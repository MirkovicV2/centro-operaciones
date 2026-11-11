#!/usr/bin/env node
import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { projectMemory } from './project-memory.mjs';
import { resolveOperationsRoot } from './operations-root.mjs';
import { recordQualityPlan, syncQualityHandoffs, verifyQualityQuestion } from './quality-handoff.mjs';
import { QUEUE_BUSINESSES, loadState as loadQueue, summarize, recoverDashboardQueue, retryJob, resolveJob, cancelQueuedJob, settledQaRevalidation, stoppedDeveloperCheckpoint, actorContext } from './queue.mjs';
import { parseTailscaleAccess, assertRoleAllows } from './access-control.mjs';
import { readAutoRun, setAutoRun, createAutoRunner, reviewAutoReceipt, retryAutoReceipt, resumeWorkflowV2Receipt, retryDestinationAdmission } from '../auto-run.mjs';
import { destinationCheck, createMissingRemote } from '../project-remote.mjs';
import { workflowV2Resumable } from '../workflow-v2-gate.mjs';
import { createWorker } from '../providers.mjs';
import { checkoutChoices, sendIdeaToCoordinator, routeCoordinatorIdea } from './agency-assistant/idea-workflow.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator, checkCoordinatorRequestNotice } from './agency-assistant/coordinator-inbox.mjs';
import { remindCoordinator } from './agency-assistant/coordinator-notice.mjs';
import { reportCoordinatorQuestions, answerCoordinatorQuestion, readCoordinatorRequest, withdrawCoordinatorRequest, respondToCoordinatorRequest } from './agency-assistant/coordinator-dialogue.mjs';
import { buildRequestTraces, createPreparationObserver, readRequestTrace } from './request-trace.mjs';
import { queryRequestContext, queryJobContext, readContextConsultations } from './knowledge-access.mjs';
import { createCoordinatorHealth } from './coordinator-health.mjs';
import { authorizeWorkerHandoff, verifyWorkerQuestion, questionsForEscalation } from './worker-decisions.mjs';
import { resumeCoordinatedDispatch, retryCoordinatedCheckout } from './dispatch-recovery.mjs';
import { loadState as loadAssistantState } from './agency-assistant/store.mjs';
import { runBot } from './agency-assistant/bot.mjs';
import {
  buildKnowledgeGraph,
  readDashboardConfig,
  saveDashboardConfig,
  safeMarkdownText,
  writeJobNote,
  writeProjectMemoryNote,
} from './agency-assistant/knowledge.mjs';
import {
  answerQuestion,
  captureJobQuestions,
  jobQuestions,
  reconcileContinuations,
  retrySavedContinuation,
  markMessageHandled,
  createProject,
  updateProject,
  createIdea,
  mutateIdea,
  loadDashboardState,
  changeDashboardState,
  markExported,
} from './agency-assistant/dashboard-state.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_ROOT = resolveOperationsRoot(APP_ROOT);
const coordinatorHealth = createCoordinatorHealth(QUEUE_ROOT);
const PORT = Number(process.env.CENTRO_OPERATIONS_PORT || 4187);
// 7: { hostname, login } (one admin) or { hostname, users: [{ login, role }] } with roles admin, ejecutar, revisar.
const tailscaleAccess = await fs.readFile(path.join(APP_ROOT, 'data', 'tailscale-access.json'), 'utf8')
  .then(content => parseTailscaleAccess(content))
  .catch(error => {
    if (error.code !== 'ENOENT') console.warn(`Acceso Tailscale desactivado: ${error.message}`);
    return null;
  });
// 25: with Claude, Orca must open workers as Terminal. Read-only check; the panel only warns.
import { configuredOrcaAgent } from '../local-tools.mjs';
import { inspectOrcaAgentSettings } from '../orca-settings.mjs';
import { readPipeline, pipelineAgents, previewPipeline, writePipeline, disablePipeline, resolveStageLaunch, STAGE_ROLES, PIPELINE_BUSINESSES } from '../pipeline-config.mjs';
import { LAUNCH_ROLES, LAUNCH_AGENTS } from '../launch-choice.mjs';
import { currentActor, addJobStage } from './queue.mjs';
import { readQuota, writeQuota, quotaStatus, billingWarnings, recordQuotaObservation, quotaConfigured, DEFAULT_QUOTA } from '../quota.mjs';
import { diagnoseJob } from '../failure-taxonomy.mjs';
import { readTeam, RESOURCE_NAMES } from '../team.mjs';
import { readSharedMemory } from '../project-knowledge.mjs';
import { readLaunchLevels, LAUNCH_LEVELS, DEFAULT_LAUNCH_LEVELS } from '../orca-provider.mjs';
// With a mixed pipeline some stages run with Claude even when the default agent is Codex.
const usesClaude = await readPipeline(QUEUE_ROOT, { levelNames: LAUNCH_LEVELS }).then(pipeline => pipelineAgents(pipeline, configuredOrcaAgent()).includes('claude'))
  .catch(error => { console.warn(`Reparto del pipeline no aplicable: ${error.message}`); return configuredOrcaAgent() === 'claude'; });
