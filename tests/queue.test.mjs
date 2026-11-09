import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addJob, increaseJobAttemptLimit, executionTimeoutMs, executionTimeExhausted, loadState, runQueue, retryJob, acquireLock, releaseLock, setBudget, reconcileCodeJob, verifyOrcaWorkerRecord, verifyOrcaRunRecords, verifyOrcaApprovalTranscript,
} from '../queue.mjs';
import { createWorker, isCreditExhausted, withTimeout, validateWorkspace } from '../providers.mjs';
import { reconcileCodeSummary } from '../cli.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(here, 'tmp-'));
  t.after(async () => {
    assert.equal(path.dirname(root), here);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const spec = (patch = {}) => ({
  id: 'review-001', business: 'games', kind: 'analysis', provider: 'auto', title: 'Revisar idea',
  prompt: 'Preparar tres observaciones sin modificar archivos.', ...patch,
});

test('Orca defaults to five attempts and explicit lower limits still apply', async t => {
  const root = await fixture(t);
  assert.equal((await addJob(root, spec({ provider: 'orca' }))).maxAttempts, 5);
  assert.equal((await addJob(root, spec({ id: 'limited', provider: 'orca', maxAttempts: 2 }))).maxAttempts, 2);
  assert.equal((await addJob(root, spec({ id: 'manual-provider' }))).maxAttempts, 2);
  await assert.rejects(addJob(root, spec({ id: 'too-many', provider: 'orca', maxAttempts: 6 })), /entre 1 y 5/);
});

test('raising the cap of a running Orca job preserves its exact active attempt', async t => {
  const root = await fixture(t);
  const job = await addJob(root, spec({ provider: 'orca', maxAttempts: 2 }));
  let release, announce;
  const paused = new Promise(resolve => { release = resolve; });
  const reported = new Promise(resolve => { announce = resolve; });
  const run = runQueue(root, { execute: true, business: job.business, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'planner', status: 'running', dispatchId: 'ctx_attempt_fixture' });
    announce();
    await paused;
    await ctx.reportStage({ key: 'planner', status: 'succeeded' });
    return { text: 'Plan verificado.' };
  } });
  try {
    await Promise.race([reported, run.then(() => assert.fail('The worker should still be active'))]);
    const before = (await loadState(root)).jobs[0];
    const changed = await increaseJobAttemptLimit(root, job.id, 5);
    assert.deepEqual(changed, { ...before, maxAttempts: 5 });
    await assert.rejects(increaseJobAttemptLimit(root, job.id, 4), /solo amplía/);
  } finally {
    release();
    await run;
  }
  const finished = (await loadState(root)).jobs[0];
  assert.equal(finished.attempts, 1);
  assert.equal(finished.maxAttempts, 5);
  assert.equal(finished.state, 'succeeded');
});

test('Orca has no default execution deadline for new or legacy jobs', async t => {
  const root = await fixture(t);
  const newJob = await addJob(root, spec({ provider: 'orca' }));
  assert.equal(newJob.timeoutMs, null);
  assert.equal(executionTimeoutMs(newJob), null);
  assert.equal(executionTimeExhausted(newJob, 10_800_000), false);
  assert.equal(executionTimeoutMs({ ...newJob, timeoutMs: 180_000 }), null);
  assert.equal(executionTimeExhausted({ provider: 'orca', kind: 'code', timeoutMs: 1_800_000 }, 1_800_000), false);
  const explicit = await addJob(root, spec({ id: 'explicit', provider: 'orca', timeoutMs: 180_000 }));
  assert.equal(executionTimeExhausted(explicit, 180_000), true);
  assert.equal(executionTimeExhausted({ provider: 'codex', kind: 'code', timeoutMs: 1_800_000 }, 1_800_000), true);
  const result = await runQueue(root, { execute: true, jobId: newJob.id, worker: async () => ({ text: 'Informe.' }) });
  assert.equal(result.jobs.length, 1);
  assert.equal((await loadState(root)).jobs.find(job => job.id === newJob.id).state, 'succeeded');
});

test('reconcile-code CLI summary allowlists useful identifiers and omits prompt/evidence', () => {
  const summary = reconcileCodeSummary({
    id: 'godot-reconcile', state: 'succeeded', prompt: 'PROMPT_CANARY_DO_NOT_PRINT',
    workflow: { status: 'delivery_wip', currentStage: 'integration' },
    branch: 'codex/godot-full-migration', destination: { branch: 'codex/godot-full-migration', sha: '400caa1' },
    deliveryStatus: 'wip', reconciliationDecisionId: 'coord-reconcile-001',
    coordinatorDecision: {
      evidence: 'EVIDENCE_CANARY_DO_NOT_PRINT',
      dispatches: [{ dispatchId: 'ctx_82429134517e' }, { dispatchId: 'ctx_93353fb64043' }],
    },
  });
  const output = JSON.stringify(summary);
  assert.equal(output.includes('PROMPT_CANARY_DO_NOT_PRINT'), false);
  assert.equal(output.includes('EVIDENCE_CANARY_DO_NOT_PRINT'), false);
  assert.deepEqual(summary, {
    id: 'godot-reconcile', state: 'succeeded', workflow: { status: 'delivery_wip', currentStage: 'integration' },
    branch: 'codex/godot-full-migration', destination: { branch: 'codex/godot-full-migration', sha: '400caa1' },
    deliveryStatus: 'wip', decisionId: 'coord-reconcile-001', dispatchIds: ['ctx_82429134517e', 'ctx_93353fb64043'],
  });
});

test('games Godot display keeps developer routing in durable events and agency unchanged', async t => {
  const root = await fixture(t);
  for (const business of ['games', 'agency']) {
    await addJob(root, spec({ id: `display-${business}`, kind: 'code', business, provider: 'orca', workspace: path.join(root, 'workspaces', business), isolated: true }));
  }
  const jobs = (await loadState(root)).jobs;
  for (const job of jobs) {
    assert.deepEqual(job.workflow.steps.map(step => step.key), ['ux', 'developer', 'qa', 'reviewer']);
    assert.deepEqual(job.workflow.steps.map(step => step.profile), ['ux', 'desarrollador', 'qa', 'revisor'].map(profile => `${profile}_${job.business}`));
    assert.equal(job.workflow.steps[1].label, job.business === 'games' ? 'Desarrollo de videojuegos (Godot)' : 'Implementación');
  }
  const events = (await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.at(-1).patch.jobs[0].workflow.steps, jobs[1].workflow.steps);
  assert.equal(events[0].patch.jobs[0].workflow.steps[1].profile, 'desarrollador_games');
});

