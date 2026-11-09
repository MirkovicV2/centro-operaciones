import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { confirmSubmission, createAutoRunner, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, runQueue } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { productJobContract, parseDelivery } from '../workflow-contract.mjs';
import { inspectRecoveryDispatch } from '../panel/dispatch-recovery.mjs';
import { runOrca } from '../orca-provider.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

test('recover an exact UX criteria array from its original dispatch and start only Development', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ux-format-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const acceptance = ['Añadir un punto al equipo.'];
  const identity = { jobId: 'ux-format-job', jobAttempt: 1, stage: 'ux', runId: 'run_fixtureux', taskId: 'task_fixtureux', dispatchId: 'ctx_fixtureux' };
  const senderId = 'term_fixtureux';
  const payload = { version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Diseño listo.',
    acceptance: [{ criterion: 'Especificación UX.', status: 'passed', evidence: 'Pantalla y comportamiento descritos.' }],
    evidence: ['Especificación UX.'], questions: [], decisions: [{ key: 'productAcceptance', value: acceptance }] };
  const text = JSON.stringify(payload);
  const expected = { ...identity, acceptance };
  assert.deepEqual(JSON.parse(parseDelivery(text, expected, { required: true }).decisions[0].value), acceptance);
  for (const decisions of [[{ key: 'otraDecision', value: acceptance }], [{ key: 'productAcceptance', value: ['Criterio cambiado.'] }]]) {
    assert.throws(() => parseDelivery(JSON.stringify({ ...payload, decisions }), expected, { required: true }), { code: 'delivery_invalid' });
  }
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  await confirmSubmission(root, 'receipt-ux-format-job', { id: identity.jobId, business: 'agency', projectId: 'project-ux-format', kind: 'code',
    title: 'Diseñar marcador', prompt: 'Diseñar marcador.', provider: 'orca', workspace, isolated: true, branch: 'feature', destination,
    coordination: { requestId: 'coord-ux-format', coordinatorId: 'agency', coordinatorName: 'Agencia', runId: identity.runId, senderId, business: 'agency', projectId: 'project-ux-format' },
    contract: productJobContract({ objective: 'Diseñar marcador.', successCriteria: 'Cierre tras integración.', productAcceptance: acceptance }) });
  let artifact;
  await createAutoRunner(root, { verify, worker: async (_job, ctx) => {
    artifact = await saveStageReport(root, identity, text, null);
    await ctx.reportStage({ key: 'ux', ...identity, status: 'blocked', attempt: 1, taskInputAttempt: 1, dispatchStatus: 'completed', dispatchSettled: true, error: 'delivery_invalid', artifact });
    throw Object.assign(new Error('Formato de UX bloqueado'), { code: 'delivery_invalid' });
  } }).tick();
  const blocked = (await loadState(root)).jobs[0];
  const originalBytes = await fs.readFile(artifact.path, 'utf8');
  const launches = [];
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    if (args[1] === 'run-show') return { run: { id: identity.runId, coordinator_handle: senderId } };
    if (args[1] === 'worker-show') return { ...identity, state: 'succeeded', liveness: 'exited', workspace };
    if (args[1] === 'inbox') return { messages: [{ id: 'msg_fixtureux', type: 'worker_done', run_id: identity.runId,
      to_handle: 'run:' + identity.runId, payload: { ...identity, outcome: 'succeeded' }, body: text }] };
    if (args[1] === 'worker-start') {
      launches.push(args);
      throw Object.assign(new Error('End fixture at the first new launch'), { rejected: true });
    }
    assert.fail(args.join(' '));
  };
  await recoverKnownDispatchReceipt(root, identity.jobId, { confirm: true, verify,
    inspectDispatch: expected => inspectRecoveryDispatch(root, blocked, expected, { command }) });
  await createAutoRunner(root, { verify, worker: (job, ctx) => runOrca(job, ctx, { command, verifyDestination: verify }) }).tick();
  const resumed = (await loadState(root)).jobs[0];
  assert.equal(resumed.attempts, 1);
  assert.equal(resumed.workflow.steps[0].status, 'succeeded');
  assert.equal(resumed.workflow.steps[0].dispatchId, identity.dispatchId);
  assert.equal(resumed.workflow.steps[0].deliveryTransport.kind, 'ux_product_acceptance_array');
  assert.equal(launches.length, 1);
  assert.ok(launches[0].includes(JSON.stringify([identity.taskId])));
  assert.equal(await fs.readFile(artifact.path, 'utf8'), originalBytes);
});
async function patchJob(root, change) {
  const state = await loadState(root); change(state.jobs[0], state);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: state.jobs, budget: state.budget } }) + '\n');
}
async function fixture(t, stage = 'qa') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const ux = { runId: 'run_fixture01', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01' };
  const ids = { runId: ux.runId, taskId: 'task_qa_fixture01', dispatchId: 'ctx_qa_fixture01' };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-transport-resume', { id: 'transport-resume-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Entrega Unicode íntegra', prompt: 'Verificar aceptación completa.', workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2, timeoutMs: 10_000 });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_status_unknown', ...ux, attempt: job.attempts, taskInputAttempt: 1 });
    throw new Error('Initial UX transport');
  } }).tick();
  await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...ux, state: 'succeeded', liveness: 'exited' }) });
  let proof;
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'running', ...ux, attempt: 2 });
    await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'UX completed' });
    await ctx.reportStage({ key: 'developer', status: 'succeeded', summary: 'Developer completed', runId: ux.runId, taskId: 'task_develop01', dispatchId: 'ctx_develop01', attempt: 2, taskInputAttempt: 2 });
    if (stage === 'reviewer') await ctx.reportStage({ key: 'qa', status: 'succeeded', summary: 'QA completed', runId: ux.runId, taskId: 'task_previousqa', dispatchId: 'ctx_previousqa', attempt: 2, taskInputAttempt: 2 });
    const identity = { jobId: job.id, jobAttempt: 1, stage, ...ids, workerState: 'succeeded' };
    const delivery = { version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Verificación íntegra.',
      acceptance: [{ criterion: 'Aceptación completa.', status: 'passed', evidence: 'Comprobación realizada.' }], evidence: ['Comprobación local.'], questions: [], decisions: [] };
    const transcript = JSON.stringify(delivery), receipt = transcript.replace(/[^\x00-\x7f]/g, '?');
    const artifact = await saveStageReport(root, identity, receipt, null);
    proof = { kind: 'unicode_loss', jobId: job.id, jobAttempt: 1, stage, ...ids, originalArtifactSha256: artifact.sha256,
      receiptMessageId: 'msg_fixture_completion', receiptSha256: hash(receipt), transcriptSourceIdentity: 'fixture:exact-native-source', transcriptSha256: hash(transcript), deliverySha256: hash(JSON.stringify(delivery)) };
    await ctx.reportStage({ key: stage, status: 'blocked', dispatchStatus: 'completed', dispatchSettled: true, error: 'delivery_acceptance_missing', ...ids,
      attempt: 2, taskInputAttempt: 1, artifact, summary: 'Invalid transport retained.' });
    throw Object.assign(new Error('Unicode transport damaged acceptance'), { code: 'delivery_acceptance_missing' });
  } }).tick();
  await patchJob(root, (job, state) => {
    job.attemptHistory = [...job.attemptHistory.filter(item => item.attempt !== 2), { attempt: 2, elapsedMs: 100, error: 'delivery_acceptance_missing' }];
    job.estimatedUsd = 0.06; state.budget.estimatedSpentUsd = 0.06;
  });
  const inspect = async () => ({ ...ids, state: 'succeeded', liveness: 'exited', deliveryTransport: structuredClone(proof) });
  const recover = options => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: inspect, ...options });
  return { root, workspace, ids, proof, inspect, recover, verify, jobId: sent.job.id, lockPath: path.join(workspace, '.git', 'centro-executor.lock') };
}

