import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { integrateGitHub, diffFingerprint, captureIntegrationSnapshot } from '../github-integration.mjs';

const exec = promisify(execFile);

const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
async function fixture({ source = 'main', ghUser = 'owner', dirty = ' M src/app.js', owner = 'owner', remoteSource = head, pr = null, conclusion = 'SUCCESS', checks, mergeable = 'MERGEABLE', createAmbiguous = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-integration-'));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const remoteBase = source === 'main' ? remoteSource : base;
  const state = { source, ghUser, dirty, owner, remoteSource, remoteBase, pr, head, conclusion, checks: checks === undefined ? [{ conclusion }] : checks, mergeable, createAmbiguous, merged: false, pushCount: 0, createCount: 0, mergeCount: 0, pushAmbiguous: false, commands: [], viewCount: 0 };
  const git = async args => {
    state.commands.push(['git', ...args]);
    if (args[0] === 'remote') return `https://github.com/${owner}/repo.git`;
    if (args[0] === 'symbolic-ref') return source;
    if (args[0] === 'check-ref-format') return args[2];
    if (args[0] === 'config') return 'Name <name@example.test>';
    if (args[0] === 'status') return state.dirty;
    if (args[0] === 'diff') return state.dirty ? 'diff --binary fixture' : '';
    if (args[0] === 'rev-parse') return state.head;
    if (args[0] === 'ls-remote') return `${args.at(-1) === source ? state.remoteSource : state.remoteBase}\trefs/heads/${args.at(-1)}`;
    if (args[0] === 'rev-list') return '0';
    if (args[0] === 'ls-files') return '';
    if (args[0] === 'add') return '';
    if (args[0] === 'commit') { state.head = 'd'.repeat(40); state.dirty = ''; return ''; }
    if (args[0] === 'push') { state.pushCount++; state.remoteSource = state.head; if (state.pr) state.pr.headRefOid = state.head; if (state.pushAmbiguous) throw new Error('connection lost'); return 'ok'; }
    throw Error(`unexpected git ${args.join(' ')}`);
  };
  const gh = async args => {
    state.commands.push(['gh', ...args]);
    if (args[0] === 'api') return ghUser;
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(state.pr ? [state.pr] : []);
    if (args[0] === 'pr' && args[1] === 'create') { state.createCount++; state.pr = { number: 4, url: 'https://github.com/owner/repo/pull/4', headRefOid: state.head, baseRefOid: base }; if (state.createAmbiguous) throw Error('response lost'); return ''; }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (state.merged) return JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-08T12:00:00Z', mergeCommit: { oid: merge } });
      state.viewCount++;
      return JSON.stringify({ state: 'OPEN', mergeable: state.mergeable, statusCheckRollup: state.checks, headRefOid: state.head, baseRefOid: base });
    }
    if (args[0] === 'pr' && args[1] === 'merge') { state.mergeCount++; state.merged = true; return ''; }
    throw Error(`unexpected gh ${args.join(' ')}`);
  };
  const job = { id: 'job-code-01', state: 'running', title: 'Implement change', autoIntent: { eligible: true, receiptId: 'receipt-code-01' }, workspace, branch: source, destination: { repository: `${owner}/repo`, baseBranch: 'main', remoteSha: remoteSource, baseSha: remoteBase } };
  const snapshot = diffFingerprint(dirty, dirty ? 'diff --binary fixture' : '', dirty ? 'diff --binary fixture' : '');
  return { root, workspace, state, git, gh, job: { ...job, integrationSnapshot: snapshot }, ctx: { root, reportStage: async () => {} } };
}

test('direct push persists intent, confirms remote SHA and completion is idempotent', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const records = [];
  const first = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, persist: async value => records.push(value) });
  assert.equal(first.phase, 'complete'); assert.equal(f.state.pushCount, 1);
  assert.ok(records.some(record => record.phase === 'push_intent'));
  assert.ok(!f.state.commands.flat().some(value => /--force/.test(value)));
  assert.ok(!JSON.stringify(records).includes('ghp_'));
  const again = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous: first, persist: async () => assert.fail('complete must not write again') });
  assert.equal(again.phase, 'complete'); assert.equal(f.state.pushCount, 1);
});

