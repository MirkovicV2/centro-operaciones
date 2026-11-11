import { createHash } from 'node:crypto';
import { loadDashboardState, changeDashboardState } from './dashboard-state.mjs';
import { safeMarkdownText } from './knowledge.mjs';
import { withInboxLock } from './inbox-lock.mjs';
import { notifyCoordinatorRequest } from '../coordinator-bridge.mjs';
import { readAutoRun } from '../../auto-run.mjs';
import { loadState as loadQueue } from '../queue.mjs';

const now = () => new Date().toISOString();
const roundPattern = /^[A-Za-z0-9_-]{1,48}$/;
const questionPattern = /^[A-Za-z0-9_-]{1,80}$/;
const identityKeys = ['runId', 'senderId', 'coordinatorId', 'coordinatorName', 'routeScope', 'routeKey', 'business', 'projectId', 'worktreeId', 'sessionId'];
const noticeIdentity = notification => Object.fromEntries(identityKeys.filter(key => notification?.[key] !== undefined).map(key => [key, notification[key]]));
const questionId = (requestId, roundId, id) => `cq-${createHash('sha256').update(`${requestId}:${roundId}:${id}`).digest('hex').slice(0, 32)}`;

export async function readCoordinatorRequest(root, id) {
  const state = await loadDashboardState(root);
  const request = state.coordinatorRequests.find(item => item.id === id);
  if (!request) throw new Error('No encuentro esa solicitud del coordinador.');
  return { ...request, questions: state.questions.filter(item => item.coordinatorRequestId === id) };
}

export function coordinatorDecisions(request, questions = []) {
  const decisions = new Map((request.snapshot?.decisions || []).map((item, index) => [item.questionId || item.decisionKey || `original-${index}`, item]));
  for (const question of questions.filter(item => item.coordinatorRequestId === request.id && item.status === 'answered')) {
    decisions.set(question.id, { questionId: question.id, decisionKey: question.decisionKey, roundId: question.roundId, question: question.question, answer: question.answer });
  }
  return [...decisions.values()];
}

export function assertCoordinatorQuestionsAnswered(request, questions = []) {
  if (request.status === 'withdrawn') throw new Error('La solicitud se retiró; edita y envía una nueva revisión.');
  if (request.status === 'answered') throw new Error('La consulta ya fue respondida y está cerrada.');
  if (questions.some(item => item.coordinatorRequestId === request.id && item.required !== false && item.status !== 'answered')) {
    throw new Error('Aún quedan preguntas imprescindibles del coordinador sin responder.');
  }
}

export function coordinatorJobLink(request, projectId = request.projectId || request.snapshot?.projectId || null) {
  const notification = request.notification;
  // Old injected/historical notices may have no native sender identity. Never invent one.
  if (notification?.status !== 'sent' || !notification.runId || !notification.senderId) return undefined;
  return {
    requestId: request.id, coordinatorId: notification.coordinatorId || notification.senderId,
    coordinatorName: notification.coordinatorName || 'Coordinador', runId: notification.runId,
    senderId: notification.senderId, business: request.business, projectId,
  };
}

