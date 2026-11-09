import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, reviseJobAcceptanceReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, runQueue } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { inspectRecoveryDispatch, reviseCoordinatedJobAcceptance } from '../panel/dispatch-recovery.mjs';
import { runOrca } from '../orca-provider.mjs';

const productAcceptance = ['Añadir tareas mediante botón y Enter.', 'Rechazar entradas vacías.', 'Conservar tareas al recargar.'];
const globalCriterion = 'Producto verificado, QA y revisión aprobadas, checks remotos SUCCESS y merge confirmado.';
const reason = 'Rectificación revisada: QA acredita el producto; revisión, checks y merge son compuertas posteriores obligatorias.';
const snapshot = 'a'.repeat(64), runId = 'run_contract001', senderId = 'term_coordinator001';
const identity = (stage, fresh = false) => ({ runId, taskId: `task_${fresh ? 'new' : 'old'}_${stage}`, dispatchId: `ctx_${fresh ? 'new' : 'old'}_${stage}` });
async function patchJob(root, change) {
  const state = await loadState(root); change(state.jobs[0], state);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: state.jobs, budget: state.budget } }) + '\n');
}
async function patchAuto(root, change) {
  const state = await readAutoRun(root); change(state); await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
}
function delivery(job, stage, fresh = false) {
  const blocked = stage === 'qa' && !fresh;
  return { version: 1, jobId: job.id, jobAttempt: fresh ? 2 : 1, stage, ...identity(stage, fresh), outcome: blocked ? 'blocked' : 'completed',
    scope: blocked ? 'partial' : 'complete', approval: blocked ? 'blocked' : ['qa', 'reviewer'].includes(stage) ? 'approved' : 'not_applicable',
    summary: blocked ? 'Producto comprobado; contrato global exige compuertas futuras.' : `${stage} completed.`,
    acceptance: [...(blocked ? [{ criterion: globalCriterion, status: 'unverified', evidence: 'Revisión, checks y merge aún no ejecutados.' }] : []),
      ...(fresh || blocked ? productAcceptance : [globalCriterion]).map(criterion => ({ criterion, status: 'passed', evidence: 'Fixture verified.' }))],
    evidence: ['Fixture evidence.'], questions: [], decisions: [] };
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contract-revision-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-contract-revision', { id: 'contract-revision-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Validate product acceptance', prompt: 'Original immutable request includes product and later integration gates.',
    contract: { objective: 'Build and integrate the product.', acceptance: [globalCriterion] }, workspace, isolated: true, branch: 'feature', destination,
    maxAttempts: 2, timeoutMs: 10_000, coordination: { requestId: 'coord-contract001', runId, senderId, business: 'agency' } });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    for (const stage of ['ux', 'developer']) {
      const value = delivery(job, stage), artifact = await saveStageReport(root, value, JSON.stringify(value), value);
      await ctx.reportStage({ key: stage, status: 'succeeded', ...identity(stage), attempt: 1, taskInputAttempt: 1, dispatchStatus: 'completed', artifact, delivery: value, summary: value.summary });
    }
    const completed = (await loadState(root)).jobs[0], dev = completed.workflow.steps.find(step => step.key === 'developer');
    await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, repository: destination.repository, sourceBranch: job.branch, baseBranch: 'main',
      phase: 'validation_pending', status: 'validating', validation: { version: 1, snapshot, capturedAt: '2026-11-08T22:00:00Z', jobId: job.id, receiptId: job.autoIntent.receiptId,
        attempt: 1, runId, workspace, branch: job.branch, cycleId: 'attempt-1', developerTaskId: dev.taskId, developerDispatchId: dev.dispatchId, developerArtifactSha256: dev.artifact.sha256 } });
    const value = delivery(job, 'qa'), artifact = await saveStageReport(root, value, JSON.stringify(value), value);
    await ctx.reportStage({ key: 'qa', status: 'blocked', ...identity('qa'), attempt: 1, taskInputAttempt: 1, dispatchStatus: 'failed', dispatchSettled: true,
      artifact, delivery: value, summary: value.summary });
    throw Object.assign(new Error('QA contract blocked by later gates'), { code: 'delivery_incomplete', partialResult: { text: JSON.stringify(value), delivery: value, artifact } });
  } }).tick();
  const nativeReads = [];
  const command = async args => {
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    assert.equal(args[1], 'worker-show'); const dispatchId = args[args.indexOf('--dispatch') + 1]; nativeReads.push(dispatchId);
    const stage = ['ux', 'developer', 'qa'].find(key => identity(key).dispatchId === dispatchId); assert.ok(stage);
    return { ...identity(stage), state: stage === 'qa' ? 'failed' : 'succeeded', liveness: 'exited', workspace };
  };
  const captureSnapshot = async () => snapshot;
  const inspect = async expected => inspectRecoveryDispatch(root, (await loadState(root)).jobs[0], expected, { command, captureSnapshot });
  const revise = options => reviseJobAcceptanceReceipt(root, sent.job.id, { confirm: true, productAcceptance, reason, verify, inspectDispatch: inspect, ...options });
  const before = (await loadState(root)).jobs[0]; assert.equal(before.error.code, 'delivery_incomplete');
  return { root, workspace, verify, command, captureSnapshot, inspect, revise, nativeReads, before, jobId: sent.job.id, receiptId: sent.receipt.id,
    lockPath: path.join(workspace, '.git', 'centro-executor.lock') };
}

