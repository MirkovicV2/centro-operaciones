import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProject, loadDashboardState, changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator, checkCoordinatorRequestNotice } from '../agency-assistant/coordinator-inbox.mjs';
import { respondToCoordinatorRequest, reportCoordinatorQuestions, answerCoordinatorQuestion, withdrawCoordinatorRequest } from '../agency-assistant/coordinator-dialogue.mjs';
import { buildRequestTraces, createPreparationObserver, readRequestTrace, readPreparationRecord } from '../request-trace.mjs';
import { loadState } from '../queue.mjs';
import { readAutoRun } from '../../auto-run.mjs';

const native = { status: 'sent', runId: 'run_fixture123', senderId: 'term_fixture123', coordinatorId: 'agency', coordinatorName: 'Coordinador de Agencia', messageId: 'msg_fixture123' };
const input = { operationId: 'consultation-operation-01', intent: 'consultation', business: 'agency', prompt: '¿Qué información tenemos para organizar la agencia?' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-trace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notices = [];
  const notify = async request => { notices.push(request.id); return structuredClone(native); };
  return { root, notices, notify };
}
const answer = { responseId: 'response-v1', text: 'Podemos organizar primero los proyectos y las decisiones pendientes.', runId: native.runId, senderId: native.senderId, sources: [{ id: 'source-record-1', title: 'Contexto de la agencia' }] };

test('a project-free consultation has a durable direct answer and no job or receipt, including replay', async t => {
  const f = await fixture(t);
  const [submitted, duplicate] = await Promise.all([submitTaskToCoordinator(f.root, input, { notify: f.notify }), submitTaskToCoordinator(f.root, input, { notify: f.notify })]);
  assert.equal(submitted.request.id, duplicate.request.id); assert.equal(f.notices.length, 1);
  assert.equal(submitted.request.projectId, null); assert.equal(submitted.request.snapshot.title, input.prompt);
  const snapshot = structuredClone(submitted.request.snapshot);
  await assert.rejects(routeTaskFromCoordinator(f.root, submitted.request.id, 'analysis'), /responden directamente/);
  await assert.rejects(routeTaskFromCoordinator(f.root, submitted.request.id, 'code'), /responden directamente/);
  const [first, repeated] = await Promise.all([respondToCoordinatorRequest(f.root, submitted.request.id, answer), respondToCoordinatorRequest(f.root, submitted.request.id, answer)]);
  assert.equal(first.status, 'answered'); assert.deepEqual(first.response, repeated.response); assert.deepEqual(first.snapshot, snapshot);
  await assert.rejects(respondToCoordinatorRequest(f.root, submitted.request.id, { ...answer, text: 'Otra respuesta distinta.' }), /otra respuesta/);
  const retry = await submitTaskToCoordinator(f.root, input, { notify: f.notify }); assert.equal(retry.request.status, 'answered');
  await checkCoordinatorRequestNotice(f.root, submitted.request.id, { notify: async () => assert.fail('answered must not notify') });
  assert.equal((await loadState(f.root)).jobs.length, 0); assert.equal((await readAutoRun(f.root)).receipts.length, 0);
  const trace = await readRequestTrace(f.root, submitted.request.id);
  assert.equal(trace.status, 'answered'); assert.equal(trace.intent, 'consultation'); assert.equal(trace.response.text, answer.text);
  assert.equal(trace.responsible.runId, native.runId); assert.deepEqual(trace.ids.jobIds, []);
});

test('consultation decisions are grouped and answered terminal rejects questions, replies, withdrawal and routing', async t => {
  const f = await fixture(t), { request } = await submitTaskToCoordinator(f.root, input, { notify: f.notify });
  const asked = await reportCoordinatorQuestions(f.root, request.id, { roundId: 'context-v1', questions: [{ id: 'period', text: '¿Qué periodo quieres revisar?' }, { id: 'optional', text: '¿Quieres aportar otro dato opcional?', required: false }] });
  await assert.rejects(respondToCoordinatorRequest(f.root, request.id, answer), /preguntas imprescindibles/);
  await answerCoordinatorQuestion(f.root, asked.questions[0].id, 'Este trimestre.', { notify: f.notify });
  await respondToCoordinatorRequest(f.root, request.id, answer);
  await assert.rejects(reportCoordinatorQuestions(f.root, request.id, { roundId: 'another', questions: [{ id: 'new', text: '¿Otra decisión posterior?' }] }), /respondida/);
  await assert.rejects(answerCoordinatorQuestion(f.root, asked.questions[0].id, 'Este trimestre.', { notify: f.notify }), /respondida/);
  await assert.rejects(withdrawCoordinatorRequest(f.root, request.id));
  await assert.rejects(routeTaskFromCoordinator(f.root, request.id, 'analysis'), /respondida/);
  const inbox = await loadDashboardState(f.root);
  assert.equal(inbox.coordinatorRequests.length, 1); assert.equal(inbox.questions[0].answer, 'Este trimestre.');
  assert.equal(inbox.questions[1].status, 'withdrawn'); assert.equal(inbox.questions[1].closedByResponseId, answer.responseId);
  assert.equal((await loadState(f.root)).jobs.length, 0);
});

