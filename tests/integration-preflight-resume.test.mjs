import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, recoverKnownDispatchReceipt, retryCheckoutAdmission, setAutoRun } from '../auto-run.mjs';
import { loadState, resolveJob } from '../queue.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { inspectRecoveryDispatch } from '../panel/dispatch-recovery.mjs';
import { effectFreeIntegrationRecord, inspectEffectFreeIntegration } from '../integration-recovery.mjs';
import { pullRequestIdentityFields } from '../github-integration.mjs';

// Improvement 29 (D4) and F14: a `gh` failure in validation_approved, before any
// commit, push or PR, must be resumable in the same attempt and must not pin the
// checkout lock forever once the remote confirms that nothing happened.
const snapshot = 'a'.repeat(64), runId = 'run_preflight0001', senderId = 'term_coordinator001';
const ghError = 'gh falló o la respuesta fue ambigua; consulta el estado remoto antes de continuar.';
const identity = stage => ({ runId, taskId: `task_old_${stage}`, dispatchId: `ctx_old_${stage}` });
const SHA = { local: 'a'.repeat(40), base: 'b'.repeat(40) };
async function patchJob(root, change) {
  const state = await loadState(root); change(state.jobs[0], state);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, at: new Date().toISOString(), patch: { jobs: state.jobs, budget: state.budget } }) + '\n');
}
async function patchAuto(root, change) {
  const state = await readAutoRun(root); change(state);
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
}
function delivery(job, stage) {
  return { version: 1, jobId: job.id, jobAttempt: 1, stage, ...identity(stage), outcome: 'completed', scope: 'complete',
    approval: ['qa', 'reviewer'].includes(stage) ? 'approved' : 'not_applicable', summary: `${stage} completed.`,
    acceptance: job.contract.acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Fixture verified.' })), evidence: ['Fixture evidence.'], questions: [], decisions: [] };
}
const effectFree = (job, record) => ({ kind: 'effect_free_integration', jobId: job.id, receiptId: record.receiptId, phase: record.phase ?? null, openPullRequests: 0 });

// Runs the pipeline to a sealed validation and then fails the integration the way
// orca-provider does when gh fails before preflight_complete (job 7 of EOC-E2E-01).
async function fixture(t, { workspaceName = 'fixture', id = 'preflight-job', receiptId = 'receipt-preflight' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'integration-preflight-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', workspaceName); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const destination = { workspace, checkout: `workspaces/${workspaceName}`, repository: 'fixture/repo', branch: 'feature', baseBranch: 'main', sha: SHA.local, remoteSha: SHA.local, baseSha: SHA.base, verified: true };
  const verify = async () => structuredClone(destination);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const sent = await confirmSubmission(root, receiptId, { id, business: 'agency', kind: 'code', provider: 'orca',
    title: 'Integrar tras aprobación', prompt: 'Complete the fixture acceptance.', contract: { acceptance: ['Complete the fixture acceptance.'] }, workspace, isolated: true, branch: 'feature', destination, maxAttempts: 2,
    coordination: { requestId: 'coord-preflight001', runId, senderId, business: 'agency' } });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    let developer;
    for (const stage of ['ux', 'developer', 'qa', 'reviewer']) {
      const value = delivery(job, stage);
      await ctx.reportStage({ key: stage, status: 'running', ...identity(stage), attempt: 1 });
      const artifact = await saveStageReport(root, { ...value, workerState: 'succeeded' }, JSON.stringify(value), value);
      if (stage === 'developer') {
        developer = artifact;
        await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, repository: 'fixture/repo', sourceBranch: 'feature', baseBranch: 'main',
          phase: 'validation_pending', status: 'validating', needsAttention: false, error: null,
          validation: { version: 1, snapshot, attempt: 1, cycleId: 'attempt-1', jobId: job.id, receiptId: job.autoIntent.receiptId, runId, workspace, branch: job.branch,
            developerTaskId: identity('developer').taskId, developerDispatchId: identity('developer').dispatchId, developerArtifactSha256: artifact.sha256 } });
      }
      await ctx.reportStage({ key: stage, status: 'succeeded', ...identity(stage), attempt: 1, taskInputAttempt: 1, artifact, delivery: value,
        approvalOutcome: value.approval, summary: value.summary, dispatchStatus: 'completed', dispatchSettled: true });
    }
    const sealed = await readAutoRun(root);
    const record = sealed.integrations[job.autoIntent.receiptId];
    await persistIntegration(root, { ...record, phase: 'validation_approved', status: 'validated',
      validation: { ...record.validation, approvedAt: new Date().toISOString(), approvals: Object.fromEntries(['qa', 'reviewer'].map(stage => [stage, { taskId: identity(stage).taskId, dispatchId: identity(stage).dispatchId, artifactSha256: job.workflow.steps.find(step => step.key === stage)?.artifact?.sha256 ?? null }])) } });
    await ctx.reportStage({ key: 'integration', status: 'running', summary: 'Revisión aprobada; preparando preflight de integración.' });
    // gh fails on `pr list` (unknown JSON field baseRefOid): no preflight_complete, commit_intent or later phase was saved.
    await persistIntegration(root, { jobId: job.id, receiptId: job.autoIntent.receiptId, status: 'needs_attention', needsAttention: true, error: ghError });
    await ctx.reportStage({ key: 'integration', status: 'blocked', error: 'integration_needs_attention', summary: ghError });
    throw Object.assign(new Error(ghError), { code: 'github_integration_needs_attention', uncertain: true });
  } }).tick();
  const command = async args => {
    if (args[1] === 'run-show') return { run: { id: runId, coordinator_handle: senderId } };
    if (args[0] === 'terminal') return { terminal: { handle: senderId, connected: true, writable: true } };
    assert.equal(args[1], 'worker-show'); const dispatchId = args[args.indexOf('--dispatch') + 1];
    const stage = ['ux', 'developer', 'qa', 'reviewer'].find(key => identity(key).dispatchId === dispatchId); assert.ok(stage, dispatchId);
    return { ...identity(stage), state: 'succeeded', liveness: 'exited', workspace };
  };
  const inspect = async expected => inspectRecoveryDispatch(root, (await loadState(root)).jobs[0], expected, { command, captureSnapshot: async () => snapshot });
  const recover = options => recoverKnownDispatchReceipt(root, sent.job.id, { confirm: true, verify, inspectDispatch: inspect, inspectIntegrationEffects: async (_root, job, record) => effectFree(job, record), ...options });
  const before = (await loadState(root)).jobs[0];
  assert.equal(before.state, 'needs_attention'); assert.equal(before.error.code, 'github_integration_needs_attention'); assert.equal(before.attempts, 1);
  const record = (await readAutoRun(root)).integrations[sent.receipt.id];
  assert.equal(record.phase, 'validation_approved'); assert.equal(record.status, 'needs_attention'); assert.equal(record.validation.approvals.qa.dispatchId, identity('qa').dispatchId);
  return { root, workspace, destination, verify, recover, before, record, jobId: sent.job.id, receiptId: sent.receipt.id, lockPath: path.join(workspace, '.git', 'centro-executor.lock') };
}

