import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bindWorkflowV2Approval, buildV2Task, normalizeWorkflowV2, priorV2Submission, resolveWorkflowV2Approval, runWorkflowV2Gate,
  v2CandidateTaskId, workflowV2Resumable } from '../workflow-v2-gate.mjs';
import { confirmSubmission, createAutoRunner, readAutoRun, readmitWorkflowV2Receipt, resumeWorkflowV2Receipt, retryAutoReceipt, setAutoRun } from '../auto-run.mjs';
import { loadState } from '../queue.mjs';

// U7 phase B: integrate only the candidate the owner approved in Workflow V2; a changed candidate needs
// a new approval; a restart neither loses the approval nor integrates twice. Off by default.
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);
const ENTRY = { stateRoot: '/srv/wfv2/state', reviewerConfig: null, allowedPaths: ['src/'], checks: ['unit-tests'] };
const config = (extra = {}) => ({ version: 1, engineeringSystem: '/srv/engineering-system', projects: { obi: { ...ENTRY, ...extra } } });
const entryB = () => ({ ...normalizeWorkflowV2(config({ integrateAfterApproval: true })).projects.obi, engineeringSystem: '/srv/engineering-system', python: 'python3' });
const TASK = v2CandidateTaskId({ id: 'v2b-1' }, A);
const submitted = (extra = {}) => ({ task: TASK, outcome: 'owner_pending', status: 'pendiente_owner', candidate: C, qaSnapshot: A, identity: 'id-1', evidenceId: 'ev-1', ...extra });
const statusRun = (value, calls = []) => async argv => { calls.push(argv); return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify(value) }; };
const ctxWith = updates => ({ signal: new AbortController().signal, async reportStage(update) { updates.push(update); } });

async function tempRoot(t, prefix = 'wfv2-b-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('phase B is opt-in per project and validated', () => {
  assert.equal(normalizeWorkflowV2(config()).projects.obi.integrateAfterApproval, false);
  assert.equal(normalizeWorkflowV2(config({ integrateAfterApproval: true })).projects.obi.integrateAfterApproval, true);
  assert.throws(() => normalizeWorkflowV2(config({ integrateAfterApproval: 'yes' })), { code: 'workflow_v2_config_invalid' });
});

test('phase B gives each candidate its own V2 task; phase A keeps the job id', () => {
  const job = { id: 'v2b-1', kind: 'code', projectId: 'obi', title: 'x', workflowV2Snapshot: A };
  assert.equal(buildV2Task(job, entryB()).id, `v2b-1-${'a'.repeat(12)}`);
  assert.equal(buildV2Task({ ...job, workflowV2Snapshot: B }, entryB()).id, `v2b-1-${'b'.repeat(12)}`);
  assert.equal(buildV2Task(job, normalizeWorkflowV2(config()).projects.obi).id, 'v2b-1');
});

test('a submission is found only for the exact QA fingerprint, newest first', () => {
  const job = { workflow: { steps: [{ key: 'reviewer', workflowV2: submitted() }] },
    workflowHistory: [{ steps: [{ key: 'reviewer', workflowV2: submitted({ qaSnapshot: B, task: 'old' }) }] }] };
  assert.equal(priorV2Submission(job, A).task, TASK);
  assert.equal(priorV2Submission(job, B).task, 'old');
  assert.equal(priorV2Submission(job, C), null);
  assert.equal(priorV2Submission({ workflow: { steps: [{ key: 'reviewer', workflowV2: submitted({ identity: null }) }] } }, A), null, 'incomplete records do not count');
});