async function reconciliationFixture(t) {
  const root = await fixture(t);
  const workspace = path.join(root, 'workspaces', 'flecha-trampa-github');
  await addJob(root, spec({ id: 'godot-reconcile', kind: 'code', business: 'games', provider: 'orca', workspace, isolated: true, autoIntent: { eligible: true },
    branch: 'develop', destination: { checkout: 'workspaces/flecha-trampa-github', workspace, branch: 'develop', sha: '1c14cf2' } }));
  const state = await loadState(root);
  const previous = state.jobs[0];
  const workflow = {
    ...previous.workflow, runId: 'run_63efad10fb71', status: 'needs_attention', currentStage: 'developer',
    steps: previous.workflow.steps.map(step => step.key === 'ux'
      ? { ...step, status: 'succeeded', dispatchId: 'ctx_5ea29c6ce824', taskId: 'task_34bb1d80f152', attempt: 2 }
      : step.key === 'developer'
        ? { ...step, status: 'blocked', dispatchStatus: 'unknown', dispatchId: 'ctx_82429134517e', taskId: 'task_64e6e50b9c31', attempt: 2 }
        : step),
  };
  const job = { ...previous, state: 'needs_attention', attempts: 2, branch: 'develop', workflow,
    error: { code: 'orca_dispatch_status_unknown', message: 'unknown' } };
  const event = { schema: 1, revision: state.revision + 1, at: new Date().toISOString(), type: 'fixture_external_dispatch_failure', patch: { jobs: [job] } };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify(event) + '\n');
  const decision = {
    schema: 1,
    decisionId: 'coord-reconcile-001',
    dispatches: [
      { stage: 'ux', dispatchId: 'ctx_5ea29c6ce824', taskId: 'task_34bb1d80f152', runId: 'run_63efad10fb71', state: 'succeeded', sequence: 1, jobAttempt: 2, parentTaskId: null, retryOfDispatchId: null, approvalEvidence: null },
      { stage: 'developer', dispatchId: 'ctx_82429134517e', taskId: 'task_64e6e50b9c31', runId: 'run_63efad10fb71', state: 'failed', sequence: 1, jobAttempt: 2, parentTaskId: null, retryOfDispatchId: null, approvalEvidence: null },
      { stage: 'developer', dispatchId: 'ctx_93353fb64043', taskId: 'task_64e6e50b9c31', runId: 'run_63efad10fb71', state: 'succeeded', sequence: 2, jobAttempt: 2, parentTaskId: null, retryOfDispatchId: 'ctx_82429134517e', approvalEvidence: null },
      { stage: 'qa', dispatchId: 'ctx_0b91884aac31', taskId: 'task_e3b1c33a4468', runId: 'run_63efad10fb71', state: 'succeeded', sequence: 1, jobAttempt: 2, parentTaskId: 'task_64e6e50b9c31', retryOfDispatchId: null, approvalEvidence: 'RESULTADO: APROBADO' },
      { stage: 'reviewer', dispatchId: 'ctx_3146e226e909', taskId: 'task_a6ebc23b3f46', runId: 'run_63efad10fb71', state: 'succeeded', sequence: 1, jobAttempt: 2, parentTaskId: 'task_e3b1c33a4468', retryOfDispatchId: null, approvalEvidence: 'RESULTADO: APROBADO' },
    ],
    destination: { checkout: 'workspaces/flecha-trampa-github', branch: 'codex/godot-full-migration', sha: '400caa1', verified: true },
    evidence: 'El retry de Desarrollo, QA y Revisión finalizaron; el destino codex/godot-full-migration se verificó en 400caa1. La migración sigue WIP.',
  };
  return { root, job, decision };
}

const mockTerminalFor = dispatchId => `term_fixture_${({
  ctx_5ea29c6ce824: 1, ctx_82429134517e: 2, ctx_93353fb64043: 3,
  ctx_0b91884aac31: 4, ctx_3146e226e909: 5,
})[dispatchId]}`;

function mockWorkerShow(evidence, overrides = {}) {
  return {
    dispatch: {
      id: evidence.dispatchId, taskId: evidence.taskId, runId: evidence.runId,
      status: evidence.state === 'failed' ? 'failed' : 'completed', retryOfDispatchId: evidence.retryOfDispatchId,
      assigneeHandle: mockTerminalFor(evidence.dispatchId),
      ...overrides.dispatch,
    },
    worker: { dispatchId: evidence.dispatchId, state: evidence.state, agentTerminalHandle: mockTerminalFor(evidence.dispatchId), ...overrides.worker },
    projection: {
      dispatchId: evidence.dispatchId, taskId: evidence.taskId, runId: evidence.runId,
      outcome: evidence.state, parent: evidence.parentTaskId ? { taskId: evidence.parentTaskId } : null,
      ...overrides.projection,
    },
  };
}

function mockRunRecords(decision) {
  const messages = [];
  const tasksById = new Map();
  for (let index = 0; index < decision.dispatches.length; index++) {
    const evidence = decision.dispatches[index];
    const from = mockTerminalFor(evidence.dispatchId);
    const body = ['qa', 'reviewer'].includes(evidence.stage)
      ? `Reporte terminal de ${evidence.stage}.\nRESULTADO: APROBADO`
      : `Reporte ${evidence.stage}: ${evidence.state}.`;
    const message = {
      id: `msg_fixture_${index + 1}`, run_id: evidence.runId, to_handle: `run:${evidence.runId}`,
      from_handle: from, type: 'worker_done', body,
      payload: JSON.stringify({ taskId: evidence.taskId, dispatchId: evidence.dispatchId, outcome: evidence.state }),
    };
    messages.push(message);
    if (!tasksById.has(evidence.taskId)) tasksById.set(evidence.taskId, {
      id: evidence.taskId, run_id: evidence.runId, parent_id: evidence.parentTaskId, status: 'completed',
    });
    if (evidence.state === 'succeeded') {
      tasksById.get(evidence.taskId).result = JSON.stringify({
        outcome: 'succeeded', messageId: message.id, reportedBy: from, body: message.body,
      });
    }
  }
  const tasks = [...tasksById.values()];
  return {
    inbox: { count: messages.length, messages },
    taskList: { runId: decision.dispatches[0].runId, legacyReadOnly: false, count: tasks.length, tasks },
  };
}

