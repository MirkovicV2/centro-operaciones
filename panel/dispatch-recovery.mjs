import path from 'node:path';
import { loadState } from './queue.mjs';
import { recoverKnownDispatchReceipt, readIntegration, retryCheckoutAdmission, reviseJobAcceptanceReceipt } from '../auto-run.mjs';
import { normalizeWorkerStatus, checkWorkerIdentity, readStageReport, verifyDispatchSpec } from '../orca-evidence.mjs';
import { coordinatorCommand, verifyCoordinatorBinding } from './coordinator-bridge.mjs';
import { verifyUnicodeDeliveryTransport } from '../orca-delivery-transport.mjs';
import { isPartialStageResume, recoveryFingerprint, integrationValidationSteps, assertCommittedIntegrationRecord } from '../queue.mjs';
import { captureIntegrationSnapshot } from '../github-integration.mjs';
import { inspectCommittedIntegration } from '../integration-recovery.mjs';
import { assertContractRevisionCheckpoint, assertContractRevisionRecord, contractRevisionHash } from '../contract-revision.mjs';
import { fingerprint, parseDelivery } from '../workflow-contract.mjs';

export function retryCoordinatedCheckout(root, receiptId, { confirm = false, command = coordinatorCommand, inspectIntegrationEffects } = {}) {
  return retryCheckoutAdmission(root, receiptId, {
    confirm, ...(inspectIntegrationEffects ? { inspectIntegrationEffects } : {}),
    inspectWorker: async (cwd, workspace, step) => {
      if (!step.runId || !step.taskId) throw new Error('Faltan los identificadores del trabajador anterior.');
      const shown = await command(['orchestration', 'worker-show', '--dispatch', step.dispatchId, '--full'], { cwd });
      const worker = normalizeWorkerStatus(shown);
      checkWorkerIdentity(worker, step, { strict: true });
      if (worker.liveness !== 'exited' || !worker.workspace
        || path.resolve(worker.workspace).toLowerCase() !== workspace.toLowerCase()
        || shown.terminalResource?.ownershipState !== 'released'
        || shown.terminalResource?.ownerDispatchId !== step.dispatchId) {
        throw new Error('Orca no acredita la salida y liberación del trabajador anterior en este checkout.');
      }
    },
  });
}

