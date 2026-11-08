import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addJob, loadState, runQueue, retryJob, acquireLock, releaseLock, setBudget,
} from '../queue.mjs';
import { createWorker, isCreditExhausted, withTimeout, validateWorkspace } from '../providers.mjs';

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

test('games Godot display keeps developer routing in durable events and agency unchanged', async t => {
  const root = await fixture(t);
  for (const business of ['games', 'agency']) {
    await addJob(root, spec({ id: `display-${business}`, kind: 'code', business, provider: 'orca', workspace: path.join(root, 'workspaces', business), isolated: true }));
  }
  const jobs = (await loadState(root)).jobs;
  for (const job of jobs) {
    assert.deepEqual(job.workflow.steps.map(step => step.key), ['ux', 'developer', 'qa', 'reviewer']);
    assert.deepEqual(job.workflow.steps.map(step => step.profile), ['ux', 'desarrollador', 'qa', 'revisor'].map(profile => `${profile}_${job.business}`));
    assert.equal(job.workflow.steps[1].label, job.business === 'games' ? 'Desarrollo de videojuegos (Godot)' : 'Implementación');
  }
  const events = (await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).patch.jobs[0].workflow.steps, jobs[1].workflow.steps);
  assert.equal(events[0].patch.jobs[0].workflow.steps[1].profile, 'desarrollador_games');
});
async function appendInterruptedStart(root) {
  const state = await loadState(root);
  const job = { ...state.jobs[0], state: 'running', attempts: 1, startedAt: new Date().toISOString() };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({
    schema: 1, revision: state.revision + 1, at: new Date().toISOString(),
    type: 'job_started', details: { jobId: job.id }, patch: { jobs: [job] },
  }) + '\n');
}

test('dry run leaves the durable queue unchanged and never invokes a worker', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  let calls = 0;
  const result = await runQueue(root, { worker: async () => { calls++; } });
  assert.equal(result.dryRun, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
});

test('job identifiers and completed jobs cannot execute twice', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await assert.rejects(addJob(root, spec()), error => error.code === 'duplicate');
  let calls = 0;
  const worker = async () => { calls++; return { text: 'Listo' }; };
  await runQueue(root, { execute: true, worker });
  await runQueue(root, { execute: true, worker });
  assert.equal(calls, 1);
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});

test('a held runner lock rejects another writer and another runner', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const lock = await acquireLock(root);
  try {
    await assert.rejects(acquireLock(root), error => error.code === 'locked');
    await assert.rejects(addJob(root, spec({ id: 'second' })), error => error.code === 'locked');
    await assert.rejects(runQueue(root, { execute: true, worker: async () => {} }), error => error.code === 'locked');
  } finally { await releaseLock(lock); }
  const replacement = await acquireLock(root);
  await releaseLock(lock);
  await assert.rejects(acquireLock(root), error => error.code === 'locked');
  await releaseLock(replacement);
});

test('concurrent runners cannot duplicate a currently executing job', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const first = runQueue(root, { execute: true, worker: async () => { calls++; started(); await hold; return { text: 'Listo' }; } });
  await running;
  try {
    await assert.rejects(runQueue(root, { execute: true, worker: async () => { calls++; } }), error => error.code === 'locked');
  } finally { finish(); }
  await first;
  assert.equal(calls, 1);
});

test('uncertain and incomplete locks stop execution until reviewed manually', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  const filename = path.join(root, 'data', 'runner.lock');
  await fs.writeFile(filename, '{incomplete');
  await assert.rejects(acquireLock(root), error => error.code === 'lock_uncertain');
  assert.equal(await fs.readFile(filename, 'utf8'), '{incomplete');
  await fs.writeFile(filename, JSON.stringify({ pid: 2_147_483_647, token: 'unsafe-token', unsafe: true }));
  await assert.rejects(acquireLock(root), error => error.code === 'lock_uncertain');
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).unsafe, true);
});

test('stale lock and interrupted execution recover to manual attention without replaying work', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await appendInterruptedStart(root);
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');
  await fs.writeFile(path.join(root, 'data', 'runner.lock'), JSON.stringify({ pid: deadPid, token: 'dead-process-token' }));
  let calls = 0;
  const blocked = await runQueue(root, { execute: true, worker: async () => { calls++; } });
  assert.deepEqual(blocked.blockedNeedsAttention, ['review-001']);
  const recovered = (await loadState(root)).jobs[0];
  assert.equal(calls, 0);
  assert.equal(recovered.state, 'needs_attention');
  assert.equal(recovered.error.code, 'interrupted');
  await addJob(root, spec({ id: 'different-job' }));
  await runQueue(root, { execute: true, worker: async () => { calls++; } });
  assert.equal(calls, 0, 'an orphaned child must be reviewed before starting other jobs');
  await assert.rejects(retryJob(root, recovered.id));
  await retryJob(root, recovered.id, { confirm: true });
  await runQueue(root, { execute: true, worker: async () => { calls++; return { text: 'Revisado' }; }, maxJobs: 1 });
  assert.equal(calls, 1);
});

