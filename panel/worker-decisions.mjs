import { loadState, settledUxReturnStep } from '../queue.mjs';
import { coordinatedStages } from '../coordination.mjs';
import { changeDashboardState, loadDashboardState } from './agency-assistant/dashboard-state.mjs';
import { withInboxLock } from './agency-assistant/inbox-lock.mjs';
import { safeMarkdownText } from './agency-assistant/knowledge.mjs';
import { checkWorkerIdentity, normalizeWorkerStatus, pendingStageDelivery, stageAskAnswered } from '../orca-evidence.mjs';
import { coordinatorCommand, notifyCoordinatorRequest, verifyCoordinatorBinding } from './coordinator-bridge.mjs';

export async function verifyWorkerQuestion(root, request, origin, command = coordinatorCommand, handoffStage) {
  const job = (await loadState(root)).jobs.find(item => item.id === origin?.jobId);
  const step = job?.workflow?.steps?.find(item => handoffStage
    ? item.dispatchId === origin.dispatchId && item.taskId === origin.taskId : item.key === job.workflow.currentStage);
  const settledUx = handoffStage === 'ux' && step?.key === 'developer' && step === settledUxReturnStep(job);
  if (!job || (!settledUx && job.state !== 'running') || job.coordination?.requestId !== request.id
    || job.coordination.runId !== origin.runId || step?.runId !== origin.runId
    || step.taskId !== origin.taskId || step.dispatchId !== origin.dispatchId
    || (!settledUx && (!origin.messageId || !(step.status === 'running' || handoffStage && step.status === 'succeeded')))) {
    throw new Error('La pregunta no pertenece al trabajador vigente de esta solicitud.');
  }
  const worker = normalizeWorkerStatus(await command(['orchestration', 'worker-show', '--dispatch', origin.dispatchId, '--full'], { cwd: root }));
  checkWorkerIdentity(worker, origin, { strict: true });
  const live = ['running', 'active', 'working', 'waiting', 'blocked', 'ready'].includes(worker.state) && ['alive', 'live', 'running'].includes(worker.liveness);
  const settled = worker.liveness === 'exited' && (settledUx ? worker.state === 'failed' : handoffStage && worker.state === 'succeeded');
  if (settledUx ? !settled : !live && !settled) {
    throw new Error('El trabajador ya no espera esta respuesta o su estado es incierto.');
  }
  const inbox = await command(['orchestration', 'inbox', '--terminal', `run:${origin.runId}`, '--limit', '100', '--full'], { cwd: root });
  const observed = pendingStageDelivery(inbox.messages, { ...origin, stage: step.key, terminalHandle: worker.terminal,
    jobAttempt: step.taskInputAttempt ?? step.attempt ?? job.attempts, acceptance: job.contract?.acceptance });
  const messageId = origin.messageId ?? (settledUx ? observed?.messageId : null);
  const message = inbox.messages?.find(item => item.id === messageId);
  let payload;
  try { payload = typeof message?.payload === 'string' ? JSON.parse(message.payload) : message?.payload; } catch { /* fail closed below */ }
  if (!['ask', 'question'].includes(message?.type) || message.run_id !== origin.runId || message.to_handle !== `run:${origin.runId}`
    || !(message.from_handle === `dispatch:${origin.dispatchId}` || worker.terminal && message.from_handle === worker.terminal)
    || payload?.dispatchId !== origin.dispatchId || payload?.taskId !== origin.taskId
    || message.truncated || message.clipped || message.contentComplete === false
    || message.warnings?.length || message.clipping?.length) throw new Error('No se pudo acreditar la pregunta exacta en ORCA.');
  if (settledUx && (!observed || observed.transport || !step.delivery.questions.filter(item => item.required).every(expected =>
    observed.delivery.questions.some(item => item.required && item.id === expected.id && item.decisionKey === expected.decisionKey)))) {
    throw new Error('El ask estructurado no coincide con el retorno UX de la entrega cerrada.');
  }
  if (observed ? observed.messageId !== messageId : step.questionMessageId !== messageId) {
    throw new Error('La pregunta no pertenece al trabajador vigente de esta solicitud.');
  }
  const replies = await command(['orchestration', 'inbox', '--terminal', `dispatch:${origin.dispatchId}`, '--limit', '100', '--full'], { cwd: root });
  const replyIdentity = { ...origin, messageId, terminalHandle: worker.terminal };
  const prefix = `[CENTRO_TRASPASO:${handoffStage}]`;
  const repliesToAsk = (replies.messages || []).filter(item => stageAskAnswered([item], replyIdentity));
  const authorizationReply = handoffStage ? repliesToAsk.find(item => typeof item.body === 'string' && item.body.replaceAll('\r\n', '\n').startsWith(prefix + '\n')
    && /^msg_[A-Za-z0-9_-]{6,100}$/.test(item.id || '') && item.contentComplete !== false
    && !item.truncated && !item.clipped && !item.warnings?.length && !item.clipping?.length) : null;
  if (handoffStage && !authorizationReply) throw new Error('Falta la respuesta de autorización del coordinador en la pregunta original de Orca.');
  if (!handoffStage && repliesToAsk.length) throw new Error('El coordinador ya respondió esta pregunta en Orca.');
  return { job, step: observed ? { ...step, delivery: observed.delivery, questionMessageId: observed.messageId, questionTransport: observed.transport } : step,
    ...(authorizationReply ? { authorizationReply: { id: authorizationReply.id, note: safeMarkdownText(authorizationReply.body.slice(prefix.length + 1)).trim() } } : {}) };
}

