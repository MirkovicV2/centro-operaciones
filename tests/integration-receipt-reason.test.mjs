import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, setAutoRun } from '../auto-run.mjs';

const published = 'Entrega integrada en GitHub; merge remoto confirmado.';
const local = 'Entrega local completada; sin publicación.';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-reason-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-publication-reason', { id: 'publication-reason-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Publication reason fixture', prompt: 'Check the receipt summary.', workspace, isolated: true, branch: 'feature', destination });
  const record = { jobId: sent.job.id, receiptId: sent.receipt.id, phase: 'complete', status: 'completed', mergeSha: 'c'.repeat(40), error: null, needsAttention: false };
  return { root, record, verify: async () => destination };
}

test('a newly completed runner distinguishes confirmed GitHub integration from local delivery', async t => {
  for (const remote of [true, false]) {
    const f = await fixture(t);
    await createAutoRunner(f.root, { verify: f.verify, worker: async () => ({ text: 'Fixture delivered.', ...(remote ? { integration: f.record } : {}) }) }).tick();
    const receipt = (await readAutoRun(f.root)).receipts[0];
    assert.equal(receipt.status, 'completed'); assert.equal(receipt.reason, remote ? published : local);
  }
});

test('persisting confirmed remote completion repairs an already completed receipt without changing its status', async t => {
  const f = await fixture(t);
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => ({ text: 'Fixture delivered.' }) }).tick();
  assert.equal((await readAutoRun(f.root)).receipts[0].reason, local);
  for (const patch of [{ phase: 'merge_intent' }, { status: 'needs_attention' }, { mergeSha: 'invalid' }]) {
    await persistIntegration(f.root, { ...f.record, ...patch });
    const receipt = (await readAutoRun(f.root)).receipts[0]; assert.equal(receipt.status, 'completed'); assert.equal(receipt.reason, local);
  }
  await persistIntegration(f.root, f.record);
  const state = await readAutoRun(f.root); assert.equal(state.receipts[0].status, 'completed'); assert.equal(state.receipts[0].reason, published);
  assert.equal(state.integrations[f.record.receiptId].error, null);
  await assert.rejects(persistIntegration(f.root, { ...f.record, jobId: 'foreign-job' }), /no elegible/);
});

test('durable remote completion never promotes a pending or blocked receipt', async t => {
  for (const status of ['pending', 'blocked']) {
    const f = await fixture(t), state = await readAutoRun(f.root);
    state.receipts[0].status = status; state.receipts[0].reason = 'Original receipt state.';
    await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(state));
    await persistIntegration(f.root, f.record);
    const receipt = (await readAutoRun(f.root)).receipts[0]; assert.equal(receipt.status, status); assert.equal(receipt.reason, 'Original receipt state.');
  }
});
