import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LAUNCH_LEVELS, LAUNCH_LEVELS, launchFlags, normalizeLaunchLevels, readLaunchLevels } from '../orca-provider.mjs';

// Improvement 4: levels per role (ligero/estandar/profundo) translated per agent.
const roles = ['planificador', 'ux', 'desarrollador', 'qa', 'revisor'];

test('the defaults reproduce the current Codex flags exactly and give Claude no flags', () => {
  assert.deepEqual(launchFlags('planificador', 'codex'), ['--model', 'gpt-6-luna', '--effort', 'high']);
  for (const role of roles.slice(1)) assert.deepEqual(launchFlags(role, 'codex'), ['--model', 'gpt-6.1-sol', '--effort', 'medium']);
  for (const role of roles) assert.deepEqual(launchFlags(role, 'claude'), []);
  assert.deepEqual(LAUNCH_LEVELS, ['ligero', 'estandar', 'profundo']);
  assert.deepEqual(normalizeLaunchLevels(undefined), DEFAULT_LAUNCH_LEVELS);
  assert.deepEqual(normalizeLaunchLevels({}).roles, DEFAULT_LAUNCH_LEVELS.roles);
});

test('a local configuration changes role levels and adds Claude flags without touching unspecified Codex entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-levels-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readLaunchLevels(root), DEFAULT_LAUNCH_LEVELS);
  await fs.mkdir(path.join(root, 'data'));
  const example = JSON.parse(await fs.readFile(new URL('../ejemplos/orca-launch-levels.example.json', import.meta.url), 'utf8'));
  await fs.writeFile(path.join(root, 'data', 'orca-launch-levels.json'), JSON.stringify(example));
  const levels = await readLaunchLevels(root);
  assert.equal(levels.roles.qa, 'ligero');
  assert.deepEqual(launchFlags('qa', 'codex', levels), ['--model', 'gpt-6.1-sol', '--effort', 'low']);
  assert.deepEqual(launchFlags('planificador', 'codex', levels), ['--model', 'gpt-6-luna', '--effort', 'high']);
  assert.deepEqual(launchFlags('qa', 'claude', levels), ['--model', 'haiku']);
  assert.deepEqual(launchFlags('planificador', 'claude', levels), ['--model', 'opus', '--effort', 'high']);
  // Only roles are overridden: Codex keeps its default table.
  await fs.writeFile(path.join(root, 'data', 'orca-launch-levels.json'), JSON.stringify({ roles: { desarrollador: 'profundo' } }));
  const partial = await readLaunchLevels(root);
  assert.deepEqual(launchFlags('desarrollador', 'codex', partial), ['--model', 'gpt-6-luna', '--effort', 'high']);
  assert.deepEqual(launchFlags('desarrollador', 'claude', partial), []);
  // A level can be removed for an agent with null; effort-only entries are allowed.
  const trimmed = normalizeLaunchLevels({ agents: { codex: { profundo: null }, claude: { estandar: { effort: 'medium' } } } });
  assert.deepEqual(launchFlags('planificador', 'codex', trimmed), []);
  assert.deepEqual(launchFlags('ux', 'claude', trimmed), ['--effort', 'medium']);
});

test('invalid level files are rejected with a typed error instead of launching with guessed flags', async t => {
  for (const bad of [[], { roles: { otro: 'ligero' } }, { roles: { qa: 'maximo' } }, { agents: { gemini: {} } }, { agents: { claude: { estandar: {} } } },
    { agents: { claude: { estandar: { model: 'opus; rm -rf /' } } } }, { agents: { codex: { intenso: { model: 'x' } } } }, { agents: { codex: [] } }]) {
    assert.throws(() => normalizeLaunchLevels(bad), { code: 'launch_levels_invalid' }, JSON.stringify(bad));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-levels-bad-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data')); await fs.writeFile(path.join(root, 'data', 'orca-launch-levels.json'), '{ not json');
  await assert.rejects(readLaunchLevels(root), { code: 'launch_levels_invalid' });
});

test('runStage passes the configured Claude flags to worker-start and records the level on the stage', async t => {
  const { runOrca } = await import('../orca-provider.mjs');
  const previous = process.env.CENTRO_ORCA_AGENT; process.env.CENTRO_ORCA_AGENT = 'claude';
  t.after(() => { if (previous === undefined) delete process.env.CENTRO_ORCA_AGENT; else process.env.CENTRO_ORCA_AGENT = previous; });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-levels-run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'game'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'orca-launch-levels.json'), JSON.stringify({ roles: { qa: 'ligero' }, agents: { claude: { ligero: { model: 'haiku' }, estandar: { model: 'sonnet', effort: 'medium' } } } }));
  const starts = [], updates = [];
  const ctx = { root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_levels01' };
    if (args[1] === 'worker-start') { const dispatchId = `ctx_level${starts.length + 1}`; starts.push({ key: updates.at(-1).key, level: updates.at(-1).launchLevel, args }); return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_levels01', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') { const key = starts.at(-1).key; return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'Validación correcta.\nRESULTADO: APROBADO' : `${key} completado`, payload: JSON.stringify({ dispatchId: `ctx_level${starts.length}` }) }] }; }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  await runOrca({ id: 'levels-001', business: 'agency', kind: 'code', provider: 'orca', title: 'Niveles', prompt: 'Probar niveles.', workspace, isolated: true, attempts: 1 }, ctx, { command });
  const flags = start => { const i = start.args.indexOf('--model'); return i < 0 ? null : start.args.slice(i, i + (start.args[i + 2] === '--effort' ? 4 : 2)); };
  assert.deepEqual(starts.map(start => [start.key, start.level, flags(start)]), [
    ['ux', 'estandar', ['--model', 'sonnet', '--effort', 'medium']], ['developer', 'estandar', ['--model', 'sonnet', '--effort', 'medium']],
    ['qa', 'ligero', ['--model', 'haiku']], ['reviewer', 'estandar', ['--model', 'sonnet', '--effort', 'medium']]]);
  for (const start of starts) assert.equal(start.args[start.args.indexOf('--agent') + 1], 'claude');
});