export async function deliverWorkerDecisions(root, job, intent, { command = coordinatorCommand, notify = notifyCoordinatorRequest, beforeSend } = {}) {
  if (intent.notification?.status === 'sent') return intent.notification;
  const step = job.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  if (!job.coordination || !step?.questionMessageId) return null;
  const origin = { jobId: job.id, runId: job.workflow.runId, taskId: step.taskId, dispatchId: step.dispatchId, messageId: step.questionMessageId };
  await verifyWorkerQuestion(root, { id: job.coordination.requestId }, origin, command);
  return notify({
    id: intent.id, kind: 'worker-decisions', createdAt: intent.createdAt,
    notification: { ...job.coordination, status: 'pending', ...intent.notification },
    snapshot: { business: job.business, projectId: job.projectId, projectName: job.projectName,
      title: `Respuestas: ${job.title}`, text: intent.originalPrompt, decisions: intent.continuation.decisions, origin },
  }, { cwd: root, beforeSend });
}

function sameHandoffScope(request, job) {
  return request?.status === 'routed' && job?.coordination && request.jobId === job.id
    && request.id === job.coordination.requestId && request.business === job.business
    && (request.projectId || request.snapshot?.projectId || null) === (job.projectId || null)
    && request.notification?.runId === job.coordination.runId && request.notification?.senderId === job.coordination.senderId;
}

