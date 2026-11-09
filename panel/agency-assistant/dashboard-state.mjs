import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { addJob, executionTimeoutMs, loadState as loadQueue } from '../queue.mjs';
import { safeMarkdownText, writeAnswerNote, writeIdeaNote, writeMessageNote } from './knowledge.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { githubRepository } from '../../project-destination.mjs';
import { classification, withIdeaLock, linkedJobs, ideaBusy } from './idea-model.mjs';
import { withInboxLock } from './inbox-lock.mjs';
import * as queueEngine from '../queue.mjs';
import { deliverWorkerDecisions } from '../worker-decisions.mjs';
import { resumeCoordinatedDispatch } from '../dispatch-recovery.mjs';

const chains = new Map();
const answerChains = new Map();
const statePath = root => path.join(path.resolve(root), 'data', 'operations-inbox.json');
const empty = () => ({ schema: 1, exportedJobs: {}, questions: [], ideas: [], messages: [], projects: [], confirmations: [], coordinatorRequests: [], continuations: [] });

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
      coordinatorRequests: Array.isArray(value.coordinatorRequests) ? value.coordinatorRequests : [],
      continuations: Array.isArray(value.continuations) ? value.continuations : [],
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
  const pending = previous.then(() => withInboxLock(key, 'state', async () => {
    const state = await loadDashboardState(key);
    const before = JSON.stringify(state);
    const result = await change(state);
    if (JSON.stringify(state) === before) return result;
    const destination = statePath(key);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx');
      try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return result;
  }));
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

export function jobQuestions(job) {
  const stage = job.workflow?.steps?.find(step => step.key === job.workflow.currentStage);
  const matches = delivery => delivery?.version === 1 && delivery.jobId === job.id
    && delivery.jobAttempt === (stage?.taskInputAttempt ?? stage?.attempt ?? job.attempts)
    && (!job.workflow?.runId || delivery.runId === job.workflow.runId)
    && (!stage || (delivery.stage === stage.key && delivery.dispatchId === stage.dispatchId && delivery.taskId === stage.taskId));
  const current = matches(stage?.delivery) ? stage.delivery : null;
  const fallback = [job.partialResult?.delivery, job.result?.delivery].find(matches);
  const delivery = job.state === 'running' ? current : job.state === 'needs_attention' ? current || fallback : job.result?.delivery;
  if (matches(delivery)) return (delivery.questions || []).map(question => ({ ...question, _roundId: `${job.id}:${delivery.dispatchId}` }));
  return job.state === 'succeeded' ? extractQuestions(job.result?.text ?? '') : [];
}

