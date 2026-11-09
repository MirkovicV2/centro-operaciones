import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { increaseJobAttemptLimit, loadState, qualityCorrection, runQueue, settledQaRevalidation } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { inspectRecoveryDispatch } from '../panel/dispatch-recovery.mjs';
import { runOrca } from '../orca-provider.mjs';
import { prepareIntegrationValidation } from '../integration-validation.mjs';
import { nextQualityAction, syncQualityHandoffs } from '../panel/quality-handoff.mjs';
import { changeDashboardState } from '../panel/agency-assistant/dashboard-state.mjs';

const snapshot = 'a'.repeat(64), runId = 'run_validation001', senderId = 'term_coordinator001';
const errorText = 'El diff actual no coincide con la revisión aprobada.';
const identity = (stage, fresh = false) => ({ runId, taskId: `task_${fresh ? 'new' : 'old'}_${stage}`, dispatchId: `ctx_${fresh ? 'new' : 'old'}_${stage}` });
async function patchJob(root, change) {
  const state = await loadState(root); change(state.jobs[0], state);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: state.jobs, budget: state.budget } }) + '\n');
}
async function patchAuto(root, change) {
  const state = await readAutoRun(root); change(state);
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
}
function delivery(job, stage, fresh = false) {
  return { version: 1, jobId: job.id, jobAttempt: stage === 'ux' ? 1 : 2, stage, ...identity(stage, fresh),
    outcome: 'completed', scope: 'complete', approval: ['qa', 'reviewer'].includes(stage) ? 'approved' : 'not_applicable',
    summary: `${stage} completed.`, acceptance: (job.contract.acceptance.length ? job.contract.acceptance : ['Complete the fixture acceptance.']).map(criterion => ({ criterion, status: 'passed', evidence: 'Fixture verified.' })),
    evidence: ['Fixture evidence.'], questions: [], decisions: [] };
}
async function fixture(t, { qaBlocked = false, finding = 'unverified', findingStage = 'qa' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-validation-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-validation-resume', { id: 'validation-resume-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Validate reviewed files', prompt: 'Complete the fixture acceptance.', contract: { acceptance: ['Complete the fixture acceptance.'] }, workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2, timeoutMs: 10_000,
    coordination: { requestId: 'coord-validation001', runId, senderId, business: 'agency' } });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_status_unknown', ...identity('ux'), attempt: job.attempts, taskInputAttempt: 1 });
    throw new Error('Initial transport failure');
  } }).tick();
  await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...identity('ux'), state: 'succeeded', liveness: 'exited' }) });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    let developerArtifactSha256;
    for (const stage of ['ux', 'developer', 'qa', 'reviewer']) {
      if (stage === 'ux') await ctx.reportStage({ key: stage, status: 'running', ...identity(stage), attempt: 2 });
      const value = delivery(job, stage);
      if (qaBlocked && stage === findingStage) {
        Object.assign(value, { outcome: finding === 'failed' ? 'failed' : 'blocked', approval: 'blocked', summary: 'Validación Android bloqueada.' });
        value.acceptance[0].status = finding;
        const artifact = await saveStageReport(root, { ...value, workerState: 'failed' }, JSON.stringify(value), value);
        await ctx.reportStage({ key: stage, status: 'running', ...identity(stage), attempt: 2 });
        await ctx.reportStage({ key: stage, status: 'blocked', ...identity(stage), attempt: 2, taskInputAttempt: 2, artifact,
          delivery: value, dispatchStatus: 'failed', dispatchSettled: true, resultMessageId: 'msg_qa_blocked' });
        await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, phase: 'validation_pending', status: 'validating',
          validation: { snapshot, attempt: 2, cycleId: 'attempt-2', jobId: job.id, receiptId: job.autoIntent.receiptId, runId, workspace, branch: job.branch,
            developerTaskId: identity('developer').taskId, developerDispatchId: identity('developer').dispatchId, developerArtifactSha256 } });
        throw Object.assign(new Error('Falta un entorno Android.'), { code: 'delivery_incomplete' });
      }
      const artifact = await saveStageReport(root, { ...value, workerState: 'succeeded' }, JSON.stringify(value), value);
      if (stage === 'developer') developerArtifactSha256 = artifact.sha256;
      await ctx.reportStage({ key: stage, status: 'succeeded', ...identity(stage), attempt: 2, taskInputAttempt: value.jobAttempt,
        artifact, delivery: value, approvalOutcome: value.approval, summary: value.summary, dispatchStatus: 'completed', dispatchSettled: true });
    }
    await ctx.reportStage({ key: 'integration', status: 'running' });
    await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, status: 'needs_attention', needsAttention: true, error: errorText });
    await ctx.reportStage({ key: 'integration', status: 'blocked', error: 'integration_needs_attention', summary: errorText });
    throw Object.assign(new Error(errorText), { code: 'github_integration_needs_attention' });
  } }).tick();
  await patchJob(root, (job, state) => { job.attemptHistory = [...job.attemptHistory.filter(item => item.attempt !== 2), { attempt: 2, elapsedMs: 100, error: 'github_integration_needs_attention' }]; job.estimatedUsd = 0.06; state.budget.estimatedSpentUsd = 0.06; });
  const nativeReads = [];
  const command = async args => {
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    assert.equal(args[1], 'worker-show'); const dispatchId = args[args.indexOf('--dispatch') + 1]; nativeReads.push(dispatchId);
    const fresh = qaBlocked && dispatchId === identity('qa', true).dispatchId;
    const stage = ['ux', 'developer', 'qa', 'reviewer'].find(key => identity(key, fresh).dispatchId === dispatchId); assert.ok(stage);
    return { ...identity(stage, fresh), state: qaBlocked && stage === findingStage ? 'failed' : 'succeeded', liveness: 'exited', workspace };
  };
  const inspect = async expected => inspectRecoveryDispatch(root, (await loadState(root)).jobs[0], expected, { command, captureSnapshot: async () => snapshot });
  const recover = options => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: inspect, ...options });
  const before = (await loadState(root)).jobs[0]; assert.equal(before.error.code, qaBlocked ? 'delivery_incomplete' : 'github_integration_needs_attention', JSON.stringify(before.error)); assert.equal(before.attempts, 2);
  return { root, workspace, verify, recover, inspect, command, nativeReads, jobId: sent.job.id, receiptId: sent.receipt.id,
    lockPath: path.join(workspace, '.git', 'centro-executor.lock'), before };
}