test('the approval is read from V2 and counts only for the identity and evidence that were submitted', async () => {
  const calls = [], updates = [];
  const binding = await resolveWorkflowV2Approval({}, ctxWith(updates), entryB(), submitted(),
    { run: statusRun({ task: TASK, status: 'aprobado', identity: 'id-1', evidence_id: 'ev-1' }, calls) });
  assert.deepEqual(binding, { task: TASK, identity: 'id-1', evidenceId: 'ev-1', candidate: C, qaSnapshot: A });
  assert.deepEqual(calls[0].slice(1), ['-m', 'wfv2.cli', '--repo', '/srv/wfv2/state', 'status', TASK], 'read-only status, never submit or approve');
  assert.deepEqual(updates.map(update => update.status), ['running', 'succeeded'], 'a stopped stage passes through running');
  assert.equal(updates.at(-1).workflowV2.outcome, 'approved');

  const cases = [
    [{ task: TASK, status: 'aprobado', identity: 'id-2', evidence_id: 'ev-1' }, 'workflow_v2_approval_mismatch'],
    [{ task: TASK, status: 'aprobado', identity: 'id-1', evidence_id: 'ev-2' }, 'workflow_v2_approval_mismatch'],
    [{ task: 'other', status: 'aprobado', identity: 'id-1', evidence_id: 'ev-1' }, 'workflow_v2_identity_mismatch'],
    [{ task: TASK, status: 'pendiente_owner', identity: 'id-1', evidence_id: 'ev-1' }, 'workflow_v2_owner_pending'],
    [{ task: TASK, status: 'rechazado' }, 'workflow_v2_rejected'],
    [{ task: TASK, status: 'aprobado' }, 'workflow_v2_unavailable'],
    [{ task: TASK, status: 'nueva' }, 'workflow_v2_unexpected'],
  ];
  for (const [status, code] of cases) {
    const seen = [];
    await assert.rejects(resolveWorkflowV2Approval({}, ctxWith(seen), entryB(), submitted(), { run: statusRun(status) }), { code }, JSON.stringify(status));
    assert.equal(seen.at(-1).status, 'blocked');
  }
  await assert.rejects(resolveWorkflowV2Approval({}, ctxWith([]), entryB(), submitted(), { run: async () => ({ code: 2, stdout: '', stderr: 'INTEGRITY ERROR', timedOut: false }) }),
    { code: 'workflow_v2_unavailable' });
});

test('the integration record is bound to one approval before any effect', async () => {
  const job = { id: 'v2b-1', branch: 'feature', autoIntent: { receiptId: 'r-1', eligible: true }, destination: { repository: 'o/r', baseBranch: 'main' } };
  const approval = { task: TASK, identity: 'id-1', evidenceId: 'ev-1', candidate: C, qaSnapshot: A };
  const saved = [];
  const bound = await bindWorkflowV2Approval(job, approval, { previous: null, persist: async record => saved.push(record) });
  assert.equal(bound.phase, 'validation_approved');
  assert.deepEqual(Object.fromEntries(Object.entries(bound.workflowV2Approval).filter(([key]) => key !== 'boundAt')), approval);
  assert.equal(saved.length, 1);
  const again = await bindWorkflowV2Approval(job, approval, { previous: { ...bound, phase: 'push_intent', commitSha: 'd'.repeat(40) }, persist: async record => saved.push(record) });
  assert.equal(again.phase, 'push_intent', 'a resumed record keeps its phase');
  assert.equal(saved.length, 1, 'the same binding is not written again');
  await assert.rejects(bindWorkflowV2Approval(job, { ...approval, identity: 'id-2' }, { previous: bound, persist: async () => {} }), { code: 'workflow_v2_approval_mismatch' });
  await assert.rejects(bindWorkflowV2Approval(job, approval, { previous: { phase: 'commit_confirmed', commitSha: 'd'.repeat(40) }, persist: async () => {} }), { code: 'workflow_v2_integration_unbound' });
});

test('phase B submit keeps integration pending and tells the owner to retry after approving', async () => {
  const updates = [];
  const job = { id: 'v2b-1', kind: 'code', projectId: 'obi', title: 'x', workflowV2Snapshot: A, workflow: { steps: [{ key: 'reviewer' }, { key: 'integration' }] } };
  const ctx = { ...ctxWith(updates), captureSnapshot: async () => A };
  const run = async argv => ({ code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ task: argv[argv.indexOf('submit') + 1], status: 'pendiente_owner', tier: 'FAST',
    identity: 'id-1', evidence_id: 'ev-1', reviews: [], steps: [{ unit: 'U1', candidate: C }] }) });
  const error = await runWorkflowV2Gate(job, ctx, entryB(), '/tmp/ws', { run }).catch(failure => failure);
  assert.equal(error.code, 'workflow_v2_owner_pending');
  assert.match(error.message, /reintenta este trabajo en el Centro/);
  assert.equal(updates.some(update => update.key === 'integration'), false, 'integration is not skipped');
  assert.deepEqual(priorV2Submission({ workflow: { steps: [{ key: 'reviewer', workflowV2: updates.at(-1).workflowV2 }] } }, A).task, TASK);
});

