#!/usr/bin/env node
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOperationsRoot } from './operations-root.mjs';
import { addJob, loadState as loadQueue, runQueue, summarize } from './queue.mjs';
import { createWorker } from './providers.mjs';
import { loadState as loadAssistantState } from './agency-assistant/store.mjs';
import { runBot } from './agency-assistant/bot.mjs';
import {
  buildKnowledgeGraph,
  readDashboardConfig,
  saveDashboardConfig,
  safeMarkdownText,
  writeJobNote,
} from './agency-assistant/knowledge.mjs';
import {
  answerQuestion,
  captureJobQuestions,
  markMessageHandled,
  createProject,
  updateProject,
  createIdea,
  extractQuestions,
  loadDashboardState,
  markExported,
} from './agency-assistant/dashboard-state.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_ROOT = resolveOperationsRoot(APP_ROOT);
const PORT = Number(process.env.CENTRO_OPERATIONS_PORT || 4187);
let runBusy = false;
let autoRunBusy = false;
let shutdownRequested = false;

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(body) : body);
}

function assertLocalRequest(request) {
  const host = String(request.headers.host || '').split(':')[0].toLowerCase();
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('El panel solo acepta conexiones locales.');
  const origin = request.headers.origin;
  if (origin) {
    const originUrl = new URL(origin);
    if (!['127.0.0.1', 'localhost'].includes(originUrl.hostname.toLowerCase()) || Number(originUrl.port || 80) !== PORT) {
      throw new Error('Origen de petición no permitido.');
    }
  }
}

async function readJson(request, maxBytes = 16_000) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('La petición es demasiado grande.');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('El contenido JSON no es válido.'); }
}

async function botRunning() {
  const file = path.join(APP_ROOT, 'data', 'agency-assistant.json.lock');
  try {
    const lock = JSON.parse(await fs.readFile(file, 'utf8'));
    try { process.kill(lock.pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  } catch (error) { return error.code !== 'ENOENT'; }
}

async function dashboardData() {
  const [queue, assistant, inbox, config, isBotRunning] = await Promise.all([
    loadQueue(QUEUE_ROOT),
    loadAssistantState(),
    loadDashboardState(QUEUE_ROOT),
    readDashboardConfig(QUEUE_ROOT),
    botRunning(),
  ]);
  const queueSummary = summarize(queue);
  return {
    queue: queueSummary,
    jobs: queue.jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 80).map(job => ({
      ...job,
      prompt: safeMarkdownText(job.prompt || '').slice(0, 6000),
      result: job.result ? { ...job.result, text: safeMarkdownText(job.result.text || '').slice(0, 12000) } : job.result,
    })),
    domains: assistant.domains.filter(item => item.status === 'active').sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)),
    tasks: assistant.tasks.filter(item => item.status === 'pending').sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'))),
    projects: inbox.projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(project => {
      const related = queue.jobs.filter(job => job.projectId === project.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return {
        ...project,
        jobCount: related.length,
        openJobCount: related.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length,
        recentJobs: related.slice(0, 3).map(job => ({ id: job.id, title: job.title, state: job.state, createdAt: job.createdAt })),
      };
    }),
    questions: inbox.questions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    ideas: inbox.ideas.slice(0, 30),
    messages: inbox.messages.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    exportedCount: Object.keys(inbox.exportedJobs).length,
    settings: { vaultPath: config.vaultPath, queueRoot: QUEUE_ROOT, autoRun: config.autoRun, telegram: isBotRunning },
  };
}

async function syncFinishedJobs() {
  const config = await readDashboardConfig(QUEUE_ROOT);
  const queue = await loadQueue(QUEUE_ROOT);
  const inbox = await loadDashboardState(QUEUE_ROOT);
  for (const job of queue.jobs) {
    if (job.state !== 'succeeded') continue;
    const questions = extractQuestions(job.result?.text ?? '');
    if (questions.length && !inbox.questions.some(item => item.jobId === job.id)) {
      await captureJobQuestions(QUEUE_ROOT, job, questions);
    }
    if (!config.vaultPath) continue;
    if (inbox.exportedJobs[job.id]) continue;
    const saved = await writeJobNote(QUEUE_ROOT, job);
    if (saved.path) await markExported(QUEUE_ROOT, job.id, saved.path);
  }
}

async function runOneBatch() {
  if (runBusy) throw new Error('Ya hay una ejecución iniciada desde este panel.');
  runBusy = true;
  try {
    const before = await loadQueue(QUEUE_ROOT);
    if (before.jobs.some(job => job.state === 'needs_attention')) throw new Error('Hay trabajos que requieren revisión. Resuélvelos o revísalos antes de continuar.');
    const result = await runQueue(QUEUE_ROOT, { execute: true, worker: createWorker(), maxJobs: 1 });
    await syncFinishedJobs();
    return result;
  } finally { runBusy = false; }
}

