import { jobReport } from './job-report.mjs';
import fs from 'node:fs/promises';
import { sameRepository } from '../repository-name.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadDashboardState } from './agency-assistant/dashboard-state.mjs';
import { loadState } from './queue.mjs';
import { readAutoRun } from '../auto-run.mjs';
import { IDENTIFIERS } from '../workflow-contract.mjs';
import { coordinatorCommand } from './coordinator-bridge.mjs';

const PREPARATION_LIMIT = 512 * 1024;
const requestPattern = /^[A-Za-z0-9_-]{8,100}$/;
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const text = (value, limit = 1800) => typeof value === 'string' ? value.slice(0, limit) : '';
const list = value => Array.isArray(value) ? value : [];
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const labels = { ux: 'Diseño UX', developer: 'Desarrollo', qa: 'Pruebas de calidad', reviewer: 'Revisión', planner: 'Análisis', integration: 'Integración GitHub' };
const stageStatuses = { queued: 'pendiente', running: 'en curso', succeeded: 'completado', blocked: 'bloqueado', failed: 'falló', skipped: 'omitido', needs_attention: 'requiere revisión' };
const phases = { validation_pending: 'Archivos registrados para QA', validation_approved: 'QA y revisión confirmadas para estos archivos', preflight_complete: 'Destino comprobado', commit_intent: 'Preparando commit', commit_confirmed: 'Commit confirmado', push_intent: 'Publicación solicitada', push_confirmed: 'Push confirmado', pr_intent: 'Creando propuesta de cambio', pr_confirmed: 'PR confirmada', checks_pending: 'Esperando comprobaciones', merge_intent: 'Integración solicitada', complete: 'Integración confirmada', needs_attention: 'Requiere revisión' };
const preparationLabels = { github_create: 'Crear repositorio', github_verify: 'Comprobar repositorio', checkout_create: 'Preparar copia aislada', readme_create: 'Preparar documentación inicial', preparation_commit: 'Guardar base inicial', remote_configure: 'Conectar repositorio', push_main: 'Publicar rama base', work_branch_create: 'Preparar rama de trabajo', push_work_branch: 'Publicar rama de trabajo', orca_repo_add: 'Registrar proyecto en ORCA', panel_project_create: 'Registrar proyecto en el panel', panel_project_update: 'Confirmar destino del proyecto', final_verification: 'Comprobar preparación', worker_done: 'Entregar preparación' };
const statusLabels = { waiting_notice: 'Aviso pendiente', waiting_coordinator: 'Pendiente del coordinador', waiting_user: 'Necesita tu respuesta', preparing: 'Preparando proyecto', queued: 'En cola', running: 'En curso', blocked: 'Requiere revisión', answered: 'Consulta respondida', delivered: 'Entregado localmente', published: 'Integración GitHub confirmada', withdrawn: 'Retirada', cancelled: 'Cancelada', unavailable: 'Seguimiento no disponible' };
const isSha = value => /^[a-f0-9]{40,64}$/i.test(value || '');
const unavailable = reason => ({ available: false, reason });

export function createPreparationObserver(command = coordinatorCommand, now = Date.now) {
  const cache = new Map();
  let inFlight = 0;
  return (root, record) => {
    if (!['start_intent', 'dispatched', 'running'].includes(record.phase)
      || !IDENTIFIERS.dispatchId.test(record.dispatchId || '')
      || !IDENTIFIERS.taskId.test(record.taskId || '')
      || !IDENTIFIERS.runId.test(record.runId || '')) return null;
    const key = JSON.stringify([root, record.runId, record.taskId, record.dispatchId, record.dispatchedAtUtc]);
    const cached = cache.get(key);
    if (cached && now() - cached.at < 15_000) return cached.result;
    if (inFlight >= 2) return null;
    inFlight++;
    const result = Promise.resolve().then(async () => {
      const output = await command(['orchestration', 'worker-read', '--dispatch', record.dispatchId, '--source', 'transcript', '--limit', '5'], { cwd: root, timeoutMs: 3000 });
      const native = output?.projection;
      if (output?.source !== 'transcript' || output.sourceExact !== true || output.dispatchId !== record.dispatchId
        || native?.dispatchId !== record.dispatchId || native.taskId !== record.taskId || native.runId !== record.runId
        || native.stage?.activity !== 'done' || native.outcome !== 'in_progress') return null;
      const last = output.transcript?.messages?.at(-1);
      if (last?.role !== 'system' || !list(last.blocks).some(block => block.type === 'text' && block.text === 'Conversation interrupted')) return null;
      if (!Number.isFinite(last.timestamp) || last.timestamp < (Date.parse(record.dispatchedAtUtc) || 0)) return null;
      return { interruptedAt: new Date(last.timestamp).toISOString() };
    }).catch(() => null).finally(() => { inFlight--; });
    if (cache.size >= 32) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), result });
    return result;
  };
}

const preparationInterrupted = 'Orca confirma que el turno del preparador se interrumpió. El coordinador debe revisar ese mismo dispatch y comprobar sus operaciones antes de continuar.';