test('consultation scope and author are strict while existing task contracts remain required', async t => {
  const f = await fixture(t), foreign = await createProject(f.root, 'Juego de prueba', 'games');
  await assert.rejects(submitTaskToCoordinator(f.root, { ...input, business: '' }, { notify: f.notify }), /empresa/);
  await assert.rejects(submitTaskToCoordinator(f.root, { ...input, projectId: foreign.id }, { notify: f.notify }), /otra empresa/);
  await assert.rejects(submitTaskToCoordinator(f.root, { ...input, intent: 'task' }, { notify: f.notify }), /título, objetivo/);
  await assert.rejects(submitTaskToCoordinator(f.root, { ...input, kind: 'code' }, { notify: f.notify }), /no confirma código/);
  const { request } = await submitTaskToCoordinator(f.root, input, { notify: f.notify });
  await assert.rejects(respondToCoordinatorRequest(f.root, request.id, { ...answer, runId: 'run_another123' }), /originales/);
  await assert.rejects(respondToCoordinatorRequest(f.root, request.id, { ...answer, sources: [{ url: 'javascript:alert(1)' }] }), /no admitida/);
  await changeDashboardState(f.root, state => { state.coordinatorRequests[0].receiptId = 'receipt-existing'; });
  await assert.rejects(respondToCoordinatorRequest(f.root, request.id, answer), /tiene una ruta/);
});

function traceFixture() {
  const request = { id: 'coord-trace-one', kind: 'idea', ideaId: 'idea-one', ideaVersion: 1, business: 'agency', status: 'routed', jobId: 'job-one', receiptId: 'receipt-one',
    createdAt: '2026-11-08T10:00:00Z', notification: native, snapshot: { title: 'Prueba de petición', text: 'Solicitud original sin proyecto', projectId: null }, route: { kind: 'code', projectId: 'project-one', at: '2026-11-08T10:10:00Z', reason: 'Destino autorizado.' } };
  const stage = { key: 'developer', label: 'Desarrollo', status: 'running', summary: 'Implementando la petición.', runId: native.runId, taskId: 'task_developer02', dispatchId: 'ctx_developer02', attempt: 2, taskInputAttempt: 1, updatedAt: '2026-11-08T10:20:00Z' };
  const job = { id: 'job-one', business: 'agency', projectId: 'project-one', projectName: 'Proyecto de prueba', title: 'Prueba de petición', state: 'running', attempts: 2, createdAt: '2026-11-08T10:11:00Z', branch: 'feature', destination: { repository: 'fixture/repo', baseBranch: 'main' },
    autoIntent: { eligible: true, receiptId: 'receipt-one' }, coordination: { requestId: request.id, runId: native.runId, senderId: native.senderId },
    workflow: { currentStage: 'developer', steps: [stage] }, workflowHistory: [{ attempt: 1, steps: [{ ...stage, status: 'blocked', dispatchId: 'ctx_developer01', updatedAt: '2026-11-08T10:15:00Z' }] }],
    attemptHistory: [{ attempt: 1, outcome: 'needs_attention', finishedAt: '2026-11-08T10:15:00Z' }] };
  const preparation = { schemaVersion: 1, requestId: request.id, business: 'agency', runId: native.runId, senderId: native.senderId, phase: 'verified', status: 'prepared', createdAt: '2026-11-08T10:01:00Z', taskId: 'task_preparation01', dispatchId: 'ctx_preparation01',
    operations: [{ operation: 'github_create', phase: 'receipt', at: '2026-11-08T10:02:00Z' }], checkpoints: [{ taskId: 'task_preparation02', dispatchId: 'ctx_preparation02', followUpOf: 'ctx_preparation01', phase: 'completed', at: '2026-11-08T10:03:00Z' }] };
  const automation = { businesses: { agency: true }, receipts: [{ id: 'receipt-one', jobId: job.id, business: 'agency', eligible: true, status: 'claimed', dispatchRecovery: { id: 'recovery-one', phase: 'ready', stage: 'developer', attempt: 1, taskId: 'task_developer01', dispatchId: 'ctx_developer01', updatedAt: '2026-11-08T10:16:00Z' } }], integrations: {}, history: [{ type: 'known_dispatch_recovery_ready', receiptId: 'receipt-one', jobId: job.id, at: '2026-11-08T10:16:00Z' }] };
  return { request, job, preparation, automation };
}

