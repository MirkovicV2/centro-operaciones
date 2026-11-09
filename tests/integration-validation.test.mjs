import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareIntegrationValidation, sealIntegrationValidation } from '../integration-validation.mjs';
import { fingerprint } from '../workflow-contract.mjs';
const snapshot = 'a'.repeat(64), cycle = 'c'.repeat(64);
const job = { id: 'validation-job', attempts: 2, workspace: process.cwd(), branch: 'work/test', autoIntent: { receiptId: 'receipt-test' }, destination: { repository: 'owner/repo', baseBranch: 'main' } };
const developer = { taskId: 'task_developer', dispatchId: 'ctx_developer', artifact: { sha256: 'd'.repeat(64) } };
function options(previous = null) {
  const saved = [];
  return { runId: 'run_validation', developer, previous, captureSnapshot: async () => snapshot, persist: async record => saved.push(structuredClone(record)), saved };
}
test('snapshot is durable before QA and original snapshot is retained across recovery', async () => {
  const opt = options(), prepared = await prepareIntegrationValidation(job, opt);
  assert.equal(opt.saved.length, 1); assert.equal(opt.saved[0].validation.snapshot, snapshot);
  const resumed = options(prepared.record);
  const next = await prepareIntegrationValidation({ ...job, workflow: { steps: [{ key: 'qa', status: 'succeeded', taskId: 'task_qa' }] } }, resumed);
  assert.equal(next.snapshot, snapshot); assert.equal(next.record.validation.capturedAt, prepared.record.validation.capturedAt);
  await assert.rejects(prepareIntegrationValidation(job, { ...resumed, captureSnapshot: async () => 'b'.repeat(64) }), /cambiaron/);
  await assert.rejects(prepareIntegrationValidation({ ...job, branch: 'other' }, resumed), /otro encargo/);
});
test('legacy completed QA without snapshot cannot silently receive a fresh approval baseline', async () => {
  for (const step of [{ key: 'qa', status: 'succeeded' }, { key: 'qa', status: 'blocked', dispatchId: 'ctx_oldqa' }, { key: 'reviewer', status: 'succeeded' }]) {
    const opt = options();
    await assert.rejects(prepareIntegrationValidation({ ...job, workflow: { steps: [step] } }, opt), /Falta la huella/);
    assert.equal(opt.saved.length, 0);
  }
});
test('new validation cycle is bound to the admitted receipt, candidate and reset stages', async () => {
  const resumed = { ...job, validationCycle: cycle, livenessResume: { id: cycle, mode: 'same_attempt_integration_validation', phase: 'consumed', jobId: job.id,
    receiptId: job.autoIntent.receiptId, attempt: 2, integrationValidation: { candidateSnapshot: snapshot } } };
  const opt = options({ phase: 'validation_pending', status: 'validation_pending', integrationRecoveryId: cycle, validationCandidateSnapshot: snapshot });
  const result = await prepareIntegrationValidation(resumed, opt);
  assert.equal(result.record.validation.cycleId, cycle);
  for (const patch of [{ phase: 'ready' }, { id: 'f'.repeat(64) }, { attempt: 1 }, { integrationValidation: { candidateSnapshot: 'e'.repeat(64) } }]) {
    await assert.rejects(prepareIntegrationValidation({ ...resumed, livenessResume: { ...resumed.livenessResume, ...patch } }, opt), /recuperación/);
  }
});
test('approval is sealed only for unchanged files and exact stage artifacts', async () => {
  const opt = options(), checkpoint = await prepareIntegrationValidation(job, opt);
  const qa = { taskId: 'task_qa', dispatchId: 'ctx_qa', artifact: { sha256: '1'.repeat(64) } };
  const review = { taskId: 'task_review', dispatchId: 'ctx_review', artifact: { sha256: '2'.repeat(64) } };
  const sealed = await sealIntegrationValidation(job, checkpoint, { ...opt, qa, review });
  assert.equal(sealed.phase, 'validation_approved'); assert.equal(sealed.validation.approvals.qa.artifactSha256, qa.artifact.sha256);
  await assert.rejects(sealIntegrationValidation(job, checkpoint, { ...opt, qa, review, captureSnapshot: async () => 'b'.repeat(64) }), /cambiaron/);
  await assert.rejects(sealIntegrationValidation(job, { ...checkpoint, record: sealed }, { ...opt, qa, review: { ...review, dispatchId: 'ctx_changed' } }), /aprobaciones cambiaron/);
});
test('validation cannot erase a recorded or ambiguous integration operation', async () => {
  const prepared = await prepareIntegrationValidation(job, options());
  for (const phase of ['preflight_complete', 'commit_intent', 'push_intent', 'pr_intent', 'merge_intent']) {
    const opt = options({ ...prepared.record, phase, status: 'needs_attention' });
    await assert.rejects(prepareIntegrationValidation(job, opt), /registró una operación/);
    assert.equal(opt.saved.length, 0);
  }
});

test('reviewed product scope correction carries the original baseline into the next attempt only', async () => {
  const original = { ...job, attempts: 1 };
  const prior = (await prepareIntegrationValidation(original, options())).record;
  const contract = { version: 1, acceptanceScope: 'product', acceptance: ['Add a task.'] };
  const revision = { id: 'f'.repeat(64), phase: 'consumed', jobId: job.id, receiptId: job.autoIntent.receiptId,
    fromAttempt: 1, toAttempt: 2, snapshot, contractHash: fingerprint(contract),
    previousValidationHash: fingerprint(prior.validation), integrationRecordHash: fingerprint(prior) };
  const revised = { ...job, contract, contractRevision: revision };
  const opt = options(prior), result = await prepareIntegrationValidation(revised, opt);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.record.validation.attempt, 2);
  assert.equal(result.record.validation.cycleId, 'attempt-2');
  assert.equal(result.record.validation.capturedAt, prior.validation.capturedAt);
  assert.deepEqual(result.record.validationHistory, [{ revisionId: revision.id, validation: prior.validation }]);
  assert.equal(result.record.contractRevisionId, revision.id);
  const replay = await prepareIntegrationValidation(revised, options(result.record));
  assert.deepEqual(replay.record.validationHistory, result.record.validationHistory);
  for (const patch of [{ phase: 'ready' }, { fromAttempt: 0 }, { toAttempt: 3 }, { jobId: 'other' },
    { receiptId: 'other' }, { contractHash: '0'.repeat(64) }, { previousValidationHash: '0'.repeat(64) },
    { integrationRecordHash: '0'.repeat(64) }, { snapshot: '0'.repeat(64) }]) {
    const rejected = options(prior);
    await assert.rejects(prepareIntegrationValidation({ ...revised, contractRevision: { ...revision, ...patch } }, rejected), /otro encargo/);
    assert.equal(rejected.saved.length, 0);
  }
  await assert.rejects(prepareIntegrationValidation(revised, { ...options(prior), captureSnapshot: async () => '0'.repeat(64) }), /cambiaron/);
  for (const patch of [{ phase: 'commit_intent' }, { prNumber: 1 }, { manifest: snapshot },
    { validation: { ...prior.validation, approvals: {} } }]) {
    const changed = { ...prior, ...patch };
    const bound = { ...revision, integrationRecordHash: fingerprint(changed), previousValidationHash: fingerprint(changed.validation) };
    await assert.rejects(prepareIntegrationValidation({ ...revised, contractRevision: bound }, options(changed)), /registró una operación|otro encargo/);
  }
  await assert.rejects(prepareIntegrationValidation({ ...revised, branch: 'work/other' }, options(prior)), /otro encargo/);
});