test('only a stop waiting for the owner, or an approved integration that stopped, can be resumed', () => {
  const base = (reviewer, integration = { key: 'integration', status: 'queued' }) => ({ state: 'needs_attention', kind: 'code',
    workflow: { steps: [{ key: 'qa', status: 'succeeded' }, { key: 'reviewer', ...reviewer }, integration] } });
  assert.equal(workflowV2Resumable(base({ status: 'blocked', error: 'workflow_v2_owner_pending', workflowV2: submitted() })), true);
  assert.equal(workflowV2Resumable(base({ status: 'succeeded', workflowV2: submitted({ outcome: 'approved' }) }, { key: 'integration', status: 'blocked', error: 'interrupted' })), true);
  assert.equal(workflowV2Resumable(base({ status: 'blocked', error: 'workflow_v2_rejected', workflowV2: submitted() })), false);
  assert.equal(workflowV2Resumable(base({ status: 'blocked', error: 'workflow_v2_owner_pending', workflowV2: submitted({ identity: undefined }) })), false);
  assert.equal(workflowV2Resumable(base({ status: 'succeeded', workflowV2: submitted({ outcome: 'owner_pending' }) }, { key: 'integration', status: 'blocked' })), false);
  assert.equal(workflowV2Resumable({ ...base({ status: 'blocked', error: 'workflow_v2_owner_pending', workflowV2: submitted() }), state: 'running' }), false);
});

// ---- runOrca: the second run after the owner's decision. No Orca stage is launched again.
async function governedRoot(t) {
  const root = await tempRoot(t, 'wfv2-b-run-');
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'workflow-v2.json'), JSON.stringify(config({ integrateAfterApproval: true })));
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, businesses: {}, history: [], integrations: {},
    receipts: [{ id: 'r-1', jobId: 'v2b-1', eligible: true, status: 'claimed' }] }));
  const workspace = path.join(root, 'workspaces', 'obi'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  return { root, workspace };
}
const stopped = (workspace, reviewer = { status: 'blocked', error: 'workflow_v2_owner_pending', workflowV2: submitted() }, integration = { status: 'queued' }) => ({
  id: 'v2b-1', business: 'agency', kind: 'code', provider: 'orca', projectId: 'obi', title: 'V2', prompt: 'Probar V2.', workspace, isolated: true, attempts: 2,
  autoIntent: { receiptId: 'r-1', eligible: true }, destination: { repository: 'o/r', baseBranch: 'main' },
  workflow: { runId: 'run_wfv2b1', currentStage: 'reviewer', steps: [
    { key: 'ux', status: 'succeeded', summary: 'Diseño listo.', taskId: 'task_b1', dispatchId: 'ctx_b1' },
    { key: 'developer', status: 'succeeded', summary: 'Implementado.', taskId: 'task_b2', dispatchId: 'ctx_b2' },
    { key: 'qa', status: 'succeeded', summary: 'Validación correcta.\nRESULTADO: APROBADO', taskId: 'task_b3', dispatchId: 'ctx_b3', approvalOutcome: 'approved', approvalDispatchId: 'ctx_b3', workflowV2Snapshot: A },
    { key: 'reviewer', ...reviewer }, { key: 'integration', ...integration }] },
});

