import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, createIdea, mutateIdea, changeDashboardState, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator } from '../agency-assistant/coordinator-inbox.mjs';
import { sendIdeaToCoordinator, routeCoordinatorIdea } from '../agency-assistant/idea-workflow.mjs';
import { reportCoordinatorQuestions, answerCoordinatorQuestion, readCoordinatorRequest, withdrawCoordinatorRequest } from '../agency-assistant/coordinator-dialogue.mjs';
import { checkCoordinatorRequestNotice } from '../agency-assistant/coordinator-inbox.mjs';
import { loadState } from '../queue.mjs';
import { readAutoRun } from '../../auto-run.mjs';

const identity = { runId: 'run_fixture001', senderId: 'term_fixture001', coordinatorId: 'games-lead', coordinatorName: 'Coordinador Videojuegos', business: 'games', routeScope: 'business', routeKey: 'games' };
const notified = async () => ({ ...identity, status: 'sent', messageId: 'msg_original001' });
async function fixture(t, { idea = false, project = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-dialogue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const savedProject = project ? await createProject(root, 'Proyecto fixture', 'games') : null;
  if (idea) {
    const savedIdea = await createIdea(root, 'games', 'Preparar propuesta del juego', savedProject?.id || '', 'idea-dialogue-001', { focus: 'mixed' });
    const submitted = await sendIdeaToCoordinator(root, savedIdea.id, { notify: notified });
    return { root, project: savedProject, idea: savedIdea, request: submitted.request };
  }
  const submitted = await submitTaskToCoordinator(root, { operationId: 'dialogue-operation-001', business: 'games', projectId: savedProject?.id || '', kind: 'analysis', title: 'Propuesta', prompt: 'Preparar propuesta del juego sin editar archivos', successCriteria: 'Entregar criterios verificables y decisiones' }, { notify: notified });
  return { root, project: savedProject, request: submitted.request };
}
const questions = [{ id: 'platform', text: '¿Qué plataforma se prioriza?', required: true }, { id: 'scope', text: '¿Qué alcance se necesita?', required: true }, { id: 'style', text: '¿Alguna preferencia de estilo?', required: false }];
const oneQuestion = [{ id: 'platform', text: '¿Qué plataforma se prioriza?', required: true }];

test('a grouped round sends all answers once, preserves original input and creates no job', async t => {
  const { root, request } = await fixture(t);
  const original = JSON.stringify(request.snapshot);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions });
  assert.equal(reported.questions.length, 3);
  assert.ok(reported.questions.every(question => !Object.hasOwn(question, 'jobId')));
  let calls = 0;
  const notify = async (notice, { beforeSend }) => {
    calls++;
    assert.equal(notice.id, `${request.id}-answers-brief-1`);
    assert.equal(notice.parentRequestId, request.id);
    assert.equal(notice.notification.runId, identity.runId);
    assert.equal(notice.notification.senderId, identity.senderId);
    assert.equal(notice.notification.coordinatorId, identity.coordinatorId);
    assert.equal(notice.snapshot.text, request.snapshot.text);
    assert.equal(notice.snapshot.decisions.length, 3);
    await beforeSend(identity);
    const checkpoint = await readCoordinatorRequest(root, request.id);
    assert.equal(checkpoint.answerNotices[0].notification.status, 'sending');
    return { ...identity, status: 'sent', messageId: 'msg_answers001' };
  };
  await answerCoordinatorQuestion(root, reported.questions[2].id, 'Minimalista', { notify });
  await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify });
  assert.equal(calls, 0);
  const [first, replay] = await Promise.all([
    answerCoordinatorQuestion(root, reported.questions[1].id, 'Una demo', { notify }),
    answerCoordinatorQuestion(root, reported.questions[1].id, 'Una demo', { notify }),
  ]);
  assert.equal(first.answerDeliveryStatus, 'sent'); assert.equal(replay.answerDeliveryStatus, 'sent'); assert.equal(calls, 1);
  const saved = await readCoordinatorRequest(root, request.id);
  assert.equal(JSON.stringify(saved.snapshot), original);
  assert.equal(saved.answerNotices.length, 1); assert.equal(saved.decisions.length, 3);
  assert.equal((await loadState(root)).jobs.length, 0); assert.equal((await readAutoRun(root)).receipts.length, 0);
});

test('question rounds are immutable, idempotent and cannot replace unresolved questions', async t => {
  const { root, request } = await fixture(t);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions });
  const replay = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions });
  assert.deepEqual(replay.questions, reported.questions);
  await assert.rejects(reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions: oneQuestion }), /otras preguntas/);
  await assert.rejects(reportCoordinatorQuestions(root, request.id, { roundId: 'brief-2', questions: oneQuestion }), /imprescindibles/);
  await assert.rejects(reportCoordinatorQuestions(root, request.id, { roundId: '../unsafe', questions }), /identificador/);
  await assert.rejects(routeTaskFromCoordinator(root, request.id, 'analysis'), /imprescindibles/);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('an interrupted answer notice keeps its original identity and reconciles the same notice', async t => {
  const { root, request } = await fixture(t);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions: oneQuestion });
  const first = await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify: async (_notice, { beforeSend }) => {
    await beforeSend(identity);
    throw Object.assign(new Error('Do not expose transport content'), { code: 'orca_command_timeout' });
  } });
  assert.equal(first.answerDeliveryStatus, 'unknown');
  const before = (await readCoordinatorRequest(root, request.id)).answerNotices[0];
  const replay = await checkCoordinatorRequestNotice(root, request.id, { notify: async notice => {
    assert.equal(notice.notification.status, 'unknown');
    assert.equal(notice.id, before.id); assert.deepEqual(notice.snapshot, before.snapshot);
    return { ...identity, status: 'sent', messageId: 'msg_located001', deduplicated: true };
  } });
  assert.equal(replay.answerNotices[0].notification.status, 'sent');
  assert.equal((await readCoordinatorRequest(root, request.id)).answerNotices.length, 1);
  await assert.rejects(answerCoordinatorQuestion(root, reported.questions[0].id, 'iOS', { notify: notified }), /otra respuesta/);
});

