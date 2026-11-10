import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureIntegrationSnapshot, createIntegrationCommandAdapters, integrateGitHubDefault } from '../github-integration.mjs';

const exec = promisify(execFile);
const rawGit = (workspace, args) => exec('git', args, { cwd: workspace, encoding: null, windowsHide: true, shell: false,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 2_000_000 });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'integration-adapter-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(workspace, { recursive: true });
  const git = args => rawGit(workspace, args);
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Integration fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.hooksPath', path.join(root, 'empty-hooks')]]) await git(['config', key, value]);
  await git(['remote', 'add', 'origin', 'https://github.com/fixture/adapter-test.git']);
  await fs.writeFile(path.join(workspace, 'a-añadir.txt'), 'Línea inicial.\n');
  await fs.writeFile(path.join(workspace, 'b-binario.bin'), Buffer.from([0, 255, 128, 13, 10, 1]));
  await git(['add', '--all']);
  await git(['commit', '-m', 'Local fixture baseline']);
  const baseline = (await git(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
  await git(['switch', '-c', 'feature']);
  await fs.writeFile(path.join(workspace, 'a-añadir.txt'), 'Línea inicial.\n  Segunda línea con botón.  \n');
  await fs.writeFile(path.join(workspace, 'b-binario.bin'), Buffer.from([0, 254, 129, 13, 10, 2]));
  await git(['add', 'b-binario.bin']);
  await fs.writeFile(path.join(workspace, ' ñ-sin-registrar.bin'), Buffer.from([0, 255, 254, 253, 10, 32]));
  const job = { id: 'adapter-fixture', title: 'Comprobación local', state: 'running', workspace, branch: 'feature',
    destination: { repository: 'fixture/adapter-test', baseBranch: 'main', remoteSha: baseline, baseSha: baseline },
    autoIntent: { eligible: true, receiptId: 'receipt-adapter-fixture' } };
  return { root, workspace, git, baseline, job, ctx: { root } };
}

function simulatedRemote(f, { sourceSha = f.baseline, stopAtPrList = false } = {}) {
  const calls = [];
  const stop = new Error('Fixture stopped before remote or local integration effects.');
  const executeCommand = async (exe, args, options) => {
    calls.push({ exe, args, encoding: options.encoding });
    assert.equal(options.encoding, null, 'the actual adapter requests undecoded stdout');
    if (exe === 'gh') {
      if (args[0] === 'api' && args[1] === 'user') return { stdout: Buffer.from('fixture\n') };
      if (args[0] === 'api' && String(args[3]).endsWith('/check-runs')) return { stdout: Buffer.from('{"total_count":0,"check_runs":[]}') };
      if (args[0] === 'pr' && args[1] === 'list') {
        if (stopAtPrList) throw stop;
        return { stdout: Buffer.from('  []\n') };
      }
      assert.fail('Unexpected GitHub effect: ' + args.join(' '));
    }
    assert.equal(exe, 'git');
    if (args[0] === 'ls-remote') return { stdout: Buffer.from(`${args.at(-1) === 'feature' ? sourceSha : f.baseline}\trefs/heads/${args.at(-1)}\n`) };
    assert.ok(['status', 'diff', 'ls-files', 'remote', 'symbolic-ref', 'check-ref-format', 'config', 'rev-parse', 'rev-list'].includes(args[0]),
      'no commit, push, checkout or other mutation is allowed through this adapter fixture');
    return exec(exe, args, options);
  };
  return { executeCommand, calls, stop };
}

test('default command adapter preserves exact real Git bytes for status, binary diffs and NUL filenames', async t => {
  const f = await fixture(t);
  const adapter = createIntegrationCommandAdapters();
  for (const args of [['status', '--porcelain=v1', '-z'], ['diff', '--binary', 'HEAD'], ['diff', '--cached', '--binary'],
    ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const actual = await adapter.git(args, f.workspace);
    const native = (await f.git(args)).stdout;
    assert.ok(Buffer.isBuffer(actual));
    assert.deepEqual(actual, native, 'same bytes as native execFile stdout');
    assert.ok(actual.length > 0);
    if (args[0] === 'status') {
      assert.equal(actual[0], 32, 'unstaged porcelain column starts with a significant space');
      assert.equal(actual.at(-1), 0);
    }
    if (args[0] === 'diff') assert.equal(actual.at(-1), 10, 'diff final newline belongs to the hash');
    if (args[0] === 'ls-files') assert.equal(actual.toString('utf8'), ' ñ-sin-registrar.bin\0');
  }
  assert.equal(await adapter.git(['symbolic-ref', '--short', 'HEAD'], f.workspace), 'feature');
  const json = createIntegrationCommandAdapters({ executeCommand: async () => ({ stdout: Buffer.from('  {"items":[]}\n') }) });
  assert.deepEqual(JSON.parse(await json.gh(['pr', 'list'], f.workspace)), { items: [] });
  const empty = createIntegrationCommandAdapters({ executeCommand: async () => ({ stdout: Buffer.alloc(0) }) });
  assert.equal(await empty.gh(['pr', 'list'], f.workspace), '');
});

test('capture and the real default integration adapter agree with Unicode and binary tracked/untracked changes', async t => {
  const f = await fixture(t);
  f.job.integrationSnapshot = await captureIntegrationSnapshot(f.workspace);
  const remote = simulatedRemote(f);
  const phases = [];
  const stop = new Error('Approved preflight reached; no commit or remote effect requested.');
  await assert.rejects(integrateGitHubDefault(f.job, f.ctx, { executeCommand: remote.executeCommand,
    persist: async record => { phases.push(record); if (record.phase === 'preflight_complete') throw stop; } }), error => error === stop);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].phase, 'preflight_complete');
  assert.equal(phases[0].manifest, f.job.integrationSnapshot);
  assert.equal(phases[0].baseline, f.baseline);
  assert.ok(remote.calls.some(call => call.exe === 'git' && call.args[0] === 'ls-files'));
  assert.ok(!remote.calls.some(call => ['add', 'commit', 'push', 'merge'].includes(call.args[0])));
});

