import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { QUEUE_BUSINESSES, addJob, loadState, runQueue, recoverDashboardQueue, retryJob, validateSpec, acquireLock, acquireLedgerLock, releaseLock, queueKnownLivenessResume, elapsedAttemptMs, executionTimeExhausted, isEffectFreeLivenessPreflight, isSameAttemptRecoveryMode, deliveryTransportError, assertDeliveryTransportProof, recoveryFingerprint, integrationValidationSteps, assertIntegrationValidationProof, queueIntegrationValidationResume, assertCommittedIntegrationRecord, assertIntegrationReconcileProof, queueIntegrationReconcileResume } from './queue.mjs';
import { verifyGitHubDestination } from './project-destination.mjs';
import { sameRepository } from './repository-name.mjs';
import { captureIntegrationSnapshot } from './github-integration.mjs';
import { inspectCommittedIntegration, inspectEffectFreeIntegration, effectFreeIntegrationRecord } from './integration-recovery.mjs';
import { replaceLocalFile } from './atomic-file.mjs';
import { assertQualityAction, queueContractRevisionRetry, recoverableChecksTimeout, uxReturnSource, developerDecisionSource, stageDecisionSource, isPartialStageResume, settledOrcaObservation, settledQaRevalidation, stoppedDeveloperCheckpoint } from './queue.mjs';
import { currentActor } from './queue.mjs';
import { createContractRevision, assertContractRevisionCheckpoint, assertContractRevisionProof, contractRevisionHash, originalContractRevisionJob } from './contract-revision.mjs';
import { workflowV2Resumable } from './workflow-v2-gate.mjs';

const location = root => path.join(path.resolve(root), 'data', 'auto-run.json');
const empty = () => ({ schema: 1, businesses: { agency: false, games: false }, receipts: [], history: [], integrations: {} });
const hooks = new Map();
const changes = new Map();
const dispatchRecoveries = new Map();
const now = () => new Date().toISOString();
const businessCheck = business => { if (!['agency', 'games'].includes(business)) throw new Error('Empresa inválida.'); };
const integratedReason = 'Entrega integrada en GitHub; merge remoto confirmado.';
const integrationCompleted = (record, receipt) => record?.jobId === receipt.jobId && record?.receiptId === receipt.id
  && record?.phase === 'complete' && record.status === 'completed' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(record.mergeSha || '');
export async function readAutoRun(root) {
  try {
    const value = JSON.parse(await fs.readFile(location(root), 'utf8'));
    if (value.schema !== 1 || !Array.isArray(value.receipts) || !Array.isArray(value.history)) throw new Error('Registro de autoejecución inválido; requiere revisión.');
    return { ...value, integrations: value.integrations || {}, businesses: { agency: value.businesses?.agency === true, games: value.businesses?.games === true } };
  } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}

export async function persistIntegration(root, record) {
  if (!record?.receiptId || !record?.jobId) throw new Error('Registro de integración sin recibo/job.');
  return change(root, state => {
    const receipt = state.receipts.find(item => item.id === record.receiptId);
    if (!receipt || receipt.jobId !== record.jobId || receipt.eligible !== true) throw new Error('Recibo no elegible para persistir integración.');
    state.integrations ||= {};
    state.integrations[record.receiptId] = { ...state.integrations[record.receiptId], ...record };
    if (receipt.status === 'completed' && integrationCompleted(state.integrations[record.receiptId], receipt)) {
      receipt.reason = integratedReason; receipt.updatedAt = now();
    }
    audit(state, 'github_integration', { receiptId: record.receiptId, jobId: record.jobId, phase: record.phase });
    return state.integrations[record.receiptId];
  });
}
export async function readIntegration(root, receiptId) {
  return (await readAutoRun(root)).integrations?.[receiptId] || null;
}