const orcaPreflight = await inspectOrcaAgentSettings({ agent: usesClaude ? 'claude' : configuredOrcaAgent() }).catch(error => ({ available: false, reason: error.code || 'orca_settings_error', surface: 'unknown', permissionMode: null, warnings: [] }));
for (const warning of usesClaude ? orcaPreflight.warnings : []) console.warn(`Preflight de Orca: ${warning}`);
const launchSources = async () => ({ levels: await readLaunchLevels(QUEUE_ROOT), pipeline: await readPipeline(QUEUE_ROOT, { levelNames: LAUNCH_LEVELS }), defaultAgent: configuredOrcaAgent(), fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
// The split as the settings view edits it. A broken file is reported, never silently replaced.
async function pipelineSettings() {
  const levels = await readLaunchLevels(QUEUE_ROOT).catch(() => DEFAULT_LAUNCH_LEVELS);
  const base = { defaultAgent: configuredOrcaAgent(), roles: LAUNCH_ROLES, agents: LAUNCH_AGENTS, businesses: PIPELINE_BUSINESSES, levelNames: LAUNCH_LEVELS, levels: { roles: levels.roles, agents: levels.agents },
    example: JSON.parse(await fs.readFile(new URL('../ejemplos/pipeline.mixto.example.json', import.meta.url), 'utf8')) };
  let configured = true;
  try { await fs.access(path.join(QUEUE_ROOT, 'data', 'pipeline.json')); } catch { configured = false; }
  try { return { ...base, configured, pipeline: await readPipeline(QUEUE_ROOT, { levelNames: LAUNCH_LEVELS }) }; }
  catch (error) { if (error.code !== 'pipeline_config_invalid') throw error; return { ...base, configured, pipeline: null, error: error.message }; }
}
// Which PC this installation is, what every PC of the team can do and whether branches are reserved. Read-only:
// the files are edited by hand (docs/EQUIPOS.md) because one of them is shared through the repository.
async function teamSettings() {
  try { const team = await readTeam(QUEUE_ROOT); return { ...team, resourceNames: RESOURCE_NAMES }; }
  catch (error) { if (error.code !== 'team_config_invalid') throw error; return { configured: false, error: error.message, equipos: {}, resourceNames: RESOURCE_NAMES }; }
}
// Subscriptions and the personal reserve as the settings view shows them. Every status says how it is known.
async function quotaSettings() {
  const configured = await quotaConfigured(QUEUE_ROOT);
  let quota = DEFAULT_QUOTA, error;
  try { quota = await readQuota(QUEUE_ROOT); } catch (failure) { if (failure.code !== 'quota_config_invalid') throw failure; error = failure.message; }
  return { configured, agents: LAUNCH_AGENTS, quota, status: Object.fromEntries(LAUNCH_AGENTS.map(agent => [agent, quotaStatus(quota, agent)])), warnings: billingWarnings(quota), ...(error ? { error } : {}) };
}
async function saveQuota(body) {
  try {
    if (body.policy) {
      const current = await readQuota(QUEUE_ROOT).catch(() => DEFAULT_QUOTA);
      const { reservaPersonalPorcentaje, avisoPorcentaje, caducidadObservacionHoras, sinDatos, alAgotar, sustituciones } = body.policy;
      await writeQuota(QUEUE_ROOT, { ...current, reservaPersonalPorcentaje, avisoPorcentaje, caducidadObservacionHoras, sinDatos, alAgotar, sustituciones });
    }
    if (body.observation) {
      const { provider, ...observation } = body.observation;
      await recordQuotaObservation(QUEUE_ROOT, provider, observation);
    }
  } catch (error) { if (error.code === 'quota_config_invalid') throw Object.assign(new Error(error.message), { status: 400, code: error.code }); throw error; }
  return quotaSettings();
}
// What each stage that has not been launched yet would be launched with right now. Launched stages keep their own record.
async function plannedLaunches(jobs) {
  const active = jobs.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state) && job.provider === 'orca');
  if (!active.length) return new Map();
  let sources;
  try { sources = await launchSources(); } catch { return new Map(); }
  return new Map(active.map(job => [job.id, Object.fromEntries((job.workflow?.steps || []).filter(step => STAGE_ROLES[step.key] && !step.launch && !['succeeded', 'skipped'].includes(step.status)).flatMap(step => {
    try { const { origin, ...launch } = resolveStageLaunch({ roleName: STAGE_ROLES[step.key], business: job.business, projectId: job.projectId, jobLaunch: job.launch, ...sources }); return [[step.key, launch]]; }
    catch { return []; }
  }))]));
}
// Read-only: what a job would be launched with. The files are read on every call, so an edit shows without a restart.
async function registeredProject(id) {
  const project = (await loadDashboardState(QUEUE_ROOT)).projects.find(item => item.id === id);
  if (!project) throw Object.assign(new Error('No encuentro ese proyecto.'), { status: 404 });
  return project;
}
async function launchPreview(params) {
  let launch;
  if (params.get('launch')) { try { launch = JSON.parse(params.get('launch')); } catch { throw Object.assign(new Error('launch no es JSON válido.'), { status: 400 }); } }
  try {
    return previewPipeline({ business: params.get('business'), kind: params.get('kind'), projectId: params.get('projectId') || null, launch, ...await launchSources() });
  } catch (error) {
    if (['pipeline_config_invalid', 'launch_choice_invalid', 'launch_levels_invalid'].includes(error.code)) throw Object.assign(new Error(error.message), { status: 400, code: error.code });
    throw error;
  }
}
const runtime = Object.freeze({
  pid: process.pid,
  startupAt: new Date().toISOString(),
  entry: fileURLToPath(import.meta.url),
  fingerprints: Object.fromEntries(await Promise.all(['dashboard.mjs', '../queue.mjs', '../providers.mjs', '../orca-provider.mjs', 'coordinator-bridge.mjs', 'coordinator-routing.mjs', '../coordination.mjs', 'worker-decisions.mjs', 'quality-handoff.mjs', 'project-memory.mjs', 'agency-assistant/coordinator-dialogue.mjs', 'request-trace.mjs', 'knowledge-access.mjs', 'dashboard/requests-view.js'].map(async relative => {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    return [file, createHash('sha256').update(await fs.readFile(file)).digest('hex')];
  }))),
});
let shutdownRequested = false;
const observePreparation = createPreparationObserver();
const autoRunner = createAutoRunner(QUEUE_ROOT, { worker: createWorker(), parallelBusinesses: true });

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