test('an exact Orca interruption blocks preparation even while its terminal remains open', async () => {
  const { request, preparation } = traceFixture();
  Object.assign(request, { status: 'pending', jobId: null, receiptId: null, route: null });
  Object.assign(preparation, { phase: 'start_intent', status: 'running', dispatchedAtUtc: '2026-11-08T10:01:00Z', operations: [], checkpoints: [] });
  const timestamp = Date.parse('2026-11-08T10:02:00Z');
  const projection = { runId: preparation.runId, taskId: preparation.taskId, dispatchId: preparation.dispatchId, stage: { activity: 'done' }, outcome: 'in_progress' };
  const output = { source: 'transcript', sourceExact: true, dispatchId: preparation.dispatchId, projection,
    status: { worker: 'ready', terminal: 'running', liveness: 'live' },
    transcript: { messages: [{ role: 'system', timestamp, blocks: [{ type: 'text', text: 'Conversation interrupted' }] }] } };
  let calls = 0;
  const observePreparation = createPreparationObserver(async args => {
    assert.equal(args[3], preparation.dispatchId);
    calls++;
    return output;
  });
  const get = async observer => (await buildRequestTraces('.', { requests: [request], preparations: [preparation], observePreparation: observer }))[0];
  const trace = await get(observePreparation);
  assert.equal(trace.status, 'blocked');
  assert.equal(trace.currentStage, 'preparation');
  assert.match(trace.nextAction, /se interrumpió/);
  assert.ok(trace.events.some(event => event.label === 'Preparación interrumpida' && event.at === new Date(timestamp).toISOString()));
  await get(observePreparation);
  assert.equal(calls, 1);
  for (const altered of [
    { ...output, sourceExact: false },
    { ...output, projection: { ...projection, taskId: 'task_foreign' } },
    { ...output, projection: { ...projection, stage: { activity: 'working' } } },
    { ...output, transcript: { messages: [...output.transcript.messages, { role: 'assistant', blocks: [] }] } },
  ]) {
    assert.equal((await get(createPreparationObserver(async () => altered))).status, 'preparing');
  }
  assert.equal(preparation.phase, 'start_intent');
});

test('one trace joins preparation follow-up, decisions, history and exact jobs without mixing a shared Run', async () => {
  const { request, job, preparation, automation } = traceFixture();
  const other = { ...job, id: 'job-unrelated', coordination: { ...job.coordination, requestId: 'coord-trace-other' } };
  const foreign = { ...job, id: 'job-foreign', business: 'games' };
  const knowledge = [
    { id: 'context-one', requestId: request.id, business: 'agency', createdAt: '2026-11-08T10:05:00Z', actor: { runId: native.runId, senderId: native.senderId }, sources: [{ id: 'source-one', delivered: true }] },
    { id: 'context-other', requestId: 'coord-trace-other', business: 'agency', actor: { runId: native.runId }, sources: [] },
    { id: 'context-foreign', requestId: request.id, business: 'games', sources: [] },
  ];
  const before = structuredClone({ request, job, preparation, automation });
  const [trace] = await buildRequestTraces('.', { requests: [request], jobs: [job, other, foreign], preparations: [preparation], automation, knowledge, questions: [{ id: 'question-one', business: 'agency', coordinatorRequestId: request.id, status: 'answered', question: '¿Destino autorizado?', answer: 'Sí, proyecto nuevo.', createdAt: '2026-11-08T10:04:00Z', answeredAt: '2026-11-08T10:05:00Z' }] });
  assert.deepEqual(trace.ids.jobIds, ['job-one']); assert.equal(trace.status, 'running'); assert.equal(trace.projectId, 'project-one');
  assert.ok(trace.events.some(event => event.ids?.followUpOf === 'ctx_preparation01'));
  assert.ok(trace.events.some(event => event.ids?.dispatchId === 'ctx_developer01'));
  assert.ok(trace.events.some(event => event.ids?.dispatchId === 'ctx_developer02'));
  assert.ok(trace.events.some(event => event.kind === 'decision' && event.summary.includes('proyecto nuevo')));
  assert.deepEqual(trace.knowledge.map(item => item.id), ['context-one']);
  assert.deepEqual({ request, job, preparation, automation }, before);
});

