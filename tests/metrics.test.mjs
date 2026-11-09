import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aggregateMetrics, readMetrics } from '../metrics.mjs';
import { summarizeCodexUsage } from '../providers.mjs';

const time = seconds => new Date(Date.parse('2026-11-08T12:00:00Z') + seconds * 1000).toISOString();
const job = (patch = {}) => ({ id: 'metrics-fixture', business: 'games', provider: 'orca', attempts: 1, state: 'running', ...patch });
const event = (revision, type, seconds, value, details = {}) => ({ schema: 1, revision, type, at: time(seconds), details, patch: { jobs: [value] } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'centro-metrics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  return root;
}

test('Codex token totals include every completed turn and missing coverage stays null', () => {
  assert.deepEqual(summarizeCodexUsage([{ input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }, { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3 }]),
    { completedTurns: 2, measuredTurns: 2, inputTokens: 30, cachedInputTokens: 9, outputTokens: 5 });
  assert.deepEqual(summarizeCodexUsage([{ input_tokens: 10, output_tokens: 2 }, null]),
    { completedTurns: 2, measuredTurns: 1, inputTokens: null, cachedInputTokens: null, outputTokens: null });
  assert.deepEqual(summarizeCodexUsage([{ input_tokens: 0, output_tokens: 0 }]),
    { completedTurns: 1, measuredTurns: 1, inputTokens: 0, cachedInputTokens: null, outputTokens: 0 });
  assert.deepEqual(summarizeCodexUsage([]),
    { completedTurns: 0, measuredTurns: 0, inputTokens: null, cachedInputTokens: null, outputTokens: null });
});

test('repeated stage checkpoints and attempt histories do not multiply cumulative Orca counters', () => {
  const running = job();
  const checkpoint = calls => job({ workflow: { steps: [{ key: 'ux', metrics: { orcaCliCalls: calls, dispatchStarts: 1, polls: calls - 1 } }] } });
  const complete = job({ state: 'succeeded', result: { provider: 'orca', metrics: { orcaCliCalls: 5, dispatchStarts: 1, polls: 3 } },
    attemptHistory: [{ attempt: 1, startedAt: time(0), finishedAt: time(10), elapsedMs: 10000, outcome: 'succeeded', metrics: { orcaCliCalls: 5, dispatchStarts: 1, polls: 3 } }] });
  const events = [event(1, 'job_started', 0, running), event(2, 'job_stage_updated', 2, checkpoint(2), { stage: 'ux' }),
    event(3, 'job_stage_updated', 5, checkpoint(4), { stage: 'ux' }), event(4, 'job_succeeded', 10, complete)];
  const report = aggregateMetrics({ events, state: { revision: 4, jobs: [complete] } });
  assert.equal(report.attempts.total, 1);
  assert.equal(report.attempts.metrics.orcaCliCalls.total, 5);
  assert.equal(report.attempts.metrics.polls.total, 3);
  assert.equal(report.attempts.timing.totalMs, 10000);
});

test('failed attempt checkpoints remain partial and old result tokens are not attributed to a retry', () => {
  const first = job({ provider: 'codex', state: 'succeeded', result: { provider: 'codex-chatgpt', inputTokens: 120, outputTokens: 15 } });
  const second = job({ provider: 'codex', attempts: 2, state: 'needs_attention', error: { code: 'worker_error' }, result: first.result });
  const events = [event(1, 'job_started', 0, job({ provider: 'codex' })), event(2, 'job_succeeded', 2, first),
    event(3, 'job_started', 10, { ...second, state: 'running' }), event(4, 'operator_required', 12, second)];
  const report = aggregateMetrics({ events, state: { jobs: [second], revision: 4 } });
  assert.equal(report.attempts.metrics.inputTokens.total, null);
  assert.equal(report.attempts.metrics.inputTokens.observedTotal, 120);
  assert.equal(report.attempts.metrics.inputTokens.measuredAttempts, 1);
  assert.equal(report.records[1].measurements.inputTokens, undefined);

  const blocked = job({ state: 'needs_attention', workflow: { steps: [{ key: 'ux', metrics: { orcaCliCalls: 3, polls: 1 } }] } });
  const partial = aggregateMetrics({ events: [event(1, 'job_started', 0, job()), event(2, 'job_stage_updated', 2, blocked, { stage: 'ux' }), event(3, 'operator_required', 3, blocked)], state: { jobs: [blocked] } });
  assert.equal(partial.attempts.metrics.orcaCliCalls.observedTotal, 3);
  assert.equal(partial.attempts.metrics.orcaCliCalls.total, null);
  assert.equal(partial.attempts.metrics.orcaCliCalls.completeAttempts, 0);
});

test('unknown measurements differ from measured zero and coverage is explicit', () => {
  const orca = job({ state: 'succeeded' });
  const codex = job({ id: 'codex-fixture', provider: 'codex', state: 'succeeded', result: { provider: 'codex-chatgpt', inputTokens: 0, outputTokens: 0 } });
  const events = [event(1, 'job_started', 0, orca), event(2, 'job_succeeded', 1, orca), event(3, 'job_started', 2, codex), event(4, 'job_succeeded', 3, codex)];
  const report = aggregateMetrics({ events, state: { jobs: [orca, codex] } });
  assert.deepEqual(report.attempts.metrics.inputTokens, { total: null, observedTotal: 0, measuredAttempts: 1, completeAttempts: 1, eligibleAttempts: 2 });
  assert.equal(report.attempts.metrics.modelCalls.observedTotal, null);
});

test('operator corrections do not inflate attempt timing and recovered intervals stay separate', () => {
  const completed = job({ state: 'succeeded', finishedAt: time(2) });
  const corrected = { ...completed, state: 'cancelled', finishedAt: time(86400), error: { code: 'false_success_retracted' } };
  const interrupted = job({ id: 'interrupted', state: 'needs_attention', finishedAt: time(600) });
  const events = [event(1, 'job_started', 0, completed), event(2, 'job_succeeded', 2, completed), event(3, 'job_started', 3, interrupted),
    event(4, 'interrupted_jobs_recovered', 600, interrupted), event(5, 'false_success_retracted', 86400, corrected)];
  const report = aggregateMetrics({ events, state: { jobs: [corrected, interrupted] } });
  assert.equal(report.records.find(record => record.jobId === completed.id).elapsedMs, 2000);
  assert.equal(report.attempts.timing.observedMs, 2000);
  assert.equal(report.attempts.timing.totalMs, null);
  assert.equal(report.attempts.timing.recoveryIntervalsMs, 597000);
  assert.equal(report.events.reportedFalseSuccesses, 1);
  assert.equal(report.jobs.byState.cancelled, 1);
  assert.equal(report.attempts.byOutcome.succeeded, 1);
});

test('CLI uses ledger over stale snapshot, reports torn tail and never rewrites source files', async t => {
  const root = await fixture(t);
  const completed = job({ state: 'succeeded' });
  const events = [event(1, 'job_started', 0, job()), event(2, 'job_succeeded', 4, completed)];
  const ledgerPath = path.join(root, 'data', 'events.jsonl');
  const snapshotPath = path.join(root, 'data', 'state.json');
  const ledger = events.map(value => JSON.stringify(value) + '\n').join('') + '{"partial":';
  const snapshot = JSON.stringify({ revision: 1, jobs: [job()] });
  await fs.writeFile(ledgerPath, ledger);
  await fs.writeFile(snapshotPath, snapshot);
  const before = await Promise.all([fs.stat(ledgerPath), fs.stat(snapshotPath)]);
  const report = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../metrics.mjs', import.meta.url)), '--root', root], { encoding: 'utf8', windowsHide: true }));
  assert.equal(report.source.kind, 'ledger');
  assert.equal(report.source.snapshotStatus, 'differs');
  assert.equal(report.source.ignoredTrailingBytes, Buffer.byteLength('{"partial":'));
  assert.equal(report.jobs.byState.succeeded, 1);
  assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledger);
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), snapshot);
  const after = await Promise.all([fs.stat(ledgerPath), fs.stat(snapshotPath)]);
  assert.deepEqual(after.map(stat => stat.mtimeMs), before.map(stat => stat.mtimeMs));
  assert.deepEqual((await fs.readdir(path.join(root, 'data'))).sort(), ['events.jsonl', 'state.json']);
});

