import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { runOrca } from '../orca-provider.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-provider-'));
  const workspace = path.join(root, 'workspaces', 'game');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, workspace };
}

function job(root, workspace, workflow = undefined) {
  return {
    id: 'game-flow-001', business: 'games', kind: 'code', provider: 'orca',
    title: 'Mejorar flujo', prompt: 'Implementar y validar el cambio.', workspace, isolated: true,
    attempts: 1, workflow,
  };
}

function context(root) {
  return {
    root, signal: new AbortController().signal, updates: [],
    async reportStage(update) { this.updates.push(update); },
    registerCleanup(fn) { this.cleanup = fn; },
  };
}

for (const [business, agent] of [['games', 'codex'], ['agency', 'codex'], ['games', 'claude']]) test(`fresh ${business} ${agent} code workflow uses supported argv and persists each finished stage`, async t => {
  const previous = process.env.CENTRO_ORCA_AGENT;
  if (agent === 'codex') delete process.env.CENTRO_ORCA_AGENT;
  else process.env.CENTRO_ORCA_AGENT = agent;
  t.after(() => {
    if (previous === undefined) delete process.env.CENTRO_ORCA_AGENT;
    else process.env.CENTRO_ORCA_AGENT = previous;
  });
  const { root, workspace } = await fixture(t);
  const ctx = context(root), starts = [], outputs = new Map();
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_abcdef' };
    if (args[1] === 'worker-start') {
      assert.equal(args[args.indexOf('--agent') + 1], agent);
      assert.equal(args.includes('--model'), agent === 'codex');
      assert.equal(args.includes('--effort'), agent === 'codex');
      assert.equal(ctx.updates.at(-1).orcaAgent, agent);
      assert.equal(args.includes('--display-name'), false);
      assert.equal(args.includes('--name'), false);
      const dispatchId = `ctx_stage${starts.length + 1}`;
      const role = args[args.indexOf('--task-title') + 1];
      starts.push({ args, dispatchId, role });
      outputs.set(dispatchId, ['qa', 'reviewer'].includes(ctx.updates.at(-1).key)
        ? 'Validación correcta.\nRESULTADO: APROBADO'
        : `${role} completado`);
      return { dispatchId, taskId: `task_${dispatchId.slice(4)}` };
    }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_abcdef', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') {
      const dispatchId = starts.at(-1).dispatchId;
      return { messages: [{ type: 'worker_done', body: outputs.get(dispatchId), payload: JSON.stringify({ dispatchId }) }] };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const result = await runOrca({ ...job(root, workspace), business }, ctx, { command });
  assert.equal(starts.length, 4);
  assert.deepEqual([...new Set(ctx.updates.filter(update => update.profile).map(update => update.profile))], ['ux', 'desarrollador', 'qa', 'revisor'].map(profile => `${profile}_${business}`));
  const label = business === 'games' ? 'Desarrollo de videojuegos (Godot)' : 'Implementación';
  assert.ok(ctx.updates.some(update => update.key === 'developer' && update.label === label && update.profile === `desarrollador_${business}`));
  for (const [index, role] of ['UX', 'DEV', 'QA', 'REV'].entries()) {
    const name = starts[index].role;
    assert.match(name, new RegExp(`^${business === 'games' ? 'Videojuegos' : 'Agencia'} · ${role} · i1 · #[a-f0-9]{8} · Mejorar flujo$`));
    assert.ok(name.length <= 80);
    assert.equal(ctx.updates.find(update => update.dispatchId === starts[index].dispatchId).displayName, name);
  }
  const brief = starts[1].args[starts[1].args.indexOf('--spec') + 1];
  const instructions = await fs.readFile(JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]), 'utf8');
  assert.match(instructions, new RegExp(`PERFIL EXISTENTE: desarrollador_${business}`));
  if (business === 'games') {
    assert.match(instructions, /project\.godot/);
    assert.match(instructions, /no autorizan scaffold ni cambios de migración/);
    assert.ok(ctx.updates.some(update => update.key === 'ux' && update.label === 'Diseño de videojuegos' && update.profile === 'ux_games'));
  }
  const references = ['Diseño de partida', 'Implementación Godot', 'Verificación en el motor', 'Revisión de jugabilidad y código'];
  for (const [index, start] of starts.entries()) {
    const stageBrief = start.args[start.args.indexOf('--spec') + 1];
    const spec = await fs.readFile(JSON.parse(stageBrief.match(/^SPEC_FILE: (.+)$/m)[1]), 'utf8');
    const embedded = spec.split('REFERENCIA DE TU PERFIL\n')[1];
    if (business === 'games') {
      assert.ok(embedded?.startsWith('# ' + references[index]));
      assert.match(spec, /github\.com\/scenent\/gd-rhythm/);
      assert.match(spec, /store\.godotengine\.org/);
      if (index === 0) assert.match(embedded, /vueltas?|vuelta jugable/);
    } else {
      assert.equal(embedded, undefined);
      assert.doesNotMatch(spec, /github\.com\/scenent\/gd-rhythm/);
    }
  }
  assert.deepEqual(result.stages, Object.fromEntries(['ux', 'developer', 'qa', 'reviewer'].map((key, index) => [key, starts[index].dispatchId])));
  assert.equal(ctx.updates.filter(update => update.status === 'succeeded').length, 4);
  assert.match(result.text, /RESULTADO: APROBADO/);
});