test('a gh failure in validation_approved without effects resumes in the same attempt once the remote confirms no commit, push or PR', async t => {
  const f = await fixture(t);
  const seen = [];
  const queued = await f.recover({ inspectIntegrationEffects: async (root, job, record, options) => {
    seen.push({ root, jobId: job.id, phase: record.phase, historyTypes: options.history.map(item => item.type) });
    return effectFree(job, record);
  } });
  assert.equal(seen.length, 1); assert.equal(seen[0].root, f.root); assert.equal(seen[0].jobId, f.jobId); assert.equal(seen[0].phase, 'validation_approved');
  assert.ok(seen[0].historyTypes.includes('github_integration'));
  assert.equal(queued.state, 'queued'); assert.equal(queued.attempts, 1);
  assert.equal(queued.livenessResume.mode, 'same_attempt_integration_validation'); assert.equal(queued.livenessResume.stage, 'integration');
  assert.equal(queued.livenessResume.integrationEffects.kind, 'effect_free_integration');
  for (const stage of ['ux', 'developer']) assert.deepEqual(queued.workflow.steps.find(item => item.key === stage), f.before.workflow.steps.find(item => item.key === stage));
  for (const stage of ['qa', 'reviewer', 'integration']) assert.equal(queued.workflow.steps.find(item => item.key === stage).status, 'queued');
  const auto = await readAutoRun(f.root);
  assert.equal(auto.receipts[0].status, 'pending'); assert.equal(auto.receipts[0].dispatchRecovery.integrationEffects.kind, 'effect_free_integration');
  assert.equal(auto.integrations[f.receiptId].phase, 'validation_pending'); assert.equal(auto.integrations[f.receiptId].manifest, undefined);
  assert.equal(auto.receipts[0].integrationRecoveryHistory[0].originalRecord.phase, 'validation_approved');
  await assert.rejects(fs.access(f.lockPath), { code: 'ENOENT' });
  // Idempotent replay: the ready recovery neither inspects Orca nor the remote again.
  await f.recover({ inspectDispatch: async () => assert.fail('ready recovery must not inspect'), inspectIntegrationEffects: async () => assert.fail('ready recovery must not re-check effects') });
  let admitted = 0;
  await createAutoRunner(f.root, { verify: f.verify, captureSnapshot: async () => snapshot, worker: async job => {
    admitted++; assert.equal(job.attempts, 1); assert.equal(job.livenessResume.phase, 'consumed');
    return { text: 'Revalidación e integración completadas.' };
  } }).tick();
  assert.equal(admitted, 1);
  assert.equal((await loadState(f.root)).jobs[0].state, 'succeeded');
});