// Returns the principal: { actor, role }. Local requests act as admin; Tailscale
// requests must come from a listed account (unlisted → 403) and carry its role.
function assertLocalRequest(request, tailscale = null) {
  const authority = String(request.headers.host || '').toLowerCase();
  const host = authority.split(':')[0];
  const { origin } = request.headers;
  const forwardedHost = request.headers['x-forwarded-host'];
  if (forwardedHost !== undefined || request.headers['tailscale-user-login'] !== undefined || request.headers['tailscale-funnel-request'] !== undefined) {
    const login = request.headers['tailscale-user-login'];
    const users = tailscale?.users ?? (tailscale?.login ? new Map([[tailscale.login, 'admin']]) : new Map());
    if (!tailscale || request.socket?.remoteAddress !== '127.0.0.1'
      || (authority !== tailscale.hostname && authority !== `${tailscale.hostname}:443`)
      || String(forwardedHost).toLowerCase() !== authority
      || request.headers['x-forwarded-proto'] !== 'https'
      || request.headers['tailscale-funnel-request'] !== undefined
      || typeof login !== 'string' || !users.has(login)) {
      throw Object.assign(new Error('Acceso restringido a las cuentas autorizadas en Tailscale.'), { status: 403 });
    }
    if ((request.method !== 'GET' || origin !== undefined) && origin !== `https://${tailscale.hostname}`) {
      throw Object.assign(new Error('Origen de petición no permitido.'), { status: 403 });
    }
    return { actor: login, role: users.get(login) };
  }
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('El panel solo acepta conexiones locales.');
  if (origin) {
    const originUrl = new URL(origin);
    if (!['127.0.0.1', 'localhost'].includes(originUrl.hostname.toLowerCase()) || Number(originUrl.port || 80) !== PORT) {
      throw new Error('Origen de petición no permitido.');
    }
  }
  return { actor: 'local', role: 'admin' };
}