test('an authorized partial game iteration returns to UX and continues Development in the same attempt', async t => {
  const f = await fixture(t, { qaBlocked: true });
  const partial = { ...delivery(f.before, 'developer'), outcome: 'blocked', scope: 'partial',
    questions: [{ id: 'ux-return', decisionKey: 'UX-I1-return', text: 'Evaluar el candidato I1.', required: true }] };
  const artifact = await saveStageReport(f.root, partial, JSON.stringify(partial), partial);
  await patchJob(f.root, job => {
    job.business = 'games'; job.coordination.business = 'games'; job.workflow.currentStage = 'developer';
    Object.assign(job.workflow.steps.find(item => item.key === 'developer'), { status: 'blocked', dispatchStatus: 'failed', delivery: partial, artifact });
    job.workflow.steps = job.workflow.steps.map(item => item.key === 'qa' ? { key: 'qa', profile: 'qa_games', status: 'queued' } : item);
  });
  await patchAuto(f.root, state => {
    state.receipts[0].business = 'games';
    state.businesses.games = true;
    delete state.integrations[f.receiptId];
  });
  const handoff = { id: 'handoff-msg_approved001', jobId: f.jobId, business: 'games', projectId: null, runId, attempt: 2,
    authorizedBy: senderId, approvalMessageId: 'msg_approved001', fromStage: 'developer', toStage: 'ux', note: 'Revisar APK I1.', ...identity('developer') };
  const inspectDispatch = async expected => ({ ...identity('developer'), state: 'failed', liveness: 'exited', partialResumeVerified: expected.mode === 'same_attempt_ux_return' });
  await assert.rejects(f.recover({ uxHandoff: { ...handoff, authorizedBy: 'term_foreign01' }, inspectDispatch }), /no corresponde/);
  const queued = await f.recover({ uxHandoff: handoff, inspectDispatch, captureSnapshot: async () => snapshot, verify: f.verify });
  assert.equal(queued.workflow.currentStage, 'ux');
  assert.equal(queued.workflowHistory.at(-1).steps.find(item => item.key === 'developer').artifact.sha256, artifact.sha256);
  assert.equal(queued.attempts, 2);
  const starts = [];
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[1] === 'worker-start') {
      const stage = ['ux', 'developer'][starts.length]; assert.ok(stage); starts.push(stage);
      const brief = args[args.indexOf('--spec') + 1];
      const spec = await fs.readFile(JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]), 'utf8');
      assert.match(spec, stage === 'ux' ? /Revisar APK I1/ : /Último dictamen de Diseño/);
      return identity(stage, true);
    }
    const stage = starts.at(-1), native = identity(stage, true);
    if (args[1] === 'worker-show') return { ...native, state: stage === 'ux' ? 'succeeded' : 'failed', liveness: 'exited', workspace: f.workspace };
    if (args[1] === 'inbox') {
      const value = stage === 'ux' ? { ...delivery(queued, stage, true), jobAttempt: 2 } : { ...partial, ...native };
      return { messages: [{ id: 'msg_current_' + stage, type: 'worker_done', run_id: runId,
        to_handle: 'run:' + runId, payload: { ...native, outcome: stage === 'ux' ? 'succeeded' : 'failed' }, body: JSON.stringify(value) }] };
    }
    assert.fail(args.join(' '));
  };
  const captureSnapshot = async () => snapshot;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot, worker: (job, ctx) => runOrca(job, ctx, {
    command, verifyDestination: f.verify, captureSnapshot,
  }) }).tick();
  const next = (await loadState(f.root)).jobs[0];
  assert.deepEqual(starts, ['ux', 'developer']);
  assert.equal(next.attempts, 2);
  assert.equal(next.workflow.steps.find(item => item.key === 'ux').authorization.mode, 'ux_return');
  assert.equal(next.workflow.steps.find(item => item.key === 'qa').status, 'queued');
  assert.equal((await readAutoRun(f.root)).integrations[f.receiptId], undefined);
});