test('a remote that cannot confirm the absence of effects, or a record with effects, keeps the integration blocked and the lock in place', async t => {
  const f = await fixture(t);
  const lock = await fs.readFile(f.lockPath, 'utf8');
  await assert.rejects(f.recover({ inspectIntegrationEffects: async () => { throw new Error('La rama remota cambió desde el baseline; no se descarta un push.'); } }), /rama remota/);
  await assert.rejects(f.recover({ inspectIntegrationEffects: async () => ({ kind: 'something_else' }) }), /no tuvo efectos/);
  for (const extra of [{ commitSha: 'c'.repeat(40) }, { manifest: snapshot }, { prNumber: 3 }, { phase: 'commit_intent' }, { phase: 'preflight_complete' }]) {
    await patchAuto(f.root, state => { state.integrations[f.receiptId] = { ...f.record, ...extra }; });
    await assert.rejects(f.recover({ inspectIntegrationEffects: async () => assert.fail('a record with effects must not consult the remote') }), /manifiesto/);
  }
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = f.record; state.history.push({ type: 'github_integration', jobId: f.jobId, receiptId: f.receiptId, phase: 'commit_intent', at: new Date().toISOString() }); });
  await assert.rejects(f.recover({ inspectIntegrationEffects: async () => assert.fail('history with an effect intent must not consult the remote') }), /manifiesto durable/);
  assert.equal(await fs.readFile(f.lockPath, 'utf8'), lock);
  assert.equal((await loadState(f.root)).jobs[0].state, 'needs_attention');
});

test('retry-checkout releases the lock of a resolved job whose only integration record is a confirmed effect-free failure', async t => {
  const f = await fixture(t);
  await resolveJob(f.root, f.jobId, { confirm: true });
  await patchAuto(f.root, state => { state.receipts[0].status = 'reviewed'; });
  await fs.writeFile(f.lockPath, JSON.stringify({ jobId: f.jobId, receiptId: f.receiptId, attempt: 1, pid: 2147483647 }));
  const next = await confirmSubmission(f.root, 'receipt-next', { id: 'next-job', business: 'agency', kind: 'code', provider: 'orca', title: 'Siguiente encargo',
    prompt: 'Complete the fixture acceptance.', contract: { acceptance: ['Complete the fixture acceptance.'] }, workspace: f.workspace, isolated: true, branch: 'feature', destination: f.destination, maxAttempts: 2 });
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('the locked checkout must not admit') }).tick();
  assert.equal((await readAutoRun(f.root)).receipts.at(-1).blockCode, 'checkout_locked');
  const inspectWorker = async (_root, workspace, step) => { assert.equal(workspace, f.workspace); assert.ok(step.dispatchId); };
  const previous = (await loadState(f.root)).jobs[0];
  // With a record carrying an effect, the lock stays regardless of the remote.
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = { ...f.record, prNumber: 7 }; });
  await assert.rejects(retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: async () => assert.fail('no remote check for a record with effects') }), /cancelado y revisado/);
  await patchAuto(f.root, state => { state.integrations[f.receiptId] = f.record; });
  // The remote must confirm; a refusal keeps the lock.
  await assert.rejects(retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: async () => { throw new Error('Existe una PR abierta para esta rama; la integración no fue inocua.'); } }), /PR abierta/);
  await fs.access(f.lockPath);
  const checked = [];
  const reopened = await retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: async (_root, job, record) => { checked.push([job.id, record.phase]); return effectFree(job, record); } });
  assert.equal(reopened.status, 'pending'); assert.deepEqual(checked, [[previous.id, 'validation_approved']]);
  await assert.rejects(fs.access(f.lockPath), { code: 'ENOENT' });
  assert.equal((await readAutoRun(f.root)).history.find(item => item.type === 'checkout_admission_reopened').previousOwner.integrationEffects.kind, 'effect_free_integration');
});