export function reportCoordinatorQuestions(root, requestId, { questions, roundId, origin } = {}) {
  if (!roundPattern.test(roundId || '')) return Promise.reject(new Error('La ronda necesita un identificador estable de 1 a 48 caracteres.'));
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 12) return Promise.reject(new Error('Agrupa entre 1 y 12 preguntas en esta ronda.'));
  const normalized = questions.map(question => ({ id: question?.id, text: safeMarkdownText(question?.text || '').trim(), required: question?.required !== false }));
  if (normalized.some(question => !questionPattern.test(question.id || '') || question.text.length < 4 || question.text.length > 1800)
    || new Set(normalized.map(question => question.id)).size !== normalized.length) return Promise.reject(new Error('Cada pregunta necesita ID único y texto de 4 a 1800 caracteres.'));
  const originRecord = origin ? Object.fromEntries(['kind', 'jobId', 'runId', 'taskId', 'dispatchId', 'messageId'].filter(key => origin[key] !== undefined).map(key => [key, origin[key]])) : undefined;
  return withInboxLock(root, `route:${requestId}`, async () => {
    await changeDashboardState(root, state => {
      const request = state.coordinatorRequests.find(item => item.id === requestId);
      if (!request) throw new Error('No encuentro esa solicitud del coordinador.');
      if (request.status === 'answered') throw new Error('La consulta ya fue respondida; no admite nuevas preguntas.');
      const previous = request.questionRounds?.find(item => item.id === roundId);
      if (previous) {
        if (JSON.stringify(previous.questions) !== JSON.stringify(normalized) || JSON.stringify(previous.origin) !== JSON.stringify(originRecord)) throw new Error('Esta ronda ya identifica otras preguntas; conserva el original y usa otra ronda.');
        return;
      }
      if (request.notification?.status !== 'sent') throw new Error('Primero confirma la entrega de la solicitud al coordinador.');
      if (request.status === 'withdrawn' || request.status === 'routing' || (request.status === 'routed' && !originRecord)) throw new Error('La solicitud ya tiene una decisión de ruta o se retiró; no puede abrir otra ronda previa al trabajo.');
      if (originRecord && request.jobId !== originRecord.jobId) throw new Error('El origen de la pregunta no pertenece al trabajo de esta solicitud.');
      assertCoordinatorQuestionsAnswered(request, state.questions);
      const createdAt = now();
      request.questionRounds ||= [];
      request.questionRounds.push({ id: roundId, questions: normalized, createdAt, ...(originRecord ? { origin: originRecord } : {}) });
      for (const question of normalized) state.questions.push({
        id: questionId(requestId, roundId, question.id), coordinatorRequestId: requestId, roundId,
        decisionKey: question.id, business: request.business, projectId: request.projectId || request.snapshot.projectId || null,
        projectName: request.projectName || request.snapshot.projectName || '', title: request.snapshot.title,
        question: question.text, required: question.required, status: 'pending', answer: '', createdAt,
        ...(originRecord ? { origin: originRecord } : {}),
      });
      request.updatedAt = createdAt;
    });
    return readCoordinatorRequest(root, requestId);
  });
}

async function deliverAnswers(root, requestId, noticeId, notify) {
  let request = await readCoordinatorRequest(root, requestId);
  const notice = request.answerNotices.find(item => item.id === noticeId);
  if (notice.notification?.status === 'sent') return notice;
  let notification;
  try {
    if (!notice.notification?.runId || !notice.notification?.senderId) throw Object.assign(new Error('Falta identidad original.'), { code: 'coordinator_identity_required' });
    notification = await notify(notice, {
      cwd: root,
      beforeSend: async target => changeDashboardState(root, state => {
        const current = state.coordinatorRequests.find(item => item.id === requestId).answerNotices.find(item => item.id === noticeId);
        current.notification = { ...current.notification, ...target, status: 'sending', updatedAt: now() };
      }),
    });
  } catch (error) {
    request = await readCoordinatorRequest(root, requestId);
    const current = request.answerNotices.find(item => item.id === noticeId);
    const uncertain = ['sending', 'unknown', 'needs_attention'].includes(current.notification?.status);
    notification = { ...current.notification, status: uncertain ? 'unknown' : 'pending', uncertain,
      code: /^[a-z][a-z0-9_]{2,80}$/.test(error.code || '') ? error.code : 'coordinator_notice_unavailable',
      reason: 'Las respuestas están guardadas; no se confirmó el aviso al coordinador.' };
  }
  return changeDashboardState(root, state => {
    const current = state.coordinatorRequests.find(item => item.id === requestId).answerNotices.find(item => item.id === noticeId);
    current.notification = { ...current.notification, ...notification, updatedAt: now() };
    return current;
  });
}

export function checkCoordinatorAnswerNotices(root, requestId, { notify = notifyCoordinatorRequest } = {}) {
  return withInboxLock(root, `route:${requestId}`, async () => {
    const request = await readCoordinatorRequest(root, requestId);
    if (!['withdrawn', 'answered'].includes(request.status)) {
      for (const notice of request.answerNotices || []) {
        if (notice.notification?.status !== 'sent') await deliverAnswers(root, requestId, notice.id, notify);
      }
    }
    return readCoordinatorRequest(root, requestId);
  });
}

