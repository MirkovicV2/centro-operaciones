import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addJob, loadState } from '../../queue.mjs';
import { authorizeWorkerHandoff, recoverSettledUxHandoff, workerHandoffContext, verifyWorkerQuestion, deliverWorkerDecisions, questionsForEscalation } from '../worker-decisions.mjs';
import { notifyCoordinatorRequest } from '../coordinator-bridge.mjs';
import { syncQualityHandoffs } from '../quality-handoff.mjs';
import { captureJobQuestions, changeDashboardState, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';

const coordination = { requestId: 'coord-request-fixture', business: 'games', projectId: 'project-game', runId: 'run_owned123', senderId: 'terminal_owner123' };
const origin = { jobId: 'live-job', runId: coordination.runId, taskId: 'task_worker123', dispatchId: 'ctx_worker123', messageId: 'msg_question123' };
async function fixture(t, { recorded = true, business = 'games', stage = 'planner' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-decisions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addJob(root, { id: origin.jobId, business, projectId: 'project-game', kind: stage === 'planner' ? 'analysis' : 'code', title: 'Plan', prompt: 'Objetivo: analizar. Criterio: respuesta comprobada.', provider: 'orca', coordination: { ...coordination, business }, ...(stage !== 'planner' ? { workspace: path.join(root, 'workspaces', 'project'), isolated: true } : {}) });
  const state = await loadState(root), job = state.jobs[0];
  Object.assign(job, { state: 'running', attempts: 1, workflow: { ...job.workflow, runId: origin.runId, currentStage: stage, steps: [{ key: stage, runId: origin.runId, taskId: origin.taskId,
    dispatchId: origin.dispatchId, status: 'running', dispatchStatus: 'active', ...(recorded ? { questionMessageId: origin.messageId } : {}) }, ...(stage === 'planner' ? [] : [{ key: 'qa', status: 'queued' }])] } });
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, at: new Date().toISOString(), type: 'fixture_running', patch: { jobs: [job] } }) + '\n');
  const intent = { id: 'continue-decisions-fixture', createdAt: new Date().toISOString(), originalPrompt: job.prompt,
    continuation: { decisions: [{ questionId: 'target', question: 'Destino?', answer: 'El checkout confirmado.' }] } };
  return { root, job, intent };
}
function simulator({ workerPatch = {}, messagePatch = {}, replies = [] } = {}) {
  const calls = [];
  const worker = { dispatchId: origin.dispatchId, taskId: origin.taskId, runId: origin.runId, state: 'running', liveness: 'live', terminal: 'term_worker123', ...workerPatch };
  const message = { id: origin.messageId, type: 'ask', run_id: origin.runId, to_handle: `run:${origin.runId}`, from_handle: worker.terminal,
    payload: { dispatchId: origin.dispatchId, taskId: origin.taskId }, body: 'Destino?', ...messagePatch };
  return { calls, worker, message, command: async args => {
    calls.push(args);
    if (args[1] === 'worker-show') return worker;
    if (args[1] === 'inbox') return { messages: args.includes(`dispatch:${origin.dispatchId}`) ? replies : [message] };
    assert.fail('Unexpected command ' + args.slice(0, 2).join(' '));
  } };
}