test('QA and reviewer Unicode recovery keeps the maxed attempt, original report, checkpoint and spend', async t => {
  for (const stage of ['qa', 'reviewer']) {
    const f = await fixture(t, stage), before = (await loadState(f.root)).jobs[0];
    const queued = await f.recover();
    assert.equal(queued.attempts, 2); assert.equal(queued.maxAttempts, 2); assert.equal(queued.estimatedUsd, 0.06);
    assert.equal(queued.livenessResume.mode, 'same_attempt_delivery_transport');
    assert.equal(queued.livenessResume.originalError, 'delivery_acceptance_missing');
    assert.equal(queued.livenessResume.elapsedMs, 100); assert.deepEqual(queued.livenessResume.deliveryTransport, f.proof);
    assert.deepEqual(queued.workflow, before.workflow); assert.equal(queued.workflow.steps.find(item => item.key === stage).delivery, undefined);
    await f.recover({ inspectDispatch: async () => assert.fail('ready replay must not inspect or enqueue again') });
    await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('manual admission') }), error => error.code === 'liveness_resume_unadmitted');
    let observations = 0;
    await createAutoRunner(f.root, { verify: f.verify, worker: async job => {
      observations++; assert.equal(job.attempts, 2); assert.equal(job.livenessResume.phase, 'consumed');
      assert.deepEqual(job.workflow, before.workflow); assert.equal(JSON.parse(await fs.readFile(f.lockPath, 'utf8')).attempt, 2);
      return { text: 'Fixture observed the same native delivery.' };
    } }).tick();
    assert.equal(observations, 1); assert.equal((await loadState(f.root)).jobs[0].attempts, 2);
    assert.equal((await readAutoRun(f.root)).receipts[0].dispatchRecovery.phase, 'consumed');
  }
});

