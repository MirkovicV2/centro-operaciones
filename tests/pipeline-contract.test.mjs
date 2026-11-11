import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addJob, loadState, runQueue, resumeJobWithDecisions, retryJob } from '../queue.mjs';
import { runOrca } from '../orca-provider.mjs';
import { parseDelivery, measuredUsage, handoffText } from '../workflow-contract.mjs';
import { readCompleteTranscript, matchingCompletion, pendingStageDelivery, saveStageReport, readStageReport } from '../orca-evidence.mjs';
import { confirmSubmission, setAutoRun, readIntegration } from '../auto-run.mjs';

const identity = { jobId: 'pipeline-fixture', jobAttempt: 1, stage: 'qa', runId: 'run_fixture1', taskId: 'task_fixture1', dispatchId: 'ctx_fixture1' };
const delivery = (patch = {}) => ({
  version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: 'Criterio verificado.',
  approval: 'approved', acceptance: [{ criterion: 'comportamiento verificado.', status: 'passed', evidence: 'Fixture reproducible, comprobación correcta.' }],
  evidence: ['fixture: resultado correcto'], questions: [], decisions: [], ...patch,
});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-v1-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const spec = { id: identity.jobId, business: 'agency', kind: 'code', provider: 'orca', title: 'Fixture', prompt: 'Objetivo: corregir. Criterio: comportamiento verificado.', workspace, isolated: true };
  return { root, workspace, spec };
}
function fakeOrca(workspace, change = () => {}) {
  const started = [], calls = [], bodies = new Map();
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: identity.runId };
    if (args[1] === 'worker-start') {
      const retryTask = args.includes('--task') ? args[args.indexOf('--task') + 1] : null;
      const launchInput = args[args.indexOf('--spec') + 1];
      const specPath = !retryTask && launchInput?.match(/^SPEC_FILE: (.+)$/m)?.[1];
      const input = retryTask ? started.find(item => item.taskId === retryTask).input : specPath ? await fs.readFile(JSON.parse(specPath), 'utf8') : launchInput;
      const stage = input.match(/stage:"([a-z]+)"/)?.[1] || ['ux', 'developer', 'qa', 'reviewer'][started.length];
      const assignment = { dispatchId: 'ctx_stage00' + started.length, taskId: retryTask || 'task_stage00' + started.length, runId: identity.runId };
      started.push({ ...assignment, stage, input, launchInput, args });
      const result = delivery({ ...assignment, stage, jobAttempt: Number(input.match(/jobAttempt:(\d+)/)?.[1] || 1), approval: ['qa', 'reviewer'].includes(stage) ? 'approved' : 'not_applicable' });
      change(result, started);
      bodies.set(assignment.dispatchId, result);
      return assignment;
    }
    if (args[1] === 'worker-show') return { ...started.find(x => x.dispatchId === args[3]), state: 'succeeded', liveness: 'exited' };
    if (args[1] === 'inbox') {
      const current = started.at(-1);
      return { messages: [{ id: 'msg_' + current.stage, type: 'worker_done', run_id: identity.runId, to_handle: 'run:' + identity.runId,
        payload: JSON.stringify({ dispatchId: current.dispatchId, taskId: current.taskId, outcome: 'succeeded' }), body: JSON.stringify(bodies.get(current.dispatchId)) }] };
    }
    throw new Error('Unexpected fixture command ' + args.join(' '));
  };
  return { command, started, calls, bodies };
}