async function resume(root, job, { status, snapshot = A, integrate } = {}) {
  const { runOrca } = await import('../orca-provider.mjs');
  const starts = [], updates = [], submits = [];
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: job.workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_wfv2b1' };
    if (args[1] === 'worker-start') { starts.push(args); throw new Error('no Orca stage may start on resume'); }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const ctx = { root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
  const runWorkflowV2 = async () => { submits.push(1); throw Object.assign(new Error('submit'), { code: 'workflow_v2_owner_pending' }); };
  const resolveWorkflowV2 = (j, c, entry, prior) => resolveWorkflowV2Approval(j, c, entry, prior, { run: statusRun(status) });
  const outcome = await runOrca(job, ctx, { command, runWorkflowV2, resolveWorkflowV2, captureSnapshot: async () => snapshot, integrate })
    .then(result => ({ ok: true, result }), error => ({ ok: false, code: error.code, error }));
  return { outcome, starts, updates, submits };
}
const readRecord = async root => JSON.parse(await fs.readFile(path.join(root, 'data', 'auto-run.json'), 'utf8')).integrations['r-1'];
const APPROVED = { task: TASK, status: 'aprobado', identity: 'id-1', evidence_id: 'ev-1' };

test('runOrca phase B: without approval nothing integrates and nothing is resubmitted', async t => {
  const { root, workspace } = await governedRoot(t);
  let integrations = 0;
  const run = await resume(root, stopped(workspace), { status: { ...APPROVED, status: 'pendiente_owner' }, integrate: async () => { integrations++; } });
  assert.equal(run.outcome.code, 'workflow_v2_owner_pending');
  assert.equal(integrations, 0);
  assert.equal(run.submits.length, 0, 'the same candidate is not submitted again');
  assert.equal(run.starts.length, 0);
});

test('runOrca phase B: the approved candidate is integrated exactly, with the approval bound first', async t => {
  const { root, workspace } = await governedRoot(t);
  const calls = [];
  const integrate = async (job, _ctx, { previous, persist }) => {
    calls.push({ snapshot: job.integrationSnapshot, previous });
    const record = { ...previous, phase: 'complete', status: 'completed', commitSha: 'd'.repeat(40), manifest: job.integrationSnapshot, mergeSha: 'e'.repeat(40) };
    await persist(record); return record;
  };
  const run = await resume(root, stopped(workspace), { status: APPROVED, integrate });
  assert.equal(run.outcome.ok, true, run.outcome.error?.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].snapshot, A, 'integrates the fingerprint QA validated and the owner approved');
  assert.equal(calls[0].previous.workflowV2Approval.identity, 'id-1', 'the approval was bound before the integration started');
  assert.equal(run.starts.length, 0);
  assert.equal(run.submits.length, 0);
  assert.equal(run.outcome.result.workflowV2.task, TASK);
  assert.deepEqual(run.updates.filter(update => update.key === 'reviewer').map(update => update.status), ['running', 'succeeded']);
  assert.equal((await readRecord(root)).workflowV2Approval.task, TASK);
});

test('runOrca phase B: a changed candidate or another approval is never integrated', async t => {
  let integrations = 0;
  const integrate = async () => { integrations++; return { phase: 'complete' }; };
  {
    const { root, workspace } = await governedRoot(t);
    const changed = await resume(root, stopped(workspace), { status: APPROVED, snapshot: B, integrate });
    assert.match(changed.outcome.code, /^workflow_v2_(qa_candidate_unverified|candidate_changed)$/);
  }
  {
    const { root, workspace } = await governedRoot(t);
    const other = await resume(root, stopped(workspace), { status: { ...APPROVED, identity: 'id-2' }, integrate });
    assert.equal(other.outcome.code, 'workflow_v2_approval_mismatch');
  }
  {
    const { root, workspace } = await governedRoot(t);
    const state = JSON.parse(await fs.readFile(path.join(root, 'data', 'auto-run.json'), 'utf8'));
    state.integrations['r-1'] = { jobId: 'v2b-1', receiptId: 'r-1', phase: 'validation_approved', workflowV2Approval: { task: 'other', identity: 'id-1', evidenceId: 'ev-1', candidate: C, qaSnapshot: A } };
    await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
    const rebound = await resume(root, stopped(workspace), { status: APPROVED, integrate });
    assert.equal(rebound.outcome.code, 'workflow_v2_approval_mismatch');
  }
  assert.equal(integrations, 0);
});