export async function answerCoordinatorQuestion(root, questionId, answer, { notify = notifyCoordinatorRequest } = {}) {
  const normalized = safeMarkdownText(answer).trim();
  if (normalized.length < 2 || normalized.length > 4000) throw new Error('La respuesta debe tener entre 2 y 4000 caracteres.');
  const question = (await loadDashboardState(root)).questions.find(item => item.id === questionId);
  if (!question?.coordinatorRequestId) throw new Error('No encuentro esa pregunta del coordinador.');
  const requestId = question.coordinatorRequestId;
  return withInboxLock(root, `route:${requestId}`, async () => {
    const noticeId = await changeDashboardState(root, state => {
      const current = state.questions.find(item => item.id === questionId);
      const request = state.coordinatorRequests.find(item => item.id === requestId);
      if (!request) throw new Error('Falta la solicitud de esta pregunta.');
      if (request.status === 'withdrawn') throw new Error('La solicitud se retiró; no admite nuevas respuestas.');
      if (request.status === 'answered') throw new Error('La consulta ya fue respondida; no admite nuevas decisiones.');
      if (current.status === 'answered' && current.answer !== normalized) throw new Error('Esta pregunta ya tiene otra respuesta; no se sustituye una decisión enviada.');
      const existing = request.answerNotices?.find(item => item.roundId === current.roundId);
      if (existing && !existing.questionIds.includes(current.id)) current.lateDecision = true;
      current.status = 'answered'; current.answer = normalized; current.answeredAt ||= now();
      request.decisions = coordinatorDecisions(request, state.questions);
      request.updatedAt = now();
      if (current.lateDecision) return null;
      if (existing) { current.answerNoticeId = existing.id; return existing.id; }
      const round = state.questions.filter(item => item.coordinatorRequestId === requestId && item.roundId === current.roundId);
      if (round.some(item => item.required !== false && item.status !== 'answered')) return null;
      const answered = round.filter(item => item.status === 'answered');
      const origin = request.questionRounds?.find(item => item.id === current.roundId)?.origin;
      const id = `${requestId}-answers-${current.roundId}`;
      const notice = {
        id, kind: 'answers', coordinatorRequestId: requestId, parentRequestId: requestId, roundId: current.roundId,
        business: request.business, projectId: request.projectId || request.snapshot.projectId || null, createdAt: now(),
        questionIds: answered.map(item => item.id), snapshot: { ...request.snapshot, decisions: request.decisions, ...(origin ? { origin } : {}) },
        ...(origin ? { origin } : {}),
        notification: { ...noticeIdentity(request.notification), status: 'pending' },
      };
      request.answerNotices ||= []; request.answerNotices.push(notice);
      for (const item of answered) item.answerNoticeId = id;
      return id;
    });
    const notice = noticeId ? await deliverAnswers(root, requestId, noticeId, notify) : null;
    const saved = (await loadDashboardState(root)).questions.find(item => item.id === questionId);
    return { ...saved, answerDeliveryStatus: saved.lateDecision ? 'needs_attention' : notice?.notification?.status || 'waiting_answers' };
  });
}

function responseSources(sources = []) {
  if (!Array.isArray(sources) || sources.length > 20) throw new Error('La respuesta admite hasta veinte referencias.');
  return sources.map(source => {
    const value = typeof source === 'string' ? { id: source } : source;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Referencia de respuesta inválida.');
    const normalized = {};
    for (const key of ['id', 'title', 'url', 'path', 'noteId', 'sha256']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'url' || key === 'path' ? 1000 : 300) || /[\x00-\x1f]/.test(value[key])) throw new Error('Referencia de respuesta inválida.');
      normalized[key] = value[key].trim();
    }
    if (!normalized.id && !normalized.title && !normalized.url && !normalized.path) throw new Error('La referencia necesita una identidad o ubicación.');
    if (normalized.url) {
      let url; try { url = new URL(normalized.url); } catch { throw new Error('URL de referencia inválida.'); }
      if (!['https:', 'http:', 'obsidian:'].includes(url.protocol) || url.username || url.password) throw new Error('URL de referencia no admitida.');
    }
    return normalized;
  });
}