for (const stage of ['ux', 'developer', 'qa', 'reviewer']) test(`a saved decision resumes ${stage} without replacing approved work or consuming an attempt`, async t => {
  const f = await fixture(t, { qaBlocked: true, findingStage: stage === 'reviewer' ? 'reviewer' : 'qa' });
  const question = { id: 'diagnosis', text: 'Elegir un diagnóstico alternativo.', required: true };
  const partial = { ...delivery(f.before, stage), outcome: 'blocked', scope: 'partial', approval: 'blocked', questions: [question] };
  const artifact = await saveStageReport(f.root, partial, JSON.stringify(partial), partial);
  await patchJob(f.root, job => {
    job.workflow.currentStage = stage;
    const index = job.workflow.steps.findIndex(item => item.key === stage);
    Object.assign(job.workflow.steps[index], { status: 'blocked', dispatchStatus: 'failed', dispatchSettled: true, delivery: partial, artifact });
    job.workflow.steps = job.workflow.steps.map((item, i) => i > index ? { key: item.key, profile: item.profile, status: 'queued' } : item);
  });
  if (['ux', 'developer'].includes(stage)) await patchAuto(f.root, state => { delete state.integrations[f.receiptId]; });
  const before = (await loadState(f.root)).jobs[0];
  const continuation = { version: 1, rootJobId: f.jobId, parentJobId: f.jobId, decisionRevision: 1, questionIds: [question.id],
    decisions: [{ questionId: question.id, decisionKey: question.id, question: question.text, answer: 'Comparar con otro entorno.' }] };
  const inspectDispatch = async expected => ({ ...identity(stage), state: 'failed', liveness: 'exited',
    partialResumeVerified: expected.mode === 'same_attempt_stage_decision' });
  const recover = options => f.recover({ stageDecision: continuation, captureSnapshot: async () => snapshot, verify: f.verify, ...options });
  await assert.rejects(recover({ inspectDispatch: async expected => ({ ...await inspectDispatch(expected), liveness: 'live' }) }), /no acredita/);
  const queued = await recover({ inspectDispatch });
  assert.equal(queued.workflow.currentStage, stage);
  assert.equal(queued.attempts, before.attempts);
  const index = queued.workflow.steps.findIndex(item => item.key === stage);
  assert.deepEqual(queued.workflow.steps.slice(0, index), before.workflow.steps.slice(0, index));
  assert.equal(queued.workflow.steps[index].predecessorTaskId, identity(stage).taskId);
  assert.deepEqual(queued.continuation, continuation);
  assert.equal(queued.livenessResume.snapshot, snapshot);
  await patchAuto(f.root, state => {
    const receipt = state.receipts[0];
    receipt.status = 'claimed';
    receipt.dispatchRecovery.phase = 'consumed';
  });
  await fs.writeFile(f.lockPath, JSON.stringify({ jobId: f.jobId, receiptId: f.receiptId, attempt: queued.attempts, pid: process.pid }));
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async job => {
    assert.equal(job.livenessResume.phase, 'consumed');
    assert.equal(job.attempts, before.attempts);
    return { text: 'Decisión recibida en el mismo intento.' };
  } }).tick();
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('coordinated planning resumes without a Git checkout or another attempt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-stage-decision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const jobId = 'planning-stage-fixture', receiptId = 'receipt-planning-stage';
  const question = { id: 'scope', text: 'Qué alcance priorizamos?', required: true };
  await setAutoRun(root, 'games', true, { confirm: true });
  await confirmSubmission(root, receiptId, { id: jobId, business: 'games', kind: 'analysis', provider: 'orca', title: 'Plan',
    prompt: 'Preparar un plan verificable.', coordination: { requestId: 'coord-planning-stage', runId, senderId, business: 'games' } });
  await createAutoRunner(root, { worker: async (job, ctx) => {
    const partial = { ...delivery(job, 'planner'), jobAttempt: 1, outcome: 'needs_input', scope: 'partial', questions: [question] };
    const artifact = await saveStageReport(root, partial, JSON.stringify(partial), partial);
    await ctx.reportStage({ key: 'planner', ...identity('planner'), status: 'running', attempt: 1, taskInputAttempt: 1 });
    await ctx.reportStage({ key: 'planner', status: 'blocked', dispatchStatus: 'failed', dispatchSettled: true, delivery: partial, artifact });
    throw Object.assign(new Error('Decisión imprescindible'), { code: 'needs_input' });
  } }).tick();
  const answer = { version: 1, rootJobId: jobId, parentJobId: jobId, decisionRevision: 1, questionIds: ['scope'],
    decisions: [{ questionId: 'scope', decisionKey: 'scope', question: question.text, answer: 'Un prototipo.' }] };
  const queued = await recoverKnownDispatchReceipt(root, jobId, { confirm: true, stageDecision: answer,
    verify: async () => assert.fail('planning has no Git checkout'), captureSnapshot: async () => assert.fail('planning has no snapshot'),
    inspectDispatch: async () => ({ ...identity('planner'), state: 'failed', liveness: 'exited', partialResumeVerified: true }) });
  assert.equal(queued.attempts, 1);
  await createAutoRunner(root, { worker: async job => {
    assert.equal(job.attempts, 1);
    assert.equal(job.continuation.decisions[0].answer, 'Un prototipo.');
    return { text: 'Plan preparado.' };
  } }).tick();
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
});