const mockDispatchVerifier = (decision, overrides = {}) => {
  const records = mockRunRecords(decision);
  return async (evidence, { relatedDispatches } = {}) => {
    const observed = mockWorkerShow(evidence, overrides[evidence.dispatchId]);
    return {
      ...verifyOrcaWorkerRecord(evidence, observed),
      ...verifyOrcaRunRecords(evidence, { ...records, terminalHandle: mockTerminalFor(evidence.dispatchId), relatedDispatches }),
    };
  };
};

function replaceRunReceiptBody(records, dispatchId, body) {
  const message = records.inbox.messages.find(item => JSON.parse(item.payload).dispatchId === dispatchId);
  message.body = body;
  const task = records.taskList.tasks.find(item => item.id === JSON.parse(message.payload).taskId);
  const result = JSON.parse(task.result);
  result.body = body;
  task.result = JSON.stringify(result);
}

const mockDestinationVerifier = async (_root, job) => ({
  checkout: 'workspaces/flecha-trampa-github', workspace: job.workspace,
  branch: 'codex/godot-full-migration', sha: '400caa1'.padEnd(40, '0'),
});

test('coordinator reconciliation preserves dispatch timeline, marks stages and leaves migration WIP', async t => {
  const { root, decision } = await reconciliationFixture(t);
  let verified = 0;
  const baseVerifier = mockDispatchVerifier(decision);
  const verifier = async (evidence, context) => { verified++; return baseVerifier(evidence, context); };
  const job = await reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision, verifyDispatch: verifier, verifyDestination: mockDestinationVerifier });
  assert.equal(verified, 5);
  assert.equal(job.state, 'needs_attention');
  assert.equal(job.error.code, 'delivery_wip');
  assert.equal(job.deliveryStatus, 'wip');
  assert.equal(job.workflow.status, 'delivery_wip');
  assert.equal(job.workflow.currentStage, 'integration');
  assert.deepEqual(job.workflow.steps.slice(0, 4).map(step => step.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  assert.equal(job.workflow.steps[1].dispatchHistory[0].dispatchId, 'ctx_82429134517e');
  assert.equal(job.workflow.steps[1].dispatchHistory[0].taskId, 'task_64e6e50b9c31');
  assert.equal(job.workflow.steps[1].dispatchHistory[1].dispatchId, 'ctx_93353fb64043');
  assert.equal(job.workflow.steps[2].dispatchId, 'ctx_0b91884aac31');
  assert.equal(job.workflow.steps[3].dispatchId, 'ctx_3146e226e909');
  assert.equal(job.branch, 'codex/godot-full-migration');
  assert.equal(job.destination.sha, '400caa1'.padEnd(40, '0'));
  assert.equal(job.workflow.steps[4].status, 'blocked');
  assert.equal(job.workflow.steps[4].error, 'delivery_wip');
  const recovered = await loadState(root);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'data', 'state.json'), 'utf8'));
  assert.deepEqual(snapshot, recovered);
  await assert.rejects(fs.access(path.join(root, 'data', 'runner.lock')), error => error.code === 'ENOENT');
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  const repeated = await reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision, verifyDispatch: verifier, verifyDestination: mockDestinationVerifier });
  assert.equal(repeated.idempotent, true);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
  const reusedId = structuredClone(decision);
  reusedId.evidence = 'Metadata diferente para el mismo decisionId.';
  await assert.rejects(reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision: reusedId, verifyDispatch: verifier, verifyDestination: mockDestinationVerifier }), error => error.code === 'reconciliation_duplicate');
});

test('coordinator reconciliation rejects discordant IDs/destination, duplicate retries and invalid metadata', async t => {
  const mismatchCases = [
    d => { d.dispatches[0].dispatchId = 'ctx_wrong000001'; },
    d => { d.dispatches[1].taskId = 'task_wrong000001'; },
    d => { d.dispatches[2].retryOfDispatchId = null; },
    d => { d.dispatches[3].parentTaskId = 'task_wrong000001'; },
    d => { d.dispatches[4].approvalEvidence = ''; },
    d => { d.dispatches[3].approvalEvidence = 'RESULTADO: APROBADO\nQA bloqueada'; },
    d => { d.dispatches[0].runId = 'run_wrong0001'; },
    d => { d.dispatches[4].jobAttempt = 1; },
    d => { d.destination.branch = 'develop'; },
    d => { d.destination.checkout = 'otro-checkout'; },
    d => { d.destination.sha = 'not-a-commit'; },
    d => { d.dispatches[2].dispatchId = d.dispatches[1].dispatchId; },
    d => { d.dispatches[2].sequence = 1; },
    d => { d.unexpected = true; },
  ];
  for (const mutateDecision of mismatchCases) {
    const { root, decision } = await reconciliationFixture(t);
    mutateDecision(decision);
    await assert.rejects(reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision, verifyDispatch: mockDispatchVerifier(decision), verifyDestination: mockDestinationVerifier }));
    assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  }
});

test('code reconciliation requires injected Orca verification and rejects uncorrelated outcomes or QA transcripts', async t => {
  for (const overrides of [
    { ctx_93353fb64043: { worker: { state: 'failed' } } },
    { ctx_0b91884aac31: { projection: { parent: { taskId: 'task_wrong000001' } } } },
  ]) {
    const { root, decision } = await reconciliationFixture(t);
    await assert.rejects(reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision, verifyDispatch: mockDispatchVerifier(decision, overrides), verifyDestination: mockDestinationVerifier }), error => error.code === 'reconciliation_dispatch_mismatch');
    assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  }
  const { root, decision } = await reconciliationFixture(t);
  await assert.rejects(reconcileCodeJob(root, 'godot-reconcile', { confirm: true, decision }), error => error.code === 'reconciliation_verifier_required');
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
});