test('long project and task labels retain stage, attempt and stable job marker within 80 characters', async t => {
  const { root, workspace } = await fixture(t);
  const names = [];
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: path.join(root, 'analysis') }] };
    if (args[1] === 'run-create') return { runId: 'run_abcdef' };
    if (args[1] === 'worker-start') {
      names.push(args[args.indexOf('--task-title') + 1]);
      return { dispatchId: 'ctx_planner01', taskId: 'task_planner01' };
    }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_abcdef', taskId: 'task_planner01' };
    if (args[1] === 'inbox') return { messages: [{ type: 'worker_done', body: 'Plan terminado.', payload: JSON.stringify({ dispatchId: 'ctx_planner01' }) }] };
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const request = { ...job(root, workspace), kind: 'analysis', attempts: 2, projectName: 'Proyecto\n' + '😀'.repeat(50), title: 'Encargo\t' + 'muy largo '.repeat(50) };
  for (const id of ['same-prefix-job-one', 'same-prefix-job-two', 'same-prefix-job-one']) {
    const ctx = context(root);
    await runOrca({ ...request, id }, ctx, { command });
    const name = names.at(-1);
    assert.ok(name.length <= 80);
    assert.match(name, /^Proyecto /);
    assert.match(name, / · PLAN · i2 · #[a-f0-9]{8} · Encargo /);
    assert.doesNotMatch(name, /[\r\n\t]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.equal(ctx.updates.at(-1).displayName, name);
  }
  assert.equal(names[0], names[2]);
  assert.notEqual(names[0], names[1]);
});

test('interrupted final reviewer resumes the same dispatch and does not rerun earlier stages', async t => {
  const { root, workspace } = await fixture(t);
  const dispatchId = 'ctx_review01', ctx = context(root), calls = [];
  const workflow = {
    runId: 'run_abcdef', currentStage: 'reviewer', status: 'needs_attention',
    steps: [
      { key: 'ux', status: 'succeeded', dispatchId: 'ctx_ux0001', summary: 'UX' },
      { key: 'developer', status: 'succeeded', dispatchId: 'ctx_dev001', summary: 'Dev' },
      { key: 'qa', status: 'succeeded', dispatchId: 'ctx_qa0001', approvalOutcome: 'approved', approvalDispatchId: 'ctx_qa0001', summary: 'QA aprobado.\nRESULTADO: APROBADO' },
      { key: 'reviewer', status: 'blocked', error: 'interrupted', dispatchId, taskId: 'task_review01' },
    ],
  };
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_abcdef', taskId: 'task_review01' };
    if (args[1] === 'inbox') return { messages: [{
      type: 'worker_done', body: 'No defects found.\nRESULTADO: APROBADO',
      payload: JSON.stringify({ dispatchId }),
    }] };
    throw new Error(`Must not relaunch: ${args.join(' ')}`);
  };
  const result = await runOrca(job(root, workspace, workflow), ctx, { command });
  assert.deepEqual(calls.map(args => args[1]), ['list', 'worker-show', 'inbox']);
  assert.equal(result.stages.reviewer, dispatchId);
  assert.equal(ctx.updates.at(-1).dispatchStatus, 'completed');
  assert.match(result.text, /No defects found/);
});

