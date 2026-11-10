import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, runQueue, settledOrcaObservation } from '../queue.mjs';
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

async function interruptDeveloper(f) {
  await patchJob(f.root, job => {
    job.error = { code: 'interrupted', message: 'Ejecución interrumpida: comprueba el dispatch guardado antes de reanudar.' };
    Object.assign(job.workflow.steps.find(step => step.key === 'developer'), { status: 'blocked', dispatchStatus: 'active', error: 'interrupted' });
  });
}

test('an interrupted developer resumes its exact exited dispatch in the same attempt only after an operator resume', async t => {
  const f = await fixture(t);
  await interruptDeveloper(f);
  let automatic = 0;
  await syncQualityHandoffs(f.root, { resume: async () => { automatic++; } });
  assert.equal(automatic, 0);
  assert.equal((await loadState(f.root)).jobs[0].state, 'needs_attention');
  for (const observed of [
    { ...f.dev, state: 'running', liveness: 'live' }, { ...f.dev, state: 'succeeded', liveness: 'unverifiable' },
    { ...f.dev, state: 'succeeded', liveness: 'exited', dispatchId: 'ctx_foreign01' },
  ]) await assert.rejects(f.recover({ inspectDispatch: async () => observed }), /Orca no acredita/);
  await f.recover();
  const queued = (await loadState(f.root)).jobs[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempts, 2);
  assert.equal(queued.livenessResume.mode, 'same_attempt_liveness');
  assert.equal(queued.livenessResume.error, 'interrupted');
  assert.equal(queued.livenessResume.dispatchId, f.dev.dispatchId);
  await createAutoRunner(f.root, { verify: f.verify, worker: async job => {
    assert.equal(job.attempts, 2);
    assert.equal(job.livenessResume.phase, 'consumed');
    assert.equal(job.workflow.steps.find(step => step.key === 'developer').dispatchId, f.dev.dispatchId);
    return { text: 'Entrega recuperada.' };
  } }).tick();
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('only a blocked interrupted developer of the current attempt is a settled observation', async t => {
  const f = await fixture(t);
  await interruptDeveloper(f);
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(settledOrcaObservation(job)?.dispatchId, f.dev.dispatchId);
  const variant = change => { const copy = structuredClone(job); change(copy, copy.workflow.steps.find(step => step.key === 'developer')); return settledOrcaObservation(copy); };
  assert.equal(variant(copy => { copy.workflow.currentStage = 'ux'; copy.workflow.steps[0].error = 'interrupted'; copy.workflow.steps[0].status = 'blocked'; }), null);
  assert.equal(variant((_copy, step) => { step.attempt = 1; }), null);
  assert.equal(variant((_copy, step) => { step.status = 'running'; }), null);
  assert.equal(variant((_copy, step) => { step.error = 'orca_worker_failed'; }), null);
  assert.equal(variant((_copy, step) => { step.artifact = { sha256: 'f'.repeat(64) }; }), null);
  assert.equal(variant((_copy, step) => { delete step.dispatchId; }), null);
});

async function snapshotFiles(files) {
  return Promise.all(files.map(async file => [file, await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })]));
}
async function restoreFiles(snapshot) {
  for (const [file, content] of snapshot) {
    if (content === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, content);
  }
}

test('a developer interrupted while really running records its segment and resumes in the same attempt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-interrupted-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const ux = { runId: 'run_fixture01', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01' };
  const dev = { runId: ux.runId, taskId: 'task_develop01', dispatchId: 'ctx_develop01' };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-interrupted', { id: 'interrupted-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Interrumpir Desarrollo', prompt: 'Implementar y validar.', workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2 });
  const data = path.join(root, 'data');
  let crash;
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'running', ...ux, attempt: job.attempts });
    await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'UX completed' });
    await ctx.reportStage({ key: 'developer', status: 'running', dispatchStatus: 'active', ...dev, attempt: job.attempts, taskInputAttempt: 1 });
    // The executor dies here: keep the files exactly as persisted while Development is active.
    const names = (await fs.readdir(data)).filter(name => !name.endsWith('.lock'));
    crash = await snapshotFiles([...names.map(name => path.join(data, name)), path.join(workspace, '.git', 'centro-executor.lock')]);
    throw new Error('process killed');
  } }).tick();
  await restoreFiles(crash);
  const running = (await loadState(root)).jobs[0];
  assert.equal(running.state, 'running');
  assert.equal(running.attemptHistory?.length ?? 0, 0);

  let calls = 0;
  await createAutoRunner(root, { verify, worker: async () => { calls++; } }).tick();
  const interrupted = (await loadState(root)).jobs[0];
  assert.equal(calls, 0);
  assert.equal(interrupted.state, 'needs_attention');
  assert.equal(interrupted.error.code, 'interrupted');
  const segment = interrupted.attemptHistory.at(-1);
  assert.equal(segment.attempt, 1);
  assert.equal(segment.error, 'interrupted');
  assert.ok(Number.isFinite(segment.elapsedMs) && segment.elapsedMs >= 0);
  assert.equal(segment.startedAt, running.startedAt);
  // The worker may keep running in Orca while the executor is down: the segment ends at detection.
  assert.equal(segment.finishedAt, interrupted.finishedAt);
  assert.equal(segment.elapsedMs, Date.parse(interrupted.finishedAt) - Date.parse(running.startedAt));

  await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...dev, state: 'succeeded', liveness: 'exited' }) });
  const queued = (await loadState(root)).jobs[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempts, 1);
  assert.equal(queued.livenessResume.error, 'interrupted');
  assert.equal(queued.livenessResume.elapsedMs, segment.elapsedMs);
  await createAutoRunner(root, { verify, worker: async job => {
    assert.equal(job.attempts, 1);
    assert.equal(job.workflow.steps.find(step => step.key === 'developer').dispatchId, dev.dispatchId);
    return { text: 'Entrega recuperada.' };
  } }).tick();
  const done = (await loadState(root)).jobs[0];
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(done.attemptHistory.map(item => item.attempt), [1, 1]);
});