for (const blockedQA of [false, true]) test(`product acceptance advances through QA before later completion gates; blockedQA=${blockedQA}`, async t => {
  const f = await fixture(t);
  const globalCriterion = 'Independent review approved; GitHub Actions SUCCESS on the current PR commit; merge confirmed.';
  await setAutoRun(f.root, 'agency', true, { confirm: true });
  const submission = await confirmSubmission(f.root, 'receipt-scoped-product', {
    ...f.spec, destination: { repository: 'owner/repo', baseBranch: 'main' },
    contract: { version: 1, objective: 'Validate the local product.', acceptanceScope: 'product',
      productAcceptance: ['comportamiento verificado.'], acceptance: ['comportamiento verificado.'], endToEndCriteria: [globalCriterion] },
  });
  let integrated = 0;
  const simulator = fakeOrca(f.workspace, result => {
    if (blockedQA && result.stage === 'qa') {
      result.outcome = 'blocked'; result.scope = 'partial'; result.approval = 'blocked';
      result.acceptance[0].status = 'failed'; result.acceptance[0].evidence = 'A reproducible product failure.';
    }
  });
  const updates = [];
  const perform = () => runOrca({ ...submission.job, attempts: 1 }, { root: f.root,
    signal: new AbortController().signal, registerCleanup() {}, reportStage: async update => updates.push(update) }, {
    command: simulator.command, captureSnapshot: async () => 'e'.repeat(64),
    integrate: async (_job, _ctx, { previous }) => {
      integrated++;
      assert.deepEqual(simulator.started.map(stage => stage.stage), ['ux', 'developer', 'qa', 'reviewer']);
      assert.equal(previous.phase, 'validation_approved');
      assert.ok(previous.validation.approvals.qa.artifactSha256);
      assert.ok(previous.validation.approvals.reviewer.artifactSha256);
      return { phase: 'complete', status: 'completed', mergeSha: 'f'.repeat(40) };
    },
  });
  if (blockedQA) {
    await assert.rejects(perform(), { code: 'delivery_incomplete' });
    assert.deepEqual(simulator.started.map(stage => stage.stage), ['ux', 'developer', 'qa']);
    assert.equal(integrated, 0);
    assert.equal((await readIntegration(f.root, submission.receipt.id)).phase, 'validation_pending');
  } else {
    const result = await perform();
    assert.equal(integrated, 1);
    assert.equal(result.integration.phase, 'complete');
    const qaInput = simulator.started.find(stage => stage.stage === 'qa').input;
    assert.ok(qaInput.includes(globalCriterion), 'global conditions remain visible and are not discarded');
    assert.deepEqual(result.delivery.acceptance.map(item => item.criterion), ['comportamiento verificado.']);
  }
});

test('a completed review report can carry an explicit product rejection but can never become an approval', () => {
  const expected = { ...identity, stage: 'reviewer', acceptance: ['comportamiento verificado.'] };
  const report = delivery({ stage: 'reviewer', approval: 'blocked',
    acceptance: [{ criterion: expected.acceptance[0], status: 'failed', evidence: 'Reproducción verificada.' }] });
  assert.throws(() => parseDelivery(JSON.stringify(report), expected), { code: 'delivery_invalid' });
  const repaired = parseDelivery(JSON.stringify(report), expected, { preserveExplicitBlock: true });
  assert.equal(repaired.outcome, 'blocked');
  assert.equal(repaired.approval, 'blocked');
  for (const changed of [
    { ...report, approval: 'approved' },
    { ...report, acceptance: [{ ...report.acceptance[0], criterion: 'otro alcance' }] },
    { ...report, dispatchId: 'ctx_foreign1' },
  ]) assert.throws(() => parseDelivery(JSON.stringify(changed), expected, { preserveExplicitBlock: true }));
});

test('structured approval is correlated and cannot approve partial work or foreign IDs', () => {
  const report = delivery();
  assert.equal(parseDelivery(JSON.stringify(report), identity).approval, 'approved');
  const fenced = String.fromCharCode(96).repeat(3) + 'centro-delivery\n' + JSON.stringify(report) + '\n' + String.fromCharCode(96).repeat(3);
  assert.equal(parseDelivery(fenced, identity).dispatchId, identity.dispatchId);
  for (const patch of [{ dispatchId: 'ctx_foreign1' }, { taskId: 'task_foreign1' }, { jobAttempt: 2 }, { scope: 'partial' }, { acceptance: [] }, { evidence: [] }]) {
    assert.throws(() => parseDelivery(JSON.stringify({ ...report, ...patch }), identity));
  }
  assert.throws(() => parseDelivery('RESULTADO: APROBADO', identity, { required: true }), /estructurada/);
});

test('explicit acceptance cannot be omitted and historical free-form JSON remains readable', () => {
  assert.equal(parseDelivery('{"tasks":[]}', identity), null);
  assert.throws(() => parseDelivery('{"tasks":[]}', identity, { required: true }));
  assert.throws(() => parseDelivery(JSON.stringify(delivery()), { ...identity, acceptance: ['Otro criterio obligatorio'] }), /criterio obligatorio/);
  assert.equal(parseDelivery(JSON.stringify(delivery()), { ...identity, acceptance: ['comportamiento verificado.'] }).scope, 'complete');
});

