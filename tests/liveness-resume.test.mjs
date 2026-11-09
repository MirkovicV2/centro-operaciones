import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, runQueue } from '../queue.mjs';
import { syncQualityHandoffs } from '../panel/quality-handoff.mjs';

async function patchJob(root, change) {
  const state = await loadState(root), job = state.jobs[0]; change(job, state);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [job], budget: state.budget } }) + '\n');
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const ux = { runId: 'run_fixture01', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01' };
  const dev = { runId: ux.runId, taskId: 'task_develop01', dispatchId: 'ctx_develop01' };
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-liveness-resume', { id: 'liveness-resume-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Reanudar cierre exacto', prompt: 'Implementar y validar.', workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2, timeoutMs: 10_000 });
  const verify = async () => structuredClone(destination);
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_status_unknown', ...ux, attempt: job.attempts, taskInputAttempt: 1 });
    throw new Error('Unknown first UX transport');
  } }).tick();
  await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...ux, state: 'succeeded', liveness: 'exited' }) });
  const priorRecovery = (await readAutoRun(root)).receipts[0].dispatchRecovery;
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    assert.equal(job.attempts, 2);
    await ctx.reportStage({ key: 'ux', status: 'running', ...ux, attempt: 2 });
    await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'UX completed' });
    await ctx.reportStage({ key: 'developer', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_liveness_unconfirmed', ...dev, attempt: 2, taskInputAttempt: 2 });
    throw Object.assign(new Error('Exact exit not yet observed'), { code: 'orca_liveness_unconfirmed' });
  } }).tick();
  await patchJob(root, (job, state) => {
    job.attemptHistory = [...job.attemptHistory.filter(item => item.attempt !== 2),
      { attempt: 2, elapsedMs: 70, error: 'orca_liveness_unconfirmed' }, { attempt: 2, elapsedMs: 30, error: 'orca_liveness_unconfirmed' }];
    job.estimatedUsd = 0.06;
    state.budget.limitUsd = 1; state.budget.estimatedSpentUsd = 0.06;
  });
  const recover = (extra = {}) => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...dev, state: 'succeeded', liveness: 'exited' }), ...extra });
  return { root, workspace, verify, recover, dev, jobId: sent.job.id, priorRecovery, lockPath: path.join(workspace, '.git', 'centro-executor.lock') };
}

test('maxed-out liveness recovery preserves attempt, checkpoint, spend and prior recovery history', async t => {
  const f = await fixture(t), before = (await loadState(f.root)).jobs[0];
  assert.equal(before.attempts, before.maxAttempts);
  const queued = await f.recover();
  assert.equal(queued.attempts, 2); assert.equal(queued.maxAttempts, 2);
  assert.equal(queued.livenessResume.elapsedMs, 100);
  assert.deepEqual(queued.workflow, before.workflow);
  assert.equal(queued.estimatedUsd, 0.06);
  const receipt = (await readAutoRun(f.root)).receipts[0];
  assert.equal(receipt.dispatchRecovery.mode, 'same_attempt_liveness');
  assert.notEqual(receipt.dispatchRecovery.id, f.priorRecovery.id);
  assert.equal(receipt.dispatchRecoveryHistory[0].id, f.priorRecovery.id);
  await f.recover({ inspectDispatch: async () => assert.fail('same ready recovery must be idempotent') });
  assert.equal((await loadState(f.root)).jobs[0].livenessRecoveryHistory.length, 1);
  let starts = 0;
  await createAutoRunner(f.root, { verify: f.verify, worker: async (job, ctx) => {
    starts++; assert.equal(job.attempts, 2); assert.equal(job.maxAttempts, 2);
    assert.deepEqual(job.workflow.steps, before.workflow.steps);
    assert.equal(job.livenessResume.phase, 'consumed'); assert.equal(job.estimatedUsd, 0.06);
    assert.equal(JSON.parse(await fs.readFile(f.lockPath, 'utf8')).attempt, 2);
    await assert.rejects(ctx.reserve(0.05), error => error.code === 'budget_limit');
    return { text: 'Continúa el dispatch existente; no se lanza otro.' };
  } }).tick();
  const result = (await loadState(f.root)).jobs[0];
  assert.equal(starts, 1); assert.equal(result.state, 'succeeded'); assert.equal(result.attempts, 2);
  assert.equal(result.attemptHistory.at(-1).attempt, 2);
  assert.equal((await readAutoRun(f.root)).receipts[0].dispatchRecovery.phase, 'consumed');
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('completed recovery cannot replay') }).tick();
});