test('transport recovery refuses missing, malformed or foreign proof and unconfirmed native exit before releasing lock', async t => {
  const f = await fixture(t), lock = await fs.readFile(f.lockPath, 'utf8');
  const invalid = [undefined, { ...f.proof, kind: 'manual_approval' }, { ...f.proof, jobId: 'other-job' }, { ...f.proof, jobAttempt: 2 },
    { ...f.proof, stage: 'developer' }, { ...f.proof, taskId: 'task_foreign1' }, { ...f.proof, runId: 'run_foreign01' }, { ...f.proof, dispatchId: 'ctx_foreign01' },
    { ...f.proof, originalArtifactSha256: hash('different artifact') }, { ...f.proof, receiptSha256: 'invalid' }, { ...f.proof, transcriptSha256: 'invalid' },
    { ...f.proof, deliverySha256: 'invalid' }, { ...f.proof, receiptMessageId: '' }, { ...f.proof, transcriptSourceIdentity: '' }];
  for (const deliveryTransport of invalid) await assert.rejects(f.recover({ inspectDispatch: async () => ({ ...f.ids, state: 'succeeded', liveness: 'exited', deliveryTransport }) }), error => error.code === 'delivery_transport_unverified');
  for (const observed of [{ state: 'running', liveness: 'live' }, { state: 'succeeded', liveness: 'unverifiable' }, { state: 'failed', liveness: 'exited' }]) {
    await assert.rejects(f.recover({ inspectDispatch: async () => ({ ...f.ids, ...observed, deliveryTransport: f.proof }) }), /Orca no acredita/);
  }
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock); assert.equal((await loadState(f.root)).jobs[0].state, 'needs_attention');
});

