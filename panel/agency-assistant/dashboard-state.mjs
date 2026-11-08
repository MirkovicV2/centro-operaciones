import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { addJob, loadState as loadQueue } from '../queue.mjs';
import { safeMarkdownText, writeAnswerNote, writeIdeaNote, writeMessageNote } from './knowledge.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { githubRepository } from '../../project-destination.mjs';
import { classification, withIdeaLock, linkedJobs, ideaBusy } from './idea-model.mjs';

const chains = new Map();
const answerChains = new Map();
const statePath = root => path.join(path.resolve(root), 'data', 'operations-inbox.json');
const empty = () => ({ schema: 1, exportedJobs: {}, questions: [], ideas: [], messages: [], projects: [], confirmations: [] });

const defaultStages = business => business === 'games'
  ? ['Por clasificar', 'Idea', 'Diseño', 'Prototipo', 'Producción', 'Pruebas', 'Lanzamiento', 'Mantenimiento']
  : ['Por clasificar', 'Brief', 'Planificación', 'Diseño', 'Implementación', 'Revisión', 'Entrega', 'Mantenimiento'];

export async function loadDashboardState(root) {
  try {
    const value = JSON.parse(await fs.readFile(statePath(root), 'utf8'));
    if (value?.schema !== 1 || !value.exportedJobs || !Array.isArray(value.questions) || !Array.isArray(value.ideas)) {
      throw new Error('El estado del panel no es compatible.');
    }
    return {
      ...value,
      messages: Array.isArray(value.messages) ? value.messages : [],
      projects: Array.isArray(value.projects) ? value.projects : [],
      confirmations: Array.isArray(value.confirmations) ? value.confirmations : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    if (error instanceof SyntaxError) throw new Error('El estado del panel no es válido; no se sobrescribirá.');
    throw error;
  }
}

export function changeDashboardState(root, change) {
  const key = path.resolve(root);
  const previous = chains.get(key) ?? Promise.resolve();
  const pending = previous.then(async () => {
    const state = await loadDashboardState(key);
    const result = await change(state);
    const destination = statePath(key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return result;
  });
  chains.set(key, pending.catch(() => {}));
  return pending;
}

export function extractQuestions(text) {
  const source = String(text ?? '');
  const header = /^#{1,3}\s*(?:Preguntas para Daniel|Decisiones para Daniel|Necesito tu decisi[oó]n)\s*$/im.exec(source);
  if (!header) return [];
  const begin = header.index + header[0].length;
  const tail = source.slice(begin).replace(/^\s*\r?\n/, '');
  const nextHeading = /^#{1,3}\s/m.exec(tail);
  const raw = (nextHeading ? tail.slice(0, nextHeading.index) : tail).trim();
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const items = lines.filter(line => /^(?:[-*+]\s+|\d{1,2}[.)]\s+)/.test(line)).map(line => line.replace(/^(?:[-*+]\s+|\d{1,2}[.)]\s+)/, '').trim());
  return (items.length ? items : raw ? [raw] : []).map(value => value.slice(0, 800)).filter(Boolean).slice(0, 8);
}

export async function captureJobQuestions(root, job, questions) {
  const createdAt = job.finishedAt || new Date().toISOString();
  return changeDashboardState(root, state => {
    const existing = new Set(state.questions.map(item => item.id));
    const added = [];
    questions.forEach((question, index) => {
      const id = `q-${job.id}-${index + 1}`;
      if (existing.has(id)) return;
      const item = {
        id,
        jobId: job.id,
        business: job.business,
        title: job.title,
        question: safeMarkdownText(question).slice(0, 800),
        status: 'pending',
        createdAt,
        answer: '',
        notifiedAt: null,
      };
      state.questions.push(item);
      added.push(item);
    });
    return added;
  });
}

export async function markExported(root, jobId, notePath) {
  return changeDashboardState(root, state => {
    state.exportedJobs[jobId] = { notePath, exportedAt: new Date().toISOString() };
  });
}

