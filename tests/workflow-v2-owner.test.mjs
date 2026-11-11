import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { candidateFiles, nextV2Step, preflightWorkflowV2, workflowV2Live, workflowV2RetryRefusal } from '../workflow-v2-gate.mjs';

const TASK = 'coord-x-code-73e486a80094';
const entry = { engineeringSystem: '/home/u/dev/engineering-system', python: 'python3', stateRoot: '/home/u/dev/wfv2-state/home finance' };
const statusRun = summary => async argv => {
  assert.deepEqual(argv.slice(-2), ['status', TASK]);
  return { code: 0, stdout: JSON.stringify(summary), stderr: '', timedOut: false };
};

async function governedRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wfv2-owner-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data', 'workflow-v2.json'), JSON.stringify({ version: 1, engineeringSystem: entry.engineeringSystem, python: 'python3',
    projects: { 'home-finance': { stateRoot: entry.stateRoot, allowedPaths: ['src/'], integrateAfterApproval: true } } }));
  return root;
}
const stoppedJob = (error, extra = {}) => ({ id: 'coord-x-code', kind: 'code', projectId: 'home-finance', state: 'needs_attention',
  workflow: { steps: [{ key: 'qa', status: 'succeeded' }, { key: 'reviewer', status: 'blocked', error, workflowV2: { task: TASK } }] }, ...extra });

test('the next V2 step names the exact command for each status (the panel used to suggest verdict in pendiente_owner)', () => {
  const owner = nextV2Step(entry, TASK, { status: 'pendiente_owner', required_reviews: ['unit'], accepted: ['unit'] });
  assert.equal(owner.action, 'approve');
  assert.equal(owner.command, `cd /home/u/dev/engineering-system && python3 -m wfv2.cli --repo '/home/u/dev/wfv2-state/home finance' approve ${TASK}`);
  const review = nextV2Step(entry, TASK, { status: 'revision', required_reviews: ['unit', 'specialist'], accepted: ['unit'], reviews: [{ role: 'unit' }, { role: 'specialist' }] });
  assert.equal(review.action, 'verdict');
  assert.match(review.command, / verdict coord-x-code-73e486a80094 specialist accepted$/);
  assert.equal(nextV2Step(entry, TASK, { status: 'revision', required_reviews: ['unit'], accepted: [], reviews: [] }).action, 'wait');
  assert.match(nextV2Step(entry, TASK, { status: 'bloqueado' }).command, / unblock coord-x-code-73e486a80094$/);
  assert.equal(nextV2Step(entry, TASK, { status: 'preparacion' }).action, 'retry');
  assert.equal(nextV2Step(entry, TASK, { status: 'aprobado' }).action, 'integrate');
  assert.equal(nextV2Step(entry, TASK, { status: 'aprobado' }).command, undefined, 'nothing to type once approved');
});

test('the live V2 status is read for the task on the reviewer step and only for governed jobs', async t => {
  const root = await governedRoot(t);
  const live = await workflowV2Live(root, stoppedJob('workflow_v2_owner_pending'), { run: statusRun({ task: TASK, status: 'pendiente_owner', tier: 'STANDARD',
    required_reviews: ['unit'], accepted: ['unit'], reviews: [{ role: 'unit', recommendation: 'ACCEPT', isolation: 'DEMONSTRATED', launch_id: 'x' }] }) });
  assert.equal(live.available, true);
  assert.equal(live.status, 'pendiente_owner');
  assert.deepEqual(live.reviews, [{ role: 'unit', recommendation: 'ACCEPT', isolation: 'DEMONSTRATED' }]);
  assert.equal(live.next.action, 'approve');
  assert.equal(await workflowV2Live(root, stoppedJob('workflow_v2_owner_pending', { projectId: 'forge' }), { run: statusRun({}) }), null);
  assert.equal(await workflowV2Live(root, { ...stoppedJob('x'), workflow: { steps: [] } }, { run: statusRun({}) }), null);
  const other = await workflowV2Live(root, stoppedJob('workflow_v2_owner_pending'), { run: statusRun({ task: 'otra', status: 'aprobado' }) });
  assert.equal(other.available, false, 'the status of another task is never trusted');
  const broken = await workflowV2Live(root, stoppedJob('workflow_v2_owner_pending'), { run: async () => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false }) });
  assert.equal(broken.available, false);
});

