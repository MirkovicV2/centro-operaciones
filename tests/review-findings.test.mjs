import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDelivery } from '../workflow-contract.mjs';

// C (structured review): findings with severity, stop only for something relevant, operational failure apart.
const ids = { jobId: 'job-c', runId: 'run_review01', taskId: 'task_review01', dispatchId: 'ctx_review01' };
const base = (extra = {}) => ({ version: 1, ...ids, jobAttempt: 1, stage: 'reviewer', outcome: 'completed', scope: 'complete', summary: 'Revisión',
  evidence: ['npm test'], acceptance: [{ criterion: 'Valida el email', status: 'passed', evidence: 'prueba manual' }], questions: [], decisions: [], approval: 'approved', ...extra });
const strict = (value, expected = {}) => validateDelivery(value, { ...ids, stage: 'reviewer', ...expected }, { strictReview: true });

test('an approval may carry non-blocking findings but never a blocking one', () => {
  const minor = { severity: 'non_blocking', summary: 'Texto del botón poco claro', evidence: 'captura' };
  assert.deepEqual(strict(base({ findings: [minor] })).findings, [minor]);
  assert.throws(() => strict(base({ findings: [{ ...minor, severity: 'blocking' }] })), /no puede tener hallazgos bloqueantes/);
  assert.throws(() => strict(base({ findings: [{ ...minor, severity: 'grave' }] })), /hallazgos de la entrega son inválidos/);
});

test('a rejection needs a blocking finding or a failed criterion with evidence; minor findings alone never stop', () => {
  const rejected = { outcome: 'blocked', approval: 'blocked', acceptance: [{ criterion: 'Valida el email', status: 'passed', evidence: 'ok' }] };
  assert.throws(() => strict(base({ ...rejected, findings: [{ severity: 'non_blocking', summary: 'Estilo', evidence: 'x' }] })), error => error.code === 'delivery_block_unjustified');
  assert.throws(() => strict(base({ ...rejected, findings: [{ severity: 'blocking', summary: 'Sin evidencia', evidence: ' ' }] })), error => error.code === 'delivery_block_unjustified');
  assert.equal(strict(base({ ...rejected, findings: [{ severity: 'blocking', summary: 'Envía con email vacío', evidence: 'pasos 1-3' }] })).approval, 'blocked');
  assert.equal(strict(base({ ...rejected, acceptance: [{ criterion: 'Valida el email', status: 'failed', evidence: 'pasos 1-3' }] })).approval, 'blocked');
  assert.equal(strict(base({ ...rejected, questions: [{ id: 'q1', text: '¿Se admite vacío?', required: true }] })).approval, 'blocked', 'a required decision is relevant');
  // Stored deliveries keep validating as before (no strictReview).
  assert.equal(validateDelivery(base(rejected), { ...ids, stage: 'reviewer' }).approval, 'blocked');
});

test('the verdict is bound to the candidate it judged', () => {
  const candidate = 'a'.repeat(64);
  assert.equal(strict(base({ candidate }), { candidate }).candidate, candidate);
  assert.throws(() => strict(base({ candidate }), { candidate: 'b'.repeat(64) }), error => error.code === 'delivery_candidate_mismatch');
  assert.throws(() => strict(base({ candidate: 'corto' })), /huella del candidato/);
  assert.equal(strict(base()).candidate, undefined, 'optional: a report without it stays valid');
});

test('a stage that could not finish its own check stops as an operational failure, not a rejection', async () => {
  const { enforceGate } = await import('../orca-provider.mjs');
  const reports = [];
  const ctx = { reportStage: async update => reports.push(update) };
  const delivery = outcome => ({ outcome, scope: 'complete', approval: 'blocked', dispatchId: 'ctx_review01' });
  const failed = await enforceGate(ctx, 'revisor', { text: 'npm test no arrancó', dispatchId: 'ctx_review01', delivery: delivery('failed') }).then(() => assert.fail('must stop'), error => error);
  assert.equal(failed.code, 'quality_gate_operational'); assert.match(failed.message, /no un rechazo/);
  assert.equal(reports[0].error, 'quality_gate_operational');
  const rejected = await enforceGate(ctx, 'revisor', { text: 'defecto', dispatchId: 'ctx_review01', delivery: delivery('blocked') }).then(() => assert.fail('must stop'), error => error);
  assert.equal(rejected.code, 'quality_gate_blocked');
  await enforceGate(ctx, 'revisor', { text: 'ok', dispatchId: 'ctx_review01', delivery: { outcome: 'completed', scope: 'complete', approval: 'approved', dispatchId: 'ctx_review01' } });
});