test('the saved answer to the current QA block requeues the same candidate exactly once', async t => {
  const f = await fixture(t, { qaBlocked: true });
  const qa = f.before.workflow.steps.find(step => step.key === 'qa');
  const request = { id: f.before.coordination.requestId, status: 'routed', jobId: f.jobId, questionRounds: [
    { id: 'old', origin: { kind: 'quality-block', jobId: f.jobId, runId, taskId: qa.taskId, dispatchId: qa.dispatchId, messageId: 'msg_stale001' } },
    { id: 'current', origin: { kind: 'quality-block', jobId: f.jobId, runId, taskId: qa.taskId, dispatchId: qa.dispatchId, messageId: qa.resultMessageId } },
  ] };
  const question = { id: 'cq-fixture', coordinatorRequestId: request.id, roundId: 'current', required: true, status: 'pending', question: '¿Es cómodo?' };
  const stale = { ...question, id: 'cq-stale', roundId: 'old', status: 'answered', answer: 'Otro candidato.' };
  assert.equal(nextQualityAction(f.before, request, [question, stale]), null);
  assert.equal(nextQualityAction(f.before, request, [stale]), null);
  question.status = 'answered';
  question.answer = 'Cómodo en el teléfono de prueba.';
  await changeDashboardState(f.root, state => {
    state.coordinatorRequests.push(request);
    state.questions.push(question, stale);
  });
  let resumed = 0;
  const resume = async (_root, id, options) => { assert.equal(id, f.jobId); resumed++; return f.recover(options); };
  await syncQualityHandoffs(f.root, { resume });
  await syncQualityHandoffs(f.root, { resume });
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(resumed, 1);
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 2);
  assert.equal(job.workflow.currentStage, 'qa');
  assert.deepEqual(job.qualityAnswers, [{ questionId: question.id, question: question.question, answer: question.answer,
    qaDispatchId: qa.dispatchId, candidateSnapshot: snapshot }]);
  assert.equal(job.workflow.steps.find(step => step.key === 'developer').dispatchId, identity('developer').dispatchId);
});

