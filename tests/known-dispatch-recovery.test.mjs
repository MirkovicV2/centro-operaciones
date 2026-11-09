import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, acquireLock, releaseLock, QueueError } from '../queue.mjs';

async function fixture(t, { stoppedDeveloper = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'known-dispatch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const ids = { runId: 'run_fixture01', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01' };
  await setAutoRun(root, 'agency', true, { confirm: true });
  const submitted = await confirmSubmission(root, 'receipt-known-dispatch', { id: 'known-dispatch-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Recover exact worker', prompt: 'Implementar la prueba con aceptación verificable.', workspace, isolated: true, branch: 'feature', destination });
  const verify = async () => structuredClone(destination);
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    if (stoppedDeveloper) {
      await ctx.reportStage({ key: 'ux', status: 'running', runId: ids.runId });
      await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'Diseño aprobado' });
      await ctx.reportStage({ key: 'developer', status: 'running', dispatchStatus: 'active', ...ids,
        attempt: job.attempts, taskInputAttempt: 1, specArtifact: { sha256: 'a'.repeat(64) } });
      const error = new QueueError('Timed out', 'timeout');
      error.uncertain = true;
      throw error;
    }
    await ctx.reportStage({ key: 'ux', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_status_unknown', ...ids, attempt: job.attempts, taskInputAttempt: 1 });
    throw new Error('Native dispatch transport unknown');
  } }).tick();
  const inspectDispatch = async expected => { assert.deepEqual({ runId: expected.runId, taskId: expected.taskId, dispatchId: expected.dispatchId }, ids); return { ...ids, state: 'succeeded', liveness: 'exited' }; };
  return { root, workspace, destination, ids, jobId: submitted.job.id, verify, inspectDispatch, lockPath: path.join(workspace, '.git', 'centro-executor.lock') };
}

async function changeReceipt(root, action) {
  const state = await readAutoRun(root); action(state.receipts[0]);
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
}

test('known completed dispatch resumes the same checkpoint once and preserves original task input attempt', async t => {
  const f = await fixture(t);
  const original = (await loadState(f.root)).jobs[0], checkpoint = structuredClone(original.workflow.steps[0]);
  const recovered = await recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch, verify: f.verify });
  assert.equal(recovered.state, 'queued'); assert.equal(recovered.attempts, 1);
  assert.deepEqual(recovered.workflow.steps[0], checkpoint); assert.equal(recovered.workflow.steps[0].dispatchStatus, 'unknown');
  assert.equal(recovered.workflowHistory.length, 1);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'pending');
  await assert.rejects(fs.access(f.lockPath), { code: 'ENOENT' });
  await recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: async () => assert.fail('ready replay does not start another recovery'), verify: f.verify });
  assert.equal((await loadState(f.root)).jobs[0].workflowHistory.length, 1);
  let resumed = 0;
  await createAutoRunner(f.root, { verify: f.verify, worker: async (job, ctx) => {
    resumed++; assert.equal(job.attempts, 2); assert.deepEqual(job.workflow.steps[0], checkpoint);
    assert.equal(job.workflow.steps[0].taskInputAttempt, 1);
    for (const step of job.workflow.steps) {
      await ctx.reportStage({ key: step.key, status: 'running' });
      await ctx.reportStage({ key: step.key, status: 'succeeded', summary: 'Fixture approval' });
    }
    return { text: 'Recovered without native start' };
  } }).tick();
  assert.equal(resumed, 1); assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'completed');
});

test('unknown state, wrong native IDs, missing exit proof and missing confirmation preserve receipt and lock', async t => {
  const f = await fixture(t), originalLock = await fs.readFile(f.lockPath, 'utf8');
  await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { inspectDispatch: f.inspectDispatch, verify: f.verify }), /Confirma/);
  for (const observed of [
    { ...f.ids, state: 'start_unknown', liveness: 'live' },
    { ...f.ids, state: 'succeeded', liveness: 'live' },
    { ...f.ids, state: 'running', liveness: 'exited' },
    { ...f.ids, state: 'succeeded', liveness: 'exited', taskId: 'task_different' },
    { dispatchId: f.ids.dispatchId, state: 'succeeded', liveness: 'exited' },
  ]) await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: async () => observed, verify: f.verify }), /Orca no acredita/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), originalLock);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'needs_attention');
  assert.equal((await loadState(f.root)).jobs[0].workflowHistory, undefined);
});