test('long QA approval survives checkpoint recovery and resumes reviewer without duplicate dispatch', async t => {
  const { root, workspace } = await fixture(t);
  const ctx = context(root), starts = [], bodies = new Map();
  let reviewerKnown = false;
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_abcdef' };
    if (args[1] === 'worker-start') {
      const role = ['ux', 'developer', 'qa', 'reviewer'][starts.length];
      const dispatchId = `ctx_${role}0001`;
      starts.push({ role, dispatchId });
      bodies.set(dispatchId, role === 'qa'
        ? `${'Q'.repeat(6200)}\nRESULTADO: APROBADO`
        : role === 'reviewer' ? 'Review recovered.\nRESULTADO: APROBADO' : `${role} completado`);
      return { dispatchId, taskId: `task_${role}0001` };
    }
    if (args[1] === 'worker-show') {
      const dispatchId = args[3];
      if (dispatchId === 'ctx_reviewer0001' && !reviewerKnown) {
        reviewerKnown = true;
        return { state: 'unknown', runId: 'run_abcdef', taskId: 'task_reviewer0001' };
      }
      return { state: 'succeeded', runId: 'run_abcdef', taskId: `task_${dispatchId.slice(4)}` };
    }
    if (args[1] === 'inbox') {
      const dispatchId = args[args.indexOf('--terminal') + 1] === 'run:run_abcdef'
        ? starts.at(-1).dispatchId : '';
      return { messages: [{ type: 'worker_done', body: bodies.get(dispatchId), payload: JSON.stringify({ dispatchId }) }] };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  await assert.rejects(runOrca(job(root, workspace), ctx, { command }), error => error.code === 'orca_dispatch_status_unknown');
  const latest = new Map();
  for (const update of ctx.updates) latest.set(update.key, { ...(latest.get(update.key) ?? {}), ...update });
  const checkpoint = {
    runId: 'run_abcdef', currentStage: 'reviewer', status: 'needs_attention',
    steps: [...latest.values()],
  };
  const qa = checkpoint.steps.find(step => step.key === 'qa');
  assert.equal(qa.status, 'succeeded');
  assert.equal(qa.approvalOutcome, 'approved');
  assert.equal(qa.approvalDispatchId, qa.dispatchId);
  assert.match(qa.summary, /RESULTADO: APROBADO$/);

  const resumed = await runOrca(job(root, workspace, checkpoint), ctx, { command });
  assert.equal(resumed.stages.reviewer, 'ctx_reviewer0001');
  assert.equal(starts.length, 4, 'resume must not create another dispatch');
  assert.match(resumed.text, /Review recovered/);
  assert.equal(ctx.updates.filter(update => update.status === 'succeeded' && update.key === 'qa').length, 1);
});

test('recovered approval cannot use a final marker when its approval belongs to another dispatch', async t => {
  const { root, workspace } = await fixture(t);
  const workflow = {
    runId: 'run_abcdef', currentStage: 'reviewer', status: 'needs_attention',
    steps: [
      { key: 'ux', status: 'succeeded', dispatchId: 'ctx_ux0001', summary: 'UX' },
      { key: 'developer', status: 'succeeded', dispatchId: 'ctx_dev0001', summary: 'Dev' },
      {
        key: 'qa', status: 'succeeded', dispatchId: 'ctx_qa0001',
        approvalOutcome: 'approved', approvalDispatchId: 'ctx_foreign01',
        summary: 'RESULTADO: APROBADO',
      },
      { key: 'reviewer', status: 'blocked', dispatchStatus: 'unknown', dispatchId: 'ctx_review01' },
    ],
  };
  const calls = [];
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    throw new Error(`Gate must stop before reading or starting reviewer: ${args.join(' ')}`);
  };
  await assert.rejects(runOrca(job(root, workspace, workflow), context(root), { command }), error => error.code === 'quality_gate_blocked');
  assert.deepEqual(calls.map(args => args[1]), ['list']);
});