test('only explicit provider exhaustion codes classify as exhausted credit', () => {
  assert.equal(isCreditExhausted({ error: { code: 'insufficient_quota' } }), true);
  assert.equal(isCreditExhausted({ error: { code: 'credit_balance_exhausted' } }), true);
  assert.equal(isCreditExhausted({ error: { code: 'rate_limit_exceeded' } }), false);
  assert.equal(isCreditExhausted({ error: { message: 'credit balance exhausted' } }), false);
  assert.equal(isCreditExhausted({ error: { code: 'invalid_api_key' } }), false);
  assert.equal(isCreditExhausted(null), false);
});

async function providerFixture(t, patch = {}) {
  const root = await fixture(t);
  await addJob(root, spec(patch));
  await setBudget(root, { limitUsd: 1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  return root;
}
const fakeEnv = { OPENAI_API_KEY: 'unit-test-key-must-never-be-persisted' };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('explicit API exhaustion falls back exactly once to the ChatGPT Codex adapter', async t => {
  const root = await providerFixture(t);
  let apiCalls = 0, codexCalls = 0;
  const worker = createWorker({
    env: fakeEnv,
    fetchImpl: async (url, request) => {
      apiCalls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(request.headers.Authorization, `Bearer ${fakeEnv.OPENAI_API_KEY}`);
      assert.deepEqual(JSON.parse(request.body).tools, []);
      return response(429, { error: { code: 'insufficient_quota' } });
    },
    runCodexImpl: async job => { codexCalls++; assert.equal(job.prompt, spec().prompt); return { provider: 'codex-chatgpt', text: 'Alternativa' }; },
  });
  await runQueue(root, { execute: true, worker });
  const state = await loadState(root);
  assert.equal(apiCalls, 1);
  assert.equal(codexCalls, 1);
  assert.equal(state.jobs[0].state, 'succeeded');
  assert.equal(state.jobs[0].result.fallbackReason, 'explicit_api_credit_exhaustion');
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0);
});

test('rate-limit, unknown 429 and authentication failures never invoke the fallback', async t => {
  for (const [code, status, expectedState] of [
    ['rate_limit_exceeded', 429, 'retry_wait'],
    ['unknown_error', 429, 'needs_attention'],
    ['invalid_api_key', 401, 'needs_attention'],
  ]) {
    const root = await providerFixture(t);
    let codexCalls = 0;
    const worker = createWorker({ env: fakeEnv,
      fetchImpl: async () => response(status, { error: { code } }),
      runCodexImpl: async () => { codexCalls++; return { text: 'Incorrect fallback' }; },
    });
    await runQueue(root, { execute: true, worker });
    assert.equal(codexCalls, 0, code);
    const state = await loadState(root);
    assert.equal(state.jobs[0].state, expectedState, code);
    assert.equal(state.budget.reservedUsd, 0);
    assert.equal(state.budget.estimatedSpentUsd, 0);
  }
});

test('API-pinned jobs stop on exhaustion and do not switch providers', async t => {
  const root = await providerFixture(t, { provider: 'api' });
  let calls = 0;
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => response(429, { error: { code: 'insufficient_quota' } }),
    runCodexImpl: async () => { calls++; return { text: 'Incorrect fallback' }; },
  }) });
  const state = await loadState(root);
  assert.equal(calls, 0);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'credit_exhausted');
});

test('successful API usage settles estimates and redacts a leaked test key from all durable output', async t => {
  const root = await providerFixture(t);
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => response(200, { status: 'completed', usage: { input_tokens: 23, output_tokens: 19 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: `Resultado ${fakeEnv.OPENAI_API_KEY}` }] }],
    }),
    runCodexImpl: async () => { throw new Error('fallback should not run'); },
  }) });
  const state = await loadState(root);
  assert.equal(state.jobs[0].state, 'succeeded');
  assert.equal(state.jobs[0].result.text, 'Resultado [CLAVE OCULTA]');
  assert.equal(state.budget.estimatedSpentUsd, 0.000061);
  for (const filename of ['events.jsonl', 'state.json']) {
    assert.equal((await fs.readFile(path.join(root, 'data', filename), 'utf8')).includes(fakeEnv.OPENAI_API_KEY), false);
  }
});

test('transport errors retain conservative estimate and require review without fallback', async t => {
  const root = await providerFixture(t);
  let codexCalls = 0;
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => { throw new Error(`Network error ${fakeEnv.OPENAI_API_KEY}`); },
    runCodexImpl: async () => { codexCalls++; },
  }) });
  const state = await loadState(root);
  assert.equal(codexCalls, 0);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'api_transport_error');
  assert.ok(state.budget.estimatedSpentUsd > 0);
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal((await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).includes(fakeEnv.OPENAI_API_KEY), false);
});

