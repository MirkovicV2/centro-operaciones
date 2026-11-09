import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIdea as captureIdea, createProject, updateProject, loadDashboardState, mutateIdea } from '../agency-assistant/dashboard-state.mjs';
import { checkoutChoices, sendIdeaToQueue, reconcileIdeaRequests } from '../agency-assistant/idea-workflow.mjs';
import { readDashboardConfig, saveDashboardConfig } from '../agency-assistant/knowledge.mjs';
import { addJob, loadState, runQueue, acquireLock, releaseLock, recoverDashboardQueue, retryJob, resolveJob } from '../queue.mjs';
import { approved, runOrca } from '../../orca-provider.mjs';
import { verifyDispatchSpec } from '../../orca-evidence.mjs';

async function completeSpec(root, brief) {
  const artifact = { path: JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]), sha256: brief.match(/^SPEC_SHA256: ([a-f0-9]{64})$/m)[1] };
  await verifyDispatchSpec(root, artifact);
  return fs.readFile(artifact.path, 'utf8');
}

const createIdea = (root, business, text, projectId, operationId) => captureIdea(root, business, text, projectId, operationId, { focus: 'mixed' });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-flow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'workspaces', 'checkout', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'workspaces', 'checkout', '.git', 'objects'));
  await fs.writeFile(path.join(root, 'workspaces', 'checkout', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(root, 'workspaces', 'checkout', '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: path.join(root, 'workspaces', 'checkout'), windowsHide: true });
  const project = await createProject(root, 'Proyecto de prueba', 'agency');
  return { root, project };
}
const confirmation = project => ({ projectId: project.id, checkout: 'workspaces/checkout', branch: 'main', baseBranch: 'main', objective: 'Implementar esta idea concreta', successCriteria: 'Comprobar el comportamiento definido', productAcceptance: ['Comprobar el comportamiento definido'] });
const spec = id => ({ id, business: 'agency', kind: 'analysis', title: id, prompt: 'Analizar sin modificar código.', provider: 'orca' });

test('capture persists locally without Obsidian and duplicate capture/send creates one code job', async t => {
  const { root, project } = await fixture(t);
  await updateProject(root, project.id, { checkout: 'workspaces/checkout', baseBranch: 'main' });
  const ideas = await Promise.all([1, 2].map(() => createIdea(root, 'agency', 'Una idea verificable', project.id, 'capture-123456')));
  assert.equal(ideas[0].id, ideas[1].id);
  assert.equal((await loadDashboardState(root)).ideas.length, 1);
  assert.ok(ideas[0].noteError);
  const sent = await Promise.all([1, 2].map(() => sendIdeaToQueue(root, ideas[0].id, 'code', '', confirmation(project))));
  assert.equal(sent[0].job.id, sent[1].job.id);
  const jobs = (await loadState(root)).jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'code'); assert.equal(jobs[0].provider, 'orca');
  assert.equal(jobs[0].workspace, path.join(root, 'workspaces', 'checkout'));
  assert.equal(jobs[0].projectId, project.id);
  assert.deepEqual(jobs[0].workflow.steps.map(step => step.profile), ['ux_agency', 'desarrollador_agency', 'qa_agency', 'revisor_agency']);
  assert.equal((await readDashboardConfig(root)).autoRun, false);
  assert.equal((await sendIdeaToQueue(root, ideas[0].id, 'code', '', confirmation(project))).existing, true);
  await sendIdeaToQueue(root, ideas[0].id, 'analysis');
  assert.equal((await loadState(root)).jobs.length, 2);
  const historical = structuredClone((await loadState(root)).jobs);
  await assert.rejects(mutateIdea(root, ideas[0].id, 'trash', { version: 1 }), /Archivar/);
  const archived = await mutateIdea(root, ideas[0].id, 'archive', { version: 1 });
  await mutateIdea(root, ideas[0].id, 'restore', { version: archived.version });
  assert.deepEqual((await loadState(root)).jobs, historical);
});

test('checkout choice rejects external, nonexistent and shared metadata; missing checkout preserves idea', async t => {
  const { root, project } = await fixture(t);
  await assert.rejects(updateProject(root, project.id, { checkout: '../external' }));
  await assert.rejects(updateProject(root, project.id, { checkout: path.join(root, 'workspaces', 'checkout') }));
  await assert.rejects(updateProject(root, project.id, { checkout: 'workspaces/missing' }));
  await fs.mkdir(path.join(root, 'workspaces', 'linked'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspaces', 'linked', '.git'), 'gitdir: elsewhere');
  await fs.mkdir(path.join(root, 'workspaces', 'shared', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'workspaces', 'shared', '.git', 'commondir'), '../other');
  const choices = await checkoutChoices(root);
  assert.equal(choices.find(item => item.value.endsWith('/checkout')).valid, true);
  assert.equal(choices.find(item => item.value.endsWith('/linked')).valid, false);
  assert.equal(choices.find(item => item.value.endsWith('/shared')).valid, false);
  const idea = await createIdea(root, 'agency', 'Idea sin checkout', project.id);
  assert.equal((await sendIdeaToQueue(root, idea.id, 'code', '', confirmation(project))).job, undefined);
  assert.equal((await loadDashboardState(root)).ideas.length, 1);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('busy executor preserves durable send intent; reconciliation queues once without executing', async t => {
  const { root, project } = await fixture(t);
  await updateProject(root, project.id, { checkout: 'workspaces/checkout', baseBranch: 'main' });
  const idea = await createIdea(root, 'agency', 'Idea con ejecutor ocupado', project.id);
  const lock = await acquireLock(root);
  try {
    const result = await sendIdeaToQueue(root, idea.id, 'code', '', confirmation(project));
    assert.equal(result.job, undefined);
    assert.equal((await loadDashboardState(root)).ideas[0].requests.code.status, 'pending');
    assert.equal((await recoverDashboardQueue(root)).available, false);
  } finally { await releaseLock(lock); }
  await reconcileIdeaRequests(root); await reconcileIdeaRequests(root);
  const jobs = (await loadState(root)).jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'queued'); assert.equal(jobs[0].attempts, 0);
  assert.equal((await readDashboardConfig(root)).autoRun, false);
});

test('Obsidian export precedes job creation and failed local persistence cannot create a job', async t => {
  const { root, project } = await fixture(t);
  const vault = path.join(root, 'vault'); await fs.mkdir(vault);
  await saveDashboardConfig(root, { vaultPath: vault, autoRun: false });
  const idea = await createIdea(root, 'agency', 'Idea exportada antes de ejecutar', project.id);
  assert.ok(idea.notePath); await fs.access(path.join(vault, idea.notePath));
  await sendIdeaToQueue(root, idea.id, 'analysis');
  assert.equal((await loadState(root)).jobs.length, 1);
  assert.equal((await readDashboardConfig(root)).autoRun, false);
  const broken = path.join(root, 'broken'); await fs.mkdir(broken); await fs.writeFile(path.join(broken, 'data'), 'not a directory');
  await assert.rejects(createIdea(broken, 'agency', 'No se puede persistir'));
  await assert.rejects(sendIdeaToQueue(broken, 'missing', 'code'));
});

test('exact dispatch never runs an earlier job or falls back to another ID', async t => {
  const { root } = await fixture(t);
  await addJob(root, spec('older')); await addJob(root, spec('target'));
  const calls = [];
  const worker = async job => { calls.push(job.id); return { text: 'Simulado' }; };
  await runQueue(root, { execute: true, jobId: 'target', worker });
  await runQueue(root, { execute: true, jobId: 'missing', worker });
  assert.deepEqual(calls, ['target']);
  assert.equal((await loadState(root)).jobs.find(job => job.id === 'older').attempts, 0);
});

test('recovery cannot displace owner, retains dispatches, and retry/close require review with attempt limit', async t => {
  const { root } = await fixture(t);
  const job = await addJob(root, { ...spec('abandoned'), maxAttempts: 2 });
  const state = await loadState(root);
  const running = { ...job, state: 'running', attempts: 1, workflow: { ...job.workflow, currentStage: 'planner', steps: [{ key: 'planner', status: 'running', dispatchId: 'dispatch-old', summary: 'Informe conservado' }] } };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [running] } }) + '\n');
  const lock = await acquireLock(root);
  assert.equal((await recoverDashboardQueue(root)).available, false);
  assert.equal((await loadState(root)).jobs[0].state, 'running');
  await releaseLock(lock);
  await recoverDashboardQueue(root); await recoverDashboardQueue(root);
  const recovered = (await loadState(root)).jobs[0];
  assert.equal(recovered.state, 'needs_attention');
  assert.equal(recovered.workflow.status, 'needs_attention');
  assert.equal(recovered.workflow.steps[0].status, 'blocked');
  assert.equal(recovered.workflow.steps[0].dispatchId, 'dispatch-old');
  await assert.rejects(retryJob(root, job.id)); await assert.rejects(resolveJob(root, job.id));
  await retryJob(root, job.id, { confirm: true });
  assert.equal((await loadState(root)).jobs[0].workflowHistory[0].steps[0].dispatchId, 'dispatch-old');
  await runQueue(root, { execute: true, jobId: job.id, worker: async () => { throw new Error('simulado'); } });
  await assert.rejects(retryJob(root, job.id, { confirm: true }));
  await resolveJob(root, job.id, { confirm: true });
  assert.equal((await loadState(root)).jobs[0].state, 'cancelled');
});

