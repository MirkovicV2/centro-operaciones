import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { integrateGitHub, diffFingerprint, createIntegrationCommandAdapters, actionsRunsAsChecks, checksPermissionDenied } from '../github-integration.mjs';

// Improvement 38: with a fine-grained token statusCheckRollup is denied (check runs need the Checks
// permission). Only then the integration reads the Actions runs of the exact head, through the real adapter.
const base = 'b'.repeat(40);
const denied = 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0)';
const run = (id, extra = {}) => ({ id, workflow_id: 7, event: 'pull_request', name: 'ci', status: 'completed', conclusion: 'success', ...extra });

async function fixture(t, { rollup = 'denied', runs = () => [], viewError = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-actions-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const state = { head: 'a'.repeat(40), remoteSource: 'a'.repeat(40), pr: null, merged: false, merges: 0, rollupCalls: 0, actionsCalls: 0, records: [] };
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
    if (['ls-files', 'add'].includes(args[0])) return '';
    if (args[0] === 'commit') { state.head = 'd'.repeat(40); return ''; }
    if (args[0] === 'push') { state.remoteSource = state.head; if (state.pr) state.pr.headRefOid = state.head; return 'ok'; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const identity = { isCrossRepository: false, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'owner' }, headRefName: 'feature', baseRefName: 'main', state: 'OPEN' };
  const fail = text => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(text) }); };
  const answer = async (exe, args) => {
    const out = value => ({ stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
    if (args[0] === 'api' && args[1] === 'user') return out('owner');
    if (args[0] === 'api' && args.includes(`repos/owner/repo/actions/runs`)) {
      assert.ok(args.includes(`head_sha=${state.head}`));
      state.actionsCalls++; const workflow_runs = runs(state.actionsCalls, state.head);
      return out({ total_count: workflow_runs.length, workflow_runs });
    }
    if (args[1] === 'list') return out(state.pr ? [{ ...identity, ...state.pr }] : []);
    if (args[1] === 'create') { state.pr = { number: 5, url: 'https://github.com/owner/repo/pull/5', headRefOid: state.head, baseRefOid: base }; return out(''); }
    if (args[1] === 'view') {
      if (state.merged) return out({ ...identity, ...state.pr, state: 'MERGED', mergedAt: '2026-11-10T00:00:00Z', mergeCommit: { oid: 'c'.repeat(40) }, headRefOid: state.head, baseRefOid: base });
      const fields = args[args.indexOf('--json') + 1];
      if (fields.includes('statusCheckRollup')) {
        state.rollupCalls++;
        if (viewError) fail(viewError);
        if (rollup === 'denied') fail(denied);
        return out({ ...identity, ...state.pr, state: 'OPEN', mergeable: 'MERGEABLE', statusCheckRollup: rollup, headRefOid: state.head, baseRefOid: base });
      }
      return out({ ...identity, ...state.pr, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: state.head, baseRefOid: base });
    }
    if (args[1] === 'merge') { state.merges++; state.merged = true; return out(''); }
    throw new Error(`unexpected ${exe} ${args.join(' ')}`);
  };
  const { gh } = createIntegrationCommandAdapters({ executeCommand: answer });
  const job = { id: 'job-actions', state: 'running', title: 'Checks via Actions', autoIntent: { eligible: true, receiptId: 'receipt-actions' }, workspace, branch: 'feature',
    destination: { repository: 'owner/repo', baseBranch: 'main', remoteSha: 'a'.repeat(40), baseSha: base },
    integrationSnapshot: diffFingerprint(' M src/app.js', 'diff --binary fixture', 'diff --binary fixture') };
  let time = 1_000_000;
  const options = { git, gh, persist: async value => state.records.push(value), clock: () => time, wait: async ms => { time += ms; } };
  return { state, job, ctx: { root, reportStage: async () => {} }, options };
}

test('with a fine-grained token the checks come from Actions for the exact head and the PR merges when they pass', async t => {
  const f = await fixture(t, { runs: (call, head) => [run(1, { head_sha: head, status: call < 3 ? 'in_progress' : 'completed', conclusion: call < 3 ? null : 'success' }),
    run(2, { head_sha: 'f'.repeat(40), conclusion: 'failure' })] });
  const record = await integrateGitHub(f.job, f.ctx, f.options);
  assert.equal(record.phase, 'complete'); assert.equal(f.state.merges, 1);
  assert.equal(record.checksSource, 'actions'); assert.equal(record.checkState, 'passed');
  assert.deepEqual(record.checks, [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]);
  assert.equal(f.state.rollupCalls, 1, 'statusCheckRollup is tried once; the record then stays on Actions');
  assert.ok(f.state.records.some(item => item.phase === 'checks_pending' && item.checkState === 'waiting' && item.checksSource === 'actions'));
});

test('a failed Actions run blocks the merge; a newer run of the same workflow replaces an older failure', async t => {
  const failed = await fixture(t, { runs: (call, head) => [run(1, { head_sha: head, conclusion: 'failure' })] });
  await assert.rejects(integrateGitHub(failed.job, failed.ctx, failed.options), { code: 'github_checks_blocked' });
  assert.equal(failed.state.merges, 0);
  const rerun = await fixture(t, { runs: (call, head) => [run(1, { head_sha: head, conclusion: 'failure' }), run(3, { head_sha: head })] });
  assert.equal((await integrateGitHub(rerun.job, rerun.ctx, rerun.options)).phase, 'complete');
  const twoEvents = await fixture(t, { runs: (call, head) => [run(1, { head_sha: head, event: 'push', conclusion: 'failure' }), run(3, { head_sha: head })] });
  await assert.rejects(integrateGitHub(twoEvents.job, twoEvents.ctx, twoEvents.options), { code: 'github_checks_blocked' });
  assert.equal(twoEvents.state.merges, 0);
});

test('with access to check runs, or on any other gh failure, Actions is never consulted', async t => {
  const keyring = await fixture(t, { rollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const record = await integrateGitHub(keyring.job, keyring.ctx, keyring.options);
  assert.equal(record.phase, 'complete'); assert.equal(record.checksSource, undefined); assert.equal(keyring.state.actionsCalls, 0);
  const other = await fixture(t, { viewError: 'HTTP 502: Bad Gateway' });
  await assert.rejects(integrateGitHub(other.job, other.ctx, other.options), /gh falló o la respuesta fue ambigua.*502/);
  assert.equal(other.state.actionsCalls, 0); assert.equal(other.state.merges, 0);
});

test('only the fine-grained permission error switches to Actions; an incomplete run listing fails closed', () => {
  assert.equal(checksPermissionDenied({ message: 'x', details: { stderr: denied } }), true);
  assert.equal(checksPermissionDenied({ message: 'gh falló', details: { stderr: 'HTTP 404: Not Found' } }), false);
  assert.equal(checksPermissionDenied(new Error('Resource not accessible by integration')), true);
  const head = 'a'.repeat(40);
  assert.throws(() => actionsRunsAsChecks({ total_count: 3, workflow_runs: [run(1, { head_sha: head })] }, head), /incompleta/);
  assert.throws(() => actionsRunsAsChecks({ workflow_runs: [] }, head), /incompleta/);
  assert.throws(() => actionsRunsAsChecks({ total_count: 100, workflow_runs: Array.from({ length: 100 }, (_, i) => run(i + 1, { head_sha: head })) }, head), /limitada/);
  assert.deepEqual(actionsRunsAsChecks({ total_count: 0, workflow_runs: [] }, head), []);
});