test('a decision on an already settled review retains the QA approval and renews the same snapshot', async t => {
  const f = await fixture(t, { qaBlocked: true, findingStage: 'reviewer' });
  const review = f.before.workflow.steps.find(item => item.key === 'reviewer');
  const action = { type: 'answer', dispatchId: review.dispatchId, messageId: review.resultMessageId,
    answers: [{ questionId: 'q-review', question: '¿Disponemos de la evidencia?', answer: 'Sí, en el informe adjunto.' }] };
  const queued = await f.recover({ qualityAction: action });
  assert.equal(queued.workflow.currentStage, 'reviewer');
  assert.deepEqual(queued.workflow.steps.find(item => item.key === 'qa'), f.before.workflow.steps.find(item => item.key === 'qa'));
  assert.equal(queued.qualityAnswers[0].reviewerDispatchId, review.dispatchId);
  const auto = await readAutoRun(f.root);
  const developer = queued.workflow.steps.find(item => item.key === 'developer');
  const job = { ...queued, livenessResume: { ...queued.livenessResume, phase: 'consumed' } };
  const validation = await prepareIntegrationValidation(job, { runId, developer, previous: auto.integrations[f.receiptId],
    captureSnapshot: async () => snapshot, persist: async () => {} });
  assert.equal(validation.snapshot, snapshot);
  assert.equal(validation.record.validation.cycleId, queued.validationCycle);
});

for (const findingStage of ['qa', 'reviewer']) test(`a confirmed ${findingStage} failure sends the same job to Development then validates the corrected snapshot`, async t => {
  const f = await fixture(t, { qaBlocked: true, finding: 'failed', findingStage });
  const qa = f.before.workflow.steps.find(step => step.key === findingStage);
  const qualityAction = { ...qualityCorrection(f.before), type: 'correction', dispatchId: qa.dispatchId, messageId: qa.resultMessageId, answers: [] };
  const queued = await f.recover({ qualityAction });
  assert.equal(queued.workflow.currentStage, 'developer');
  assert.equal(queued.workflow.steps.find(step => step.key === 'developer').predecessorTaskId, identity('developer').taskId);
  assert.equal(queued.workflow.steps.find(step => step.key === 'ux').dispatchId, identity('ux').dispatchId);
  const simulatedBlock = { ...f.before, livenessRecoveryHistory: queued.livenessRecoveryHistory };
  assert.equal(qualityCorrection(simulatedBlock), null, 'the same failure set cannot restart Development again');
  const starts = [];
  const corrected = 'c'.repeat(64);
  let candidate = snapshot;
  const command = async args => {
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[1] === 'worker-start') {
      const stage = ['developer', 'qa', 'reviewer'][starts.length]; starts.push(stage);
      if (stage === 'developer') candidate = corrected;
      else assert.equal((await readAutoRun(f.root)).integrations[f.receiptId].validation.snapshot, corrected);
      return identity(stage, true);
    }
    if (args[1] === 'worker-show') {
      const stage = starts.find(key => identity(key, true).dispatchId === args[args.indexOf('--dispatch') + 1]);
      return { ...identity(stage, true), state: 'succeeded', liveness: 'exited', workspace: f.workspace };
    }
    if (args[1] === 'inbox') return { messages: starts.map(stage => ({ id: `msg_new_${stage}`, type: 'worker_done', run_id: runId,
      to_handle: `run:${runId}`, payload: { ...identity(stage, true), outcome: 'succeeded' }, body: JSON.stringify(delivery(queued, stage, true)) })) };
    assert.fail('Unexpected native command: ' + args.join(' '));
  };
  const captureSnapshot = async () => candidate;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot, worker: (job, ctx) => runOrca(job, ctx, {
    command, verifyDestination: f.verify, captureSnapshot, integrate: async (_job, _ctx, { previous }) => {
      assert.equal(previous.validation.snapshot, corrected);
      assert.equal(previous.validation.developerDispatchId, identity('developer', true).dispatchId);
      assert.equal(previous.validation.approvals.qa.dispatchId, identity('qa', true).dispatchId);
      return { phase: 'complete' };
    },
  }) }).tick();
  const job = (await loadState(f.root)).jobs[0];
  assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
  assert.equal(job.attempts, 2);
  assert.deepEqual(starts, ['developer', 'qa', 'reviewer']);
  const spec = await fs.readFile(job.workflow.steps.find(step => step.key === 'developer').specArtifact.path, 'utf8');
  assert.match(spec, /RONDA DE CORRECCIÓN (QA|REVISIÓN) 1/);
  const permit = job.workflow.steps.find(step => step.key === 'developer').authorization;
  assert.equal(permit.mode, 'contract_correction');
  assert.equal(permit.from, findingStage);
  assert.equal(permit.dispatchId, qa.dispatchId);
  assert.equal(permit.senderId, senderId);
  assert.equal(job.workflow.steps.find(step => step.key === 'qa').authorization.from, 'developer');
  assert.equal(job.workflow.steps.find(step => step.key === 'integration').authorization.from, 'reviewer');
});