// Separate short lock for the shared receipt journal. Workers own their
// company and checkout locks while executing. Stale receipt locks fail closed.
function change(root, action) {
  const key = path.resolve(root);
  const pending = (changes.get(key) || Promise.resolve()).then(() => writeChange(key, action));
  changes.set(key, pending.catch(() => {}));
  return pending;
}
async function writeChange(root, action) {
  const file = location(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let lock;
  try { lock = await fs.open(`${file}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Registro de autoejecución ocupado o interrumpido; consulta y revisa antes de repetir.'); throw error; }
  let temporary;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() })); await lock.sync();
    const state = await readAutoRun(root);
    const result = await action(state);
    temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    // Windows may briefly refuse replacement while a reader/AV holds a handle.
    // Retry only this local atomic rename, never admission or external dispatch.
    await replaceLocalFile(temporary, file);
    return result;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true });
    await lock.close(); await fs.unlink(`${file}.lock`);
  }
}
function audit(state, type, detail) { const actor = currentActor(); state.history.push({ at: now(), type, ...(actor ? { actor } : {}), ...detail }); }
export async function setAutoRun(root, business, enabled, { confirm = false } = {}) {
  businessCheck(business);
  if (!confirm || typeof enabled !== 'boolean') throw new Error('Confirma explícitamente activar o pausar esta empresa.');
  return change(root, state => {
    state.businesses[business] = enabled;
    audit(state, 'setting_changed', { business, enabled });
    return { business, enabled };
  });
}

// This receipt is the confirmation boundary. It is fsynced BEFORE enqueue and
// includes the immutable brief and the setting observed at that moment.
export async function confirmSubmission(root, receiptId, spec) {
  validateSpec(spec);
  businessCheck(spec.business);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(receiptId || '')) throw new Error('Falta el identificador estable del envío; conserva el mismo al reintentar.');
  if (spec.provider && spec.provider !== 'orca') throw new Error('El panel utiliza exclusivamente el pipeline Orca.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...spec, destination: spec.destination ? { checkout: spec.destination.checkout, workspace: spec.destination.workspace, branch: spec.destination.branch, baseBranch: spec.destination.baseBranch, repository: spec.destination.repository } : null })).digest('hex');
  const receipt = await change(root, state => {
    const previous = state.receipts.find(item => item.id === receiptId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Este recibo pertenece a otro encargo; consulta el envío original.');
      return previous;
    }
    const item = { id: receiptId, jobId: spec.id || `send-${createHash('sha256').update(receiptId).digest('hex').slice(0, 32)}`, business: spec.business, eligible: state.businesses[spec.business] === true, status: 'pending', confirmedAt: now(), fingerprint, spec: { ...spec, provider: 'orca' } };
    state.receipts.push(item); audit(state, 'submission_confirmed', { receiptId, jobId: item.jobId, business: item.business, eligible: item.eligible });
    return item;
  });
  let job;
  try { job = await materialize(root, receipt); }
  finally { hooks.get(path.resolve(root))?.(); }
  return { receipt, job };
}

async function materialize(root, receipt) {
  const existing = (await loadState(root)).jobs.find(job => job.id === receipt.jobId);
  if (existing) {
    if (existing.autoIntent?.receiptId !== receipt.id) throw new Error('Job ID ocupado por otro envío; revisión necesaria.');
    return existing;
  }
  if (receipt.status !== 'pending') throw new Error('Recibo ya admitido sin job recuperable; no se vuelve a encolar. Requiere revisión.');
  try {
    return await addJob(root, { ...receipt.spec, id: receipt.jobId, autoIntent: { receiptId: receipt.id, eligible: receipt.eligible, confirmedAt: receipt.confirmedAt } });
  } catch (error) {
    if (['locked', 'lock_uncertain'].includes(error.code)) return null;
    if (error.code === 'duplicate') {
      const found = (await loadState(root)).jobs.find(job => job.id === receipt.jobId);
      if (found?.autoIntent?.receiptId === receipt.id) return found;
    }
    throw error;
  }
}

export function createAutoRunner(root, { worker, run = runQueue, verify = verifyGitHubDestination, captureSnapshot = captureIntegrationSnapshot, inspectIntegration = inspectCommittedIntegration, intervalMs = 1500, parallelBusinesses = false } = {}) {
  root = path.resolve(root);
  const busy = new Set();
  let stopped = false, timer;
  const update = (id, status, detail = {}) => change(root, state => {
    const receipt = state.receipts.find(item => item.id === id);
    Object.assign(receipt, { status, updatedAt: now(), ...detail });
    audit(state, status, { receiptId: id, jobId: receipt.jobId, ...detail });
  });
  async function tickBusiness(business) {
    if (busy.has(business) || stopped) return;
    busy.add(business);
    const inLane = item => !business || item.business === business;
    try {
      const executor = await recoverDashboardQueue(root, { business });
      if (!executor.available) return;
      let queue = await loadState(root);
      let saved = await readAutoRun(root);
      for (const receipt of saved.receipts.filter(inLane).filter(item => item.status === 'needs_attention')) {
        const resumed = queue.jobs.find(job => job.id === receipt.jobId && job.state === 'queued' && job.continuation?.decisionRevision
          && job.livenessResume?.phase !== 'ready');
        if (resumed) await authorizeDecisionResume(root, resumed.id);
      }
      saved = await readAutoRun(root);
      // Never repeat a claimed/started submission, even when no dispatch receipt
      // was returned: transport uncertainty is not evidence of non-execution.
      for (const receipt of saved.receipts.filter(inLane)) {
        const job = queue.jobs.find(item => item.id === receipt.jobId);
        const reviewedRetry = job?.state === 'queued' && receipt.retryAuthorizedAttempt === job.attempts;
        if (job?.state === 'queued' && isPartialStageResume(receipt.dispatchRecovery?.mode)
          && receipt.dispatchRecovery.phase === 'consumed' && ['claimed', 'needs_attention'].includes(receipt.status)) {
          if (await rearmUnstartedPartial(root, receipt.id)) continue;
        }
        if (receipt.status === 'claimed' || (receipt.status === 'pending' && job?.attempts > 0 && !reviewedRetry)) {
          await update(receipt.id, job?.state === 'succeeded' ? 'completed' : 'needs_attention', { reason: 'Intento previo o despacho incierto; consulta Orca y revisa efectos antes de decidir.' });
        }
      }
      let state = await readAutoRun(root);
      if (state.receipts.some(item => inLane(item) && ['needs_attention', 'blocked', 'retrying'].includes(item.status))
        || queue.jobs.some(job => inLane(job) && ['needs_attention', 'running'].includes(job.state))) return;
      // Recover confirmed outbox entries, including manual ones, without ever
      // promoting their original eligibility when settings change.
      for (const receipt of state.receipts.filter(inLane).filter(item => item.status === 'pending')) {
        const existing = queue.jobs.find(job => job.id === receipt.jobId);
        if (existing?.autoIntent?.receiptId === receipt.id) continue;
        try { await materialize(root, receipt); }
        catch (error) { await update(receipt.id, 'blocked', { reason: `No se pudo recuperar el envío: ${error.message}` }); return; }
      }
      queue = await loadState(root);
      state = await readAutoRun(root);
      try { await fs.access(path.join(root, 'data', 'PAUSE')); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const receipt = state.receipts.find(item => inLane(item) && item.status === 'pending' && item.eligible && state.businesses[item.business] && queue.jobs.some(job => job.id === item.jobId && job.state === 'queued' && (job.attempts === 0 || item.retryAuthorizedAttempt === job.attempts)));
      if (!receipt) return;
      let checkoutLock, lockPath, admitted = false, uncertain = false;
      try {
        const result = await run(root, { execute: true, maxJobs: 1, jobId: receipt.jobId, business, worker,
          beforeStart: async job => {
            const reviewedRetry = job.attempts > 0 && receipt.retryAuthorizedAttempt === job.attempts;
            if (job.id !== receipt.jobId || (job.attempts !== 0 && !reviewedRetry) || job.autoIntent?.receiptId !== receipt.id || !job.autoIntent.eligible) throw new Error('El recibo y el job no coinciden; requiere revisión.');
            const sameAttempt = isSameAttemptRecoveryMode(receipt.dispatchRecovery?.mode) && receipt.dispatchRecovery.phase === 'ready';
            const stoppedRecovery = receipt.dispatchRecovery?.mode === 'retry_stopped_developer'
              && receipt.dispatchRecovery.phase === 'ready' ? receipt.dispatchRecovery : null;
            if (stoppedRecovery) {
              assertRecoveryCheckpoint(job, stoppedRecovery);
              if (await captureSnapshot(job.workspace) !== stoppedRecovery.snapshot) throw new Error('Los cambios de Godot variaron desde la recuperación.');
            }
            const revisedContract = receipt.contractRevision?.phase === 'ready';
            if (revisedContract || job.contractRevision?.phase === 'ready') {
              if (!revisedContract || job.contractRevision?.id !== receipt.contractRevision.id || sameAttempt) throw new Error('La rectificación no coincide con el recibo o se solapa con otra recuperación.');
              assertContractRevisionCheckpoint(job, receipt.contractRevision);
              const record = (await readAutoRun(root)).integrations?.[receipt.id];
              if (contractRevisionHash(record) !== receipt.contractRevision.integrationRecordHash
                || await captureSnapshot(job.workspace) !== receipt.contractRevision.snapshot) throw new Error('El snapshot original cambió antes del segundo intento de QA.');
            }
            if (sameAttempt && (job.livenessResume?.phase !== 'ready' || job.livenessResume.id !== receipt.dispatchRecovery.id || job.livenessResume.mode !== receipt.dispatchRecovery.mode || job.livenessResume.attempt !== job.attempts)
              || job.livenessResume?.phase === 'ready' && !sameAttempt) throw new Error('El marcador de reanudación no coincide con el recibo original.');
            if (sameAttempt && receipt.dispatchRecovery.mode === 'same_attempt_delivery_transport'
              && JSON.stringify(assertDeliveryTransportProof(job, receipt.dispatchRecovery.deliveryTransport)) !== JSON.stringify(assertDeliveryTransportProof(job, job.livenessResume.deliveryTransport))) {
              throw new Error('La evidencia de transporte del recibo no coincide con el marcador del trabajo.');
            }
            if (sameAttempt && receipt.dispatchRecovery.mode === 'same_attempt_integration_validation') {
              const proof = assertIntegrationValidationProof(receipt.dispatchRecovery, job.livenessResume.integrationValidation);
              if (recoveryFingerprint(proof) !== recoveryFingerprint(receipt.dispatchRecovery.integrationValidation)
                || await captureSnapshot(job.workspace) !== proof.candidateSnapshot) throw new Error('El diff cambió desde la autorización de una nueva validación.');
            }
            if (sameAttempt && job.kind === 'code' && isPartialStageResume(receipt.dispatchRecovery.mode)
              && (receipt.dispatchRecovery.snapshot !== job.livenessResume.snapshot || await captureSnapshot(job.workspace) !== job.livenessResume.snapshot)) {
              throw new Error('El candidato cambió desde la continuación autorizada.');
            }
            if (sameAttempt && receipt.dispatchRecovery.mode === 'same_attempt_integration_reconcile') {
              const record = (await readAutoRun(root)).integrations?.[receipt.id];
              if (recoveryFingerprint(record) !== receipt.dispatchRecovery.integrationRecordHash) throw new Error('El registro de integración cambió antes de continuar.');
              const proof = assertIntegrationReconcileProof(job, receipt.dispatchRecovery, await inspectIntegration(root, job, record));
              if (recoveryFingerprint(proof) !== recoveryFingerprint(receipt.dispatchRecovery.integrationProof)
                || recoveryFingerprint(proof) !== recoveryFingerprint(job.livenessResume.integrationProof)) throw new Error('La PR observada cambió antes de continuar.');
            }
            let destination = job.destination;
            let admittedJob = job;
            if (job.kind === 'code') {
              const receiptSpec = (await readAutoRun(root)).receipts.find(item => item.id === receipt.id)?.spec;
              if (!destination?.baseBranch && receiptSpec?.id === job.id && receiptSpec?.destination?.baseBranch) {
                destination = { ...destination, baseBranch: receiptSpec.destination.baseBranch };
              }
              if (destination?.workspace !== job.workspace || destination?.branch !== job.branch || !destination?.baseBranch) throw new Error('Destino sin coincidencia exacta con el recibo confirmado; requiere revisión.');
              admittedJob = { ...job, destination };
              const recovery = receipt.dispatchRecovery;
              if (revisedContract) {
                assertRecoveryDestination(receipt.contractRevision.destination, destination);
                assertRecoveryDestination(destination, await verify(root, admittedJob, { requireClean: false }));
              } else if (recovery?.phase === 'ready' && recovery.attempt === job.attempts) {
                assertRecoveryCheckpoint(job, recovery);
                assertRecoveryDestination(recovery.destination, destination);
                if (recovery.mode !== 'same_attempt_integration_reconcile') {
                  const observed = await verify(root, admittedJob, { requireClean: recovery.stage === 'ux' && !isPartialStageResume(recovery.mode) });
                  assertRecoveryDestination(destination, observed);
                }
                // Recovery observes the original baseline; it does not approve a new one.
              } else destination = await verify(root, admittedJob);
              lockPath = path.join(destination.workspace, '.git', 'centro-executor.lock');
              try { checkoutLock = await fs.open(lockPath, 'wx'); }
              catch (error) {
                const blocked = new Error(`Checkout ocupado o bloqueo pendiente; revisa ${lockPath}. ${error.code}`);
                if (error.code === 'EEXIST') blocked.code = 'checkout_locked';
                throw blocked;
              }
              await checkoutLock.writeFile(JSON.stringify({ jobId: job.id, receiptId: receipt.id, attempt: job.attempts + (sameAttempt ? 0 : 1), pid: process.pid, at: now() })); await checkoutLock.sync();
            }
            // Recheck pause immediately at the durable admission boundary.
            return change(root, async current => {
              const entry = current.receipts.find(item => item.id === receipt.id);
              let paused = false;
              try { await fs.access(path.join(root, 'data', 'PAUSE')); paused = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (!current.businesses[job.business] || paused || entry.status !== 'pending') return false;
              if (revisedContract) {
                if (entry.contractRevision?.phase !== 'ready' || entry.contractRevision.id !== job.contractRevision.id
                  || contractRevisionHash(current.integrations?.[entry.id]) !== entry.contractRevision.integrationRecordHash) throw new Error('La rectificación o validación original cambió antes de admitirla.');
                assertContractRevisionCheckpoint(job, entry.contractRevision);
                entry.contractRevision.phase = 'consumed'; entry.contractRevision.consumedAt = now();
                audit(current, 'contract_revision_consumed', { receiptId: entry.id, jobId: job.id, revisionId: entry.contractRevision.id, fromAttempt: job.attempts, toAttempt: job.attempts + 1 });
              }
              if (sameAttempt) {
                if (entry.dispatchRecovery?.phase !== 'ready' || entry.dispatchRecovery.id !== job.livenessResume.id) throw new Error('La recuperación ya se consumió o cambió antes de admitirla.');
                assertRecoveryCheckpoint(job, entry.dispatchRecovery);
                if (entry.dispatchRecovery.integrationRecordHash && entry.dispatchRecovery.mode === 'same_attempt_liveness'
                  && recoveryFingerprint(current.integrations?.[entry.id]) !== entry.dispatchRecovery.integrationRecordHash) {
                  throw new Error('La validación sellada cambió antes de reanudar la etapa de calidad.');
                }
                if (entry.dispatchRecovery.mode === 'same_attempt_integration_validation') {
                  const record = current.integrations?.[entry.id];
                  const candidate = entry.dispatchRecovery.integrationValidation.candidateSnapshot;
                  // 29: an integration-only resume keeps the sealed, approved validation of this exact snapshot.
                  const kept = entry.dispatchRecovery.integrationOnly
                    ? record?.phase === 'validation_approved' && record.status === 'validated' && record.integrationRecoveryId === entry.dispatchRecovery.id
                      && record.validation?.snapshot === candidate && record.validation.approvals?.qa && record.validation.approvals?.reviewer
                    : record?.phase === 'validation_pending' && record.integrationRecoveryId === entry.dispatchRecovery.id && record.validationCandidateSnapshot === candidate;
                  if (!kept) throw new Error('El registro de nueva validación no coincide con su recibo.');
                }
                if (entry.dispatchRecovery.mode === 'same_attempt_integration_reconcile'
                  && recoveryFingerprint(current.integrations?.[entry.id]) !== entry.dispatchRecovery.integrationRecordHash) throw new Error('El registro de integración cambió en la admisión.');
                entry.dispatchRecovery.phase = 'consumed'; entry.dispatchRecovery.consumedAt = now();
                audit(current, 'same_attempt_recovery_consumed', { receiptId: entry.id, jobId: job.id, recoveryId: entry.dispatchRecovery.id, attempt: job.attempts });
              }
              if (stoppedRecovery) {
                if (entry.dispatchRecovery?.id !== stoppedRecovery.id || entry.dispatchRecovery.phase !== 'ready') throw new Error('La recuperación de Desarrollo cambió antes de la admisión.');
                entry.dispatchRecovery.phase = 'consumed'; entry.dispatchRecovery.consumedAt = now();
              }
              entry.status = 'claimed'; entry.claimedAt = now(); entry.destination = destination;
              audit(current, 'claimed', { receiptId: entry.id, jobId: job.id, destination });
              admitted = true;
              return { destination, ...(stoppedRecovery ? { stoppedDeveloperRecoveryId: stoppedRecovery.id } : {}), ...(sameAttempt ? { sameAttemptRecoveryId: entry.dispatchRecovery.id } : {}),
                ...(revisedContract ? { contractRevisionId: entry.contractRevision.id, contractRevision: structuredClone(entry.contractRevision) } : {}) };
            });
          },
        });
        const job = result.jobs?.find(item => item.id === receipt.jobId);
        if (admitted) {
          uncertain = !job || job.state !== 'succeeded';
          await update(receipt.id, uncertain ? 'needs_attention' : 'completed', { reason: uncertain ? 'El intento no terminó aprobado; revisa job, etapa y dispatch, sin reintento automático.'
            : integrationCompleted(job.result?.integration, receipt) ? integratedReason : 'Entrega local completada; sin publicación.' });
        }
      } catch (error) {
        if (['locked', 'lock_uncertain'].includes(error.code) && !admitted) return;
        uncertain = admitted;
        await update(receipt.id, admitted ? 'needs_attention' : 'blocked', {
          reason: error.message,
          ...(error.code === 'checkout_locked' && !admitted ? { blockCode: error.code } : {}),
          // Why the destination check failed, so the person does not have to rerun Git by hand to find out.
          ...(/^destination_[a-z_]+$/.test(error.code || '') && !admitted ? { blockCode: error.code, ...(blockDetails(error.details) ? { blockDetails: blockDetails(error.details) } : {}) } : {}),
        });
      } finally {
        if (checkoutLock) { await checkoutLock.close(); if (!uncertain) await fs.unlink(lockPath); }
      }
    } finally { busy.delete(business); }
  }
  function tick() {
    return parallelBusinesses ? Promise.all(QUEUE_BUSINESSES.map(tickBusiness)) : tickBusiness();
  }
  function wake() { setImmediate(() => { void tick().catch(() => {}); }); }
  return {
    tick,
    start() { stopped = false; hooks.set(root, wake); timer = setInterval(wake, intervalMs); timer.unref(); wake(); },
    stop() { stopped = true; clearInterval(timer); hooks.delete(root); },
  };
}

// Queue validation has already accepted all required decisions for one settled
// needs_input dispatch. Reopen only that receipt; never a failed/unknown attempt.
export async function authorizeDecisionResume(root, jobId) {
  return change(root, async state => {
    const job = (await loadState(root)).jobs.find(item => item.id === jobId);
    const receipt = state.receipts.find(item => item.jobId === jobId);
    if (!job?.autoIntent?.eligible || !receipt?.eligible) return null;
    const revision = job.continuation?.decisionRevision;
    if (receipt.status === 'pending' && receipt.decisionRevision === revision && receipt.retryAuthorizedAttempt === job.attempts) return receipt;
    const previous = job.workflowHistory?.at(-1);
    const stage = previous?.steps?.find(item => item.key === previous.currentStage);
    const next = job.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
    if (receipt.status !== 'needs_attention' || receipt.id !== job.autoIntent.receiptId
      || receipt.business !== job.business || job.state !== 'queued' || job.orphanRisk
      || !revision || job.continuation.parentJobId !== job.id || job.attempts >= job.maxAttempts
      || previous?.attempt !== job.attempts || stage?.attempt !== job.attempts
      || stage?.delivery?.outcome !== 'needs_input' || stage.dispatchSettled !== true
      || !['completed', 'failed'].includes(stage.dispatchStatus)
      || next?.supersedesDispatchId !== stage.dispatchId || next?.predecessorTaskId !== stage.taskId) {
      throw new Error('La reanudación no acredita un trabajador cerrado que esperaba estas decisiones.');
    }
    if (job.kind === 'code') {
      const workspace = await fs.realpath(job.workspace);
      const relative = path.relative(await fs.realpath(path.join(root, 'workspaces')), workspace);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Checkout fuera del destino aislado.');
      const lockPath = path.join(workspace, '.git', 'centro-executor.lock');
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (owner.jobId !== job.id || owner.receiptId !== receipt.id || (owner.attempt != null && owner.attempt !== job.attempts)) throw new Error('El bloqueo pertenece a otro encargo o intento.');
        await fs.unlink(lockPath);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts;
    receipt.decisionRevision = revision; receipt.updatedAt = now();
    receipt.reason = 'Todas las decisiones recibidas; continúa el mismo encargo dentro de sus límites.';
    audit(state, 'decisions_resume_authorized', { receiptId: receipt.id, jobId, revision, attempt: job.attempts, dispatchId: stage.dispatchId });
    return receipt;
  });
}

// Bounded copy of a destination error's details (already redacted at the source): short scalars only.
function blockDetails(details) {
  if (!details || typeof details !== 'object') return null;
  const kept = Object.entries(details).filter(([key, value]) => /^[A-Za-z]{2,24}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 8)
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 400) : value]);
  return kept.length ? Object.fromEntries(kept) : null;
}

// The destination check failed before anything was admitted or dispatched (repository missing, branch not pushed,
// no network). Once the person has fixed it, re-arm the same receipt: the runner repeats the full check before starting.
export async function retryDestinationAdmission(root, id, { confirm = false } = {}) {
  if (!confirm) throw new Error('Confirma que has corregido el destino.');
  return change(root, async state => {
    const receipt = state.receipts.find(item => item.id === id);
    const job = (await loadState(root)).jobs.find(item => item.id === receipt?.jobId);
    if (receipt?.status !== 'blocked' || !receipt.eligible || receipt.claimedAt || !/^destination_[a-z_]+$/.test(receipt.blockCode || '')
      || job?.kind !== 'code' || job.state !== 'queued' || job.attempts !== 0 || job.startedAt || job.result || job.orphanRisk
      || job.autoIntent?.receiptId !== id || job.workflow?.status !== 'queued' || job.workflow.currentStage != null
      || !job.workflow.steps?.length || job.workflow.steps.some(step => !['queued', 'skipped'].includes(step.status) || step.runId || step.taskId || step.dispatchId)) {
      throw new Error('El recibo no acredita un fallo de destino anterior al primer intento.');
    }
    const previous = receipt.blockCode;
    receipt.status = 'pending'; receipt.updatedAt = now(); receipt.reason = 'Destino corregido; se vuelve a comprobar antes de empezar.';
    delete receipt.blockCode; delete receipt.blockDetails;
    audit(state, 'destination_retry', { receiptId: id, jobId: job.id, previous });
    return receipt;
  });
}

export async function reviewAutoReceipt(root, id, { confirm = false } = {}) {
  if (!confirm) throw new Error('Confirma la revisión de efectos y dispatches.');
  return change(root, async state => {
    const receipt = state.receipts.find(item => item.id === id);
    if (!receipt || !['blocked', 'needs_attention'].includes(receipt.status)) throw new Error('El recibo no está pendiente de revisión.');
    const job = (await loadState(root)).jobs.find(item => item.id === receipt.jobId);
    if (job && ['running', 'needs_attention'].includes(job.state)) throw new Error('Revisa y resuelve primero el job mediante las acciones manuales.');
    receipt.status = 'reviewed'; receipt.reviewedAt = now();
    audit(state, 'reviewed', { receiptId: id, jobId: receipt.jobId });
    return receipt;
  });
}

// A collision before admission did not consume an attempt. Keep the original
// job and receipt and only clear a previous owner's lock with positive proof.
export async function retryCheckoutAdmission(root, id, { confirm = false, inspectWorker, inspectIntegrationEffects = inspectEffectFreeIntegration } = {}) {
  if (!confirm || typeof inspectWorker !== 'function') throw new Error('Confirma la revisión del checkout.');
  root = path.resolve(root);
  const queueLock = await acquireLock(root);
  try {
    return await change(root, async state => {
      const receipt = state.receipts.find(item => item.id === id);
      const { jobs } = await loadState(root);
      const job = jobs.find(item => item.id === receipt?.jobId);
      if (receipt?.status !== 'blocked' || !receipt.eligible || receipt.claimedAt
        || job?.kind !== 'code' || job.state !== 'queued' || job.attempts !== 0 || job.startedAt || job.result || job.orphanRisk
        || job.autoIntent?.receiptId !== id || receipt.spec?.workspace !== job.workspace
        || job.workflow?.status !== 'queued' || job.workflow.currentStage != null
        || !job.workflow.steps?.length || job.workflow.steps.some(step => step.status !== 'queued' || step.runId || step.taskId || step.dispatchId)) {
        throw new Error('El recibo no acredita un bloqueo anterior al primer intento.');
      }
      const workspace = await fs.realpath(job.workspace);
      const workspaces = await fs.realpath(path.join(root, 'workspaces'));
      const relative = path.relative(workspaces, workspace);
      if (workspace !== path.resolve(job.workspace) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Checkout fuera del destino aislado.');
      }
      const git = path.join(workspace, '.git');
      if (!(await fs.lstat(git)).isDirectory() || await fs.realpath(git) !== git) throw new Error('El directorio Git no es local al checkout.');
      const file = path.join(git, 'centro-executor.lock');
      if (receipt.blockCode !== 'checkout_locked' && receipt.reason !== `Checkout ocupado o bloqueo pendiente; revisa ${file}. EEXIST`) {
        throw new Error('El recibo está bloqueado por otro motivo.');
      }
      const raw = await fs.lstat(file).then(stat => {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Bloqueo del checkout inválido.');
        return fs.readFile(file, 'utf8');
      }, error => { if (error.code === 'ENOENT') return null; throw error; });
      let owner;
      if (raw !== null) {
        owner = JSON.parse(raw);
        const previous = jobs.find(item => item.id === owner?.jobId);
        const oldReceipt = state.receipts.find(item => item.id === owner?.receiptId);
        // A pre-effect integration failure (29/F14) may still release the checkout once the remote confirms no commit, push or PR.
        const oldIntegration = state.integrations?.[oldReceipt?.id];
        if (!previous || previous.workspace !== workspace || previous.state !== 'cancelled' || !previous.reviewedAt || previous.orphanRisk
          || previous.autoIntent?.receiptId !== oldReceipt?.id || oldReceipt?.jobId !== previous.id || oldReceipt.status !== 'reviewed'
          || (owner.attempt != null && owner.attempt !== previous.attempts) || (oldIntegration && !effectFreeIntegrationRecord(oldIntegration, state.history, previous.id, { closed: true }))
          || !Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('El bloqueo no pertenece a un encargo cancelado y revisado de este checkout.');
        // 24 (F12): this process wrote the lock while running the previous job. That job
        // is now cancelled and reviewed, so no executor of this process can still own it.
        const assertPidExited = () => {
          if (owner.pid === process.pid) return;
          try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
          throw new Error('El proceso que reservó el checkout sigue activo.');
        };
        assertPidExited();
        const steps = [...(previous.workflowHistory || []), previous.workflow].flatMap(workflow => workflow?.steps || []);
        const dispatched = steps.filter(step => step.dispatchId);
        if (!dispatched.length || steps.some(step => step.taskId && !step.dispatchId || step.status === 'running')) {
          throw new Error('El encargo anterior tiene etapas sin identificar o aún activas.');
        }
        for (const step of dispatched) await inspectWorker(root, workspace, step);
        if (oldIntegration) owner = { ...owner, integrationEffects: await inspectIntegrationEffects(root, previous, oldIntegration, { history: state.history }) };
        assertPidExited();
        if (await fs.readFile(file, 'utf8') !== raw) throw new Error('El propietario del bloqueo cambió durante la revisión.');
        await fs.unlink(file);
      }
      receipt.status = 'pending'; receipt.updatedAt = now();
      delete receipt.blockCode;
      receipt.reason = 'Checkout liberado y verificado; continúa la solicitud original.';
      audit(state, 'checkout_admission_reopened', { receiptId: id, jobId: job.id, previousOwner: owner });
      return receipt;
    });
  } finally { await releaseLock(queueLock); }
}

function assertRecoveryDestination(expected, observed) {
  const keys = ['workspace', 'branch', 'repository', 'baseBranch', 'sha', 'remoteSha', 'baseSha'];
  if (keys.some(key => !expected?.[key] || (key === 'repository' ? !sameRepository(observed?.[key], expected[key]) : observed?.[key] !== expected[key]))
    || !['sha', 'remoteSha', 'baseSha'].every(key => /^[a-f0-9]{40,64}$/i.test(expected[key]))
    || expected.sha !== expected.remoteSha) throw new Error('El destino observado diverge del checkout, ramas o SHA originales; no se autoriza otro baseline.');
}

function assertRecoveryCheckpoint(job, recovery) {
  if (recovery.mode === 'same_attempt_integration_reconcile') {
    if (recoveryFingerprint(job.workflow) !== recovery.checkpointHash || job.workflow?.runId !== recovery.runId) throw new Error('La integración cambió desde su recuperación.');
    return;
  }
  if (recovery.mode === 'same_attempt_integration_validation' || isPartialStageResume(recovery.mode)) {
    const expected = job.state === 'queued' ? job.livenessResume?.queuedWorkflowHash : recovery.originalWorkflowHash;
    if (!expected || recoveryFingerprint(job.workflow) !== expected || job.workflow.runId !== recovery.runId) throw new Error('El flujo cambió desde la autorización de nueva validación.');
    return;
  }
  let step = job.workflow?.steps?.find(item => item.key === recovery.stage);
  if (recovery.mode === 'retry_stopped_developer' && job.state === 'queued') {
    const retry = step?.retryOf;
    if (job.attempts !== recovery.attempt || step?.status !== 'queued' || step.dispatchId || step.taskId
      || retry?.recoveryId !== recovery.id || retry.taskId !== recovery.taskId || retry.dispatchId !== recovery.dispatchId
      || retry.dispatchStatus !== 'stopped') throw new Error('El reintento de Desarrollo perdió su checkpoint original.');
    step = job.workflowHistory?.at(-1)?.steps?.find(item => item.key === recovery.stage);
  }
  if (!step || job.workflow.currentStage !== recovery.stage || job.workflow.runId !== recovery.runId
    || step.runId !== recovery.runId || step.taskId !== recovery.taskId || step.dispatchId !== recovery.dispatchId
    || createHash('sha256').update(JSON.stringify(step)).digest('hex') !== recovery.checkpointHash) {
    throw new Error('La etapa cambió desde la recuperación del dispatch; requiere revisión.');
  }
  return step;
}

async function recoveryCheckoutLock(root, job, receiptId, attempt, { allowMissing = false } = {}) {
  const realRoot = await fs.realpath(root), workspace = await fs.realpath(job.workspace);
  const relative = path.relative(path.join(realRoot, 'workspaces'), workspace);
  if (workspace !== path.resolve(job.workspace) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Checkout fuera del destino aislado.');
  const file = path.join(workspace, '.git', 'centro-executor.lock');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Bloqueo del checkout inválido; requiere revisión.');
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (owner.jobId !== job.id || owner.receiptId !== receiptId || owner.attempt !== attempt) throw new Error('Bloqueo del checkout pertenece a otro trabajo, recibo o intento.');
    return { file, owner };
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return { file, owner: null };
    throw error;
  }
}

// Admission reserves the receipt before writing the running job. A queued
// job with its matching ready marker proves the worker entry point was not called.
async function rearmUnstartedPartial(root, receiptId) {
  const lock = await acquireLedgerLock(root, 2000);
  try {
    return await change(root, async state => {
      const receipt = state.receipts.find(item => item.id === receiptId);
      const recovery = receipt?.dispatchRecovery;
      const job = (await loadState(root)).jobs.find(item => item.id === receipt?.jobId);
      if (job?.state !== 'queued' || !['claimed', 'needs_attention'].includes(receipt.status)
        || !isPartialStageResume(recovery?.mode) || recovery.phase !== 'consumed' || job.livenessResume?.phase !== 'ready'
        || job.livenessResume.id !== recovery.id || job.attempts !== recovery.attempt
        || receipt.retryAuthorizedAttempt !== job.attempts || job.autoIntent?.receiptId !== receiptId) return false;
      assertRecoveryCheckpoint(job, recovery);
      if (job.kind === 'code') {
        const checkout = await recoveryCheckoutLock(root, job, receiptId, recovery.attempt, { allowMissing: true });
        if (checkout.owner) await fs.unlink(checkout.file);
      }
      receipt.dispatchRecovery = { ...job.livenessResume, updatedAt: now() };
      receipt.status = 'pending'; receipt.updatedAt = now();
      receipt.reason = 'La admisión anterior quedó sin arrancar; se conserva la recuperación verificada.';
      audit(state, 'partial_admission_rearmed', { jobId: job.id, receiptId, recoveryId: recovery.id });
      return true;
    });
  } finally { await releaseLock(lock); }
}

// Resume a positively observed native worker, never infer non-execution from an
// unknown state. The callback must query Orca; HTTP callers cannot supply proof.
export function recoverKnownDispatchReceipt(root, jobId, { confirm = false, inspectDispatch, verify = verifyGitHubDestination, captureSnapshot = captureIntegrationSnapshot, inspectIntegrationEffects = inspectEffectFreeIntegration, qualityAction, uxHandoff, developerDecision, stageDecision } = {}) {
  if (!confirm || typeof inspectDispatch !== 'function') return Promise.reject(new Error('Confirma la recuperación y consulta nativamente el dispatch exacto antes de reanudar.'));
  root = path.resolve(root);
  const key = `${root}:${jobId}`;
  if (dispatchRecoveries.has(key)) return dispatchRecoveries.get(key);
  const pending = recoverKnownDispatchOnce(root, jobId, { inspectDispatch, verify, captureSnapshot, inspectIntegrationEffects, qualityAction, uxHandoff, developerDecision, stageDecision }).finally(() => dispatchRecoveries.delete(key));
  dispatchRecoveries.set(key, pending);
  return pending;
}

async function recoverKnownDispatchOnce(root, jobId, { inspectDispatch, verify, captureSnapshot, inspectIntegrationEffects, qualityAction, uxHandoff, developerDecision, stageDecision }) {
  const initial = (await loadState(root)).jobs.find(item => item.id === jobId);
  const integration = (await readAutoRun(root)).integrations?.[initial?.autoIntent?.receiptId];
  if ((initial?.error?.code === 'github_integration_needs_attention' && integration?.commitSha || recoverableChecksTimeout(initial, integration))
    || initial?.livenessResume?.mode === 'same_attempt_integration_reconcile' && ['ready', 'verified', 'lock_released'].includes(initial.livenessResume.phase)) {
    return recoverIntegrationReconcileOnce(root, jobId, { inspectDispatch });
  }
  if (qualityAction || settledQaRevalidation(initial) || initial?.error?.code === 'github_integration_needs_attention' || initial?.livenessResume?.mode === 'same_attempt_integration_validation'
    && ['ready', 'verified', 'lock_released'].includes(initial.livenessResume.phase)) {
    return recoverIntegrationValidationOnce(root, jobId, { inspectDispatch, verify, qualityAction, inspectIntegrationEffects });
  }
  let queueLock, recoveryId, candidate;
  try {
    queueLock = await acquireLedgerLock(root, 2000);
    candidate = await change(root, async state => {
      const job = (await loadState(root)).jobs.find(item => item.id === jobId);
      const receipt = state.receipts.find(item => item.jobId === jobId);
      const prior = receipt?.dispatchRecovery;
      const stage = job?.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
      const sameCheckpoint = prior && job?.attempts === prior.attempt && stage?.key === prior.stage && stage?.dispatchId === prior.dispatchId && stage?.taskId === prior.taskId && stage?.runId === prior.runId;
      if (prior?.mode === 'retry_stopped_developer' && job?.state === 'queued'
        && ['ready', 'lock_released'].includes(prior.phase)) {
        assertRecoveryCheckpoint(job, prior);
        return { job, done: prior.phase === 'ready', receiptId: receipt.id, recovery: prior };
      }
      if (sameCheckpoint && prior.phase === 'ready' && job.state === 'queued' && receipt.status === 'pending') {
        assertRecoveryCheckpoint(job, prior); return { job, done: true };
      }
      if (job?.state === 'queued' && job.livenessResume?.id === prior?.id && isPartialStageResume(prior?.mode)
        && ['ready', 'lock_released'].includes(prior.phase)) {
        assertRecoveryCheckpoint(job, prior);
        return { job, done: prior.phase === 'ready', receiptId: receipt.id, recovery: prior };
      }
      const resuming = sameCheckpoint && ['verified', 'lock_released'].includes(prior.phase);
      const handoff = resuming ? prior.uxHandoff : uxHandoff;
      const uxReturn = uxReturnSource(job, handoff);
      const legacyDecision = resuming ? prior.developerDecision : developerDecision;
      const decision = resuming ? prior.stageDecision : stageDecision;
      const decidedStep = decision ? stageDecisionSource(job, decision) : developerDecisionSource(job, legacyDecision);
      const integrationRecord = state.integrations?.[receipt?.id];
      if ((decision || legacyDecision) && (!decidedStep || integrationRecord && (!['qa', 'reviewer'].includes(stage.key)
        || integrationRecord.phase !== 'validation_pending' || integrationRecord.commitSha || integrationRecord.validation?.approvals))) {
        throw new Error('La decisión no corresponde a la etapa parcial vigente o hay efectos de integración.');
      }
      if (handoff && (!uxReturn || state.integrations?.[receipt?.id])) throw new Error('El retorno UX no corresponde al candidato parcial vigente.');
      const rearm = isEffectFreeLivenessPreflight(job, prior);
      const observationError = resuming ? prior.error : job?.error?.code;
      const observation = settledOrcaObservation(job, observationError);
      const transportError = deliveryTransportError(job);
      const deliveryTransport = transportError && (job.error?.code === transportError
        || resuming && prior.mode === 'same_attempt_delivery_transport');
      if (prior?.mode === 'same_attempt_liveness' && prior.phase === 'consumed' && job?.error?.code !== 'orca_liveness_unconfirmed' && !rearm && !deliveryTransport && !observation && !uxReturn && !decidedStep) {
        throw new Error('La recuperación consumida no acredita un preflight sin efectos y no se puede rearmar.');
      }
      const sameAttempt = job?.error?.code === 'orca_liveness_unconfirmed' || observation || uxReturn || decidedStep || rearm || deliveryTransport || Boolean(resuming && isSameAttemptRecoveryMode(prior.mode));
      const originalError = deliveryTransport ? transportError : observation ? observationError : uxReturn || decidedStep ? job.error.code : 'orca_liveness_unconfirmed';
      const mode = uxReturn ? 'same_attempt_ux_return' : decidedStep ? (decision ? 'same_attempt_stage_decision' : 'same_attempt_developer_decision') : deliveryTransport ? 'same_attempt_delivery_transport' : 'same_attempt_liveness';
      const preservesDispatch = stage && (observation || uxReturn || decidedStep || deliveryTransport || (['blocked', 'running'].includes(stage.status) && !['rejected', 'failed', 'cancelled', 'abandoned', 'completed'].includes(stage.dispatchStatus))
        || (stage.status === 'failed' && ['completed', 'unknown'].includes(stage.dispatchStatus)));
      if (!job || (job.kind !== 'code' && !decidedStep) || !receipt?.eligible || !job.autoIntent?.eligible || receipt.id !== job.autoIntent.receiptId
        || receipt.business !== job.business || receipt.spec?.id !== job.id || receipt.spec?.kind !== job.kind
        || job.kind === 'code' && (receipt.spec.workspace !== job.workspace || receipt.spec.branch !== job.branch
          || !sameRepository(receipt.spec.destination?.repository, job.destination?.repository) || receipt.spec.destination?.baseBranch !== job.destination?.baseBranch)
        || !['needs_attention', 'retrying'].includes(receipt.status)
        || !(job.state === 'needs_attention' || resuming && job.state === 'queued') || (!sameAttempt && job.attempts >= job.maxAttempts)
        || !preservesDispatch || !/^run_[A-Za-z0-9_-]{6,80}$/.test(stage.runId || '')
        || !/^task_[A-Za-z0-9_-]{6,80}$/.test(stage.taskId || '') || !/^ctx_[A-Za-z0-9_-]{6,80}$/.test(stage.dispatchId || '')
        || stage.runId !== job.workflow.runId || stage.attempt !== job.attempts) {
        throw new Error('El recibo no permite recuperar una etapa nativa conocida conservando su dispatch e intento.');
      }
      const recovery = resuming ? prior : {
        id: createHash('sha256').update(`${receipt.id}:${job.attempts}:${stage.dispatchId}:${sameAttempt ? mode + ':' + createHash('sha256').update(JSON.stringify({ stage, history: job.attemptHistory })).digest('hex') : 'dispatch'}`).digest('hex'),
        jobId, receiptId: receipt.id, stage: stage.key, attempt: job.attempts,
        runId: stage.runId, taskId: stage.taskId, dispatchId: stage.dispatchId,
        checkpointHash: createHash('sha256').update(JSON.stringify(stage)).digest('hex'),
        destination: structuredClone(job.destination), createdAt: now(),
        ...(uxReturn ? { uxHandoff: handoff, originalWorkflowHash: recoveryFingerprint(job.workflow) } : {}),
        ...(decidedStep ? { ...(decision ? { stageDecision: decision } : { developerDecision: legacyDecision }), originalWorkflowHash: recoveryFingerprint(job.workflow) } : {}),
        ...(sameAttempt ? { mode, error: originalError, ...(deliveryTransport ? { originalError } : {}), elapsedMs: elapsedAttemptMs(job), timeoutMs: job.timeoutMs } : {}),
        ...(rearm ? { rearmedFrom: prior.id, rearmReason: 'effect_free_preflight', preflightSegmentHash: createHash('sha256').update(JSON.stringify(job.attemptHistory.at(-1))).digest('hex') } : {}),
      };
      if (sameAttempt && ((!observation && !uxReturn && !decidedStep && (stage.error !== originalError || stage.status !== 'blocked')) || executionTimeExhausted(job, recovery.elapsedMs))) {
        throw new Error('No queda tiempo del mismo intento o el bloqueo no corresponde a cierre no confirmado.');
      }
      assertRecoveryCheckpoint(job, recovery);
      if (job.kind === 'code') assertRecoveryDestination(recovery.destination, job.destination);
      const expected = { jobId, receiptId: receipt.id, stage: recovery.stage, attempt: recovery.attempt, runId: recovery.runId, taskId: recovery.taskId, dispatchId: recovery.dispatchId,
        ...(uxReturn || decidedStep ? { mode: recovery.mode } : {}) };
      const observed = await inspectDispatch(expected);
      const stoppedDeveloper = recovery.mode === 'retry_stopped_developer'
        || !resuming && !sameAttempt && observed?.state === 'stopped' && Boolean(stoppedDeveloperCheckpoint(job));
      if (['runId', 'taskId', 'dispatchId'].some(field => observed?.[field] !== expected[field])
        || !(stoppedDeveloper ? observed?.state === 'stopped' && observed.liveness === 'exited' && observed.dispatchStatus === 'failed'
          : sameAttempt ? (uxReturn ? observed?.state === 'failed' && observed.partialResumeVerified : decidedStep ? observed?.state === (stage.dispatchStatus === 'failed' ? 'failed' : 'succeeded') && observed.partialResumeVerified : ['succeeded', ...(observation ? ['failed', 'cancelled'] : [])].includes(observed?.state)) && observed.liveness === 'exited'
          : ['ready', 'running'].includes(observed?.state) && observed.liveness === 'live' || observed?.state === 'succeeded' && observed.liveness === 'exited')) {
        throw new Error('Orca no acredita la identidad y actividad o cierre del dispatch exacto; unknown no permite reanudar.');
      }
      if (observation && observationError === 'delivery_invalid' && !observed.explicitBlockedReport) throw new Error('La entrega original no acredita un rechazo explícito recuperable.');
      if (deliveryTransport) {
        const proof = assertDeliveryTransportProof(job, observed.deliveryTransport);
        if (resuming && JSON.stringify(assertDeliveryTransportProof(job, recovery.deliveryTransport)) !== JSON.stringify(proof)) {
          throw new Error('La evidencia de transporte cambió durante la recuperación.');
        }
        recovery.deliveryTransport = proof;
      }
      if (job.kind === 'code') {
        const destination = await verify(root, job, { requireClean: recovery.stage === 'ux' && !decidedStep });
        assertRecoveryDestination(recovery.destination, destination);
      }
      // D3 for QA and Revisión: the interrupted quality stage resumes over the exact candidate that the
      // sealed pre-QA validation recorded; a changed record or checkout refuses before releasing the lock.
      if (observation && observationError === 'interrupted' && ['qa', 'reviewer'].includes(recovery.stage) && job.autoIntent?.eligible === true) {
        const saved = integrationRecord?.validation, developer = job.workflow.steps.find(item => item.key === 'developer');
        if (integrationRecord?.phase !== 'validation_pending' || integrationRecord.status !== 'validating' || integrationRecord.commitSha || integrationRecord.manifest
          || !/^[a-f0-9]{64}$/.test(saved?.snapshot || '') || saved.approvals || saved.jobId !== job.id || saved.receiptId !== receipt.id
          || saved.attempt !== job.attempts || saved.runId !== job.workflow.runId || saved.cycleId !== (job.validationCycle || `attempt-${job.attempts}`)
          || saved.developerTaskId !== developer?.taskId || saved.developerDispatchId !== developer?.dispatchId || saved.developerArtifactSha256 !== developer?.artifact?.sha256
          || resuming && recoveryFingerprint(integrationRecord) !== prior.integrationRecordHash) {
          throw new Error('La validación sellada antes de QA no corresponde a la etapa interrumpida; no se reanuda.');
        }
        if (await captureSnapshot(job.workspace) !== saved.snapshot) throw new Error('Los archivos cambiaron desde la validación sellada antes de QA.');
        recovery.integrationRecordHash = recoveryFingerprint(integrationRecord);
      }
      if (job.kind === 'code' && (uxReturn || decidedStep)) {
        const snapshot = await captureSnapshot(job.workspace);
        if (recovery.snapshot && recovery.snapshot !== snapshot) throw new Error('El candidato parcial cambió durante la recuperación.');
        if (integrationRecord?.validation && integrationRecord.validation.snapshot !== snapshot) throw new Error('El candidato ya no coincide con el snapshot de QA o Revisión.');
        recovery.snapshot = snapshot;
      }
      if (stoppedDeveloper) {
        recovery.mode = 'retry_stopped_developer';
        const snapshot = await captureSnapshot(job.workspace);
        if (recovery.snapshot && recovery.snapshot !== snapshot) throw new Error('El checkout cambió durante la recuperación de Desarrollo.');
        recovery.snapshot = snapshot;
      }
      const checkoutLock = job.kind === 'code' ? await recoveryCheckoutLock(root, job, receipt.id, recovery.attempt, { allowMissing: Boolean(resuming && prior.lockOwner) }) : {};
      if (resuming && prior.lockOwner && checkoutLock.owner && JSON.stringify(prior.lockOwner) !== JSON.stringify(checkoutLock.owner)) throw new Error('El propietario del bloqueo cambió durante la recuperación.');
      if (prior && !resuming) receipt.dispatchRecoveryHistory = [...(receipt.dispatchRecoveryHistory || []), prior];
      receipt.status = 'retrying';
      receipt.dispatchRecovery = { ...recovery, phase: recovery.phase || 'verified', observedState: observed.state, liveness: observed.liveness,
        verifiedAt: now(), lockOwner: recovery.lockOwner || checkoutLock.owner };
      audit(state, 'known_dispatch_recovery_verified', { receiptId: receipt.id, jobId, recoveryId: recovery.id, ...expected, state: observed.state });
      return { job, receiptId: receipt.id, recovery: receipt.dispatchRecovery };
    });
    if (candidate.done) return candidate.job;
    recoveryId = candidate.recovery.id;
    const checkoutLock = candidate.job.kind === 'code' ? await recoveryCheckoutLock(root, candidate.job, candidate.receiptId, candidate.recovery.attempt, { allowMissing: true }) : {};
    if (checkoutLock.owner) {
      if (JSON.stringify(checkoutLock.owner) !== JSON.stringify(candidate.recovery.lockOwner)) throw new Error('El propietario del bloqueo cambió antes de liberarlo.');
      await fs.unlink(checkoutLock.file);
    }
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (receipt?.dispatchRecovery?.id !== recoveryId) throw new Error('La recuperación cambió antes de reabrir el trabajo.');
      receipt.dispatchRecovery.phase = 'lock_released'; receipt.dispatchRecovery.updatedAt = now();
    });
    await releaseLock(queueLock); queueLock = null;
    // retryJob owns the queue mutation and keeps this blocked/unknown dispatch
    // verbatim. A replay after this checkpoint must not retry a second time.
    const current = (await loadState(root)).jobs.find(item => item.id === jobId);
    if (current?.state === 'needs_attention') {
      if (isSameAttemptRecoveryMode(candidate.recovery.mode)) await queueKnownLivenessResume(root, jobId, candidate.recovery);
      else await retryJob(root, jobId, { confirm: true, ...(candidate.recovery.mode === 'retry_stopped_developer'
        ? { stoppedDeveloperRecovery: { ...candidate.recovery, phase: 'lock_released' } } : {}) });
    }
    return await change(root, async state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      const job = (await loadState(root)).jobs.find(item => item.id === jobId);
      if (receipt?.dispatchRecovery?.id !== recoveryId || job?.state !== 'queued' || job.attempts !== candidate.recovery.attempt) throw new Error('La recuperación no conserva el mismo trabajo e intento antes de admitirlo.');
      assertRecoveryCheckpoint(job, candidate.recovery);
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      receipt.dispatchRecovery.phase = 'ready'; receipt.dispatchRecovery.updatedAt = now();
      receipt.reason = candidate.recovery.mode === 'retry_stopped_developer'
        ? 'Parada verificada en Orca. Continúa Desarrollo en la misma Task con el checkout conservado.'
        : candidate.recovery.mode === 'same_attempt_ux_return' ? 'Retorno a Diseño autorizado sobre el candidato del mismo encargo.'
          : ['same_attempt_developer_decision', 'same_attempt_stage_decision'].includes(candidate.recovery.mode) ? 'La etapa continúa con la decisión registrada dentro del mismo intento.'
          : candidate.recovery.error === 'orca_response_too_large' ? 'Informe de Orca pendiente de lectura; se recupera el mismo dispatch.'
          : 'Dispatch nativo conocido verificado; continúa la misma etapa sin crear otra.';
      audit(state, 'known_dispatch_recovery_ready', { receiptId: receipt.id, jobId, recoveryId, dispatchId: candidate.recovery.dispatchId, attempt: job.attempts });
      return job;
    });
  } catch (error) {
    if (recoveryId) await change(root, state => {
      const receipt = state.receipts.find(item => item.jobId === jobId);
      if (receipt?.dispatchRecovery?.id === recoveryId && receipt.dispatchRecovery.phase !== 'ready') {
        receipt.status = 'needs_attention'; receipt.dispatchRecovery.lastError = String(error.message).slice(0, 1000); receipt.updatedAt = now();
      }
    }).catch(() => {});
    throw error;
  } finally { if (queueLock) await releaseLock(queueLock); }
}

async function recoverIntegrationReconcileOnce(root, jobId, { inspectDispatch }) {
  let queueLock;
  try {
    queueLock = await acquireLedgerLock(root, 2000);
    const candidate = await change(root, async state => {
      const job = (await loadState(root)).jobs.find(item => item.id === jobId);
      const receipt = state.receipts.find(item => item.jobId === jobId), prior = receipt?.dispatchRecovery, record = state.integrations?.[receipt?.id];
      if (prior?.mode === 'same_attempt_integration_reconcile' && prior.phase === 'ready' && receipt.status === 'pending' && job?.state === 'queued') {
        assertRecoveryCheckpoint(job, prior);
        if (recoveryFingerprint(record) !== prior.integrationRecordHash) throw new Error('La integración cambió después de autorizarla.');
        return { done: true, job };
      }
      const resuming = prior?.mode === 'same_attempt_integration_reconcile' && ['verified', 'lock_released'].includes(prior.phase);
      const step = job?.workflow?.steps?.find(item => item.key === 'integration');
      if (!job || job.kind !== 'code' || !receipt?.eligible || !job.autoIntent?.eligible || job.autoIntent.receiptId !== receipt.id
        || receipt.business !== job.business || receipt.spec?.id !== job.id || receipt.spec.workspace !== job.workspace || receipt.spec.branch !== job.branch
        || !sameRepository(receipt.spec.destination?.repository, job.destination?.repository) || receipt.spec.destination?.baseBranch !== job.destination?.baseBranch
        || !['needs_attention', 'retrying'].includes(receipt.status) || !['needs_attention', ...(resuming ? ['queued'] : [])].includes(job.state)
        || !resuming && job.error?.code !== 'github_integration_needs_attention' && !recoverableChecksTimeout(job, record) || job.workflow?.currentStage !== 'integration'
        || step?.status !== 'blocked' || step.error !== 'integration_needs_attention' || record?.status !== 'needs_attention') {
        throw new Error('El recibo no acredita una integración confirmada pendiente de reconciliar.');
      }
      const originalSteps = assertCommittedIntegrationRecord(job, record), integrationRecordHash = recoveryFingerprint(record);
      if (!resuming && job.livenessRecoveryHistory?.some(item => item.mode === 'same_attempt_integration_reconcile' && item.integrationRecordHash === integrationRecordHash)) {
        throw new Error('Este registro de integración ya consumió su recuperación.');
      }
      const recovery = resuming ? prior : { id: recoveryFingerprint({ jobId, receiptId: receipt.id, integrationRecordHash, workflow: job.workflow }),
        mode: 'same_attempt_integration_reconcile', jobId, receiptId: receipt.id, attempt: job.attempts, stage: 'integration', runId: job.workflow.runId,
        originalError: job.error.code, checkpointHash: recoveryFingerprint(job.workflow), integrationRecordHash,
        originalSteps, originalIntegrationRecord: structuredClone(record), destination: structuredClone(job.destination),
        elapsedMs: elapsedAttemptMs(job), timeoutMs: job.timeoutMs, createdAt: now() };
      if (recovery.integrationRecordHash !== integrationRecordHash || recovery.elapsedMs !== elapsedAttemptMs(job)
        || executionTimeExhausted(job, recovery.elapsedMs) || recovery.timeoutMs !== job.timeoutMs) throw new Error('La integración o el tiempo restante cambió.');
      assertRecoveryCheckpoint(job, recovery); assertRecoveryDestination(recovery.destination, job.destination);
      const observed = await inspectDispatch({ mode: recovery.mode, jobId, receiptId: receipt.id, attempt: recovery.attempt, stage: 'integration', runId: recovery.runId,
        checkpointHash: recovery.checkpointHash, integrationRecordHash, originalSteps });
      if (observed?.state !== 'succeeded' || observed.liveness !== 'exited' || observed.runId !== recovery.runId) throw new Error('Las etapas aprobadas no acreditan cierre nativo exacto.');
      const proof = assertIntegrationReconcileProof(job, recovery, observed.integrationProof);
      if (resuming && recoveryFingerprint(proof) !== recoveryFingerprint(prior.integrationProof)) throw new Error('La PR observada cambió durante la recuperación.');
      const checkoutLock = await recoveryCheckoutLock(root, job, receipt.id, recovery.attempt, { allowMissing: Boolean(resuming && prior.lockOwner) });
      if (resuming && checkoutLock.owner && recoveryFingerprint(checkoutLock.owner) !== recoveryFingerprint(prior.lockOwner)) throw new Error('El bloqueo del checkout cambió.');
      if (prior && !resuming) receipt.dispatchRecoveryHistory = [...(receipt.dispatchRecoveryHistory || []), prior];
      receipt.status = 'retrying'; receipt.dispatchRecovery = { ...recovery, integrationProof: proof, observedState: observed.state, liveness: observed.liveness,
        phase: recovery.phase || 'verified', verifiedAt: now(), lockOwner: recovery.lockOwner || checkoutLock.owner };
      audit(state, 'integration_reconcile_verified', { jobId, receiptId: receipt.id, recoveryId: recovery.id, attempt: job.attempts });
      return { job, receiptId: receipt.id, recovery: receipt.dispatchRecovery };
    });
    if (candidate.done) return candidate.job;
    const { job, receiptId, recovery } = candidate;
    const checkoutLock = await recoveryCheckoutLock(root, job, receiptId, recovery.attempt, { allowMissing: true });
    if (checkoutLock.owner) {
      if (recoveryFingerprint(checkoutLock.owner) !== recoveryFingerprint(recovery.lockOwner)) throw new Error('El bloqueo cambió antes de continuar integración.');
      await fs.unlink(checkoutLock.file);
    }
    await change(root, state => { const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.dispatchRecovery?.id !== recovery.id) throw new Error('La recuperación de integración cambió.'); receipt.dispatchRecovery.phase = 'lock_released'; });
    await releaseLock(queueLock); queueLock = null;
    const queued = await queueIntegrationReconcileResume(root, jobId, recovery);
    return await change(root, state => {
      const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.dispatchRecovery?.id !== recovery.id || recoveryFingerprint(state.integrations[receiptId]) !== recovery.integrationRecordHash) throw new Error('El recibo o registro de integración cambió.');
      receipt.dispatchRecovery = { ...queued.livenessResume, phase: 'ready', updatedAt: now() };
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      receipt.reason = 'Continuar la PR exacta ya creada con sus aprobaciones, dentro del mismo intento.';
      audit(state, 'integration_reconcile_ready', { jobId, receiptId, recoveryId: recovery.id, attempt: job.attempts }); return queued;
    });
  } finally { if (queueLock) await releaseLock(queueLock); }
}

async function recoverIntegrationValidationOnce(root, jobId, { inspectDispatch, verify, qualityAction, inspectIntegrationEffects = inspectEffectFreeIntegration }) {
  let queueLock;
  try {
    queueLock = await acquireLedgerLock(root, 2000);
    const candidate = await change(root, async state => {
      const job = (await loadState(root)).jobs.find(item => item.id === jobId);
      const receipt = state.receipts.find(item => item.jobId === jobId), prior = receipt?.dispatchRecovery;
      if (prior?.mode === 'same_attempt_integration_validation' && prior.phase === 'ready' && receipt.status === 'pending' && job?.state === 'queued') {
        assertRecoveryCheckpoint(job, prior); return { done: true, job };
      }
      const unstarted = prior?.mode === 'same_attempt_integration_validation' && ['qa', 'reviewer'].includes(prior.stage) && prior.phase === 'consumed'
        && receipt.status === 'needs_attention' && receipt.reason === 'El recibo no autorizó el reintento de Desarrollo detenido.'
        && job?.state === 'queued' && job.livenessResume?.phase === 'ready' && job.livenessResume.id === prior.id
        && job.attempts === prior.attempt && receipt.retryAuthorizedAttempt === prior.attempt;
      if (unstarted) {
        assertRecoveryCheckpoint(job, prior);
        const saved = state.integrations[receipt.id];
        const proof = assertIntegrationValidationProof(prior, job.livenessResume.integrationValidation);
        if (saved?.integrationRecoveryId !== prior.id || saved.phase !== 'validation_pending' || saved.validation
          || saved.validationCandidateSnapshot !== proof.candidateSnapshot) throw new Error('La admisión anterior cambió el registro de validación.');
        const native = await inspectDispatch(prior);
        if (native?.runId !== prior.runId || native.liveness !== 'exited' || native.state !== 'succeeded'
          || recoveryFingerprint(assertIntegrationValidationProof(prior, native.integrationValidation)) !== recoveryFingerprint(proof)) {
          throw new Error('No coincide el cierre nativo y el candidato de la admisión que quedó sin arrancar.');
        }
        assertRecoveryDestination(prior.destination, await verify(root, job, { requireClean: false }));
        const checkout = await recoveryCheckoutLock(root, job, receipt.id, prior.attempt, { allowMissing: true });
        return { unstarted, job, receiptId: receipt.id, recovery: prior, checkout };
      }
      const resuming = prior?.mode === 'same_attempt_integration_validation' && ['verified', 'lock_released'].includes(prior.phase);
      const record = state.integrations?.[receipt?.id], step = job?.workflow?.steps?.find(item => item.key === 'integration');
      const action = resuming ? prior.qualityAction : qualityAction;
      if (action && job?.state === 'needs_attention') assertQualityAction(job, action);
      const scope = resuming ? prior.stage : action ? job.workflow.currentStage : settledQaRevalidation(job) ? 'qa' : 'integration';
      if (qualityAction && scope === 'integration') throw new Error('El informe de calidad ya no está vigente.');
      // A job that already consumed a validation cycle may still resume only the integration (29); a new revalidation is refused below.
      const integrationBlocked = job?.error?.code === 'github_integration_needs_attention' && job.workflow?.currentStage === 'integration'
        && step?.status === 'blocked' && step.error === 'integration_needs_attention';
      const previousValidation = record?.validation;
      const developer = job?.workflow?.steps?.find(item => item.key === 'developer');
      const recordEligible = scope !== 'integration' ? job && receipt && record?.phase === 'validation_pending' && record.status === 'validating'
        && /^[a-f0-9]{64}$/.test(previousValidation?.snapshot || '') && !previousValidation.approvals
        && previousValidation.attempt === job.attempts && previousValidation.runId === job.workflow.runId
        && previousValidation.cycleId === (job.validationCycle || `attempt-${job.attempts}`)
        && previousValidation.jobId === job.id && previousValidation.receiptId === receipt.id
        && previousValidation.developerTaskId === developer?.taskId && previousValidation.developerDispatchId === developer?.dispatchId
        && previousValidation.developerArtifactSha256 === developer?.artifact?.sha256
        && previousValidation.workspace === job.workspace && previousValidation.branch === job.branch
        : record?.status === 'needs_attention' && (record.error === 'El diff actual no coincide con la revisión aprobada.'
          && record.phase === undefined && record.validation === undefined
          // 29: a failure after the files were sealed (validation_pending/approved) but before any effect intent.
          || record.phase !== undefined && effectFreeIntegrationRecord(record, state.history, job?.id));
      const preEffectFailure = scope === 'integration' && record?.phase !== undefined;
      if (!job || job.kind !== 'code' || !receipt?.eligible || !job.autoIntent?.eligible || job.autoIntent.receiptId !== receipt.id
        || receipt.business !== job.business || receipt.spec?.id !== job.id || receipt.spec.workspace !== job.workspace || receipt.spec.branch !== job.branch
        || !sameRepository(receipt.spec.destination?.repository, job.destination?.repository) || receipt.spec.destination?.baseBranch !== job.destination?.baseBranch
        || !['needs_attention', 'retrying'].includes(receipt.status) || !['needs_attention', ...(resuming ? ['queued'] : [])].includes(job.state)
        || !resuming && scope === 'integration' && !integrationBlocked
        || !recordEligible || record.jobId !== job.id || record.receiptId !== receipt.id
        || ['manifest', 'commitSha', 'prNumber', 'prUrl', 'mergeSha', 'pushedAt', 'mergedAt'].some(key => record[key] !== undefined)
        || state.history.some(item => item.jobId === job.id && item.type === 'github_integration' && item.phase
          && (scope === 'integration' ? !['validation_pending', 'validation_approved'].includes(item.phase) : item.phase !== 'validation_pending'))) {
        throw new Error('La integración no acredita un único fallo previo a efectos y sin manifiesto durable.');
      }
      // The remote must confirm the failure was inert before the same attempt revalidates and integrates again.
      const integrationEffects = preEffectFailure && !resuming ? await inspectIntegrationEffects(root, job, record, { history: state.history }) : resuming ? prior.integrationEffects : undefined;
      if (preEffectFailure && integrationEffects?.kind !== 'effect_free_integration') throw new Error('No se pudo confirmar con el remoto que la integración fallida no tuvo efectos.');
      const recovery = resuming ? prior : { id: recoveryFingerprint({ jobId, receiptId: receipt.id, workflow: job.workflow, record, qualityAction: action }),
        mode: 'same_attempt_integration_validation', jobId, receiptId: receipt.id, attempt: job.attempts, stage: scope, runId: job.workflow.runId,
        originalError: job.error.code, originalWorkflowHash: recoveryFingerprint(job.workflow), integrationRecordHash: recoveryFingerprint(record),
        ...(action ? { qualityAction: action } : {}), ...(integrationEffects ? { integrationEffects } : {}),
        originalSteps: integrationValidationSteps(job, scope, action), originalIntegrationRecord: structuredClone(record), destination: structuredClone(job.destination),
        elapsedMs: elapsedAttemptMs(job), timeoutMs: job.timeoutMs, createdAt: now() };
      if (recovery.elapsedMs !== elapsedAttemptMs(job) || executionTimeExhausted(job, recovery.elapsedMs) || recovery.timeoutMs !== job.timeoutMs
        || recovery.integrationRecordHash !== recoveryFingerprint(record)) throw new Error('La evidencia o el tiempo restante de integración cambió.');
      assertRecoveryCheckpoint(job, recovery); assertRecoveryDestination(recovery.destination, job.destination);
      const observed = await inspectDispatch({ mode: recovery.mode, jobId, receiptId: receipt.id, attempt: recovery.attempt, stage: scope, runId: recovery.runId,
        originalWorkflowHash: recovery.originalWorkflowHash, integrationRecordHash: recovery.integrationRecordHash, originalSteps: recovery.originalSteps, qualityAction: recovery.qualityAction });
      if (observed?.state !== 'succeeded' || observed.liveness !== 'exited' || observed.runId !== recovery.runId) throw new Error('Las etapas originales no acreditan cierre nativo exacto.');
      const proof = assertIntegrationValidationProof(recovery, observed.integrationValidation);
      if (scope !== 'integration' && proof.candidateSnapshot !== previousValidation.snapshot) throw new Error('Los archivos cambiaron desde el QA anterior.');
      // 29: resume only the integration when (a) the checkout snapshot is exactly the one QA and
      // Revisión approved, (b) the remote confirmed no commit, push or PR and (c) the remote base
      // branch was verifiable. Otherwise QA and Revisión are revalidated on the current files.
      const approvedSnapshot = record?.phase === 'validation_approved' && previousValidation?.approvals && /^[a-f0-9]{64}$/.test(previousValidation.snapshot || '') ? previousValidation.snapshot : null;
      const integrationOnly = preEffectFailure && Boolean(approvedSnapshot) && proof.candidateSnapshot === approvedSnapshot
        && /^[a-f0-9]{40,64}$/i.test(integrationEffects?.remoteBaseSha || '') && integrationEffects.remoteBaseSha === job.destination?.baseSha;
      if (resuming ? Boolean(prior.integrationOnly) !== integrationOnly : false) throw new Error('El candidato cambió respecto a la huella aprobada durante la recuperación.');
      if (!resuming && integrationOnly) recovery.integrationOnly = true;
      if (!resuming && scope === 'integration' && !integrationOnly && job.validationCycle) throw new Error('Solo se revalida una vez la integración sin manifiesto original.');
      if (resuming && recoveryFingerprint(proof) !== recoveryFingerprint(recovery.integrationValidation)) throw new Error('El candidato cambió durante la recuperación de integración.');
      assertRecoveryDestination(recovery.destination, await verify(root, job, { requireClean: false }));
      const checkoutLock = await recoveryCheckoutLock(root, job, receipt.id, recovery.attempt, { allowMissing: Boolean(resuming && prior.lockOwner) });
      if (resuming && checkoutLock.owner && recoveryFingerprint(checkoutLock.owner) !== recoveryFingerprint(prior.lockOwner)) throw new Error('El bloqueo del checkout cambió.');
      if (prior && !resuming) receipt.dispatchRecoveryHistory = [...(receipt.dispatchRecoveryHistory || []), prior];
      receipt.status = 'retrying';
      receipt.dispatchRecovery = { ...recovery, integrationValidation: proof, observedState: observed.state, liveness: observed.liveness,
        phase: recovery.phase || 'verified', verifiedAt: now(), lockOwner: recovery.lockOwner || checkoutLock.owner };
      audit(state, 'integration_validation_verified', { jobId, receiptId: receipt.id, recoveryId: recovery.id, attempt: job.attempts });
      return { job, receiptId: receipt.id, recovery: receipt.dispatchRecovery };
    });
    if (candidate.done) return candidate.job;
    const { recovery, receiptId, job } = candidate;
    const checkoutLock = await recoveryCheckoutLock(root, job, receiptId, recovery.attempt, { allowMissing: true });
    if (candidate.unstarted) {
      if (recoveryFingerprint(checkoutLock.owner) !== recoveryFingerprint(candidate.checkout.owner)) throw new Error('El bloqueo cambió tras comprobar la admisión no iniciada.');
      if (checkoutLock.owner) await fs.unlink(checkoutLock.file);
      return await change(root, state => {
        const receipt = state.receipts.find(item => item.id === receiptId);
        if (receipt?.dispatchRecovery?.id !== recovery.id || receipt.status !== 'needs_attention'
          || receipt.dispatchRecovery.phase !== 'consumed') throw new Error('El recibo de la admisión no iniciada cambió.');
        receipt.dispatchRecovery = { ...job.livenessResume, phase: 'ready', updatedAt: now() };
        receipt.status = 'pending'; receipt.reason = 'Revalidación reencolada tras verificar que la admisión anterior nunca inició un trabajador.';
        receipt.updatedAt = now();
        audit(state, 'qa_admission_rearmed', { jobId, receiptId, recoveryId: recovery.id, attempt: job.attempts });
        return job;
      });
    }
    if (checkoutLock.owner) {
      if (recoveryFingerprint(checkoutLock.owner) !== recoveryFingerprint(recovery.lockOwner)) throw new Error('El bloqueo cambió antes de liberar la nueva validación.');
      await fs.unlink(checkoutLock.file);
    }
    await change(root, state => { const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.dispatchRecovery?.id !== recovery.id) throw new Error('La recuperación de integración cambió.');
      receipt.dispatchRecovery.phase = 'lock_released'; });
    await releaseLock(queueLock); queueLock = null;
    const queued = await queueIntegrationValidationResume(root, jobId, recovery);
    return await change(root, state => {
      const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.dispatchRecovery?.id !== recovery.id || recoveryFingerprint(state.integrations[receiptId]) !== recovery.integrationRecordHash) throw new Error('El recibo o registro de integración cambió.');
      receipt.dispatchRecovery = { ...queued.livenessResume, phase: 'ready', updatedAt: now() };
      receipt.integrationRecoveryHistory = [...(receipt.integrationRecoveryHistory || []), { recoveryId: recovery.id, at: now(), originalRecord: recovery.originalIntegrationRecord }];
      state.integrations[receiptId] = recovery.integrationOnly
        // The sealed validation and its approvals stay; only the failure is cleared so the integration preflight runs again.
        ? { ...state.integrations[receiptId], status: 'validated', needsAttention: false, error: null, integrationRecoveryId: recovery.id, updatedAt: now() }
        : { jobId, receiptId, repository: job.destination.repository, sourceBranch: job.branch, baseBranch: job.destination.baseBranch,
          phase: 'validation_pending', status: 'validation_pending', integrationRecoveryId: recovery.id, validationCandidateSnapshot: recovery.integrationValidation.candidateSnapshot, updatedAt: now() };
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      receipt.reason = recovery.integrationOnly ? 'Integración reanudada sobre la huella aprobada por QA y Revisión; no se repiten esas etapas.'
        : recovery.qualityAction?.type === 'correction' ? 'Corrección de Desarrollo encolada con hallazgos de QA.'
        : recovery.qualityAction?.type === 'answer' ? 'QA reanudado con las respuestas guardadas del panel.'
          : 'Nueva validación QA y revisión sobre candidato fijo; conserva el mismo intento y el historial.';
      audit(state, 'integration_validation_ready', { jobId, receiptId, recoveryId: recovery.id, attempt: job.attempts }); return queued;
    });
  } finally { if (queueLock) await releaseLock(queueLock); }
}

// This is an explicitly reviewed contract correction, not an automatic retry.
// The original receipt/spec, reports and pre-QA snapshot remain immutable.
export async function reviseJobAcceptanceReceipt(root, jobId, { confirm = false, productAcceptance, reason, inspectDispatch, verify = verifyGitHubDestination } = {}) {
  if (!confirm || typeof inspectDispatch !== 'function') throw new Error('Confirma la rectificación y consulta los trabajadores originales antes de continuar.');
  root = path.resolve(root);
  const key = `contract:${root}:${jobId}`;
  const requestHash = contractRevisionHash({ productAcceptance, reason });
  if (dispatchRecoveries.has(key)) {
    const existing = dispatchRecoveries.get(key);
    if (existing.requestHash !== requestHash) throw new Error('Ya se está revisando otro contrato para este trabajo.');
    return existing;
  }
  const pending = reviseJobAcceptanceOnce(root, jobId, { productAcceptance, reason, inspectDispatch, verify }).finally(() => dispatchRecoveries.delete(key));
  pending.requestHash = requestHash;
  dispatchRecoveries.set(key, pending); return pending;
}

async function reviseJobAcceptanceOnce(root, jobId, { productAcceptance, reason, inspectDispatch, verify }) {
  let queueLock;
  try {
    queueLock = await acquireLock(root);
    const candidate = await change(root, async state => {
      const job = (await loadState(root)).jobs.find(item => item.id === jobId), receipt = state.receipts.find(item => item.jobId === jobId);
      const record = state.integrations?.[receipt?.id], prior = receipt?.contractRevision;
      if (!job || !receipt?.eligible || !job.autoIntent?.eligible || receipt.id !== job.autoIntent.receiptId
        || receipt.business !== job.business || receipt.spec?.id !== job.id || receipt.spec.workspace !== job.workspace || receipt.spec.branch !== job.branch
        || !sameRepository(receipt.spec.destination?.repository, job.destination?.repository) || receipt.spec.destination?.baseBranch !== job.destination?.baseBranch
        || receipt.dispatchRecovery?.phase === 'ready') throw new Error('El recibo no corresponde al contrato y destino originales.');
      const resuming = prior && ['verified', 'lock_released'].includes(prior.phase);
      const replay = prior?.phase === 'ready' && receipt.status === 'pending' && job.state === 'queued';
      const original = prior ? originalContractRevisionJob(job, prior) : job;
      const requested = createContractRevision(original, record, productAcceptance, reason);
      if (prior && requested.id !== prior.id) throw new Error('La rectificación ya identifica otro contrato; no puede sustituirse durante su recuperación.');
      if (replay) { assertContractRevisionCheckpoint(job, job.contractRevision); return { done: true, job }; }
      if (prior && !resuming || !['needs_attention', 'retrying'].includes(receipt.status)
        || !(job.state === 'needs_attention' || resuming && job.state === 'queued')) throw new Error('El recibo no permite una nueva rectificación.');
      const revision = resuming ? { ...prior, ...(job.state === 'queued' ? { queuedWorkflowHash: job.contractRevision?.queuedWorkflowHash } : {}) } : { ...requested, createdAt: now() };
      assertContractRevisionCheckpoint(job, revision);
      if (contractRevisionHash(record) !== revision.integrationRecordHash) throw new Error('La validación original cambió.');
      const nativeProof = assertContractRevisionProof(revision, await inspectDispatch({ mode: 'product_acceptance_revision', ...revision }));
      if (resuming && contractRevisionHash(nativeProof) !== contractRevisionHash(prior.nativeProof)) throw new Error('La evidencia de la rectificación cambió.');
      assertRecoveryDestination(revision.destination, await verify(root, job, { requireClean: false }));
      const checkoutLock = await recoveryCheckoutLock(root, job, receipt.id, revision.fromAttempt, { allowMissing: Boolean(resuming && prior.lockOwner) });
      if (resuming && checkoutLock.owner && contractRevisionHash(checkoutLock.owner) !== contractRevisionHash(prior.lockOwner)) throw new Error('El bloqueo del checkout cambió.');
      receipt.status = 'retrying'; receipt.contractRevision = { ...revision, nativeProof, phase: resuming ? prior.phase : 'verified',
        lockOwner: revision.lockOwner || checkoutLock.owner, verifiedAt: now() };
      audit(state, 'contract_revision_verified', { jobId, receiptId: receipt.id, revisionId: revision.id, fromAttempt: revision.fromAttempt, toAttempt: revision.toAttempt });
      return { job, receiptId: receipt.id, revision: receipt.contractRevision };
    });
    if (candidate.done) return candidate.job;
    const { job, receiptId, revision } = candidate;
    const checkoutLock = await recoveryCheckoutLock(root, job, receiptId, revision.fromAttempt, { allowMissing: true });
    if (checkoutLock.owner) {
      if (contractRevisionHash(checkoutLock.owner) !== contractRevisionHash(revision.lockOwner)) throw new Error('El bloqueo cambió antes de liberar la rectificación.');
      await fs.unlink(checkoutLock.file);
    }
    await change(root, state => { const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.contractRevision?.id !== revision.id) throw new Error('La rectificación cambió.'); receipt.contractRevision.phase = 'lock_released'; });
    await releaseLock(queueLock); queueLock = null;
    const queued = await queueContractRevisionRetry(root, jobId, revision);
    return await change(root, state => {
      const receipt = state.receipts.find(item => item.id === receiptId);
      if (receipt.contractRevision?.id !== revision.id || contractRevisionHash(state.integrations[receiptId]) !== revision.integrationRecordHash) throw new Error('El recibo o validación original cambió.');
      receipt.contractRevision = { ...queued.contractRevision, phase: 'ready' };
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = queued.attempts; receipt.updatedAt = now();
      receipt.reason = 'Contrato de producto rectificado; QA y Revisión nuevas dentro del siguiente intento disponible.';
      audit(state, 'contract_revision_ready', { jobId, receiptId, revisionId: revision.id, fromAttempt: revision.fromAttempt, toAttempt: revision.toAttempt }); return queued;
    });
  } finally { if (queueLock) await releaseLock(queueLock); }
}

// Reopen only a reviewed, pre-dispatch auto-run failure. The immutable receipt
// remains the source of destination truth; uncertain or started stages stay blocked.
// Workflow V2 phase B: after the owner approves in V2, resume the same job so it reads that approval and
// integrates only the approved candidate. Unlike retryAutoReceipt, the workflow already has dispatches;
// what makes this safe is that no Orca stage is relaunched (QA is recovered, V2 is only read) and the
// integration resumes from its bound record.
export async function resumeWorkflowV2Receipt(root, jobId, { confirm = false } = {}) {
  if (!confirm) throw new Error('Confirma que aprobaste este candidato en Workflow V2 antes de reanudar.');
  const candidate = await change(root, async state => {
    const receipt = state.receipts.find(item => item.jobId === jobId);
    const job = (await loadState(root)).jobs.find(item => item.id === jobId);
    if (!receipt || receipt.status !== 'needs_attention' || !receipt.eligible || !job || job.autoIntent?.receiptId !== receipt.id
      || receipt.spec?.id !== job.id || receipt.spec?.workspace !== job.workspace || receipt.spec?.destination?.workspace !== job.workspace
      || receipt.spec?.destination?.branch !== job.branch || !workflowV2Resumable(job) || job.attempts >= job.maxAttempts) {
      throw new Error('Este trabajo no está esperando una aprobación de Workflow V2 ni su integración; revisa su estado.');
    }
    receipt.status = 'retrying'; receipt.updatedAt = now();
    audit(state, 'retrying', { receiptId: receipt.id, jobId, reason: 'Reanudación tras la decisión del owner en Workflow V2.' });
    return { receiptId: receipt.id, workspace: job.workspace };
  });
  try {
    const workspacesRoot = path.resolve(root, 'workspaces');
    const workspace = path.resolve(candidate.workspace);
    const relative = path.relative(workspacesRoot, workspace);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Checkout fuera de workspaces; no se libera ningún bloqueo.');
    const lockPath = path.join(workspace, '.git', 'centro-executor.lock');
    try {
      const lockOwner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lockOwner.jobId !== jobId || lockOwner.receiptId !== candidate.receiptId) throw new Error('Bloqueo del checkout pertenece a otro trabajo; requiere revisión.');
      await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const job = await retryJob(root, jobId, { confirm: true });
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (!receipt || receipt.status !== 'retrying') throw new Error('El recibo cambió durante la reanudación; requiere revisión.');
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      audit(state, 'retry_authorized', { receiptId: receipt.id, jobId, attempt: job.attempts, workflowV2: true });
    });
    return job;
  } catch (error) {
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (receipt?.status === 'retrying') { receipt.status = 'needs_attention'; receipt.updatedAt = now(); audit(state, 'retry_blocked', { receiptId: receipt.id, jobId, reason: error.message }); }
    });
    throw error;
  }
}

export async function retryAutoReceipt(root, jobId, { confirm = false, noDispatchConfirmed = false } = {}) {
  if (!confirm || !noDispatchConfirmed) throw new Error('Confirma que consultaste Orca: no existe Run/dispatch para este intento y no hay agentes activos.');
  const candidate = await change(root, async state => {
    const receipt = state.receipts.find(item => item.jobId === jobId);
    const job = (await loadState(root)).jobs.find(item => item.id === jobId);
    const untouched = job?.workflow?.status === 'queued' && job.workflow.currentStage == null
      && job.workflow.steps?.every(step => step.status === 'queued' && !step.runId && !step.taskId && !step.dispatchId)
      && !job.result && job.attempts < job.maxAttempts;
    if (!receipt || receipt.status !== 'needs_attention' || !receipt.eligible
      || !job || job.state !== 'needs_attention' || job.autoIntent?.receiptId !== receipt.id
      || receipt.spec?.id !== job.id || receipt.spec?.workspace !== job.workspace
      || receipt.spec?.destination?.workspace !== job.workspace || receipt.spec?.destination?.branch !== job.branch || !untouched) {
      throw new Error('Este intento no es un fallo previo al dispatch verificable; consulta Orca y conserva el estado para revisión.');
    }
    receipt.status = 'retrying'; receipt.updatedAt = now();
    audit(state, 'retrying', { receiptId: receipt.id, jobId, reason: 'Reintento confirmado: workflow sin dispatch ni resultado.' });
    return { receiptId: receipt.id, workspace: job.workspace };
  });
  try {
    const workspacesRoot = path.resolve(root, 'workspaces');
    const workspace = path.resolve(candidate.workspace);
    const relative = path.relative(workspacesRoot, workspace);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Checkout fuera de workspaces; no se libera ningún bloqueo.');
    const lockPath = path.join(workspace, '.git', 'centro-executor.lock');
    try {
      const lockOwner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lockOwner.jobId !== jobId || lockOwner.receiptId !== candidate.receiptId) throw new Error('Bloqueo del checkout pertenece a otro trabajo; requiere revisión.');
      await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const job = await retryJob(root, jobId, { confirm: true });
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (!receipt || receipt.status !== 'retrying') throw new Error('El recibo cambió durante el reintento; requiere revisión.');
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      audit(state, 'retry_authorized', { receiptId: receipt.id, jobId, attempt: job.attempts });
    });
    return job;
  } catch (error) {
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (receipt?.status === 'retrying') { receipt.status = 'needs_attention'; receipt.updatedAt = now(); audit(state, 'retry_blocked', { receiptId: receipt.id, jobId, reason: error.message }); }
    });
    throw error;
  }
}