export async function recordJobConfirmation(root, jobId, business, destination) {
  return changeDashboardState(root, state => {
    if (!['agency', 'games'].includes(business) || !jobId || !destination?.checkout || !destination?.branch) throw new Error('Confirmación del destino incompleta.');
    state.confirmations ||= [];
    const value = { jobId, business, checkout: destination.checkout, repository: destination.repository || '', sourceBranch: destination.branch, baseBranch: destination.baseBranch || '', confirmedAt: new Date().toISOString() };
    const index = state.confirmations.findIndex(item => item.jobId === jobId);
    if (index >= 0) state.confirmations[index] = value; else state.confirmations.unshift(value);
    return value;
  });
}

export async function createProject(root, name, business) {
  const normalized = safeMarkdownText(name).trim().replace(/[\r\n\t]+/g, ' ').slice(0, 100);
  if (normalized.length < 2) throw new Error('Escribe un nombre de proyecto de al menos 2 caracteres.');
  if (!['agency', 'games'].includes(business)) throw new Error('Elige Agencia o Videojuegos.');
  return changeDashboardState(root, state => {
    if (state.projects.some(item => item.business === business && item.name.toLowerCase() === normalized.toLowerCase())) {
      throw new Error('Ya existe un proyecto con ese nombre en esta línea de negocio.');
    }
    const now = new Date().toISOString();
    const project = {
      id: `project-${randomUUID().slice(0, 12)}`,
      name: normalized,
      business,
      stages: defaultStages(business),
      stageIndex: 0,
      nextAction: '',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    state.projects.unshift(project);
    return project;
  });
}

export async function updateProject(root, id, changes) {
  const repository = changes.repository !== undefined && changes.repository.trim() ? githubRepository(`https://github.com/${changes.repository.trim()}`) : '';
  const baseBranch = changes.baseBranch !== undefined ? String(changes.baseBranch).trim() : undefined;
  if (baseBranch !== undefined && baseBranch && (baseBranch.includes('..') || /[\\\x00\r\n]/.test(baseBranch) || baseBranch.startsWith('-'))) throw new Error('Rama base inválida.');
  let checkout, destination;
  if (changes.checkout !== undefined) {
    checkout = String(changes.checkout);
    if (checkout) {
      if (path.isAbsolute(checkout)) throw new Error('Selecciona un checkout relativo bajo workspaces.');
      destination = await inspectDestination(root, checkout, String(changes.branch || ''));
    }
  }
  return changeDashboardState(root, state => {
    const project = state.projects.find(item => item.id === id);
    if (!project) throw new Error('No encuentro ese proyecto.');
    if (changes.repository !== undefined) project.repository = repository;
    if (baseBranch !== undefined) project.baseBranch = baseBranch;
    if (checkout !== undefined) { project.checkout = checkout; project.branch = destination?.branch || ''; project.destinationCheckedAt = destination?.checkedAt || null; }
    if (changes.stageIndex !== undefined) {
      const stageIndex = Number(changes.stageIndex);
      if (!Number.isInteger(stageIndex) || stageIndex < 0 || stageIndex >= project.stages.length) throw new Error('Elige una etapa válida.');
      project.stageIndex = stageIndex;
    }
    if (changes.nextAction !== undefined) {
      const nextAction = safeMarkdownText(changes.nextAction).trim().replace(/[\r\n\t]+/g, ' ').slice(0, 240);
      project.nextAction = nextAction;
    }
    if (changes.status !== undefined) {
      if (!['active', 'paused', 'completed'].includes(changes.status)) throw new Error('Elige un estado válido.');
      project.status = changes.status;
    }
    project.updatedAt = new Date().toISOString();
    return project;
  });
}

export async function createIdea(root, business, text, projectId = '', operationId = '', metadata = {}) {
  const classified = classification(metadata.focus, metadata.tags);
  const normalized = safeMarkdownText(text).trim();
  if (!['agency', 'games'].includes(business)) throw new Error('Elige agencia o videojuegos.');
  if (normalized.length < 4 || normalized.length > 6000) throw new Error('Escribe una idea de 4 a 6000 caracteres.');
  const project = projectId ? (await loadDashboardState(root)).projects.find(item => item.id === projectId) : null;
  if (projectId && (!project || project.business !== business)) throw new Error('Elige un proyecto de la línea de negocio seleccionada.');
  if (operationId && !/^[a-zA-Z0-9_-]{8,60}$/.test(operationId)) throw new Error('Operación de captura inválida.');
  const item = {
    id: operationId || randomUUID().slice(0, 12),
    business,
    projectId: project?.id ?? null,
    projectName: project?.name ?? '',
    title: normalized.split(/\r?\n/)[0].slice(0, 100),
    text: normalized,
    ...classified,
    version: 1,
    status: 'active',
    operationId: operationId || null,
    createdAt: new Date().toISOString(),
  };
  item.capture = structuredClone(item);
  const saved = await changeDashboardState(root, state => {
    const existing = state.ideas.find(idea => idea.id === item.id);
    if (existing) {
      const original = existing.capture || existing;
      if (original.text !== item.text || original.projectId !== item.projectId || original.business !== business || (original.focus || '') !== classified.focus || JSON.stringify(original.tags || []) !== JSON.stringify(classified.tags)) throw new Error('Esta operación pertenece a otra idea.');
      return existing;
    }
    state.ideas.unshift(item);
    return item;
  });
  if (saved.notePath) return saved;
  try {
    const note = await writeIdeaNote(root, saved.capture || saved);
    return await changeDashboardState(root, state => {
      const current = state.ideas.find(idea => idea.id === saved.id);
      current.notePath = note.path;
      delete current.noteError;
      return current;
    });
  } catch (error) {
    return changeDashboardState(root, state => {
      const current = state.ideas.find(idea => idea.id === saved.id);
      current.noteError = error.message;
      return current;
    });
  }
}

export function mutateIdea(root, id, action, changes = {}) {
  return withIdeaLock(root, id, () => changeDashboardState(root, async state => {
    const idea = state.ideas.find(item => item.id === id);
    if (!idea) throw new Error('No encuentro esa idea.');
    if (ideaBusy(idea)) throw new Error('Envío pendiente, activo o incierto; revisa su estado antes de modificar.');
    const jobs = linkedJobs(idea, (await loadQueue(root)).jobs);
    const hasLinks = jobs.length || Object.keys(idea.requests || {}).length;
    const target = { trash: 'trash', archive: 'archived', restore: 'active' }[action];
    if (target && (idea.status || 'active') === target) return idea;
    if (!Number.isInteger(changes.version) || changes.version !== (idea.version || 1)) throw new Error('La idea cambió en otra ventana. Recarga su versión; conserva tu borrador.');
    if (action === 'trash' && hasLinks) throw new Error('Han aparecido trabajos o solicitudes; confirma Archivar en lugar de Eliminar.');
    if (action === 'archive' && !hasLinks) throw new Error('Sin vínculos: usa Eliminar para mover a Papelera.');
    const prior = structuredClone(idea);
    delete prior.versions;
    if (action === 'update') {
      if (idea.status === 'trash') throw new Error('Restaura la idea antes de editar.');
      const text = safeMarkdownText(changes.text).trim();
      const title = String(changes.title || '').trim();
      if (text.length < 4 || text.length > 6000 || !title || title.length > 100) throw new Error('Texto: 4–6000 caracteres; título: 1–100.');
      const project = state.projects.find(item => item.id === changes.projectId && item.business === idea.business);
      if (changes.projectId && (!project || (project.status === 'completed' && project.id !== idea.projectId))) throw new Error('Elige un proyecto disponible del mismo negocio.');
      Object.assign(idea, classification(changes.focus, changes.tags), { text, title, projectId: project?.id || null, projectName: project?.name || '' });
    } else if (target) idea.status = target;
    else throw new Error('Acción de idea inválida.');
    idea.capture ||= prior.capture || structuredClone(prior);
    idea.versions = [...(idea.versions || []), { action, at: new Date().toISOString(), snapshot: prior }];
    idea.version = (idea.version || 1) + 1;
    idea.updatedAt = new Date().toISOString();
    return idea;
  }));
}

export async function captureMessage(root, text, source = 'Telegram') {
  const normalized = safeMarkdownText(text).trim();
  if (normalized.length < 2 || normalized.length > 6000) throw new Error('El mensaje debe tener entre 2 y 6000 caracteres.');
  const item = {
    id: `msg-${randomUUID().slice(0, 12)}`,
    source: safeMarkdownText(source).slice(0, 32),
    text: normalized,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  const note = await writeMessageNote(root, item);
  item.notePath = note.path ?? null;
  await changeDashboardState(root, state => { state.messages.unshift(item); });
  return item;
}

export async function markMessageHandled(root, id) {
  return changeDashboardState(root, state => {
    const item = state.messages.find(entry => entry.id === id);
    if (!item) throw new Error('No encuentro ese mensaje en la bandeja.');
    if (item.status === 'handled') throw new Error('Ese mensaje ya estÃ¡ marcado como tratado.');
    item.status = 'handled';
    item.handledAt = new Date().toISOString();
    return item;
  });
}

function clipUtf8(value, maxBytes) {
  const bytes = Buffer.from(String(value ?? ''), 'utf8');
  if (bytes.length <= maxBytes) return bytes.toString('utf8');
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '');
}

async function answerQuestionOnce(root, id, answer) {
  const normalized = safeMarkdownText(answer).trim();
  if (normalized.length < 2 || normalized.length > 4000) throw new Error('La respuesta debe tener entre 2 y 4000 caracteres.');
  const state = await loadDashboardState(root);
  const question = state.questions.find(item => item.id === id);
  if (!question) throw new Error('No encuentro esa pregunta del agente.');
  if (question.status === 'answered') throw new Error('Esa pregunta ya está respondida.');
  const queue = await loadQueue(root);
  const parent = queue.jobs.find(item => item.id === question.jobId && item.state === 'succeeded');
  const note = await writeAnswerNote(root, question, normalized);
  let followUpJobId = null;
  if (parent) {
    followUpJobId = `follow-${createHash('sha256').update(question.id).digest('hex').slice(0, 16)}`;
    const priorFollowUp = queue.jobs.find(item => item.id === followUpJobId);
    if (!priorFollowUp) {
      const originalPrompt = String(parent.prompt || '');
      const criterion = originalPrompt.match(/Criterio de éxito:\s*([\s\S]*)$/i)?.[1] || '';
      const resultText = safeMarkdownText(parent.result?.text || JSON.stringify(parent.result || {}, null, 2));
      const continuation = [
        `Continúa el trabajo «${parent.title}» (ID ${parent.id}) después de recibir la decisión de Daniel.`,
        `Encargo original:\n${clipUtf8(originalPrompt, 1800)}`,
        criterion ? `Criterio de éxito original:\n${clipUtf8(criterion, 900)}` : '',
        `Resultado de la primera parte:\n${clipUtf8(resultText, 1800)}`,
        `Pregunta que hizo el agente:\n${clipUtf8(question.question, 800)}`,
        `Respuesta de Daniel:\n${clipUtf8(normalized, 3500)}`,
        'Continúa desde el trabajo existente, respeta el criterio de éxito y pregunta de nuevo solo si hace falta una decisión diferente.',
      ].filter(Boolean).join('\n\n');
      await addJob(root, {
        id: followUpJobId,
        business: parent.business,
        projectId: parent.projectId,
        projectName: parent.projectName,
        kind: parent.kind,
        title: `Continuación: ${parent.title}`.slice(0, 160),
        prompt: clipUtf8(continuation, 10_500),
        provider: parent.provider,
        workspace: parent.workspace,
        isolated: parent.isolated,
        maxAttempts: parent.maxAttempts,
        timeoutMs: parent.timeoutMs,
        maxUsd: parent.maxUsd,
      });
    }
  }
  const updated = await changeDashboardState(root, current => {
    const item = current.questions.find(entry => entry.id === id);
    if (!item || item.status === 'answered') throw new Error('La pregunta ya se respondió en otra ventana.');
    item.status = 'answered';
    item.answer = normalized;
    item.answeredAt = new Date().toISOString();
    item.answerNotePath = note.path ?? null;
    item.followUpJobId = followUpJobId;
    return item;
  });
  return updated;
}

export function answerQuestion(root, id, answer) {
  const key = `${path.resolve(root)}:${id}`;
  const previous = answerChains.get(key) ?? Promise.resolve();
  const pending = previous.then(() => answerQuestionOnce(root, id, answer));
  answerChains.set(key, pending.catch(() => {}));
  return pending;
}

export async function markQuestionNotified(root, id) {
  return changeDashboardState(root, state => {
    const item = state.questions.find(entry => entry.id === id);
    if (item && item.status === 'pending' && !item.notifiedAt) item.notifiedAt = new Date().toISOString();
  });
}