test('default integration adapter still rejects changed tracked or untracked binary bytes after approval', async t => {
  for (const filename of ['b-binario.bin', ' ñ-sin-registrar.bin']) {
    const f = await fixture(t);
    f.job.integrationSnapshot = await captureIntegrationSnapshot(f.workspace);
    await fs.appendFile(path.join(f.workspace, filename), Buffer.from([0, 255, 254]));
    const remote = simulatedRemote(f);
    await assert.rejects(integrateGitHubDefault(f.job, f.ctx, { executeCommand: remote.executeCommand }), /diff actual no coincide/);
    assert.ok(!remote.calls.some(call => call.exe === 'git' && ['ls-remote', 'add', 'commit', 'push'].includes(call.args[0])));
  }
});

test('an empty status Buffer permits recovery of an already confirmed commit without recommitting', async t => {
  const f = await fixture(t);
  f.job.integrationSnapshot = await captureIntegrationSnapshot(f.workspace);
  await f.git(['add', '--all']);
  await f.git(['commit', '-m', 'Local approved fixture commit']);
  const commitSha = (await f.git(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
  assert.equal((await f.git(['status', '--porcelain=v1', '-z'])).stdout.length, 0);
  const previous = { jobId: f.job.id, receiptId: f.job.autoIntent.receiptId, repository: f.job.destination.repository,
    sourceBranch: f.job.branch, baseBranch: f.job.destination.baseBranch, phase: 'commit_confirmed', status: 'running',
    baseline: f.baseline, commitSha, manifest: f.job.integrationSnapshot };
  const remote = simulatedRemote(f);
  const phases = [];
  const stop = new Error('Recovered commit reached push intent; no push was executed.');
  await assert.rejects(integrateGitHubDefault(f.job, f.ctx, { previous, executeCommand: remote.executeCommand,
    persist: async record => { phases.push(record); if (record.phase === 'push_intent') throw stop; } }), error => error === stop);
  assert.deepEqual(phases.map(record => record.phase), ['preflight_complete', 'push_intent']);
  assert.equal(phases[1].commitSha, commitSha);
  assert.ok(!remote.calls.some(call => ['add', 'commit', 'push'].includes(call.args[0])));
});