test('settled QA revalidation preserves the pre-QA snapshot, attempt and previous reports', async t => {
  const f = await fixture(t, { qaBlocked: true });
  await patchJob(f.root, job => {
    job.workflow.steps.find(item => item.key === 'developer').retryOf = {
      taskId: identity('developer').taskId, dispatchId: 'ctx_stopped_developer', dispatchStatus: 'stopped', recoveryId: 'stopped-recovery',
    };
    job.stoppedDeveloperRecoveryId = 'stopped-recovery';
  });
  const before = (await loadState(f.root)).jobs[0];
  const changed = async expected => {
    const observed = await f.inspect(expected);
    observed.integrationValidation.candidateSnapshot = 'b'.repeat(64);
    return observed;
  };
  await assert.rejects(f.recover({ inspectDispatch: changed }), /archivos cambiaron/);
  const queued = await f.recover();
  assert.equal(queued.attempts, 2);
  assert.equal(queued.workflow.runId, runId);
  assert.equal(queued.workflow.currentStage, 'qa');
  assert.equal(queued.workflow.steps.find(item => item.key === 'qa').predecessorTaskId, identity('qa').taskId);
  assert.equal(queued.workflowHistory.at(-1).steps.find(item => item.key === 'qa').delivery.outcome, 'blocked');
  assert.deepEqual(queued.workflow.steps.find(item => item.key === 'developer'), before.workflow.steps.find(item => item.key === 'developer'));
  assert.equal((await readAutoRun(f.root)).integrations[f.receiptId].validationCandidateSnapshot, snapshot);
  await patchAuto(f.root, state => {
    const receipt = state.receipts[0];
    receipt.status = 'needs_attention';
    receipt.reason = 'El recibo no autorizó el reintento de Desarrollo detenido.';
    receipt.dispatchRecovery.phase = 'consumed';
  });
  await fs.writeFile(f.lockPath, JSON.stringify({ jobId: f.jobId, receiptId: f.receiptId, attempt: 2, pid: process.pid }));
  assert.equal((await f.recover()).livenessResume.id, queued.livenessResume.id);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'pending');
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async job => {
    assert.equal(job.attempts, 2);
    assert.equal(job.livenessResume.phase, 'consumed');
    return { text: 'Revalidación admitida' };
  } }).tick();
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('a later QA block revalidates the unchanged candidate after increasing the limit', async t => {
  const f = await fixture(t, { qaBlocked: true });
  const first = await f.recover();
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async (job, ctx) => {
    const developer = job.workflow.steps.find(item => item.key === 'developer');
    await prepareIntegrationValidation(job, { runId, developer, previous: (await readAutoRun(f.root)).integrations[f.receiptId],
      captureSnapshot: async () => snapshot, persist: record => persistIntegration(f.root, record) });
    const stage = 'qa', value = delivery(job, stage, true);
    Object.assign(value, { outcome: 'blocked', approval: 'blocked' });
    value.acceptance[0].status = 'failed';
    const artifact = await saveStageReport(f.root, { ...value, workerState: 'failed' }, JSON.stringify(value), value);
    await ctx.reportStage({ key: stage, status: 'running', ...identity(stage, true), attempt: 2 });
    await ctx.reportStage({ key: stage, status: 'blocked', ...identity(stage, true), attempt: 2, taskInputAttempt: 2, artifact, delivery: value,
      dispatchStatus: 'failed', dispatchSettled: true, resultMessageId: 'msg_qa_blocked_again' });
    throw Object.assign(new Error('Render no disponible en el emulador.'), { code: 'delivery_incomplete' });
  } }).tick();
  assert.equal(settledQaRevalidation((await loadState(f.root)).jobs[0]), null);
  await increaseJobAttemptLimit(f.root, f.jobId, 5);
  const second = await f.recover();
  assert.notEqual(second.validationCycle, first.validationCycle);
  assert.equal(second.attempts, 2);
  assert.equal(second.workflow.currentStage, 'qa');
  assert.equal(second.workflowHistory.at(-1).steps.find(item => item.key === 'qa').dispatchId, identity('qa', true).dispatchId);
  assert.equal((await readAutoRun(f.root)).integrations[f.receiptId].validationCandidateSnapshot, snapshot);
});