test('knowledge citations are projected only from exact delivered source IDs without modifying evidence', async () => {
  const { request } = traceFixture(); request.status = 'answered'; request.intent = 'consultation'; request.response = { ...answer, sources: [{ id: 'delivered-source' }, { id: 'other-source', title: 'Referencia externa declarada' }] };
  const knowledge = [{ id: 'context-citations', business: 'agency', requestId: request.id, citedSourceIds: [], sources: [{ id: 'delivered-source', delivered: true }, { id: 'other-source', delivered: false }] }];
  const before = structuredClone(knowledge);
  const [trace] = await buildRequestTraces('.', { requests: [request], preparations: [], knowledge });
  assert.deepEqual(trace.knowledge[0].citedSourceIds, ['delivered-source']);
  assert.equal(trace.response.sources[0].citationVerified, true);
  assert.equal(trace.response.sources[1].citationVerified, false); assert.equal(trace.response.sources[1].label, 'Referencia declarada');
  assert.deepEqual(knowledge, before); assert.equal(request.response.sources[0].citationVerified, undefined);
});

test('local success is never publication without the matching completed integration receipt', async () => {
  const { request, job, automation } = traceFixture(); job.state = 'succeeded'; job.workflow.currentStage = null; automation.receipts[0].status = 'completed';
  const get = async () => (await buildRequestTraces('.', { requests: [request], jobs: [job], automation, preparations: [] }))[0];
  assert.equal((await get()).status, 'delivered');
  automation.integrations['receipt-one'] = { jobId: job.id, receiptId: 'receipt-one', repository: 'fixture/repo', sourceBranch: 'feature', baseBranch: 'main', phase: 'checks_pending', status: 'checks_pending' };
  assert.equal((await get()).status, 'delivered');
  Object.assign(automation.integrations['receipt-one'], { phase: 'complete', status: 'completed', commitSha: 'c'.repeat(40), mergeSha: 'd'.repeat(40) });
  assert.equal((await get()).status, 'published');
  automation.integrations['receipt-one'].jobId = 'different-job';
  assert.equal((await get()).status, 'delivered');
});

test('preparation reads are size-bounded, isolated, and identity checked without failing the whole projection', async t => {
  const { root } = await fixture(t), { request, preparation } = traceFixture();
  request.status = 'pending'; delete request.jobId; delete request.receiptId;
  const directory = path.join(root, 'data', 'coordinators', 'preparation'); await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, request.id + '.json');
  await fs.writeFile(filename, Buffer.alloc(512 * 1024 + 1, 32));
  assert.match((await readPreparationRecord(root, request.id)).reason, /512 KB/);
  let [trace] = await buildRequestTraces(root, { requests: [request] });
  assert.equal(trace.status, 'unavailable');
  assert.equal((await readPreparationRecord(root, '../outside-file')).available, false);
  await fs.writeFile(filename, '{unfinished');
  assert.equal((await readPreparationRecord(root, request.id)).available, false);
  await fs.writeFile(filename, JSON.stringify({ ...preparation, senderId: 'term_other-owner' }));
  [trace] = await buildRequestTraces(root, { requests: [request] }); assert.equal(trace.status, 'unavailable');
  await fs.writeFile(filename, JSON.stringify(preparation));
  [trace] = await buildRequestTraces(root, { requests: [request] }); assert.equal(trace.status, 'preparing');
});

test('a receipt waiting for materialization remains visible on the same request', async () => {
  const { request, automation } = traceFixture();
  automation.receipts[0].status = 'pending'; automation.receipts[0].spec = { coordination: { requestId: request.id } };
  const [trace] = await buildRequestTraces('.', { requests: [request], jobs: [], automation, preparations: [] });
  assert.equal(trace.status, 'queued'); assert.equal(trace.currentStage, 'queue');
  assert.deepEqual(trace.ids.receiptIds, ['receipt-one']); assert.deepEqual(trace.ids.jobIds, []);
});

