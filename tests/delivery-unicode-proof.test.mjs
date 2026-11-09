import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateUnicodeDeliveryRepair, verifyUnicodeDeliveryTransport } from '../orca-delivery-transport.mjs';
import { saveStageReport } from '../orca-evidence.mjs';

const identity = { jobId: 'unicode-job', jobAttempt: 2, stage: 'qa', runId: 'run_unicode001', taskId: 'task_unicode001', dispatchId: 'ctx_unicode001', workerState: 'succeeded' };
const criterion = 'Añadir mediante botón y tecla Enter.';
const delivery = { version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: 'Validación completada.', approval: 'approved',
  acceptance: [{ criterion, status: 'passed', evidence: 'Comprobé el botón.' }], evidence: ['Probado con teclado.'], decisions: [], questions: [] };
delete delivery.workerState;
const original = JSON.stringify(delivery), damaged = original.replace(/[^\x00-\x7f]/g, '?');
const expected = { ...identity, acceptance: [criterion] };
const sha = value => createHash('sha256').update(value).digest('hex');

test('exact original approved contract repairs only explainable Unicode loss', () => {
  assert.deepEqual(validateUnicodeDeliveryRepair(damaged, original, expected), delivery);
  assert.throws(() => validateUnicodeDeliveryRepair(original, original, expected), { code: 'delivery_transport_unverified' });
  for (const patch of [{ summary: 'Otro informe' }, { evidence: ['Otras pruebas.'] }, { questions: [{ id: 'q-new', text: '¿Autorizar?', required: true }] }, { jobAttempt: 3 }]) {
    assert.throws(() => validateUnicodeDeliveryRepair(damaged, JSON.stringify({ ...delivery, ...patch }), expected));
  }
  assert.throws(() => validateUnicodeDeliveryRepair(damaged.replace('Probado', 'Inventado'), original, expected), { code: 'delivery_transport_unverified' });
  assert.throws(() => validateUnicodeDeliveryRepair(damaged, original.replace('approved', 'blocked'), expected));
  assert.throws(() => validateUnicodeDeliveryRepair(damaged, original.slice(0, Math.floor(original.length / 2)), expected));
});

test('transport proof binds the original artifact, exact receipt, closed worker and archived final', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unicode-proof-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'checkout');
  const artifact = await saveStageReport(root, identity, damaged, null);
  const job = { id: identity.jobId, workspace, attempts: 2, contract: { acceptance: [criterion] } };
  const step = { key: 'qa', ...identity, taskInputAttempt: 2, artifact };
  let receiptText = damaged, workerState = 'succeeded', liveness = 'exited';
  const command = async args => {
    if (args[1] === 'worker-show') return { ...identity, state: workerState, liveness, workspace };
    if (args[1] === 'inbox') return { messages: [{ id: 'msg_unicode001', type: 'worker_done', run_id: identity.runId, to_handle: `run:${identity.runId}`, payload: { ...identity, outcome: 'succeeded' }, body: receiptText }] };
    assert.fail('Unexpected native mutation');
  };
  const readArchive = async observed => { assert.equal(observed.dispatchId, identity.dispatchId); return { text: original, sourceIdentity: 'native-bound-source', messageId: 'msg_final001', sha256: sha(original), provenance: { verified: true } }; };
  const result = await verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive });
  assert.equal(result.proof.originalArtifactSha256, artifact.sha256);
  assert.equal(result.proof.receiptSha256, sha(damaged)); assert.equal(result.proof.transcriptSha256, sha(original));
  assert.deepEqual(result.delivery, delivery); assert.equal(JSON.parse(await fs.readFile(artifact.path, 'utf8')).text, damaged);
  receiptText = damaged + 'changed'; await assert.rejects(verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive }), { code: 'delivery_transport_unverified' });
  receiptText = damaged; liveness = 'live'; await assert.rejects(verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive }), { code: 'delivery_transport_unverified' });
  liveness = 'exited'; workerState = 'failed'; await assert.rejects(verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive }));
});