test('reviewed product contract uses attempt two with fresh QA/reviewer and the original durable snapshot through real queue/provider', async t => {
  const f = await fixture(t), automation = await readAutoRun(f.root), originalRecord = automation.integrations[f.receiptId];
  const queued = await reviseCoordinatedJobAcceptance(f.root, f.jobId, { confirm: true, productAcceptance, reason, command: f.command, captureSnapshot: f.captureSnapshot, verify: f.verify });
  assert.equal(queued.attempts, 1); assert.equal(queued.maxAttempts, 2); assert.equal(queued.timeoutMs, 10_000); assert.equal(queued.contractRevision.toAttempt, 2);
  assert.equal(queued.contract.acceptanceScope, 'product'); assert.deepEqual(queued.contract.acceptance, productAcceptance); assert.deepEqual(queued.contract.endToEndCriteria, [globalCriterion]);
  assert.deepEqual(queued.contractHistory[0].contract, f.before.contract); assert.deepEqual(queued.workflowHistory[0].steps, f.before.workflow.steps);
  assert.deepEqual((await readAutoRun(f.root)).receipts[0].spec, automation.receipts[0].spec);
  assert.deepEqual((await readAutoRun(f.root)).integrations[f.receiptId], originalRecord); assert.equal(f.nativeReads.length, 3);
  for (const stage of ['ux', 'developer']) assert.deepEqual(queued.workflow.steps.find(item => item.key === stage), f.before.workflow.steps.find(item => item.key === stage));
  assert.equal(queued.workflow.steps.find(item => item.key === 'qa').predecessorTaskId, identity('qa').taskId);
  assert.equal(queued.workflow.steps.find(item => item.key === 'qa').retryOf, undefined);
  await f.revise({ inspectDispatch: async () => assert.fail('ready replay should not query') });
  await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('manual admission') }), { code: 'contract_revision_unadmitted' });
  const starts = [];
  const command = async args => {
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[1] === 'worker-start') {
      const stage = starts.length ? 'reviewer' : 'qa'; starts.push(stage);
      assert.ok(args.includes('--spec')); assert.equal(args.includes('--retry-of'), false);
      if (stage === 'qa') { assert.equal(args[args.indexOf('--parent') + 1], identity('qa').taskId); assert.ok(args.includes(JSON.stringify([identity('developer').taskId]))); }
      const record = (await readAutoRun(f.root)).integrations[f.receiptId];
      assert.equal(record.validation.attempt, 2); assert.equal(record.validation.cycleId, 'attempt-2'); assert.equal(record.validation.snapshot, snapshot);
      assert.deepEqual(record.validationHistory[0].validation, originalRecord.validation); assert.equal(record.manifest, undefined);
      return identity(stage, true);
    }
    if (args[1] === 'worker-show') {
      const dispatchId = args[args.indexOf('--dispatch') + 1], stage = starts.find(key => identity(key, true).dispatchId === dispatchId); assert.ok(stage);
      return { ...identity(stage, true), state: 'succeeded', liveness: 'exited', workspace: f.workspace };
    }
    if (args[1] === 'inbox') return { messages: starts.map(stage => ({ id: `msg_new_${stage}`, type: 'worker_done', run_id: runId, to_handle: `run:${runId}`,
      payload: { ...identity(stage, true), outcome: 'succeeded' }, body: JSON.stringify(delivery(queued, stage, true)) })) };
    assert.fail('Unexpected command: ' + args.join(' '));
  };
  let integrated = false;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: f.captureSnapshot,
    worker: (job, ctx) => runOrca(job, ctx, { command, verifyDestination: f.verify, captureSnapshot: f.captureSnapshot, integrate: async (job, _ctx, options) => {
      integrated = true; assert.equal(job.contractRevision.phase, 'consumed'); assert.equal(job.attempts, 2); assert.equal(job.integrationSnapshot, snapshot);
      assert.equal(options.previous.validation.approvals.qa.dispatchId, identity('qa', true).dispatchId);
      assert.equal(options.previous.validation.approvals.reviewer.dispatchId, identity('reviewer', true).dispatchId); return { phase: 'complete' };
    } }) }).tick();
  const finished = (await loadState(f.root)).jobs[0]; assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  assert.deepEqual(starts, ['qa', 'reviewer']); assert.ok(integrated); assert.equal(finished.attempts, 2); assert.equal(finished.maxAttempts, 2); assert.equal(finished.timeoutMs, 10_000);
  assert.deepEqual(finished.attemptHistory.map(item => item.attempt), [1, 2]);
  assert.equal(finished.workflow.steps.find(item => item.key === 'developer').taskInputAttempt, 1);
  assert.equal(finished.contractHistory.length, 1);
});