test('queued preparation is administratively complete only with exact product receipt and verified destination', async () => {
  const { request, job, preparation, automation } = traceFixture();
  job.workspace = path.resolve('workspaces', 'fixture');
  Object.assign(job.destination, { checkout: 'workspaces/fixture', workspace: job.workspace, sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) });
  Object.assign(preparation, { phase: 'job_queued', status: 'queued', productJobId: job.id, productReceiptId: 'receipt-one', verifiedAt: '2026-11-08T10:09:00Z', checkoutAbsolute: job.workspace, independentGitDirectory: true,
    routeIntent: { requestId: request.id, business: request.business, projectId: job.projectId, repository: 'Fixture/Repo', checkout: 'workspaces/fixture', branch: job.branch, baseBranch: 'main', gitClean: true, headSha: 'a'.repeat(40), remoteWorkSha: 'a'.repeat(40), remoteMainSha: 'b'.repeat(40) },
    normalizationTaskId: 'task_normalized01', normalizationDispatchId: 'ctx_normalized01', normalizedAt: '2026-11-08T10:08:00Z', operationSummary: ['github_create:receipt@2026-11-08T10:02:00Z'] });
  delete preparation.operations;
  const get = async () => (await buildRequestTraces('.', { requests: [request], jobs: [job], automation, preparations: [preparation] }))[0];
  const trace = await get(), step = trace.steps.find(item => item.key === 'preparation');
  assert.equal(step.status, 'succeeded'); assert.match(step.summary, /no acredita.*cierre físico/);
  assert.ok(trace.events.some(event => event.ids?.dispatchId === 'ctx_normalized01'));
  assert.ok(trace.events.some(event => event.label === 'Crear repositorio · confirmada'));
  preparation.routeIntent.remoteMainSha = 'f'.repeat(40);
  assert.equal((await get()).steps.find(item => item.key === 'preparation').status, 'skipped');
  preparation.routeIntent.remoteMainSha = 'b'.repeat(40); preparation.productReceiptId = 'receipt-other';
  assert.equal((await get()).steps.find(item => item.key === 'preparation').status, 'skipped');
});

test('PowerShell BOM and nested route receipt preserve a verified preparation handoff', async t => {
  const { root } = await fixture(t), { request, job, preparation, automation } = traceFixture();
  const workspace = path.join(root, 'workspaces', 'fixture'), headSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
  job.workspace = workspace;
  Object.assign(job.destination, { workspace, checkout: 'workspaces/fixture', sha: headSha, remoteSha: headSha, baseSha });
  const target = { projectId: job.projectId, business: request.business, repository: job.destination.repository,
    checkout: job.destination.checkout, branch: job.branch, baseBranch: job.destination.baseBranch };
  const native = { runId: preparation.runId, taskId: preparation.taskId, dispatchId: preparation.dispatchId };
  Object.assign(preparation, { phase: 'routed', startReceipt: { ok: true, result: native }, routeIntent: { confirmation: target },
    coordinatorVerification: { ...target, verifiedAtUtc: '2026-11-08T10:09:00Z', independentGitDirectory: true, cleanGitStatus: true, localSha: headSha,
      remoteRefs: [headSha + '\trefs/heads/' + job.branch, baseSha + '\trefs/heads/main'] },
    preparation: { result: { ...target, ...native, requestId: request.id, senderId: preparation.senderId,
      absoluteCheckout: workspace, relativeCheckout: target.checkout, independentGitDirectory: true, cleanGitStatus: true,
      localBranchSha: headSha, remoteBranchSha: headSha, remoteMainSha: baseSha } },
    routeReceipt: { request, job, receipt: automation.receipts[0] } });
  const folder = path.join(root, 'data', 'coordinators', 'preparation');
  await fs.mkdir(folder, { recursive: true });
  const file = path.join(folder, request.id + '.json');
  const get = async () => {
    await fs.writeFile(file, '\uFEFF' + JSON.stringify(preparation));
    return (await buildRequestTraces(root, { requests: [request], jobs: [job], automation }))[0];
  };
  assert.equal((await get()).steps.find(s => s.key === 'preparation').status, 'succeeded');
  preparation.preparation.result.remoteMainSha = 'c'.repeat(40);
  assert.equal((await get()).steps.find(s => s.key === 'preparation').status, 'blocked');
});