test('effectFreeIntegrationRecord accepts only pre-effect failures without effect fields or effect history', () => {
  const base = { jobId: 'j1', receiptId: 'r1', status: 'needs_attention', phase: 'validation_approved' };
  assert.equal(effectFreeIntegrationRecord(base), true);
  assert.equal(effectFreeIntegrationRecord({ ...base, phase: 'validation_pending' }), true);
  assert.equal(effectFreeIntegrationRecord({ ...base, phase: undefined }), true);
  assert.equal(effectFreeIntegrationRecord({ ...base, status: 'validated' }), false);
  for (const phase of ['preflight_complete', 'commit_intent', 'commit_confirmed', 'push_intent', 'pr_intent', 'merge_intent', 'complete']) assert.equal(effectFreeIntegrationRecord({ ...base, phase }), false);
  for (const key of ['manifest', 'commitSha', 'prNumber', 'prUrl', 'mergeSha', 'pushedAt', 'mergedAt']) assert.equal(effectFreeIntegrationRecord({ ...base, [key]: 'x' }), false);
  const history = [{ type: 'github_integration', jobId: 'j1', phase: 'validation_pending' }, { type: 'github_integration', jobId: 'j1', phase: 'validation_approved' }, { type: 'github_integration', jobId: 'j1', phase: undefined }];
  assert.equal(effectFreeIntegrationRecord(base, history), true);
  assert.equal(effectFreeIntegrationRecord(base, [...history, { type: 'github_integration', jobId: 'j1', phase: 'commit_intent' }]), false);
  assert.equal(effectFreeIntegrationRecord(base, [{ type: 'github_integration', jobId: 'other', phase: 'commit_intent' }]), true);
  assert.equal(effectFreeIntegrationRecord(null), false);
});