test('saved evidence cannot be substituted across stages, tasks, dispatches or attempts', async t => {
  const { root } = await fixture(t);
  const artifact = await saveStageReport(root, identity, 'Informe completo', delivery());
  assert.equal((await readStageReport(root, artifact, identity)).text, 'Informe completo');
  for (const change of [{ taskId: 'task_other01' }, { dispatchId: 'ctx_other01' }, { jobAttempt: 2 }, { stage: 'reviewer' }]) {
    await assert.rejects(readStageReport(root, artifact, { ...identity, ...change }), /otra identidad/);
  }
});

test('failed terminal transcript remains evidence without becoming successful', async () => {
  const report = await readCompleteTranscript({ ...identity, workerState: 'failed' }, async () => ({
    dispatchId: identity.dispatchId, source: 'transcript', sourceExact: true, sourceIdentity: 'provider:exact',
    contentComplete: true, status: { worker: 'failed' }, projection: { outcome: 'failed' },
    transcript: { limited: false, messages: [{ role: 'assistant', blocks: [{ type: 'text', text: 'No pude completar el encargo.' }] }] },
  }));
  assert.match(report.text, /No pude/);
});

test('running questions require exact Run, Task, Dispatch and sender correlation', () => {
  const expected = { ...identity, terminalHandle: 'term_fixture01' };
  const report = delivery({ outcome: 'needs_input', scope: 'partial', approval: 'not_applicable',
    questions: [{ id: 'decision', text: 'Qué destino confirmado?', required: true }] });
  const message = { id: 'message_question01', type: 'ask', run_id: identity.runId, to_handle: 'run:' + identity.runId,
    from_handle: expected.terminalHandle, payload: JSON.stringify({ taskId: identity.taskId, dispatchId: identity.dispatchId }), body: JSON.stringify(report) };
  assert.equal(pendingStageDelivery([message], expected).delivery.outcome, 'needs_input');
  for (const patch of [{ from_handle: 'term_other01' }, { run_id: 'run_other01' }, { truncated: true },
    { payload: JSON.stringify({ taskId: 'task_other01', dispatchId: identity.dispatchId }) }]) {
    assert.equal(pendingStageDelivery([{ ...message, ...patch }], expected), null);
  }
});

test('native question dispatch sender preserves strict payload and structured delivery identities', () => {
  const report = delivery({ outcome: 'needs_input', scope: 'partial', approval: 'not_applicable',
    questions: [{ id: 'target', text: 'Destino confirmado?', required: true }] });
  const body = JSON.stringify(report);
  const message = { id: 'message_native_question', type: 'question', run_id: identity.runId,
    to_handle: `run:${identity.runId}`, from_handle: `dispatch:${identity.dispatchId}`,
    payload: JSON.stringify({ taskId: identity.taskId, dispatchId: identity.dispatchId, question: body, options: [] }), body };
  const matched = pendingStageDelivery([message], identity);
  assert.equal(matched.messageId, message.id); assert.equal(matched.delivery.dispatchId, identity.dispatchId);
  for (const patch of [
    { from_handle: 'dispatch:ctx_foreign123' }, { run_id: 'run_foreign123' },
    { payload: JSON.stringify({ taskId: 'task_foreign123', dispatchId: identity.dispatchId, question: body, options: [] }) },
  ]) assert.equal(pendingStageDelivery([{ ...message, ...patch }], identity), null);
  for (const changed of [{ taskId: 'task_foreign123' }, { dispatchId: 'ctx_foreign123' }, { runId: 'run_foreign123' }, { jobAttempt: 2 }]) {
    assert.throws(() => pendingStageDelivery([{ ...message, body: JSON.stringify({ ...report, ...changed }) }], identity), { code: 'delivery_identity_mismatch' });
  }
  assert.equal(pendingStageDelivery([{ ...message, body: 'Destino confirmado?' }], identity), null, 'plain native question cannot impersonate a structured delivery');
});

