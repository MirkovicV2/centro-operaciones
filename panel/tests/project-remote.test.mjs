import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProject, updateProject, loadDashboardState, verifyProjectRemote } from '../agency-assistant/dashboard-state.mjs';

// Improvement 14: saving a project also checks origin, branch and SHA, or says clearly that it could not.
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-remote-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = 'workspaces/app'; const workspace = path.join(root, checkout); await fs.mkdir(workspace, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: workspace, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git(['init', '-q', '--initial-branch=main']); git(['config', 'user.email', 't@example.test']); git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(workspace, 'a.txt'), 'a\n'); git(['add', 'a.txt']); git(['commit', '-q', '-m', 'init']);
  const project = await createProject(root, 'Proyecto', 'agency');
  return { root, checkout, workspace, project, git, sha: git(['rev-parse', 'HEAD']).trim() };
}
const projectOf = async (root, id) => (await loadDashboardState(root)).projects.find(item => item.id === id);

test('saving checkout and repository records a verified remote or a clear warning without blocking the save', async t => {
  const f = await fixture(t);
  const calls = [];
  const ok = async (workspace, repository, branch) => { calls.push([workspace, repository, branch]); return { verified: true, repository, branch, origin: repository, localSha: f.sha, remoteSha: f.sha, checkedAt: 'now' }; };
  await updateProject(f.root, f.project.id, { checkout: f.checkout, repository: 'Owner/App', baseBranch: 'main' }, { verifyRemote: ok });
  let project = await projectOf(f.root, f.project.id);
  assert.deepEqual(calls, [[f.workspace, 'Owner/App', 'main']]);
  assert.equal(project.remote.verified, true); assert.equal(project.remote.remoteSha, f.sha); assert.equal(project.branch, 'main');
  await updateProject(f.root, f.project.id, { repository: 'Owner/App' }, { verifyRemote: async () => ({ verified: false, repository: 'Owner/App', branch: 'main', warning: 'No se pudo consultar origin/main: sin red.', checkedAt: 'now' }) });
  project = await projectOf(f.root, f.project.id);
  assert.equal(project.repository, 'Owner/App'); assert.equal(project.remote.verified, false); assert.match(project.remote.warning, /sin red/);
  // A verifier that throws still lets the project save and leaves a warning.
  await updateProject(f.root, f.project.id, { repository: 'Owner/App' }, { verifyRemote: async () => { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); } });
  assert.match((await projectOf(f.root, f.project.id)).remote.warning, /ETIMEDOUT/);
  // Saving unrelated fields does not re-check; clearing the repository clears the remote record.
  await updateProject(f.root, f.project.id, { nextAction: 'Revisar' }, { verifyRemote: async () => assert.fail('no remote check for unrelated fields') });
  assert.ok((await projectOf(f.root, f.project.id)).remote);
  await updateProject(f.root, f.project.id, { repository: '' }, { verifyRemote: async () => assert.fail('no repository, no check') });
  assert.equal((await projectOf(f.root, f.project.id)).remote, undefined);
});

test('verifyProjectRemote explains a missing origin, a non-GitHub origin, a mismatching origin and an unreachable remote', async t => {
  const f = await fixture(t);
  assert.match((await verifyProjectRemote(f.workspace, 'Owner/App', 'main')).warning, /no tiene remoto origin/);
  f.git(['remote', 'add', 'origin', path.join(f.root, 'bare.git')]);
  assert.match((await verifyProjectRemote(f.workspace, 'Owner/App', 'main')).warning, /no es un repositorio GitHub/);
  f.git(['remote', 'set-url', 'origin', 'https://github.com/Other/Repo.git']);
  const mismatch = await verifyProjectRemote(f.workspace, 'Owner/App', 'main');
  assert.equal(mismatch.verified, false); assert.equal(mismatch.origin, 'Other/Repo'); assert.match(mismatch.warning, /no coincide/);
  f.git(['remote', 'set-url', 'origin', 'https://github.com/owner/app.git']); f.git(['config', 'http.proxy', 'http://127.0.0.1:9']);
  const unreachable = await verifyProjectRemote(f.workspace, 'Owner/App', 'main');
  assert.equal(unreachable.verified, false); assert.equal(unreachable.origin, 'owner/app'); assert.equal(unreachable.localSha, f.sha); assert.match(unreachable.warning, /No se pudo consultar origin\/main/);
  assert.match((await verifyProjectRemote(f.workspace, 'Owner/App', '')).warning, /Sin rama observada/);
  // The remote agrees with the local HEAD through an injected git.
  const execute = async (_exe, args) => ({ stdout: args[0] === 'remote' ? 'https://github.com/Owner/App.git\n' : args[0] === 'rev-parse' ? `${f.sha}\n` : `${f.sha}\trefs/heads/main\n` });
  const verified = await verifyProjectRemote(f.workspace, 'owner/app', 'main', { execute });
  assert.equal(verified.verified, true); assert.equal(verified.remoteSha, f.sha); assert.equal(verified.origin, 'Owner/App');
  const diverged = await verifyProjectRemote(f.workspace, 'owner/app', 'main', { execute: async (_exe, args) => ({ stdout: args[0] === 'remote' ? 'https://github.com/Owner/App.git' : args[0] === 'rev-parse' ? f.sha : `${'f'.repeat(40)}\trefs/heads/main` }) });
  assert.equal(diverged.verified, false); assert.match(diverged.warning, /SHA local/);
});
