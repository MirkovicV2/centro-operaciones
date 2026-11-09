import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCommittedIntegration } from '../integration-recovery.mjs';

const commit = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), manifest = 'd'.repeat(64);
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'committed-integration-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const job = { id: 'integration-fixture', state: 'needs_attention', workspace, branch: 'feature', autoIntent: { eligible: true, receiptId: 'receipt-integration' },
    destination: { workspace, branch: 'feature', repository: 'owner/repo', baseBranch: 'main', baseSha: base, remoteSha: base, sha: base } };
  const record = { jobId: job.id, receiptId: job.autoIntent.receiptId, repository: 'owner/repo', sourceBranch: 'feature', baseBranch: 'main',
    phase: 'pr_intent', status: 'needs_attention', commitSha: commit, manifest, remoteBaseSha: base };
  const pr = { number: 1, url: 'https://github.com/owner/repo/pull/1', state: 'OPEN', isCrossRepository: false,
    headRepository: { name: 'repo' }, headRepositoryOwner: { login: 'owner' }, headRefName: 'feature', baseRefName: 'main', headRefOid: commit, baseRefOid: base };
  const state = { status: Buffer.alloc(0), head: commit, origin: 'https://github.com/owner/repo.git', branch: 'feature', remoteSource: commit, remoteBase: base, listed: [pr], viewed: pr, calls: [] };
  const git = async (args, cwd) => {
    state.calls.push(['git', ...args]); assert.equal(cwd, workspace);
    if (args[0] === 'remote') return state.origin;
    if (args[0] === 'symbolic-ref') return state.branch;
    if (args[0] === 'check-ref-format') return args[2];
    if (args[0] === 'status') return state.status;
    if (args[0] === 'rev-parse') return state.head;
    if (args[0] === 'ls-remote') return `${args.at(-1) === 'main' ? state.remoteBase : state.remoteSource}\trefs/heads/${args.at(-1)}`;
    assert.fail('Unexpected Git command: ' + args.join(' '));
  };
  const gh = async (args, cwd) => {
    state.calls.push(['gh', ...args]); assert.equal(cwd, workspace);
    if (args[0] === 'pr' && args[1] === 'list') {
      assert.equal(args[args.indexOf('--head') + 1], 'feature');
      assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
      return JSON.stringify(state.listed);
    }
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(state.viewed);
    assert.fail('Unexpected GitHub command: ' + args.join(' '));
  };
  return { root, workspace, job, record, state, pr, options: { git, gh } };
}

test('read-only recovery finds the existing same-repository PR after a recorded ambiguous create', async t => {
  const f = await fixture(t), before = structuredClone(f.record);
  const first = await inspectCommittedIntegration(f.root, f.job, f.record, f.options);
  const second = await inspectCommittedIntegration(f.root, f.job, f.record, f.options);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { kind: 'committed_integration', jobId: f.job.id, receiptId: f.record.receiptId, commitSha: commit, manifest,
    phase: 'pr_intent', repository: 'owner/repo', sourceBranch: 'feature', baseBranch: 'main', baseSha: base,
    prNumber: 1, prUrl: f.pr.url, prHeadSha: commit, prBaseSha: base, prState: 'OPEN' });
  assert.deepEqual(f.record, before);
  assert.ok(!f.state.calls.some(call => ['add', 'commit', 'push', 'create', 'merge', 'checkout', 'switch'].some(word => call.includes(word))));
});

test('foreign forks with the same branch are never selected as the existing PR', async t => {
  const f = await fixture(t);
  const fork = { ...f.pr, number: 2, url: 'https://github.com/owner/repo/pull/2', isCrossRepository: true, headRepositoryOwner: { login: 'someoneelse' } };
  f.state.listed = [fork, f.pr];
  assert.equal((await inspectCommittedIntegration(f.root, f.job, f.record, f.options)).prNumber, 1);
  f.state.listed = [fork];
  await assert.rejects(inspectCommittedIntegration(f.root, f.job, f.record, f.options), /única PR/);
});

test('confirmed merged PR is accepted only for its pending merge and exact remote merge commit', async t => {
  const f = await fixture(t);
  f.record.phase = 'merge_intent'; f.record.prNumber = 1; f.record.prUrl = f.pr.url;
  f.pr.state = 'MERGED'; f.pr.mergedAt = '2026-11-08T20:00:00Z'; f.pr.mergeCommit = { oid: merge }; f.state.remoteBase = merge;
  assert.equal((await inspectCommittedIntegration(f.root, f.job, f.record, f.options)).mergeSha, merge);
  f.state.remoteBase = 'f'.repeat(40);
  await assert.rejects(inspectCommittedIntegration(f.root, f.job, f.record, f.options), /ramas remotas/);
  f.state.remoteBase = merge; f.record.phase = 'checks_pending';
  await assert.rejects(inspectCommittedIntegration(f.root, f.job, f.record, f.options), /única PR/);
});

for (const [name, change] of [
  ['foreign job', f => { f.record.jobId = 'other'; }], ['foreign receipt', f => { f.record.receiptId = 'other'; }],
  ['missing manifest', f => { delete f.record.manifest; }], ['unsupported phase', f => { f.record.phase = 'commit_intent'; }],
  ['missing commit', f => { delete f.record.commitSha; }], ['dirty checkout', f => { f.state.status = Buffer.from(' M changed\0'); }],
  ['changed HEAD', f => { f.state.head = base; }], ['changed origin', f => { f.state.origin = 'https://github.com/other/repo.git'; }],
  ['changed branch', f => { f.state.branch = 'other'; }], ['changed remote source', f => { f.state.remoteSource = base; }],
  ['changed remote base', f => { f.state.remoteBase = commit; }], ['missing PR', f => { f.state.listed = []; }],
  ['multiple own PRs', f => { f.state.listed = [f.pr, { ...f.pr, number: 2, url: 'https://github.com/owner/repo/pull/2' }]; }],
  ['changed PR number', f => { f.record.prNumber = 2; }], ['changed PR URL', f => { f.record.prUrl = 'https://github.com/owner/repo/pull/2'; }],
  ['changed PR head', f => { f.state.viewed = { ...f.pr, headRefOid: base }; }],
  ['changed PR base', f => { f.state.viewed = { ...f.pr, baseRefOid: commit }; }],
  ['foreign PR view', f => { f.state.viewed = { ...f.pr, headRepositoryOwner: { login: 'someoneelse' } }; }],
  ['closed PR', f => { f.state.viewed = { ...f.pr, state: 'CLOSED' }; }],
  ['unknown repository metadata', f => { delete f.pr.headRepositoryOwner; }],
]) test('recovery rejects ' + name, async t => {
  const f = await fixture(t); change(f);
  await assert.rejects(inspectCommittedIntegration(f.root, f.job, f.record, f.options));
});