test('only exact succeeded/exited evidence can authorize same-attempt liveness recovery', async t => {
  const f = await fixture(t), lock = await fs.readFile(f.lockPath, 'utf8');
  for (const observed of [
    { ...f.dev, state: 'failed', liveness: 'exited' }, { ...f.dev, state: 'unknown', liveness: 'exited' },
    { ...f.dev, state: 'running', liveness: 'live' }, { ...f.dev, state: 'succeeded', liveness: 'unverifiable' },
    { ...f.dev, state: 'succeeded', liveness: 'exited', taskId: 'task_foreign1' },
  ]) await assert.rejects(f.recover({ inspectDispatch: async () => observed }), /Orca no acredita/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock);
  assert.equal((await loadState(f.root)).jobs[0].state, 'needs_attention');
  await patchJob(f.root, job => { job.error.code = 'orca_worker_failed'; });
  await assert.rejects(f.recover(), /no permite/);
});

test('an unread oversized delivery resumes the exact exited dispatch even when its outcome was failed', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => {
    job.error.code = 'orca_response_too_large';
    Object.assign(job.workflow.steps.find(step => step.key === 'developer'), { status: 'running', dispatchStatus: 'awaiting_exit', error: null });
  });
  const observed = { ...f.dev, state: 'failed', liveness: 'exited' };
  await assert.rejects(f.recover({ inspectDispatch: async () => ({ ...observed, liveness: 'live' }) }), /Orca no acredita/);
  const resume = async (_root, jobId, options) => {
    assert.equal(jobId, f.jobId);
    return f.recover({ ...options, inspectDispatch: async () => observed });
  };
  await syncQualityHandoffs(f.root, { resume });
  const queued = (await loadState(f.root)).jobs[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.livenessResume.dispatchId, f.dev.dispatchId);
  assert.equal(queued.attempts, 2);
  await createAutoRunner(f.root, { verify: f.verify, worker: async job => {
    assert.equal(job.livenessResume.observedState, 'failed');
    assert.equal(job.workflow.steps.find(step => step.key === 'developer').dispatchId, f.dev.dispatchId);
    return { text: 'Informe recuperado.' };
  } }).tick();
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('an identity read failure recovers a later exact exited dispatch without incrementing the attempt', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => {
    job.error.code = 'orca_dispatch_status_unknown';
    job.workflow.steps.find(step => step.key === 'developer').error = 'orca_identity_mismatch';
  });
  await assert.rejects(f.recover({ inspectDispatch: async () => ({ ...f.dev, taskId: 'task_foreign1', state: 'succeeded', liveness: 'exited' }) }), /Orca no acredita/);
  await syncQualityHandoffs(f.root, { resume: (_root, _id, options) => f.recover(options) });
  const queued = (await loadState(f.root)).jobs[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempts, 2);
  assert.equal(queued.livenessResume.error, 'orca_dispatch_status_unknown');
  assert.equal(queued.livenessResume.dispatchId, f.dev.dispatchId);
});

test('queue refuses manual execution or a mismatched receipt marker for an admitted same-attempt resume', async t => {
  const f = await fixture(t); await f.recover();
  await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('missing receipt authorization') }), error => error.code === 'liveness_resume_unadmitted');
  const automation = await readAutoRun(f.root); automation.receipts[0].dispatchRecovery.id = 'changed';
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(automation));
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('wrong receipt marker') }).tick();
  assert.equal((await loadState(f.root)).jobs[0].attempts, 2);
  assert.equal((await loadState(f.root)).jobs[0].state, 'queued');
});

test('same-attempt recovery resumes a partially persisted receipt without queuing it twice', async t => {
  const f = await fixture(t); await f.recover();
  const automation = await readAutoRun(f.root), receipt = automation.receipts[0];
  receipt.status = 'retrying'; receipt.dispatchRecovery.phase = 'lock_released'; delete receipt.retryAuthorizedAttempt;
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(automation));
  const recovered = await f.recover();
  assert.equal(recovered.state, 'queued'); assert.equal(recovered.attempts, 2);
  assert.equal(recovered.livenessRecoveryHistory.length, 1);
  assert.equal((await readAutoRun(f.root)).receipts[0].dispatchRecovery.phase, 'ready');
});

test('remaining timeout subtracts all elapsed segments of the same attempt', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => { job.timeoutMs = 2000; job.attemptHistory.at(-1).elapsedMs = 1880; });
  await f.recover();
  let elapsed;
  await createAutoRunner(f.root, { verify: f.verify, worker: async (_job, ctx) => {
    const started = Date.now();
    await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
    elapsed = Date.now() - started;
    throw ctx.signal.reason;
  } }).tick();
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(job.error.code, 'timeout'); assert.equal(job.attempts, 2); assert.equal(job.timeoutMs, 2000);
  assert.ok(elapsed >= 35 && elapsed < 1500, 'Only approximately 50ms should remain, not the original 2000ms.');
  assert.equal(job.attemptHistory.at(-1).attempt, 2);
});