async function readJson(request, maxBytes = 32_000) {
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
  const byBusiness = Object.fromEntries(await Promise.all(QUEUE_BUSINESSES.map(async business =>
    [business, await recoverDashboardQueue(QUEUE_ROOT, { business })])));
  const available = Object.values(byBusiness).some(executor => executor.available);
  const executor = { available, ...(available ? {} : { reason: byBusiness.agency.reason }), byBusiness };
  const [queue, assistant, inbox, config, isBotRunning] = await Promise.all([
    loadQueue(QUEUE_ROOT),
    loadAssistantState(),
    loadDashboardState(QUEUE_ROOT),
    readDashboardConfig(QUEUE_ROOT),
    botRunning(),
  ]);
  const queueSummary = summarize(queue);
  const automation = await readAutoRun(QUEUE_ROOT);
  const knowledge = await readContextConsultations(QUEUE_ROOT, { requestIds: inbox.coordinatorRequests.map(item => item.id), jobIds: queue.jobs.map(item => item.id) });
  const requestTraces = await buildRequestTraces(QUEUE_ROOT, { requests: inbox.coordinatorRequests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), jobs: queue.jobs, questions: inbox.questions, automation, knowledge, observePreparation });
  const planned = await plannedLaunches(queue.jobs);
  // The team's shared memory per project (memoria/): counts and the decisions in force, for the project card.
  const sharedMemories = new Map(await Promise.all(inbox.projects.map(async project => {
    try {
      const memory = await readSharedMemory({ business: project.business, projectName: project.name });
      if (!memory) return [project.id, null];
      const count = states => memory.entradas.filter(entry => states.includes(entry.estado)).length;
      return [project.id, { file: memory.file, vigentes: count(['vigente', 'validada']), enEvaluacion: count(['en_evaluacion']), historial: count(['sustituida', 'descartado']),
        decisiones: memory.entradas.filter(entry => entry.tipo === 'decision' && entry.estado === 'vigente').map(entry => entry.titulo).slice(0, 5) }];
    } catch (error) { return [project.id, { error: error.message }]; }
  })));
  return {
    executor,
    checkouts: await checkoutChoices(QUEUE_ROOT),
    queue: queueSummary,
    jobs: queue.jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(job => ({
      ...job,
      ...(planned.get(job.id) && Object.keys(planned.get(job.id)).length ? { plannedLaunch: planned.get(job.id) } : {}),
      ...(diagnoseJob(job) ? { diagnosis: diagnoseJob(job) } : {}),
      prompt: safeMarkdownText(job.prompt || '').slice(0, 6000),
      result: job.result ? { ...job.result, text: safeMarkdownText(job.result.text || '').slice(0, 12000) } : job.result,
    })),
    domains: assistant.domains.filter(item => item.status === 'active').sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)),
    tasks: assistant.tasks.filter(item => item.status === 'pending').sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999'))),
    projects: inbox.projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(project => {
      const related = queue.jobs.filter(job => job.projectId === project.id && job.business === project.business).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return {
        ...project,
        ...(sharedMemories.get(project.id) ? { sharedMemory: sharedMemories.get(project.id) } : {}),
        jobCount: related.length,
        openJobCount: related.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length,
        recentJobs: related.slice(0, 3).map(job => ({ id: job.id, title: job.title, state: job.state, createdAt: job.createdAt })),
      };
    }),
    questions: inbox.questions.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    continuations: inbox.continuations,
    ideas: inbox.ideas,
    coordinatorRequests: inbox.coordinatorRequests.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    requestTraces,
    coordination: await coordinatorHealth(),
    messages: inbox.messages.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    exportedCount: Object.keys(inbox.exportedJobs).length,
    automation,
    settings: { vaultPath: config.vaultPath, queueRoot: QUEUE_ROOT, autoRun: false, telegram: isBotRunning, runtime, orcaAgent: configuredOrcaAgent(), orcaPreflight },
  };
}

