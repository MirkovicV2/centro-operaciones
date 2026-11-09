import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, runQueue } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { inspectRecoveryDispatch } from '../panel/dispatch-recovery.mjs';
import { runOrca } from '../orca-provider.mjs';
import { syncQualityHandoffs } from '../panel/quality-handoff.mjs';

const commitSha = 'c'.repeat(40);
const snapshot = 'a'.repeat(64), runId = 'run_validation001', senderId = 'term_coordinator001';
const errorText = 'PR no confirmada tras crearla; necesita revisión.';
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
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-reconcile-resume-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, 'receipt-validation-resume', { id: 'validation-resume-job', business: 'agency', kind: 'code', provider: 'orca',
    title: 'Validate reviewed files', prompt: 'Complete the fixture acceptance.', acceptance: ['Complete the fixture acceptance.'], workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2, timeoutMs: 10_000,
    coordination: { requestId: 'coord-validation001', runId, senderId, business: 'agency' } });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_status_unknown', ...identity('ux'), attempt: job.attempts, taskInputAttempt: 1 });
    throw new Error('Initial transport failure');
  } }).tick();
  await recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: async () => ({ ...identity('ux'), state: 'succeeded', liveness: 'exited' }) });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    for (const stage of ['ux', 'developer', 'qa', 'reviewer']) {
      if (stage === 'ux') await ctx.reportStage({ key: stage, status: 'running', ...identity(stage), attempt: 2 });
      const value = delivery(job, stage), artifact = await saveStageReport(root, { ...value, workerState: 'succeeded' }, JSON.stringify(value), value);
      await ctx.reportStage({ key: stage, status: 'succeeded', ...identity(stage), attempt: 2, taskInputAttempt: value.jobAttempt,
        artifact, delivery: value, approvalOutcome: value.approval, summary: value.summary, dispatchStatus: 'completed', dispatchSettled: true });
    }
    await ctx.reportStage({ key: 'integration', status: 'running' });
    const completed = (await loadState(root)).jobs[0], dev = completed.workflow.steps.find(item => item.key === 'developer');
    await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, repository: destination.repository, sourceBranch: job.branch, baseBranch: destination.baseBranch,
      status: 'needs_attention', needsAttention: true, error: errorText, phase: 'pr_intent', baseline: destination.sha, remoteBaseSha: destination.baseSha,
      remoteSourceSha: destination.remoteSha, manifest: snapshot, commitSha, pushedAt: '2026-11-08T20:00:00Z',
      validation: { version: 1, snapshot, jobId: job.id, receiptId: job.autoIntent.receiptId, attempt: 2, runId, workspace, branch: job.branch, cycleId: 'attempt-2',
        developerTaskId: dev.taskId, developerDispatchId: dev.dispatchId, developerArtifactSha256: dev.artifact.sha256,
        approvals: Object.fromEntries(['qa', 'reviewer'].map(key => { const step = completed.workflow.steps.find(item => item.key === key);
          return [key, { taskId: step.taskId, dispatchId: step.dispatchId, artifactSha256: step.artifact.sha256 }]; })) } });
    await ctx.reportStage({ key: 'integration', status: 'blocked', error: 'integration_needs_attention', summary: errorText });
    throw Object.assign(new Error(errorText), { code: 'github_integration_needs_attention' });
  } }).tick();
  await patchJob(root, (job, state) => { job.attemptHistory = [...job.attemptHistory.filter(item => item.attempt !== 2), { attempt: 2, elapsedMs: 100, error: 'github_integration_needs_attention' }]; job.estimatedUsd = 0.06; state.budget.estimatedSpentUsd = 0.06; });
  const nativeReads = [];
  const command = async args => {
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    assert.equal(args[1], 'worker-show'); const dispatchId = args[args.indexOf('--dispatch') + 1]; nativeReads.push(dispatchId);
    const stage = ['ux', 'developer', 'qa', 'reviewer'].find(key => identity(key).dispatchId === dispatchId); assert.ok(stage);
    return { ...identity(stage), state: 'succeeded', liveness: 'exited', workspace };
  };
  const inspectIntegration = async (_root, job, record) => ({ kind: 'committed_integration', jobId: job.id, receiptId: record.receiptId,
    commitSha, manifest: snapshot, phase: record.phase, repository: destination.repository, sourceBranch: job.branch, baseBranch: destination.baseBranch,
    baseSha: destination.baseSha, prNumber: 1, prUrl: 'https://github.com/Fixture/Repo/pull/1', prHeadSha: commitSha, prBaseSha: destination.baseSha, prState: 'OPEN' });
  const inspect = async expected => inspectRecoveryDispatch(root, (await loadState(root)).jobs[0], expected, { command, inspectIntegration });
  const recover = options => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify: async () => assert.fail('old HEAD verification is invalid after commit'), inspectDispatch: inspect, ...options });
  const before = (await loadState(root)).jobs[0]; assert.equal(before.error.code, 'github_integration_needs_attention', JSON.stringify(before.error)); assert.equal(before.attempts, 2);
  return { root, workspace, verify, recover, inspect, inspectIntegration, command, nativeReads, jobId: sent.job.id, receiptId: sent.receipt.id,
    lockPath: path.join(workspace, '.git', 'centro-executor.lock'), before };
}