test('runOrca phase B: a restart mid-integration resumes the same record and never repeats an effect', async t => {
  const { root, workspace } = await governedRoot(t);
  const effects = [];
  // First run: the commit and the push intent are recorded, then the process dies before confirming.
  const crashing = async (job, _ctx, { previous, persist }) => {
    effects.push('commit');
    await persist({ ...previous, phase: 'push_intent', status: 'running', commitSha: 'd'.repeat(40), manifest: job.integrationSnapshot });
    throw new Error('proceso detenido');
  };
  const first = await resume(root, stopped(workspace), { status: APPROVED, integrate: crashing });
  assert.equal(first.outcome.ok, false);
  const afterCrash = await readRecord(root);
  assert.equal(afterCrash.phase, 'push_intent');
  const boundAt = afterCrash.workflowV2Approval.boundAt;
  // After the restart the reviewer is already approved and the integration step stopped.
  const resumedJob = stopped(workspace, { status: 'succeeded', workflowV2: submitted({ outcome: 'approved' }) }, { status: 'blocked', error: 'interrupted' });
  assert.equal(workflowV2Resumable({ ...resumedJob, state: 'needs_attention' }), true);
  const seen = [];
  const resuming = async (job, _ctx, { previous, persist }) => {
    seen.push(previous);
    if (previous.phase === 'complete') return previous;
    // Like github-integration: an existing commit and push intent are reconciled, not repeated.
    const record = { ...previous, phase: 'complete', status: 'completed', mergeSha: previous.commitSha, reconciled: true };
    await persist(record); return record;
  };
  const second = await resume(root, resumedJob, { status: APPROVED, integrate: resuming });
  assert.equal(second.outcome.ok, true, second.outcome.error?.message);
  assert.equal(seen[0].phase, 'push_intent', 'resumed from the recorded intent');
  assert.equal(seen[0].workflowV2Approval.boundAt, boundAt, 'the approval binding survived the restart unchanged');
  // A further retry after completion integrates nothing new.
  const third = await resume(root, resumedJob, { status: APPROVED, integrate: resuming });
  assert.equal(third.outcome.ok, true);
  assert.equal(seen[1].phase, 'complete');
  assert.deepEqual(effects, ['commit'], 'one commit in total');
  assert.equal((await readRecord(root)).phase, 'complete');
});