export async function captureJobQuestions(root, job, questions = jobQuestions(job)) {
  const createdAt = job.finishedAt || new Date().toISOString();
  return changeDashboardState(root, state => {
    const existing = new Set(state.questions.map(item => item.id));
    const added = [];
    questions.forEach((question, index) => {
      if (job.coordination && job.business === 'games' && job.workflow?.currentStage === 'developer'
        && /^UX-I[1-3]-return$/i.test(question?.decisionKey || '')) return;
      const structured = typeof question === 'object' && question !== null;
      const questionText = structured ? safeMarkdownText(question.text) : safeMarkdownText(question).slice(0, 800);
      if (!questionText) return;
      const decisionKey = structured && (question.decisionKey || question.id) || createHash('sha256').update(questionText.toLocaleLowerCase('es').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 24);
      const roundId = structured && question._roundId || job.id;
      const id = structured ? `q-${createHash('sha256').update(`${roundId}:${question.id || decisionKey}`).digest('hex').slice(0, 32)}` : `q-${job.id}-${index + 1}`;
      if (existing.has(id)) return;
      const known = job.continuation?.decisions?.find(item => item.decisionKey === decisionKey
        && (!item.question || safeMarkdownText(item.question).trim() === questionText.trim()));
      const item = {
        id,
        jobId: job.id,
        business: job.business,
        projectId: job.projectId || null,
        projectName: job.projectName || '',
        rootJobId: job.continuation?.rootJobId || job.id,
        roundId,
        decisionKey,
        required: !structured || question.required !== false,
        title: job.title,
        question: questionText,
        status: known ? 'answered' : 'pending',
        createdAt,
        answer: known?.answer || '',
        ...(known ? { inherited: true, answeredAt: createdAt } : {}),
        notifiedAt: null,
      };
      state.questions.push(item);
      existing.add(id);
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
    const jobs = linkedJobs(idea, (await loadQueue(root)).jobs);
    const coordinatorLinks = state.coordinatorRequests.filter(item => item.ideaId === id && ['pending', 'routing', 'needs_attention', 'routed'].includes(item.status));
    if (ideaBusy(idea) || coordinatorLinks.some(item => ['pending', 'routing', 'needs_attention'].includes(item.status))) throw new Error('Solicitud al coordinador pendiente, en curso o incierta; revisa su estado antes de modificar.');
    const hasLinks = jobs.length || Object.keys(idea.requests || {}).length || coordinatorLinks.length;
    const target = { trash: 'trash', archive: 'archived', restore: 'active' }[action];
    if (target && (idea.status || 'active') === target) return idea;
    if (!Number.isInteger(changes.version) || changes.version !== (idea.version || 1)) throw new Error('La idea cambió en otra ventana. Recarga su versión; conserva tu borrador.');
    if (action === 'trash' && hasLinks) throw new Error('Hay trabajos o solicitudes del coordinador vinculados; confirma Archivar en lugar de Eliminar.');
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

function stableHash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 32); }

function originalJob(queue, parent) {
  let current = parent;
  const seen = new Set();
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const ancestorId = current.continuation?.rootJobId || current.prompt?.match(/^Continúa el trabajo .*?\(ID ([a-zA-Z0-9_-]+)\)/)?.[1];
    const ancestor = ancestorId && queue.jobs.find(item => item.id === ancestorId && item.business === parent.business && item.projectId === parent.projectId);
    if (!ancestor || ancestor.id === current.id) return current;
    current = ancestor;
  }
  throw new Error('La cadena histórica de continuaciones contiene un ciclo; requiere revisión.');
}

function makeContinuation(state, queue, parent, roundId = parent.id) {
  const questions = state.questions.filter(item => item.jobId === parent.id && (item.roundId || item.jobId) === roundId);
  if (!questions.length || questions.some(item => item.required !== false && item.status !== 'answered')) return null;
  const answered = questions.filter(item => item.status === 'answered');
  if (!answered.length) return null;
  const previous = state.continuations.find(item => item.parentJobId === parent.id && (item.roundId || item.parentJobId) === roundId);
  if (previous) return previous;
  const origin = originalJob(queue, parent);
  const decisions = new Map((parent.continuation?.decisions || []).map(item => [item.decisionKey || item.questionId, item]));
  for (const item of state.questions.filter(item => item.status === 'answered' && (item.rootJobId === origin.id || item.jobId === origin.id || item.jobId === parent.id))) {
    const decisionKey = item.decisionKey || stableHash(item.question.toLocaleLowerCase('es').replace(/\s+/g, ' ').trim());
    decisions.set(decisionKey, { questionId: item.id, decisionKey, question: item.question, answer: item.answer });
  }
  const decisionRevision = stableHash(JSON.stringify([...decisions.values()]));
  const id = `continue-${stableHash(`${roundId}:${decisionRevision}`)}`;
  const continuation = { version: 1, rootJobId: origin.id, parentJobId: parent.id, decisionRevision, questionIds: answered.map(item => item.id), decisions: [...decisions.values()], originalPromptRef: { jobId: origin.id, file: 'data/events.jsonl' } };
  const original = state.continuations.find(item => item.rootJobId === origin.id);
  const intent = { id, parentJobId: parent.id, rootJobId: origin.id, roundId, status: 'pending', createdAt: new Date().toISOString(), continuation, originalPrompt: original?.originalPrompt || origin.prompt, title: original?.title || origin.title };
  state.continuations.push(intent);
  for (const item of questions) item.continuationId = id;
  return intent;
}

async function materializeContinuation(root, intentId) {
  return withInboxLock(root, `continuation:${intentId}`, async () => {
    const inbox = await loadDashboardState(root);
    const intent = inbox.continuations.find(item => item.id === intentId);
    if (!intent || ['queued', 'resumed', 'needs_attention'].includes(intent.status)) return intent;
    const queue = await loadQueue(root);
    const parent = queue.jobs.find(item => item.id === intent.parentJobId);
    if (!parent) throw new Error('Falta el trabajo padre de la continuación; no se crea otro trabajo.');
    const contextPath = path.join(path.resolve(root), 'data', 'continuations', `${intent.id}.json`);
    await fs.mkdir(path.dirname(contextPath), { recursive: true });
    const payload = { version: 1, rootJobId: intent.rootJobId, parentJobId: parent.id, originalPrompt: intent.originalPrompt, decisions: intent.continuation.decisions };
    const contextText = `${JSON.stringify(payload, null, 2)}\n`;
    try {
      const handle = await fs.open(contextPath, 'wx');
      try { await handle.writeFile(contextText); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fs.readFile(contextPath, 'utf8') !== contextText) throw new Error('El contexto durable de la continuación cambió; requiere revisión.');
    }
    const instructions = [
      `Continuar el objetivo ${intent.rootJobId}; entrega previa ${parent.id}; revisión de decisiones ${intent.continuation.decisionRevision}.`,
      'Aplica todas las decisiones siguientes juntas. Una decisión delegada autoriza elegir dentro del objetivo; no vuelvas a formular la misma pregunta. No amplía permisos externos.',
      `Contexto íntegro y verificable: ${contextPath}. Léelo antes de trabajar. No uses un historial recursivo ni supongas que un resultado previo satisface los criterios.`,
    ];
    const inline = `Encargo original:\n${intent.originalPrompt}\n\nDecisiones acumuladas:\n${intent.continuation.decisions.map(item => `${item.decisionKey}: ${item.question}\nRespuesta: ${item.answer}`).join('\n\n')}`;
    if (Buffer.byteLength([...instructions, inline].join('\n\n'), 'utf8') <= 12_000) instructions.push(inline);
    const prompt = instructions.join('\n\n');
    let status, jobId;
    try {
      const alreadyApplied = parent.continuation?.decisionRevision === intent.continuation.decisionRevision;
      const currentStage = parent.workflow?.steps?.find(step => step.key === parent.workflow.currentStage);
      const currentDispatch = currentStage?.dispatchId || parent.result?.delivery?.dispatchId;
      if (!alreadyApplied && currentDispatch && intent.roundId !== parent.id && intent.roundId !== `${parent.id}:${currentDispatch}`) throw Object.assign(new Error('La pregunta pertenece a otro dispatch.'), { code: 'continuation_stale' });
      if (alreadyApplied && ['queued', 'running', 'retry_wait', 'succeeded'].includes(parent.state)) {
        status = 'resumed'; jobId = parent.id;
      } else if (parent.state === 'running') {
        if (!currentStage?.dispatchId || !['active', 'confirmed', 'checking', 'completed'].includes(currentStage.dispatchStatus)) {
          return changeDashboardState(root, state => {
            const current = state.continuations.find(item => item.id === intent.id);
            current.reason = 'Respuesta guardada. El panel espera que Orca confirme el estado del trabajador.';
            return current;
          });
        }
        let notification = intent.notification;
        if (parent.coordination && currentStage.questionMessageId && notification?.status !== 'sent'
          && (!notification?.updatedAt || Date.now() - Date.parse(notification.updatedAt) > 10_000)) {
          try {
            notification = await deliverWorkerDecisions(root, parent, intent, { beforeSend: target => changeDashboardState(root, state => {
              state.continuations.find(item => item.id === intent.id).notification = { ...target, status: 'sending', updatedAt: new Date().toISOString() };
            }) });
          } catch {
            const saved = (await loadDashboardState(root)).continuations.find(item => item.id === intent.id)?.notification;
            notification = { ...saved, status: ['sending', 'unknown'].includes(saved?.status) ? 'unknown' : 'pending', reason: 'Decisiones guardadas; el aviso al coordinador necesita comprobación.' };
          }
        }
        return changeDashboardState(root, state => {
          const current = state.continuations.find(item => item.id === intent.id);
          current.status = 'pending'; current.reason = 'waiting_existing_dispatch';
          current.waitingDispatchId = currentStage.dispatchId;
          if (notification) current.notification = { ...notification, updatedAt: new Date().toISOString() };
          return current;
        });
      } else if (parent.state === 'needs_attention') {
        if (typeof queueEngine.resumeJobWithDecisions !== 'function') throw new Error('La cola aún no admite reanudación con decisiones.');
        const resumed = queueEngine.stageDecisionSource(parent, intent.continuation)
          ? await resumeCoordinatedDispatch(root, parent.id, { confirm: true, stageDecision: intent.continuation })
          : await queueEngine.resumeJobWithDecisions(root, parent.id, { continuation: intent.continuation, prompt });
        if (resumed?.status === 'pending_review' || resumed?.state === 'needs_attention') throw new Error('La reanudación requiere revisar los intentos o el dispatch existente.');
        status = 'resumed'; jobId = parent.id;
      } else if (parent.state === 'succeeded' && parent.kind === 'analysis' && intent.roundId === parent.id) {
        const existing = queue.jobs.find(item => item.id === intent.id);
        if (existing && (existing.continuation?.decisionRevision !== intent.continuation.decisionRevision || existing.continuation?.parentJobId !== parent.id)) throw new Error('El identificador de continuación pertenece a otro contexto.');
        if (!existing) await addJob(root, {
          id: intent.id, continuation: intent.continuation, business: parent.business, projectId: parent.projectId, projectName: parent.projectName,
          kind: 'analysis', title: `Continuación: ${intent.title}`.slice(0, 160), prompt, provider: parent.provider,
          maxAttempts: parent.maxAttempts, timeoutMs: executionTimeoutMs(parent), maxUsd: parent.maxUsd,
        });
        status = 'queued'; jobId = intent.id;
      } else if (parent.continuation?.decisionRevision === intent.continuation.decisionRevision && ['queued', 'running', 'retry_wait', 'succeeded'].includes(parent.state)) {
        status = 'resumed'; jobId = parent.id;
      } else throw new Error('La respuesta necesita revisar el estado del trabajo; no se inicia una copia de un trabajo de código.');
    } catch (error) {
      if (['locked', 'inbox_locked'].includes(error.code)) return intent;
      if (error.code === 'duplicate') {
        const existing = (await loadQueue(root)).jobs.find(item => item.id === intent.id);
        if (existing?.continuation?.decisionRevision === intent.continuation.decisionRevision) { status = 'queued'; jobId = intent.id; }
        else throw error;
      } else return changeDashboardState(root, state => {
        const current = state.continuations.find(item => item.id === intent.id);
        current.status = 'needs_attention'; current.reason = safeMarkdownText(error.message || 'No se pudo reconciliar la continuación de forma segura.').slice(0, 1000);
        current.errorCode = /^[a-z_]{3,80}$/.test(error.code || '') ? error.code : 'continuation_review_required';
        return current;
      });
    }
    return changeDashboardState(root, state => {
      const current = state.continuations.find(item => item.id === intent.id);
      current.status = status; current.jobId = jobId; current.updatedAt = new Date().toISOString();
      delete current.reason; delete current.errorCode; delete current.waitingDispatchId;
      for (const question of state.questions.filter(item => item.continuationId === intent.id)) question.followUpJobId = jobId;
      return current;
    });
  });
}

export async function retrySavedContinuation(root, id) {
  const pending = await changeDashboardState(root, state => {
    const intent = state.continuations.find(item => item.id === id);
    if (!intent || !['pending', 'needs_attention'].includes(intent.status)) throw new Error('La respuesta guardada ya no espera reanudación.');
    intent.status = 'pending';
    delete intent.reason;
    return intent;
  });
  return materializeContinuation(root, pending.id);
}

export async function reconcileContinuations(root) {
  const inbox = await loadDashboardState(root);
  for (const intent of inbox.continuations.filter(item => item.status === 'pending')) {
    try { await materializeContinuation(root, intent.id); }
    catch (error) {
      if (!['locked', 'inbox_locked'].includes(error.code)) console.warn(`Continuación ${intent.id}: ${error.code || 'error de reconciliación'}`);
    }
  }
}

async function answerQuestionOnce(root, id, answer) {
  const normalized = safeMarkdownText(answer).trim();
  if (normalized.length < 2 || normalized.length > 4000) throw new Error('La respuesta debe tener entre 2 y 4000 caracteres.');
  const queue = await loadQueue(root);
  const saved = await changeDashboardState(root, state => {
    const question = state.questions.find(item => item.id === id);
    if (!question) throw new Error('No encuentro esa pregunta del agente.');
    if (question.status === 'answered' && question.answer !== normalized) throw new Error('Esa pregunta ya tiene otra respuesta; revisa la decisión antes de sustituirla.');
    if (question.status === 'answered' && question.followUpJobId && !question.continuationId) return question;
    question.status = 'answered'; question.answer = normalized; question.answeredAt ||= new Date().toISOString();
    const parent = queue.jobs.find(item => item.id === question.jobId);
    const existingIntent = state.continuations.find(item => item.parentJobId === question.jobId && (item.roundId || item.parentJobId) === (question.roundId || question.jobId));
    if (existingIntent && !existingIntent.continuation.questionIds.includes(id)) question.lateDecision = true;
    if (parent && !question.lateDecision) makeContinuation(state, queue, parent, question.roundId || question.jobId);
    return question;
  });
  // The answer is authoritative even if the optional knowledge export is unavailable.
  try {
    const note = await writeAnswerNote(root, saved, normalized);
    await changeDashboardState(root, state => { const question = state.questions.find(item => item.id === id); question.answerNotePath = note.path ?? null; });
  } catch { /* Obsidian is a projection; it must not discard a saved decision. */ }
  if (saved.continuationId) await materializeContinuation(root, saved.continuationId);
  return (await loadDashboardState(root)).questions.find(item => item.id === id);
}

export function answerQuestion(root, id, answer) {
  const key = path.resolve(root);
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
