import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveLaunch, validateJobLaunch } from '../launch-choice.mjs';
import { normalizeLaunchLevels, launchFlags, runOrca } from '../orca-provider.mjs';
import { addJob, loadState } from '../queue.mjs';
import { jobReport } from '../panel/job-report.mjs';

// Model choice in three layers: default → project → job. The most specific wins and the stage records it.
const levels = normalizeLaunchLevels({
  roles: { qa: 'estandar', revisor: 'estandar' },
  projects: { obi: { roles: { revisor: 'profundo' } } },
  agents: { claude: { estandar: { model: 'sonnet' }, profundo: { model: 'opus', effort: 'medium' } } },
});

test('default, project and job layers resolve in that order; a job choice for another agent is ignored', () => {
  assert.deepEqual(resolveLaunch({ roleName: 'revisor', agent: 'claude', levels }), { agent: 'claude', level: 'estandar', model: 'sonnet', effort: null, source: 'por defecto' });
  assert.deepEqual(resolveLaunch({ roleName: 'revisor', agent: 'claude', levels, projectId: 'obi' }), { agent: 'claude', level: 'profundo', model: 'opus', effort: 'medium', source: 'proyecto' });
  const jobLaunch = validateJobLaunch({ agent: 'claude', roles: { revisor: { model: 'claude-opus-5-5', effort: 'medium' }, qa: { model: 'sonnet', effort: 'high' } } });
  assert.deepEqual(resolveLaunch({ roleName: 'revisor', agent: 'claude', levels, projectId: 'obi', jobLaunch }), { agent: 'claude', level: null, model: 'claude-opus-5-5', effort: 'medium', source: 'encargo' });
  assert.deepEqual(launchFlags('qa', 'claude', levels, { jobLaunch }), ['--model', 'sonnet', '--effort', 'high']);
  assert.equal(resolveLaunch({ roleName: 'qa', agent: 'codex', levels, jobLaunch }).source, 'por defecto', 'Claude model names never reach Codex');
  assert.deepEqual(launchFlags('qa', 'codex', normalizeLaunchLevels(null)), ['--model', 'gpt-6.1-sol', '--effort', 'medium'], 'Codex defaults unchanged');
  assert.deepEqual(launchFlags('qa', 'claude', normalizeLaunchLevels(null)), [], 'without the file Claude gets no flags');
});

test('invalid project levels and job choices are refused with an actionable message', async t => {
  assert.throws(() => normalizeLaunchLevels({ projects: { obi: { roles: { revisor: 'maximo' } } } }), /nivel desconocido maximo/);
  assert.throws(() => normalizeLaunchLevels({ projects: { '../obi': { roles: {} } } }), /id de proyecto inválido/);
  for (const [value, message] of [
    [{ roles: { qa: { model: 'sonnet' } } }, /agent/],
    [{ agent: 'claude', roles: {} }, /al menos un rol/],
    [{ agent: 'claude', roles: { arquitecto: { model: 'opus' } } }, /Rol desconocido arquitecto/],
    [{ agent: 'claude', roles: { qa: { model: 'sonnet; rm -rf' } } }, /caracteres/],
    [{ agent: 'claude', roles: { qa: { model: 'sonnet', temperature: 1 } } }, /caracteres/],
  ]) assert.throws(() => validateJobLaunch(value), message);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const spec = { id: 'con-modelo', business: 'agency', kind: 'analysis', provider: 'orca', title: 'Con modelo', prompt: 'Analizar.' };
  await assert.rejects(addJob(root, { ...spec, launch: { agent: 'gpt', roles: { qa: { model: 'x' } } } }), { code: 'launch_choice_invalid' });
  await addJob(root, { ...spec, launch: { agent: 'claude', roles: { qa: { model: 'sonnet', effort: 'high' } } } });
  assert.deepEqual((await loadState(root)).jobs[0].launch, { agent: 'claude', roles: { qa: { model: 'sonnet', effort: 'high' } } });
});

test('each stage records what it was launched with and the report shows it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'launch-run-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'orca-launch-levels.json'), JSON.stringify({ roles: { revisor: 'estandar' }, projects: { web: { roles: { revisor: 'profundo' } } },
    agents: { claude: { estandar: { model: 'sonnet' }, profundo: { model: 'opus', effort: 'medium' } } } }));
  const workspace = path.join(root, 'workspaces', 'web'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const previous = process.env.CENTRO_ORCA_AGENT; process.env.CENTRO_ORCA_AGENT = 'claude';
  t.after(() => { if (previous === undefined) delete process.env.CENTRO_ORCA_AGENT; else process.env.CENTRO_ORCA_AGENT = previous; });
  const starts = [], updates = [];
  const ctx = { root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_launch001' };
    if (args[1] === 'run-show') return { run: { id: 'run_launch001', coordinator_handle: 'term_launch' } };
    if (args[0] === 'terminal') return { terminal: { handle: 'term_launch', connected: true, writable: true } };
    if (args[1] === 'worker-start') { starts.push(args); const dispatchId = `ctx_launch${starts.length}`; return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_launch001', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') { const key = updates.at(-1).key; return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'OK.\nRESULTADO: APROBADO' : `${key} listo`, payload: JSON.stringify({ dispatchId: `ctx_launch${starts.length}` }) }] }; }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  await runOrca({ id: 'launch-001', business: 'agency', projectId: 'web', kind: 'code', provider: 'orca', title: 'Modelos', prompt: 'Probar modelos.', workspace, isolated: true, attempts: 1,
    launch: { agent: 'claude', roles: { qa: { model: 'sonnet', effort: 'high' } } },
    coordination: { requestId: 'coord-launch', runId: 'run_launch001', senderId: 'term_launch', business: 'agency', projectId: 'web' } }, ctx, { command });
  const flags = start => start.slice(start.indexOf('--agent'), start.indexOf('--agent') + 6);
  assert.deepEqual(flags(starts[2]), ['--agent', 'claude', '--model', 'sonnet', '--effort', 'high'], 'QA: chosen in the job');
  assert.deepEqual(flags(starts[3]), ['--agent', 'claude', '--model', 'opus', '--effort', 'medium'], 'Revisión: project default');
  const launched = Object.fromEntries(updates.filter(item => item.launch).map(item => [item.key, item.launch]));
  assert.deepEqual(launched.qa, { agent: 'claude', level: null, model: 'sonnet', effort: 'high', source: 'encargo' });
  assert.deepEqual(launched.reviewer, { agent: 'claude', level: 'profundo', model: 'opus', effort: 'medium', source: 'proyecto' });
  assert.equal(launched.ux.source, 'por defecto');
  const step = (key, launch) => ({ key, status: 'succeeded', runId: 'run_launch001', taskId: `task_${key}`, dispatchId: `ctx_${key}`, launch });
  const report = jobReport({ id: 'launch-001', title: 'Modelos', workflow: { steps: [step('qa', launched.qa), step('reviewer', launched.reviewer), { key: 'ux', status: 'succeeded', orcaAgent: 'codex', launchLevel: 'estandar' }] } });
  const model = key => report.stages.find(stage => stage.key === key).facts.find(fact => fact.label === 'Modelo');
  assert.deepEqual(model('qa'), { label: 'Modelo', value: 'claude · sonnet · esfuerzo high (elegido en el encargo)', level: 'observed' });
  assert.equal(model('reviewer').value, 'claude · opus · esfuerzo medium (por defecto del proyecto, nivel profundo)');
  assert.deepEqual(model('ux'), { label: 'Modelo', value: 'codex · nivel estandar · modelo no registrado', level: 'unknown' });
});