// ---- queue and receipt: resuming an eligible job after the owner's decision.
test('an eligible job waiting for the owner is resumed once, without the pre-dispatch retry', async t => {
  const root = await tempRoot(t, 'wfv2-b-auto-');
  await setAutoRun(root, 'agency', true, { confirm: true });
  const workspace = path.join(root, 'workspaces', 'obi'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sent = await confirmSubmission(root, 'receipt-v2b', { id: 'v2b-auto', business: 'agency', kind: 'code', title: 'V2', provider: 'orca', projectId: 'obi',
    prompt: 'Objetivo: probar V2. Criterio: el candidato aprobado se integra.', workspace, isolated: true, branch: 'feature',
    destination: { checkout: 'workspaces/obi', workspace, branch: 'feature', repository: 'o/r', baseBranch: 'main' },
    autoIntent: { receiptId: 'receipt-v2b', eligible: true } });
  const verify = async () => ({ checkout: 'workspaces/obi', workspace, branch: 'feature', repository: 'o/r', origin: 'https://github.com/o/r.git',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseBranch: 'main', baseSha: 'b'.repeat(40), verified: true });
  let runs = 0;
  const first = createAutoRunner(root, { verify, worker: async (job, ctx) => {
    runs++;
    for (const key of ['ux', 'developer']) await ctx.reportStage({ key, status: 'succeeded', summary: `${key} listo` });
    await ctx.reportStage({ key: 'qa', status: 'succeeded', summary: 'RESULTADO: APROBADO', workflowV2Snapshot: A });
    await ctx.reportStage({ key: 'reviewer', status: 'blocked', error: 'workflow_v2_owner_pending', summary: 'Decide en V2.', workflowV2: submitted({ task: 'v2b-auto-aaaaaaaaaaaa' }) });
    throw Object.assign(new Error('Decide tú en V2.'), { code: 'workflow_v2_owner_pending', uncertain: false });
  } });
  await first.tick();
  let job = (await loadState(root)).jobs.find(item => item.id === sent.job.id);
  assert.equal(job.state, 'needs_attention');
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
  await assert.rejects(retryAutoReceipt(root, job.id, { confirm: true, noDispatchConfirmed: true }), /no es un fallo previo al dispatch/, 'the pre-dispatch retry still refuses');
  await assert.rejects(resumeWorkflowV2Receipt(root, job.id), /Confirma/);
  await resumeWorkflowV2Receipt(root, job.id, { confirm: true });
  const receipt = (await readAutoRun(root)).receipts[0];
  job = (await loadState(root)).jobs.find(item => item.id === sent.job.id);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.retryAuthorizedAttempt, job.attempts);
  assert.equal(job.workflow.steps.find(step => step.key === 'reviewer').workflowV2.identity, 'id-1', 'the submission record survives the retry');
  await assert.rejects(resumeWorkflowV2Receipt(root, job.id, { confirm: true }), /no está esperando/, 'only once');
  // The approved candidate is uncommitted in the checkout: a clean-tree admission must not block it.
  const dirtyVerify = async (_root, _job, { requireClean = true } = {}) => {
    if (requireClean) throw Object.assign(new Error('Checkout no estaba limpio al admitir el job; se requiere revisión antes de ejecutar.'), { code: 'destination_dirty' });
    return verify();
  };
  const second = createAutoRunner(root, { verify: dirtyVerify, worker: async (current, ctx) => {
    runs++;
    assert.equal(priorV2Submission(current, A).task, 'v2b-auto-aaaaaaaaaaaa');
    // Same sequence resolveWorkflowV2Approval reports; the queue enforces the transitions.
    await ctx.reportStage({ key: 'reviewer', status: 'running', summary: 'Comprobando la aprobación.' });
    await ctx.reportStage({ key: 'reviewer', status: 'succeeded', summary: 'Aprobado en V2.', workflowV2: submitted({ task: 'v2b-auto-aaaaaaaaaaaa', outcome: 'approved' }) });
    await ctx.reportStage({ key: 'integration', status: 'succeeded', summary: 'Integrado.' });
    return { text: 'integrado' };
  } });
  await second.tick();
  assert.equal(runs, 2);
  const finished = (await loadState(root)).jobs.find(item => item.id === sent.job.id);
  assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  assert.equal((await loadState(root)).jobs.find(item => item.id === sent.job.id).state, 'succeeded');
  await second.tick(); assert.equal(runs, 2, 'nothing runs again');
});

