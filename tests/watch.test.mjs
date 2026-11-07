import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from '../watch.mjs';

// All watcher collaborators are fakes. This path is never opened or created.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch-no-disk-access');
const HOUR = 3_600_000;
const queuedJob = { id: 'watch-job', kind: 'analysis', provider: 'codex', state: 'queued', attempts: 0, maxAttempts: 2 };

function harness({ jobs = [queuedJob], isPaused = false, advanceMs = 5_000, workerImpl, outcomeState = 'retry_wait' } = {}) {
  let current = 1_700_000_000_000;
  const counts = { load: 0, paused: 0, workers: 0, workerCalls: 0, dispatches: 0, sleeps: 0 };
  const events = [];
  const deps = {
    clock: () => current,
    loadState: async root => {
      assert.equal(root, ROOT);
      counts.load++;
      return { schema: 1, revision: 1, jobs, budget: {} };
    },
    paused: async root => {
      assert.equal(root, ROOT);
      counts.paused++;
      return isPaused;
    },
    createWorker: () => {
      counts.workers++;
      return async (job, ctx) => {
        counts.workerCalls++;
        if (workerImpl) return workerImpl(job, ctx);
        throw Object.assign(new Error('simulated rate-limit rejection'), { code: 'rate_limit', retryable: true });
      };
    },
    runQueue: async (root, options) => {
      assert.equal(root, ROOT);
      if (!options.execute) return { dryRun: true, jobs, budget: {} };
      counts.dispatches++;
      assert.equal(options.maxJobs, 1, 'each iteration must be limited to one job');
      assert.equal(typeof options.worker, 'function');
      // Model queue's invocation of the wrapped worker and durable failure result.
      try { await options.worker(queuedJob, { signal: new AbortController().signal }); }
      catch { /* simulated worker failure is represented in the returned job state */ }
      return { dryRun: false, jobs: [{ ...queuedJob, state: outcomeState, attempts: 1 }], budget: {} };
    },
    sleep: async (_ms, signal) => {
      counts.sleeps++;
      if (signal?.aborted) throw signal.reason;
      current += advanceMs;
    },
  };
  return { deps, counts, events, onEvent: event => { events.push(event); }, advance: ms => { current += ms; } };
}

test('paused watcher never constructs or dispatches an AI worker', async () => {
  const h = harness({ isPaused: true, advanceMs: HOUR });
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3, onEvent: h.onEvent }, h.deps);
  assert.equal(h.counts.workers, 0);
  assert.equal(h.counts.dispatches, 0);
  assert.equal(result.attempts, 0);
  assert.equal(typeof result.reason, 'string');
});

test('idle watcher does not instantiate or dispatch AI workers', async () => {
  const h = harness({ jobs: [], advanceMs: HOUR });
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3 }, h.deps);
  assert.equal(h.counts.workers, 0);
  assert.equal(h.counts.dispatches, 0);
  assert.equal(result.attempts, 0);
});

test('failed job attempts count toward the watcher dispatch cap', async () => {
  const h = harness();
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3 }, h.deps);
  assert.equal(h.counts.dispatches, 3);
  assert.equal(h.counts.workerCalls, 3);
  assert.equal(result.attempts, 3);
  assert.ok(h.counts.workers >= 1);
  assert.equal(typeof result.reason, 'string');
});

test('needs_attention stops the watcher after one failed attempt', async () => {
  const h = harness({ outcomeState: 'needs_attention', workerImpl: async () => {
    throw Object.assign(new Error('simulated uncertain worker failure'), { code: 'codex_failed', uncertain: true });
  } });
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3 }, h.deps);
  assert.equal(h.counts.workerCalls, 1);
  assert.equal(h.counts.dispatches, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.reason, 'needs_attention');
});

test('external cancellation reaches the active worker and stops further dispatches', async () => {
  const stop = new AbortController();
  let workerSignal;
  const h = harness({ workerImpl: async (_job, ctx) => {
    workerSignal = ctx.signal;
    stop.abort();
    assert.equal(ctx.signal.aborted, true);
    throw ctx.signal.reason;
  } });
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3, signal: stop.signal }, h.deps);
  assert.equal(workerSignal.aborted, true);
  assert.equal(result.reason, 'signal');
  assert.equal(h.counts.workerCalls, 1);
  assert.equal(h.counts.dispatches, 1);
  assert.equal(result.attempts, 1);
});

test('dry run never constructs or dispatches an AI worker even with queued jobs', async () => {
  const h = harness({ advanceMs: HOUR });
  const result = await watch({ root: ROOT, hours: 1, maxJobs: 3 }, h.deps);
  assert.equal(h.counts.workers, 0);
  assert.equal(h.counts.dispatches, 0);
  assert.equal(result.attempts, 0);
});

test('wall clock limit stops an idle watcher instead of polling forever', async () => {
  const h = harness({ jobs: [], advanceMs: HOUR });
  const result = await watch({ root: ROOT, execute: true, hours: 1, maxJobs: 10 }, h.deps);
  assert.ok(result.elapsedMs >= HOUR);
  assert.equal(h.counts.sleeps, 1);
  assert.equal(h.counts.dispatches, 0);
});

test('invalid watcher duration and attempt bounds are rejected before collaborators run', async () => {
  for (const patch of [
    { hours: 0 }, { hours: -1 }, { hours: NaN }, { hours: Infinity },
    { maxJobs: 0 }, { maxJobs: -1 }, { maxJobs: 1.5 }, { maxJobs: NaN },
  ]) {
    const h = harness();
    await assert.rejects(watch({ root: ROOT, execute: true, hours: 1, maxJobs: 3, ...patch }, h.deps));
    assert.equal(h.counts.workers, 0);
    assert.equal(h.counts.dispatches, 0);
  }
});
