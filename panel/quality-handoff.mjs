import { createHash } from 'node:crypto';
import { loadState, qualityCorrection, recoverableChecksTimeout, settledOrcaObservation, settledQaRevalidation, settledReviewerRevalidation, settledUxReturnStep, uxReturnSource } from '../queue.mjs';
import { readAutoRun } from '../auto-run.mjs';
import { resumeCoordinatedDispatch } from './dispatch-recovery.mjs';
import { recoverSettledUxHandoff } from './worker-decisions.mjs';
import { changeDashboardState, loadDashboardState } from './agency-assistant/dashboard-state.mjs';
import { safeMarkdownText } from './agency-assistant/knowledge.mjs';
import { withInboxLock } from './agency-assistant/inbox-lock.mjs';
import { notifyCoordinatorRequest, verifyCoordinatorBinding } from './coordinator-bridge.mjs';

export function qualityBlock(job) {
  const stage = job?.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  if (job?.state !== 'needs_attention' || !job.coordination || !['qa', 'reviewer'].includes(stage?.key)
    || stage.status !== 'blocked' || stage.dispatchSettled !== true || !stage.resultMessageId
    || stage.runId !== job.coordination.runId || !stage.taskId || !stage.dispatchId
    || !['blocked', 'failed'].includes(stage.delivery?.outcome)) return null;
  return stage;
}

const originFor = (job, stage) => ({ kind: 'quality-block', jobId: job.id, runId: stage.runId,
  taskId: stage.taskId, dispatchId: stage.dispatchId, messageId: stage.resultMessageId });

export async function verifyQualityQuestion(root, request, origin, { verify = verifyCoordinatorBinding } = {}) {
  const job = (await loadState(root)).jobs.find(item => item.id === origin?.jobId);
  const stage = qualityBlock(job);
  if (!stage || request.status !== 'routed' || request.jobId !== job.id || job.coordination.requestId !== request.id
    || origin.senderId !== request.notification?.senderId || origin.senderId !== job.coordination.senderId
    || Object.entries(originFor(job, stage)).some(([key, value]) => origin[key] !== value)) {
    throw new Error('La ronda no pertenece al bloqueo de calidad vigente de esta solicitud.');
  }
  const owner = await verify(request.notification, { cwd: root });
  if (!owner.ok) throw new Error(owner.reason);
  return originFor(job, stage);
}

export async function checkQualityHandoff(root, jobId, { notify = notifyCoordinatorRequest } = {}) {
  const job = (await loadState(root)).jobs.find(item => item.id === jobId);
  const stage = qualityBlock(job);
  if (!stage) return null;
  const requestId = job.coordination.requestId;
  const origin = originFor(job, stage);
  const id = 'quality-' + createHash('sha256').update(JSON.stringify(origin)).digest('hex').slice(0, 32);
  return withInboxLock(root, `route:${requestId}`, async () => {
    const currentJob = (await loadState(root)).jobs.find(item => item.id === jobId);
    if (qualityBlock(currentJob)?.resultMessageId !== origin.messageId) return null;
    const save = action => changeDashboardState(root, state => {
      const request = state.coordinatorRequests.find(item => item.id === requestId);
      if (request?.status !== 'routed' || request.jobId !== jobId || request.notification?.status !== 'sent'
        || request.notification.runId !== origin.runId || request.notification.senderId !== job.coordination.senderId) return null;
      request.qualityNotices ||= [];
      return action(request);
    });
    const notice = await save(request => {
      const previous = request.qualityNotices.find(item => item.id === id);
      if (previous) return previous;
      const created = {
        id, kind: 'quality-block', parentRequestId: requestId, origin, createdAt: new Date().toISOString(),
        business: job.business, projectId: job.projectId || null,
        snapshot: { business: job.business, projectId: job.projectId || null, projectName: job.projectName || '',
          title: job.title, text: stage.delivery.summary, stage: stage.key,
          outstanding: stage.delivery.acceptance.filter(item => item.status !== 'passed').slice(0, 12) },
        notification: { runId: request.notification.runId, senderId: request.notification.senderId, status: 'pending' },
      };
      request.qualityNotices.push(created);
      return created;
    });
    if (!notice || notice.notification.status === 'sent') return notice;
    const persist = detail => save(request => {
      const current = request.qualityNotices.find(item => item.id === id);
      current.notification = { ...current.notification, ...detail, updatedAt: new Date().toISOString() };
      return current;
    });
    const notification = await notify(notice, { cwd: root, beforeSend: target => persist({ ...target, status: 'sending' }) });
    return persist(notification);
  });
}

export async function recordQualityPlan(root, request, { origin, nextAction } = {}, options) {
  const verified = await verifyQualityQuestion(root, request, origin, options);
  const text = safeMarkdownText(nextAction || '').trim();
  if (text.length < 8 || text.length > 2000) throw new Error('Indica el siguiente paso de validación en 8 a 2000 caracteres.');
  return withInboxLock(root, `route:${request.id}`, () => changeDashboardState(root, state => {
    const current = state.coordinatorRequests.find(item => item.id === request.id);
    const notice = current?.qualityNotices?.find(item => item.origin.messageId === verified.messageId && item.origin.dispatchId === verified.dispatchId);
    if (current?.status !== 'routed' || !notice) throw new Error('El bloqueo de calidad ya no está en esta solicitud.');
    if (notice.plan?.text !== text) notice.plan = { text, updatedAt: new Date().toISOString() };
    return notice.plan;
  }));
}