for (const business of ['games', 'agency']) test(`the ${business} coordinator authorizes a scoped clarification exactly once`, async t => {
  const { root, job } = await fixture(t, { business, stage: 'developer' });
  const request = { id: coordination.requestId, jobId: job.id, status: 'routed', business, projectId: job.projectId,
    notification: { status: 'sent', runId: origin.runId, senderId: coordination.senderId } };
  await changeDashboardState(root, state => state.coordinatorRequests.push(request));
  const body = { origin: { ...origin, senderId: coordination.senderId }, toStage: 'qa', note: 'Reproduce con la misma referencia.' };
  const messagePatch = { payload: { dispatchId: origin.dispatchId, taskId: origin.taskId, question: 'Destino?' } };
  const reply = { id: 'msg_approval123', type: 'status', thread_id: origin.messageId, run_id: origin.runId,
    from_handle: `run:${origin.runId}`, to_handle: `dispatch:${origin.dispatchId}`, body: `[CENTRO_TRASPASO:qa]\n${body.note}` };
  const fake = simulator({ messagePatch, replies: [reply] });
  const options = { command: fake.command, verifyOwner: async () => ({ ok: true }) };
  await assert.rejects(authorizeWorkerHandoff(root, request.id, { ...body, origin: { ...body.origin, senderId: 'term_foreign123' } }, options), /Solo el coordinador/);
  await assert.rejects(authorizeWorkerHandoff(root, request.id, { ...body, toStage: 'integration' }, options), /etapa destinataria/);
  await assert.rejects(authorizeWorkerHandoff(root, request.id, body, { ...options, command: simulator({ messagePatch, replies: [{ ...reply, body: '[CENTRO_TRASPASO:reviewer]\nOtra etapa.' }] }).command }), /Falta la respuesta/);
  const [first, second] = await Promise.all([authorizeWorkerHandoff(root, request.id, body, options), authorizeWorkerHandoff(root, request.id, body, options)]);
  assert.deepEqual(first, second);
  assert.equal(first.approvalMessageId, reply.id);
  await assert.rejects(authorizeWorkerHandoff(root, request.id, { ...body, note: 'Otra aclaración.' }, options), /ya fue autorizada/);
  const saved = (await loadDashboardState(root)).coordinatorRequests[0];
  assert.deepEqual(workerHandoffContext(saved, job, 'qa'), [first]);
  assert.deepEqual(workerHandoffContext(saved, job, 'developer'), []);
  assert.deepEqual(workerHandoffContext(saved, { ...job, attempts: 2 }, 'qa'), []);
  assert.deepEqual(workerHandoffContext(saved, { ...job, business: business === 'games' ? 'agency' : 'games' }, 'qa'), []);
  assert.equal(fake.calls.filter(args => args[1] === 'worker-show').length, 1);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('only a live worker and its exact original ask are accepted', async t => {
  const { root } = await fixture(t), fake = simulator();
  const verified = await verifyWorkerQuestion(root, { id: coordination.requestId }, origin, fake.command);
  assert.equal(verified.job.id, origin.jobId); assert.equal(verified.step.questionMessageId, origin.messageId);
  assert.deepEqual(fake.calls.map(args => args[1]), ['worker-show', 'inbox', 'inbox']);
  for (const change of [{ request: { id: 'coord-foreign-request' } }, { origin: { ...origin, dispatchId: 'ctx_foreign123' } }, { origin: { ...origin, runId: 'run_foreign123' } }]) {
    await assert.rejects(verifyWorkerQuestion(root, change.request || { id: coordination.requestId }, change.origin || origin, async () => assert.fail('local identity must fail before CLI')));
  }
});

test('an exact Orca ask can be verified before the stage poll and cannot escalate after reply', async t => {
  const { root } = await fixture(t, { recorded: false });
  const body = '{version:1,questions:[{text:¿Puedo continuar?}]}';
  const messagePatch = { type: 'question', body, from_handle: `dispatch:${origin.dispatchId}`,
    payload: { taskId: origin.taskId, dispatchId: origin.dispatchId, question: body } };
  const request = { id: coordination.requestId };
  const verified = await verifyWorkerQuestion(root, request, origin, simulator({ messagePatch }).command);
  assert.equal(verified.step.questionTransport, 'damaged');
  assert.equal(verified.step.delivery.questions[0].id, origin.messageId);
  const replies = [{ type: 'status', thread_id: origin.messageId, run_id: origin.runId,
    from_handle: `run:${origin.runId}`, to_handle: `dispatch:${origin.dispatchId}` }];
  await assert.rejects(verifyWorkerQuestion(root, request, origin, simulator({ messagePatch, replies }).command), /ya respondió/);
});

test('native question from its exact dispatch mailbox works without a terminal handle and rejects a foreign dispatch sender', async t => {
  const { root } = await fixture(t);
  const messagePatch = { type: 'question', from_handle: `dispatch:${origin.dispatchId}`,
    payload: JSON.stringify({ taskId: origin.taskId, dispatchId: origin.dispatchId, question: 'Destino?', options: [] }), body: 'Destino?' };
  const native = simulator({ workerPatch: { terminal: undefined }, messagePatch });
  assert.equal((await verifyWorkerQuestion(root, { id: coordination.requestId }, origin, native.command)).job.id, origin.jobId);
  const foreign = simulator({ messagePatch: { ...messagePatch, from_handle: 'dispatch:ctx_foreign123' } });
  await assert.rejects(verifyWorkerQuestion(root, { id: coordination.requestId }, origin, foreign.command));
});

for (const [name, options] of [
  ['wrong worker Task', { workerPatch: { taskId: 'task_foreign123' } }],
  ['closed worker', { workerPatch: { state: 'succeeded', liveness: 'exited' } }],
  ['unknown worker state', { workerPatch: { state: 'unknown' } }],
  ['unverifiable worker liveness', { workerPatch: { liveness: 'unverifiable' } }],
  ['invented worker state', { workerPatch: { state: 'not-a-native-state' } }],
  ['wrong sender', { messagePatch: { from_handle: 'term_foreign123' } }],
  ['foreign message dispatch', { messagePatch: { payload: { dispatchId: 'ctx_foreign123', taskId: origin.taskId } } }],
  ['truncated ask', { messagePatch: { truncated: true } }],
  ['ask with clipping warnings', { messagePatch: { warnings: ['truncated'] } }],
]) test(`worker decision forwarding rejects ${name}`, async t => {
  const { root } = await fixture(t), fake = simulator(options);
  await assert.rejects(verifyWorkerQuestion(root, { id: coordination.requestId }, origin, fake.command));
});

test('an older ask from the same worker cannot replace the currently saved question', async t => {
  const { root } = await fixture(t), older = { ...origin, messageId: 'msg_older123' }, fake = simulator({ messagePatch: { id: older.messageId } });
  await assert.rejects(verifyWorkerQuestion(root, { id: coordination.requestId }, older, fake.command));
});

test('decisions preserve exact origin and coordinator with a durable intent before send, and confirmed replay sends nothing', async t => {
  const { root, job, intent } = await fixture(t), fake = simulator();
  let checkpoint, sends = 0;
  const command = async args => {
    if (args[1] === 'run-show') return { run: { id: coordination.runId, coordinator_handle: coordination.senderId } };
    if (args[1] === 'inbox') return { messages: [] };
    assert.equal(args[1], 'send'); assert.ok(checkpoint);
    assert.equal(args[args.indexOf('--from') + 1], coordination.senderId);
    assert.equal(args[args.indexOf('--to') + 1], `run:${coordination.runId}`);
    const body = args[args.indexOf('--body') + 1];
    assert.ok(body.includes(JSON.stringify(origin))); assert.ok(body.includes('El checkout confirmado.'));
    assert.match(body, /reply --id msg_question123/);
    sends++; return { messageId: 'msg_decisions123' };
  };
  const notify = (request, options) => notifyCoordinatorRequest(request, { ...options, env: {}, command });
  const result = await deliverWorkerDecisions(root, job, intent, { command: fake.command, notify, beforeSend: async target => { checkpoint = { ...target, status: 'sending' }; } });
  assert.equal(result.status, 'sent'); assert.equal(sends, 1);
  const replay = await deliverWorkerDecisions(root, job, { ...intent, notification: result }, { command: async () => assert.fail('confirmed response must not re-query or resend'), notify: async () => assert.fail('cannot resend') });
  assert.equal(replay.messageId, result.messageId); assert.equal(sends, 1);
  const recovered = await deliverWorkerDecisions(root, job, { ...intent, notification: checkpoint }, { command: fake.command, notify });
  assert.equal(recovered.status, 'unknown'); assert.equal(sends, 1, 'missing receipt is not permission to duplicate');
});

test('failed decision checkpoint cannot produce an external send', async t => {
  const { root, job, intent } = await fixture(t), fake = simulator(); let sends = 0;
  const notify = (request, options) => notifyCoordinatorRequest(request, { ...options, env: {}, command: async args => {
    if (args[1] === 'run-show') return { run: { id: coordination.runId, coordinator_handle: coordination.senderId } };
    if (args[1] === 'inbox') return { messages: [] };
    sends++; return { messageId: 'msg_unexpected123' };
  } });
  await assert.rejects(deliverWorkerDecisions(root, job, intent, { command: fake.command, notify, beforeSend: async () => { throw new Error('checkpoint failed'); } }), /checkpoint failed/);
  assert.equal(sends, 0);
});

const humanQuestions = [
  { id: 'scope', decisionKey: 'scope', text: 'Qué alcance autorizas?', required: true },
  { id: 'priority', decisionKey: 'priority', text: 'Qué prioridad prefieres?', required: false },
];

test('human escalation retains exact worker IDs, original wording and required flags in the same job/dispatch round', () => {
  const job = { id: origin.jobId }, step = { dispatchId: origin.dispatchId, delivery: { questions: humanQuestions } };
  const proposed = [{ id: 'priority', text: 'Texto distinto', required: true }, { id: 'scope', text: 'Reescritura', required: false }];
  assert.deepEqual(questionsForEscalation(job, step, proposed), humanQuestions.map(question => ({ ...question, _roundId: `${origin.jobId}:${origin.dispatchId}` })));
  assert.equal(humanQuestions.some(question => Object.hasOwn(question, '_roundId')), false, 'escalation must not mutate original worker evidence');
});

test('human escalation rejects foreign, repeated or missing worker question identifiers', () => {
  const job = { id: origin.jobId }, step = { dispatchId: origin.dispatchId, delivery: { questions: humanQuestions } };
  for (const proposed of [
    [{ id: 'scope' }, { id: 'foreign' }], [{ id: 'scope' }, { id: 'scope' }], [{ id: 'scope' }], [], null,
  ]) assert.throws(() => questionsForEscalation(job, step, proposed), /identificadores y la ronda/);
  assert.throws(() => questionsForEscalation(job, { dispatchId: origin.dispatchId }, humanQuestions), /identificadores y la ronda/);
});

test('capturing escalated questions twice and after needs_input settlement preserves one question set for the same job', async t => {
  const { root, job } = await fixture(t), step = job.workflow.steps[0];
  step.attempt = step.taskInputAttempt = job.attempts;
  step.delivery = { version: 1, jobId: job.id, jobAttempt: job.attempts, stage: step.key, runId: origin.runId,
    taskId: origin.taskId, dispatchId: origin.dispatchId, outcome: 'needs_input', scope: 'partial', summary: 'Faltan decisiones humanas.',
    approval: 'not_applicable', questions: humanQuestions, acceptance: [], evidence: [], decisions: [] };
  const selected = questionsForEscalation(job, step, humanQuestions);
  const first = await captureJobQuestions(root, job, selected);
  assert.equal(first.length, 2);
  assert.deepEqual(await captureJobQuestions(root, job, selected), []);
  const settled = structuredClone(job); settled.state = 'needs_attention';
  settled.workflow.steps[0].dispatchSettled = true; settled.workflow.steps[0].dispatchStatus = 'completed';
  assert.deepEqual(await captureJobQuestions(root, settled), [], 'settled worker capture must reuse the original escalation round');
  const saved = (await loadDashboardState(root)).questions;
  assert.deepEqual(saved.map(question => question.id), first.map(question => question.id));
  assert.ok(saved.every(question => question.jobId === job.id && question.rootJobId === job.id && question.roundId === `${job.id}:${origin.dispatchId}`));
  assert.deepEqual(saved.map(question => question.decisionKey), humanQuestions.map(question => question.decisionKey));
  assert.equal((await loadState(root)).jobs.length, 1, 'capture must not create a new job');
});

test('sync recovers a missing UX handoff from the exact settled ask and native authorization', async t => {
  const { root, job } = await fixture(t, { recorded: false, stage: 'developer' });
  const receipt = { id: 'receipt-ux-return', jobId: job.id, eligible: true, status: 'needs_attention' };
  const question = { id: 'review-i2', decisionKey: 'UX-I2-return', text: 'Evaluar la medición física.', required: true };
  const delivery = { version: 1, jobId: job.id, jobAttempt: 1, stage: 'developer', runId: origin.runId,
    taskId: origin.taskId, dispatchId: origin.dispatchId, outcome: 'blocked', scope: 'partial', approval: 'blocked',
    summary: 'Medición completada. Falta dictamen de Diseño.', acceptance: [], evidence: [], decisions: [], questions: [question] };
  Object.assign(job, { state: 'needs_attention', error: { code: 'delivery_incomplete' }, autoIntent: { eligible: true, receiptId: receipt.id } });
  job.workflow.steps = [
    { key: 'ux', status: 'succeeded', artifact: { path: 'previous-ux.json' } },
    { ...job.workflow.steps[0], status: 'blocked', dispatchStatus: 'failed', dispatchSettled: true, delivery, artifact: { path: 'developer.json' } },
    ...['qa', 'reviewer', 'integration'].map(key => ({ key, status: 'queued' })),
  ];
  const state = await loadState(root);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [job] } }) + '\n');
  const request = { id: coordination.requestId, jobId: job.id, status: 'routed', business: 'games', projectId: job.projectId,
    notification: { status: 'sent', runId: origin.runId, senderId: coordination.senderId } };
  await changeDashboardState(root, state => state.coordinatorRequests.push(request));
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, businesses: { games: true }, receipts: [receipt], history: [] }));
  const note = 'Revisar la pasada técnica sin dar por validada la parte humana.';
  const reply = { id: 'msg_approval123', type: 'status', thread_id: origin.messageId, run_id: origin.runId,
    from_handle: 'run:' + origin.runId, to_handle: 'dispatch:' + origin.dispatchId, body: '[CENTRO_TRASPASO:ux]\r\n' + note };
  const opts = (replies, changes = {}) => ({
    command: simulator({ replies, messagePatch: { body: JSON.stringify({ ...delivery, outcome: 'needs_input' }), ...changes },
      workerPatch: { state: 'failed', liveness: 'exited' } }).command,
    verifyOwner: async () => ({ ok: true }),
  });
  await assert.rejects(recoverSettledUxHandoff(root, job, opts([{ ...reply, thread_id: 'msg_unrelated123' }])), /Falta la respuesta/);
  await assert.rejects(recoverSettledUxHandoff(root, job, opts([reply], {
    body: JSON.stringify({ ...delivery, outcome: 'needs_input', questions: [{ ...question, id: 'other-ask' }] }),
  })), /no coincide/);
  assert.equal((await loadDashboardState(root)).coordinatorRequests[0].workerHandoffs, undefined);
  let handedOff;
  await syncQualityHandoffs(root, {
    recoverUx: (dir, candidate) => recoverSettledUxHandoff(dir, candidate, opts([reply])),
    resume: async (_root, id, { uxHandoff }) => { assert.equal(id, job.id); handedOff = uxHandoff; },
  });
  assert.equal(handedOff.approvalMessageId, reply.id);
  assert.equal(handedOff.messageId, origin.messageId);
  assert.equal(handedOff.note, note);
  assert.deepEqual(await recoverSettledUxHandoff(root, job, opts([reply])), handedOff);
  assert.deepEqual((await loadDashboardState(root)).coordinatorRequests[0].workerHandoffs, [handedOff]);
});