let coordinatorRecoveryRunning = false;
async function resumeCoordinatorRoutes() {
  if (coordinatorRecoveryRunning) return;
  coordinatorRecoveryRunning = true;
  try {
  const inbox = await loadDashboardState(QUEUE_ROOT);
  for (const request of inbox.coordinatorRequests.filter(item => !['withdrawn', 'answered'].includes(item.status)
    && (item.notification?.status === 'pending' || item.answerNotices?.some(notice => notice.notification?.status === 'pending'))).slice(0, 3)) {
    try { await checkCoordinatorRequestNotice(QUEUE_ROOT, request.id); } catch { /* Durable intent remains pending. */ }
  }
  for (const request of inbox.coordinatorRequests.filter(item => item.status === 'pending' && item.notification?.status === 'sent').slice(0, 3)) {
    try { await remindCoordinator(QUEUE_ROOT, request.id); } catch { /* The notice stays in the inbox; the panel shows it as unanswered. */ }
  }
  for (const request of inbox.coordinatorRequests.filter(item => item.status === 'routing' && item.route?.kind)) {
    try {
      if (request.kind === 'idea') await routeCoordinatorIdea(QUEUE_ROOT, request.id, request.route.kind, request.route.confirmation || {});
      else await routeTaskFromCoordinator(QUEUE_ROOT, request.id, request.route.kind, { reason: request.route.reason || '', confirmation: request.route.confirmation });
    } catch (error) {
      await changeDashboardState(QUEUE_ROOT, state => {
        const current = state.coordinatorRequests.find(item => item.id === request.id);
        if (current?.status === 'routing') {
          current.route = { ...current.route, lastAttemptAt: new Date().toISOString(), lastError: String(error.message || 'No se pudo reanudar la ruta.').slice(0, 1000) };
          current.updatedAt = new Date().toISOString();
        }
      });
    }
  }
  } finally { coordinatorRecoveryRunning = false; }
}

async function syncFinishedJobs() {
  const config = await readDashboardConfig(QUEUE_ROOT);
  const queue = await loadQueue(QUEUE_ROOT);
  const inbox = await loadDashboardState(QUEUE_ROOT);
  for (const job of queue.jobs) {
    if (['succeeded', 'needs_attention', 'running'].includes(job.state)) {
      const questions = jobQuestions(job);
      if (questions.length && !(job.state === 'running' && job.coordination)) {
        await captureJobQuestions(QUEUE_ROOT, job, questions);
      }
    }
    if (!['succeeded', 'needs_attention', 'cancelled'].includes(job.state)) continue;
    if (!config.vaultPath) continue;
    const saved = await writeJobNote(QUEUE_ROOT, job, { revision: queue.revision });
    const visiblePath = saved.currentPath || saved.path;
    if (saved.current !== false && visiblePath && (inbox.exportedJobs[job.id]?.notePath !== visiblePath || saved.created)) {
      await markExported(QUEUE_ROOT, job.id, visiblePath);
    }
  }
  await reconcileContinuations(QUEUE_ROOT);
}

async function syncProjectMemory() {
  const [config, queue, inbox] = await Promise.all([readDashboardConfig(QUEUE_ROOT), loadQueue(QUEUE_ROOT), loadDashboardState(QUEUE_ROOT)]);
  if (!config.vaultPath) return;
  for (const project of inbox.projects) {
    const memory = projectMemory({ business: project.business, projectId: project.id }, queue.jobs);
    try { await writeProjectMemoryNote(config.vaultPath, project, memory, queue.revision); }
    catch (error) { console.warn(`No se pudo actualizar la memoria de ${project.id}: ${error.code || error.message}`); }
  }
}

let qualitySyncRunning = false;
async function syncQuality() {
  if (qualitySyncRunning) return;
  qualitySyncRunning = true;
  try { await syncQualityHandoffs(QUEUE_ROOT); }
  catch { console.warn('La sincronización de calidad se reintentará.'); }
  finally { qualitySyncRunning = false; }
}