test('changed source/base or foreign checkout lock cannot be approved during known dispatch recovery', async t => {
  const f = await fixture(t), originalLock = await fs.readFile(f.lockPath, 'utf8');
  for (const key of ['sha', 'remoteSha', 'baseSha', 'branch', 'repository']) {
    await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch,
      verify: async () => ({ ...f.destination, [key]: 'changed' }) }), /diverge/);
  }
  const owner = JSON.parse(originalLock); owner.attempt = 99; await fs.writeFile(f.lockPath, JSON.stringify(owner));
  await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch, verify: f.verify }), /otro trabajo, recibo o intento/);
  assert.equal(JSON.parse(await fs.readFile(f.lockPath, 'utf8')).attempt, 99);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'needs_attention');
});

test('recovery replays safely after retryJob persisted but before the receipt became ready', async t => {
  const f = await fixture(t);
  await recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch, verify: f.verify });
  await changeReceipt(f.root, receipt => { receipt.status = 'retrying'; receipt.dispatchRecovery.phase = 'lock_released'; delete receipt.retryAuthorizedAttempt; });
  const resumed = await recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch, verify: f.verify });
  assert.equal(resumed.state, 'queued'); assert.equal(resumed.workflowHistory.length, 1); assert.equal(resumed.attempts, 1);
  assert.equal((await readAutoRun(f.root)).receipts[0].dispatchRecovery.phase, 'ready');
});

test('queue ownership blocks recovery and live exact workers are recoverable without changing their dispatch', async t => {
  const f = await fixture(t), lock = await acquireLock(f.root);
  try { await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: f.inspectDispatch, verify: f.verify }), error => error.code === 'locked'); }
  finally { await releaseLock(lock); }
  const recovered = await recoverKnownDispatchReceipt(f.root, f.jobId, { confirm: true, inspectDispatch: async () => ({ ...f.ids, state: 'running', liveness: 'live' }), verify: f.verify });
  assert.equal(recovered.workflow.steps[0].dispatchId, f.ids.dispatchId);
  assert.equal(recovered.workflow.steps[0].status, 'blocked');
});


test('confirmed stopped developer retries the same native Task and preserves UX and the work in progress', async t => {
  const f = await fixture(t, { stoppedDeveloper: true });
  const original = (await loadState(f.root)).jobs[0];
  const inspectDispatch = async () => ({ ...f.ids, state: 'stopped', dispatchStatus: 'failed', liveness: 'exited' });
  const captureSnapshot = async () => 'a'.repeat(64);
  const options = { confirm: true, verify: f.verify, captureSnapshot };
  await assert.rejects(recoverKnownDispatchReceipt(f.root, f.jobId, { ...options,
    inspectDispatch: async () => ({ ...await inspectDispatch(), liveness: 'unverifiable' }),
  }), /Orca no acredita/);
  await fs.access(f.lockPath);
  const job = await recoverKnownDispatchReceipt(f.root, f.jobId, { ...options, inspectDispatch });
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 1);
  assert.deepEqual(job.workflow.steps[0], original.workflow.steps[0]);
  assert.equal(job.workflow.steps[1].retryOf.taskId, f.ids.taskId);
  assert.equal(job.workflow.steps[1].retryOf.dispatchId, f.ids.dispatchId);
  assert.equal(job.workflow.steps[1].retryOf.taskInputAttempt, 1);
  await assert.rejects(fs.access(f.lockPath), { code: 'ENOENT' });
  await recoverKnownDispatchReceipt(f.root, f.jobId, { ...options, inspectDispatch: async () => assert.fail('already queued') });
  let started = 0;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot, worker: async (current, ctx) => {
    started++;
    assert.equal(current.attempts, 2);
    assert.equal(current.stoppedDeveloperRecoveryId, current.workflow.steps[1].retryOf.recoveryId);
    for (const step of current.workflow.steps.slice(1)) {
      await ctx.reportStage({ key: step.key, status: 'running' });
      await ctx.reportStage({ key: step.key, status: 'succeeded', summary: 'Fixture approval' });
    }
    return { text: 'Continued' };
  } }).tick();
  assert.equal(started, 1);
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
  assert.equal((await readAutoRun(f.root)).receipts[0].dispatchRecovery.phase, 'consumed');
});