test('timeout helper aborts the operation and labels the outcome uncertain', async () => {
  let aborted = false;
  const started = Date.now();
  await assert.rejects(withTimeout(signal => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }), 20), error => error.code === 'timeout' && error.uncertain === true && error.retryable === false);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1_000);
});

test('code workspace validation rejects outside paths, linked metadata and missing isolation confirmation', async t => {
  const root = await fixture(t);
  const workspaces = path.join(root, 'workspaces');
  const checkout = path.join(workspaces, 'separate-checkout');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await fs.mkdir(path.join(outside, '.git'), { recursive: true });
  assert.equal(await validateWorkspace({ workspace: checkout, isolated: true }, root), await fs.realpath(checkout));
  await assert.rejects(validateWorkspace({ workspace: outside, isolated: true }, root), error => error.code === 'unsafe_workspace');
  await assert.rejects(validateWorkspace({ workspace: checkout, isolated: false }, root), error => error.code === 'unsafe_workspace');
  await fs.rm(path.join(checkout, '.git'), { recursive: true });
  await fs.writeFile(path.join(checkout, '.git'), 'gitdir: shared-active-metadata');
  await assert.rejects(validateWorkspace({ workspace: checkout, isolated: true }, root), error => error.code === 'unsafe_workspace');
});

test('ledger recovers an outdated/broken snapshot and trims only an incomplete final record', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await fs.writeFile(path.join(root, 'data', 'state.json'), '{snapshot broken');
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), '{"revision":2,"partial":');
  assert.equal((await loadState(root)).jobs[0].id, 'review-001');
  await addJob(root, spec({ id: 'review-002', business: 'agency' }));
  const state = await loadState(root);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.revision, 2);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), '{bad complete record}\n');
  await assert.rejects(loadState(root), error => error.code === 'ledger_corrupt');
});

test('explicit rejected requests back off and stop at the maximum attempt count', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxAttempts: 2 }));
  const start = Date.now();
  let calls = 0;
  const worker = async () => { calls++; throw Object.assign(new Error('rejected'), { code: 'rate_limit', retryable: true }); };
  await runQueue(root, { execute: true, worker, now: start, clock: () => start });
  assert.equal((await loadState(root)).jobs[0].state, 'retry_wait');
  await runQueue(root, { execute: true, worker, now: start + 29_999, clock: () => start + 29_999 });
  assert.equal(calls, 1);
  await runQueue(root, { execute: true, worker, now: start + 30_000, clock: () => start + 30_000 });
  const exhausted = (await loadState(root)).jobs[0];
  assert.equal(calls, 2);
  assert.equal(exhausted.state, 'needs_attention');
  assert.equal(exhausted.attempts, 2);
  await assert.rejects(retryJob(root, exhausted.id, { confirm: true }));
});

test('retry backoff starts when a slow request is rejected, not when the runner starts', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxAttempts: 2 }));
  const start = 1_700_000_000_000;
  let current = start;
  const clock = () => current;
  let calls = 0;
  const worker = async () => {
    calls++;
    if (calls === 1) {
      current += 120_000;
      throw Object.assign(new Error('request rejected after a long wait'), { code: 'rate_limit', retryable: true });
    }
    return { text: 'Reintento completado' };
  };
  await runQueue(root, { execute: true, worker, clock });
  const waiting = (await loadState(root)).jobs[0];
  assert.equal(waiting.state, 'retry_wait');
  assert.equal(Date.parse(waiting.nextAttemptAt), start + 120_000 + 30_000);
  current = start + 149_999;
  await runQueue(root, { execute: true, worker, clock });
  assert.equal(calls, 1);
  assert.equal((await loadState(root)).jobs[0].state, 'retry_wait');
  current += 1;
  await runQueue(root, { execute: true, worker, clock });
  assert.equal(calls, 2);
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});

test('uncertain failures always require operator review even when marked retryable', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const worker = async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', retryable: true, uncertain: true }); };
  await runQueue(root, { execute: true, worker });
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  await runQueue(root, { execute: true, worker });
  assert.equal((await loadState(root)).jobs[0].attempts, 1);
});

test('budget reservations block concurrent overspend and ledger preserves estimates', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxUsd: 0.1 }));
  await setBudget(root, { limitUsd: 0.1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reserve(0.08);
    await assert.rejects(ctx.reserve(0.03), error => error.code === 'budget_limit');
    await ctx.settle(0.04);
    return { text: 'Hecho' };
  } });
  const state = await loadState(root);
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0.04);
  assert.equal(state.jobs[0].estimatedUsd, 0.04);
});