async function handleApi(request, response, url, tailscale = null) {
  if (request.method === 'GET' && url.pathname === '/api/state') return send(response, 200, await dashboardData());
  if (request.method === 'GET' && url.pathname === '/api/coordinators') return send(response, 200, await coordinatorHealth());
  const coordinatorRead = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)$/);
  if (request.method === 'GET' && coordinatorRead) return send(response, 200, await readCoordinatorRequest(QUEUE_ROOT, coordinatorRead[1]));
  const traceRead = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/trace$/);
  if (request.method === 'GET' && traceRead) return send(response, 200, await readRequestTrace(QUEUE_ROOT, traceRead[1], { observePreparation }));
  if (request.method === 'GET' && url.pathname === '/api/graph') return send(response, 200, await buildKnowledgeGraph(QUEUE_ROOT, url.searchParams.get('business')));
  if (request.method === 'GET' && url.pathname === '/api/launch-preview') return send(response, 200, await launchPreview(url.searchParams));
  if (request.method === 'GET' && url.pathname === '/api/team') return send(response, 200, await teamSettings());
  if (request.method === 'GET' && url.pathname === '/api/quota') return send(response, 200, await quotaSettings());
  if (request.method === 'GET' && url.pathname === '/api/pipeline') return send(response, 200, await pipelineSettings());
  if (request.method === 'GET' && url.pathname === '/api/config') return send(response, 200, await readDashboardConfig(QUEUE_ROOT));
  const destinationProbe = request.method === 'GET' && url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/destination-check$/);
  if (destinationProbe) return send(response, 200, await destinationCheck(QUEUE_ROOT, await registeredProject(destinationProbe[1])));
  if (request.method !== 'POST') return send(response, 405, { error: 'Método no permitido.' });
  assertLocalRequest(request, tailscale);
  const body = await readJson(request);
  const contextRequest = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/context$/);
  if (contextRequest) return send(response, 200, await queryRequestContext(QUEUE_ROOT, contextRequest[1], body));
  const contextJob = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/context$/);
  if (contextJob) return send(response, 200, await queryJobContext(QUEUE_ROOT, contextJob[1], body));
  const coordinatorResponse = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/response$/);
  if (coordinatorResponse) return send(response, 200, await respondToCoordinatorRequest(QUEUE_ROOT, coordinatorResponse[1], body));

  if (url.pathname === '/api/auto-run') return send(response, 200, await setAutoRun(QUEUE_ROOT, body.business, body.enabled, { confirm: body.confirm === true }));
  const checkoutRetry = url.pathname.match(/^\/api\/auto-run\/([a-zA-Z0-9_-]+)\/retry-checkout$/);
  if (checkoutRetry) return send(response, 200, await retryCoordinatedCheckout(QUEUE_ROOT, checkoutRetry[1], { confirm: body.confirm === true }));
  const destinationRetry = url.pathname.match(/^\/api\/auto-run\/([a-zA-Z0-9_-]+)\/retry-destination$/);
  if (destinationRetry) return send(response, 200, await retryDestinationAdmission(QUEUE_ROOT, destinationRetry[1], { confirm: body.confirm === true }));
  const receiptReview = url.pathname.match(/^\/api\/auto-run\/([a-zA-Z0-9_-]+)\/review$/);
  if (receiptReview) return send(response, 200, await reviewAutoReceipt(QUEUE_ROOT, receiptReview[1], { confirm: body.confirm === true }));

  if (url.pathname === '/api/config') {
    const config = await saveDashboardConfig(QUEUE_ROOT, { vaultPath: body.vaultPath, autoRun: false });
    return send(response, 200, config);
  }
  if (url.pathname === '/api/quota') return send(response, 200, await saveQuota(body));
  if (url.pathname === '/api/pipeline') {
    try {
      if (body.disable === true) { if (body.confirm !== true) throw Object.assign(new Error('Confirma explícitamente volver al agente único.'), { status: 400 }); await disablePipeline(QUEUE_ROOT, { actor: currentActor() }); }
      else await writePipeline(QUEUE_ROOT, body.pipeline, { levelNames: LAUNCH_LEVELS, actor: currentActor() });
    } catch (error) { if (error.code === 'pipeline_config_invalid') throw Object.assign(new Error(error.message), { status: 400, code: error.code }); throw error; }
    return send(response, 200, await pipelineSettings());
  }
  if (url.pathname === '/api/projects') {
    return send(response, 201, await createProject(QUEUE_ROOT, body.name, body.business));
  }
  const remoteCreate = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/create-remote$/);
  if (remoteCreate) return send(response, 200, await createMissingRemote(QUEUE_ROOT, await registeredProject(remoteCreate[1]), { confirm: body.confirm === true }));
  const projectUpdateMatch = url.pathname.match(/^\/api\/projects\/([a-zA-Z0-9_-]+)\/update$/);
  if (projectUpdateMatch) return send(response, 200, await updateProject(QUEUE_ROOT, projectUpdateMatch[1], body));
  if (url.pathname === '/api/ideas') {
    const idea = await createIdea(QUEUE_ROOT, body.business, body.text, body.projectId, body.operationId, { focus: body.focus, tags: body.tags });
    return send(response, 201, idea);
  }
  const ideaMutation = url.pathname.match(/^\/api\/ideas\/([a-zA-Z0-9_-]+)\/(update|trash|archive|restore)$/);
  if (ideaMutation) return send(response, 200, await mutateIdea(QUEUE_ROOT, ideaMutation[1], ideaMutation[2], body));
  const coordinatorRequest = url.pathname.match(/^\/api\/ideas\/([a-zA-Z0-9_-]+)\/coordinator$/);
  if (coordinatorRequest) return send(response, 200, await sendIdeaToCoordinator(QUEUE_ROOT, coordinatorRequest[1]));
  const coordinatorRoute = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/route$/);
  if (coordinatorRoute) {
    const request = (await loadDashboardState(QUEUE_ROOT)).coordinatorRequests.find(item => item.id === coordinatorRoute[1]);
    const result = request?.kind === 'idea'
      ? await routeCoordinatorIdea(QUEUE_ROOT, coordinatorRoute[1], body.kind, { ...(body.confirmation || {}), reason: body.reason, ...(body.route ? { pipelineRoute: body.route } : {}) })
      : await routeTaskFromCoordinator(QUEUE_ROOT, coordinatorRoute[1], body.kind, { reason: body.reason, confirmation: body.confirmation, route: body.route });
    return send(response, 200, result);
  }
  const coordinatorNotice = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/notify$/);
  if (coordinatorNotice) return send(response, 200, await checkCoordinatorRequestNotice(QUEUE_ROOT, coordinatorNotice[1]));
  const workerHandoff = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/handoffs$/);
  if (workerHandoff) return send(response, 200, await authorizeWorkerHandoff(QUEUE_ROOT, workerHandoff[1], body));
  const qualityPlan = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/quality-plan$/);
  if (qualityPlan) {
    const item = await readCoordinatorRequest(QUEUE_ROOT, qualityPlan[1]);
    return send(response, 200, await recordQualityPlan(QUEUE_ROOT, item, body));
  }
  const coordinatorQuestions = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/questions$/);
  if (coordinatorQuestions) {
    const item = await readCoordinatorRequest(QUEUE_ROOT, coordinatorQuestions[1]);
    if (body.origin?.kind === 'quality-block') {
      const origin = await verifyQualityQuestion(QUEUE_ROOT, item, body.origin);
      return send(response, 200, await reportCoordinatorQuestions(QUEUE_ROOT, coordinatorQuestions[1], { ...body, origin }));
    }
    if (body.origin) {
      const { job, step } = await verifyWorkerQuestion(QUEUE_ROOT, item, body.origin);
      const questions = await captureJobQuestions(QUEUE_ROOT, job, questionsForEscalation(job, step, body.questions));
      return send(response, 200, { requestId: item.id, jobId: job.id, mode: 'job-decisions', questions });
    }
    return send(response, 200, await reportCoordinatorQuestions(QUEUE_ROOT, coordinatorQuestions[1], body));
  }
  const coordinatorWithdraw = url.pathname.match(/^\/api\/coordinator\/requests\/([a-zA-Z0-9_-]+)\/withdraw$/);
  if (coordinatorWithdraw) return send(response, 200, await withdrawCoordinatorRequest(QUEUE_ROOT, coordinatorWithdraw[1]));
  const ideaSend = url.pathname.match(/^\/api\/ideas\/([a-zA-Z0-9_-]+)\/send$/);
  if (ideaSend) return send(response, 409, { error: 'El panel ya no inicia agentes directamente desde Ideas. Envía la idea al coordinador para que decida la ruta.' });
  const resumeDispatch = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/resume$/);
  if (resumeDispatch) return send(response, 200, await resumeCoordinatedDispatch(QUEUE_ROOT, resumeDispatch[1], { confirm: body.confirmReviewed === true }));
  const addedStage = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/stages$/);
  if (addedStage) return send(response, 200, await addJobStage(QUEUE_ROOT, addedStage[1], { stage: body.stage, reason: body.reason }));
  const reviewedJob = url.pathname.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)\/(retry|resolve|cancel)$/);
  if (reviewedJob) {
    let job;
    if (reviewedJob[2] === 'retry') {
      const current = (await loadQueue(QUEUE_ROOT)).jobs.find(item => item.id === reviewedJob[1]);
      const receipt = current?.autoIntent?.eligible ? (await readAutoRun(QUEUE_ROOT)).receipts.find(item => item.jobId === current.id) : null;
      const confirm = body.confirmReviewed === true;
      if (receipt?.status === 'needs_attention' && (stoppedDeveloperCheckpoint(current) || settledQaRevalidation(current))) {
        job = await resumeCoordinatedDispatch(QUEUE_ROOT, current.id, { confirm });
      } else if (receipt?.status === 'needs_attention' && workflowV2Resumable(current)) {
        // Workflow V2 phase B: read the owner's approval and integrate only that candidate.
        job = await resumeWorkflowV2Receipt(QUEUE_ROOT, current.id, { confirm });
      } else {
        job = receipt?.status === 'needs_attention'
          ? await retryAutoReceipt(QUEUE_ROOT, reviewedJob[1], { confirm, noDispatchConfirmed: body.noDispatchConfirmed === true })
          : await retryJob(QUEUE_ROOT, reviewedJob[1], { confirm, ...(body.substitute ? { substitute: body.substitute, reason: body.reason } : {}) });
      }
    } else if (reviewedJob[2] === 'cancel') {
      job = await cancelQueuedJob(QUEUE_ROOT, reviewedJob[1], { confirm: body.confirmReviewed === true });
    } else {
      job = await resolveJob(QUEUE_ROOT, reviewedJob[1], { confirm: body.confirmReviewed === true });
    }
    return send(response, 200, job);
  }
  if (url.pathname === '/api/jobs') {
    const result = await submitTaskToCoordinator(QUEUE_ROOT, body);
    return send(response, 202, result);
  }
  if (url.pathname === '/api/run') return send(response, 409, { error: 'No se drena la cola desde el panel. Solo se admiten recibos nuevos elegibles por su ID; la cola manual requiere run --execute con --id.' });
  const messageMatch = url.pathname.match(/^\/api\/messages\/([a-zA-Z0-9_-]+)\/handled$/);
  if (messageMatch) return send(response, 200, await markMessageHandled(QUEUE_ROOT, messageMatch[1]));
  const retryContinuation = url.pathname.match(/^\/api\/continuations\/([a-zA-Z0-9_-]+)\/retry$/);
  if (retryContinuation) return send(response, 200, await retrySavedContinuation(QUEUE_ROOT, retryContinuation[1]));
  const answerMatch = url.pathname.match(/^\/api\/questions\/([a-zA-Z0-9_-]+)\/answer$/);
  if (answerMatch) {
    const question = (await loadDashboardState(QUEUE_ROOT)).questions.find(item => item.id === answerMatch[1]);
    const answered = question?.coordinatorRequestId
      ? await answerCoordinatorQuestion(QUEUE_ROOT, answerMatch[1], body.answer)
      : await answerQuestion(QUEUE_ROOT, answerMatch[1], body.answer);
    if (question?.origin?.kind === 'quality-block') void syncQuality();
    return send(response, 200, answered);
  }
  return send(response, 404, { error: 'No se encontró esta ruta.' });
}

