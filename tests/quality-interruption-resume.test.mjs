import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, recoverKnownDispatchReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState, settledOrcaObservation } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { runOrca } from '../orca-provider.mjs';

// R14 of the E2E (encargo 9): the executor died while Revisión awaited its exit. D3 now also
// covers QA and Revisión: same attempt, same dispatch, the sealed pre-QA validation kept.
const snapshot = 'a'.repeat(64), runId = 'run_quality0001', senderId = 'term_coordinator001';
const identity = stage => ({ runId, taskId: `task_quality_${stage}`, dispatchId: `ctx_quality_${stage}` });
const acceptance = ['Complete the fixture acceptance.'];
const delivery = (job, stage) => ({ version: 1, jobId: job.id, jobAttempt: 1, stage, ...identity(stage), outcome: 'completed', scope: 'complete',
  approval: ['qa', 'reviewer'].includes(stage) ? 'approved' : 'not_applicable', summary: `${stage} completed.`,
  acceptance: acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Fixture verified.' })), evidence: ['Fixture evidence.'], questions: [], decisions: [] });
async function snapshotFiles(files) { return Promise.all(files.map(async file => [file, await fs.readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })])); }
async function restoreFiles(saved) { for (const [file, content] of saved) { if (content === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, content); } }

async function interruptedIn(t, stopAt) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `quality-interrupt-${stopAt}-`)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: 'workspaces/fixture', repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, `receipt-${stopAt}`, { id: `quality-${stopAt}`, business: 'agency', kind: 'code', provider: 'orca', title: 'Interrumpir calidad',
    prompt: 'Complete the fixture acceptance.', contract: { acceptance }, workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2,
    coordination: { requestId: 'coord-quality0001', runId, senderId, business: 'agency' } });
  const data = path.join(root, 'data');
  let crash;
  await createAutoRunner(root, { verify, captureSnapshot: async () => snapshot, worker: async (job, ctx) => {
    for (const stage of ['ux', 'developer', 'qa', 'reviewer']) {
      const value = delivery(job, stage);
      await ctx.reportStage({ key: stage, status: 'running', dispatchStatus: 'active', ...identity(stage), attempt: job.attempts, taskInputAttempt: 1 });
      if (stage === stopAt) {
        if (stage === 'reviewer') await ctx.reportStage({ key: stage, status: 'running', dispatchStatus: 'awaiting_exit' });
        // The executor dies here: keep the files exactly as persisted while the stage is active.
        const names = (await fs.readdir(data, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.endsWith('.lock')).map(entry => entry.name);
        crash = await snapshotFiles([...names.map(name => path.join(data, name)), path.join(workspace, '.git', 'centro-executor.lock')]);
        throw new Error('process killed');
      }
      const artifact = await saveStageReport(root, { ...value, workerState: 'succeeded' }, JSON.stringify(value), value);
      await ctx.reportStage({ key: stage, status: 'succeeded', ...identity(stage), attempt: job.attempts, taskInputAttempt: 1, artifact, delivery: value,
        approvalOutcome: value.approval, summary: value.summary, dispatchStatus: 'completed', dispatchSettled: true });
      if (stage === 'developer') await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, repository: 'fixture/repo', sourceBranch: 'feature', baseBranch: 'main',
        phase: 'validation_pending', status: 'validating', needsAttention: false, error: null,
        validation: { version: 1, jobId: job.id, receiptId: job.autoIntent.receiptId, attempt: 1, runId, workspace, branch: 'feature', developerTaskId: identity('developer').taskId,
          developerDispatchId: identity('developer').dispatchId, developerArtifactSha256: artifact.sha256, cycleId: 'attempt-1', snapshot, capturedAt: new Date().toISOString() } });
    }
  } }).tick();
  if (!crash) assert.fail('setup did not reach the interruption: ' + JSON.stringify((await loadState(root)).jobs[0].error));
  await restoreFiles(crash);
  assert.equal((await loadState(root)).jobs[0].state, 'running');
  await createAutoRunner(root, { verify, worker: async () => assert.fail('detection never starts a worker') }).tick();
  const interrupted = (await loadState(root)).jobs[0];
  assert.equal(interrupted.state, 'needs_attention'); assert.equal(interrupted.error.code, 'interrupted'); assert.equal(interrupted.workflow.currentStage, stopAt);
  const record = (await readAutoRun(root)).integrations[sent.receipt.id];
  const exited = { ...identity(stopAt), state: 'succeeded', liveness: 'exited' };
  const recover = options => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, captureSnapshot: async () => snapshot, inspectDispatch: async () => exited, ...options });
  return { root, workspace, verify, recover, exited, interrupted, record, jobId: sent.job.id, receiptId: sent.receipt.id, stopAt };
}