test('structured ask encoding preserves quoted questions and UTF-8 on the native mailbox', () => {
  const report = delivery({ outcome: 'needs_input', scope: 'partial', approval: 'not_applicable',
    questions: [{ id: 'target', text: '¿Conservar la "versión rápida"?', required: true }] });
  const body = 'centro-ask-v1.' + Buffer.from(JSON.stringify(report), 'utf8').toString('base64url');
  const message = { id: 'msg_encoded001', type: 'question', run_id: identity.runId,
    to_handle: `run:${identity.runId}`, from_handle: `dispatch:${identity.dispatchId}`,
    payload: { taskId: identity.taskId, dispatchId: identity.dispatchId, question: body }, body };
  assert.deepEqual(pendingStageDelivery([message], identity).delivery, report);
  const later = { ...message, id: 'msg_encoded002' };
  assert.equal(pendingStageDelivery([later, message], identity).messageId, later.id);
});

test('all four stages exchange validated evidence and retain acceptance past character 3500', async t => {
  const f = await fixture(t);
  await addJob(f.root, f.spec);
  const simulator = fakeOrca(f.workspace, result => {
    if (result.stage === 'ux') {
      result.summary = 'X'.repeat(6606) + '\nACEPTACIÓN: no perder esta condición.';
      result.decisions = [{ key: 'input', value: 'La decisión fue delegada al agente.' }];
    }
  });
  const outcome = await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command: simulator.command }) });
  assert.equal(outcome.jobs[0].state, 'succeeded', JSON.stringify(outcome.jobs[0].error));
  assert.equal(simulator.started.length, 4);
  assert.match(simulator.started[1].input, /ACEPTACIÓN: no perder esta condición/);
  assert.match(simulator.started[1].input, /La decisión fue delegada/);
  assert.match(simulator.started[0].input, /CONTRATO DEL ENCARGO/);
  assert.equal(simulator.started.every(item => item.args.includes('--spec') && item.launchInput.length < 2000 && /SPEC_SHA256: [a-f0-9]{64}/.test(item.launchInput)), true);
  assert.equal(outcome.jobs[0].result.metrics.dispatchStarts, 4);
  assert.equal(outcome.jobs[0].result.metrics.inputTokens, null);
  for (const stage of outcome.jobs[0].workflow.steps) {
    assert.equal(stage.delivery.dispatchId, stage.dispatchId);
    assert.equal(stage.delivery.jobId, f.spec.id);
    assert.ok((await fs.readFile(stage.artifact.path, 'utf8')).includes(stage.dispatchId));
    const start = simulator.started.find(item => item.stage === stage.key);
    assert.equal(stage.displayName, start.args[start.args.indexOf('--task-title') + 1]);
  }
});

test('native retry keeps the immutable Task input and launch agent while queue attempt advances', async t => {
  const previousAgent = process.env.CENTRO_ORCA_AGENT;
  process.env.CENTRO_ORCA_AGENT = 'claude';
  t.after(() => {
    if (previousAgent === undefined) delete process.env.CENTRO_ORCA_AGENT;
    else process.env.CENTRO_ORCA_AGENT = previousAgent;
  });
  const f = await fixture(t); await addJob(f.root, f.spec);
  const simulator = fakeOrca(f.workspace);
  const command = async args => {
    const value = await simulator.command(args);
    if (simulator.started.length === 1 && args[1] === 'worker-show') value.state = 'failed';
    if (simulator.started.length === 1 && args[1] === 'inbox') {
      const payload = JSON.parse(value.messages[0].payload); payload.outcome = 'failed'; value.messages[0].payload = JSON.stringify(payload);
    }
    return value;
  };
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command }) });
  const failed = (await loadState(f.root)).jobs[0]; assert.equal(failed.state, 'needs_attention');
  assert.equal(failed.workflow.steps[0].dispatchStatus, 'failed');
  assert.equal(failed.workflow.steps[0].orcaAgent, 'claude');
  process.env.CENTRO_ORCA_AGENT = 'codex';
  await retryJob(f.root, failed.id, { confirm: true });
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command }) });
  const resumed = (await loadState(f.root)).jobs[0]; assert.equal(resumed.state, 'succeeded', JSON.stringify(resumed.error));
  const retry = simulator.started[1]; assert.equal(retry.taskId, simulator.started[0].taskId);
  assert.equal(retry.args[retry.args.indexOf('--retry-of') + 1], simulator.started[0].dispatchId);
  assert.equal(retry.args.includes('--task-title'), false, 'retry must not rename the existing native Task');
  assert.equal(retry.args[retry.args.indexOf('--agent') + 1], 'claude');
  assert.equal(retry.args.includes('--model'), false);
  assert.equal(resumed.workflow.steps[0].displayName, failed.workflow.steps[0].displayName);
  assert.match(resumed.workflow.steps[0].displayName, / · UX · i1 · /);
  assert.equal(resumed.workflow.steps[0].attempt, 2); assert.equal(resumed.workflow.steps[0].taskInputAttempt, 1);
  assert.deepEqual(resumed.workflow.steps[0].specArtifact, failed.workflow.steps[0].specArtifact);
  assert.equal(retry.args.includes('--spec'), false, 'native retry retains the original Task pointer');
  assert.equal(retry.args.includes('--spec-file'), false);
  await assert.rejects(fs.access(path.join(f.root, 'data', 'dispatch-specs', f.spec.id, 'ux-attempt-2.txt')), { code: 'ENOENT' });
  assert.equal(resumed.workflow.steps[0].delivery.jobAttempt, 1); assert.equal(simulator.started.length, 5);
});