// An operator resumes observation of the exact durable assignment. This API
// neither supplies a replacement Task nor accepts caller-provided evidence.
export async function inspectRecoveryDispatch(root, job, expected, { command = coordinatorCommand, captureSnapshot = captureIntegrationSnapshot, inspectIntegration = inspectCommittedIntegration } = {}) {
  const binding = job.coordination;
  const step = job.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  if (expected.mode === 'product_acceptance_revision') {
    if (!binding || expected.jobId !== job.id || expected.receiptId !== job.autoIntent?.receiptId || expected.runId !== binding.runId
      || expected.fromAttempt !== job.attempts || expected.toAttempt !== expected.fromAttempt + 1) throw new Error('La rectificación no pertenece al encargo y coordinador originales.');
    const original = assertContractRevisionCheckpoint(job, expected), record = await readIntegration(root, expected.receiptId);
    const identities = assertContractRevisionRecord(original, record);
    if (contractRevisionHash(record) !== expected.integrationRecordHash || contractRevisionHash(identities) !== contractRevisionHash(expected.originalSteps)) throw new Error('La evidencia original de la rectificación cambió.');
    const owner = await verifyCoordinatorBinding(binding, { cwd: root, command });
    if (!owner.ok) throw new Error(owner.reason);
    for (const identity of identities) {
      const stage = original.workflow.steps.find(item => item.key === identity.stage);
      const report = await readStageReport(root, stage.artifact, { jobId: job.id, jobAttempt: identity.taskInputAttempt, stage: identity.stage,
        runId: identity.runId, taskId: identity.taskId, dispatchId: identity.dispatchId });
      if (contractRevisionHash(report.delivery) !== contractRevisionHash(stage.delivery)) throw new Error('El informe nativo no coincide con la entrega original.');
      const worker = normalizeWorkerStatus(await command(['orchestration', 'worker-show', '--dispatch', identity.dispatchId, '--full'], { cwd: root }));
      checkWorkerIdentity(worker, identity, { strict: true });
      const location = worker.workspace || worker.worktreeId?.split('::').slice(1).join('::');
      const workspace = location?.includes('::') ? location.split('::').slice(1).join('::') : location;
      if (!(identity.stage === 'qa' ? ['succeeded', 'failed'].includes(worker.state) : worker.state === 'succeeded') || worker.liveness !== 'exited'
        || !workspace || path.resolve(workspace).toLowerCase() !== path.resolve(job.workspace).toLowerCase()) throw new Error('Falta cierre nativo confirmado del trabajador original en su checkout.');
    }
    const snapshot = await captureSnapshot(job.workspace);
    if (snapshot !== expected.snapshot) throw new Error('Los archivos cambiaron desde el snapshot original de QA.');
    return { state: 'settled', liveness: 'exited', runId: expected.runId, contractRevision: {
      snapshot, previousContractHash: expected.previousContractHash, previousValidationHash: expected.previousValidationHash,
      originalWorkflowHash: expected.originalWorkflowHash, integrationRecordHash: expected.integrationRecordHash, originalSteps: identities,
    } };
  }
  if (expected.mode === 'same_attempt_integration_reconcile') {
    if (!binding || expected.jobId !== job.id || expected.receiptId !== job.autoIntent?.receiptId || expected.runId !== binding.runId
      || expected.runId !== job.workflow?.runId || expected.attempt !== job.attempts || recoveryFingerprint(job.workflow) !== expected.checkpointHash) {
      throw new Error('La continuación de integración no pertenece al encargo original.');
    }
    const record = await readIntegration(root, expected.receiptId), original = assertCommittedIntegrationRecord(job, record);
    if (recoveryFingerprint(record) !== expected.integrationRecordHash || recoveryFingerprint(original) !== recoveryFingerprint(expected.originalSteps)) {
      throw new Error('El registro o aprobaciones de integración cambiaron.');
    }
    const owner = await verifyCoordinatorBinding(binding, { cwd: root, command });
    if (!owner.ok) throw new Error(owner.reason);
    for (const identity of original) {
      const stage = job.workflow.steps.find(item => item.key === identity.stage);
      const report = await readStageReport(root, stage.artifact, { jobId: job.id, jobAttempt: identity.taskInputAttempt, stage: identity.stage,
        runId: identity.runId, taskId: identity.taskId, dispatchId: identity.dispatchId });
      if (recoveryFingerprint(report.delivery) !== recoveryFingerprint(stage.delivery)) throw new Error('El informe aprobado no coincide con la entrega guardada.');
      const worker = normalizeWorkerStatus(await command(['orchestration', 'worker-show', '--dispatch', identity.dispatchId, '--full'], { cwd: root }));
      checkWorkerIdentity(worker, identity, { strict: true });
      const location = worker.workspace || worker.worktreeId?.split('::').slice(1).join('::');
      const workspace = location?.includes('::') ? location.split('::').slice(1).join('::') : location;
      if (worker.state !== 'succeeded' || worker.liveness !== 'exited' || !workspace || path.resolve(workspace).toLowerCase() !== path.resolve(job.workspace).toLowerCase()) {
        throw new Error('Una etapa aprobada no acredita cierre y checkout exactos.');
      }
    }
    return { state: 'succeeded', liveness: 'exited', runId: expected.runId, integrationProof: await inspectIntegration(root, job, record) };
  }
  if (expected.mode === 'same_attempt_integration_validation') {
    if (!binding || expected.jobId !== job.id || expected.receiptId !== job.autoIntent?.receiptId || expected.runId !== binding.runId
      || expected.runId !== job.workflow?.runId || expected.attempt !== job.attempts) throw new Error('La nueva validación no pertenece al encargo y coordinador originales.');
    const original = recoveryFingerprint(job.workflow) === expected.originalWorkflowHash ? integrationValidationSteps(job, expected.stage, expected.qualityAction)
      : job.livenessResume?.mode === expected.mode && job.livenessResume.originalWorkflowHash === expected.originalWorkflowHash ? job.livenessResume.originalSteps : null;
    if (!original || recoveryFingerprint(original) !== recoveryFingerprint(expected.originalSteps)) throw new Error('Las etapas originales cambiaron antes de verificar su cierre.');
    const owner = await verifyCoordinatorBinding(binding, { cwd: root, command });
    if (!owner.ok) throw new Error(owner.reason);
    const originalWorkflow = recoveryFingerprint(job.workflow) === expected.originalWorkflowHash ? job.workflow : job.workflowHistory?.at(-1);
    for (const identity of original) {
      if (expected.stage !== 'integration') {
        const saved = originalWorkflow?.steps?.find(item => item.key === identity.stage);
        const report = await readStageReport(root, saved?.artifact, { ...identity, jobId: job.id, jobAttempt: identity.taskInputAttempt });
        if (recoveryFingerprint(report.delivery) !== recoveryFingerprint(saved.delivery)) throw new Error('El informe original de calidad no coincide con el registro.');
      }
      const shown = await command(['orchestration', 'worker-show', '--dispatch', identity.dispatchId, '--full'], { cwd: root });
      const worker = normalizeWorkerStatus(shown); checkWorkerIdentity(worker, identity, { strict: true });
      const location = worker.workspace || worker.worktreeId?.split('::').slice(1).join('::');
      const workspace = location?.includes('::') ? location.split('::').slice(1).join('::') : location;
      if (worker.state !== (identity.workerState || 'succeeded') || worker.liveness !== 'exited' || !workspace || path.resolve(workspace).toLowerCase() !== path.resolve(job.workspace).toLowerCase()) {
        throw new Error('Una etapa original no acredita cierre y checkout exactos; no se inicia otra validación.');
      }
    }
    return { state: 'succeeded', liveness: 'exited', runId: expected.runId, integrationValidation: {
      candidateSnapshot: await captureSnapshot(job.workspace), originalWorkflowHash: expected.originalWorkflowHash,
      integrationRecordHash: expected.integrationRecordHash, originalSteps: structuredClone(original),
    } };
  }
  if (!binding || expected.jobId !== job.id || expected.runId !== binding.runId
    || expected.runId !== job.workflow.runId || expected.stage !== step?.key
    || expected.taskId !== step.taskId || expected.dispatchId !== step.dispatchId) {
    throw new Error('La recuperación no corresponde al coordinador y al trabajador guardados.');
  }
  const owner = await verifyCoordinatorBinding(binding, { cwd: root, command });
  if (!owner.ok) throw new Error(owner.reason);
  const shown = await command(['orchestration', 'worker-show', '--dispatch', expected.dispatchId, '--full'], { cwd: root });
  const worker = normalizeWorkerStatus(shown);
  checkWorkerIdentity(worker, expected, { strict: true });
  const observed = worker.workspace || worker.worktreeId?.split('::').slice(1).join('::');
  const workspace = observed?.includes('::') ? observed.split('::').slice(1).join('::') : observed;
  if (!workspace || path.resolve(workspace).toLowerCase() !== path.resolve(job.workspace || path.join(root, 'analysis')).toLowerCase()) {
    throw new Error('ORCA no acredita el checkout exacto del trabajador guardado.');
  }
  if (isPartialStageResume(expected.mode)) {
    if (worker.state !== (step.dispatchStatus === 'failed' ? 'failed' : 'succeeded') || worker.liveness !== 'exited') throw new Error('Falta el cierre nativo de la etapa parcial.');
    for (const saved of job.workflow.steps.slice(0, job.workflow.steps.indexOf(step) + 1)) {
      const report = await readStageReport(root, saved.artifact, { jobId: job.id, jobAttempt: saved.taskInputAttempt, stage: saved.key,
        runId: saved.runId, taskId: saved.taskId, dispatchId: saved.dispatchId });
      if (fingerprint(report.delivery) !== fingerprint(saved.delivery)) throw new Error('El informe del traspaso cambió.');
    }
    return { ...worker, partialResumeVerified: true };
  }
  if (worker.state === 'stopped' && step.key === 'developer' && job.error?.code === 'timeout') {
    if (worker.exitEvidence !== 'native_exact_observation') throw new Error('Falta el cierre exacto del desarrollador.');
    await verifyDispatchSpec(root, step.specArtifact);
    const listed = await command(['orchestration', 'worker-list', '--run', expected.runId, '--include-remote'], { cwd: root });
    if (!Array.isArray(listed.workers) || !listed.workers.some(item => item.dispatchId === expected.dispatchId && item.taskId === expected.taskId)
      || listed.workers.some(item => item.taskId === expected.taskId && item.liveness !== 'exited')) {
      throw new Error('La Task conserva un trabajador cuyo cierre no se ha confirmado.');
    }
  }
  if (step.error === 'delivery_invalid' && ['qa', 'reviewer'].includes(step.key) && step.dispatchSettled === true && step.artifact) {
    if (worker.state !== 'succeeded' || worker.liveness !== 'exited') throw new Error('Falta el cierre confirmado del trabajador de calidad.');
    const identity = { jobId: job.id, jobAttempt: step.taskInputAttempt, stage: step.key, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId };
    const original = await readStageReport(root, step.artifact, identity);
    const delivery = parseDelivery(original.text, { ...identity, acceptance: job.contract.acceptance }, { required: true, preserveExplicitBlock: true });
    if (original.delivery !== null || delivery.outcome !== 'blocked' || delivery.approval !== 'blocked') throw new Error('El informe original no acredita un rechazo explícito.');
    return { ...worker, explicitBlockedReport: true };
  }
  if (step.error === 'delivery_acceptance_missing' && ['qa', 'reviewer'].includes(step.key)) {
    const repaired = await verifyUnicodeDeliveryTransport(root, job, step, { command: args => command(args, { cwd: root }) });
    return { ...worker, deliveryTransport: repaired.proof };
  }
  if (step.key === 'ux' && step.error === 'delivery_invalid' && job.contract?.acceptanceScope === 'product') {
    if (worker.state !== 'succeeded' || worker.liveness !== 'exited') throw new Error('Falta el cierre confirmado del mismo trabajador de UX.');
    const identity = { jobId: job.id, jobAttempt: step.taskInputAttempt, stage: 'ux', runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId };
    const original = await readStageReport(root, step.artifact, identity);
    const delivery = parseDelivery(original.text, { ...identity, acceptance: job.contract.acceptance }, { required: true, requireUxAcceptanceArray: true });
    if (original.delivery !== null || delivery.outcome !== 'completed' || delivery.scope !== 'complete') throw new Error('El informe original no acredita una entrega UX completa.');
    return { ...worker, deliveryTransport: { kind: 'ux_product_acceptance_array', ...identity, originalArtifactSha256: step.artifact.sha256,
      reportSha256: fingerprint(original.text), deliverySha256: fingerprint(delivery) } };
  }
  return worker;
}

