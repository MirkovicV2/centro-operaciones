import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCoordinatorBindings, selectCoordinatorBinding } from '../coordinator-routing.mjs';

const coordinator = (id, business) => ({ id, name: `Coordinador ${id}`, business, runId: `run_${id}123456`, senderId: `term_${id}123456`,
  worktreeId: `repo-${id}::C:/fixtures/${id}`, sessionId: null });
const games = coordinator('games', 'games'), gameProject = coordinator('flecha', 'games'), agency = coordinator('agency', 'agency');
const config = () => ({ schemaVersion: 1, coordinators: [games, gameProject, agency], projects: { flecha: gameProject.id, client: agency.id }, businesses: { games: games.id, agency: agency.id } });
const request = (business = 'games', projectId = 'flecha') => ({ id: 'request-fixture', snapshot: { business, projectId } });
const env = { ORCA_COORDINATOR_RUN_ID: 'run_legacy123', ORCA_COORDINATOR_SENDER: 'terminal_legacy' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-routing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  return { root, file: path.join(root, 'data', 'coordinator-bindings.json') };
}

test('project routes win over business defaults and never mix companies', () => {
  const project = selectCoordinatorBinding(request(), config(), { env });
  assert.equal(project.coordinatorId, gameProject.id);
  assert.equal(project.routeScope, 'project'); assert.equal(project.routeKey, 'flecha');
  assert.equal(project.runId, gameProject.runId); assert.equal(project.senderId, gameProject.senderId);
  const client = selectCoordinatorBinding(request('agency', 'client'), config(), { env });
  assert.equal(client.coordinatorId, agency.id);
  for (const projectId of [null, 'unassigned-project']) {
    const fallback = selectCoordinatorBinding(request('games', projectId), config(), { env });
    assert.equal(fallback.coordinatorId, games.id); assert.equal(fallback.routeScope, 'business');
  }
});

test('an explicit project binding to another company fails without business or environment fallback', () => {
  const wrong = config(); wrong.projects.flecha = agency.id;
  assert.throws(() => selectCoordinatorBinding(request(), wrong, { env }), { code: 'coordinator_binding_mismatch' });
  const missing = config(); missing.projects = {}; missing.businesses = {};
  assert.throws(() => selectCoordinatorBinding(request(), missing, { env }), { code: 'coordinator_binding_missing' });
  assert.throws(() => selectCoordinatorBinding({ ...request(), business: 'agency' }, config(), { env }), { code: 'coordinator_request_mismatch' });
  assert.throws(() => selectCoordinatorBinding({ ...request(), projectId: 'client' }, config(), { env }), { code: 'coordinator_request_mismatch' });
});

test('absent configuration preserves explicit legacy environment identity and does not create files', async t => {
  const { root, file } = await fixture(t);
  assert.equal(await readCoordinatorBindings(root), null);
  const target = selectCoordinatorBinding(request(), null, { env });
  assert.equal(target.routeScope, 'legacy'); assert.equal(target.runId, env.ORCA_COORDINATOR_RUN_ID);
  assert.equal(selectCoordinatorBinding(request(), null, { env: { ORCA_COORDINATOR_RUN_ID: env.ORCA_COORDINATOR_RUN_ID, ORCA_TERMINAL_HANDLE: env.ORCA_COORDINATOR_SENDER } }).senderId, env.ORCA_COORDINATOR_SENDER);
  assert.throws(() => selectCoordinatorBinding(request(), null, { env: {} }), { code: 'coordinator_identity_required' });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('configuration reads are strict, read-only and accept an optional UTF-8 BOM', async t => {
  const { root, file } = await fixture(t);
  await fs.writeFile(file, '\uFEFF' + JSON.stringify(config()));
  assert.equal((await readCoordinatorBindings(root)).coordinators.length, 3);
  await fs.writeFile(file, '{broken-json');
  await assert.rejects(readCoordinatorBindings(root), { code: 'coordinator_bindings_invalid' });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken-json');
  await fs.rm(file); await fs.mkdir(file);
  await assert.rejects(readCoordinatorBindings(root), { code: 'coordinator_bindings_unreadable' });
});

test('invalid schema, identifiers, duplicate IDs and missing references fail closed', () => {
  const cases = [
    cfg => { cfg.schemaVersion = 2; },
    cfg => { cfg.coordinators.push({ ...games }); },
    cfg => { cfg.coordinators[0] = { ...games, runId: 'run wrong' }; },
    cfg => { cfg.coordinators[0] = { ...games, senderId: '' }; },
    cfg => { cfg.coordinators[0] = { ...games, worktreeId: 'a relative path' }; },
    cfg => { cfg.coordinators[0] = { ...games, sessionId: 'session\nsecret' }; },
    cfg => { cfg.projects.flecha = 'missing'; },
    cfg => { cfg.businesses.games = agency.id; },
    cfg => { cfg.businesses = []; },
  ];
  for (const change of cases) {
    const candidate = config(); change(candidate);
    assert.throws(() => selectCoordinatorBinding(request(), candidate, { env }), { code: 'coordinator_bindings_invalid' });
  }
});

test('saved sends retain identity and labels across config changes or disappearance', () => {
  const original = selectCoordinatorBinding(request(), config(), { env });
  for (const status of ['sending', 'unknown', 'sent', 'pending']) {
    const saved = { ...request(), notification: { ...original, status } };
    const renamed = config(); renamed.coordinators = renamed.coordinators.map(item => item.id === original.coordinatorId ? { ...item, name: 'New label' } : item);
    assert.deepEqual(selectCoordinatorBinding(saved, renamed, { env }), original);
    assert.deepEqual(selectCoordinatorBinding(saved, null, { env: {} }), original);
    const changed = config(); changed.projects.flecha = games.id;
    assert.throws(() => selectCoordinatorBinding(saved, changed, { env }), error => {
      assert.equal(error.code, 'coordinator_identity_changed'); assert.equal(error.binding.runId, original.runId); return true;
    });
  }
});

test('send intent is a destination fence; partial or conflicting saved identities cannot borrow configuration', () => {
  const original = selectCoordinatorBinding(request(), config(), { env });
  assert.deepEqual(selectCoordinatorBinding({ ...request(), sendIntent: original }, config(), { env }), original);
  assert.throws(() => selectCoordinatorBinding({ ...request(), notification: { runId: original.runId } }, config(), { env }), { code: 'coordinator_saved_identity_invalid' });
  assert.throws(() => selectCoordinatorBinding({ ...request(), sendIntent: original, notification: { ...original, senderId: 'term_foreign123' } }, config(), { env }), { code: 'coordinator_saved_identity_conflict' });
  assert.throws(() => selectCoordinatorBinding({ ...request(), notification: { ...original, routeKey: 'foreign-project' } }, config(), { env }), { code: 'coordinator_saved_identity_invalid' });
});
