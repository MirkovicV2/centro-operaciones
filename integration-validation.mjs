import path from 'node:path';
import { fingerprint } from './workflow-contract.mjs';

const hash = value => /^[a-f0-9]{64}$/i.test(value || '');
const fail = message => { throw Object.assign(new Error(message), { code: 'github_validation_checkpoint', uncertain: true }); };
function binding(job, runId, developer) {
  return { jobId: job.id, receiptId: job.autoIntent.receiptId, attempt: job.attempts, runId,
    workspace: path.resolve(job.workspace), branch: job.branch,
    developerTaskId: developer.taskId, developerDispatchId: developer.dispatchId,
    developerArtifactSha256: developer.artifact?.sha256 ?? null,
    cycleId: job.validationCycle || `attempt-${job.attempts}` };
}

// Capture BEFORE validation, durably. A restart may compare this checkpoint but
// must never replace it with the files that happen to be present afterwards.
export async function prepareIntegrationValidation(job, { runId, developer, previous, captureSnapshot, persist }) {
  if (previous?.commitSha) return { record: previous, snapshot: previous.manifest, committed: true };
  if (previous?.phase && !['validation_pending', 'validation_approved'].includes(previous.phase)) {
    fail('La integración ya registró una operación; conserva su fase y revisa sus efectos antes de continuar.');
  }
  const expected = binding(job, runId, developer);
  const current = await captureSnapshot(job.workspace);
  if (!hash(current)) fail('La huella de archivos no tiene un formato verificable.');
  if (previous?.validation) {
    const saved = previous.validation;
    if (!hash(saved.snapshot)) fail('La validación guardada pertenece a otro encargo, ciclo o implementación.');
    if (saved.snapshot !== current) fail('Los archivos cambiaron desde el inicio de QA; las aprobaciones anteriores no cubren esos cambios.');
    if (Object.entries(expected).some(([key, value]) => saved[key] !== value)) {
      // A reviewed scope correction may spend the next configured attempt. It
      // carries the original pre-QA snapshot forward; it never samples a new
      // baseline or converts the earlier blocked delivery into an approval.
      const revision = job.contractRevision;
      const originalBinding = { ...expected, attempt: revision?.fromAttempt, cycleId: `attempt-${revision?.fromAttempt}` };
      if (revision?.phase !== 'consumed' || !hash(revision.id)
        || revision.jobId !== job.id || revision.receiptId !== job.autoIntent.receiptId
        || revision.toAttempt !== job.attempts || revision.toAttempt !== revision.fromAttempt + 1
        || job.validationCycle || revision.contractHash !== fingerprint(job.contract)
        || revision.previousValidationHash !== fingerprint(saved) || revision.integrationRecordHash !== fingerprint(previous)
        || revision.snapshot !== saved.snapshot || previous.phase !== 'validation_pending'
        || previous.commitSha || previous.manifest || previous.prNumber || previous.prUrl || previous.mergeSha || saved.approvals
        || Object.entries(originalBinding).some(([key, value]) => saved[key] !== value)) {
        fail('La validación guardada pertenece a otro encargo, ciclo o implementación.');
      }
      const record = { ...previous, status: 'validating', needsAttention: false, error: null,
        contractRevisionId: revision.id,
        validationHistory: [...(previous.validationHistory || []), { revisionId: revision.id, validation: structuredClone(saved) }],
        validation: { ...saved, ...expected, contractRevisionId: revision.id, revisedAt: new Date().toISOString() } };
      await persist(record);
      return { record, snapshot: saved.snapshot };
    }
    const record = { ...previous, status: 'validating', needsAttention: false, error: null };
    await persist(record);
    return { record, snapshot: saved.snapshot };
  }
  const oldValidation = job.workflow?.steps?.some(step => ['qa', 'reviewer'].includes(step.key)
    && (step.status === 'succeeded' || step.taskId || step.dispatchId));
  const marker = job.livenessResume;
  const qa = job.workflow?.steps?.find(step => step.key === 'qa');
  const originalQa = marker?.originalSteps?.find(step => step.stage === 'qa');
  const keepQa = marker?.mode === 'same_attempt_integration_validation' && marker.stage === 'reviewer'
    && marker.qualityAction?.type === 'answer' && originalQa && qa?.status === 'succeeded' && qa.taskId === originalQa.taskId
    && qa.dispatchId === originalQa.dispatchId && qa.artifact?.sha256 === originalQa.artifactSha256;
  if (oldValidation && !keepQa) fail('Falta la huella duradera anterior a QA; se necesita una nueva validación de los archivos.');
  if (job.validationCycle || previous?.status === 'needs_attention' || previous?.validationCandidateSnapshot) {
    const correction = job.livenessRecoveryHistory?.find(item => item.id === job.validationCycle && item.qualityAction?.type === 'correction');
    const checkpoint = correction ?? marker;
    if (checkpoint?.mode !== 'same_attempt_integration_validation' || (!correction && checkpoint.phase !== 'consumed')
      || checkpoint.id !== job.validationCycle || checkpoint.jobId !== job.id || checkpoint.receiptId !== job.autoIntent.receiptId
      || checkpoint.attempt !== job.attempts || (!correction && checkpoint.integrationValidation?.candidateSnapshot !== current)
      || previous?.integrationRecoveryId !== checkpoint.id || previous?.validationCandidateSnapshot !== checkpoint.integrationValidation?.candidateSnapshot
      || (correction && developer.taskId === checkpoint.originalSteps.find(item => item.stage === 'developer')?.taskId)) {
      fail('La nueva validación no coincide con la recuperación y los archivos verificados.');
    }
  }
  const record = { ...previous, jobId: job.id, receiptId: job.autoIntent.receiptId,
    repository: job.destination.repository, sourceBranch: job.branch, baseBranch: job.destination.baseBranch,
    phase: 'validation_pending', status: 'validating', needsAttention: false, error: null,
    validation: { version: 1, ...expected, snapshot: current, capturedAt: new Date().toISOString() } };
  await persist(record);
  return { record, snapshot: current };
}

export async function sealIntegrationValidation(job, checkpoint, { qa, review, captureSnapshot, persist }) {
  if (checkpoint.committed) return checkpoint.record;
  if (!['validation_pending', 'validation_approved'].includes(checkpoint.record?.phase)) fail('La fase de integración no permite renovar una validación.');
  if (await captureSnapshot(job.workspace) !== checkpoint.snapshot) fail('Los archivos cambiaron durante QA o revisión; no se puede integrar esa aprobación.');
  const approvals = Object.fromEntries([['qa', qa], ['reviewer', review]].map(([stage, result]) => [stage, {
    taskId: result.taskId, dispatchId: result.dispatchId, artifactSha256: result.artifact?.sha256 ?? null,
  }]));
  const prior = checkpoint.record.validation.approvals;
  if (prior && JSON.stringify(prior) !== JSON.stringify(approvals)) fail('Las aprobaciones cambiaron respecto a la validación guardada.');
  const record = { ...checkpoint.record, phase: 'validation_approved', status: 'validated',
    validation: { ...checkpoint.record.validation, approvals, approvedAt: checkpoint.record.validation.approvedAt || new Date().toISOString() } };
  await persist(record);
  return record;
}