test('recovery admits one fresh QA and reviewer through the real queue/provider, preserving maxed attempt, UX/DEV, budget and original evidence', async t => {
  const f = await fixture(t), queued = await f.recover();
  assert.equal(queued.attempts, 2); assert.equal(queued.maxAttempts, 2); assert.equal(queued.estimatedUsd, 0.06); assert.equal(queued.timeoutMs, 10_000);
  assert.equal(queued.livenessResume.mode, 'same_attempt_integration_validation'); assert.equal(queued.livenessResume.elapsedMs, 100);
  assert.match(queued.validationCycle, /^[a-f0-9]{64}$/); assert.equal(f.nativeReads.length, 4);
  for (const stage of ['ux', 'developer']) assert.deepEqual(queued.workflow.steps.find(item => item.key === stage), f.before.workflow.steps.find(item => item.key === stage));
  for (const stage of ['qa', 'reviewer', 'integration']) {
    const value = queued.workflow.steps.find(item => item.key === stage); assert.equal(value.status, 'queued');
    for (const key of ['taskId', 'dispatchId', 'artifact', 'delivery']) assert.equal(value[key], undefined);
  }
  assert.equal(queued.workflowHistory.at(-1).steps.find(item => item.key === 'qa').dispatchId, identity('qa').dispatchId);
  const pending = (await readAutoRun(f.root)).integrations[f.receiptId];
  assert.equal(pending.phase, 'validation_pending'); assert.equal(pending.validationCandidateSnapshot, snapshot); assert.equal(pending.manifest, undefined);
  await f.recover({ inspectDispatch: async () => assert.fail('idempotent replay must not inspect again') });
  await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('manual admission') }), { code: 'liveness_resume_unadmitted' });
  const starts = [];
  const command = async args => {
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[1] === 'worker-start') {
      const stage = starts.length ? 'reviewer' : 'qa'; starts.push(stage); assert.ok(args.includes('--spec'));
      const record = (await readAutoRun(f.root)).integrations[f.receiptId];
      assert.equal(record.validation.snapshot, snapshot); assert.equal(record.validation.cycleId, queued.validationCycle); assert.equal(record.manifest, undefined);
      return identity(stage, true);
    }
    if (args[1] === 'worker-show') {
      const dispatchId = args[args.indexOf('--dispatch') + 1]; const stage = starts.find(key => identity(key, true).dispatchId === dispatchId); assert.ok(stage);
      return { ...identity(stage, true), state: 'succeeded', liveness: 'exited', workspace: f.workspace };
    }
    if (args[1] === 'inbox') return { messages: starts.map(stage => ({ id: `msg_new_${stage}`, type: 'worker_done', run_id: runId, to_handle: `run:${runId}`,
      payload: { ...identity(stage, true), outcome: 'succeeded' }, body: JSON.stringify(delivery(queued, stage, true)) })) };
    assert.fail('Unexpected native command: ' + args.join(' '));
  };
  let integrations = 0;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot,
    worker: (job, ctx) => runOrca(job, ctx, { command, verifyDestination: f.verify, captureSnapshot: async () => snapshot,
      integrate: async (job, _ctx, options) => {
        integrations++; assert.equal(job.attempts, 2); assert.equal(job.integrationSnapshot, snapshot);
        assert.equal(options.previous.phase, 'validation_approved'); assert.equal(options.previous.validation.snapshot, snapshot);
        assert.equal(options.previous.validation.approvals.qa.dispatchId, identity('qa', true).dispatchId);
        assert.equal(options.previous.validation.approvals.reviewer.dispatchId, identity('reviewer', true).dispatchId);
        assert.equal(options.previous.manifest, undefined);
        await options.persist({ ...options.previous, phase: 'complete', status: 'complete' }); return { phase: 'complete' };
      } }) }).tick();
  const finished = (await loadState(f.root)).jobs[0]; assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  assert.deepEqual(starts, ['qa', 'reviewer']); assert.equal(integrations, 1); assert.equal(finished.attempts, 2); assert.equal(finished.maxAttempts, 2);
  assert.equal(finished.livenessResume.phase, 'consumed'); assert.equal(finished.estimatedUsd, 0.06);
  for (const stage of ['qa', 'reviewer']) assert.ok(finished.workflow.steps.find(item => item.key === stage).specArtifact.path.includes('-validation-' + queued.validationCycle));
});