test('fresh approval ignores a worker_done with matching taskId but a different dispatch', async t => {
  const { root, workspace } = await fixture(t);
  const ctx = context(root), starts = [], calls = [];
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_abcdef' };
    if (args[1] === 'worker-start') {
      const role = ['ux', 'developer', 'qa', 'reviewer'][starts.length];
      const dispatchId = `ctx_${role}0001`;
      starts.push({ role, dispatchId });
      return { dispatchId, taskId: `task_${role}0001` };
    }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_abcdef', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') {
      const current = starts.at(-1);
      const body = current.role === 'qa'
        ? 'Foreign worker approval.\nRESULTADO: APROBADO'
        : `${current.role} complete`;
      const payload = current.role === 'qa'
        ? { dispatchId: 'ctx_foreign01', taskId: `task_${current.role}0001` }
        : { dispatchId: current.dispatchId, taskId: `task_${current.role}0001` };
      return { messages: [{ type: 'worker_done', body, payload: JSON.stringify(payload) }] };
    }
    if (args[1] === 'worker-read') {
      const dispatchId = args[args.indexOf('--dispatch') + 1];
      return { dispatchId, source: 'transcript', sourceExact: true, sourceIdentity: 'fixture-exact', contentComplete: true,
        transcript: { limited: false, messages: [{ role: 'assistant', blocks: [{ type: 'text', text: `Transcript for ${dispatchId} has no approval.` }] }] } };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  await assert.rejects(runOrca(job(root, workspace), ctx, { command }), error => error.code === 'quality_gate_blocked');
  assert.deepEqual(starts.map(start => start.role), ['ux', 'developer', 'qa']);
  assert.equal(calls.some(args => args[1] === 'worker-read' && args[args.indexOf('--dispatch') + 1] === 'ctx_qa0001'), true);
  assert.equal(ctx.updates.some(update => update.key === 'reviewer' && update.status === 'running'), false);
});

test('unknown or missing dispatch blocks safely without creating a replacement', async t => {
  const { root, workspace } = await fixture(t);
  for (const reviewer of [
    { key: 'reviewer', status: 'blocked', error: 'interrupted', dispatchStatus: 'unknown' },
    { key: 'reviewer', status: 'blocked', error: 'interrupted', dispatchStatus: 'unknown', dispatchId: 'ctx_review01' },
  ]) {
    const ctx = context(root), calls = [];
    const workflow = {
      runId: 'run_abcdef', currentStage: 'reviewer', status: 'needs_attention',
      steps: [
        { key: 'ux', status: 'succeeded', summary: 'UX' },
        { key: 'developer', status: 'succeeded', summary: 'Dev' },
        { key: 'qa', status: 'succeeded', dispatchId: 'ctx_qa0001', approvalOutcome: 'approved', approvalDispatchId: 'ctx_qa0001', summary: 'QA aprobado.\nRESULTADO: APROBADO' },
        reviewer,
      ],
    };
    const command = async args => {
      calls.push(args);
      if (args[0] === 'repo') return { repos: [{ path: workspace }] };
      if (args[1] === 'worker-show') throw Object.assign(new Error('unknown'), { code: 'orca_command_failed' });
      throw new Error(`Must not launch: ${args.join(' ')}`);
    };
    await assert.rejects(runOrca(job(root, workspace, workflow), ctx, { command }), error => error.code === 'orca_dispatch_unknown' || error.code === 'orca_dispatch_status_unknown');
    assert.equal(calls.some(args => args[1] === 'worker-start'), false);
  }
});