test('committed integration accepts canonical mixed-case GitHub URLs through real queue/provider without new workers or resetting attempt, evidence or destination', async t => {
  const f = await fixture(t), originalRecord = (await readAutoRun(f.root)).integrations[f.receiptId], queued = await f.recover();
  assert.equal(queued.livenessResume.mode, 'same_attempt_integration_reconcile'); assert.equal(queued.livenessResume.elapsedMs, 100);
  assert.equal(queued.livenessResume.integrationProof.prUrl, 'https://github.com/Fixture/Repo/pull/1');
  assert.equal(queued.attempts, 2); assert.equal(queued.maxAttempts, 2); assert.equal(queued.timeoutMs, 10_000); assert.equal(queued.estimatedUsd, 0.06);
  assert.deepEqual(queued.workflow, f.before.workflow); assert.deepEqual(queued.destination, f.before.destination);
  assert.deepEqual((await readAutoRun(f.root)).integrations[f.receiptId], originalRecord); assert.equal(f.nativeReads.length, 4);
  await f.recover({ inspectDispatch: async () => assert.fail('ready replay') });
  await assert.rejects(runQueue(f.root, { execute: true, worker: async () => assert.fail('manual admission') }), { code: 'liveness_resume_unadmitted' });
  const commands = [], inspections = [];
  const inspectIntegration = async (...args) => { inspections.push(args[2]); return f.inspectIntegration(...args); };
  const command = async args => {
    commands.push(args);
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    assert.fail('No worker may start or be polled: ' + args.join(' '));
  };
  let integrations = 0;
  const failOldVerify = async () => assert.fail('original baseline cannot replace the committed inspection');
  await createAutoRunner(f.root, { verify: failOldVerify, inspectIntegration,
    worker: (job, ctx) => runOrca(job, ctx, { command, inspectIntegration, verifyDestination: failOldVerify,
      captureSnapshot: async () => assert.fail('never recapture committed manifest'), integrate: async (job, _ctx, options) => {
        integrations++; assert.deepEqual(options.previous, originalRecord); assert.equal(job.integrationSnapshot, originalRecord.manifest);
        assert.deepEqual(job.destination, f.before.destination); assert.equal(job.attempts, 2);
        await options.persist({ ...options.previous, phase: 'complete', status: 'completed', prNumber: 1, prUrl: queued.livenessResume.integrationProof.prUrl, mergeSha: 'd'.repeat(40) });
        return { phase: 'complete' };
      } }) }).tick();
  const finished = (await loadState(f.root)).jobs[0]; assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  assert.equal(integrations, 1); assert.equal(inspections.length, 2); assert.equal(finished.attempts, 2); assert.equal(finished.maxAttempts, 2);
  assert.equal(finished.estimatedUsd, 0.06); assert.equal(commands.some(args => args[1] === 'worker-start'), false);
  for (const stage of ['ux', 'developer', 'qa', 'reviewer']) assert.deepEqual(finished.workflow.steps.find(item => item.key === stage), f.before.workflow.steps.find(item => item.key === stage));
});

test('an expired wait automatically resumes the recorded PR and keeps the same approvals and attempt', async t => {
  const f = await fixture(t);
  await patchJob(f.root, job => { job.error.code = 'github_checks_timeout'; });
  await patchAuto(f.root, state => Object.assign(state.integrations[f.receiptId], {
    phase: 'checks_pending', checkState: 'waiting', waitTimedOut: true, prNumber: 1,
    prUrl: 'https://github.com/Fixture/Repo/pull/1',
  }));
  await syncQualityHandoffs(f.root, { resume: (_root, id, options) => { assert.equal(id, f.jobId); return f.recover(options); } });
  const queued = (await loadState(f.root)).jobs[0];
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempts, 2);
  assert.equal(queued.livenessResume.originalError, 'github_checks_timeout');
  assert.equal(queued.livenessResume.integrationProof.prNumber, 1);
  assert.equal(queued.livenessResume.integrationProof.prHeadSha, commitSha);
  assert.deepEqual(queued.workflow, f.before.workflow);
});

