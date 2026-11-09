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
    const prIdentity = { isCrossRepository: false, headRepository: { name: 'repo' }, headRepositoryOwner: { login: owner }, headRefName: source, baseRefName: 'main', state: 'OPEN' };
    if (args[0] === 'pr' && args[1] === 'list') {
      assert.equal(args[args.indexOf('--head') + 1], source, 'gh pr list accepts a branch, not owner:branch');
      return JSON.stringify(state.pr ? [{ ...prIdentity, ...state.pr }] : []);
    }
    if (args[0] === 'pr' && args[1] === 'create') { state.createCount++; state.pr = { number: 4, url: 'https://github.com/owner/repo/pull/4', headRefOid: state.head, baseRefOid: base }; if (state.createAmbiguous) throw Error('response lost'); return ''; }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (state.merged) return JSON.stringify({ ...prIdentity, ...state.pr, number: state.pr?.number, headRefOid: state.head, state: 'MERGED', mergedAt: '2026-11-08T12:00:00Z', mergeCommit: { oid: merge } });
      state.viewCount++;
      return JSON.stringify({ ...prIdentity, ...state.pr, number: state.pr?.number, state: 'OPEN', mergeable: state.mergeable, statusCheckRollup: state.checks, headRefOid: state.head, baseRefOid: base });
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

test('branch-only PR listing selects the original repository rather than a foreign fork of the same branch', async t => {
  const f = await fixture({ source: 'develop', remoteSource: base, pr: { number: 8, url: 'https://github.com/owner/repo/pull/8', headRefOid: head, baseRefOid: base } });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const gh = async args => {
    const value = await f.gh(args);
    if (args[0] !== 'pr' || args[1] !== 'list') return value;
    assert.equal(args[args.indexOf('--limit') + 1], '100');
    const own = JSON.parse(value)[0];
    return JSON.stringify([{ ...own, number: 99, url: 'https://github.com/owner/repo/pull/99', isCrossRepository: true, headRepositoryOwner: { login: 'foreign' } }, own]);
  };
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh });
  assert.equal(result.prNumber, 8);
  assert.equal(f.state.createCount, 0);
});

test('a foreign fork cannot satisfy an ambiguous create receipt or trigger a duplicate creation', async t => {
  const f = await fixture({ source: 'develop', dirty: '', pr: { number: 99, url: 'https://github.com/owner/repo/pull/99', headRefOid: head, baseRefOid: base,
    isCrossRepository: true, headRepositoryOwner: { login: 'foreign' } } });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const previous = { jobId: f.job.id, receiptId: f.job.autoIntent.receiptId, repository: 'owner/repo', sourceBranch: 'develop', baseBranch: 'main',
    phase: 'pr_intent', status: 'needs_attention', commitSha: head, manifest: f.job.integrationSnapshot };
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous }), /Creación de PR ambigua/);
  assert.equal(f.state.createCount, 0); assert.equal(f.state.pushCount, 0); assert.equal(f.state.mergeCount, 0);
});

test('a potentially truncated PR listing fails closed before mutations', async t => {
  const f = await fixture({ source: 'develop', remoteSource: base, pr: { number: 8, url: 'https://github.com/owner/repo/pull/8', headRefOid: head, baseRefOid: base } });
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const gh = async args => {
    const value = await f.gh(args);
    return args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(Array(100).fill(JSON.parse(value)[0])) : value;
  };
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh }), /no acreditó/);
  assert.ok(!f.state.commands.some(call => call[0] === 'git' && ['add', 'commit', 'push'].includes(call[1])));
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
  previous = { ...previous, status: 'needs_attention', needsAttention: true, error: 'PR no confirmada tras crearla; necesita revisión.' };
  const original = previous;
  f.state.createAmbiguous = false;
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous, persist: async value => { previous = value; } });
  assert.equal(result.phase, 'complete'); assert.equal(f.state.createCount, 1); assert.equal(f.state.pushCount, 1);
  assert.equal(result.error, null); assert.equal(previous.error, null); assert.equal(result.needsAttention, false);
  assert.match(original.error, /PR no confirmada/);
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
    await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, checksTimeoutMs: 0, persist: async record => records.push(record) }), /PR pendiente/);
    assert.equal(f.state.createCount, 0); assert.equal(f.state.mergeCount, 0);
    assert.equal(records.at(-1).phase, 'checks_pending');
    assert.equal(records.at(-1).status, 'checks_pending');
    if (Array.isArray(checks) && checks.some(check => check.conclusion && !['SUCCESS', 'PENDING'].includes(check.conclusion))) {
      assert.equal(records.at(-1).error, 'Un check terminó sin aprobación.');
    }
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
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh, checksTimeoutMs: 0, persist: async record => records.push(record) }), /PR pendiente/);
  assert.equal(f.state.mergeCount, 0); assert.equal(records.at(-1).phase, 'checks_pending');
});