test('same-attempt recovery segments remain separate without inventing another attempt', async () => {
  const { request, job } = traceFixture();
  job.attemptHistory = [
    { attempt: 2, outcome: 'needs_attention', error: 'orca_liveness_unconfirmed', finishedAt: '2026-11-08T10:20:00Z' },
    { attempt: 2, outcome: 'needs_attention', error: 'worker_error', recoveryId: 'recovery-first', finishedAt: '2026-11-08T10:21:00Z' },
    { attempt: 2, outcome: 'succeeded', recoveryId: 'recovery-second', finishedAt: '2026-11-08T10:22:00Z' },
  ];
  const [trace] = await buildRequestTraces('.', { requests: [request], jobs: [job], preparations: [] });
  const segments = trace.events.filter(item => item.id.startsWith(`${job.id}:attempt:`));
  assert.equal(segments.length, 3); assert.equal(new Set(segments.map(item => item.id)).size, 3);
  assert.deepEqual(segments.map(item => item.ids.attempt), [2, 2, 2]);
  assert.deepEqual(segments.map(item => item.summary), ['orca_liveness_unconfirmed', 'worker_error', '']);
  assert.deepEqual(segments.map(item => item.ids.recoveryId), [null, 'recovery-first', 'recovery-second']);
});

test('worker citations require exact delivery actor and input attempt, and match source IDs as whole tokens', async () => {
  const { request, job } = traceFixture(), step = job.workflow.steps[0];
  const actor = { kind: 'worker', jobId: job.id, stage: step.key, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId, jobAttempt: 1, queueAttempt: 2 };
  step.delivery = { jobId: job.id, stage: step.key, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId, jobAttempt: 1,
    evidence: ['Referencia explícita: (source-known). source-undelivered'], summary: 'source-summary-only' };
  const receipt = { id: 'knowledge-worker', jobId: job.id, requestId: request.id, business: job.business, actor, citedSourceIds: [],
    sources: [{ id: 'source-known', delivered: true }, { id: 'source-undelivered', delivered: false }, { id: 'source-summary-only', delivered: true }] };
  const original = structuredClone({ job, receipt });
  const get = async () => (await buildRequestTraces('.', { requests: [request], jobs: [job], knowledge: [receipt], preparations: [] }))[0].knowledge[0]?.citedSourceIds || [];
  assert.deepEqual(await get(), ['source-known']);
  assert.deepEqual({ job, receipt }, original);
  for (const patch of [{ taskId: 'task_foreign123' }, { dispatchId: 'ctx_foreign123' }, { stage: 'qa' }, { jobAttempt: 2 }, { runId: 'run_foreign123' }, { jobId: 'job-other' }]) {
    receipt.actor = { ...actor, ...patch }; assert.deepEqual(await get(), []);
  }
  receipt.actor = actor;
  for (const evidence of ['prefixsource-known', 'source-known-extension', 'source-known_2', 'ñsource-known']) {
    step.delivery.evidence = [evidence]; assert.deepEqual(await get(), []);
  }
  step.delivery.evidence = ['source-known']; step.delivery.taskId = 'task_foreign123'; assert.deepEqual(await get(), []);
  step.delivery.taskId = step.taskId; step.delivery.jobAttempt = 2; assert.deepEqual(await get(), []);
  step.delivery.jobAttempt = 1;
  job.workflowHistory.push(structuredClone(job.workflow)); delete step.delivery;
  assert.deepEqual(await get(), ['source-known'], 'An exact historical delivery retains its declared citation.');
});

test('unconfirmed grouped answer notices remain visible and actionable after the original notice was delivered', async () => {
  const { request } = traceFixture(); request.status = 'pending';
  request.answerNotices = [{ id: `${request.id}-answers-round1`, roundId: 'round1', notification: { status: 'unknown', reason: 'No se confirmó la entrega.', updatedAt: '2026-11-08T10:20:00Z' } }];
  const get = async () => (await buildRequestTraces('.', { requests: [request], preparations: [] }))[0];
  for (const status of ['unknown', 'needs_attention', 'sending']) {
    request.answerNotices[0].notification.status = status;
    const trace = await get(); assert.equal(trace.status, 'blocked'); assert.equal(trace.currentStage, 'decisions');
    assert.match(trace.nextAction, /Consulta la entrega de respuestas/); assert.equal(trace.answerNotices[0].notification.status, status);
    assert.equal(trace.requestId, request.id);
  }
  request.answerNotices[0].notification.status = 'pending'; assert.equal((await get()).status, 'waiting_notice');
  request.answerNotices[0].notification.status = 'sent'; assert.equal((await get()).status, 'waiting_coordinator');
  request.answerNotices[0].notification.status = 'unknown'; request.status = 'answered'; request.response = answer;
  assert.equal((await get()).status, 'answered');
  request.status = 'withdrawn'; assert.equal((await get()).status, 'withdrawn');
});
