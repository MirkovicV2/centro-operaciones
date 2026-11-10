import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { githubRepository, sameRepository, verifyGitHubDestination } from '../project-destination.mjs';
import { createProject, updateProject, loadDashboardState } from '../panel/agency-assistant/dashboard-state.mjs';
import { integrateGitHub } from '../github-integration.mjs';

// Improvement 13 (F9): owner/repo keeps its case; every comparison ignores it.
test('githubRepository preserves case for HTTPS and SSH origins and sameRepository compares without it', () => {
  assert.equal(githubRepository('https://github.com/DaDaVL/eoc-e2e-sandbox.git'), 'DaDaVL/eoc-e2e-sandbox');
  assert.equal(githubRepository('git@github.com:Owner/Repo.git'), 'Owner/Repo');
  assert.equal(githubRepository('ssh://git@github.com/Owner/Repo/'), 'Owner/Repo');
  assert.equal(sameRepository('DaDaVL/eoc-e2e-sandbox', 'dadavl/eoc-e2e-sandbox'), true);
  assert.equal(sameRepository('owner/repo', 'owner/other'), false);
  assert.equal(sameRepository('owner/repo', undefined), false);
  assert.throws(() => githubRepository('https://github.com/../x'), /Origin debe ser/);
});

test('a destination configured in another case than origin still verifies and keeps the origin case', async () => {
  const workspace = path.join('/tmp/never', 'workspaces', 'checkout');
  const inspect = async () => ({ checkout: 'workspaces/checkout', workspace, branch: 'develop', valid: true });
  const git = async args => {
    if (args[0] === 'remote') return 'git@github.com:DaDaVL/Sandbox.git';
    if (args[0] === 'symbolic-ref') return 'develop';
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'status') return '';
    if (args[0] === 'ls-remote') return `${args.at(-1).endsWith('/main') ? 'b'.repeat(40) : 'a'.repeat(40)}\trefs/heads/${args.at(-1).split('/').pop()}`;
    assert.fail(args.join(' '));
  };
  const job = { id: 'case', workspace, branch: 'develop', isolated: true, destination: { repository: 'dadavl/sandbox', baseBranch: 'main' }, autoIntent: { eligible: true, receiptId: 'r' } };
  const result = await verifyGitHubDestination('/tmp/never', job, { inspect, git });
  assert.equal(result.repository, 'DaDaVL/Sandbox'); assert.equal(result.verified, true);
  await assert.rejects(verifyGitHubDestination('/tmp/never', { ...job, destination: { repository: 'dadavl/other', baseBranch: 'main' } }, { inspect, git }), { code: 'destination_origin_mismatch' });
});

test('the panel stores the repository exactly as typed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-case-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root, 'Proyecto', 'agency');
  await updateProject(root, project.id, { repository: ' DaDaVL/Eoc-E2E-Sandbox ' });
  assert.equal((await loadDashboardState(root)).projects[0].repository, 'DaDaVL/Eoc-E2E-Sandbox');
  await assert.rejects(updateProject(root, project.id, { repository: 'not a repo' }), /Origin debe ser/);
});

test('integrateGitHub accepts a lower-case previous record for a destination in origin case and still rejects another repository', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repo-case-int-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const job = { id: 'j', state: 'running', title: 'T', autoIntent: { eligible: true, receiptId: 'r' }, workspace, branch: 'feature', destination: { repository: 'Owner/Repo', baseBranch: 'main' } };
  const previous = { jobId: 'j', receiptId: 'r', repository: 'owner/repo', sourceBranch: 'feature', baseBranch: 'main', phase: 'validation_approved', status: 'validated' };
  const stop = new Error('reached origin check');
  const git = async args => { if (args[0] === 'remote') throw stop; assert.fail(args.join(' ')); };
  await assert.rejects(integrateGitHub(job, { root }, { git, gh: async () => '', previous }), error => error === stop);
  await assert.rejects(integrateGitHub(job, { root }, { git, gh: async () => '', previous: { ...previous, repository: 'owner/other' } }), /pertenece a otro encargo/);
  const { repository, ...withoutRepository } = previous;
  await assert.rejects(integrateGitHub(job, { root }, { git, gh: async () => '', previous: withoutRepository }), /pertenece a otro encargo/);
});