// Read only the record belonging to this request. Bound both allocation and read
// even if a concurrently written file grows after stat (a real historical case).
export async function readPreparationRecord(root, requestId) {
  if (!requestPattern.test(requestId || '')) return unavailable('Identificador de preparación inválido.');
  let handle;
  try {
    const realRoot = await fs.realpath(root);
    const base = path.join(realRoot, 'data', 'coordinators', 'preparation');
    if (await fs.realpath(base) !== base) return unavailable('El registro de preparación está fuera de su directorio.');
    const file = path.join(base, `${requestId}.json`);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) return unavailable('El registro de preparación no es un archivo local independiente.');
    if (stat.size > PREPARATION_LIMIT) return unavailable('El registro de preparación supera el límite de 512 KB.');
    handle = await fs.open(file, 'r');
    const opened = await handle.stat();
    if (opened.size > PREPARATION_LIMIT) return unavailable('El registro de preparación supera el límite de 512 KB.');
    const buffer = Buffer.alloc(PREPARATION_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > PREPARATION_LIMIT || (await handle.stat()).size > PREPARATION_LIMIT) return unavailable('El registro de preparación supera el límite de 512 KB.');
    return { available: true, record: JSON.parse(buffer.subarray(0, length).toString('utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    return error.code === 'ENOENT' ? null : unavailable('El registro de preparación no está disponible o se está actualizando.');
  } finally { await handle?.close(); }
}

function coordinator(request) {
  const notice = request.notification || {};
  return { id: notice.coordinatorId || notice.senderId || null, name: notice.coordinatorName || 'Coordinador', role: 'coordinator', runId: notice.runId || null, senderId: notice.senderId || null };
}
function worker(step) {
  return { id: step.dispatchId || step.taskId || step.profile || null, name: step.label || labels[step.key] || step.profile || 'Trabajador', role: step.key === 'integration' ? 'integration' : 'worker', runId: step.runId || null, taskId: step.taskId || null, dispatchId: step.dispatchId || null };
}
function assignedProject(request) { return request.route?.projectId || request.route?.confirmation?.projectId || request.projectId || request.snapshot?.projectId || null; }
function workerCitationEvidence(receipt, jobs) {
  const actor = receipt.actor;
  if (actor?.kind !== 'worker' || !receipt.jobId || actor.jobId !== receipt.jobId
    || !actor.runId || !actor.taskId || !actor.dispatchId || !actor.stage || !Number.isInteger(actor.jobAttempt)) return [];
  const job = jobs.find(item => item.id === receipt.jobId);
  if (!job) return [];
  return [...list(job.workflowHistory), ...(job.workflow ? [job.workflow] : [])].flatMap(workflow => list(workflow.steps).flatMap(step => {
    const delivery = step.delivery;
    const inputAttempt = step.taskInputAttempt ?? step.attempt ?? workflow.attempt ?? job.attempts;
    if (step.key !== actor.stage || step.runId !== actor.runId || step.taskId !== actor.taskId || step.dispatchId !== actor.dispatchId
      || inputAttempt !== actor.jobAttempt || delivery?.jobId !== job.id || delivery.stage !== actor.stage || delivery.jobAttempt !== actor.jobAttempt
      || delivery.runId !== actor.runId || delivery.taskId !== actor.taskId || delivery.dispatchId !== actor.dispatchId) return [];
    return list(delivery.evidence).filter(item => typeof item === 'string');
  }));
}
function citesSource(evidence, id) {
  if (typeof id !== 'string' || !id) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return evidence.some(item => new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, 'u').test(item));
}
function requestJobs(request, jobs) {
  const projectId = assignedProject(request);
  const scoped = jobs.filter(job => job.business === request.business && (!projectId || job.projectId === projectId));
  const linked = scoped.filter(job => {
    if (job.coordination?.requestId) return job.coordination.requestId === request.id
      && (!request.notification?.runId || job.coordination.runId === request.notification.runId)
      && (!request.notification?.senderId || job.coordination.senderId === request.notification.senderId);
    return job.id === request.jobId || request.kind === 'idea' && job.ideaId === request.ideaId && (job.ideaVersion || 1) === (request.ideaVersion || 1);
  });
  const ids = new Set(linked.map(job => job.id));
  for (let pass = 0; pass < scoped.length; pass++) {
    const children = scoped.filter(job => !ids.has(job.id) && !job.coordination?.requestId
      && (ids.has(job.continuation?.parentJobId) || ids.has(job.continuation?.rootJobId)));
    if (!children.length) break;
    for (const child of children) { ids.add(child.id); linked.push(child); }
  }
  return linked.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
}
// Earlier coordinators kept the verification and routing receipt in nested fields.
export function normalizeRoutedPreparation(record) {
  if (record.phase !== 'routed') return record;
  const start = record.startReceipt?.result;
  const result = record.preparation?.result;
  const verified = record.coordinatorVerification;
  const receipt = record.routeReceipt?.receipt;
  const job = record.routeReceipt?.job;
  const request = record.routeReceipt?.request;
  const confirmation = record.routeIntent?.confirmation;
  if (record.startReceipt?.ok !== true || !start || !result || !verified || !receipt || !job || !request || !confirmation
    || result.requestId !== record.requestId || result.runId !== record.runId || result.senderId !== record.senderId
    || result.business !== record.business || start.runId !== record.runId
    || !IDENTIFIERS.taskId.test(start.taskId || '') || !IDENTIFIERS.dispatchId.test(start.dispatchId || '')
    || start.taskId !== result.taskId || start.dispatchId !== result.dispatchId
    || request.id !== record.requestId || request.status !== 'routed'
    || request.jobId !== job.id || request.receiptId !== receipt.id || receipt.jobId !== job.id || job.autoIntent?.receiptId !== receipt.id
    || job.coordination?.requestId !== record.requestId || job.coordination?.runId !== record.runId || job.coordination?.senderId !== record.senderId
    || verified.business !== record.business || job.business !== record.business
    || !date(verified.verifiedAtUtc) || verified.independentGitDirectory !== true || result.independentGitDirectory !== true
    || verified.cleanGitStatus !== true || result.cleanGitStatus !== true
    || !path.isAbsolute(result.absoluteCheckout || '') || path.resolve(result.absoluteCheckout) !== path.resolve(job.workspace || '')
    || !verified.projectId || [job.projectId, result.projectId, confirmation.projectId].some(id => id !== verified.projectId)
    || !verified.repository || String(result.repository || '').toLowerCase() !== String(verified.repository).toLowerCase()
    || !verified.checkout || [result.relativeCheckout, confirmation.checkout].some(checkout => checkout !== verified.checkout)
    || !verified.branch || [result.branch, confirmation.branch].some(branch => branch !== verified.branch)
    || !verified.baseBranch || [result.baseBranch, confirmation.baseBranch].some(branch => branch !== verified.baseBranch)
    || !isSha(verified.localSha) || verified.localSha !== result.localBranchSha) return null;
  const remoteSha = branch => {
    const matches = list(verified.remoteRefs).map(line => String(line).trim().split(/\s+/)).filter(fields => fields[1] === 'refs/heads/' + branch);
    return matches.length === 1 ? matches[0][0] : null;
  };
  const remoteWorkSha = remoteSha(verified.branch), remoteMainSha = remoteSha(verified.baseBranch);
  if (!isSha(remoteWorkSha) || !isSha(remoteMainSha) || remoteWorkSha !== verified.localSha
    || remoteWorkSha !== result.remoteBranchSha || remoteMainSha !== result.remoteMainSha) return null;
  return { ...record, phase: 'job_queued', taskId: start.taskId, dispatchId: start.dispatchId, productJobId: job.id, productReceiptId: receipt.id,
    verifiedAt: verified.verifiedAtUtc, checkoutAbsolute: result.absoluteCheckout, independentGitDirectory: true,
    routeIntent: { ...record.routeIntent, requestId: record.requestId, business: record.business, projectId: verified.projectId,
      repository: verified.repository, checkout: verified.checkout, branch: verified.branch, baseBranch: verified.baseBranch,
      gitClean: true, headSha: verified.localSha, remoteWorkSha, remoteMainSha },
  };
}

function preparationFor(request, supplied) {
  if (!supplied) return null;
  if (supplied.available === false) return supplied;
  const record = supplied.record || supplied;
  if (record.schemaVersion !== 1 || record.requestId !== request.id || record.business !== request.business
    || !request.notification?.runId || !request.notification?.senderId
    || record.runId !== request.notification.runId || record.senderId !== request.notification.senderId) return unavailable('El registro de preparación no coincide con la solicitud y su coordinador.');
  const normalized = normalizeRoutedPreparation(record);
  return normalized ? { available: true, record: normalized } : unavailable('El traspaso de preparación no coincide con su destino y recibo registrados.');
}
function integrationFor(job, automation, receipts) {
  const receipt = receipts.find(item => item.id === job.autoIntent?.receiptId && item.jobId === job.id);
  const record = automation.integrations?.[job.autoIntent?.receiptId];
  if (!job.autoIntent?.eligible || !receipt?.eligible || !record || record.jobId !== job.id || record.receiptId !== receipt.id
    || !sameRepository(record.repository, job.destination?.repository) || record.sourceBranch !== job.branch || record.baseBranch !== job.destination?.baseBranch) return null;
  return record;
}
const published = record => record?.phase === 'complete' && record.status === 'completed' && isSha(record.commitSha)
  && (record.sourceBranch === record.baseBranch || isSha(record.mergeSha));

function preparationHandoff(record, request, linked, receipts) {
  if (record.phase !== 'job_queued') return { linked: false, verified: false };
  const job = linked.find(item => item.id === record.productJobId);
  if (!job) return { linked: false, verified: false };
  const receipt = receipts.find(item => item.id === record.productReceiptId && item.jobId === job.id && item.id === job.autoIntent?.receiptId);
  const route = record.routeIntent, destination = job.destination;
  const verified = Boolean(receipt && route && destination && date(record.verifiedAt)
    && route.requestId === request.id && route.business === request.business && route.projectId === job.projectId
    && String(route.repository || '').toLowerCase() === String(destination.repository || '').toLowerCase()
    && route.checkout === destination.checkout && route.branch === job.branch && route.baseBranch === destination.baseBranch
    && record.checkoutAbsolute && path.resolve(record.checkoutAbsolute) === path.resolve(job.workspace || '')
    && record.independentGitDirectory === true && route.gitClean === true
    && isSha(route.headSha) && route.headSha === destination.sha
    && isSha(route.remoteWorkSha) && route.remoteWorkSha === destination.remoteSha
    && isSha(route.remoteMainSha) && route.remoteMainSha === destination.baseSha);
  return { linked: true, verified };
}

function projectTrace(request, inputs, prepared) {
  const { jobs, questions, automation, knowledge } = inputs;
  const owner = coordinator(request), linked = requestJobs(request, jobs), jobIds = new Set(linked.map(job => job.id));
  const primary = linked.at(-1), projectId = assignedProject(request) || primary?.projectId || prepared?.record?.result?.projectId || null;
  const receipts = list(automation.receipts).filter(receipt => receipt.business === request.business
    && (jobIds.has(receipt.jobId) || receipt.id === request.receiptId && (receipt.spec?.coordination?.requestId === request.id
      || receipt.spec?.id === `${request.id}-analysis` || receipt.spec?.id === `${request.id}-code`
      || request.kind === 'idea' && receipt.spec?.ideaId === request.ideaId && (receipt.spec.ideaVersion || 1) === (request.ideaVersion || 1))));
  const receiptIds = new Set(receipts.map(receipt => receipt.id));
  const relatedQuestions = questions.filter(question => question.business === request.business
    && (question.coordinatorRequestId === request.id || !question.coordinatorRequestId && jobIds.has(question.jobId)));
  const events = new Map(), steps = [];
  const event = (id, at, kind, label, summary = '', stage = null, agent = owner, ids) => events.set(id, {
    id, at: date(at), kind, label, summary: text(summary, 4000), stage, agent, ...(ids ? { ids } : {}),
  });
  event(`${request.id}:created`, request.createdAt, 'request', request.intent === 'consultation' ? 'Consulta guardada' : 'Petición guardada', request.snapshot?.text);
  const notice = request.notification || {};
  if (notice.status) event(`${request.id}:notice:${notice.messageId || notice.status}`, notice.updatedAt || request.createdAt, 'notification', notice.status === 'sent' ? 'Aviso entregado al coordinador' : 'Aviso pendiente de confirmación', notice.reason, 'coordination');
  steps.push({ key: 'coordination', label: 'Coordinación', status: notice.status === 'sent' ? 'succeeded' : ['unknown', 'needs_attention'].includes(notice.status) ? 'blocked' : 'queued', summary: text(notice.reason || (notice.status === 'sent' ? 'Solicitud entregada al responsable.' : 'La solicitud está guardada.')), agent: owner, at: date(notice.updatedAt || request.createdAt) });
  for (const [index, route] of [...list(request.routeHistory), ...(request.route ? [request.route] : [])].entries()) event(`${request.id}:route:${index}`, route.at, 'decision', route.kind === 'code' ? 'Ruta de desarrollo decidida' : 'Ruta de análisis decidida', route.reason, 'coordination');
  const qualityNotices = list(request.qualityNotices);
  for (const handoff of qualityNotices) {
    const sent = handoff.notification?.status === 'sent';
    event(`${handoff.id}:handoff`, handoff.notification?.updatedAt || handoff.createdAt, 'notification',
      sent ? 'Validación pendiente escalada al coordinador' : 'Aviso de calidad pendiente',
      handoff.notification?.reason || handoff.snapshot?.text, 'coordination', owner, handoff.origin);
    if (handoff.resume?.status === 'blocked') event(`${handoff.id}:resume-blocked`, handoff.resume.updatedAt, 'recovery',
      'Continuación de calidad pendiente', handoff.resume.reason, handoff.origin?.jobId ? `${handoff.origin.jobId}:qa` : 'coordination', owner, handoff.origin);
    if (handoff.plan) event(`${handoff.id}:plan`, handoff.plan.updatedAt, 'decision', 'Siguiente paso de validación', handoff.plan.text, 'coordination', owner, handoff.origin);
  }
  for (const question of relatedQuestions) {
    event(`${question.id}:asked`, question.createdAt, 'question', 'Decisión solicitada', question.question, 'decisions');
    if (question.status === 'answered') event(`${question.id}:answered`, question.answeredAt, 'decision', 'Respuesta del usuario guardada', question.answer, 'decisions', { id: 'user', name: 'Tú', role: 'user' });
    if (question.status === 'withdrawn') event(`${question.id}:closed`, question.closedAt || request.withdrawnAt, 'question', 'Pregunta cerrada', question.closedByResponseId ? 'La consulta terminó sin necesitar esta respuesta opcional.' : 'La solicitud se retiró; la pregunta queda en el historial.', 'decisions');
  }
  if (relatedQuestions.length) steps.push({ key: 'decisions', label: 'Decisiones', status: relatedQuestions.some(question => question.status === 'pending' && question.required !== false) ? 'blocked' : 'succeeded',
    summary: `${relatedQuestions.filter(question => question.status === 'answered').length} respuestas guardadas; ${relatedQuestions.filter(question => question.status === 'withdrawn').length} preguntas cerradas.`, agent: owner,
    at: date(relatedQuestions.map(question => question.answeredAt || question.createdAt).filter(Boolean).sort().at(-1)) });
  for (const answerNotice of list(request.answerNotices)) event(`${answerNotice.id}:notice`, answerNotice.notification?.updatedAt || answerNotice.createdAt, 'notification', answerNotice.notification?.status === 'sent' ? 'Decisiones entregadas al coordinador' : 'Decisiones guardadas; aviso pendiente', answerNotice.notification?.reason, answerNotice.roundId || null);

  let prepBlocked = false;
  if (prepared?.available === false) {
    steps.push({ key: 'preparation', label: 'Preparación del proyecto', status: 'blocked', summary: prepared.reason, agent: owner, at: null });
    event(`${request.id}:preparation:unavailable`, null, 'preparation', 'Preparación no disponible', prepared.reason, 'preparation');
  } else if (prepared?.record) {
    const record = prepared.record;
    const handoff = preparationHandoff(record, request, linked, receipts);
    const interruptedAt = prepared.observation?.interruptedAt;
    prepBlocked = Boolean(interruptedAt) || ['failed', 'blocked', 'needs_attention'].includes(record.status) || ['failed', 'blocked', 'needs_attention'].includes(record.phase) || record.phase === 'job_queued' && !handoff.linked;
    const verified = record.phase === 'verified' || handoff.verified;
    const agent = { id: record.dispatchId || null, name: 'Preparador del proyecto', role: 'preparation', runId: record.runId, taskId: record.taskId || null, dispatchId: record.dispatchId || null };
    steps.push({ key: 'preparation', label: 'Preparación del proyecto', status: prepBlocked ? 'blocked' : verified ? 'succeeded' : handoff.linked ? 'skipped' : 'running',
      summary: text(interruptedAt ? preparationInterrupted : record.error || record.reason || (record.phase === 'job_queued' && !handoff.linked ? 'El registro de preparación no coincide con el trabajo encolado.' : handoff.verified ? 'Destino verificado y encargo encolado. Este traspaso no acredita por sí solo el cierre físico del preparador.' : handoff.linked ? 'Trabajo de producto vinculado; la evidencia de preparación está incompleta.' : verified ? 'Destino preparado y verificado por el coordinador.' : record.status === 'prepared' ? 'Preparación entregada; pendiente de verificación del coordinador.' : 'Preparación registrada bajo esta solicitud.')), agent, at: date(interruptedAt || record.routeAcceptedAt || record.verifiedAt || record.completedAt || record.dispatchedAtUtc || record.startedAt || record.createdAt) });
    event(`${request.id}:preparation:start`, record.dispatchedAtUtc || record.startedAt || record.createdAt, 'preparation', 'Preparación iniciada', record.targetName, 'preparation', agent);
    if (interruptedAt) event(`${request.id}:preparation:interrupted:${record.dispatchId}`, interruptedAt, 'preparation', 'Preparación interrumpida', preparationInterrupted, 'preparation', agent);
    const checkpoints = [...list(record.checkpoints), ...list(record.followUps), ...list(record.followups)];
    if (record.followUpOf) checkpoints.unshift(record);
    for (const [index, checkpoint] of checkpoints.entries()) {
      if (checkpoint.runId && checkpoint.runId !== record.runId || checkpoint.senderId && checkpoint.senderId !== record.senderId) continue;
      const dispatchId = checkpoint.dispatchId || checkpoint.dispatch_id || null;
      const taskId = checkpoint.taskId || checkpoint.task_id || null;
      event(`${request.id}:preparation:checkpoint:${index}:${dispatchId || ''}`, checkpoint.at || checkpoint.createdAt || checkpoint.startedAt, 'preparation', checkpoint.followUpOf || checkpoint.follow_up_of ? 'Seguimiento del preparador registrado' : 'Estado del preparador registrado', checkpoint.summary || checkpoint.phase || checkpoint.status, 'preparation', { ...agent, taskId, dispatchId, id: dispatchId || taskId },
        { taskId, dispatchId, followUpOf: checkpoint.followUpOf || checkpoint.follow_up_of || null });
    }
    for (const [index, operation] of list(record.operations).entries()) event(`${request.id}:preparation:operation:${index}`, operation.at, 'preparation', `${preparationLabels[operation.operation] || 'Operación de preparación'} · ${operation.phase === 'receipt' ? 'confirmada' : operation.phase === 'intent' ? 'solicitada' : text(operation.phase, 40)}`, operation.summary || operation.error, 'preparation', agent);
    if (!list(record.operations).length) for (const [index, item] of list(record.operationSummary).entries()) {
      const match = typeof item === 'string' ? item.match(/^([a-z0-9_]+):(intent|receipt)@(.+)$/) : null;
      if (match && date(match[3])) event(`${request.id}:preparation:operation:${index}`, match[3], 'preparation', `${preparationLabels[match[1]] || 'Operación de preparación'} · ${match[2] === 'receipt' ? 'confirmada' : 'solicitada'}`, '', 'preparation', agent);
    }
    if (record.normalizationTaskId && record.normalizationDispatchId) event(`${request.id}:preparation:normalization`, record.normalizedAt, 'preparation', 'Registro de preparación normalizado', record.normalizationNote, 'preparation',
      { ...agent, id: record.normalizationDispatchId, taskId: record.normalizationTaskId, dispatchId: record.normalizationDispatchId }, { taskId: record.normalizationTaskId, dispatchId: record.normalizationDispatchId, relatedDispatchId: record.dispatchId });
    if (record.completedAt || verified) event(`${request.id}:preparation:result`, record.routeAcceptedAt || record.verifiedAt || record.completedAt, 'preparation', handoff.verified ? 'Preparación verificada y encargo encolado' : verified ? 'Preparación verificada' : 'Preparación entregada', verified ? 'No equivale a la entrega del producto.' : 'El cierre nativo y el destino requieren verificación.', 'preparation', agent);
  }

  for (const handoff of list(request.workerHandoffs)) if (jobIds.has(handoff.jobId) && handoff.business === request.business) {
    event(handoff.id, handoff.at, 'decision',
      `Aclaración autorizada · ${labels[handoff.fromStage] || handoff.fromStage} → ${labels[handoff.toStage] || handoff.toStage}`,
      [handoff.note, ...list(handoff.questions).map(item => item.text)].filter(Boolean).join('\n'),
      `${handoff.jobId}:${handoff.toStage}`, owner, { jobId: handoff.jobId, dispatchId: handoff.dispatchId, messageId: handoff.messageId, approvalMessageId: handoff.approvalMessageId });
  }
  for (const job of linked) {
    event(`${job.id}:created`, job.createdAt, 'job', 'Trabajo creado', job.title);
    const workflows = [...list(job.workflowHistory), ...(job.workflow ? [job.workflow] : [])];
    for (const workflow of workflows) for (const step of list(workflow.steps)) {
      const key = `${job.id}:${step.key}`;
      if (step.status !== 'queued') event(`stage:${digest(`${job.id}:${step.dispatchId || workflow.attempt || job.attempts}:${step.key}:${step.status}:${step.updatedAt || workflow.updatedAt || ''}`)}`, step.updatedAt || workflow.updatedAt, 'stage', `${step.label || labels[step.key] || step.key} · ${stageStatuses[step.status] || step.status}`, step.summary || step.error, key, worker(step),
        { jobId: job.id, taskId: step.taskId || null, dispatchId: step.dispatchId || null, attempt: step.attempt || workflow.attempt || job.attempts, taskInputAttempt: step.taskInputAttempt || step.attempt || workflow.attempt || job.attempts });
      const authorization = step.authorization;
      if (authorization?.requestId === request.id && authorization.jobId === job.id && authorization.to === step.key) {
        const from = labels[authorization.from] || authorization.from || 'Coordinación';
        const to = step.label || labels[step.key] || step.key;
        event(`handoff:${job.id}:${step.key}:${authorization.at}`, authorization.at, 'decision',
          `Traspaso autorizado · ${from} → ${to}`,
          authorization.mode === 'contract_correction' ? `Corrección del contrato · ronda ${authorization.round}` : 'Secuencia aprobada al enrutar el encargo.',
          key, owner, { jobId: job.id, taskId: authorization.taskId || null, dispatchId: authorization.dispatchId || null, messageId: authorization.messageId || null });
      }
      if (step.questionCheckError) {
        event(`${job.id}:ask:${step.dispatchId}:check`, step.updatedAt || workflow.updatedAt, 'decision', 'Comprobación de preguntas pendiente',
          step.questionCheckError, key, worker(step), { jobId: job.id, taskId: step.taskId, dispatchId: step.dispatchId });
      }
      const askId = step.questionMessageId || step.answeredQuestionMessageId;
      if (askId && step.questionTransport === 'damaged') {
        event(`${job.id}:ask:${askId}:transport`, step.updatedAt || workflow.updatedAt, 'decision', 'Pregunta de Orca recuperada',
          `El formato de la pregunta llegó dañado. Orca conserva el mensaje ${askId}.`, key, worker(step),
          { jobId: job.id, taskId: step.taskId, dispatchId: step.dispatchId, messageId: askId });
      }
    }
    for (const step of list(job.workflow?.steps)) steps.push({ key: `${job.id}:${step.key}`, label: step.label || labels[step.key] || step.key, status: step.status, summary: text(step.summary || step.error), agent: worker(step), at: date(step.updatedAt) });
    for (const [index, attempt] of list(job.attemptHistory).entries()) event(`${job.id}:attempt:${attempt.attempt}:segment:${index}:${attempt.recoveryId || ''}`, attempt.finishedAt || attempt.startedAt, 'recovery', `Intento ${attempt.attempt} · ${stageStatuses[attempt.outcome] || 'registrado'}`, attempt.error, null, owner, { jobId: job.id, attempt: attempt.attempt, segment: index, recoveryId: attempt.recoveryId || null });
    const integration = integrationFor(job, automation, receipts);
    if (integration) {
      const label = published(integration) ? (integration.sourceBranch === integration.baseBranch ? 'Push confirmado' : 'Merge confirmado') : integration.phase === 'checks_pending' ? 'Esperando comprobaciones de GitHub' : 'Integración GitHub pendiente';
      event(`${job.id}:integration:${integration.phase}`, integration.updatedAt || integration.mergedAt || integration.pushedAt, 'integration', label, integration.error || integration.prUrl, `${job.id}:integration`, { id: 'integration', name: 'Integración GitHub', role: 'integration' },
        { jobId: job.id, receiptId: integration.receiptId, commitSha: integration.commitSha || null, mergeSha: integration.mergeSha || null, prUrl: integration.prUrl || null });
    }
    if (job.finishedAt) event(`${job.id}:finished:${job.attempts}`, job.finishedAt, 'job', job.state === 'succeeded' ? published(integration) ? 'Entrega integrada en GitHub' : 'Entrega local registrada' : job.state === 'cancelled' ? 'Trabajo cancelado' : 'Trabajo pendiente de revisión', job.error?.message);
  }
  for (const [index, item] of list(automation.history).entries()) if ((!item.business || item.business === request.business) && (jobIds.has(item.jobId) || receiptIds.has(item.receiptId))) {
    event(`${request.id}:automation:${index}`, item.at, item.type === 'github_integration' ? 'integration' : 'recovery', item.type === 'github_integration' ? phases[item.phase] || 'Estado de integración registrado' : item.type === 'submission_confirmed' ? 'Envío confirmado' : item.type === 'claimed' ? 'Ejecución admitida' : item.type === 'completed' ? 'Ejecución terminada' : item.type.includes('recovery') || item.type.includes('retry') ? 'Recuperación registrada' : 'Estado de ejecución registrado', item.reason, item.phase || null, owner, { jobId: item.jobId || null, receiptId: item.receiptId || null, dispatchId: item.dispatchId || null });
  }
  for (const receipt of receipts) if (receipt.dispatchRecovery) {
    const recovery = receipt.dispatchRecovery;
    const recoveryLabel = recovery.mode === 'same_attempt_ux_return' ? 'Retorno a Diseño autorizado'
      : ['same_attempt_developer_decision', 'same_attempt_stage_decision'].includes(recovery.mode) ? 'Etapa reanudada con decisión registrada'
      : recovery.qualityAction?.type === 'correction' ? `Corrección de Desarrollo · ronda ${recovery.qualityAction.round}`
      : recovery.qualityAction?.type === 'answer' ? (recovery.stage === 'reviewer' ? 'Revisión reanudada con tu respuesta' : 'QA reanudado con tu respuesta')
      : recovery.mode === 'same_attempt_integration_validation' ? 'Nueva validación antes de publicar'
      : recovery.mode === 'same_attempt_integration_reconcile' ? 'Continuación sobre la PR existente' : 'Recuperación del mismo trabajador';
    event(`${receipt.id}:recovery:${recovery.id}`, recovery.updatedAt || recovery.verifiedAt || recovery.createdAt, 'recovery', recoveryLabel, recovery.lastError || `Estado: ${recovery.phase}`, `${receipt.jobId}:${recovery.stage}`, owner,
      { jobId: receipt.jobId, taskId: recovery.taskId, dispatchId: recovery.dispatchId, attempt: recovery.attempt });
  }
  const scopedKnowledge = knowledge.filter(item => (item.business || item.scope?.business) === request.business
    && (item.requestId === request.id || !item.requestId && jobIds.has(item.jobId))
    && (!item.actor?.runId || !notice.runId || item.actor.runId === notice.runId)
    && (!item.actor?.senderId || !notice.senderId || item.actor.senderId === notice.senderId));
  const declaredIds = new Set(list(request.response?.sources).map(source => source.id).filter(Boolean));
  const relatedKnowledge = scopedKnowledge.map(item => {
    const evidence = workerCitationEvidence(item, linked);
    return { ...item, ...(!item.projectState && item.scope?.projectId && linked.some(job => job.kind === 'code' && job.coordination)
      ? { legacyProjectContext: true } : {}), citedSourceIds: list(item.sources).filter(source => source.delivered === true && (declaredIds.has(source.id) || citesSource(evidence, source.id))).map(source => source.id) };
  });
  const deliveredIds = new Set(relatedKnowledge.flatMap(item => list(item.sources).filter(source => source.delivered === true).map(source => source.id)));
  for (const item of relatedKnowledge) event(`${request.id}:knowledge:${item.id}`, item.createdAt, 'knowledge', list(item.sources).length ? 'Contexto consultado' : 'Consulta de contexto sin fuentes', item.query || item.notice, item.actor?.stage || null, item.actor || owner);
  const response = request.response ? { ...request.response, sources: list(request.response.sources).map(source => ({ ...source, citationVerified: Boolean(source.id && deliveredIds.has(source.id)), label: source.id && deliveredIds.has(source.id) ? 'Fuente consultada citada' : 'Referencia declarada' })) } : null;
  if (response) {
    steps.push({ key: 'response', label: 'Respuesta del coordinador', status: 'succeeded', summary: text(response.text), agent: owner, at: date(response.at) });
    event(`${request.id}:response:${response.responseId}`, response.at, 'response', 'Consulta respondida', response.text, 'response');
  }
  if (request.status === 'withdrawn') event(`${request.id}:withdrawn`, request.withdrawnAt, 'request', 'Solicitud retirada', 'El historial se conserva.');

  let status = 'waiting_coordinator', currentStage = 'coordination', nextAction = 'El coordinador debe responder o decidir la ruta.';
  const answerNotices = list(request.answerNotices).map(item => ({ id: item.id, roundId: item.roundId,
    notification: { status: item.notification?.status || 'pending', reason: text(item.notification?.reason), updatedAt: date(item.notification?.updatedAt || item.createdAt) } }));
  const uncertainAnswers = answerNotices.some(item => ['sending', 'unknown', 'needs_attention'].includes(item.notification.status));
  const pendingAnswers = answerNotices.some(item => item.notification.status === 'pending');
  const waiting = relatedQuestions.filter(question => question.status === 'pending' && question.required !== false);
  const primaryReceipt = receipts.find(receipt => receipt.jobId === primary?.id);
  if (request.status === 'withdrawn') { status = 'withdrawn'; nextAction = 'No hay acciones pendientes en esta solicitud.'; }
  else if (request.status === 'answered' && response) { status = 'answered'; currentStage = 'response'; nextAction = 'Consulta respondida. Puedes abrir una nueva petición si necesitas continuar.'; }
  else if (uncertainAnswers) { status = 'blocked'; currentStage = 'decisions'; nextAction = 'Consulta la entrega de respuestas al coordinador; el aviso no está confirmado. Las decisiones siguen guardadas.'; }
  else if (waiting.length) { status = 'waiting_user'; currentStage = 'decisions'; nextAction = `${waiting.length} decisión${waiting.length === 1 ? '' : 'es'} pendiente${waiting.length === 1 ? '' : 's'} de tu respuesta.`; }
  else if (pendingAnswers) { status = 'waiting_notice'; currentStage = 'decisions'; nextAction = 'Las respuestas están guardadas; su aviso al coordinador sigue pendiente.'; }
  else if (primary) {
    currentStage = primary.workflow?.currentStage ? `${primary.id}:${primary.workflow.currentStage}` : null;
    if (primary.state === 'running') {
      status = 'running';
      const record = integrationFor(primary, automation, receipts);
      nextAction = record?.phase === 'checks_pending' && record.checkState === 'waiting'
        ? 'Esperando los checks de GitHub en la PR existente. El panel continuará al confirmarse el resultado.'
        : 'El equipo está trabajando; las decisiones necesarias aparecerán aquí.';
    }
    else if (primary.state === 'needs_attention' || ['blocked', 'needs_attention'].includes(primaryReceipt?.status)) {
      status = 'blocked';
      const stage = list(primary.workflow?.steps).find(item => item.key === primary.workflow.currentStage);
      const handoff = qualityNotices.find(item => item.origin?.jobId === primary.id && item.origin.messageId === stage?.resultMessageId);
      nextAction = handoff?.plan?.text || (handoff ? handoff.notification?.status === 'sent'
        ? 'El coordinador recibió la validación pendiente. Revisará qué puede resolver el equipo y dejará aquí las decisiones que necesiten tu respuesta.'
        : 'El aviso de calidad está guardado y pendiente de confirmar su entrega al coordinador.'
        : text(primary.error?.message || primaryReceipt?.reason || 'Revisa la etapa y sus evidencias antes de continuar.'));
    }
    else if (primary.state === 'succeeded') { status = published(integrationFor(primary, automation, receipts)) ? 'published' : 'delivered'; nextAction = status === 'published' ? 'Integración remota confirmada; puedes revisar la entrega.' : 'Entrega local registrada; no acredita publicación en GitHub.'; }
    else if (primary.state === 'cancelled') { status = 'cancelled'; nextAction = 'El trabajo se cerró; su historial permanece disponible.'; }
    else { status = 'queued'; nextAction = primary.autoIntent?.eligible ? automation.businesses?.[request.business] === false ? 'La autoejecución de esta empresa está pausada.' : 'Esperando al ejecutor disponible.' : 'La ejecución manual está pendiente.'; }
  } else if (receipts.length) { status = receipts.some(receipt => ['blocked', 'needs_attention'].includes(receipt.status)) ? 'blocked' : 'queued'; currentStage = 'queue'; nextAction = status === 'blocked' ? text(receipts.find(receipt => receipt.reason)?.reason || 'El envío requiere revisión.') : 'El envío está confirmado; falta materializar su trabajo.'; }
  else if (prepared?.available === false) { status = 'unavailable'; currentStage = 'preparation'; nextAction = prepared.reason; }
  else if (prepared?.record) { status = prepBlocked ? 'blocked' : 'preparing'; currentStage = 'preparation'; nextAction = prepared.observation?.interruptedAt ? preparationInterrupted : prepBlocked ? text(prepared.record.error || prepared.record.reason || 'El coordinador debe revisar la preparación.') : prepared.record.phase === 'verified' || prepared.record.status === 'prepared' ? 'El coordinador debe confirmar la preparación y decidir la ruta del producto.' : 'Preparación registrada. El destino sigue pendiente de verificación.'; }
  else if (request.status === 'routing') { status = 'queued'; nextAction = 'La decisión está guardada; se está materializando el mismo trabajo.'; }
  else if (request.status === 'routed') { status = 'blocked'; nextAction = 'La ruta no tiene un trabajo o recibo asociado verificable; requiere revisión.'; }
  else if (request.status === 'needs_attention' || ['unknown', 'needs_attention'].includes(notice.status)) { status = 'blocked'; nextAction = text(request.reason || notice.reason || 'Hay un aviso o una decisión que requiere revisión.'); }
  else if (notice.status !== 'sent') { status = 'waiting_notice'; nextAction = text(notice.reason || 'El aviso queda guardado hasta confirmar la conexión con el coordinador.'); }
  const sortedEvents = [...events.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id));
  if (currentStage === 'queue') steps.push({ key: 'queue', label: 'Entrada en la cola', status: status === 'blocked' ? 'blocked' : 'queued', summary: nextAction, agent: owner, at: date(receipts.at(-1)?.confirmedAt) });
  return { requestId: request.id, kind: request.kind || null, intent: request.intent || 'task', title: text(request.snapshot?.title || request.snapshot?.text || 'Solicitud', 160), business: request.business,
    projectId, projectName: primary?.projectName || request.projectName || request.snapshot?.projectName || '', status, statusLabel: statusLabels[status], currentStage, nextAction, responsible: owner,
    steps, reports: linked.map(job => jobReport(job, integrationFor(job, automation, receipts))), events: sortedEvents.slice(-500), questions: relatedQuestions, answerNotices, response, knowledge: relatedKnowledge,
    ids: { requestId: request.id, ideaId: request.ideaId || null, jobIds: [...jobIds], receiptIds: [...receiptIds], runId: notice.runId || null, eventsTruncated: sortedEvents.length > 500 } };
}