const server = http.createServer(async (request, response) => {
  try {
    const principal = assertLocalRequest(request, tailscaleAccess);
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/')) {
      assertRoleAllows(principal.role, request.method, url.pathname);
      return await actorContext.run(principal, () => handleApi(request, response, url, tailscaleAccess));
    }
    if (request.method !== 'GET') return send(response, 405, 'Método no permitido.', 'text/plain; charset=utf-8');
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const contentTypes = {
      'index.html': 'text/html; charset=utf-8',
      'app.js': 'text/javascript; charset=utf-8',
      'ideas-view.js': 'text/javascript; charset=utf-8',
      'requests-view.js': 'text/javascript; charset=utf-8',
      'style.css': 'text/css; charset=utf-8',
      'panel.webmanifest': 'application/manifest+json; charset=utf-8',
      'panel-icon-192.png': 'image/png',
      'panel-icon-512.png': 'image/png',
    };
    if (!Object.hasOwn(contentTypes, relative)) return send(response, 404, 'No encontrado.', 'text/plain; charset=utf-8');
    return send(response, 200, await fs.readFile(path.join(APP_ROOT, 'dashboard', relative)), contentTypes[relative]);
  } catch (error) {
    return send(response, [403, 409].includes(error.status) ? error.status : 400, { error: error.message || 'No se pudo completar la operación.', ...(error.code ? { code: error.code } : {}) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  autoRunner.start();
  void resumeCoordinatorRoutes();
  void syncQuality();
  void syncProjectMemory().catch(() => {});
  console.log(`Panel local del Centro de Operaciones: http://127.0.0.1:${PORT}`);
  void syncFinishedJobs().catch(() => console.warn('La sincronización de Obsidian se reintentará.'));
});

setInterval(() => { void syncFinishedJobs().catch(() => console.warn('La sincronización de Obsidian se reintentará.')); }, 10_000).unref();
setInterval(() => { void resumeCoordinatorRoutes().catch(() => {}); }, 10_000).unref();
setInterval(() => { void syncQuality(); }, 10_000).unref();
setInterval(() => { void syncProjectMemory().catch(() => {}); }, 10_000).unref();


async function keepBotRunning() {
  while (!shutdownRequested) {
    try { await runBot(); }
    catch (error) { if (!shutdownRequested) console.warn(error.message); }
    if (!shutdownRequested) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOWED_CHAT_ID) void keepBotRunning();

function stop() {
  autoRunner.stop();
  shutdownRequested = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
