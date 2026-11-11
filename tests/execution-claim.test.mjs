import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireClaim, claimRef, readClaim, releaseClaim } from '../execution-claim.mjs';
import { claimHold, teamHold, admissionHold } from '../admission-gate.mjs';
import { hostTeamId, missingResources, normalizeLocalTeam, normalizeTeams, readTeam, requiredResources, validateRequires } from '../team.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
// One shared remote and two PCs, each with its own clone, as in the real setup.
async function twoPcs(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'claim remoto ')); t.after(() => fs.rm(base, { recursive: true, force: true }));
  const remote = path.join(base, 'proyecto.git'); await fs.mkdir(remote); git(remote, 'init', '--bare', '--initial-branch=main');
  const clone = async name => {
    const root = path.join(base, name), workspace = path.join(root, 'workspaces', 'proyecto');
    await fs.mkdir(path.dirname(workspace), { recursive: true }); git(base, 'clone', '--quiet', remote, workspace);
    return { root, workspace };
  };
  const dani = await clone('pc dani'); await fs.writeFile(path.join(dani.workspace, 'README.md'), 'x'); git(dani.workspace, 'add', '.'); git(dani.workspace, 'commit', '--quiet', '-m', 'inicio'); git(dani.workspace, 'push', '--quiet', 'origin', 'HEAD:main');
  const david = await clone('pc david');
  for (const [pc, id] of [[dani, 'dani-windows'], [david, 'david-ubuntu']]) {
    await fs.mkdir(path.join(pc.root, 'data'), { recursive: true });
    await fs.writeFile(path.join(pc.root, 'data', 'equipo.json'), JSON.stringify({ version: 1, id, reservas: { activas: true, caducidadMinutos: 30 } }));
  }
  return { remote, dani, david };
}
const ttlMs = 30 * 60_000, t0 = Date.parse('2026-11-11T10:00:00Z');
const claim = (pc, team, jobId, now = t0) => acquireClaim({ workspace: pc.workspace, branch: 'develop', team, jobId, ttlMs, now });

test('only one PC holds a branch; the holder renews across a restart and gives it back when done', async t => {
  const { remote, dani, david } = await twoPcs(t);
  const first = await claim(dani, 'dani-windows', 'job-1');
  assert.equal(first.held, true); assert.equal(first.expiresAt, new Date(t0 + ttlMs).toISOString());
  assert.match(git(remote, 'for-each-ref', '--format=%(refname)'), new RegExp(claimRef('develop')));
  const denied = await claim(david, 'david-ubuntu', 'job-9', t0 + 60_000);
  assert.deepEqual([denied.held, denied.by, denied.jobId, denied.expiresAt], [false, 'dani-windows', 'job-1', first.expiresAt]);
  // The holder asks again after a restart: nothing local was needed, the remote says it is still its claim.
  const renewed = await claim(dani, 'dani-windows', 'job-1', t0 + 10 * 60_000);
  assert.equal(renewed.held, true); assert.equal(renewed.expiresAt, new Date(t0 + 10 * 60_000 + ttlMs).toISOString());
  assert.equal((await readClaim(dani.workspace, 'origin', claimRef('develop'))).claim.takenAt, new Date(t0).toISOString(), 'renewing keeps when it was first taken');
  // Another job of the same PC is not the holder either.
  assert.equal((await claim(dani, 'dani-windows', 'job-2', t0 + 11 * 60_000)).held, false);
  // Releasing someone else's claim does nothing; the holder's release frees the branch.
  assert.deepEqual(await releaseClaim({ workspace: david.workspace, branch: 'develop', team: 'david-ubuntu', jobId: 'job-9' }), { released: false });
  assert.deepEqual(await releaseClaim({ workspace: dani.workspace, branch: 'develop', team: 'dani-windows', jobId: 'job-1' }), { released: true });
  assert.equal((await claim(david, 'david-ubuntu', 'job-9', t0 + 12 * 60_000)).held, true);
  // Another branch is another claim.
  assert.equal((await acquireClaim({ workspace: dani.workspace, branch: 'feature/otra rama', team: 'dani-windows', jobId: 'job-3', ttlMs, now: t0 })).held, true);
  assert.notEqual(claimRef('feature/otra rama'), claimRef('feature-otra-rama'), 'different branches never share a claim');
});