export async function buildRequestTraces(root, { requests = [], jobs = [], questions = [], automation = {}, preparations, knowledge = [], observePreparation } = {}) {
  const ordered = [...requests].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || a.id.localeCompare(b.id));
  return Promise.all(ordered.map(async request => {
    let supplied;
    if (preparations === undefined) supplied = await readPreparationRecord(root, request.id);
    else if (Array.isArray(preparations)) {
      const matches = preparations.filter(item => (item.record || item).requestId === request.id);
      supplied = matches.length > 1 ? unavailable('Hay varios registros de preparación para la solicitud; requiere revisión.') : matches[0];
    } else supplied = preparations?.[request.id];
    const prepared = preparationFor(request, supplied);
    if (prepared?.record && request.kind === 'idea' && request.status === 'pending' && !request.jobId && !request.receiptId && observePreparation) {
      prepared.observation = await observePreparation(root, prepared.record);
    }
    return projectTrace(request, { jobs, questions, automation, knowledge }, prepared);
  }));
}

export async function readRequestTrace(root, requestId, { observePreparation } = {}) {
  if (!requestPattern.test(requestId || '')) throw new Error('Identificador de solicitud inválido.');
  const [inbox, queue, automation] = await Promise.all([loadDashboardState(root), loadState(root), readAutoRun(root)]);
  const request = inbox.coordinatorRequests.find(item => item.id === requestId);
  if (!request) throw new Error('No encuentro esa solicitud del coordinador.');
  const jobs = requestJobs(request, queue.jobs);
  const { readContextConsultations } = await import('./knowledge-access.mjs');
  const knowledge = await readContextConsultations(root, { requestId, jobIds: jobs.map(job => job.id) });
  return (await buildRequestTraces(root, { requests: [request], jobs: queue.jobs, questions: inbox.questions, automation, knowledge, observePreparation }))[0];
}
