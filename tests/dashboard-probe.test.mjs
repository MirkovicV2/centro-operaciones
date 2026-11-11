import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { addJob, loadState, recoverDashboardQueue, acquireLock, releaseLock, acquireLedgerLock } from '../queue.mjs';

// The panel (every refresh) and the automatic executor (every tick) ask the same process whether a
// company's executor is free. These tests keep that question from reporting the process's own short
// locks as «Ya hay un ejecutor u otra operación de escritura en marcha».

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
  id: 'review-001', business: 'games', kind: 'analysis', provider: 'auto', title: 'Revisar idea',
  prompt: 'Preparar tres observaciones sin modificar archivos.', ...patch,
});
const ledgerFile = root => path.join(root, 'data', 'events.jsonl');
async function appendInterruptedStart(root) {
  const state = await loadState(root);
  const job = { ...state.jobs[0], state: 'running', attempts: 1, startedAt: new Date().toISOString() };
  await fs.appendFile(ledgerFile(root), JSON.stringify({
    schema: 1, revision: state.revision + 1, at: new Date().toISOString(),
    type: 'job_started', details: { jobId: job.id }, patch: { jobs: [job] },
  }) + '\n');
}

test('simultaneous questions about the same company share one answer instead of meeting each other\'s lock', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  for (let round = 0; round < 5; round++) {
    const answers = await Promise.all(Array.from({ length: 6 }, () => recoverDashboardQueue(root, { business: 'games' })));
    assert.deepEqual(answers, Array(6).fill({ available: true }));
  }
  assert.deepEqual(await recoverDashboardQueue(root, { business: 'games' }), { available: true }, 'a finished probe is not reused');
});

test('both companies asked at once, while the same process is writing the ledger, are both free', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const answers = [];
  const writes = [];
  for (let round = 0; round < 4; round++) {
    writes.push(addJob(root, spec({ id: `otro-${round}` })).catch(error => { if (error.code !== 'locked') throw error; }));
    answers.push(...await Promise.all(['agency', 'games'].map(business => recoverDashboardQueue(root, { business }))));
  }
  await Promise.all(writes);
  assert.deepEqual(answers, Array(8).fill({ available: true }));
});

test('a ledger write of this same process that outlasts the usual two seconds is waited for', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const own = await acquireLock(root);
  const started = performance.now();
  const answer = recoverDashboardQueue(root, { business: 'games' });
  await wait(2400);
  await releaseLock(own);
  assert.deepEqual(await answer, { available: true });
  assert.ok(performance.now() - started >= 2300, 'the probe waited for the write instead of answering early');
});

test('a ledger lock that belongs to another live process is still reported, and is left alone', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const foreign = JSON.stringify({ pid: process.ppid, token: 'otro-proceso', at: new Date().toISOString() });
  assert.notEqual(process.ppid, process.pid);
  await fs.writeFile(path.join(root, 'data', 'runner.lock'), foreign);
  const started = performance.now();
  const answer = await recoverDashboardQueue(root, { business: 'games' });
  assert.equal(answer.available, false);
  assert.match(answer.reason, /Ya hay un ejecutor/);
  assert.ok(performance.now() - started < 10_000, 'another process is not waited for beyond the usual two seconds');
  assert.equal(await fs.readFile(path.join(root, 'data', 'runner.lock'), 'utf8'), foreign);
  await assert.rejects(acquireLedgerLock(root, 0, { sameProcessWaitMs: 5000 }), error => error.code === 'locked' && error.ownerPid === process.ppid && error.lockName === 'runner');
});

test('a company whose executor is running is still reported as busy, and only that company', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const lane = await acquireLock(root, 'games');
  try {
    const started = performance.now();
    const busy = await recoverDashboardQueue(root, { business: 'games' });
    assert.equal(busy.available, false);
    assert.match(busy.reason, /Ya hay un ejecutor/);
    assert.ok(performance.now() - started < 2000, 'a running executor is reported at once');
    assert.deepEqual(await recoverDashboardQueue(root, { business: 'agency' }), { available: true });
  } finally { await releaseLock(lane); }
  assert.deepEqual(await recoverDashboardQueue(root, { business: 'games' }), { available: true });
});

test('a probe with nothing to record leaves the ledger untouched and unlocked for the operator', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const before = await fs.readFile(ledgerFile(root), 'utf8');
  const lane = await acquireLock(root, 'agency');
  let operatorWrite;
  try {
    // While a company lock is held (as during a probe), an operator write with no waiting still gets the ledger.
    operatorWrite = await addJob(root, spec({ id: 'operador', business: 'agency' }));
  } finally { await releaseLock(lane); }
  assert.equal(operatorWrite.id, 'operador');
  const afterWrite = await fs.readFile(ledgerFile(root), 'utf8');
  assert.ok(afterWrite.startsWith(before));
  for (const business of ['agency', 'games']) assert.deepEqual(await recoverDashboardQueue(root, { business }), { available: true });
  assert.equal(await fs.readFile(ledgerFile(root), 'utf8'), afterWrite, 'no event is written when no job was interrupted');
});

test('an interrupted job of the company is still recorded for review, once, and other companies are not touched', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await appendInterruptedStart(root);
  assert.deepEqual(await recoverDashboardQueue(root, { business: 'agency' }), { available: true });
  assert.equal((await loadState(root)).jobs[0].state, 'running', 'the other company\'s probe does not record it');
  const answers = await Promise.all(Array.from({ length: 4 }, () => recoverDashboardQueue(root, { business: 'games' })));
  assert.deepEqual(answers, Array(4).fill({ available: true }));
  const state = await loadState(root);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'interrupted');
  assert.equal(state.jobs[0].orphanRisk, true);
  const ledger = await fs.readFile(ledgerFile(root), 'utf8');
  assert.equal(ledger.split('\n').filter(line => line.includes('interrupted_jobs_recovered')).length, 1);
  assert.deepEqual(await recoverDashboardQueue(root, { business: 'games' }), { available: true });
  assert.equal(await fs.readFile(ledgerFile(root), 'utf8'), ledger);
});