test('a settled needs_input delivery blocks dependent stages and resumes the same job with all decisions', async t => {
  const f = await fixture(t);
  await addJob(f.root, f.spec);
  const simulator = fakeOrca(f.workspace, result => {
    if (result.stage === 'ux') Object.assign(result, {
      outcome: 'needs_input', approval: 'not_applicable', scope: 'partial',
      questions: [{ id: 'target', text: 'Destino confirmado?', required: true, decisionKey: 'target' }],
    });
  });
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command: simulator.command }) });
  const blocked = (await loadState(f.root)).jobs[0];
  assert.equal(blocked.state, 'needs_attention');
  assert.equal(blocked.error.code, 'needs_input');
  assert.equal(simulator.started.length, 1);
  const continuation = { version: 1, rootJobId: f.spec.id, parentJobId: f.spec.id, decisionRevision: 1,
    questionIds: ['target'], decisions: [{ questionId: 'target', decisionKey: 'target', question: 'Destino confirmado?', answer: 'El checkout asignado.' }] };
  const resumed = await resumeJobWithDecisions(f.root, f.spec.id, { continuation, prompt: 'Objetivo original. Decisión target: checkout asignado. Criterio: comportamiento verificado.' });
  assert.equal(resumed.id, blocked.id);
  assert.equal(resumed.workflow.steps[0].predecessorTaskId, blocked.workflow.steps[0].taskId);
  assert.equal(resumed.workflowHistory.length, 1);
  assert.equal((await resumeJobWithDecisions(f.root, f.spec.id, { continuation, prompt: resumed.prompt })).id, blocked.id);
  assert.equal((await loadState(f.root)).jobs.length, 1);
});

test('a failure stops a selected two-job batch and a late update cannot reopen the attempt', async t => {
  const f = await fixture(t);
  await addJob(f.root, f.spec);
  await addJob(f.root, { ...f.spec, id: 'second-fixture' });
  let calls = 0, late;
  await runQueue(f.root, { execute: true, maxJobs: 2, worker: async (_job, ctx) => { calls++; late = ctx; throw new Error('fixture'); } });
  const state = await loadState(f.root);
  assert.equal(calls, 1);
  assert.equal(state.jobs[1].state, 'queued');
  await assert.rejects(late.reportStage({ key: 'ux', status: 'succeeded' }), error => error.code === 'attempt_closed');
});

test('stage updates reject missing prerequisites and changed run, dispatch, or attempt', async t => {
  const f = await fixture(t);
  await addJob(f.root, f.spec);
  await runQueue(f.root, { execute: true, worker: async (_job, ctx) => {
    await assert.rejects(ctx.reportStage({ key: 'developer', status: 'running' }), error => error.code === 'stage_dependencies_unmet');
    await ctx.reportStage({ key: 'ux', status: 'running', runId: identity.runId, taskId: identity.taskId, dispatchId: identity.dispatchId, attempt: 1 });
    for (const patch of [{ runId: 'run_foreign1' }, { dispatchId: 'ctx_foreign1' }, { attempt: 2 }]) {
      await assert.rejects(ctx.reportStage({ key: 'ux', status: 'running', ...patch }), error => /^stage_/.test(error.code));
    }
    throw new Error('Stop simulated worker');
  } });
  assert.equal((await loadState(f.root)).jobs[0].workflow.steps[0].dispatchId, identity.dispatchId);
});