test('unreviewed, foreign, changed or active evidence fails closed before checkout lock release', async t => {
  const f = await fixture(t), lock = await fs.readFile(f.lockPath, 'utf8'), original = (await readAutoRun(f.root)).integrations[f.receiptId];
  await assert.rejects(f.revise({ confirm: false }));
  await assert.rejects(f.revise({ productAcceptance: ['An invented product criterion.'] }), /criterio nuevo/);
  await assert.rejects(f.revise({ inspectDispatch: async expected => ({ ...(await f.inspect(expected)), liveness: 'live' }) }), /observación nativa/);
  await assert.rejects(f.revise({ inspectDispatch: async expected => { const seen = await f.inspect(expected); seen.contractRevision.snapshot = 'b'.repeat(64); return seen; } }));
  await assert.rejects(f.revise({ inspectDispatch: async expected => inspectRecoveryDispatch(f.root, f.before, expected, {
    captureSnapshot: f.captureSnapshot, command: async args => args[1] === 'run-show' ? { run: { id: runId, coordinator_handle: 'term_foreign001' } } : f.command(args) }) }));
  for (const patch of [{ phase: 'commit_intent' }, { manifest: snapshot }, { commitSha: 'c'.repeat(40) }, { validation: { ...original.validation, snapshot: 'b'.repeat(64) } }]) {
    await patchAuto(f.root, state => { state.integrations[f.receiptId] = { ...original, ...patch }; }); await assert.rejects(f.revise());
  }
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = original; });
  await patchJob(f.root, job => { job.maxAttempts = 1; }); await assert.rejects(f.revise(), /otro intento/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock);
});

test('failed product criteria and tampered artifacts cannot be turned into a contract correction', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => { job.workflow.steps.find(item => item.key === 'qa').delivery.acceptance[1].status = 'failed'; });
  await assert.rejects(f.revise({ inspectDispatch: async () => assert.fail('product failure must not reach inspection') }), /sin fallos/);
  await patchJob(f.root, job => { job.workflow = f.before.workflow; });
  const artifact = f.before.workflow.steps.find(item => item.key === 'qa').artifact;
  await fs.appendFile(artifact.path, 'tampered'); await assert.rejects(f.revise(), /huella/);
});

test('durable partial handoff replays the same contract and denies changed input or preflight snapshot', async t => {
  const f = await fixture(t), queued = await f.revise();
  await patchAuto(f.root, state => { const entry = state.receipts[0]; entry.status = 'retrying'; entry.contractRevision.phase = 'lock_released'; delete entry.contractRevision.queuedWorkflowHash; delete entry.retryAuthorizedAttempt; });
  await assert.rejects(f.revise({ reason: reason + ' Changed.' }), /otro contrato/);
  const replay = await f.revise(); assert.equal(replay.contractRevision.id, queued.contractRevision.id); assert.equal(replay.contractHistory.length, 1); assert.equal(replay.attempts, 1);
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => 'b'.repeat(64), worker: async () => assert.fail('changed snapshot') }).tick();
  const job = (await loadState(f.root)).jobs[0]; assert.equal(job.state, 'queued'); assert.equal(job.attempts, 1); assert.equal(job.contractRevision.phase, 'ready');
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'blocked');
});
