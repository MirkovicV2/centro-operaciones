import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { githubRepository, sameRepository, verifyGitHubDestination } from '../project-destination.mjs';
import { createProject, updateProject, loadDashboardState } from '../panel/agency-assistant/dashboard-state.mjs';

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