test('empty and running CI checks are awaited on the same PR and merge once after success', async t => {
  const f = await fixture({ source: 'develop', checks: [] }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let elapsed = 0, waits = 0;
  const records = [];
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, clock: () => elapsed,
    checksTimeoutMs: 100, checksIntervalMs: 10, wait: async ms => {
      elapsed += ms; waits++;
      f.state.checks = waits === 1 ? [{ name: 'CI', status: 'IN_PROGRESS', conclusion: null }] : [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }];
    }, persist: async record => records.push(record) });
  assert.equal(result.phase, 'complete'); assert.equal(waits, 2);
  assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1); assert.equal(f.state.mergeCount, 1);
  assert.equal(records.filter(record => record.phase === 'checks_pending').length, 2);
});

test('the default wait allows checks to pass after the old five-minute limit', async t => {
  const f = await fixture({ source: 'develop', checks: [] }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let elapsed = 0;
  const result = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, clock: () => elapsed, wait: async ms => {
    elapsed += ms;
    if (elapsed > 300_000) f.state.checks = [{ name: 'Android', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  } });
  assert.ok(elapsed > 300_000);
  assert.equal(result.checkState, 'passed');
  assert.equal(f.state.mergeCount, 1);
  assert.equal(f.state.createCount, 1);
});

test('bounded CI wait and cancellation preserve the PR without attempting merge', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture({ source: 'develop', checks: [] }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const controller = new AbortController(); let elapsed = 0, latest;
    await assert.rejects(integrateGitHub(f.job, { ...f.ctx, signal: controller.signal }, { git: f.git, gh: f.gh, clock: () => elapsed,
      checksTimeoutMs: 20, checksIntervalMs: 10, wait: async (ms, signal) => {
        elapsed += ms;
        if (cancel) { controller.abort(new Error('fixture cancellation')); signal.throwIfAborted(); }
      }, persist: async record => { latest = record; } }), cancel ? /fixture cancellation/ : /espera acotada/);
    assert.equal(latest.phase, 'checks_pending'); assert.equal(f.state.mergeCount, 0);
    assert.equal(f.state.createCount, 1); assert.equal(f.state.pushCount, 1);
    if (!cancel) { assert.equal(elapsed, 20); assert.equal(latest.waitTimedOut, true); }
  }
});

test('terminal CI failure or changed PR head/base stops immediately instead of waiting', async t => {
  for (const mismatch of ['failure', 'headRefOid', 'baseRefOid']) {
    const f = await fixture({ source: 'develop', checks: [{ conclusion: mismatch === 'failure' ? 'FAILURE' : 'SUCCESS' }] });
    t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const gh = async args => {
      const value = await f.gh(args);
      return args[0] === 'pr' && args[1] === 'view' && mismatch !== 'failure' ? JSON.stringify({ ...JSON.parse(value), [mismatch]: 'f'.repeat(40) }) : value;
    };
    await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh, wait: async () => assert.fail('terminal mismatch cannot be awaited') }), /PR pendiente de revisión/);
    assert.equal(f.state.mergeCount, 0);
  }
});

test('an unresolved merge intent remains durable across repeated recovery and is never merged again', async t => {
  const f = await fixture({ source: 'develop', checks: [] }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let previous;
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, checksTimeoutMs: 0, persist: async record => { previous = record; } }), /checks/);
  previous = { ...previous, phase: 'merge_intent', status: 'needs_attention' };
  f.state.checks = [{ conclusion: 'SUCCESS' }];
  const mutations = f.state.commands.filter(call => ['push', 'commit', 'create', 'merge'].includes(call[1]) || call[1] === 'pr' && ['create', 'merge'].includes(call[2])).length;
  for (let repeat = 0; repeat < 2; repeat++) await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous,
    persist: async () => assert.fail('unresolved intent must not be overwritten') }), /Merge previo ambiguo/);
  assert.equal(previous.phase, 'merge_intent'); assert.equal(f.state.mergeCount, 0);
  assert.equal(f.state.commands.filter(call => ['push', 'commit', 'create', 'merge'].includes(call[1]) || call[1] === 'pr' && ['create', 'merge'].includes(call[2])).length, mutations);
  f.state.merged = true;
  const reconciled = await integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous });
  assert.equal(reconciled.phase, 'complete'); assert.equal(reconciled.reconciled, true); assert.equal(f.state.mergeCount, 0);
});

test('recovery cannot replace the approved manifest or overwrite an unobserved PR creation intent', async t => {
  const f = await fixture({ source: 'develop', createAmbiguous: true }); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  let previous;
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, persist: async record => { previous = record; } }), /response lost/);
  const originalManifest = previous.manifest;
  await assert.rejects(integrateGitHub({ ...f.job, integrationSnapshot: 'e'.repeat(64) }, f.ctx, { git: f.git, gh: f.gh, previous }), /manifest original/);
  f.state.pr = null;
  await assert.rejects(integrateGitHub(f.job, f.ctx, { git: f.git, gh: f.gh, previous,
    persist: async () => assert.fail('ambiguous intent cannot be overwritten') }), /Creación de PR ambigua/);
  assert.equal(previous.phase, 'pr_intent'); assert.equal(previous.manifest, originalManifest);
  assert.equal(f.state.pushCount, 1); assert.equal(f.state.createCount, 1); assert.equal(f.state.mergeCount, 0);
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
