import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addJob, cancelQueuedJob, loadState, runQueue } from '../queue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(here, 'tmp-'));
  t.after(async () => {
    assert.equal(path.dirname(root), here);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const spec = (patch = {}) => ({
  id: 'cancel-001', business: 'games', kind: 'analysis', provider: 'auto', title: 'Revisar idea',
  prompt: 'Preparar tres observaciones sin modificar archivos.', ...patch,
});
const LEDGER = root => path.join(root, 'data', 'events.jsonl');
const events = async root => (await fs.readFile(LEDGER(root), 'utf8'))
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a queued job that never started can be cancelled and is no longer picked up', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await assert.rejects(cancelQueuedJob(root, 'cancel-001'), /--confirm-reviewed/);
  const job = await cancelQueuedJob(root, 'cancel-001', { confirm: true });
  assert.equal(job.state, 'cancelled');
  assert.ok(job.cancelledAt);
  assert.equal((await loadState(root)).jobs.find(item => item.id === 'cancel-001').state, 'cancelled');
  assert.deepEqual((await runQueue(root, {})).jobs, []);
  let calls = 0;
  await runQueue(root, { execute: true, worker: async () => { calls++; return { text: 'No debería ejecutarse.' }; } });
  assert.equal(calls, 0);
});

test('the cancellation is recorded in the ledger as an operator event', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await cancelQueuedJob(root, 'cancel-001', { confirm: true });
  const recorded = await events(root);
  assert.equal(recorded.at(-1).type, 'operator_cancelled');
  assert.equal(recorded.at(-1).details.jobId, 'cancel-001');
});

test('started, finished or unknown jobs cannot be cancelled', async t => {
  const root = await fixture(t);
  await assert.rejects(cancelQueuedJob(root, 'missing', { confirm: true }), /No existe/);
  await addJob(root, spec());
  await runQueue(root, { execute: true, jobId: 'cancel-001', worker: async () => ({ text: 'Informe.' }) });
  const finished = (await loadState(root)).jobs.find(item => item.id === 'cancel-001');
  assert.notEqual(finished.state, 'queued');
  await assert.rejects(cancelQueuedJob(root, 'cancel-001', { confirm: true }), /no han arrancado nunca/);
  assert.equal((await loadState(root)).jobs.find(item => item.id === 'cancel-001').state, finished.state);
});