test('inspectEffectFreeIntegration confirms unchanged remote refs, unchanged HEAD and no open PR through injected adapters', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'effect-free-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'repo');
  const job = { id: 'j1', workspace, branch: 'feature', destination: { repository: 'Owner/Repo', baseBranch: 'main', sha: SHA.local, remoteSha: SHA.local, baseSha: SHA.base } };
  const record = { jobId: 'j1', receiptId: 'r1', repository: 'Owner/Repo', sourceBranch: 'feature', baseBranch: 'main', phase: 'validation_approved', status: 'needs_attention' };
  const remote = { origin: 'git@github.com:Owner/Repo.git', head: SHA.local, feature: SHA.local, main: SHA.base, prs: [] };
  const git = async args => {
    if (args[0] === 'remote') return remote.origin;
    if (args[0] === 'rev-parse') return remote.head;
    if (args[0] === 'ls-remote') return `${remote[args.at(-1)]}\trefs/heads/${args.at(-1)}`;
    assert.fail('unexpected git ' + args.join(' '));
  };
  const gh = async args => { assert.deepEqual(args.slice(0, 2), ['pr', 'list']); assert.ok(args.includes(pullRequestIdentityFields)); return JSON.stringify(remote.prs); };
  const proof = await inspectEffectFreeIntegration(root, job, record, { git, gh });
  assert.deepEqual(proof, { kind: 'effect_free_integration', jobId: 'j1', receiptId: 'r1', phase: 'validation_approved', repository: 'owner/repo', sourceBranch: 'feature', baseBranch: 'main', headSha: SHA.local, remoteSourceSha: SHA.local, remoteBaseSha: SHA.base, openPullRequests: 0 });
  const pr = { number: 4, url: 'https://github.com/Owner/Repo/pull/4', state: 'OPEN', headRefOid: 'd'.repeat(40), baseRefOid: SHA.base, headRefName: 'feature', baseRefName: 'main', isCrossRepository: false, headRepository: { name: 'Repo' }, headRepositoryOwner: { login: 'Owner' } };
  for (const [label, change, pattern] of [
    ['moved remote source', () => { remote.feature = 'd'.repeat(40); }, /rama remota cambió/],
    ['moved remote base', () => { remote.main = 'e'.repeat(40); }, /rama base remota/],
    ['local commit', () => { remote.head = 'f'.repeat(40); }, /commit posterior/],
    ['open PR', () => { remote.prs = [pr]; }, /PR abierta/],
    ['other origin', () => { remote.origin = 'https://github.com/other/repo.git'; }, /Origin cambió/],
  ]) {
    const saved = structuredClone(remote); change();
    await assert.rejects(inspectEffectFreeIntegration(root, job, record, { git, gh }), pattern, label);
    Object.assign(remote, saved);
  }
  await assert.rejects(inspectEffectFreeIntegration(root, job, { ...record, commitSha: 'c'.repeat(40) }, { git, gh }), /anterior a cualquier efecto/);
  await assert.rejects(inspectEffectFreeIntegration(root, job, record, { git, gh, history: [{ type: 'github_integration', jobId: 'j1', phase: 'commit_intent' }] }), /anterior a cualquier efecto/);
  await assert.rejects(inspectEffectFreeIntegration(root, { ...job, destination: { ...job.destination, sha: undefined } }, record, { git, gh }), /no permite comprobar/);
  // A direct push to the base branch has no PR to list: gh is never called.
  const direct = { ...job, branch: 'main', destination: { ...job.destination, remoteSha: SHA.base, sha: SHA.base } };
  remote.head = SHA.base;
  const directProof = await inspectEffectFreeIntegration(root, direct, { ...record, sourceBranch: 'main' }, { git, gh: async () => assert.fail('no PR listing for same-branch integration') });
  assert.equal(directProof.openPullRequests, 0);
});

test('retry-checkout accepts a lock written by this process for a job that is now cancelled and reviewed (F12)', async t => {
  const f = await fixture(t);
  await resolveJob(f.root, f.jobId, { confirm: true });
  await patchAuto(f.root, state => { state.receipts[0].status = 'reviewed'; });
  await fs.writeFile(f.lockPath, JSON.stringify({ jobId: f.jobId, receiptId: f.receiptId, attempt: 1, pid: process.pid }));
  const next = await confirmSubmission(f.root, 'receipt-next', { id: 'next-job', business: 'agency', kind: 'code', provider: 'orca', title: 'Siguiente encargo',
    prompt: 'Complete the fixture acceptance.', contract: { acceptance: ['Complete the fixture acceptance.'] }, workspace: f.workspace, isolated: true, branch: 'feature', destination: f.destination, maxAttempts: 2 });
  await createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('the locked checkout must not admit') }).tick();
  assert.equal((await readAutoRun(f.root)).receipts.at(-1).blockCode, 'checkout_locked');
  const inspectWorker = async () => {};
  const effects = async (_root, job, record) => effectFree(job, record);
  // Still cancelled but not yet reviewed by the operator: the lock stays even though the pid is ours.
  await patchJob(f.root, job => { delete job.reviewedAt; });
  await assert.rejects(retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: effects }), /cancelado y revisado/);
  await patchJob(f.root, job => { job.reviewedAt = new Date().toISOString(); });
  // A still-running stage of the previous job keeps the lock as well.
  await patchJob(f.root, job => { job.workflow.steps.find(step => step.key === 'reviewer').status = 'running'; });
  await assert.rejects(retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: effects }), /aún activas/);
  await patchJob(f.root, job => { job.workflow.steps.find(step => step.key === 'reviewer').status = 'succeeded'; });
  await fs.access(f.lockPath);
  const reopened = await retryCheckoutAdmission(f.root, next.receipt.id, { confirm: true, inspectWorker, inspectIntegrationEffects: effects });
  assert.equal(reopened.status, 'pending');
  await assert.rejects(fs.access(f.lockPath), { code: 'ENOENT' });
});
