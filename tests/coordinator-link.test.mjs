import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkCoordinator } from '../panel/coordinator-link.mjs';
import { readCoordinatorBindings } from '../panel/coordinator-routing.mjs';

// `vincular` writes the binding from Orca's own answers instead of a hand-copied runId/senderId.
const RUN = 'run_abcdef123456', TERM = 'term_0123456789abcdef';
const orca = ({ owner = TERM, connected = true, worktreeId = 'repo1::/home/x/centro' } = {}, calls = []) => async args => {
  calls.push(args.slice(0, 2).join(' '));
  if (args[1] === 'run-show') return { run: { id: args[3], coordinator_handle: owner } };
  if (args[0] === 'terminal') return { terminal: { handle: args[3], connected, writable: connected, worktreeId } };
  throw new Error(`inesperado: ${args.join(' ')}`);
};
async function root(t, bindings) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vincular-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (bindings) { await fs.mkdir(path.join(dir, 'data')); await fs.writeFile(path.join(dir, 'data', 'coordinator-bindings.json'), JSON.stringify(bindings)); }
  return dir;
}

test('a new PC gets a valid binding for the business from the Run owner and its live terminal', async t => {
  const dir = await root(t), calls = [];
  const linked = await linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: orca({}, calls) });
  assert.deepEqual(calls, ['orchestration run-show', 'terminal show']);
  assert.equal(linked.changed, true); assert.equal(linked.backup, null);
  const config = await readCoordinatorBindings(dir);
  assert.deepEqual(config.businesses, { agency: 'agencia-local' });
  assert.deepEqual(config.coordinators[0], { id: 'agencia-local', name: 'Coordinador de Agencia', business: 'agency', runId: RUN, senderId: TERM, worktreeId: 'repo1::/home/x/centro', sessionId: null });
});

test('relinking after an Orca restart keeps the other business and the project routes, and backs up the old file', async t => {
  const old = { schemaVersion: 1, projects: { 'project-1': 'agencia-local' }, businesses: { agency: 'agencia-local', games: 'juegos' },
    coordinators: [{ id: 'agencia-local', name: 'Mi agencia', business: 'agency', runId: 'run_oldoldold1', senderId: 'term_oldoldoldold' },
      { id: 'juegos', name: 'Juegos', business: 'games', runId: 'run_games12345', senderId: 'term_games123456' }] };
  const dir = await root(t, old);
  const linked = await linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: orca(), now: () => new Date('2026-11-12T00:00:00Z') });
  assert.equal(linked.backup, path.join('data', 'coordinator-bindings.json.anterior-2026-11-12T00-00-00-000Z'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, linked.backup), 'utf8')), old);
  const config = await readCoordinatorBindings(dir);
  assert.deepEqual(config.projects, { 'project-1': 'agencia-local' });
  assert.equal(config.coordinators.find(item => item.id === 'juegos').runId, 'run_games12345');
  const agency = config.coordinators.find(item => item.id === 'agencia-local');
  assert.equal(agency.name, 'Mi agencia'); assert.equal(agency.runId, RUN); assert.equal(agency.senderId, TERM);
  const again = await linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: orca() });
  assert.equal(again.changed, false, 'the same Run is not written again');
});

test('nothing is written when Orca does not vouch for the coordinator', async t => {
  const dir = await root(t);
  await assert.rejects(linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: orca({ owner: null }) }), { code: 'link_owner_unknown' });
  await assert.rejects(linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: orca({ connected: false }) }), { code: 'link_terminal_closed' });
  await assert.rejects(linkCoordinator(dir, { business: 'agency', runId: RUN }, { command: async () => { throw new Error('no such run'); } }), { code: 'link_run_unreadable' });
  await assert.rejects(linkCoordinator(dir, { business: 'shop', runId: RUN }, { command: orca() }), { code: 'link_business' });
  await assert.rejects(linkCoordinator(dir, { business: 'agency', runId: 'term_x' }, { command: orca() }), { code: 'link_run' });
  await assert.rejects(fs.access(path.join(dir, 'data', 'coordinator-bindings.json')));
  const broken = await root(t, { schemaVersion: 2 });
  await assert.rejects(linkCoordinator(broken, { business: 'agency', runId: RUN }, { command: orca() }), { code: 'link_existing_invalid' });
});