test('worker-show and full Run inbox/task-list records correlate terminal reports and exact QA approvals', async t => {
  const { root, decision } = await reconciliationFixture(t);
  const records = mockRunRecords(decision);
  for (const evidence of decision.dispatches) {
    const actual = verifyOrcaWorkerRecord(evidence, mockWorkerShow(evidence));
    assert.equal(actual.dispatchId, evidence.dispatchId);
    const receipt = verifyOrcaRunRecords(evidence, { ...records, terminalHandle: mockTerminalFor(evidence.dispatchId), relatedDispatches: decision.dispatches });
    assert.equal(receipt.approvalVerified, ['qa', 'reviewer'].includes(evidence.stage));
  }

  const completeMention = structuredClone(records);
  replaceRunReceiptBody(completeMention, 'ctx_0b91884aac31', 'Se comprobó que un informe truncated o clipped se rechaza.\nRESULTADO: APROBADO');
  assert.equal(verifyOrcaRunRecords(decision.dispatches[3], { ...completeMention, terminalHandle: mockTerminalFor(decision.dispatches[3].dispatchId) }).approvalVerified, true);
  const invalidRecords = [
    value => { value.inbox.messages.push(structuredClone(value.inbox.messages[3])); value.inbox.count++; },
    value => { value.inbox.messages.find(item => item.id === 'msg_fixture_4').id = ''; },
    value => { value.inbox.messages.find(item => item.id === 'msg_fixture_1').id = 'msg_fixture_4'; },
    value => { const receipt = value.inbox.messages.find(item => item.id === 'msg_fixture_4'); receipt.payload = JSON.stringify({ taskId: 'task_wrong000001', dispatchId: 'ctx_0b91884aac31', outcome: 'succeeded' }); },
    value => { const receipt = value.inbox.messages.find(item => item.id === 'msg_fixture_4'); receipt.payload = JSON.stringify({ taskId: 'task_e3b1c33a4468', dispatchId: 'ctx_0b91884aac31', outcome: 'failed' }); },
    value => { value.inbox.messages = value.inbox.messages.filter(item => item.id !== 'msg_fixture_4'); value.inbox.count--; },
    value => { value.inbox.count = 500; },
    value => { value.taskList.legacyReadOnly = true; },
    value => { value.taskList.tasks.find(task => task.id === 'task_e3b1c33a4468').parent_id = null; },
    value => { value.taskList.tasks.find(task => task.id === 'task_e3b1c33a4468').status = 'running'; },
    value => { value.taskList.tasks.find(task => task.id === 'task_e3b1c33a4468').run_id = 'run_wrong0001'; },
    value => { const task = value.taskList.tasks.find(item => item.id === 'task_e3b1c33a4468'); const result = JSON.parse(task.result); result.messageId = 'msg_wrong0001'; task.result = JSON.stringify(result); },
    value => { const task = value.taskList.tasks.find(item => item.id === 'task_e3b1c33a4468'); const result = JSON.parse(task.result); delete result.messageId; task.result = JSON.stringify(result); },
    value => { replaceRunReceiptBody(value, 'ctx_0b91884aac31', 'RESULTADO: APROBADO\nQA bloqueada'); },
    value => { replaceRunReceiptBody(value, 'ctx_0b91884aac31', 'El texto menciona RESULTADO: APROBADO sin aprobar.'); },
    value => { replaceRunReceiptBody(value, 'ctx_0b91884aac31', 'RESULTADO: APROBADO CON RESERVAS'); },
    value => { value.inbox.messages.find(item => item.id === 'msg_fixture_4').from_handle = 'term_forged'; },
    value => { value.taskList.count = 500; },
  ];
  for (const mutateRecords of invalidRecords) {
    const broken = structuredClone(records);
    mutateRecords(broken);
    assert.throws(() => verifyOrcaRunRecords(decision.dispatches[3], { ...broken, terminalHandle: mockTerminalFor(decision.dispatches[3].dispatchId) }), error => error.code?.startsWith('reconciliation_'));
  }
  const failedDeveloper = decision.dispatches[1];
  const failedReceiptWithoutId = structuredClone(records);
  delete failedReceiptWithoutId.inbox.messages.find(item => item.id === 'msg_fixture_2').id;
  assert.throws(() => verifyOrcaRunRecords(failedDeveloper, {
    ...failedReceiptWithoutId, terminalHandle: mockTerminalFor(failedDeveloper.dispatchId), relatedDispatches: decision.dispatches,
  }), error => error.code === 'reconciliation_receipt_mismatch');
  const retryReceiptWithoutId = structuredClone(records);
  delete retryReceiptWithoutId.inbox.messages.find(item => item.id === 'msg_fixture_3').id;
  assert.throws(() => verifyOrcaRunRecords(failedDeveloper, {
    ...retryReceiptWithoutId, terminalHandle: mockTerminalFor(failedDeveloper.dispatchId), relatedDispatches: decision.dispatches,
  }), error => error.code === 'reconciliation_receipt_mismatch');
  const failedTaskResultWithoutMessageId = structuredClone(records);
  const failedTask = failedTaskResultWithoutMessageId.taskList.tasks.find(item => item.id === failedDeveloper.taskId);
  const failedResult = JSON.parse(failedTask.result);
  delete failedResult.messageId;
  failedTask.result = JSON.stringify(failedResult);
  assert.throws(() => verifyOrcaRunRecords(failedDeveloper, {
    ...failedTaskResultWithoutMessageId, terminalHandle: mockTerminalFor(failedDeveloper.dispatchId), relatedDispatches: decision.dispatches,
  }), error => error.code === 'reconciliation_task_mismatch');
  for (const mutateResult of [
    result => { result.outcome = 'failed'; },
    result => { result.messageId = 'msg_wrong0001'; },
    result => { result.reportedBy = 'term_forged'; },
    result => { result.body = 'Informe distinto del retry.'; },
  ]) {
    const broken = structuredClone(records);
    const task = broken.taskList.tasks.find(item => item.id === failedDeveloper.taskId);
    const result = JSON.parse(task.result);
    mutateResult(result);
    task.result = JSON.stringify(result);
    assert.throws(() => verifyOrcaRunRecords(failedDeveloper, {
      ...broken, terminalHandle: mockTerminalFor(failedDeveloper.dispatchId), relatedDispatches: decision.dispatches,
    }), error => error.code === 'reconciliation_task_mismatch');
  }
  const clippedFailure = structuredClone(records);
  clippedFailure.inbox.messages.find(item => item.id === 'msg_fixture_2').body += '\n[truncated]';
  assert.throws(() => verifyOrcaRunRecords(failedDeveloper, {
    ...clippedFailure, terminalHandle: mockTerminalFor(failedDeveloper.dispatchId), relatedDispatches: decision.dispatches,
  }), error => error.code === 'reconciliation_receipt_mismatch');
  for (const override of [
    { dispatch: { taskId: 'task_wrong000001' } },
    { dispatch: { runId: 'run_wrong0001' } },
    { worker: { state: 'failed' } },
    { worker: { agentTerminalHandle: 'term_forged' } },
    { projection: { parent: { taskId: 'task_wrong000001' } } },
    { dispatch: { retryOfDispatchId: 'ctx_wrong000001' } },
  ]) {
    assert.throws(() => verifyOrcaWorkerRecord(decision.dispatches[2], mockWorkerShow(decision.dispatches[2], override)), error => error.code === 'reconciliation_dispatch_mismatch', JSON.stringify(override));
  }
  assert.throws(() => verifyOrcaRunRecords(decision.dispatches[3], { ...records, terminalHandle: mockTerminalFor(decision.dispatches[3].dispatchId), limit: 5 }), error => error.code === 'reconciliation_records_invalid');
});

