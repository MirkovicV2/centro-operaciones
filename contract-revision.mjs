import { createHash } from 'node:crypto';
import { sameRepository } from './project-destination.mjs';
import { IDENTIFIERS, normalizeJobContract, validateDelivery } from './workflow-contract.mjs';

export const contractRevisionHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw Object.assign(new Error(message), { code: 'contract_revision_invalid' }); };
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
const canonical = value => String(value).trim().replace(/\s+/g, ' ');

export function revisedProductContract(job, productAcceptance) {
  if (!Array.isArray(productAcceptance) || !productAcceptance.length || productAcceptance.length > 50
    || !productAcceptance.every(value => typeof value === 'string' && value.trim() && value.length <= 2000)
    || new Set(productAcceptance.map(canonical)).size !== productAcceptance.length) fail('Indica criterios de producto explícitos, completos y sin duplicados.');
  const contract = normalizeJobContract({ ...job, contract: { ...job.contract, acceptanceScope: 'product',
    acceptance: productAcceptance.map(value => value.trim()), productAcceptance: productAcceptance.map(value => value.trim()),
    endToEndCriteria: job.contract.endToEndCriteria || job.contract.acceptance } });
  if (contract.acceptanceScope !== 'product' || contractRevisionHash(contract.acceptance) !== contractRevisionHash(productAcceptance.map(value => value.trim()))
    || !Array.isArray(contract.endToEndCriteria) || !contract.endToEndCriteria.length) fail('La nueva norma debe conservar las condiciones globales y limitar aceptación al producto.');
  return contract;
}

export function contractRevisionSteps(job) {
  if (job?.kind !== 'code' || job.workflow?.currentStage !== 'qa' || job.state !== 'needs_attention' || job.error?.code !== 'delivery_incomplete'
    || job.contract?.acceptanceScope === 'product' || job.contractRevision || job.reservedUsd !== 0 || job.attempts >= job.maxAttempts) fail('Solo se rectifica el contrato global de una QA bloqueada con otro intento disponible.');
  const steps = ['ux', 'developer', 'qa'].map(stage => {
    const step = job.workflow.steps.find(item => item.key === stage);
    if (!step || step.runId !== job.workflow.runId || !IDENTIFIERS.runId.test(step.runId || '') || !IDENTIFIERS.taskId.test(step.taskId || '')
      || !IDENTIFIERS.dispatchId.test(step.dispatchId || '') || !Number.isInteger(step.taskInputAttempt) || step.taskInputAttempt < 1 || !hash(step.artifact?.sha256)
      || stage !== 'qa' && step.status !== 'succeeded') fail('Falta identidad o evidencia íntegra de UX, Desarrollo o QA.');
    validateDelivery(step.delivery, { jobId: job.id, jobAttempt: step.taskInputAttempt, stage, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId,
      acceptance: job.contract.acceptance });
    if (stage === 'qa' && (step.status !== 'blocked' || step.dispatchSettled !== true || !['completed', 'failed'].includes(step.dispatchStatus)
      || step.delivery.outcome !== 'blocked' || step.delivery.scope !== 'partial' || step.delivery.approval !== 'blocked'
      || step.delivery.acceptance.some(item => item.status === 'failed') || step.delivery.questions.some(item => item.required))) fail('QA no acredita un bloqueo contractual sin fallos de producto ni decisiones pendientes.');
    return { stage, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId, taskInputAttempt: step.taskInputAttempt, artifactSha256: step.artifact.sha256 };
  });
  if (['reviewer', 'integration'].some(key => { const step = job.workflow.steps.find(item => item.key === key); return !step || step.status !== 'queued' || step.taskId || step.dispatchId || step.artifact || step.delivery; })) {
    fail('La revisión o integración ya comenzaron; no se puede rectificar este contrato.');
  }
  return steps;
}

export function assertContractRevisionRecord(job, record) {
  const steps = contractRevisionSteps(job), developer = steps.find(item => item.stage === 'developer'), validation = record?.validation;
  if (!record || record.phase !== 'validation_pending' || record.status !== 'validating' || record.jobId !== job.id || record.receiptId !== job.autoIntent?.receiptId
    || !sameRepository(record.repository, job.destination?.repository) || record.sourceBranch !== job.branch || record.baseBranch !== job.destination?.baseBranch
    || ['manifest', 'commitSha', 'prNumber', 'prUrl', 'mergeSha', 'pushedAt', 'mergedAt'].some(key => record[key] !== undefined)
    || !validation || !hash(validation.snapshot) || validation.jobId !== job.id || validation.receiptId !== record.receiptId || validation.attempt !== job.attempts
    || validation.runId !== job.workflow.runId || validation.workspace !== job.workspace || validation.branch !== job.branch
    || validation.cycleId !== (job.validationCycle || `attempt-${job.attempts}`) || validation.approvals || validation.approvedAt
    || validation.developerTaskId !== developer.taskId || validation.developerDispatchId !== developer.dispatchId || validation.developerArtifactSha256 !== developer.artifactSha256) {
    fail('La validación previa a QA cambió o ya contiene efectos y aprobaciones posteriores.');
  }
  return steps;
}

