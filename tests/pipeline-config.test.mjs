import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EMPTY_PIPELINE, disablePipeline, normalizePipeline, pipelineAgents, previewPipeline, readPipeline, resolveStageLaunch, writePipeline } from '../pipeline-config.mjs';
import { DEFAULT_LAUNCH_LEVELS, LAUNCH_LEVELS, normalizeLaunchLevels } from '../orca-provider.mjs';
import { resolveLaunch, validateJobLaunch } from '../launch-choice.mjs';

const levelNames = LAUNCH_LEVELS;
const levels = normalizeLaunchLevels({ agents: { claude: { ligero: { model: 'haiku' }, estandar: { model: 'sonnet' }, profundo: { model: 'opus', effort: 'high' } } },
  projects: { legado: { roles: { revisor: 'profundo' } } } });
const example = JSON.parse(await fs.readFile(new URL('../ejemplos/pipeline.mixto.example.json', import.meta.url), 'utf8'));
const mixed = normalizePipeline(example, { levelNames });
const resolve = (roleName, extra = {}) => resolveStageLaunch({ roleName, levels, pipeline: mixed, defaultAgent: 'codex', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles, ...extra });
const flags = launch => [launch.agent, launch.model, launch.effort];

test('without data/pipeline.json every stage resolves exactly as the previous per-agent resolution', () => {
  for (const agent of ['codex', 'claude']) for (const roleName of ['planificador', 'ux', 'desarrollador', 'qa', 'revisor']) for (const projectId of [null, 'legado']) {
    for (const jobLaunch of [null, validateJobLaunch({ agent: 'claude', roles: { qa: { model: 'sonnet', effort: 'high' }, revisor: { effort: 'low' } } })]) {
      const { origin, ...actual } = resolveStageLaunch({ roleName, levels, pipeline: EMPTY_PIPELINE, defaultAgent: agent, projectId, jobLaunch, fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
      assert.deepEqual(actual, resolveLaunch({ roleName, agent, levels, projectId, jobLaunch, fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles }), `${agent} ${roleName} ${projectId}`);
    }
  }
});

test('the shipped mixed example puts Claude on Diseño and Desarrollo and Codex on Planificación, QA and Revisión in both businesses', () => {
  assert.deepEqual(flags(resolve('planificador', { business: 'agency' })), ['codex', 'gpt-6.1-sol', 'high']);
  assert.deepEqual(flags(resolve('ux', { business: 'agency' })), ['claude', 'sonnet', 'medium']);
  assert.deepEqual(flags(resolve('desarrollador', { business: 'agency' })), ['claude', 'sonnet', 'medium']);
  assert.deepEqual(flags(resolve('ux', { business: 'games' })), ['claude', 'sonnet', 'high']);
  assert.deepEqual(flags(resolve('desarrollador', { business: 'games' })), ['claude', 'sonnet', 'high']);
  for (const business of ['agency', 'games']) {
    assert.deepEqual(flags(resolve('qa', { business })), ['codex', 'gpt-6.1-sol', 'medium']);
    assert.deepEqual(flags(resolve('revisor', { business })), ['codex', 'gpt-6.1-sol', 'high']);
  }
  assert.deepEqual(resolve('desarrollador', { business: 'games' }).origin, { agent: 'general', model: 'general', effort: 'empresa' });
  assert.deepEqual(pipelineAgents(mixed, 'codex').sort(), ['claude', 'codex']);
  assert.deepEqual(pipelineAgents(EMPTY_PIPELINE, 'codex'), ['codex']);
});

test('general, empresa, proyecto and encargo combine field by field; the most specific wins', () => {
  const pipeline = normalizePipeline({ version: 1, general: { roles: { qa: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } } },
    empresas: { games: { roles: { qa: { effort: 'high' } } } }, proyectos: { flecha: { roles: { qa: { agent: 'codex', model: 'gpt-6-luna' } } }, legado: { roles: { revisor: { level: 'ligero' } } } } }, { levelNames });
  const at = extra => resolveStageLaunch({ roleName: 'qa', levels, pipeline, defaultAgent: 'claude', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles, ...extra });
  assert.deepEqual(flags(at({ business: 'agency' })), ['codex', 'gpt-6.1-sol', 'medium']);
  assert.equal(at({ business: 'agency' }).source, 'general');
  assert.deepEqual(flags(at({ business: 'games' })), ['codex', 'gpt-6.1-sol', 'high']);
  assert.deepEqual(flags(at({ business: 'games', projectId: 'flecha' })), ['codex', 'gpt-6-luna', 'high'], 'project keeps the business effort, replaces the model');
  const job = validateJobLaunch({ roles: { qa: { effort: 'low' } } });
  assert.deepEqual(flags(at({ business: 'games', projectId: 'flecha', jobLaunch: job })), ['codex', 'gpt-6-luna', 'low']);
  assert.equal(at({ business: 'games', projectId: 'flecha', jobLaunch: job }).source, 'encargo');
  // The new project layer comes after the legacy one from orca-launch-levels.json.
  const reviewer = resolveStageLaunch({ roleName: 'revisor', levels, pipeline, defaultAgent: 'claude', projectId: 'legado', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
  assert.deepEqual([reviewer.model, reviewer.level, reviewer.source], ['haiku', 'ligero', 'proyecto']);
});

test('changing the provider drops the model and effort of the other one; a model never crosses providers', () => {
  // Project moves Desarrollo back to Codex without naming a model: it gets the Codex level, not "sonnet".
  const toCodex = resolve('desarrollador', { business: 'games', jobLaunch: validateJobLaunch({ roles: { desarrollador: { agent: 'codex' } } }) });
  assert.deepEqual([toCodex.agent, toCodex.model, toCodex.effort, toCodex.level], ['codex', 'gpt-6.1-sol', 'medium', 'estandar']);
  const toClaude = resolve('qa', { business: 'agency', jobLaunch: validateJobLaunch({ roles: { qa: { agent: 'claude' } } }) });
  assert.deepEqual([toClaude.agent, toClaude.model, toClaude.effort], ['claude', 'sonnet', null]);
  // Legacy job form: a Claude choice is ignored on a stage that runs with Codex, and applied where Claude runs.
  const legacy = validateJobLaunch({ agent: 'claude', roles: { qa: { model: 'opus' }, ux: { model: 'opus' } } });
  assert.deepEqual(flags(resolve('qa', { business: 'agency', jobLaunch: legacy })), ['codex', 'gpt-6.1-sol', 'medium']);
  assert.deepEqual(flags(resolve('ux', { business: 'agency', jobLaunch: legacy })), ['claude', 'opus', null]);
  const preview = previewPipeline({ business: 'agency', kind: 'code', launch: legacy, levels, pipeline: mixed, defaultAgent: 'codex', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
  assert.equal(preview.warnings.length, 1); assert.match(preview.warnings[0], /qa.*se ignora/);
  assert.throws(() => validateJobLaunch({ roles: { qa: { model: 'sonnet' } } }), /agent/);
  assert.throws(() => normalizePipeline({ version: 1, general: { roles: { qa: { model: 'sonnet' } } } }, { levelNames }), /indica también agent/);
});

test('an escalation needs a reason, a scope and a verifiable result, and is recorded with the launch', () => {
  const launch = validateJobLaunch({ roles: { revisor: { escalada: 'gpt-astra', motivo: 'Dos revisiones discrepan', alcance: 'Solo el guardado', resultado: 'Reproducción o descarte razonado' } } });
  const escalated = resolve('revisor', { business: 'games', jobLaunch: launch });
  assert.deepEqual(flags(escalated), ['codex', 'gpt-6-astra', 'high']);
  assert.equal(escalated.source, 'escalada');
  assert.deepEqual(escalated.escalation, { id: 'gpt-astra', motivo: 'Dos revisiones discrepan', alcance: 'Solo el guardado', resultado: 'Reproducción o descarte razonado' });
  assert.deepEqual(flags(resolve('desarrollador', { business: 'agency', jobLaunch: validateJobLaunch({ roles: { desarrollador: { escalada: 'claude-opus', motivo: 'm', alcance: 'a', resultado: 'r' } } }) })), ['claude', 'opus', null]);
  assert.throws(() => validateJobLaunch({ roles: { revisor: { escalada: 'gpt-astra', motivo: 'sin alcance' } } }), /motivo, alcance y resultado/);
  assert.throws(() => resolve('desarrollador', { jobLaunch: validateJobLaunch({ roles: { desarrollador: { escalada: 'gpt-astra', motivo: 'm', alcance: 'a', resultado: 'r' } } }) }), { code: 'pipeline_config_invalid', message: /no cubre el rol desarrollador/ });
  assert.throws(() => resolve('qa', { jobLaunch: validateJobLaunch({ roles: { qa: { escalada: 'inexistente', motivo: 'm', alcance: 'a', resultado: 'r' } } }) }), /no está definida/);
});

test('an invalid pipeline file is refused with an actionable message', async t => {
  for (const [value, message] of [
    [{ general: {} }, /version debe ser 1/],
    [{ version: 1, modelos: {} }, /campo desconocido modelos/],
    [{ version: 1, general: { roles: { arquitecto: { agent: 'codex' } } } }, /rol desconocido arquitecto/],
    [{ version: 1, general: { roles: { qa: { agent: 'gemini' } } } }, /agent debe ser codex o claude/],
    [{ version: 1, general: { roles: { qa: { agent: 'codex', model: 'x; rm -rf' } } } }, /caracteres/],
    [{ version: 1, general: { roles: { qa: { level: 'maximo' } } } }, /nivel desconocido maximo/],
    [{ version: 1, general: { roles: { qa: { level: 'ligero', effort: 'low' } } } }, /level o model\/effort/],
    [{ version: 1, general: { roles: { qa: { agent: 'codex', temperature: 1 } } } }, /campo desconocido temperature/],
    [{ version: 1, empresas: { tienda: { roles: {} } } }, /identificador inválido tienda/],
    [{ version: 1, proyectos: { '../x': { roles: {} } } }, /identificador inválido/],
    [{ version: 1, escaladas: { fuerte: { agent: 'claude', roles: ['ux'] } } }, /necesita agent y model/],
    [{ version: 1, escaladas: { fuerte: { agent: 'claude', model: 'opus', roles: [] } } }, /roles debe listar/],
  ]) assert.throws(() => normalizePipeline(value, { levelNames }), error => error.code === 'pipeline_config_invalid' && message.test(error.message), JSON.stringify(value));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await readPipeline(root, { levelNames }), EMPTY_PIPELINE, 'no file = previous behaviour');
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data', 'pipeline.json'), '﻿' + JSON.stringify(example));
  assert.deepEqual(await readPipeline(root, { levelNames }), mixed, 'a BOM written by a Windows editor is accepted');
  await fs.writeFile(path.join(root, 'data', 'pipeline.json'), '{ roto');
  await assert.rejects(readPipeline(root, { levelNames }), /JSON ilegible/);
});

test('the preview shows the route of each kind without creating anything, also from the CLI', () => {
  const analysis = previewPipeline({ business: 'games', kind: 'analysis', levels, pipeline: mixed, defaultAgent: 'codex', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
  assert.deepEqual(analysis.stages.map(stage => stage.role), ['planificador']); assert.equal(analysis.integration, undefined);
  const code = previewPipeline({ business: 'games', kind: 'code', levels, pipeline: mixed, defaultAgent: 'codex', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles });
  assert.deepEqual(code.stages.map(stage => `${stage.role}:${stage.agent}`), ['ux:claude', 'desarrollador:claude', 'qa:codex', 'revisor:codex']);
  assert.match(code.integration, /Motor/);
  assert.throws(() => previewPipeline({ business: 'tienda', kind: 'code', levels, pipeline: mixed }), /business/);
  // Runs against this checkout's own data/: only the shape is asserted, whatever split is configured here.
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'preview', '--business', 'agency', '--kind', 'code'], { encoding: 'utf8', env: { ...process.env, CENTRO_ORCA_AGENT: 'codex' } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /Diseño\s+(codex|claude)\s/); assert.match(cli.stdout, /Integración\s+Motor/);
});

test('saving the split from the panel validates first, keeps the previous file and records who changed what', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-write-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'pipeline.json'), log = path.join(root, 'data', 'pipeline-changes.jsonl');
  await assert.rejects(writePipeline(root, { general: { roles: { qa: { model: 'sonnet' } } } }, { levelNames }), { code: 'pipeline_config_invalid' });
  await assert.rejects(fs.access(file), { code: 'ENOENT' }, 'an invalid split writes nothing');
  assert.equal((await writePipeline(root, example, { levelNames, actor: 'dani@example.test' })).changed, true);
  assert.deepEqual(await readPipeline(root, { levelNames }), mixed);
  assert.equal((await writePipeline(root, mixed, { levelNames, actor: 'dani@example.test' })).changed, false, 'saving the same split is not a change');
  const next = JSON.parse(JSON.stringify(mixed)); next.general.roles.qa = { agent: 'claude', level: 'ligero' };
  await writePipeline(root, next, { levelNames, actor: 'david@example.test' });
  assert.deepEqual(normalizePipeline(JSON.parse(await fs.readFile(file + '.anterior', 'utf8')), { levelNames }), mixed, 'the replaced file is one copy away');
  assert.equal((await disablePipeline(root, { actor: 'david@example.test' })).changed, true);
  assert.equal(await readPipeline(root, { levelNames }), EMPTY_PIPELINE);
  assert.equal((await disablePipeline(root)).changed, false);
  const changes = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(changes.map(item => [item.type, item.actor]), [['saved', 'dani@example.test'], ['saved', 'david@example.test'], ['disabled', 'david@example.test']]);
  assert.equal(changes[0].previousSha256, null); assert.equal(changes[1].previousSha256, changes[0].sha256); assert.equal(changes[2].previousSha256, changes[1].sha256);
  assert.deepEqual((await fs.readdir(path.join(root, 'data'))).filter(name => name.endsWith('.tmp')), []);
});