function transcriptPage({ dispatchId = 'ctx_0b91884aac31', sourceIdentity = 'transcript-v1', text = '', limited = false,
  nextCursor = null, contentComplete = !limited, warnings = [], clipping } = {}) {
  return {
    dispatchId, source: 'transcript', sourceExact: true, archived: true, sourceIdentity,
    status: { worker: 'succeeded' }, projection: { outcome: 'succeeded' },
    transcript: { messages: [{ role: 'assistant', blocks: [{ type: 'text', text }] }] },
    limited, nextCursor, contentComplete, warnings, ...(clipping === undefined ? {} : { clipping }),
  };
}

test('Orca transcript verification paginates to stable complete source and requires exact terminal approval marker', async () => {
  const pages = new Map([
    [undefined, transcriptPage({ text: 'QA evidencia parcial', limited: true, nextCursor: 'cursor-one' })],
    ['cursor-one', transcriptPage({ text: 'Informe QA completo.\nRESULTADO: APROBADO' })],
  ]);
  const seen = [];
  assert.equal(await verifyOrcaApprovalTranscript('ctx_0b91884aac31', 'succeeded', async ({ cursor }) => {
    seen.push(cursor); return pages.get(cursor);
  }), true);
  assert.deepEqual(seen, [undefined, 'cursor-one']);

  const invalidPageSets = [
    [
      transcriptPage({ text: 'parte', limited: true, nextCursor: 'repeat' }),
      transcriptPage({ text: 'RESULTADO: APROBADO', limited: true, nextCursor: 'repeat' }),
    ],
    [
      transcriptPage({ text: 'parte', limited: true, nextCursor: 'next' }),
      transcriptPage({ text: 'RESULTADO: APROBADO', sourceIdentity: 'changed' }),
    ],
    [transcriptPage({ text: 'RESULTADO: APROBADO', warnings: ['Oversized transcript text was clipped.'] })],
    [transcriptPage({ text: 'RESULTADO: APROBADO', clipping: ['transcript_payload'] })],
    [transcriptPage({ text: 'RESULTADO: APROBADO', contentComplete: false })],
    [transcriptPage({ text: 'RESULTADO: APROBADO', limited: true, nextCursor: 'next' })],
    [transcriptPage({ text: 'RESULTADO: APROBADO\nSe detectó una negación al final.' })],
    [transcriptPage({ text: 'RESULTADO: APROBADO, con reservas' })],
    [transcriptPage({ text: 'El marcador RESULTADO: APROBADO no acredita QA.' })],
  ];
  for (const invalidPages of invalidPageSets) {
    await assert.rejects(verifyOrcaApprovalTranscript('ctx_0b91884aac31', 'succeeded', async ({ cursor }) => {
      return invalidPages[cursor ? 1 : 0];
    }, { maxPages: invalidPages.length === 1 && invalidPages[0].limited ? 1 : 100 }), error => error.code === 'reconciliation_approval_unverified');
  }
});
async function appendInterruptedStart(root) {
  const state = await loadState(root);
  const job = { ...state.jobs[0], state: 'running', attempts: 1, startedAt: new Date().toISOString() };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({
    schema: 1, revision: state.revision + 1, at: new Date().toISOString(),
    type: 'job_started', details: { jobId: job.id }, patch: { jobs: [job] },
  }) + '\n');
}

test('dry run leaves the durable queue unchanged and never invokes a worker', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  let calls = 0;
  const result = await runQueue(root, { worker: async () => { calls++; } });
  assert.equal(result.dryRun, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
});

test('job identifiers and completed jobs cannot execute twice', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await assert.rejects(addJob(root, spec()), error => error.code === 'duplicate');
  let calls = 0;
  const worker = async () => { calls++; return { text: 'Listo' }; };
  await runQueue(root, { execute: true, worker });
  await runQueue(root, { execute: true, worker });
  assert.equal(calls, 1);
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});

test('a held runner lock rejects another writer and another runner', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const lock = await acquireLock(root);
  try {
    await assert.rejects(acquireLock(root), error => error.code === 'locked');
    await assert.rejects(addJob(root, spec({ id: 'second' })), error => error.code === 'locked');
    await assert.rejects(runQueue(root, { execute: true, worker: async () => {} }), error => error.code === 'locked');
  } finally { await releaseLock(lock); }
  const replacement = await acquireLock(root);
  await releaseLock(lock);
  await assert.rejects(acquireLock(root), error => error.code === 'locked');
  await releaseLock(replacement);
});