test('changed PR, approvals, manifest, native exit and exhausted budget are refused before lock release', async t => {
  const f = await fixture(t), lock = await fs.readFile(f.lockPath, 'utf8'), automation = await readAutoRun(f.root), originalRecord = automation.integrations[f.receiptId];
  for (const patch of [{ commitSha: 'd'.repeat(40) }, { manifest: 'b'.repeat(64) }, { prHeadSha: 'd'.repeat(40) }, { prBaseSha: 'e'.repeat(40) }, { prNumber: 2 }, { prState: 'CLOSED' }]) {
    await assert.rejects(f.recover({ inspectDispatch: async expected => { const observed = await f.inspect(expected); Object.assign(observed.integrationProof, patch); return observed; } }));
  }
  for (const prUrl of [null, 1, 'http://github.com/Fixture/Repo/pull/1', 'https://github.com/Other/Repo/pull/1',
    'https://github.com/Fixture/Repo/pull/2', 'https://github.com/Fixture/Repo/pull/1?other=1', 'https://github.com/Fixture/Repo/pull/1/']) {
    await assert.rejects(f.recover({ inspectDispatch: async expected => { const observed = await f.inspect(expected); observed.integrationProof.prUrl = prUrl; return observed; } }));
  }
  for (const patch of [{ manifest: 'f'.repeat(64) }, { validation: { ...originalRecord.validation, approvals: {} } }, { phase: 'push_intent' }]) {
    await patchAuto(f.root, state => { state.integrations[f.receiptId] = { ...originalRecord, ...patch }; });
    await assert.rejects(f.recover({ inspectDispatch: async () => assert.fail('bad durable approval must fail before inspection') }));
  }
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = originalRecord; });
  await assert.rejects(f.recover({ inspectDispatch: async expected => ({ ...(await f.inspect(expected)), liveness: 'unverifiable' }) }), /cierre nativo/);
  await patchJob(f.root, job => { job.timeoutMs = 100; }); await assert.rejects(f.recover(), /tiempo restante/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock);
});

test('changed record or PR during admission cannot consume recovery or start integration', async t => {
  for (const changeRecord of [true, false]) {
    const f = await fixture(t); await f.recover();
    if (changeRecord) await patchAuto(f.root, state => { state.integrations[f.receiptId].error = 'Changed after inspection'; });
    await createAutoRunner(f.root, { verify: async () => assert.fail('old verify'), inspectIntegration: async (...args) => ({ ...(await f.inspectIntegration(...args)), prNumber: 2 }),
      worker: async () => assert.fail('changed proof cannot start') }).tick();
    const job = (await loadState(f.root)).jobs[0]; assert.equal(job.state, 'queued'); assert.equal(job.attempts, 2); assert.equal(job.livenessResume.phase, 'ready');
    assert.equal((await readAutoRun(f.root)).receipts[0].status, 'blocked');
  }
});

test('durable handoff replays one recovery and the same record cannot be authorized twice', async t => {
  const f = await fixture(t), originalRecord = (await readAutoRun(f.root)).integrations[f.receiptId], queued = await f.recover();
  await patchAuto(f.root, state => { state.receipts[0].status = 'retrying'; state.receipts[0].dispatchRecovery.phase = 'lock_released'; delete state.receipts[0].retryAuthorizedAttempt; });
  const replay = await f.recover(); assert.equal(replay.livenessResume.id, queued.livenessResume.id); assert.equal(replay.workflowHistory.length, queued.workflowHistory.length);
  assert.deepEqual((await readAutoRun(f.root)).integrations[f.receiptId], originalRecord);
  await createAutoRunner(f.root, { inspectIntegration: f.inspectIntegration, verify: async () => assert.fail('old verify'), worker: async () => {
    throw Object.assign(new Error('Same integration stopped before effects'), { code: 'github_integration_needs_attention' });
  } }).tick();
  await assert.rejects(f.recover({ inspectDispatch: async () => assert.fail('repeated identical record') }), /ya consumió/);
});