test('an abandoned claim expires and is taken over atomically; the PC that went away finds out and stops', async t => {
  const { dani, david } = await twoPcs(t);
  await claim(dani, 'dani-windows', 'job-1');
  assert.equal((await claim(david, 'david-ubuntu', 'job-9', t0 + ttlMs - 1)).held, false, 'not expired yet');
  const taken = await claim(david, 'david-ubuntu', 'job-9', t0 + ttlMs);
  assert.equal(taken.held, true); assert.deepEqual(taken.tookOverFrom, { team: 'dani-windows', jobId: 'job-1', expiredAt: new Date(t0 + ttlMs).toISOString() });
  // Dani's PC comes back and tries to continue: the branch is no longer its.
  const back = await claim(dani, 'dani-windows', 'job-1', t0 + ttlMs + 60_000);
  assert.deepEqual([back.held, back.by, back.jobId], [false, 'david-ubuntu', 'job-9']);
  assert.deepEqual(await releaseClaim({ workspace: dani.workspace, branch: 'develop', team: 'dani-windows', jobId: 'job-1' }), { released: false }, 'it cannot delete the new holder\'s claim');
});

test('two PCs asking at the same moment cannot both win', async t => {
  for (let round = 0; round < 5; round++) {
    const { dani, david } = await twoPcs(t);
    const results = await Promise.all([claim(dani, 'dani-windows', 'job-1'), claim(david, 'david-ubuntu', 'job-9')]);
    assert.equal(results.filter(result => result.held).length, 1, JSON.stringify(results));
    const winner = results.find(result => result.held) === results[0] ? 'dani-windows' : 'david-ubuntu';
    assert.equal(results.find(result => !result.held).by, winner, 'the loser is told who holds it');
  }
});

test('offline nothing is claimed, and a ref that is not a claim of the Centro is never overwritten', async t => {
  const { remote, dani, david } = await twoPcs(t);
  await fs.rename(remote, remote + '.desconectado');
  await assert.rejects(claim(dani, 'dani-windows', 'job-1'), { code: 'claim_offline' });
  const offline = await claimHold({ id: 'job-1', kind: 'code', provider: 'orca', workspace: dani.workspace, branch: 'develop' }, { root: dani.root, now: t0 });
  assert.equal(offline.code, 'claim'); assert.match(offline.message, /sin conexión o sin acceso.*Sin reserva confirmada no se despacha/);
  await fs.rename(remote + '.desconectado', remote);
  git(dani.workspace, 'push', '--quiet', 'origin', `HEAD:${claimRef('develop')}`);
  await assert.rejects(claim(david, 'david-ubuntu', 'job-9'), { code: 'claim_unreadable' });
  assert.equal(git(remote, 'rev-parse', claimRef('develop')), git(dani.workspace, 'rev-parse', 'HEAD'));
});

test('the admission gate reserves the branch for code jobs only when this PC has reservations on, and names the holder', async t => {
  const { dani, david } = await twoPcs(t);
  const job = (pc, id = 'job-1') => ({ id, kind: 'code', provider: 'orca', business: 'agency', workspace: pc.workspace, branch: 'develop' });
  assert.equal(await claimHold(job(dani), { root: dani.root, now: t0 }), null);
  const held = await claimHold(job(david, 'job-9'), { root: david.root, now: t0 + 1000 });
  assert.equal(held.code, 'claim'); assert.match(held.message, /La rama develop está reservada por PC de Dani \(encargo job-1\)/); assert.equal(held.until, new Date(t0 + ttlMs).toISOString());
  assert.equal(await claimHold({ id: 'plan', kind: 'analysis', provider: 'orca' }, { root: david.root }), null, 'an analysis touches no branch');
  await fs.writeFile(path.join(david.root, 'data', 'equipo.json'), JSON.stringify({ version: 1, id: 'david-ubuntu' }));
  assert.equal(await claimHold(job(david, 'job-9'), { root: david.root, now: t0 + 2000 }), null, 'reservations are opt-in per PC');
  const unconfigured = await fs.mkdtemp(path.join(os.tmpdir(), 'sin-equipo-')); t.after(() => fs.rm(unconfigured, { recursive: true, force: true }));
  assert.equal(await claimHold(job(dani), { root: unconfigured }), null);
});