test('a V2 resume blocked at admission by the dirty candidate is readmitted once and integrates', async t => {
  const root = await tempRoot(t, 'wfv2-b-readmit-');
  await setAutoRun(root, 'agency', true, { confirm: true });
  const workspace = path.join(root, 'workspaces', 'obi'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sent = await confirmSubmission(root, 'receipt-v2r', { id: 'v2r-auto', business: 'agency', kind: 'code', title: 'V2', provider: 'orca', projectId: 'obi',
    prompt: 'Objetivo: probar V2. Criterio: el candidato aprobado se integra.', workspace, isolated: true, branch: 'feature',
    destination: { checkout: 'workspaces/obi', workspace, branch: 'feature', repository: 'o/r', baseBranch: 'main' },
    autoIntent: { receiptId: 'receipt-v2r', eligible: true } });
  const observed = { checkout: 'workspaces/obi', workspace, branch: 'feature', repository: 'o/r', origin: 'https://github.com/o/r.git',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseBranch: 'main', baseSha: 'b'.repeat(40), verified: true };
  let dirty = false;
  const verify = async (_root, _job, { requireClean = true } = {}) => {
    if (dirty && requireClean) throw Object.assign(new Error('Checkout no estaba limpio al admitir el job; se requiere revisión antes de ejecutar.'), { code: 'destination_dirty' });
    return observed;
  };
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    for (const key of ['ux', 'developer']) await ctx.reportStage({ key, status: 'succeeded', summary: `${key} listo` });
    await ctx.reportStage({ key: 'qa', status: 'succeeded', summary: 'RESULTADO: APROBADO', workflowV2Snapshot: A });
    await ctx.reportStage({ key: 'reviewer', status: 'blocked', error: 'workflow_v2_owner_pending', summary: 'Decide en V2.', workflowV2: submitted({ task: 'v2r-auto-aaaaaaaaaaaa' }) });
    throw Object.assign(new Error('Decide tú en V2.'), { code: 'workflow_v2_owner_pending', uncertain: false });
  } }).tick();
  dirty = true;
  await resumeWorkflowV2Receipt(root, sent.job.id, { confirm: true });
  // Reproduce the receipt a previous version left: blocked at admission, job still queued.
  const auto = JSON.parse(await fs.readFile(path.join(root, 'data', 'auto-run.json'), 'utf8'));
  delete auto.receipts[0].workflowV2Resume; auto.receipts[0].status = 'blocked';
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(auto));
  let ran = 0;
  const runner = createAutoRunner(root, { verify, worker: async (current, ctx) => {
    ran++;
    await ctx.reportStage({ key: 'reviewer', status: 'running', summary: 'Comprobando la aprobación.' });
    await ctx.reportStage({ key: 'reviewer', status: 'succeeded', summary: 'Aprobado en V2.', workflowV2: submitted({ task: 'v2r-auto-aaaaaaaaaaaa', outcome: 'approved' }) });
    await ctx.reportStage({ key: 'integration', status: 'succeeded', summary: 'Integrado.' });
    return { text: 'integrado' };
  } });
  await runner.tick();
  assert.equal(ran, 0, 'a blocked receipt stops the lane until reviewed');
  await assert.rejects(readmitWorkflowV2Receipt(root, sent.job.id), /Confirma/);
  await readmitWorkflowV2Receipt(root, sent.job.id, { confirm: true });
  await assert.rejects(readmitWorkflowV2Receipt(root, sent.job.id, { confirm: true }), /no es una reanudación/, 'only once');
  await runner.tick();
  assert.equal(ran, 1);
  assert.equal((await loadState(root)).jobs.find(item => item.id === sent.job.id).state, 'succeeded');
});

test('a project can name its virtualenv for V2 checks; it reaches submit as --python-env', async () => {
  assert.equal(normalizeWorkflowV2(config()).projects.obi.pythonEnv, null);
  assert.throws(() => normalizeWorkflowV2(config({ pythonEnv: 'relative/venv' })), { code: 'workflow_v2_config_invalid' });
  const entry = { ...entryB(), pythonEnv: '/home/x/hf/.venv' };
  const seen = [];
  const run = async argv => { seen.push(argv); return { code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({ task: argv[argv.indexOf('submit') + 1], status: 'pendiente_owner',
    identity: 'id-1', evidence_id: 'ev-1', reviews: [], steps: [{ unit: 'U1', candidate: C }] }) }; };
  const job = { id: 'v2b-1', kind: 'code', projectId: 'obi', title: 'x', workflowV2Snapshot: A, workflow: { steps: [{ key: 'reviewer' }] } };
  await runWorkflowV2Gate(job, { ...ctxWith([]), captureSnapshot: async () => A }, entry, '/tmp/ws', { run }).catch(() => {});
  assert.deepEqual(seen[0].slice(seen[0].indexOf('--python-env'), seen[0].indexOf('--python-env') + 2), ['--python-env', '/home/x/hf/.venv']);
  const without = [];
  await runWorkflowV2Gate(job, { ...ctxWith([]), captureSnapshot: async () => A }, entryB(), '/tmp/ws', { run: async argv => { without.push(argv); return run(argv); } }).catch(() => {});
  assert.equal(without[0].includes('--python-env'), false);
});
