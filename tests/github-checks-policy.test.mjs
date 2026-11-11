import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { integrateGitHub, diffFingerprint, DEFAULT_CHECKS_TIMEOUT_MS, DEFAULT_NO_CHECKS_GRACE_MS } from '../github-integration.mjs';

// Improvement 17: bounded default wait for checks and an actionable no_checks state.
const head = 'a'.repeat(40), base = 'b'.repeat(40);
async function fixture(t, { checks = [], mergeable = 'MERGEABLE' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-policy-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const state = { head, remoteSource: head, pr: null, checks, mergeable, views: 0, merges: 0, records: [] };
  const git = async args => {
    if (args[0] === 'remote') return 'https://github.com/owner/repo.git';
    if (args[0] === 'symbolic-ref') return 'feature';
    if (args[0] === 'check-ref-format') return args[2];
    if (args[0] === 'config') return 'Name <name@example.test>';
    if (args[0] === 'status') return ' M src/app.js';
    if (args[0] === 'diff') return 'diff --binary fixture';
    if (args[0] === 'rev-parse') return state.head;
    if (args[0] === 'ls-remote') return `${args.at(-1) === 'feature' ? state.remoteSource : base}\trefs/heads/${args.at(-1)}`;
    if (args[0] === 'rev-list') return '0';
    if (args[0] === 'ls-files') return '';
    if (args[0] === 'add') return '';
    if (args[0] === 'commit') { state.head = 'd'.repeat(40); return ''; }
    if (args[0] === 'push') { state.remoteSource = state.head; if (state.pr) state.pr.headRefOid = state.head; return 'ok'; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const identity = { isCrossRepository: false, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'owner' }, headRefName: 'feature', baseRefName: 'main', state: 'OPEN' };
  const gh = async args => {
    if (args[0] === 'api') return 'owner';
    if (args[1] === 'list') return JSON.stringify(state.pr ? [{ ...identity, ...state.pr }] : []);
    if (args[1] === 'create') { state.pr = { number: 4, url: 'https://github.com/owner/repo/pull/4', headRefOid: state.head, baseRefOid: base }; return ''; }
    if (args[1] === 'view') {
      if (state.merged) return JSON.stringify({ ...identity, ...state.pr, state: 'MERGED', mergedAt: '2026-11-10T00:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, headRefOid: state.head, baseRefOid: base });
      state.views++; return JSON.stringify({ ...identity, ...state.pr, state: state.pr.state || 'OPEN', mergeable: state.mergeable, statusCheckRollup: typeof state.checks === 'function' ? state.checks(state.views) : state.checks, headRefOid: state.head, baseRefOid: base });
    }
    if (args[1] === 'merge') { state.merges++; state.merged = true; return ''; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const snapshot = diffFingerprint(' M src/app.js', 'diff --binary fixture', 'diff --binary fixture');
  const job = { id: 'job-checks', state: 'running', title: 'Checks policy', autoIntent: { eligible: true, receiptId: 'receipt-checks' }, workspace, branch: 'feature', destination: { repository: 'owner/repo', baseBranch: 'main', remoteSha: head, baseSha: base }, integrationSnapshot: snapshot };
  let time = 1_000_000; const waits = [];
  const options = { git, gh, persist: async value => state.records.push(value), clock: () => time, wait: async ms => { waits.push(ms); time += ms; } };
  return { state, job, ctx: { root, reportStage: async () => {} }, options, waits, advance: ms => { time += ms; } };
}

test('a mergeable PR still without any check after the grace stops with github_no_checks before the timeout and never merges', async t => {
  const f = await fixture(t);
  const error = await integrateGitHub(f.job, f.ctx, f.options).then(() => assert.fail('must stop'), error => error);
  assert.equal(error.code, 'github_no_checks'); assert.match(error.message, /no tiene checks registrados/); assert.match(error.message, /pull\/4/);
  assert.equal(f.waits.reduce((sum, ms) => sum + ms, 0), DEFAULT_NO_CHECKS_GRACE_MS); assert.equal(DEFAULT_NO_CHECKS_GRACE_MS, 600_000);
  assert.equal(f.state.merges, 0);
  const last = f.state.records.at(-1);
  assert.equal(last.phase, 'checks_pending'); assert.equal(last.checkState, 'no_checks'); assert.equal(last.error, 'La PR no tiene checks registrados.'); assert.equal(last.prNumber, 4);
  assert.equal(last.waitTimedOut, undefined);
  // A shorter grace is honoured; a null grace falls back to the generic timeout.
  const quick = await fixture(t);
  await assert.rejects(integrateGitHub(quick.job, quick.ctx, { ...quick.options, noChecksGraceMs: 30_000 }), { code: 'github_no_checks' });
  assert.equal(quick.waits.reduce((sum, ms) => sum + ms, 0), 30_000);
  const legacy = await fixture(t);
  await assert.rejects(integrateGitHub(legacy.job, legacy.ctx, { ...legacy.options, noChecksGraceMs: null, checksTimeoutMs: DEFAULT_CHECKS_TIMEOUT_MS }), { code: 'github_checks_timeout' });
});

test('a check that registers late is awaited and merged; pending checks are awaited without a global limit unless a bound is passed', async t => {
  const late = await fixture(t, { checks: views => views < 10 ? [] : [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const record = await integrateGitHub(late.job, late.ctx, late.options);
  assert.equal(record.phase, 'complete'); assert.equal(late.state.merges, 1); assert.equal(late.state.records.some(item => item.checkState === 'no_checks'), false);
  assert.equal(DEFAULT_CHECKS_TIMEOUT_MS, 900_000);
  // Owner's choice (revised 17): by default a running check keeps the same PR and commit under watch.
  const running = await fixture(t, { checks: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }] });
  const stop = new AbortController(); let polls = 0, elapsed = 0; const intervals = new Set();
  const watched = integrateGitHub(running.job, { ...running.ctx, signal: stop.signal }, { ...running.options, wait: async ms => {
    running.advance(ms); elapsed += ms; intervals.add(ms); if (++polls === 300) stop.abort(new Error('stop watching')); } });
  await assert.rejects(watched, /stop watching/);
  assert.ok(elapsed >= 300 * 15_000 - 15_000, `still polling after ${elapsed} ms (about 75 minutes), no timeout`);
  assert.deepEqual([...intervals], [15_000], 'normal interval, never a tight loop after the no_checks grace');
  assert.equal(running.state.merges, 0);
  assert.ok(running.state.records.every(item => item.prNumber === undefined || item.prNumber === 4));
  assert.equal(running.state.records.at(-1).checkState, 'waiting'); assert.equal(running.state.records.at(-1).waitTimedOut, undefined);
  const pending = await fixture(t, { checks: [{ name: 'ci', status: 'IN_PROGRESS', conclusion: null }] });
  const error = await integrateGitHub(pending.job, pending.ctx, { ...pending.options, checksTimeoutMs: DEFAULT_CHECKS_TIMEOUT_MS }).then(() => assert.fail('must time out'), error => error);
  assert.equal(error.code, 'github_checks_timeout');
  assert.equal(pending.waits.reduce((sum, ms) => sum + ms, 0), DEFAULT_CHECKS_TIMEOUT_MS);
  assert.equal(pending.state.records.at(-1).checkState, 'waiting'); assert.equal(pending.state.records.at(-1).waitTimedOut, true);
  assert.equal(pending.state.merges, 0);
});

test('a PR the owner merges by hand while the Centro waits for checks is recorded as integrated, without a second merge', async t => {
  const f = await fixture(t);
  // No CI: the owner merges during the wait.
  f.options.wait = async ms => { f.advance(ms); f.state.merged = true; };
  const record = await integrateGitHub(f.job, f.ctx, f.options);
  assert.equal(record.phase, 'complete'); assert.equal(record.status, 'completed');
  assert.equal(record.mergedBy, 'owner'); assert.equal(record.reconciled, true);
  assert.equal(record.mergeSha, 'c'.repeat(40)); assert.equal(record.prNumber, 4);
  assert.equal(f.state.merges, 0, 'the Centro never merges on top of the owner');
});

test('decision on GitHub: the Centro opens the PR and never merges it; the owner merge completes it and closing it rejects', async t => {
  // No CI: no no_checks stop, the PR just waits for the owner.
  const noCi = await fixture(t);
  let polls = 0;
  const record = await integrateGitHub(noCi.job, noCi.ctx, { ...noCi.options, ownerMerges: true, wait: async ms => { noCi.advance(ms); if (++polls === 60) noCi.state.merged = true; } });
  assert.equal(record.phase, 'complete'); assert.equal(record.mergedBy, 'owner'); assert.equal(noCi.state.merges, 0, 'the Centro never merges');
  assert.ok(polls >= 60, 'it kept waiting past the 10 minute no_checks grace');
  assert.ok(noCi.state.records.some(item => item.checkState === 'awaiting_owner'));
  assert.equal(noCi.state.records.some(item => item.checkState === 'no_checks'), false);
  // Green CI is not a merge either.
  const green = await fixture(t, { checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  let greenPolls = 0;
  await integrateGitHub(green.job, green.ctx, { ...green.options, ownerMerges: true, wait: async ms => { green.advance(ms); if (++greenPolls === 3) green.state.merged = true; } });
  assert.equal(green.state.merges, 0);
  // Closing the PR is the rejection.
  const closed = await fixture(t);
  let closedPolls = 0;
  const error = await integrateGitHub(closed.job, closed.ctx, { ...closed.options, ownerMerges: true, wait: async ms => { closed.advance(ms); if (++closedPolls === 2) closed.state.pr.state = 'CLOSED'; } }).catch(failure => failure);
  assert.equal(error.code, 'github_checks_blocked'); assert.match(error.message, /Cerraste la PR sin fusionarla/);
  assert.equal(closed.state.merges, 0);
});