test('a job runs on the PC it belongs to, that has what it needs and has a free slot', async t => {
  const { dani, david } = await twoPcs(t);
  const game = { id: 'juego', kind: 'code', provider: 'orca', business: 'games' };
  assert.equal(await teamHold(game, { root: dani.root }), null);
  const missing = await teamHold(game, { root: david.root });
  assert.equal(missing.code, 'resource'); assert.match(missing.message, /PC de David\) no dispone de Godot.*Lo tiene: PC de Dani\./);
  const phone = await teamHold({ ...game, requires: ['telefonoFisico'] }, { root: dani.root });
  assert.match(phone.message, /no dispone de teléfono físico.*Ningún equipo registrado lo tiene\./);
  assert.equal(await teamHold({ id: 'web', kind: 'code', provider: 'orca', business: 'agency', requires: ['navegador'] }, { root: david.root }), null);
  // Belonging: a job stamped for the other PC is not run here; a provisional stamp (host name) is not enforced.
  assert.match((await teamHold({ id: 'web', kind: 'code', business: 'agency', team: { id: 'dani-windows', nombre: 'PC de Dani' } }, { root: david.root })).message, /pertenece al equipo PC de Dani/);
  assert.equal(await teamHold({ id: 'web', kind: 'code', business: 'agency', team: { id: 'viejo-host', provisional: true } }, { root: david.root }), null);
  // One job at a time by default; more only if this PC says so.
  const busy = [{ id: 'otro', state: 'running' }];
  assert.equal((await teamHold({ id: 'web', kind: 'analysis', business: 'agency' }, { root: david.root, jobs: busy })).code, 'concurrency');
  await fs.writeFile(path.join(david.root, 'data', 'equipo.json'), JSON.stringify({ version: 1, id: 'david-ubuntu', concurrencia: 2 }));
  assert.equal(await teamHold({ id: 'web', kind: 'analysis', business: 'agency' }, { root: david.root, jobs: busy }), null);
  // The job that starts is stamped with its responsible team.
  assert.deepEqual((await admissionHold({ id: 'web', kind: 'analysis', business: 'agency', provider: 'orca', workflow: { steps: [] } }, { root: david.root })).admit.team, { id: 'david-ubuntu', nombre: 'PC de David' });
  const unconfigured = await fs.mkdtemp(path.join(os.tmpdir(), 'sin-equipo-')); t.after(() => fs.rm(unconfigured, { recursive: true, force: true }));
  assert.deepEqual((await admissionHold({ id: 'web', kind: 'analysis', business: 'games', provider: 'orca', workflow: { steps: [] } }, { root: unconfigured })).admit.team, { id: hostTeamId(), nombre: os.hostname(), provisional: true });
  assert.equal(await teamHold(game, { root: unconfigured }), null, 'without data/equipo.json nothing is checked, as before');
  await fs.writeFile(path.join(david.root, 'data', 'equipo.json'), JSON.stringify({ version: 1, id: 'portatil-nuevo' }));
  assert.match((await teamHold(game, { root: david.root })).message, /no está en equipos\/equipos\.json/);
});