async function autoRunTick() {
  if (autoRunBusy || runBusy) return;
  autoRunBusy = true;
  try {
    const config = await readDashboardConfig(QUEUE_ROOT);
    if (!config.autoRun) return;
    const queue = await loadQueue(QUEUE_ROOT);
    if (queue.jobs.some(job => job.state === 'needs_attention')) {
      await saveDashboardConfig(QUEUE_ROOT, { vaultPath: config.vaultPath, autoRun: false });
      console.warn('Ejecución automática pausada: hay trabajos que requieren revisión.');
      return;
    }
    const ready = queue.jobs.some(job => job.state === 'queued' || (job.state === 'retry_wait' && Date.parse(job.nextAttemptAt) <= Date.now()));
    if (!ready) return;
    const result = await runQueue(QUEUE_ROOT, { execute: true, worker: createWorker(), maxJobs: 1 });
    await syncFinishedJobs();
    if (result.jobs?.some(job => job.state === 'needs_attention') || result.blockedNeedsAttention?.length) {
      await saveDashboardConfig(QUEUE_ROOT, { vaultPath: config.vaultPath, autoRun: false });
      console.warn('Ejecución automática pausada: un trabajo requiere revisión.');
    }
  } catch {
    console.warn('No se pudo procesar la cola en modo automático; se revisará de nuevo más tarde.');
  } finally { autoRunBusy = false; }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, await dashboardData());
  if (request.method === 'GET' && url.pathname === '/api/graph') return send(response, 200, await buildKnowledgeGraph(QUEUE_ROOT));
  if (request.method === 'GET' && url.pathname === '/api/config') return send(response, 200, await readDashboardConfig(QUEUE_ROOT));
  if (request.method !== 'POST') return send(response, 405, { error: 'Método no permitido.' });
  assertLocalRequest(request);
  const body = await readJson(request);

  if (url.pathname === '/api/config') {
    const config = await saveDashboardConfig(QUEUE_ROOT, { vaultPath: body.vaultPath, autoRun: body.autoRun });
    return send(response, 200, config);
  }
  if (url.pathname === '/api/projects') {
    return send(response, 201, await createProject(QUEUE_ROOT, body.name, body.business));
  }
  const projectUpdateMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/update$/);
  if (projectUpdateMatch) return send(response, 200, await updateProject(QUEUE_ROOT, projectUpdateMatch[1], body));
  if (url.pathname === '/api/ideas') {
    const idea = await createIdea(QUEUE_ROOT, body.business, body.text, body.projectId);
    return send(response, 201, idea);
  }
  if (url.pathname === '/api/jobs') {
    const prompt = String(body.prompt || '').trim();
    const successCriteria = String(body.successCriteria || '').trim();
    if (successCriteria.length < 4 || successCriteria.length > 1800) throw new Error('Describe un criterio de éxito verificable (4–1800 caracteres).');
    const projectId = String(body.projectId || '');
    const projects = (await loadDashboardState(QUEUE_ROOT)).projects;
    const project = projectId ? projects.find(item => item.id === projectId) : null;
    if (projectId && (!project || project.business !== body.business)) throw new Error('El proyecto no existe o pertenece a otra línea de negocio.');
    const job = await addJob(QUEUE_ROOT, {
      business: body.business,
      projectId: project?.id,
      projectName: project?.name,
      kind: body.kind,
      title: String(body.title || '').trim(),
      prompt: `${prompt}\n\nCriterio de éxito:\n${successCriteria}`,
      provider: body.provider || 'orca',
      workspace: body.workspace || undefined,
      isolated: body.isolated === true,
      maxUsd: Number(body.maxUsd || 0.1),
    });
    return send(response, 201, { id: job.id, business: job.business, kind: job.kind, title: job.title, state: job.state, provider: job.provider, workflow: job.workflow });
  }
  if (url.pathname === '/api/run') {
    if (runBusy || autoRunBusy) return send(response, 409, { error: 'El ejecutor del panel ya está ocupado.' });
    const queue = await loadQueue(QUEUE_ROOT);
    if (queue.jobs.some(job => job.state === 'needs_attention')) return send(response, 409, { error: 'Hay trabajos que necesitan revisión antes de procesar otros.' });
    void runOneBatch().catch(() => {});
    return send(response, 202, { started: true });
  }
  const messageMatch = url.pathname.match(/^\/api\/messages\/([a-zA-Z0-9_-]+)\/handled$/);
  if (messageMatch) return send(response, 200, await markMessageHandled(QUEUE_ROOT, messageMatch[1]));
  const answerMatch = url.pathname.match(/^\/api\/questions\/([a-zA-Z0-9_-]+)\/answer$/);
  if (answerMatch) return send(response, 200, await answerQuestion(QUEUE_ROOT, answerMatch[1], body.answer));
  return send(response, 404, { error: 'No se encontró esta ruta.' });
}

const server = http.createServer(async (request, response) => {
  try {
    assertLocalRequest(request);
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET') return send(response, 405, 'Método no permitido.', 'text/plain; charset=utf-8');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    if (!['index.html', 'app.js', 'style.css'].includes(relative)) return send(response, 404, 'No encontrado.', 'text/plain; charset=utf-8');
    const contentTypes = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
    return send(response, 200, await fs.readFile(path.join(APP_ROOT, 'dashboard', relative), 'utf8'), contentTypes[relative]);
  } catch (error) {
    return send(response, 400, { error: error.message || 'No se pudo completar la operación.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Panel local del Centro de Operaciones: http://127.0.0.1:${PORT}`);
  void syncFinishedJobs().catch(() => console.warn('La sincronización de Obsidian se reintentará.'));
});

setInterval(() => { void syncFinishedJobs().catch(() => console.warn('La sincronización de Obsidian se reintentará.')); }, 10_000).unref();
setInterval(() => { void autoRunTick(); }, 5_000).unref();

async function keepBotRunning() {
  while (!shutdownRequested) {
    try { await runBot(); }
    catch (error) { if (!shutdownRequested) console.warn(error.message); }
    if (!shutdownRequested) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_CHAT_ID) void keepBotRunning();

function stop() {
  shutdownRequested = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