test('transcript pagination uses exact identity and never takes an incomplete last page as final', async () => {
  const page = (text, limited, nextCursor, complete) => ({ dispatchId: identity.dispatchId, source: 'transcript', sourceExact: true, sourceIdentity: 'same-fixture',
    status: { worker: 'succeeded' }, projection: { outcome: 'succeeded' }, contentComplete: complete,
    transcript: { limited, nextCursor, messages: [{ role: 'assistant', blocks: [{ type: 'text', text }] }] } });
  const pages = [page('Provisional', true, 'second', false), page('Entrega final', false, null, true)];
  const cursors = [];
  assert.equal((await readCompleteTranscript(identity, async cursor => { cursors.push(cursor); return pages.shift(); })).text, 'Entrega final');
  assert.deepEqual(cursors, [undefined, 'second']);
  for (const invalid of [page('Incompleto', false, null, false), { ...page('Ajeno', false, null, true), dispatchId: 'ctx_foreign1' },
    { ...page('Recortado', false, null, true), clipping: ['limit'] }]) {
    await assert.rejects(readCompleteTranscript(identity, async () => invalid), error => error.code === 'orca_transcript_unverified');
  }
  await assert.rejects(readCompleteTranscript(identity, async () => page('Bucle', true, 'same', false)), /cursor/);
});

test('worker receipts accept native string/object payload and reject a foreign Task', () => {
  const receipt = { type: 'worker_done', body: 'Entrega', payload: { ...identity, outcome: 'succeeded' } };
  assert.equal(matchingCompletion([receipt], identity, { strict: true }).text, 'Entrega');
  assert.throws(() => matchingCompletion([{ ...receipt, payload: { ...receipt.payload, taskId: 'task_foreign1' } }], identity), /Task/);
});

// 34: in the E2E the UX worker sent worker_done twice for the same dispatch. The live pipeline is
// idempotent for an exact repeat (one delivery) and fails closed when the repeats disagree.
test('a repeated worker_done for the same dispatch yields one delivery; contradictory repeats block', () => {
  const receipt = { type: 'worker_done', body: 'Entrega UX', payload: { ...identity, outcome: 'succeeded' } };
  const twice = [{ ...receipt, id: 'msg_2' }, { ...receipt, id: 'msg_1', body: '  Entrega UX\n' }];
  assert.deepEqual(matchingCompletion(twice, identity, { strict: true }), { text: 'Entrega UX', messageId: 'msg_2' });
  const otherDispatch = { ...receipt, id: 'msg_3', body: 'Otra etapa', payload: { ...receipt.payload, dispatchId: 'ctx_other01' } };
  assert.equal(matchingCompletion([otherDispatch, ...twice], identity, { strict: true }).text, 'Entrega UX');
  assert.throws(() => matchingCompletion([...twice, { ...receipt, id: 'msg_0', body: 'Entrega UX distinta' }], identity, { strict: true }),
    error => error.code === 'orca_receipt_ambiguous');
});

test('unavailable token measurements remain null and long legacy context is not cut silently', () => {
  assert.deepEqual(measuredUsage(undefined), { inputTokens: null, cachedInputTokens: null, outputTokens: null });
  assert.equal(measuredUsage({ input_tokens: 120, output_tokens: 9 }).inputTokens, 120);
  assert.match(handoffText({ text: 'X'.repeat(6606) + 'ACEPTACIÓN' }), /ACEPTACIÓN$/);
  assert.throws(() => handoffText({ text: 'X'.repeat(25000) }), /referencia/);
});

// Mixed pipeline (data/pipeline.json): each stage is launched with its own agent, model and effort.
const mixedExample = () => fs.readFile(new URL('../ejemplos/pipeline.mixto.example.json', import.meta.url), 'utf8');
const flagOf = (args, flag) => args.includes(flag) ? [args[args.indexOf(flag) + 1]] : [];
const launchedWith = item => ['--agent', '--model', '--effort'].flatMap(flag => flagOf(item.args, flag)).join(' ');
async function withDefaultAgent(t, agent) {
  const previous = process.env.CENTRO_ORCA_AGENT;
  if (agent === undefined) delete process.env.CENTRO_ORCA_AGENT; else process.env.CENTRO_ORCA_AGENT = agent;
  t.after(() => { if (previous === undefined) delete process.env.CENTRO_ORCA_AGENT; else process.env.CENTRO_ORCA_AGENT = previous; });
}