test('late optional answers are preserved without changing an already delivered notice', async t => {
  const { root, request } = await fixture(t);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions: [questions[0], questions[2]] });
  await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify: notified });
  const original = (await readCoordinatorRequest(root, request.id)).answerNotices[0];
  const late = await answerCoordinatorQuestion(root, reported.questions[1].id, 'Minimalista', { notify: async () => assert.fail('must not resend an amended payload') });
  assert.equal(late.lateDecision, true); assert.equal(late.answerDeliveryStatus, 'needs_attention');
  const saved = await readCoordinatorRequest(root, request.id);
  assert.deepEqual(saved.answerNotices[0], original); assert.equal(saved.decisions.length, 2);
});

test('answered decisions and verified coordinator identity survive task routing', async t => {
  const { root, request, project } = await fixture(t);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions: oneQuestion });
  await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify: notified });
  await assert.rejects(routeTaskFromCoordinator(root, request.id, 'code'), /checkout|confirmación/);
  const routed = await routeTaskFromCoordinator(root, request.id, 'analysis');
  assert.match(routed.job.prompt, /Android/);
  const receipt = (await readAutoRun(root)).receipts[0];
  assert.deepEqual(receipt.spec.coordination, { requestId: request.id, coordinatorId: identity.coordinatorId, coordinatorName: identity.coordinatorName, runId: identity.runId, senderId: identity.senderId, business: 'games', projectId: project.id });
  assert.equal(routed.request.snapshot.destinationConfirmation, null);
  assert.equal((await routeTaskFromCoordinator(root, request.id, 'analysis')).job.id, routed.job.id);
});

test('idea routing blocks unanswered questions and carries decisions without replacing the idea', async t => {
  const { root, request, idea } = await fixture(t, { idea: true });
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'brief-1', questions: oneQuestion });
  await assert.rejects(routeCoordinatorIdea(root, request.id, 'analysis'), /imprescindibles/);
  await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify: notified });
  const routed = await routeCoordinatorIdea(root, request.id, 'analysis');
  assert.match(routed.job.prompt, /Android/);
  assert.equal((await readAutoRun(root)).receipts[0].spec.coordination.requestId, request.id);
  assert.equal((await loadDashboardState(root)).ideas[0].text, idea.text);
});

test('worker-origin questions after routing preserve exact origin across replay and answer notice', async t => {
  const { root, request } = await fixture(t);
  const routed = await routeTaskFromCoordinator(root, request.id, 'analysis');
  const origin = { jobId: routed.job.id, runId: 'run_jobfixture', taskId: 'task_fixture001', dispatchId: 'ctx_fixture001', messageId: 'msg_askfixture' };
  await assert.rejects(reportCoordinatorQuestions(root, request.id, { roundId: 'worker-1', questions: oneQuestion }), /decisión/);
  const reported = await reportCoordinatorQuestions(root, request.id, { roundId: 'worker-1', questions: oneQuestion, origin });
  await assert.rejects(reportCoordinatorQuestions(root, request.id, { roundId: 'worker-1', questions: oneQuestion, origin: { ...origin, dispatchId: 'ctx_other0001' } }), /otras preguntas/);
  assert.deepEqual(reported.questions[0].origin, origin);
  await answerCoordinatorQuestion(root, reported.questions[0].id, 'Android', { notify: async notice => {
    assert.deepEqual(notice.origin, origin); assert.deepEqual(notice.snapshot.origin, origin);
    assert.equal(notice.notification.runId, identity.runId, 'notify upstream coordinator, preserve worker Run separately');
    return notified();
  } });
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('withdrawing an unassigned idea permits a new revision and prevents delivery or routing of the old one', async t => {
  const { root, request, idea } = await fixture(t, { idea: true, project: false });
  const withdrawn = await withdrawCoordinatorRequest(root, request.id);
  assert.equal(withdrawn.status, 'withdrawn');
  assert.equal((await withdrawCoordinatorRequest(root, request.id)).status, 'withdrawn');
  await checkCoordinatorRequestNotice(root, request.id, { notify: async () => assert.fail('withdrawn request cannot be sent') });
  await assert.rejects(routeCoordinatorIdea(root, request.id, 'analysis'), /retiró/);
  const edited = await mutateIdea(root, idea.id, 'update', { version: 1, title: idea.title, text: idea.text, focus: 'mixed', tags: [], projectId: '' });
  assert.equal(edited.version, 2);
  const next = await sendIdeaToCoordinator(root, idea.id, { notify: notified });
  assert.notEqual(next.request.id, request.id);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('withdrawal refuses uncertain notices and durable routing receipts', async t => {
  const { root, request } = await fixture(t);
  await changeDashboardState(root, state => { state.coordinatorRequests[0].notification.status = 'unknown'; });
  await assert.rejects(withdrawCoordinatorRequest(root, request.id), /incierta/);
  await changeDashboardState(root, state => { state.coordinatorRequests[0].notification.status = 'sent'; });
  await routeTaskFromCoordinator(root, request.id, 'analysis');
  await assert.rejects(withdrawCoordinatorRequest(root, request.id), /ruta/);
});