test('simultaneous reservations cannot bypass the remaining budget', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxUsd: 0.1 }));
  await setBudget(root, { limitUsd: 0.06, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  let outcomes;
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    outcomes = await Promise.allSettled([ctx.reserve(0.04), ctx.reserve(0.04)]);
    await ctx.settle(0.04);
    return { text: 'Hecho' };
  } });
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'budget_limit');
  assert.equal((await loadState(root)).budget.estimatedSpentUsd, 0.04);
});

test('worker timeout is bounded, charges the reservation conservatively and closes the old context', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ timeoutMs: 150, maxAttempts: 2 }));
  await setBudget(root, { limitUsd: 0.1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  let oldContext;
  let aborted = false;
  const started = Date.now();
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    oldContext = ctx;
    ctx.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await ctx.reserve(0.08);
    await new Promise(() => {});
  } });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(aborted, true);
  const state = await loadState(root);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'timeout');
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0.08);
  assert.equal(state.jobs[0].costUncertain, true);
  await assert.rejects(oldContext.reserve(0.01), error => error.code === 'attempt_closed');
  await assert.rejects(oldContext.settle(0), error => error.code === 'attempt_closed');
  await retryJob(root, 'review-001', { confirm: true });
  await runQueue(root, { execute: true, worker: async () => ({ text: 'Revisado' }) });
  assert.equal((await loadState(root)).jobs[0].attempts, 2);
});

test('a late worker response cannot bypass timeout cleanup or become a success', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ timeoutMs: 30 }));
  let cleaned = false;
  await runQueue(root, { execute: true, worker: (_job, ctx) => {
    ctx.registerCleanup(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      cleaned = true;
    });
    return new Promise(resolve => {
      ctx.signal.addEventListener('abort', () => resolve({ text: 'Late result after the deadline' }), { once: true });
    });
  } });
  assert.equal(cleaned, true);
  const job = (await loadState(root)).jobs[0];
  assert.equal(job.state, 'needs_attention');
  assert.equal(job.error.code, 'timeout');
});

test('manual retry preserves an interrupted stage checkpoint and its dispatch', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_dev01', summary: 'Code ready' });
    await ctx.reportStage({ key: 'reviewer', status: 'blocked', runId: 'run_abcdef', dispatchId: 'ctx_rev01', dispatchStatus: 'active', error: 'interrupted' });
    throw Object.assign(new Error('runner stopped'), { code: 'interrupted', uncertain: true });
  } });
  const before = (await loadState(root)).jobs[0];
  assert.equal(before.state, 'needs_attention');
  const resumed = await retryJob(root, before.id, { confirm: true });
  assert.equal(resumed.state, 'queued');
  assert.equal(resumed.workflow.runId, 'run_abcdef');
  assert.equal(resumed.workflow.steps[0].status, 'succeeded');
  assert.equal(resumed.workflow.steps[1].status, 'succeeded');
  assert.equal(resumed.workflow.steps[3].dispatchId, 'ctx_rev01');
  assert.equal(resumed.workflow.steps[3].dispatchStatus, 'active');
  assert.equal(resumed.workflowHistory.length, 1);
});

test('manual retry restarts only the confirmed failed stage and preserves completed work', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_dev01', summary: 'Code ready' });
    await ctx.reportStage({ key: 'qa', status: 'failed', runId: 'run_abcdef', dispatchId: 'ctx_qa001', dispatchStatus: 'failed', summary: 'QA worker failed' });
    throw Object.assign(new Error('known worker failure'), { code: 'orca_worker_failed', uncertain: true });
  } });
  const failed = (await loadState(root)).jobs[0];
  const retry = await retryJob(root, failed.id, { confirm: true });
  assert.equal(retry.workflow.steps[0].status, 'succeeded');
  assert.equal(retry.workflow.steps[1].status, 'succeeded');
  assert.equal(retry.workflow.steps[2].status, 'queued');
  assert.equal(retry.workflow.steps[2].dispatchId, undefined);
  assert.equal(retry.workflow.steps[3].status, 'queued');
  assert.equal(retry.workflowHistory.length, 1);
});

test('manual retry refuses to relaunch an interrupted stage without a confirmed dispatch', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'blocked', runId: 'run_abcdef', dispatchStatus: 'unknown', error: 'interrupted' });
    throw Object.assign(new Error('launch outcome unknown'), { code: 'interrupted', uncertain: true });
  } });
  const failed = (await loadState(root)).jobs[0];
  await assert.rejects(retryJob(root, failed.id, { confirm: true }), error => error.code === 'dispatch_unknown');
  const unchanged = (await loadState(root)).jobs[0];
  assert.equal(unchanged.state, 'needs_attention');
  assert.equal(unchanged.attempts, 1);
  assert.equal(unchanged.workflow.steps[1].dispatchId, undefined);
});