test('snapshot-only fallback uses attempt history and leaves uncorrelated dates/tokens unknown', async t => {
  const root = await fixture(t);
  const snapshot = { revision: 12, jobs: [job({ attempts: 2, state: 'cancelled', startedAt: time(0), finishedAt: time(86400),
    result: { inputTokens: 900 }, attemptHistory: [{ attempt: 1, elapsedMs: 3000, outcome: 'needs_attention', metrics: { orcaCliCalls: 2 } }] })] };
  await fs.writeFile(path.join(root, 'data', 'state.json'), JSON.stringify(snapshot));
  const report = await readMetrics(root);
  assert.equal(report.source.kind, 'snapshot');
  assert.equal(report.attempts.total, 2);
  assert.equal(report.attempts.timing.observedMs, 3000);
  assert.equal(report.attempts.timing.unknownAttempts, 1);
  assert.equal(report.attempts.metrics.inputTokens.observedTotal, null);
});

test('invalid ledger is rejected without repair and empty folders report no invented data', async t => {
  const root = await fixture(t);
  const empty = await readMetrics(root);
  assert.equal(empty.attempts.total, 0);
  assert.equal(empty.attempts.metrics.inputTokens.total, null);
  const file = path.join(root, 'data', 'events.jsonl');
  const raw = JSON.stringify(event(2, 'job_started', 0, job())) + '\n';
  await fs.writeFile(file, raw);
  await assert.rejects(readMetrics(root), /inconsistente/);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});