// A consultation closes with a durable coordinator answer, not an execution
// receipt. Sources are declared citations, never evidence that a tool was used.
export function respondToCoordinatorRequest(root, requestId, { responseId, text, runId, senderId, sources } = {}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(responseId || '')) return Promise.reject(new Error('La respuesta necesita un identificador estable.'));
  const normalized = safeMarkdownText(text || '').trim();
  if (normalized.length < 2 || normalized.length > 12_000) return Promise.reject(new Error('La respuesta debe tener entre 2 y 12000 caracteres.'));
  let references;
  try { references = responseSources(sources); } catch (error) { return Promise.reject(error); }
  const content = { responseId, text: normalized, runId, senderId, sources: references };
  return withInboxLock(root, `route:${requestId}`, async () => {
    await changeDashboardState(root, async state => {
      const request = state.coordinatorRequests.find(item => item.id === requestId);
      if (!request || request.kind !== 'task' || request.intent !== 'consultation') throw new Error('Solo una consulta directa admite esta respuesta del coordinador.');
      if (request.notification?.status !== 'sent' || !runId || !senderId
        || runId !== request.notification.runId || senderId !== request.notification.senderId) throw new Error('La respuesta no pertenece al coordinador y Run originales.');
      if (request.response) {
        const previous = Object.fromEntries(Object.keys(content).map(key => [key, request.response[key]]));
        if (JSON.stringify(previous) !== JSON.stringify(content)) throw new Error('La consulta ya tiene otra respuesta guardada; no se sustituye su historial.');
        return;
      }
      if (!['pending', 'needs_attention'].includes(request.status) || request.route || request.jobId || request.receiptId) throw new Error('La solicitud ya se retiró o tiene una ruta; no puede cerrarse como consulta.');
      assertCoordinatorQuestionsAnswered(request, state.questions);
      const queue = await loadQueue(root), automatic = await readAutoRun(root);
      const belongs = spec => spec?.business === request.business && (spec.coordination?.requestId === requestId
        || spec.id === `${requestId}-analysis` || spec.id === `${requestId}-code`);
      if (queue.jobs.some(belongs) || automatic.receipts.some(receipt => belongs(receipt.spec))) throw new Error('La solicitud ya tiene un trabajo o recibo durable; requiere revisión.');
      const at = now();
      request.response = { ...content, at };
      request.status = 'answered'; request.answeredAt = at; request.updatedAt = at;
      for (const question of state.questions.filter(item => item.coordinatorRequestId === requestId && item.status === 'pending' && item.required === false)) {
        question.status = 'withdrawn'; question.closedAt = at; question.closedByResponseId = responseId;
      }
    });
    return readCoordinatorRequest(root, requestId);
  });
}

// «Descartar» cierra en el panel una solicitud atascada aunque su entrega sea incierta (el aviso pudo llegar al coordinador y no se
// puede retirar de él). Solo sin trabajo ni recibo; deja constancia de que se cerró con la entrega sin confirmar.
export function withdrawCoordinatorRequest(root, requestId, { discard = false } = {}) {
  return withInboxLock(root, `route:${requestId}`, () => withInboxLock(root, `notice:${requestId}`, async () => {
    const request = await readCoordinatorRequest(root, requestId);
    if (request.status === 'withdrawn') return request;
    const uncertain = ['sending', 'unknown', 'needs_attention'].includes(request.notification?.status)
      || request.answerNotices?.some(item => ['sending', 'unknown', 'needs_attention'].includes(item.notification?.status));
    if (!['pending', 'needs_attention'].includes(request.status) || request.jobId || request.receiptId || (uncertain && !discard)) {
      throw new Error(discard ? 'La solicitud ya tiene un trabajo, una ruta decidida o una respuesta; no se puede descartar desde aquí.'
        : 'La solicitud tiene una ruta o entrega incierta; revisa su estado antes de retirarla.');
    }
    const queue = await loadQueue(root);
    const automatic = await readAutoRun(root);
    const matches = spec => spec?.coordination?.requestId === requestId
      || spec?.id === `${requestId}-analysis` || spec?.id === `${requestId}-code`
      || spec?.prompt?.includes(`[COORDINATOR_REQUEST:${requestId}]`)
      || (request.kind === 'idea' && spec?.ideaId === request.ideaId && (spec.ideaVersion || 1) === request.ideaVersion);
    if (queue.jobs.some(matches) || automatic.receipts.some(receipt => matches(receipt.spec))) throw new Error('Ya existe trabajo o recibo durable; no se puede retirar esta solicitud.');
    await changeDashboardState(root, state => {
      const current = state.coordinatorRequests.find(item => item.id === requestId);
      current.status = 'withdrawn'; current.withdrawnAt = now(); current.updatedAt = now();
      if (discard) { current.discarded = true; current.discardedAt = current.withdrawnAt; current.discardedWhileUncertain = Boolean(uncertain); }
      for (const question of state.questions.filter(item => item.coordinatorRequestId === requestId && item.status === 'pending')) question.status = 'withdrawn';
    });
    return readCoordinatorRequest(root, requestId);
  }));
}