test('approval requires exact marker at end of final line, with a separate final marker line', () => {
  for (const text of ['RESULTADO: APROBADO', 'Resumen.\nRESULTADO: APROBADO\n', 'Informe\r\nRESULTADO: APROBADO']) assert.equal(approved(text), true);
  for (const text of ['RESULTADO: APROBADO\nDespués', 'RESULTADO: BLOQUEADO', 'resultado: aprobado', 'RESULTADO:  APROBADO', 'RESULTADO: APROBADO.', 'RESULTADO: APROBADO\nRESULTADO: BLOQUEADO', 'No debe interpretarse como RESULTADO: APROBADO', 'Falta validacion esencial; no puedo emitir RESULTADO: APROBADO', 'RESULTADO: BLOQUEADO\nNo emitir RESULTADO: APROBADO']) assert.equal(approved(text), false);
});

test('oversized instructions remain saved without dispatching an incomplete idea', async t => {
  const { root, project } = await fixture(t);
  await updateProject(root, project.id, { checkout: 'workspaces/checkout', baseBranch: 'main' });
  const text = '界'.repeat(5000);
  const idea = await createIdea(root, 'agency', text, project.id);
  const result = await sendIdeaToQueue(root, idea.id, 'code', '', confirmation(project));
  assert.equal(result.job, undefined); assert.match(result.message, /12.000 bytes/);
  assert.equal((await loadDashboardState(root)).ideas[0].text, text);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('existing checkout worker argv contains no creation flags and preserves task title', async t => {
  const { root } = await fixture(t);
  const workspace = path.join(root, 'workspaces', 'checkout');
  const job = { ...spec('argv-contract'), attempts: 1, kind: 'code', title: 'Inicio con checkout existente', workspace, isolated: true };
  const captured = [];
  const stoppedBeforeDispatch = new Error('argv captured; do not launch a worker');
  const ctx = { root, registerCleanup() {} };
  await assert.rejects(runOrca(job, ctx, { command: async (args, cwd) => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_argv123' };
    captured.push({ args, cwd });
    throw stoppedBeforeDispatch;
  } }), error => error.code === 'orca_start_failed');
  assert.equal(captured.length, 1);
  const { args, cwd } = captured[0];
  assert.equal(cwd, root);
  // Inspect the actual array produced by runStage, before any transport response.
  assert.deepEqual(args, [
    'orchestration', 'worker-start', '--spec', args[3], '--agent', 'codex', '--model', 'gpt-6.1-sol',
    '--effort', 'medium', '--worktree', `path:${workspace}`, '--run', 'run_argv123',
    '--task-title', args[args.indexOf('--task-title') + 1],
  ]);
  assert.match(args.at(-1), /^Agencia · UX · i1 · #[a-f0-9]{8} · Inicio con checkout existente$/);
  assert.match(await completeSpec(root, args[3]), /PERFIL EXISTENTE: ux/);
  for (const flag of ['--name', '--repo', '--base-branch', '--display-name', '--comment', '--setup']) {
    assert.equal(args.includes(flag), false, `${flag} is rejected for an existing worktree`);
  }
});

test('simulated Orca executes profiles sequentially and QA gate prevents review on nonfinal approval', async t => {
  const { root } = await fixture(t);
  for (const qaPass of [true, false]) {
    const starts = [], updates = [];
    let current, active = false;
    const command = async args => {
      if (args[0] === 'repo') return { repos: [{ path: path.join(root, 'workspaces', 'checkout') }] };
      if (args[1] === 'run-create') return { runId: 'run_test123' };
      if (args[1] === 'worker-start') {
        assert.equal(args.includes('--display-name'), false);
        assert.equal(args[args.indexOf('--worktree') + 1], `path:${path.join(root, 'workspaces', 'checkout')}`);
        const fullSpec = await completeSpec(root, args[args.indexOf('--spec') + 1]);
        assert.ok(fullSpec.includes(job.prompt), 'every effective stage reads the complete verified idea snapshot');
        assert.equal(active, false); active = true;
        current = fullSpec.match(/PERFIL EXISTENTE: (\w+)/)[1];
        starts.push(current);
        return { dispatchId: `ctx_stage_${current}`, taskId: `task_stage_${current}` };
      }
      if (args[1] === 'worker-show') { active = false; return { state: 'succeeded', taskId: `task_stage_${current}` }; }
      if (args[1] === 'inbox') return { messages: [{ id: `msg_${current}`, type: 'worker_done', run_id: 'run_test123', payload: { dispatchId: `ctx_stage_${current}`, taskId: `task_stage_${current}`, outcome: 'succeeded' }, body: current === 'qa_agency' && !qaPass ? 'RESULTADO: APROBADO\nNo es final' : 'Informe simulado.\nRESULTADO: APROBADO' }] };
      if (args[1] === 'worker-read') return { transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text: current === 'qa_agency' && !qaPass ? 'RESULTADO: APROBADO\nNo es final' : 'Informe simulado.\nRESULTADO: APROBADO' }] }] } };
      throw new Error(`Unexpected command ${args}`);
    };
    const job = { ...spec('simulation'), prompt: '[IDEA_ID:fixture]\nEmpresa: agency\nProyecto: fixture\nFoco del trabajo: Mixto\nEtiquetas: mobile, lógica\nIdea íntegra: Fixture sin truncamiento\nObjetivo: verificar\nCriterio de éxito: conservar contexto', kind: 'code', workspace: path.join(root, 'workspaces', 'checkout'), isolated: true };
    const ctx = { root, signal: new AbortController().signal, registerCleanup() {}, reportStage: async value => { updates.push(value); } };
    if (qaPass) await runOrca(job, ctx, { command });
    else await assert.rejects(runOrca(job, ctx, { command }), error => error.code === 'quality_gate_blocked');
    assert.deepEqual(starts, qaPass ? ['ux_agency', 'desarrollador_agency', 'qa_agency', 'revisor_agency'] : ['ux_agency', 'desarrollador_agency', 'qa_agency']);
    assert.ok(updates.some(update => update.key === 'qa' && update.status === (qaPass ? 'succeeded' : 'blocked')));
  }
});