test('concurrent runners cannot duplicate a currently executing job', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let finish;
  const hold = new Promise(resolve => { finish = resolve; });
  let calls = 0;
  const first = runQueue(root, { execute: true, worker: async () => { calls++; started(); await hold; return { text: 'Listo' }; } });
  await running;
  try {
    await assert.rejects(runQueue(root, { execute: true, worker: async () => { calls++; } }), error => error.code === 'locked');
  } finally { finish(); }
  await first;
  assert.equal(calls, 1);
});

test('uncertain and incomplete locks stop execution until reviewed manually', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  const filename = path.join(root, 'data', 'runner.lock');
  await fs.writeFile(filename, '{incomplete');
  await assert.rejects(acquireLock(root), error => error.code === 'lock_uncertain');
  assert.equal(await fs.readFile(filename, 'utf8'), '{incomplete');
  await fs.writeFile(filename, JSON.stringify({ pid: 2_147_483_647, token: 'unsafe-token', unsafe: true }));
  await assert.rejects(acquireLock(root), error => error.code === 'lock_uncertain');
  assert.equal(JSON.parse(await fs.readFile(filename, 'utf8')).unsafe, true);
});

test('stale lock and interrupted execution recover to manual attention without replaying work', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await appendInterruptedStart(root);
  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), error => error.code === 'ESRCH');
  await fs.writeFile(path.join(root, 'data', 'runner.lock'), JSON.stringify({ pid: deadPid, token: 'dead-process-token' }));
  let calls = 0;
  const blocked = await runQueue(root, { execute: true, worker: async () => { calls++; } });
  assert.deepEqual(blocked.blockedNeedsAttention, ['review-001']);
  const recovered = (await loadState(root)).jobs[0];
  assert.equal(calls, 0);
  assert.equal(recovered.state, 'needs_attention');
  assert.equal(recovered.error.code, 'interrupted');
  await addJob(root, spec({ id: 'different-job' }));
  await runQueue(root, { execute: true, worker: async () => { calls++; } });
  assert.equal(calls, 0, 'an orphaned child must be reviewed before starting other jobs');
  await assert.rejects(retryJob(root, recovered.id));
  await retryJob(root, recovered.id, { confirm: true });
  await runQueue(root, { execute: true, worker: async () => { calls++; return { text: 'Revisado' }; }, maxJobs: 1 });
  assert.equal(calls, 1);
});

test('only explicit provider exhaustion codes classify as exhausted credit', () => {
  assert.equal(isCreditExhausted({ error: { code: 'insufficient_quota' } }), true);
  assert.equal(isCreditExhausted({ error: { code: 'credit_balance_exhausted' } }), true);
  assert.equal(isCreditExhausted({ error: { code: 'rate_limit_exceeded' } }), false);
  assert.equal(isCreditExhausted({ error: { message: 'credit balance exhausted' } }), false);
  assert.equal(isCreditExhausted({ error: { code: 'invalid_api_key' } }), false);
  assert.equal(isCreditExhausted(null), false);
});

async function providerFixture(t, patch = {}) {
  const root = await fixture(t);
  await addJob(root, spec(patch));
  await setBudget(root, { limitUsd: 1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  return root;
}
const fakeEnv = { OPENAI_API_KEY: 'unit-test-key-must-never-be-persisted' };
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('explicit API exhaustion falls back exactly once to the ChatGPT Codex adapter', async t => {
  const root = await providerFixture(t);
  let apiCalls = 0, codexCalls = 0;
  const worker = createWorker({
    env: fakeEnv,
    fetchImpl: async (url, request) => {
      apiCalls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(request.headers.Authorization, `Bearer ${fakeEnv.OPENAI_API_KEY}`);
      assert.deepEqual(JSON.parse(request.body).tools, []);
      return response(429, { error: { code: 'insufficient_quota' } });
    },
    runCodexImpl: async job => { codexCalls++; assert.equal(job.prompt, spec().prompt); return { provider: 'codex-chatgpt', text: 'Alternativa' }; },
  });
  await runQueue(root, { execute: true, worker });
  const state = await loadState(root);
  assert.equal(apiCalls, 1);
  assert.equal(codexCalls, 1);
  assert.equal(state.jobs[0].state, 'succeeded');
  assert.equal(state.jobs[0].result.fallbackReason, 'explicit_api_credit_exhaustion');
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0);
});

test('rate-limit, unknown 429 and authentication failures never invoke the fallback', async t => {
  for (const [code, status, expectedState] of [
    ['rate_limit_exceeded', 429, 'retry_wait'],
    ['unknown_error', 429, 'needs_attention'],
    ['invalid_api_key', 401, 'needs_attention'],
  ]) {
    const root = await providerFixture(t);
    let codexCalls = 0;
    const worker = createWorker({ env: fakeEnv,
      fetchImpl: async () => response(status, { error: { code } }),
      runCodexImpl: async () => { codexCalls++; return { text: 'Incorrect fallback' }; },
    });
    await runQueue(root, { execute: true, worker });
    assert.equal(codexCalls, 0, code);
    const state = await loadState(root);
    assert.equal(state.jobs[0].state, expectedState, code);
    assert.equal(state.budget.reservedUsd, 0);
    assert.equal(state.budget.estimatedSpentUsd, 0);
  }
});

test('API-pinned jobs stop on exhaustion and do not switch providers', async t => {
  const root = await providerFixture(t, { provider: 'api' });
  let calls = 0;
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => response(429, { error: { code: 'insufficient_quota' } }),
    runCodexImpl: async () => { calls++; return { text: 'Incorrect fallback' }; },
  }) });
  const state = await loadState(root);
  assert.equal(calls, 0);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'credit_exhausted');
});

test('successful API usage settles estimates and redacts a leaked test key from all durable output', async t => {
  const root = await providerFixture(t);
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => response(200, { status: 'completed', usage: { input_tokens: 23, output_tokens: 19 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: `Resultado ${fakeEnv.OPENAI_API_KEY}` }] }],
    }),
    runCodexImpl: async () => { throw new Error('fallback should not run'); },
  }) });
  const state = await loadState(root);
  assert.equal(state.jobs[0].state, 'succeeded');
  assert.equal(state.jobs[0].result.text, 'Resultado [CLAVE OCULTA]');
  assert.equal(state.budget.estimatedSpentUsd, 0.000061);
  for (const filename of ['events.jsonl', 'state.json']) {
    assert.equal((await fs.readFile(path.join(root, 'data', filename), 'utf8')).includes(fakeEnv.OPENAI_API_KEY), false);
  }
});