test('existing PR is reused and merged only after checks pass', async t => {
  const f = await fixture({ source: 'develop', remoteSource: base, pr: { number: 8, url: 'https://github.com/owner/repo/pull/8', headRefOid: head, baseRefOid: base } });
  f.job.destination.remoteSha = base;
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh });
  assert.equal(result.phase, 'complete'); assert.equal(f.state.createCount, 0); assert.equal(f.state.mergeCount, 1); assert.equal(result.mergeSha, merge);
});

test('ambiguous direct push reconciles remote before retry and never duplicates push', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  f.state.pushAmbiguous = true;
  let previous;
  try { await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, persist: async value => { previous = value; } }); } catch {}
  assert.equal(previous.phase, 'push_intent'); assert.equal(f.state.pushCount, 1);
  f.state.pushAmbiguous = false;
  const recovered = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous, persist: async value => { previous = value; } });
  assert.equal(recovered.phase, 'complete'); assert.equal(recovered.reconciled, true); assert.equal(f.state.pushCount, 1);
});

test('ambiguous PR creation reuses the remotely observed PR without repeating create or push', async t => {
  const f = await fixture({ source: 'develop', remoteSource: base, createAmbiguous: true }); f.job.destination.remoteSha = base;
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let previous;
  try { await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, persist: async value => { previous = value; } }); } catch {}
  assert.equal(previous.phase, 'pr_intent'); assert.equal(f.state.createCount, 1); assert.equal(f.state.pushCount, 1);
  f.state.createAmbiguous = false;
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous, persist: async value => { previous = value; } });
  assert.equal(result.phase, 'complete'); assert.equal(f.state.createCount, 1); assert.equal(f.state.pushCount, 1);
});

test('conflicting or failing required PR checks stop before merge', async t => {
  for (const values of [{ mergeable: 'CONFLICTING' }, { conclusion: 'FAILURE' }]) {
    const f = await fixture({ source: 'develop', remoteSource: base, ...values }); f.job.destination.remoteSha = base;
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh }), /PR pendiente/);
    assert.equal(f.state.mergeCount, 0);
    assert.ok(!f.state.commands.flat().some(value => /--admin|--force/.test(value)));
  }
});

test('empty, unknown, pending, cancelled and mixed check rollups preserve the PR for later inspection', async t => {
  const cases = [[], null, [{ conclusion: null }], [{ conclusion: 'PENDING' }], [{ conclusion: 'CANCELLED' }], [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }], [{ conclusion: 'NEUTRAL' }]];
  for (const checks of cases) {
    const f = await fixture({ source: 'develop', remoteSource: base, checks, pr: { number: 8, url: 'https://github.com/owner/repo/pull/8', headRefOid: head, baseRefOid: base } });
    f.job.destination.remoteSha = base;
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const records = [];
    await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, persist: async record => records.push(record) }), /PR pendiente/);
    assert.equal(f.state.createCount, 0); assert.equal(f.state.mergeCount, 0);
    assert.equal(records.at(-1).phase, 'checks_pending');
    assert.equal(records.at(-1).status, 'checks_pending');
    assert.ok(records.at(-1).prNumber === 8);
  }
});

test('a check that becomes pending before merge is rechecked and stops the mutation', async t => {
  const f = await fixture({ source: 'develop', remoteSource: base, pr: { number: 8, url: 'https://github.com/owner/repo/pull/8', headRefOid: head, baseRefOid: base } });
  f.job.destination.remoteSha = base;
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let checkViews = 0;
  const gh = async args => {
    if (args[0] === 'pr' && args[1] === 'view' && ++checkViews === 2) f.state.checks = [{ conclusion: null }];
    return f.gh(args);
  };
  const records = [];
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh, persist: async record => records.push(record) }), /PR pendiente/);
  assert.equal(f.state.mergeCount, 0); assert.equal(records.at(-1).phase, 'checks_pending');
});

test('noneligible, dirty baseline, auth mismatch, owner mismatch and divergence block without writes', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  assert.deepEqual(await integrateGitHub({ ...f.job, autoIntent: { eligible: false } }, f.ctx, { git: f.git, gh: f.gh }), { status: 'skipped', reason: 'not_eligible' });
  const reject = async (changes, text) => { const value = { ...f, ...changes }; await assert.rejects(integrateGitHub(value.job || f.job, value.ctx, { git: value.git || f.git, gh: value.gh || f.gh }), new RegExp(text)); };
  await reject({ job: { ...f.job, integrationSnapshot: 'wrong' } }, 'diff actual');
  await reject({ gh: async args => args[0] === 'api' ? 'other' : f.gh(args) }, 'propietario');
  await reject({ git: async args => args[0] === 'remote' ? 'https://github.com/else/repo.git' : f.git(args) }, 'Origin');
  await reject({ git: async args => args[0] === 'rev-list' && args[2].startsWith('HEAD..') ? '2' : f.git(args) }, 'diverge');
  await reject({ job: { ...f.job, destination: { ...f.job.destination, baseSha: 'c'.repeat(40) } } }, 'Baseline remoto');
  assert.equal(f.state.pushCount, 0); assert.equal(f.state.createCount, 0); assert.equal(f.state.mergeCount, 0);
});