test('an interrupted segment without a usable start time keeps the elapsed-time refusal', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => {
    job.state = 'running'; job.startedAt = 'not-a-date';
    job.attemptHistory = job.attemptHistory.filter(item => item.attempt !== job.attempts);
    Object.assign(job.workflow.steps.find(step => step.key === 'developer'), { status: 'running', dispatchStatus: 'active', error: null });
  });
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('No worker may start.') }).tick();
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(job.state, 'needs_attention');
  assert.equal(job.attemptHistory.filter(item => item.attempt === job.attempts).length, 0);
  await assert.rejects(f.recover(), /tiempo consumido/);
});

test('an interrupted segment ends at detection even when the last persisted event is much older', async t => {
  const f = await fixture(t);
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  await patchJob(f.root, job => {
    job.state = 'running'; job.startedAt = startedAt;
    job.attemptHistory = job.attemptHistory.filter(item => item.attempt !== job.attempts);
    Object.assign(job.workflow.steps.find(step => step.key === 'developer'), { status: 'running', dispatchStatus: 'active', error: null });
  });
  // Rewind the timestamp of that last event: the outage started ten minutes ago.
  const ledger = path.join(f.root, 'data', 'events.jsonl');
  const lines = (await fs.readFile(ledger, 'utf8')).trim().split('\n');
  lines[lines.length - 1] = JSON.stringify({ ...JSON.parse(lines.at(-1)), at: startedAt });
  await fs.writeFile(ledger, lines.join('\n') + '\n');
  const before = Date.now();
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('No worker may start.') }).tick();
  const job = (await loadState(f.root)).jobs[0];
  const segment = job.attemptHistory.at(-1);
  assert.equal(segment.error, 'interrupted');
  assert.equal(segment.finishedAt, job.finishedAt);
  assert.ok(Date.parse(segment.finishedAt) >= before);
  assert.ok(segment.elapsedMs >= 600_000, 'the outage counts as consumed time');
  assert.equal(segment.finishedAtSource, undefined);
});

for (const admittedRepository of ['Fixture/Repo', 'fixture/repo']) test(`case-mixed data: an interrupted developer admitted as ${admittedRepository} resumes when origin now says Fixture/Repo`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liveness-case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const dev = { runId: 'run_fixture01', taskId: 'task_develop01', dispatchId: 'ctx_develop01' };
  // A job admitted before this branch stored the lower-case name; today the same origin is reported in its own case.
  let observed = admittedRepository;
  const verify = async () => ({ ...structuredClone(destination), repository: observed });
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-case', { id: 'case-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Mayúsculas', prompt: 'Implementar y validar.', workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2 });
  const data = path.join(root, 'data');
  let crash;
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'running', runId: dev.runId, taskId: 'task_fixture01', dispatchId: 'ctx_fixture01', attempt: job.attempts });
    await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'UX completed' });
    await ctx.reportStage({ key: 'developer', status: 'running', dispatchStatus: 'active', ...dev, attempt: job.attempts, taskInputAttempt: 1 });
    const names = (await fs.readdir(data)).filter(name => !name.endsWith('.lock'));
    crash = await snapshotFiles([...names.map(name => path.join(data, name)), path.join(workspace, '.git', 'centro-executor.lock')]);
    throw new Error('process killed');
  } }).tick();
  await restoreFiles(crash);
  await createAutoRunner(root, { verify, worker: async () => assert.fail('no worker on detection') }).tick();
  const interrupted = (await loadState(root)).jobs[0];
  assert.equal(interrupted.destination.repository, admittedRepository);
  observed = 'Fixture/Repo';
  assert.equal((await readAutoRun(root)).receipts[0].spec.destination.repository, 'fixture/repo');
  const queued = await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...dev, state: 'succeeded', liveness: 'exited' }) });
  assert.equal(queued.state, 'queued'); assert.equal(queued.attempts, 1); assert.equal(queued.livenessResume.mode, 'same_attempt_liveness');
  await createAutoRunner(root, { verify, worker: async job => { assert.equal(job.attempts, 1); return { text: 'Entrega recuperada.' }; } }).tick();
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});