test('transport errors retain conservative estimate and require review without fallback', async t => {
  const root = await providerFixture(t);
  let codexCalls = 0;
  await runQueue(root, { execute: true, worker: createWorker({ env: fakeEnv,
    fetchImpl: async () => { throw new Error(`Network error ${fakeEnv.OPENAI_API_KEY}`); },
    runCodexImpl: async () => { codexCalls++; },
  }) });
  const state = await loadState(root);
  assert.equal(codexCalls, 0);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'api_transport_error');
  assert.ok(state.budget.estimatedSpentUsd > 0);
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal((await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).includes(fakeEnv.OPENAI_API_KEY), false);
});

test('timeout helper aborts the operation and labels the outcome uncertain', async () => {
  let aborted = false;
  const started = Date.now();
  await assert.rejects(withTimeout(signal => new Promise(() => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
  }), 20), error => error.code === 'timeout' && error.uncertain === true && error.retryable === false);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1_000);
});

test('code workspace validation rejects outside paths, linked metadata and missing isolation confirmation', async t => {
  const root = await fixture(t);
  const workspaces = path.join(root, 'workspaces');
  const checkout = path.join(workspaces, 'separate-checkout');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await fs.mkdir(path.join(outside, '.git'), { recursive: true });
  assert.equal(await validateWorkspace({ workspace: checkout, isolated: true }, root), await fs.realpath(checkout));
  await assert.rejects(validateWorkspace({ workspace: outside, isolated: true }, root), error => error.code === 'unsafe_workspace');
  await assert.rejects(validateWorkspace({ workspace: checkout, isolated: false }, root), error => error.code === 'unsafe_workspace');
  await fs.rm(path.join(checkout, '.git'), { recursive: true });
  await fs.writeFile(path.join(checkout, '.git'), 'gitdir: shared-active-metadata');
  await assert.rejects(validateWorkspace({ workspace: checkout, isolated: true }, root), error => error.code === 'unsafe_workspace');
});

test('ledger recovers an outdated/broken snapshot and trims only an incomplete final record', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await fs.writeFile(path.join(root, 'data', 'state.json'), '{snapshot broken');
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), '{"revision":2,"partial":');
  assert.equal((await loadState(root)).jobs[0].id, 'review-001');
  await addJob(root, spec({ id: 'review-002', business: 'agency' }));
  const state = await loadState(root);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.revision, 2);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), '{bad complete record}\n');
  await assert.rejects(loadState(root), error => error.code === 'ledger_corrupt');
});

test('explicit rejected requests back off and stop at the maximum attempt count', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxAttempts: 2 }));
  const start = Date.now();
  let calls = 0;
  const worker = async () => { calls++; throw Object.assign(new Error('rejected'), { code: 'rate_limit', retryable: true }); };
  await runQueue(root, { execute: true, worker, now: start, clock: () => start });
  assert.equal((await loadState(root)).jobs[0].state, 'retry_wait');
  await runQueue(root, { execute: true, worker, now: start + 29_999, clock: () => start + 29_999 });
  assert.equal(calls, 1);
  await runQueue(root, { execute: true, worker, now: start + 30_000, clock: () => start + 30_000 });
  const exhausted = (await loadState(root)).jobs[0];
  assert.equal(calls, 2);
  assert.equal(exhausted.state, 'needs_attention');
  assert.equal(exhausted.attempts, 2);
  await assert.rejects(retryJob(root, exhausted.id, { confirm: true }));
});

test('retry backoff starts when a slow request is rejected, not when the runner starts', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxAttempts: 2 }));
  const start = 1_700_000_000_000;
  let current = start;
  const clock = () => current;
  let calls = 0;
  const worker = async () => {
    calls++;
    if (calls === 1) {
      current += 120_000;
      throw Object.assign(new Error('request rejected after a long wait'), { code: 'rate_limit', retryable: true });
    }
    return { text: 'Reintento completado' };
  };
  await runQueue(root, { execute: true, worker, clock });
  const waiting = (await loadState(root)).jobs[0];
  assert.equal(waiting.state, 'retry_wait');
  assert.equal(Date.parse(waiting.nextAttemptAt), start + 120_000 + 30_000);
  current = start + 149_999;
  await runQueue(root, { execute: true, worker, clock });
  assert.equal(calls, 1);
  assert.equal((await loadState(root)).jobs[0].state, 'retry_wait');
  current += 1;
  await runQueue(root, { execute: true, worker, clock });
  assert.equal(calls, 2);
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});

test('uncertain failures always require operator review even when marked retryable', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  const worker = async () => { throw Object.assign(new Error('timeout'), { code: 'timeout', retryable: true, uncertain: true }); };
  await runQueue(root, { execute: true, worker });
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  await runQueue(root, { execute: true, worker });
  assert.equal((await loadState(root)).jobs[0].attempts, 1);
});

test('parallel company executors share the same durable budget cap', async t => {
  const root = await fixture(t);
  await setBudget(root, { limitUsd: 0.1, model: 'fixture', inputPerMillion: 0, outputPerMillion: 0 });
  for (const business of ['agency', 'games']) await addJob(root, spec({ id: business, business }));
  let arrived = 0, checked = 0, release, reserved;
  const together = new Promise(resolve => { release = resolve; });
  const bothChecked = new Promise(resolve => { reserved = resolve; });
  const worker = async (_job, ctx) => {
    if (++arrived === 2) release();
    await together;
    try { await ctx.reserve(0.08); }
    finally { if (++checked === 2) reserved(); }
    await bothChecked;
    await ctx.settle(0.08);
    return { text: 'Reservado' };
  };
  const results = await Promise.all(['agency', 'games'].map(business => runQueue(root, { execute: true, worker, business })));
  assert.equal(arrived, 2);
  assert.deepEqual(results.flatMap(result => result.jobs.map(job => job.state)).sort(), ['needs_attention', 'succeeded']);
  const { budget, jobs } = await loadState(root);
  assert.equal(budget.reservedUsd, 0);
  assert.equal(budget.estimatedSpentUsd, 0.08);
  assert.equal(jobs.find(job => job.state === 'needs_attention').error.code, 'budget_limit');
});

