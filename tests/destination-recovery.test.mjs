import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, readAutoRun, retryDestinationAdmission, setAutoRun } from '../auto-run.mjs';
import { loadState } from '../queue.mjs';
import { DestinationError, destinationGitError } from '../project-destination.mjs';
import { createMissingRemote, destinationCheck } from '../project-remote.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dest-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('a failed destination check says which of the two fixable causes it was', () => {
  const lsRemote = ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/e2e/slugify'];
  const gone = destinationGitError(lsRemote, { code: 128, stderr: 'ERROR: Repository not found.\nfatal: Could not read from remote repository.' }, 'owner/repo');
  assert.equal(gone.code, 'destination_repository_missing'); assert.match(gone.message, /owner\/repo no existe/);
  assert.deepEqual([gone.details.command, gone.details.exitCode], ['git ls-remote', 128]); assert.match(gone.details.stderr, /Repository not found/);
  const branch = destinationGitError(lsRemote, { code: 2, stderr: '' }, 'owner/repo');
  assert.equal(branch.code, 'destination_remote_branch_missing'); assert.match(branch.message, /e2e\/slugify no existe en origin/);
  assert.equal(destinationGitError(lsRemote, { code: 128, stderr: 'ssh: connect to host github.com port 22: Network is unreachable' }, 'owner/repo').code, 'destination_git_failed');
  assert.equal(destinationGitError(['status', '--porcelain'], { code: 2, stderr: '' }, 'owner/repo').code, 'destination_git_failed');
});

test('a destination failure before admission keeps its cause and the same receipt can be checked again', async t => {
  const root = await fixture(t), workspace = path.join(root, 'workspaces', 'sandbox');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { checkout: 'workspaces/sandbox', workspace, branch: 'feature', repository: 'owner/repo', baseBranch: 'main', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  await setAutoRun(root, 'agency', true, { confirm: true });
  await confirmSubmission(root, 'receipt-dest', { id: 'dest-job', business: 'agency', kind: 'code', title: 't', prompt: 'Objetivo: x. Criterio: y.', provider: 'orca', workspace, isolated: true, branch: 'feature', destination });
  let repositoryExists = false, starts = 0;
  const verify = async () => {
    if (!repositoryExists) throw destinationGitError(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/feature'], { code: 128, stderr: 'ERROR: Repository not found.' }, 'owner/repo');
    return destination;
  };
  const runner = createAutoRunner(root, { verify, worker: async () => { starts++; return { text: 'Entrega simulada' }; } });
  await runner.tick();
  let receipt = (await readAutoRun(root)).receipts[0];
  assert.deepEqual([receipt.status, receipt.blockCode, starts], ['blocked', 'destination_repository_missing', 0]);
  assert.equal(receipt.blockDetails.command, 'git ls-remote'); assert.match(receipt.blockDetails.stderr, /Repository not found/);
  await assert.rejects(retryDestinationAdmission(root, receipt.id), /Confirma/);
  // Checked again without fixing anything: blocked again, still nothing started.
  await retryDestinationAdmission(root, receipt.id, { confirm: true });
  receipt = (await readAutoRun(root)).receipts[0]; assert.equal(receipt.status, 'pending'); assert.equal(receipt.blockCode, undefined);
  await runner.tick();
  assert.deepEqual([(await readAutoRun(root)).receipts[0].status, starts], ['blocked', 0]);
  // Fixed: the same receipt and job go ahead, once.
  repositoryExists = true;
  await retryDestinationAdmission(root, receipt.id, { confirm: true });
  await runner.tick();
  const done = (await readAutoRun(root)).receipts[0];
  assert.equal(starts, 1); assert.notEqual(done.status, 'blocked');
  assert.equal((await loadState(root)).jobs.find(job => job.id === 'dest-job').attempts, 1);
  await assert.rejects(retryDestinationAdmission(root, receipt.id, { confirm: true }), /no acredita un fallo de destino/);
  assert.ok((await readAutoRun(root)).history.some(item => item.type === 'destination_retry'));
});

test('a missing repository is recreated only on confirmation, private, with the local base as the base', async () => {
  const project = { id: 'p1', repository: 'Owner/Repo', checkout: 'workspaces/sandbox', branch: 'e2e/work', baseBranch: 'main' };
  const missing = async () => ({ ok: false, code: 'destination_repository_missing', reason: 'no existe' });
  const calls = [], exec = hasBase => async (file, args) => { calls.push([file, ...args]); if (args[0] === 'rev-parse' && !hasBase) throw new Error('unknown revision'); return { stdout: '' }; };
  await assert.rejects(createMissingRemote('/centro', project, { check: missing, exec: exec(true) }), /Confirma/); assert.equal(calls.length, 0);
  await assert.rejects(createMissingRemote('/centro', project, { confirm: true, check: async () => ({ ok: true }), exec: exec(true) }), /ya existe/);
  await assert.rejects(createMissingRemote('/centro', project, { confirm: true, check: async () => ({ ok: false, code: 'destination_git_failed', reason: 'sin red' }), exec: exec(true) }), /Solo se crea un repositorio que no existe/);
  assert.equal(calls.length, 0, 'nothing is published unless the repository is known to be gone');
  const made = await createMissingRemote('/centro', project, { confirm: true, check: missing, exec: exec(true) });
  assert.deepEqual(calls, [['gh', 'repo', 'create', 'Owner/Repo', '--private'], ['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/main'],
    ['git', 'push', 'origin', 'refs/heads/main:refs/heads/main'], ['git', 'push', 'origin', 'refs/heads/e2e/work:refs/heads/e2e/work']]);
  assert.deepEqual([made.visibility, made.baseFrom, made.pushed], ['private', 'main', ['main', 'e2e/work']]);
  calls.length = 0;
  assert.equal((await createMissingRemote('/centro', project, { confirm: true, check: missing, exec: exec(false) })).baseFrom, 'e2e/work');
  assert.deepEqual(calls[2], ['git', 'push', 'origin', 'refs/heads/e2e/work:refs/heads/main']);
  await assert.rejects(createMissingRemote('/centro', { ...project, branch: '--force' }, { confirm: true, check: missing, exec: exec(true) }), /ramas? .*válidas/);
  const failing = async file => { if (file === 'gh') throw Object.assign(new Error('x'), { stderr: 'GraphQL: Name already exists on this account' }); };
  await assert.rejects(createMissingRemote('/centro', project, { confirm: true, check: missing, exec: failing }), /Crear el repositorio falló.*Name already exists/);
});

test('the destination check answers ok, a definite no, or unknown, and never throws', async () => {
  const project = { repository: 'owner/repo', checkout: 'workspaces/x', branch: 'work', baseBranch: 'main' };
  assert.deepEqual(await destinationCheck('/centro', project, { verify: async (root, job, options) => { assert.equal(options.requireClean, false); assert.equal(job.branch, 'work'); return { repository: 'owner/repo', branch: 'work', sha: 'a'.repeat(40) }; } }),
    { ok: true, repository: 'owner/repo', branch: 'work', sha: 'a'.repeat(40) });
  const no = await destinationCheck('/centro', project, { verify: async () => { throw new DestinationError('destination_remote_branch_missing', 'La rama work no existe en origin.', { command: 'git ls-remote' }); } });
  assert.deepEqual([no.ok, no.code, no.details.command], [false, 'destination_remote_branch_missing', 'git ls-remote']);
  assert.equal((await destinationCheck('/centro', project, { verify: async () => { throw new Error('boom'); } })).ok, null);
  assert.equal((await destinationCheck('/centro', { repository: 'owner/repo' })).code, 'destination_unconfigured');
});
