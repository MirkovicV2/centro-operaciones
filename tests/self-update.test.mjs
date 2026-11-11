import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSelfUpdate, runCommand } from '../panel/self-update.mjs';

// «Actualizar el Centro» from the panel (or the phone): only main, only clean, only after the new version's tests pass in
// a separate copy, and never with a job running.
async function repos(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'autoupdate-')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dani', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'Dani', GIT_COMMITTER_EMAIL: 'd@x' } }).trim();
  const origin = path.join(base, 'origin.git'), local = path.join(base, 'local'), other = path.join(base, 'other');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, other);
  await fs.writeFile(path.join(other, 'a.txt'), '1'); git(other, 'add', '.'); git(other, 'commit', '-qm', 'base'); git(other, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', origin, local);
  const push = async subject => { await fs.writeFile(path.join(other, `${subject}.txt`), subject); git(other, 'add', '.'); git(other, 'commit', '-qm', subject); git(other, 'push', '-q', 'origin', 'HEAD:main'); return git(other, 'rev-parse', 'HEAD'); };
  return { local, git, push, tmp: base };
}
const settle = async updater => { for (let i = 0; i < 100 && ['probando', 'actualizando'].includes(updater.operation.phase); i++) await new Promise(resolve => setTimeout(resolve, 20)); };
const runWith = (testsPass, seen = []) => (argv, options) => {
  if (argv[1] === 'tests/run-tests.mjs') { seen.push(options.cwd); return Promise.resolve({ code: testsPass ? 0 : 1, stdout: testsPass ? '# pass 3\n' : '# pass 2\n# fail 1\n', stderr: '', timedOut: false }); }
  return runCommand(argv, options);
};

test('a new version on main is listed and installed after its tests pass in a separate copy, then the panel restarts', async t => {
  const { local, git, push, tmp } = await repos(t);
  const target = await push('Descartar petición');
  const tested = [], restarts = [];
  const updater = createSelfUpdate(local, { run: runWith(true, tested), restart: async root => restarts.push(root), tmpdir: tmp });
  const status = await updater.status({ fresh: true });
  assert.equal(status.available, true); assert.equal(status.canUpdate, true); assert.equal(status.behind, 1);
  assert.equal(status.commits[0].subject, 'Descartar petición'); assert.equal(status.commits[0].author, 'Dani');
  await assert.rejects(updater.start({ target: 'f'.repeat(40) }), /ha cambiado desde que la viste/);
  await updater.start({ target });
  await settle(updater);
  assert.equal(updater.operation.phase, 'reiniciando');
  assert.equal(tested.length, 1); assert.notEqual(tested[0], local, 'the tests ran in a separate copy');
  await assert.rejects(fs.access(tested[0]), 'the copy is removed');
  assert.equal(git(local, 'rev-parse', 'HEAD'), target);
  assert.deepEqual(restarts, [local]);
  assert.equal((await updater.status()).available, false);
});

test('failing tests, a running job, local changes or another branch leave the folder untouched', async t => {
  const { local, git, push, tmp } = await repos(t);
  const before = git(local, 'rev-parse', 'HEAD');
  const target = await push('roto');
  const failing = createSelfUpdate(local, { run: runWith(false), restart: async () => assert.fail('no restart'), tmpdir: tmp });
  await failing.status({ fresh: true });
  await failing.start({ target });
  await settle(failing);
  assert.equal(failing.operation.phase, 'error'); assert.match(failing.operation.message, /no pasan \(# pass 2 · # fail 1\); no se ha cambiado nada/);
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);

  const busy = createSelfUpdate(local, { run: runWith(true), jobsRunning: async () => 1, restart: async () => assert.fail('no restart'), tmpdir: tmp });
  await assert.rejects(busy.start({ target }), /trabajos en marcha/);

  await fs.writeFile(path.join(local, 'a.txt'), 'editado a mano');
  const dirty = await createSelfUpdate(local, { run: runWith(true), tmpdir: tmp }).status({ fresh: true });
  assert.equal(dirty.available, true); assert.equal(dirty.canUpdate, false); assert.match(dirty.reason, /cambios sin guardar/);
  git(local, 'checkout', '-q', '--', 'a.txt');

  git(local, 'switch', '-q', '-c', 'david/prueba');
  const branch = await createSelfUpdate(local, { run: runWith(true), tmpdir: tmp }).status({ fresh: true });
  assert.equal(branch.canUpdate, false); assert.match(branch.reason, /rama «david\/prueba»/);
  git(local, 'switch', '-q', 'main');
  assert.equal(git(local, 'rev-parse', 'HEAD'), before);
});

test('only an admin may start an update', async () => {
  const { roleAllows } = await import('../panel/access-control.mjs');
  assert.equal(roleAllows('admin', 'POST', '/api/update'), true);
  assert.equal(roleAllows('ejecutar', 'POST', '/api/update'), false);
  assert.equal(roleAllows('revisar', 'GET', '/api/update'), true, 'anyone allowed in may see that there is a new version');
});