export function createContractRevision(job, record, productAcceptance, reason) {
  const originalSteps = assertContractRevisionRecord(job, record), contract = revisedProductContract(job, productAcceptance);
  reason = String(reason || '').trim();
  if (reason.length < 10 || reason.length > 2000) fail('Documenta la rectificación revisada del contrato.');
  const qa = job.workflow.steps.find(item => item.key === 'qa');
  if (contract.acceptance.some(criterion => !qa.delivery.acceptance.some(item => canonical(item.criterion) === canonical(criterion) && item.status === 'passed' && item.evidence.trim()))) {
    fail('Un criterio nuevo no está acreditado como producto comprobado en el informe original; revisa su alcance.');
  }
  const revision = { kind: 'product_acceptance_revision', jobId: job.id, receiptId: job.autoIntent.receiptId, runId: job.workflow.runId,
    fromAttempt: job.attempts, toAttempt: job.attempts + 1, maxAttempts: job.maxAttempts, timeoutMs: job.timeoutMs,
    previousContractHash: contractRevisionHash(job.contract), contractHash: contractRevisionHash(contract), previousValidationHash: contractRevisionHash(record.validation),
    originalWorkflowHash: contractRevisionHash(job.workflow), integrationRecordHash: contractRevisionHash(record), snapshot: record.validation.snapshot,
    originalSteps, reason, previousContract: structuredClone(job.contract), contract, originalValidation: structuredClone(record.validation),
    originalIntegrationRecord: structuredClone(record), originalWorkflow: structuredClone(job.workflow), destination: structuredClone(job.destination) };
  return { id: contractRevisionHash(revision), ...revision };
}

export function originalContractRevisionJob(job, revision) {
  return { ...job, state: 'needs_attention', error: { code: 'delivery_incomplete' }, attempts: revision.fromAttempt,
    contract: revision.previousContract, workflow: revision.originalWorkflow, contractRevision: undefined };
}

export function assertContractRevisionCheckpoint(job, revision, { queued = job.state === 'queued' } = {}) {
  const original = originalContractRevisionJob(job, revision);
  const expected = createContractRevision(original, revision.originalIntegrationRecord, revision.contract.acceptance, revision.reason);
  if (expected.id !== revision.id || job.id !== revision.jobId || job.autoIntent?.receiptId !== revision.receiptId || job.attempts !== revision.fromAttempt
    || job.maxAttempts !== revision.maxAttempts || job.timeoutMs !== revision.timeoutMs || job.reservedUsd !== 0
    || contractRevisionHash(job.destination) !== contractRevisionHash(revision.destination)
    || contractRevisionHash(job.contract) !== (queued ? revision.contractHash : revision.previousContractHash)
    || contractRevisionHash(job.workflow) !== (queued ? revision.queuedWorkflowHash : revision.originalWorkflowHash)) fail('El contrato, flujo, destino o límites cambiaron durante la rectificación.');
  if (queued && (job.contractRevision?.id !== revision.id || job.workflow.currentStage !== 'qa'
    || ['qa', 'reviewer', 'integration'].some(key => { const step = job.workflow.steps.find(item => item.key === key);
      return !step || step.status !== 'queued' || step.taskId || step.dispatchId || step.delivery || step.artifact; }))) fail('El nuevo intento no conserva las etapas pendientes de validación.');
  return original;
}

export function assertContractRevisionProof(revision, observed) {
  const proof = observed?.contractRevision;
  if (observed?.runId !== revision.runId || observed.liveness !== 'exited' || observed.state !== 'settled'
    || !proof || ['snapshot', 'previousContractHash', 'previousValidationHash', 'originalWorkflowHash', 'integrationRecordHash'].some(key => proof[key] !== revision[key])
    || contractRevisionHash(proof.originalSteps) !== contractRevisionHash(revision.originalSteps)) fail('La observación nativa y los archivos no confirman la rectificación exacta.');
  return structuredClone(proof);
}