export function nextQualityAction(job, request, questions) {
  const stage = qualityBlock(job);
  if (!stage || request?.status !== 'routed'
    || request.id !== job.coordination.requestId || request.jobId !== job.id) return null;
  const origin = originFor(job, stage);
  const matchingRounds = (request.questionRounds || []).filter(round => Object.entries(origin)
    .every(([key, value]) => round.origin?.[key] === value));
  const questionIds = new Set(matchingRounds.map(round => round.id));
  const current = questions.filter(item => item.coordinatorRequestId === request.id && questionIds.has(item.roundId));
  if (current.some(item => item.required !== false && item.status !== 'answered')) return null;
  const answers = current.filter(item => item.status === 'answered')
    .map(item => ({ questionId: item.id, question: item.question, answer: item.answer }));
  const correction = qualityCorrection(job);
  const binding = { dispatchId: stage.dispatchId, messageId: stage.resultMessageId, answers };
  if (correction) return { ...binding, type: 'correction', ...correction };
  return answers.length && (settledQaRevalidation(job, true) || settledReviewerRevalidation(job)) ? { ...binding, type: 'answer' } : null;
}

const uxRecoveryChecks = new Map();

export async function syncQualityHandoffs(root, { resume = resumeCoordinatedDispatch, handoff = checkQualityHandoff, recoverUx = recoverSettledUxHandoff } = {}) {
  const [queue, inbox, automation] = await Promise.all([loadState(root), loadDashboardState(root), readAutoRun(root)]);
  for (const job of queue.jobs) {
    const stage = qualityBlock(job);
    const request = inbox.coordinatorRequests.find(item => item.id === job.coordination?.requestId);
    const receipt = automation.receipts.find(item => item.jobId === job.id);
    const recovery = receipt?.dispatchRecovery;
    const action = recovery?.qualityAction && ['verified', 'lock_released'].includes(recovery.phase)
      ? recovery.qualityAction : nextQualityAction(job, request, inbox.questions);
    const notice = request?.qualityNotices?.find(item => item.origin.messageId === stage?.resultMessageId);
    const resuming = ['verified', 'lock_released'].includes(recovery?.phase);
    const observationError = resuming ? recovery.error : job.error?.code;
    const unread = settledOrcaObservation(job, observationError);
    const observationPending = unread && (resuming || (job.state === 'needs_attention'
      && !job.livenessRecoveryHistory?.some(item => item.dispatchId === unread.dispatchId && item.error === observationError)));
    const checksPending = (job.state === 'needs_attention' || resuming)
      && recoverableChecksTimeout(job, automation.integrations?.[receipt?.id], resuming ? recovery.originalError : job.error?.code);
    const routed = request?.status === 'routed' && request.jobId === job.id;
    let uxHandoff = routed
      ? (resuming && recovery.mode === 'same_attempt_ux_return' ? recovery.uxHandoff
        : request.workerHandoffs?.findLast(item => uxReturnSource(job, item))) : null;
    const recoverableUx = routed && !uxHandoff && receipt?.eligible && receipt.status === 'needs_attention'
      && automation.businesses[job.business] && settledUxReturnStep(job);
    const uxKey = `${root}:${job.id}`;
    if (!recoverableUx) uxRecoveryChecks.delete(uxKey);
    else {
      const previous = uxRecoveryChecks.get(uxKey);
      if (previous?.dispatchId !== recoverableUx.dispatchId || Date.now() - previous.at >= 60_000) {
        uxRecoveryChecks.set(uxKey, { dispatchId: recoverableUx.dispatchId, at: Date.now() });
        try {
          const restored = await recoverUx(root, job);
          if (uxReturnSource(job, restored)) uxHandoff = restored;
        } catch { /* Wait for a verifiable native authorization. */ }
      }
    }
    const developerDecision = resuming && recovery.mode === 'same_attempt_developer_decision' ? recovery.developerDecision : null;
    const stageDecision = resuming && recovery.mode === 'same_attempt_stage_decision' ? recovery.stageDecision : null;
    const durableReplay = resuming && receipt?.eligible && job.state === 'queued' && job.livenessResume?.id === recovery.id;
    if ((action || observationPending || checksPending || uxHandoff || developerDecision || stageDecision || durableReplay) && receipt?.eligible && ['needs_attention', 'retrying'].includes(receipt.status) && automation.businesses[job.business]) {
      if (notice?.resume?.status === 'blocked' && notice.resume.code !== 'locked' && Date.now() - Date.parse(notice.resume.updatedAt) < 60_000) continue;
      try {
        await resume(root, job.id, { confirm: true, ...(action ? { qualityAction: action } : {}), ...(uxHandoff ? { uxHandoff } : {}), ...(developerDecision ? { developerDecision } : {}), ...(stageDecision ? { stageDecision } : {}) });
        if (uxHandoff) await changeDashboardState(root, state => {
          for (const question of state.questions) if (question.jobId === job.id && question.roundId === `${job.id}:${uxHandoff.dispatchId}`
            && question.status === 'pending' && /^UX-I[1-3]-return$/i.test(question.decisionKey || '')) {
            question.status = 'withdrawn'; question.closedAt = new Date().toISOString(); question.handoffId = uxHandoff.id;
          }
        });
        continue;
      } catch (error) {
        if (error.code === 'locked') continue;
        if (notice) await changeDashboardState(root, state => {
          const saved = state.coordinatorRequests.find(item => item.id === request.id)?.qualityNotices?.find(item => item.id === notice.id);
          if (saved) saved.resume = { status: 'blocked', code: error.code || null, updatedAt: new Date().toISOString(),
            reason: safeMarkdownText(String(error.message || error)).slice(0, 1000) };
        });
      }
    }
    if (!stage || notice?.notification.status === 'sent') continue;
    try { await handoff(root, job.id); } catch { /* The saved intent will be reconciled. */ }
  }
}