export async function resumeCoordinatedDispatch(root, jobId, { confirm = false, command = coordinatorCommand, inspectIntegrationEffects, qualityAction, uxHandoff, developerDecision, stageDecision } = {}) {
  if (!confirm) throw new Error('Confirma la revisión del trabajador antes de continuar.');
  const job = (await loadState(root)).jobs.find(item => item.id === jobId);
  if (!job) throw new Error('No encuentro el encargo que se quiere continuar.');
  return recoverKnownDispatchReceipt(root, jobId, {
    confirm, qualityAction, uxHandoff, developerDecision, stageDecision, ...(inspectIntegrationEffects ? { inspectIntegrationEffects } : {}),
    inspectDispatch: expected => inspectRecoveryDispatch(root, job, expected, { command }),
  });
}

export async function reviseCoordinatedJobAcceptance(root, jobId, { confirm = false, productAcceptance, reason, command = coordinatorCommand,
  captureSnapshot = captureIntegrationSnapshot, verify } = {}) {
  return reviseJobAcceptanceReceipt(root, jobId, { confirm, productAcceptance, reason, ...(verify ? { verify } : {}),
    inspectDispatch: async expected => {
      const job = (await loadState(root)).jobs.find(item => item.id === jobId);
      if (!job) throw new Error('No encuentro el encargo que se quiere rectificar.');
      return inspectRecoveryDispatch(root, job, expected, { command, captureSnapshot });
    } });
}
