import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { integrateGitHub, diffFingerprint, createIntegrationCommandAdapters, checksPermissionDenied } from '../github-integration.mjs';

// Actions workflow status alone cannot prove that every PR check succeeded.
const base = 'b'.repeat(40);
const denied = 'GraphQL: Resource not accessible by personal access token (repository.pullRequest.statusCheckRollup.nodes.0)';

async function fixture(t, { rollup = 'denied', viewError = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checks-actions-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const state = { head: 'a'.repeat(40), remoteSource: 'a'.repeat(40), pr: null, merged: false, merges: 0, rollupCalls: 0, actionsCalls: 0, probes: [], pushes: 0, records: [] };
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
    if (args[0] === 'push') { state.pushes++; state.remoteSource = state.head; if (state.pr) state.pr.headRefOid = state.head; return 'ok'; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const identity = { isCrossRepository: false, headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'owner' }, headRefName: 'feature', baseRefName: 'main', state: 'OPEN' };
  const fail = text => { throw Object.assign(new Error('exit 1'), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(text) }); };
  const answer = async (exe, args) => {
    const out = value => ({ stdout: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
    if (args[0] === 'api' && args[1] === 'user') return out('owner');
    if (args[0] === 'api' && args.includes(`repos/owner/repo/commits/${base}/check-runs`)) { state.probes.push('check-runs'); return rollup === 'denied' ? fail(denied) : out({ total_count: 0, check_runs: [] }); }
    if (args[0] === 'api' && args.includes('repos/owner/repo/actions/runs')) {
      state.actionsCalls++;
      return out({ total_count: 1, workflow_runs: [{ id: 1, workflow_id: 7, head_sha: state.head, event: 'pull_request',
        name: 'ci', status: 'completed', conclusion: 'success' }] });
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

const successful = { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
const failedExternal = { name: 'external-security', status: 'COMPLETED', conclusion: 'FAILURE' };

test('a credential without check-run access stops before committing even when Actions is green', async t => {
  const f = await fixture(t);
  await assert.rejects(integrateGitHub(f.job, f.ctx, f.options), { code: 'github_checks_unreadable' });
  assert.equal(f.state.pushes, 0);
  assert.equal(f.state.pr, null);
  assert.equal(f.state.head, 'a'.repeat(40));
  assert.equal(f.state.actionsCalls, 0);
  assert.equal(f.state.merges, 0);
  assert.deepEqual(f.state.probes, ['check-runs']);
});

test('permission loss keeps the original PR in no_permission without merging', async t => {
  const f = await fixture(t, { rollup: [successful], viewError: denied });
  await assert.rejects(integrateGitHub(f.job, f.ctx, f.options), { code: 'github_checks_unreadable' });
  const last = f.state.records.at(-1);
  assert.equal(last.phase, 'checks_pending');
  assert.equal(last.checkState, 'no_permission');
  assert.equal(last.prNumber, 5);
  assert.equal(f.state.actionsCalls, 0);
  assert.equal(f.state.merges, 0);
});

test('a visible external failure stops the merge and a complete successful rollup allows it', async t => {
  const failed = await fixture(t, { rollup: [successful, failedExternal] });
  await assert.rejects(integrateGitHub(failed.job, failed.ctx, failed.options), { code: 'github_checks_blocked' });
  assert.equal(failed.state.merges, 0);
  const passed = await fixture(t, { rollup: [successful] });
  assert.equal((await integrateGitHub(passed.job, passed.ctx, passed.options)).phase, 'complete');
  assert.equal(passed.state.merges, 1);
  assert.equal(passed.state.actionsCalls, 0);
});

test('unrelated gh failures retain their diagnostics', async t => {
  assert.equal(checksPermissionDenied({ details: { stderr: denied } }), true);
  assert.equal(checksPermissionDenied(new Error('HTTP 502: Bad Gateway')), false);
  const f = await fixture(t, { rollup: [], viewError: 'HTTP 502: Bad Gateway' });
  await assert.rejects(integrateGitHub(f.job, f.ctx, f.options), /gh falló o la respuesta fue ambigua.*502/);
  assert.equal(f.state.actionsCalls, 0);
  assert.equal(f.state.merges, 0);
});