test('exhausted or unmeasured elapsed history and changed checkpoints cannot bypass limits', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => { job.timeoutMs = 100; });
  await assert.rejects(f.recover(), /No queda tiempo/);
  await patchJob(f.root, job => { job.timeoutMs = 10_000; delete job.attemptHistory.at(-1).elapsedMs; });
  await assert.rejects(f.recover(), error => error.code === 'resume_elapsed_unknown');
  await patchJob(f.root, job => { job.attemptHistory.at(-1).elapsedMs = 30; });
  await f.recover();
  await patchJob(f.root, job => { job.workflow.steps[1].dispatchId = 'ctx_foreign1'; });
  await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('changed checkpoint') }), error => error.code === 'liveness_resume_invalid');
});

async function failedPreflight(t) {
  const f = await fixture(t); await f.recover();
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => {
    throw Object.assign(new Error('Checkout dirty before first Orca call'), { metrics: { orcaCliCalls: 0, dispatchStarts: 0, polls: 0 } });
  } }).tick();
  return f;
}

test('consumed zero-call preflight recovery can be rearmed with a new receipt at the same attempt', async t => {
  const f = await failedPreflight(t);
  const failed = (await loadState(f.root)).jobs[0];
  assert.equal(failed.error.code, 'worker_error');
  assert.equal(failed.livenessResume.phase, 'consumed');
  const previousId = failed.livenessResume.id;
  const elapsed = failed.attemptHistory.filter(item => item.attempt === 2).reduce((sum, item) => sum + item.elapsedMs, 0);
  let inspections = 0;
  const queued = await f.recover({ inspectDispatch: async expected => { inspections++; assert.equal(expected.dispatchId, f.dev.dispatchId); return { ...f.dev, state: 'succeeded', liveness: 'exited' }; } });
  assert.equal(inspections, 1);
  assert.equal(queued.attempts, 2); assert.equal(queued.maxAttempts, 2); assert.equal(queued.estimatedUsd, failed.estimatedUsd);
  assert.equal(queued.livenessResume.elapsedMs, elapsed);
  assert.equal(queued.livenessResume.rearmedFrom, previousId);
  assert.notEqual(queued.livenessResume.id, previousId);
  assert.deepEqual(queued.workflow, failed.workflow);
  assert.ok(queued.livenessRecoveryHistory.some(item => item.id === previousId && item.phase === 'consumed'));
  const receipt = (await readAutoRun(f.root)).receipts[0];
  assert.ok(receipt.dispatchRecoveryHistory.some(item => item.id === previousId && item.phase === 'consumed'));
  await f.recover({ inspectDispatch: async () => assert.fail('ready rearm replay cannot reinspect or enqueue again') });
  let calls = 0;
  await createAutoRunner(f.root, { verify: f.verify, worker: async job => { calls++; assert.equal(job.attempts, 2); assert.equal(job.livenessResume.phase, 'consumed'); return { text: 'Recovered existing native result' }; } }).tick();
  assert.equal(calls, 1); assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('rearm refuses missing/nonzero metrics, foreign recovery segments and later-stage effects', async t => {
  const f = await failedPreflight(t);
  const original = structuredClone((await loadState(f.root)).jobs[0]);
  const originalLock = await fs.readFile(f.lockPath, 'utf8');
  for (const alter of [
    job => { delete job.attemptHistory.at(-1).metrics; },
    job => { job.attemptHistory.at(-1).metrics.orcaCliCalls = 1; },
    job => { job.attemptHistory.at(-1).metrics.dispatchStarts = 1; },
    job => { job.attemptHistory.at(-1).recoveryId = 'foreign'; },
    job => { job.workflow.steps[1].dispatchId = 'ctx_foreign1'; },
    job => { job.workflow.steps[2].status = 'running'; job.workflow.steps[2].dispatchId = 'ctx_later001'; },
    job => { job.error.code = 'orca_start_unknown_timeout'; },
  ]) {
    await patchJob(f.root, job => { Object.assign(job, structuredClone(original)); job.maxAttempts = 3; alter(job); });
    await assert.rejects(f.recover({ inspectDispatch: async () => assert.fail('invalid preflight must not reach native recovery') }), /preflight sin efectos/);
    assert.equal(await fs.readFile(f.lockPath, 'utf8'), originalLock);
  }
});

test('rearmed preflight still requires new exact exit proof and unchanged destination', async t => {
  const f = await failedPreflight(t);
  for (const observed of [{ ...f.dev, state: 'failed', liveness: 'exited' }, { ...f.dev, state: 'succeeded', liveness: 'unverifiable' }, { ...f.dev, state: 'succeeded', liveness: 'exited', taskId: 'task_foreign1' }]) {
    await assert.rejects(f.recover({ inspectDispatch: async () => observed }), /Orca no acredita/);
  }
  await assert.rejects(f.recover({ verify: async () => ({ ...(await f.verify()), remoteSha: 'c'.repeat(40) }) }), /diverge/);
  assert.equal((await loadState(f.root)).jobs[0].livenessResume.phase, 'consumed');
});