test('budget reservations block concurrent overspend and ledger preserves estimates', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxUsd: 0.1 }));
  await setBudget(root, { limitUsd: 0.1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reserve(0.08);
    await assert.rejects(ctx.reserve(0.03), error => error.code === 'budget_limit');
    await ctx.settle(0.04);
    return { text: 'Hecho' };
  } });
  const state = await loadState(root);
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0.04);
  assert.equal(state.jobs[0].estimatedUsd, 0.04);
});

test('simultaneous reservations cannot bypass the remaining budget', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ maxUsd: 0.1 }));
  await setBudget(root, { limitUsd: 0.06, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  let outcomes;
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    outcomes = await Promise.allSettled([ctx.reserve(0.04), ctx.reserve(0.04)]);
    await ctx.settle(0.04);
    return { text: 'Hecho' };
  } });
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'budget_limit');
  assert.equal((await loadState(root)).budget.estimatedSpentUsd, 0.04);
});

test('worker timeout is bounded, charges the reservation conservatively and closes the old context', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ timeoutMs: 150, maxAttempts: 2 }));
  await setBudget(root, { limitUsd: 0.1, inputPerMillion: 1, outputPerMillion: 2, model: 'example-model' });
  let oldContext;
  let aborted = false;
  const started = Date.now();
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    oldContext = ctx;
    ctx.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    await ctx.reserve(0.08);
    await new Promise(() => {});
  } });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(aborted, true);
  const state = await loadState(root);
  assert.equal(state.jobs[0].state, 'needs_attention');
  assert.equal(state.jobs[0].error.code, 'timeout');
  assert.equal(state.budget.reservedUsd, 0);
  assert.equal(state.budget.estimatedSpentUsd, 0.08);
  assert.equal(state.jobs[0].costUncertain, true);
  await assert.rejects(oldContext.reserve(0.01), error => error.code === 'attempt_closed');
  await assert.rejects(oldContext.settle(0), error => error.code === 'attempt_closed');
  await retryJob(root, 'review-001', { confirm: true });
  await runQueue(root, { execute: true, worker: async () => ({ text: 'Revisado' }) });
  assert.equal((await loadState(root)).jobs[0].attempts, 2);
});

test('a late worker response cannot bypass timeout cleanup or become a success', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ timeoutMs: 30 }));
  let cleaned = false;
  await runQueue(root, { execute: true, worker: (_job, ctx) => {
    ctx.registerCleanup(async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      cleaned = true;
    });
    return new Promise(resolve => {
      ctx.signal.addEventListener('abort', () => resolve({ text: 'Late result after the deadline' }), { once: true });
    });
  } });
  assert.equal(cleaned, true);
  const job = (await loadState(root)).jobs[0];
  assert.equal(job.state, 'needs_attention');
  assert.equal(job.error.code, 'timeout');
});

test('manual retry preserves an interrupted stage checkpoint and its dispatch', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_dev01', summary: 'Code ready' });
    await ctx.reportStage({ key: 'reviewer', status: 'blocked', runId: 'run_abcdef', dispatchId: 'ctx_rev01', dispatchStatus: 'active', error: 'interrupted' });
    throw Object.assign(new Error('runner stopped'), { code: 'interrupted', uncertain: true });
  } });
  const before = (await loadState(root)).jobs[0];
  assert.equal(before.state, 'needs_attention');
  const resumed = await retryJob(root, before.id, { confirm: true });
  assert.equal(resumed.state, 'queued');
  assert.equal(resumed.workflow.runId, 'run_abcdef');
  assert.equal(resumed.workflow.steps[0].status, 'succeeded');
  assert.equal(resumed.workflow.steps[1].status, 'succeeded');
  assert.equal(resumed.workflow.steps[3].dispatchId, 'ctx_rev01');
  assert.equal(resumed.workflow.steps[3].dispatchStatus, 'active');
  assert.equal(resumed.workflowHistory.length, 1);
});

test('manual retry restarts only the confirmed failed stage and preserves completed work', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_dev01', summary: 'Code ready' });
    await ctx.reportStage({ key: 'qa', status: 'failed', runId: 'run_abcdef', dispatchId: 'ctx_qa001', dispatchStatus: 'failed', summary: 'QA worker failed' });
    throw Object.assign(new Error('known worker failure'), { code: 'orca_worker_failed', uncertain: true });
  } });
  const failed = (await loadState(root)).jobs[0];
  const retry = await retryJob(root, failed.id, { confirm: true });
  assert.equal(retry.workflow.steps[0].status, 'succeeded');
  assert.equal(retry.workflow.steps[1].status, 'succeeded');
  assert.equal(retry.workflow.steps[2].status, 'queued');
  assert.equal(retry.workflow.steps[2].dispatchId, undefined);
  assert.equal(retry.workflow.steps[3].status, 'queued');
  assert.equal(retry.workflowHistory.length, 1);
});

test('manual retry refuses to relaunch an interrupted stage without a confirmed dispatch', async t => {
  const root = await fixture(t);
  await addJob(root, spec({ kind: 'code', provider: 'orca', workspace: path.join(root, 'workspaces', 'game'), isolated: true }));
  await runQueue(root, { execute: true, worker: async (_job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', runId: 'run_abcdef', dispatchId: 'ctx_ux001', summary: 'UX ready' });
    await ctx.reportStage({ key: 'developer', status: 'blocked', runId: 'run_abcdef', dispatchStatus: 'unknown', error: 'interrupted' });
    throw Object.assign(new Error('launch outcome unknown'), { code: 'interrupted', uncertain: true });
  } });
  const failed = (await loadState(root)).jobs[0];
  await assert.rejects(retryJob(root, failed.id, { confirm: true }), error => error.code === 'dispatch_unknown');
  const unchanged = (await loadState(root)).jobs[0];
  assert.equal(unchanged.state, 'needs_attention');
  assert.equal(unchanged.attempts, 1);
  assert.equal(unchanged.workflow.steps[1].dispatchId, undefined);
});