test('a retry that would meet the same V2 stop is refused without spending an attempt', () => {
  const live = status => ({ available: true, status, next: nextV2Step(entry, TASK, { status }) });
  assert.match(workflowV2RetryRefusal(stoppedJob('workflow_v2_owner_pending'), live('pendiente_owner')), /Falta tu decisión.*approve.*No se ha gastado/s);
  assert.equal(workflowV2RetryRefusal(stoppedJob('workflow_v2_owner_pending'), live('aprobado')), null);
  assert.match(workflowV2RetryRefusal(stoppedJob('workflow_v2_blocked'), live('bloqueado')), /sigue bloqueado/);
  assert.equal(workflowV2RetryRefusal(stoppedJob('workflow_v2_blocked'), live('preparacion')), null);
  assert.equal(workflowV2RetryRefusal(stoppedJob('workflow_v2_owner_pending'), { available: false }), null, 'without V2 the retry keeps its old behaviour');
  assert.equal(workflowV2RetryRefusal(stoppedJob('worker_error'), live('pendiente_owner')), null);
});

test('the candidate files come from git status, with new binaries flagged', async t => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'wfv2-files-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  await fs.mkdir(path.join(repo, 'shots'));
  await fs.writeFile(path.join(repo, 'app.js'), 'a'); await fs.writeFile(path.join(repo, 'shots', 'inicio.png'), 'a'); await fs.writeFile(path.join(repo, 'old.txt'), 'a');
  git('add', '.'); git('commit', '-qm', 'base');
  await fs.writeFile(path.join(repo, 'app.js'), 'b'); await fs.writeFile(path.join(repo, 'shots', 'inicio.png'), 'b');
  await fs.writeFile(path.join(repo, 'shots', 'mobile casa.png'), 'n'); await fs.rm(path.join(repo, 'old.txt'));
  const { files, total } = await candidateFiles(repo);
  assert.equal(total, 4);
  const by = Object.fromEntries(files.map(file => [file.path, file]));
  assert.deepEqual(by['app.js'], { path: 'app.js', change: 'modificado', binary: false });
  assert.deepEqual(by['shots/inicio.png'], { path: 'shots/inicio.png', change: 'modificado', binary: true });
  assert.deepEqual(by['shots/mobile casa.png'], { path: 'shots/mobile casa.png', change: 'nuevo', binary: true });
  assert.equal(by['old.txt'].change, 'borrado');
  assert.deepEqual((await candidateFiles('relativo')).files, []);
});

test('the V2 preflight lists every missing piece and runs wfv2 only when the checkout exists', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wfv2-pre-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const system = path.join(base, 'es'), state = path.join(base, 'state'), env = path.join(base, 'venv');
  await fs.mkdir(system); await fs.mkdir(state); await fs.mkdir(path.join(env, 'bin'), { recursive: true }); await fs.writeFile(path.join(env, 'bin', 'python'), '');
  const calls = [];
  const ok = async argv => { calls.push(argv); return { code: 0, stdout: '', stderr: '', timedOut: false }; };
  await preflightWorkflowV2({ engineeringSystem: system, python: 'python3', stateRoot: state, reviewerConfig: null, pythonEnv: env }, { run: ok });
  assert.deepEqual(calls, [['python3', '-m', 'wfv2.cli', '--help']]);
  await assert.rejects(preflightWorkflowV2({ engineeringSystem: system, python: 'python3', stateRoot: path.join(base, 'nope'), reviewerConfig: path.join(base, 'r.json'), pythonEnv: state }, { run: ok }),
    error => error.code === 'workflow_v2_preflight_failed' && /no existe stateRoot/.test(error.message) && /no existe reviewerConfig/.test(error.message)
      && /pythonEnv no contiene un intérprete/.test(error.message) && /ningún agente/.test(error.message));
  await assert.rejects(preflightWorkflowV2({ engineeringSystem: system, python: 'python3', stateRoot: state }, { run: async () => ({ code: 1, stdout: '', stderr: 'ModuleNotFoundError: wfv2', timedOut: false }) }),
    /wfv2 no arranca: ModuleNotFoundError/);
  calls.length = 0;
  await assert.rejects(preflightWorkflowV2({ engineeringSystem: path.join(base, 'none'), python: 'python3', stateRoot: state }, { run: ok }), /no existe engineeringSystem/);
  assert.equal(calls.length, 0, 'wfv2 is not started without its checkout');
});