test('team files are validated with the field that is wrong, and the shipped ones are valid', async () => {
  const teams = normalizeTeams({ version: 1, equipos: { 'pc-uno': { nombre: 'Uno', sistema: 'ubuntu', recursos: ['godot', 'godot'] } } });
  assert.deepEqual(teams['pc-uno'].recursos, ['godot']);
  for (const [value, message] of [[{ version: 1, equipos: { 'PC Uno': { nombre: 'x', sistema: 'ubuntu', recursos: [] } } }, /identificador/], [{ version: 1, equipos: { uno: { nombre: 'x', sistema: 'amiga', recursos: [] } } }, /sistema/],
    [{ version: 1, equipos: { uno: { nombre: 'x', sistema: 'ubuntu', recursos: ['impresora'] } } }, /recursos/]]) assert.throws(() => normalizeTeams(value), error => error.code === 'team_config_invalid' && message.test(error.message));
  for (const [value, message] of [[{ version: 1, id: 'pc-uno', concurrencia: 9 }, /concurrencia/], [{ version: 1, id: 'pc-uno', reservas: { caducidadMinutos: 1 } }, /caducidadMinutos/], [{ version: 1, id: 'pc-uno', reservas: { remoto: 'origin; rm' } }, /remoto/]]) {
    assert.throws(() => normalizeLocalTeam(value, teams), error => error.code === 'team_config_invalid' && message.test(error.message));
  }
  const shipped = await readTeam(await fs.mkdtemp(path.join(os.tmpdir(), 'equipos-')));
  assert.deepEqual(Object.keys(shipped.equipos).sort(), ['dani-windows', 'david-ubuntu']);
  const example = JSON.parse(await fs.readFile(new URL('../ejemplos/equipo.example.json', import.meta.url), 'utf8'));
  assert.equal(normalizeLocalTeam(example, shipped.equipos).reservas.activas, false, 'the example does not turn reservations on by itself');
  assert.deepEqual(requiredResources({ business: 'games', kind: 'code', requires: ['emuladorAndroid'] }), ['godot', 'emuladorAndroid']);
  assert.deepEqual(requiredResources({ business: 'games', kind: 'analysis' }), []);
  assert.throws(() => validateRequires(['impresora']), { code: 'team_config_invalid' });
  assert.deepEqual(missingResources({ configured: false }, { business: 'games', kind: 'code' }), { missing: [], elsewhere: [] });
});

// Through the engine: the claim is renewed before each worker and released when the job ends well.
async function runJobOn(pc, { now } = {}) {
  const { runOrca } = await import('../orca-provider.mjs');
  const starts = [], updates = [];
  const ctx = { root: pc.root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {},
    ...(now ? { claimHold: (job, context) => claimHold(job, { ...context, now }) } : {}) };
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: pc.workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_claim0001' };
    if (args[1] === 'worker-start') { starts.push(args); const dispatchId = `ctx_claim${starts.length}`; return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_claim0001', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') { const key = updates.at(-1).key; return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'OK.\nRESULTADO: APROBADO' : `${key} listo`, payload: JSON.stringify({ dispatchId: `ctx_claim${starts.length}` }) }] }; }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const job = { id: 'job-1', business: 'agency', kind: 'code', provider: 'orca', title: 'Reserva', prompt: 'Probar la reserva.', workspace: pc.workspace, branch: 'develop', isolated: true, attempts: 1, team: { id: 'dani-windows', nombre: 'PC de Dani' } };
  try { await runOrca(job, ctx, { command }); return { starts, updates }; }
  catch (error) { return { starts, updates, error }; }
}

test('a job keeps its branch reserved while it works, records its team on each stage and frees the branch at the end', async t => {
  const { remote, dani } = await twoPcs(t);
  git(dani.workspace, 'checkout', '--quiet', '-b', 'develop');
  assert.equal(await claimHold({ id: 'job-1', kind: 'code', provider: 'orca', workspace: dani.workspace, branch: 'develop' }, { root: dani.root }), null);
  assert.match(git(remote, 'for-each-ref', '--format=%(refname)'), /refs\/centro\/claims\/develop-/);
  const run = await runJobOn(dani);
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.starts.length, 4);
  assert.deepEqual(run.updates.filter(update => update.dispatchStatus === 'starting').map(update => update.team.id), ['dani-windows', 'dani-windows', 'dani-windows', 'dani-windows']);
  assert.doesNotMatch(git(remote, 'for-each-ref', '--format=%(refname)'), /refs\/centro\/claims\//, 'the finished job gave the branch back');
});

test('if the other PC took the branch over while this one was away, no second worker is put on it', async t => {
  const { dani, david } = await twoPcs(t);
  git(dani.workspace, 'checkout', '--quiet', '-b', 'develop');
  await claim(dani, 'dani-windows', 'job-1', t0);
  assert.equal((await claim(david, 'david-ubuntu', 'job-9', t0 + ttlMs + 1)).held, true);
  const run = await runJobOn(dani, { now: t0 + ttlMs + 60_000 });
  assert.equal(run.error?.code, 'claim_lost', run.error?.message);
  assert.match(run.error.message, /reservada por PC de David \(encargo job-9\).*no se lanza/);
  assert.equal(run.starts.length, 0);
  assert.equal((await readClaim(david.workspace, 'origin', claimRef('develop'))).claim.team, 'david-ubuntu', 'the new holder keeps its claim');
});