// Native fake for re-admission: the interrupted dispatch is only read; a worker may start only for a later stage.
function nativeFor(f, starts) {
  const job = { id: f.jobId };
  const later = ['qa', 'reviewer'].slice(['qa', 'reviewer'].indexOf(f.stopAt) + 1);
  const known = () => [f.stopAt, ...starts];
  return async args => {
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: f.workspace }] };
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    if (args[1] === 'worker-start') { const stage = later[starts.length]; assert.ok(stage, 'no worker may start for the interrupted or an earlier stage'); starts.push(stage); return identity(stage); }
    if (args[1] === 'worker-show') { const stage = known().find(key => identity(key).dispatchId === args[args.indexOf('--dispatch') + 1]); assert.ok(stage); return { ...identity(stage), state: 'succeeded', liveness: 'exited', workspace: f.workspace }; }
    if (args[1] === 'inbox') return { messages: known().map(stage => ({ id: `msg_quality_${stage}`, type: 'worker_done', run_id: runId, to_handle: `run:${runId}`,
      payload: { ...identity(stage), outcome: 'succeeded' }, body: JSON.stringify(delivery(job, stage)) })) };
    assert.fail('Unexpected native command: ' + args.join(' '));
  };
}

for (const stopAt of ['qa', 'reviewer']) test(`an executor interrupted during ${stopAt} resumes the exact dispatch in the same attempt and keeps the sealed validation`, async t => {
  const f = await interruptedIn(t, stopAt);
  assert.equal(settledOrcaObservation(f.interrupted)?.dispatchId, identity(stopAt).dispatchId);
  const segment = f.interrupted.attemptHistory.at(-1); assert.equal(segment.error, 'interrupted'); assert.equal(segment.attempt, 1);
  const queued = await f.recover();
  assert.equal(queued.state, 'queued'); assert.equal(queued.attempts, 1);
  assert.equal(queued.livenessResume.mode, 'same_attempt_liveness'); assert.equal(queued.livenessResume.stage, stopAt);
  assert.equal(queued.livenessResume.dispatchId, identity(stopAt).dispatchId); assert.match(queued.livenessResume.integrationRecordHash, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readAutoRun(f.root)).integrations[f.receiptId], f.record, 'the sealed validation is untouched');
  let integrations = 0; const starts = [];
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot,
    worker: (job, ctx) => runOrca(job, ctx, { command: nativeFor(f, starts), verifyDestination: f.verify, captureSnapshot: async () => snapshot,
      integrate: async (job, _ctx, options) => {
        integrations++; assert.equal(job.attempts, 1);
        assert.equal(options.previous.phase, 'validation_approved'); assert.equal(options.previous.validation.snapshot, snapshot);
        assert.equal(options.previous.validation.capturedAt, f.record.validation.capturedAt, 'the pre-QA capture is the original one');
        for (const stage of ['qa', 'reviewer']) assert.equal(options.previous.validation.approvals[stage].dispatchId, identity(stage).dispatchId);
        await options.persist({ ...options.previous, phase: 'complete', status: 'completed' }); return { phase: 'complete' };
      } }) }).tick();
  const done = (await loadState(f.root)).jobs[0];
  assert.equal(done.state, 'succeeded', JSON.stringify(done.error)); assert.equal(done.attempts, 1); assert.equal(integrations, 1);
  assert.deepEqual(starts, stopAt === 'qa' ? ['reviewer'] : [], 'only stages after the interrupted one start a worker');
  assert.equal(done.workflow.steps.find(item => item.key === stopAt).dispatchId, identity(stopAt).dispatchId);
  assert.deepEqual(done.attemptHistory.map(item => item.attempt), [1, 1]);
});

test('an interrupted quality stage does not resume with a live worker, another dispatch, an altered validation or changed files', async t => {
  const f = await interruptedIn(t, 'reviewer');
  const lock = await fs.readFile(path.join(f.workspace, '.git', 'centro-executor.lock'), 'utf8');
  for (const observed of [{ ...f.exited, state: 'running', liveness: 'live' }, { ...f.exited, liveness: 'unverifiable' }, { ...f.exited, dispatchId: 'ctx_foreign0001' }]) {
    await assert.rejects(f.recover({ inspectDispatch: async () => observed }), /Orca no acredita/);
  }
  const auto = path.join(f.root, 'data', 'auto-run.json');
  const original = await fs.readFile(auto, 'utf8');
  for (const tamper of [record => { record.validation.snapshot = 'b'.repeat(64); }, record => { record.validation.attempt = 2; }, record => { record.validation.developerDispatchId = 'ctx_other0001'; },
    record => { record.phase = 'validation_approved'; }, record => { record.commitSha = 'c'.repeat(40); }]) {
    const state = JSON.parse(original); tamper(state.integrations[f.receiptId]); await fs.writeFile(auto, JSON.stringify(state));
    await assert.rejects(f.recover(), /validación sellada/);
  }
  await fs.writeFile(auto, original);
  await assert.rejects(f.recover({ captureSnapshot: async () => 'c'.repeat(64) }), /archivos cambiaron/);
  assert.equal(await fs.readFile(path.join(f.workspace, '.git', 'centro-executor.lock'), 'utf8'), lock, 'no refusal released the checkout');
  const job = (await loadState(f.root)).jobs[0]; assert.equal(job.state, 'needs_attention'); assert.equal(job.attempts, 1);
  // A validation altered after the recovery was queued blocks the admission instead of starting the stage.
  await f.recover();
  const state = JSON.parse(await fs.readFile(auto, 'utf8')); state.integrations[f.receiptId].validation.snapshot = 'd'.repeat(64); await fs.writeFile(auto, JSON.stringify(state));
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async () => assert.fail('an altered validation must not be admitted') }).tick();
  const receipt = (await readAutoRun(f.root)).receipts[0];
  assert.equal(receipt.status, 'blocked'); assert.match(receipt.reason, /validación sellada cambió/);
});