test('only settled QA/reviewer acceptance damage is eligible and consumed execution time remains bounded', async t => {
  const f = await fixture(t), original = structuredClone((await loadState(f.root)).jobs[0]);
  for (const change of [
    job => { job.error.code = 'delivery_missing'; },
    job => { job.workflow.steps.find(item => item.key === 'qa').dispatchSettled = false; },
    job => { job.workflow.steps.find(item => item.key === 'qa').dispatchStatus = 'unknown'; },
    job => { job.workflow.steps.find(item => item.key === 'qa').taskInputAttempt = undefined; },
    job => { job.workflow.steps.find(item => item.key === 'qa').artifact.sha256 = 'invalid'; },
    job => { const step = job.workflow.steps.find(item => item.key === 'qa'); step.key = 'developer'; job.workflow.currentStage = 'developer'; },
  ]) {
    await patchJob(f.root, job => { Object.assign(job, structuredClone(original)); change(job); });
    await assert.rejects(f.recover({ inspectDispatch: async () => assert.fail('ineligible checkpoint') }));
  }
  await patchJob(f.root, job => { Object.assign(job, structuredClone(original)); job.timeoutMs = 100; });
  await assert.rejects(f.recover(), /No queda tiempo/);
  await patchJob(f.root, job => { Object.assign(job, structuredClone(original)); job.timeoutMs = 2000; job.attemptHistory.at(-1).elapsedMs = 1950; });
  await f.recover(); let elapsed;
  await createAutoRunner(f.root, { verify: f.verify, worker: async (_job, ctx) => {
    const started = Date.now(); await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true })); elapsed = Date.now() - started; throw ctx.signal.reason;
  } }).tick();
  const timedOut = (await loadState(f.root)).jobs[0]; assert.equal(timedOut.error.code, 'timeout'); assert.equal(timedOut.attempts, 2); assert.equal(timedOut.timeoutMs, 2000);
  assert.ok(elapsed >= 30 && elapsed < 1500);
});

test('partial durable recovery replays the exact transport proof and rejects changed receipt evidence', async t => {
  const f = await fixture(t); await f.recover();
  const automation = await readAutoRun(f.root), receipt = automation.receipts[0];
  receipt.status = 'retrying'; receipt.dispatchRecovery.phase = 'lock_released'; delete receipt.retryAuthorizedAttempt;
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(automation));
  await assert.rejects(f.recover({ inspectDispatch: async () => ({ ...(await f.inspect()), deliveryTransport: { ...f.proof, deliverySha256: hash('other delivery') } }) }), /evidencia de transporte cambió/);
  const queued = await f.recover(); assert.equal(queued.livenessRecoveryHistory.length, 1); assert.equal(queued.attempts, 2);
  const tampered = await readAutoRun(f.root); tampered.receipts[0].dispatchRecovery.deliveryTransport.deliverySha256 = hash('other delivery');
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(tampered));
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('mismatched proof cannot be consumed') }).tick();
  assert.equal((await loadState(f.root)).jobs[0].state, 'queued'); assert.equal((await loadState(f.root)).jobs[0].attempts, 2);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'blocked');
});

test('a later QA transport repair preserves an earlier consumed liveness recovery', async t => {
  const f = await fixture(t), automation = await readAutoRun(f.root);
  const previous = { ...automation.receipts[0].dispatchRecovery, mode: 'same_attempt_liveness', phase: 'consumed',
    error: 'orca_liveness_unconfirmed', stage: 'developer', taskId: 'task_develop01', dispatchId: 'ctx_develop01', attempt: 2 };
  automation.receipts[0].dispatchRecovery = previous;
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify(automation));
  await patchJob(f.root, job => { job.livenessResume = structuredClone(previous); });
  const queued = await f.recover();
  assert.equal(queued.attempts, 2); assert.equal(queued.livenessResume.stage, 'qa');
  assert.equal(queued.livenessResume.mode, 'same_attempt_delivery_transport');
  assert.deepEqual((await readAutoRun(f.root)).receipts[0].dispatchRecoveryHistory.at(-1), previous);
});