test('stale proof, foreign owner, missing closure, integration effects and exhausted time fail before releasing checkout', async t => {
  const f = await fixture(t), lock = await fs.readFile(f.lockPath, 'utf8');
  for (const mutate of [proof => { proof.candidateSnapshot = 'bad'; }, proof => { proof.originalWorkflowHash = 'b'.repeat(64); }, proof => { proof.originalSteps[2].dispatchId = 'ctx_foreign001'; }]) {
    await assert.rejects(f.recover({ inspectDispatch: async expected => { const observed = await f.inspect(expected); mutate(observed.integrationValidation); return observed; } }));
  }
  for (const override of [{ state: 'running', liveness: 'live' }, { state: 'succeeded', liveness: 'unverifiable' }]) {
    await assert.rejects(f.recover({ inspectDispatch: async expected => ({ ...(await f.inspect(expected)), ...override }) }), /cierre nativo/);
  }
  await assert.rejects(f.recover({ inspectDispatch: async expected => inspectRecoveryDispatch(f.root, f.before, expected, { captureSnapshot: async () => snapshot,
    command: async args => args[1] === 'run-show' ? { run: { id: runId, coordinator_handle: 'term_foreign001' } } : f.command(args) }) }));
  const original = (await readAutoRun(f.root)).integrations[f.receiptId];
  for (const extra of [{ phase: 'commit_intent' }, { manifest: snapshot }, { commitSha: 'c'.repeat(40) }, { prNumber: 2 }]) {
    await patchAuto(f.root, state => { state.integrations[f.receiptId] = { ...original, ...extra }; });
    await assert.rejects(f.recover({ inspectDispatch: async () => assert.fail('record with effects must not inspect') }), /manifiesto/);
  }
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = original; });
  await patchJob(f.root, job => { job.timeoutMs = 100; });
  await assert.rejects(f.recover(), /tiempo restante/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock);
});

test('candidate changes before admission cannot consume an attempt or start a worker', async t => {
  const f = await fixture(t); await f.recover();
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => 'b'.repeat(64), worker: async () => assert.fail('changed candidate') }).tick();
  const job = (await loadState(f.root)).jobs[0]; assert.equal(job.state, 'queued'); assert.equal(job.attempts, 2); assert.equal(job.livenessResume.phase, 'ready');
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'blocked');
});

test('interrupted durable handoff replays one cycle and rejects a changed candidate', async t => {
  const f = await fixture(t), queued = await f.recover(), originalHistory = queued.workflowHistory.length;
  await patchAuto(f.root, state => { const receipt = state.receipts[0]; receipt.status = 'retrying'; receipt.dispatchRecovery.phase = 'lock_released';
    state.integrations[f.receiptId] = receipt.integrationRecoveryHistory.pop().originalRecord; delete receipt.retryAuthorizedAttempt; });
  await assert.rejects(f.recover({ inspectDispatch: async expected => { const result = await f.inspect(expected); result.integrationValidation.candidateSnapshot = 'b'.repeat(64); return result; } }), /candidato cambió/);
  const replay = await f.recover(); assert.equal(replay.validationCycle, queued.validationCycle); assert.equal(replay.workflowHistory.length, originalHistory);
  assert.equal((await readAutoRun(f.root)).receipts[0].integrationRecoveryHistory.length, 1);
});

test('a later native closure failure uses its own same-attempt recovery instead of reauthorizing the validation cycle', async t => {
  const f = await fixture(t); const queued = await f.recover();
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'qa', status: 'blocked', error: 'orca_liveness_unconfirmed', dispatchStatus: 'unknown', ...identity('qa', true), attempt: 2, taskInputAttempt: 2 });
    throw Object.assign(new Error('Await physical close'), { code: 'orca_liveness_unconfirmed' });
  } }).tick();
  const resumed = await f.recover({ inspectDispatch: async expected => { assert.equal(expected.stage, 'qa'); assert.equal(expected.dispatchId, identity('qa', true).dispatchId);
    return { ...identity('qa', true), state: 'succeeded', liveness: 'exited' }; } });
  assert.equal(resumed.livenessResume.mode, 'same_attempt_liveness'); assert.equal(resumed.validationCycle, queued.validationCycle); assert.equal(resumed.attempts, 2);
});