// An authorized clarification travels through the existing job context.
// It never admits a stage or bypasses the acceptance and publishing gates.
export async function authorizeWorkerHandoff(root, requestId, { origin, toStage, note = '' } = {}, {
  command = coordinatorCommand, verifyOwner = verifyCoordinatorBinding, verifyQuestion = verifyWorkerQuestion, recover = false,
} = {}) {
  if (!coordinatedStages.includes(toStage) || toStage === 'integration' || typeof note !== 'string' || note.length > 1800) {
    throw new Error('Indica una etapa destinataria de trabajo y una aclaración de hasta 1800 caracteres.');
  }
  const text = safeMarkdownText(note).trim();
  return withInboxLock(root, `route:${requestId}`, async () => {
    const request = (await loadDashboardState(root)).coordinatorRequests.find(item => item.id === requestId);
    const job = (await loadState(root)).jobs.find(item => item.id === request?.jobId);
    if (!sameHandoffScope(request, job) || request.notification.status !== 'sent' || !origin
      || (recover && (toStage !== 'ux' || !settledUxReturnStep(job)))
      || origin.jobId !== job.id || origin.runId !== job.coordination.runId || origin.senderId !== job.coordination.senderId
      || (!recover && !/^msg_[A-Za-z0-9_-]{6,100}$/.test(origin.messageId ?? ''))) {
      throw new Error('Solo el coordinador asignado puede autorizar un traspaso dentro de su encargo.');
    }
    function existingHandoff(messageId, approvedNote) {
      const existing = request.workerHandoffs?.find(item => item.messageId === messageId);
      if (existing && (existing.toStage !== toStage || existing.note !== approvedNote
        || existing.taskId !== origin.taskId || existing.dispatchId !== origin.dispatchId)) {
        throw new Error('La aclaración ya fue autorizada con otro contenido, origen o destinatario.');
      }
      return existing;
    }
    const existing = origin.messageId && existingHandoff(origin.messageId, text);
    if (existing) return existing;
    const target = job.workflow?.steps?.find(item => item.key === toStage);
    if (!target || target.dispatchId === origin.dispatchId || target.status === 'skipped') throw new Error('El destinatario debe ser otra etapa de este encargo.');
    const owner = await verifyOwner(request.notification, { cwd: root, command });
    if (!owner.ok) throw new Error(owner.reason);
    const { job: current, step, authorizationReply } = await verifyQuestion(root, request, origin, command, toStage);
    if (!authorizationReply || (!recover && authorizationReply.note !== text)) throw new Error('La aclaración debe coincidir con la autorización nativa del coordinador.');
    const messageId = origin.messageId ?? step.questionMessageId;
    const verifiedNote = recover ? authorizationReply.note : text;
    if (!messageId || verifiedNote.length > 1800) throw new Error('La autorización nativa del traspaso es inválida.');
    const recovered = existingHandoff(messageId, verifiedNote);
    if (recovered) return recovered;
    if (!sameHandoffScope(request, current) || step.key === toStage || !step.delivery?.questions?.length) throw new Error('Falta la pregunta vigente del trabajador.');
    const record = {
      id: 'handoff-' + messageId, jobId: current.id, business: current.business, projectId: current.projectId || null,
      runId: origin.runId, taskId: origin.taskId, dispatchId: origin.dispatchId, messageId,
      attempt: current.attempts, fromStage: step.key, toStage, note: verifiedNote, authorizedBy: origin.senderId, approvalMessageId: authorizationReply.id,
      questions: step.delivery.questions.map(({ id, text }) => ({ id, text })), at: new Date().toISOString(),
    };
    return changeDashboardState(root, state => {
      const saved = state.coordinatorRequests.find(item => item.id === requestId);
      if (!sameHandoffScope(saved, current)) throw new Error('El encargo del traspaso cambió durante la autorización.');
      saved.workerHandoffs ||= [];
      if (saved.workerHandoffs.length >= 50) throw new Error('El encargo alcanzó el límite de aclaraciones registradas.');
      saved.workerHandoffs.push(record);
      saved.updatedAt = record.at;
      return record;
    });
  });
}

export function recoverSettledUxHandoff(root, job, options = {}) {
  const step = settledUxReturnStep(job);
  if (!step || !job.coordination) return null;
  return authorizeWorkerHandoff(root, job.coordination.requestId, {
    toStage: 'ux',
    origin: { jobId: job.id, runId: job.workflow.runId, taskId: step.taskId, dispatchId: step.dispatchId, senderId: job.coordination.senderId },
  }, { ...options, recover: true });
}

export function workerHandoffContext(request, job, stage) {
  if (!sameHandoffScope(request, job)) return [];
  return (request.workerHandoffs || []).filter(item => item.toStage === stage && item.jobId === job.id
    && item.business === job.business && item.projectId === (job.projectId || null)
    && item.runId === job.coordination.runId && item.authorizedBy === job.coordination.senderId
    && item.attempt === job.attempts).slice(-8);
}

export function questionsForEscalation(job, step, proposed) {
  const questions = step.delivery?.questions;
  if (!Array.isArray(questions) || !questions.length || !Array.isArray(proposed)
    || proposed.length !== questions.length || new Set(proposed.map(item => item.id)).size !== questions.length
    || proposed.some(item => !questions.some(original => original.id === item.id))) {
    throw new Error('Conserva los identificadores y la ronda de preguntas del trabajador; primero resuelve las dudas internas con él.');
  }
  return questions.map(item => ({ ...item, _roundId: `${job.id}:${step.dispatchId}` }));
}