for (const [business, design] of [['agency', 'claude sonnet medium'], ['games', 'claude sonnet high']]) {
  test(`mixed profile in ${business}: Claude runs Diseño and Desarrollo, Codex runs QA and Revisión, and each stage records it`, async t => {
    await withDefaultAgent(t, undefined);
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'data', 'pipeline.json'), await mixedExample());
    await addJob(f.root, { ...f.spec, business });
    const simulator = fakeOrca(f.workspace);
    await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command: simulator.command }) });
    const job = (await loadState(f.root)).jobs[0]; assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.deepEqual(simulator.started.map(launchedWith), [design, design, 'codex gpt-6.1-sol medium', 'codex gpt-6.1-sol high']);
    assert.deepEqual(job.workflow.steps.filter(step => step.launch).map(step => `${step.key}:${step.orcaAgent}:${step.launch.source}`),
      business === 'games' ? ['ux:claude:empresa', 'developer:claude:empresa', 'qa:codex:general', 'reviewer:codex:general'] : ['ux:claude:general', 'developer:claude:general', 'qa:codex:general', 'reviewer:codex:general']);
    // Only Claude workers get the Claude-specific COMMANDS line of the brief.
    assert.deepEqual(simulator.started.map(item => /COMANDOS: /.test(item.launchInput)), [true, true, false, false]);
  });
}

test('a native retry keeps the agent, model and effort recorded at launch after the configuration changes', async t => {
  await withDefaultAgent(t, undefined);
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  const file = path.join(f.root, 'data', 'pipeline.json');
  await fs.writeFile(file, await mixedExample());
  await addJob(f.root, f.spec);
  const simulator = fakeOrca(f.workspace);
  const command = async args => {
    const value = await simulator.command(args);
    if (simulator.started.length === 1 && args[1] === 'worker-show') value.state = 'failed';
    if (simulator.started.length === 1 && args[1] === 'inbox') { const payload = JSON.parse(value.messages[0].payload); payload.outcome = 'failed'; value.messages[0].payload = JSON.stringify(payload); }
    return value;
  };
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command }) });
  const failed = (await loadState(f.root)).jobs[0]; assert.equal(failed.state, 'needs_attention');
  assert.equal(launchedWith(simulator.started[0]), 'claude sonnet medium');
  // The operator moves Diseño to Codex and QA to Claude before retrying.
  const changed = JSON.parse(await mixedExample());
  changed.general.roles.ux = { agent: 'codex', model: 'gpt-6-luna', effort: 'high' };
  changed.general.roles.qa = { agent: 'claude', model: 'haiku' };
  await fs.writeFile(file, JSON.stringify(changed));
  await retryJob(f.root, failed.id, { confirm: true });
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command }) });
  const done = (await loadState(f.root)).jobs[0]; assert.equal(done.state, 'succeeded', JSON.stringify(done.error));
  const retry = simulator.started[1];
  assert.equal(retry.args[retry.args.indexOf('--retry-of') + 1], simulator.started[0].dispatchId);
  assert.equal(launchedWith(retry), 'claude sonnet medium', 'the same Task keeps its recorded launch');
  assert.equal(done.workflow.steps[0].launch.recovered, true);
  assert.equal(launchedWith(simulator.started[3]), 'claude haiku', 'stages not launched yet use the configuration in force');
  assert.equal(simulator.started.length, 5, 'one retry and no duplicated worker');
});

test('an invalid data/pipeline.json stops the stage before any worker starts, without an uncertain dispatch', async t => {
  await withDefaultAgent(t, undefined);
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'data', 'pipeline.json'), JSON.stringify({ version: 1, general: { roles: { ux: { model: 'sonnet' } } } }));
  await addJob(f.root, f.spec);
  const simulator = fakeOrca(f.workspace);
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command: simulator.command }) });
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(job.state, 'needs_attention'); assert.equal(job.error.code, 'pipeline_config_invalid');
  assert.equal(simulator.started.length, 0);
  // Fixing the file and retrying launches normally.
  await fs.writeFile(path.join(f.root, 'data', 'pipeline.json'), await mixedExample());
  await retryJob(f.root, job.id, { confirm: true });
  await runQueue(f.root, { execute: true, worker: (job, ctx) => runOrca(job, ctx, { command: simulator.command }) });
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
  assert.equal(simulator.started.length, 4);
});