test('source branch mismatch and noneligible history never reach GitHub effects', async t => {
  const f = await fixture({ source: 'develop' }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  f.job.destination.baseBranch = 'develop';
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: async args => args[0] === 'symbolic-ref' ? 'other' : f.git(args), gh: f.gh }), /Branch activa/);
  assert.equal(f.state.pushCount, 0); assert.equal(f.state.createCount, 0);
});

test('binary fingerprint fields preserve invalid UTF-8 bytes', () => {
  const left = diffFingerprint(Buffer.from([0xff]), Buffer.alloc(0), Buffer.alloc(0));
  const right = diffFingerprint(Buffer.from([0xfe]), Buffer.alloc(0), Buffer.alloc(0));
  assert.notEqual(left, right);
  assert.notEqual(diffFingerprint('', Buffer.from([0xff]), Buffer.alloc(0)), diffFingerprint('', Buffer.from([0xfe]), Buffer.alloc(0)));
  assert.notEqual(diffFingerprint('', Buffer.alloc(0), Buffer.from([0xff])), diffFingerprint('', Buffer.alloc(0), Buffer.from([0xfe])));
});

async function localRepo(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gh-bytes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout');
  await fs.mkdir(workspace, { recursive: true });
  const run = async args => (await exec('git', args, { cwd: workspace, windowsHide: true, shell: false })).stdout.trim();
  await run(['init', '-b', 'main']);
  await run(['config', 'user.name', 'Test User']);
  await run(['config', 'user.email', 'test@example.test']);
  await fs.writeFile(path.join(workspace, 'tracked.bin'), Buffer.from([0x00]));
  await run(['add', 'tracked.bin']);
  await run(['commit', '-m', 'fixture']);
  await run(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  return { root, workspace, run };
}

test('binary fixtures produce distinct snapshots and post-approval byte changes block integration', async t => {
  const first = await localRepo(t), second = await localRepo(t);
  await fs.writeFile(path.join(first.workspace, 'invalid.bin'), Buffer.from([0xff, 0xc0]));
  await fs.writeFile(path.join(second.workspace, 'invalid.bin'), Buffer.from([0xfe, 0xc0]));
  assert.notEqual(await captureIntegrationSnapshot(first.workspace), await captureIntegrationSnapshot(second.workspace));

  for (const mode of ['worktree', 'index', 'untracked']) {
    const f = await localRepo(t);
    const approved = await captureIntegrationSnapshot(f.workspace);
    if (mode === 'untracked') {
      await fs.writeFile(path.join(f.workspace, 'new.bin'), Buffer.from([0xff, 0xc0]));
    } else {
      await fs.writeFile(path.join(f.workspace, 'tracked.bin'), Buffer.from([0xff, 0xc0]));
      if (mode === 'index') await f.run(['add', 'tracked.bin']);
    }
    const job = {
      id: 'binary-fixture', title: 'Binary fixture', state: 'running',
      autoIntent: { eligible: true, receiptId: 'binary-receipt' },
      workspace: f.workspace, branch: 'main', integrationSnapshot: approved,
      destination: { repository: 'owner/repo', baseBranch: 'main', remoteSha: head, baseSha: base },
    };
    const integrationGitCalls = [];
    const git = async args => {
      integrationGitCalls.push(args);
      const result = await exec('git', args, { cwd: f.workspace, windowsHide: true, shell: false, encoding: null });
      return ['status', 'diff', 'ls-files'].includes(args[0]) ? result.stdout : result.stdout.toString('utf8').trim();
    };
    const gh = async args => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      assert.fail(`Unexpected GitHub command: ${args.join(' ')}`);
    };
    await assert.rejects(integrateGitHub(job, { root: f.root }, { git, gh }), /diff actual/);
    assert.ok(!integrationGitCalls.some(args => ['add', 'commit', 'push'].includes(args[0])));
  }
});
