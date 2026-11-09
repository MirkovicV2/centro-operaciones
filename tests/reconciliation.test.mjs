import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { addJob, loadState, reconcileCodeJob, verifyOrcaApprovalTranscript, verifyOrcaRunRecords } from '../queue.mjs';
import { verifyReconciliationDestination } from '../reconciliation-destination.mjs';

const sha = 'abcdef01'.repeat(5);
const stageKeys = ['ux', 'developer', 'qa', 'reviewer'];
const approval = stage => ['qa', 'reviewer'].includes(stage) ? 'RESULTADO: APROBADO' : null;

async function fixture(t, { integration = false, partial = false, priorAttempt = false, retries = 0 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'centro-reconciliation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'agency-checkout');
  await addJob(root, { id: 'agency-reconcile', business: 'agency', kind: 'code', provider: 'orca', title: 'Cambio acotado',
    prompt: 'Entrega verificable.', workspace, isolated: true, branch: 'feature/local',
    destination: { workspace, checkout: 'workspaces/agency-checkout', branch: 'feature/local' },
    ...(integration ? { autoIntent: { eligible: true } } : {}),
  });
  const state = await loadState(root);
  const dispatches = [];
  for (const [index, stage] of stageKeys.entries()) {
    if (partial && index > 1) break;
    const attempts = stage === 'developer' ? retries + 1 : 1;
    for (let sequence = 1; sequence <= attempts; sequence++) dispatches.push({
      stage, dispatchId: `ctx_${stage}00000${sequence}`, taskId: `task_${stage}00000`, runId: 'run_generic0001',
      state: sequence < attempts ? 'failed' : 'succeeded', sequence, jobAttempt: priorAttempt && stage === 'ux' ? 1 : 2,
      parentTaskId: index ? `task_${stageKeys[index - 1]}00000` : null,
      retryOfDispatchId: sequence > 1 ? `ctx_${stage}00000${sequence - 1}` : null,
      approvalEvidence: sequence === attempts ? approval(stage) : null,
    });
  }
  const job = { ...state.jobs[0], attempts: 2, state: 'needs_attention', error: { code: 'interrupted' }, workflow: {
    ...state.jobs[0].workflow, runId: 'run_generic0001', status: 'needs_attention', currentStage: 'developer',
    steps: state.jobs[0].workflow.steps.map(step => {
      if (!['ux', 'developer'].includes(step.key)) return step;
      const first = dispatches.find(item => item.stage === step.key);
      return { ...step, status: step.key === 'ux' ? 'succeeded' : 'blocked', dispatchId: first.dispatchId, taskId: first.taskId,
        attempt: first.jobAttempt, dispatchStatus: step.key === 'ux' ? 'completed' : 'start_unknown' };
    }),
  } };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1,
    type: 'fixture_interrupted', at: new Date().toISOString(), patch: { jobs: [job] } }) + '\n');
  const decision = { schema: 2, decisionId: 'decision-generic-001', jobId: job.id, scope: partial ? 'partial' : 'complete', dispatches,
    destination: { checkout: 'workspaces/agency-checkout', branch: 'feature/local', sha, verified: true },
    evidence: 'Etapas externas comprobadas, con resultados y destino local verificados.',
  };
  const verifyDispatch = async item => ({ ...item, approvalVerified: item.state === 'succeeded' && ['qa', 'reviewer'].includes(item.stage), receiptId: 'msg_' + item.dispatchId });
  const verifyDestination = async () => ({ workspace, checkout: decision.destination.checkout, branch: 'feature/local', sha });
  const options = { confirm: true, decision, verifyDispatch, verifyDestination };
  return { root, job, decision, options };
}

async function amendCheckpoint(root, amend) {
  const state = await loadState(root);
  const job = structuredClone(state.jobs[0]);
  amend(job);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1,
    type: 'fixture_checkpoint', at: new Date().toISOString(), patch: { jobs: [job] } }) + '\n');
}

test('schema 2 reconciles another business, unchanged branch, arbitrary SHA and zero retries', async t => {
  const { root, job, options } = await fixture(t);
  const result = await reconcileCodeJob(root, job.id, options);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.workflow.status, 'succeeded');
  assert.equal(result.workflow.currentStage, null);
  assert.equal(result.deliveryStatus, 'complete');
  assert.equal(result.destination.sha, sha);
  assert.equal(result.workflow.steps[2].approvalDispatchId, 'ctx_qa000001');
  assert.equal(result.workflow.steps[1].dispatchHistory[0].receiptId, 'msg_ctx_developer000001');
  const bytes = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  assert.equal((await reconcileCodeJob(root, job.id, options)).idempotent, true);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), bytes);
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, decision: { ...options.decision, scope: 'partial' } }), { code: 'reconciliation_duplicate' });
});

test('timeline accepts multiple verified retries and a preserved stage from an earlier job attempt', async t => {
  const { root, job, options } = await fixture(t, { retries: 2, priorAttempt: true });
  const result = await reconcileCodeJob(root, job.id, options);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.workflow.steps[0].attempt, 1);
  assert.equal(result.workflow.steps[1].dispatchHistory.length, 3);
  assert.equal(result.workflow.steps[1].dispatchId, 'ctx_developer000003');
});

for (const explicitQueueAttempt of [true, false]) test(`native retry keeps task input attempt 1 in queue attempt 2 (${explicitQueueAttempt ? 'explicit' : 'legacy-compatible'} queue identity)`, async t => {
  const { root, job, options } = await fixture(t, { retries: 1, priorAttempt: true });
  for (const item of options.decision.dispatches.filter(item => item.stage === 'developer')) {
    item.jobAttempt = 1;
    if (explicitQueueAttempt) item.queueAttempt = item.sequence;
  }
  await amendCheckpoint(root, current => {
    Object.assign(current.workflow.steps[1], { dispatchId: 'ctx_developer000002', attempt: 2, taskInputAttempt: 1 });
  });
  const seen = [];
  const verifyDispatch = async item => {
    seen.push({ stage: item.stage, jobAttempt: item.jobAttempt, queueAttempt: item.queueAttempt });
    return { ...await options.verifyDispatch(item), ...(item.stage === 'developer' && item.state === 'succeeded'
      ? { delivery: structuredDelivery({ jobId: job.id, jobAttempt: item.jobAttempt, stage: item.stage, runId: item.runId, taskId: item.taskId, dispatchId: item.dispatchId }, { approval: 'not_applicable' }) } : {}) };
  };
  const result = await reconcileCodeJob(root, job.id, { ...options, verifyDispatch });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.workflow.steps[1].attempt, 2);
  assert.equal(result.workflow.steps[1].taskInputAttempt, 1);
  assert.equal(result.workflow.steps[1].delivery.jobAttempt, 1);
  assert.deepEqual(seen.filter(item => item.stage === 'developer').map(item => item.jobAttempt), [1, 1]);
});

test('native retry rejects a mismatched queue attempt or task input identity', async t => {
  const { root, job, options } = await fixture(t, { retries: 1, priorAttempt: true });
  for (const item of options.decision.dispatches.filter(item => item.stage === 'developer')) {
    item.jobAttempt = 1; item.queueAttempt = item.sequence;
  }
  await amendCheckpoint(root, current => {
    Object.assign(current.workflow.steps[1], { dispatchId: 'ctx_developer000002', attempt: 2, taskInputAttempt: 1 });
  });
  for (const mutate of [
    d => { d.dispatches.find(item => item.dispatchId === 'ctx_developer000002').queueAttempt = 1; },
    d => { for (const item of d.dispatches.filter(item => item.stage === 'developer')) { item.jobAttempt = 2; item.queueAttempt = 2; } },
    d => { d.dispatches.find(item => item.dispatchId === 'ctx_developer000002').queueAttempt = 3; },
  ]) {
    const decision = structuredClone(options.decision); mutate(decision);
    await assert.rejects(reconcileCodeJob(root, job.id, { ...options, decision }), { code: 'reconciliation_dispatch_mismatch' });
  }
});

test('a replaced dispatch cannot inherit stale delivery, artifact or output metadata', async t => {
  const { root, job, options } = await fixture(t, { retries: 1 });
  await amendCheckpoint(root, current => {
    Object.assign(current.workflow.steps[1], {
      artifact: { path: 'old-failed-report.json', sha256: '1'.repeat(64) },
      delivery: { dispatchId: 'ctx_developer000001', outcome: 'failed' },
      summary: 'Resumen del dispatch fallido.', summaryTruncated: true, outputChars: 999,
      approvalOutcome: 'blocked', approvalDispatchId: 'ctx_developer000001', resultMessageId: 'msg_old',
    });
    current.workflow.steps[0].artifact = { path: 'same-ux-report.json', sha256: '2'.repeat(64) };
  });
  const result = await reconcileCodeJob(root, job.id, options);
  const developer = result.workflow.steps[1];
  for (const key of ['artifact', 'delivery', 'summaryTruncated', 'outputChars', 'approvalOutcome', 'approvalDispatchId']) assert.equal(Object.hasOwn(developer, key), false, key);
  assert.notEqual(developer.summary, 'Resumen del dispatch fallido.');
  assert.equal(developer.resultMessageId, 'msg_ctx_developer000002');
  assert.equal(result.workflow.steps[0].artifact.path, 'same-ux-report.json');
  const history = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  assert.ok(history.includes('old-failed-report.json'));
});

test('a newly verified delivery invalidates an older artifact even for the same dispatch', async t => {
  const { root, job, options } = await fixture(t);
  await amendCheckpoint(root, current => {
    Object.assign(current.workflow.steps[1], { artifact: { path: 'stale-report.json', sha256: '1'.repeat(64) }, delivery: { summary: 'old' } });
  });
  const verifyDispatch = async item => ({ ...await options.verifyDispatch(item), ...(item.stage === 'developer'
    ? { delivery: structuredDelivery({ jobId: job.id, jobAttempt: item.jobAttempt, stage: item.stage, runId: item.runId, taskId: item.taskId, dispatchId: item.dispatchId }, { approval: 'not_applicable' }) } : {}) });
  const result = await reconcileCodeJob(root, job.id, { ...options, verifyDispatch });
  assert.equal(result.workflow.steps[1].artifact, undefined);
  assert.equal(result.workflow.steps[1].delivery.dispatchId, 'ctx_developer000001');
});

test('reconciliation checks structured QA and reviewer coverage against the original job criteria', async t => {
  const { root, job, options } = await fixture(t);
  await amendCheckpoint(root, current => { current.contract.acceptance = ['Guardar y restaurar el estado.']; });
  const verify = includeCriterion => async item => ({ ...await options.verifyDispatch(item), ...(['qa', 'reviewer'].includes(item.stage)
    ? { delivery: structuredDelivery({ jobId: job.id, jobAttempt: item.jobAttempt, stage: item.stage, runId: item.runId, taskId: item.taskId, dispatchId: item.dispatchId },
      { acceptance: [{ criterion: includeCriterion ? 'Guardar y restaurar el estado.' : 'Cambio correcto', status: 'passed', evidence: 'Comprobación reproducible.' }] }) } : {}) });
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, verifyDispatch: verify(false) }), { code: 'reconciliation_dispatch_mismatch' });
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  assert.equal((await reconcileCodeJob(root, job.id, { ...options, verifyDispatch: verify(true) })).state, 'succeeded');
});

test('partial evidence stays WIP and cannot masquerade as a completed workflow', async t => {
  const { root, job, options } = await fixture(t, { partial: true });
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, decision: { ...options.decision, scope: 'complete' } }), { code: 'reconciliation_incomplete' });
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
  const result = await reconcileCodeJob(root, job.id, options);
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.error.code, 'delivery_wip');
  assert.equal(result.workflow.currentStage, 'qa');
  assert.equal(result.workflow.steps[2].status, 'queued');
});

test('reconciliation never executes or completes a pending integration', async t => {
  const { root, job, options } = await fixture(t, { integration: true });
  const result = await reconcileCodeJob(root, job.id, options);
  assert.equal(result.state, 'needs_attention');
  assert.equal(result.workflow.currentStage, 'integration');
  assert.equal(result.workflow.steps.at(-1).status, 'blocked');
  assert.equal(result.deliveryStatus, 'wip');
});

test('manifest verified boolean cannot replace independent destination observation', async t => {
  const { root, job, options } = await fixture(t);
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, verifyDestination: undefined }), { code: 'reconciliation_destination_verifier_required' });
  for (const patch of [{ branch: 'another-branch' }, { sha: '1'.repeat(40) }, { workspace: root }, { checkout: 'another-checkout' }, { sha: 'abcdef0' }]) {
    await assert.rejects(reconcileCodeJob(root, job.id, { ...options, verifyDestination: async () => ({ ...await options.verifyDestination(), ...patch }) }), { code: 'reconciliation_destination_mismatch' });
  }
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
});

test('destination is checked again before committing external evidence', async t => {
  const { root, job, options } = await fixture(t);
  let calls = 0;
  const before = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, verifyDestination: async () => ({
    ...await options.verifyDestination(), sha: calls++ ? '1'.repeat(40) : sha,
  }) }), { code: 'reconciliation_destination_mismatch' });
  assert.equal(calls, 2);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), before);
});

test('no skipped stages, wrong job, replayed task or unanchored dispatch can be reconciled', async t => {
  const { root, job, options } = await fixture(t, { retries: 1 });
  for (const mutate of [
    d => { d.jobId = 'another-job'; },
    d => { d.dispatches = d.dispatches.filter(item => item.stage !== 'developer'); },
    d => { d.dispatches[2].taskId = 'task_unrelated00'; },
    d => { d.dispatches[3].taskId = d.dispatches[0].taskId; },
    d => { d.dispatches[3].parentTaskId = 'task_unrelated00'; },
    d => { d.dispatches[2].retryOfDispatchId = null; },
    d => { d.dispatches[0].dispatchId = 'ctx_unrelated00'; },
    d => { d.dispatches[0].jobAttempt = 1; },
    d => { d.dispatches[1].sequence = 2; },
  ]) {
    const decision = structuredClone(options.decision); mutate(decision);
    await assert.rejects(reconcileCodeJob(root, job.id, { ...options, decision }), error => error.code.startsWith('reconciliation_'));
  }
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
});

function structuredDelivery(evidence, patch = {}) {
  return { version: 1, jobId: 'agency-reconcile', jobAttempt: 2, stage: 'qa', runId: 'run_generic0001', taskId: 'task_qa00000', dispatchId: 'ctx_qa000001',
    outcome: 'completed', scope: 'complete', summary: 'Comprobaciones superadas.', approval: 'approved',
    acceptance: [{ criterion: 'Cambio correcto', status: 'passed', evidence: 'Comprobación reproducible.' }],
    evidence: ['Comprobación reproducible.'], questions: [], decisions: [], ...evidence, ...patch };
}

test('complete scope cannot override a structured partial delivery', async t => {
  const { root, job, options } = await fixture(t);
  const verifyDispatch = async item => ({ ...await options.verifyDispatch(item), ...(item.stage === 'developer'
    ? { delivery: structuredDelivery({ jobId: job.id, jobAttempt: item.jobAttempt, stage: item.stage, runId: item.runId, taskId: item.taskId, dispatchId: item.dispatchId }, { approval: 'not_applicable', scope: 'partial' }) } : {}) });
  await assert.rejects(reconcileCodeJob(root, job.id, { ...options, verifyDispatch }), { code: 'reconciliation_incomplete' });
  const partial = await reconcileCodeJob(root, job.id, { ...options, verifyDispatch, decision: { ...options.decision, scope: 'partial' } });
  assert.equal(partial.state, 'needs_attention');
  assert.equal(partial.workflow.steps[1].status, 'blocked');
  assert.equal(partial.workflow.currentStage, 'developer');
});

test('native nested transcript cursors and structured approvals remain strictly correlated', async () => {
  const evidence = { jobId: 'agency-reconcile', jobAttempt: 2, stage: 'qa', runId: 'run_generic0001', taskId: 'task_qa00000', dispatchId: 'ctx_qa000001' };
  const page = (text, limited = false, nextCursor = null) => ({ dispatchId: evidence.dispatchId, source: 'transcript', sourceExact: true, archived: true,
    status: { worker: 'succeeded' }, projection: { outcome: 'succeeded' }, sourceIdentity: 'stable-source', contentComplete: !limited,
    transcript: { limited, nextCursor, messages: [{ role: 'assistant', blocks: [{ type: 'text', text }] }] } });
  const calls = [];
  const result = await verifyOrcaApprovalTranscript(evidence.dispatchId, 'succeeded', async ({ cursor }) => {
    calls.push(cursor); return cursor ? page(JSON.stringify(structuredDelivery(evidence))) : page('Comprobación en curso.', true, 'native-cursor');
  }, { evidence, includeDelivery: true });
  assert.deepEqual(calls, [undefined, 'native-cursor']);
  assert.equal(result.delivery.dispatchId, evidence.dispatchId);
  for (const patch of [{ dispatchId: 'ctx_another0001' }, { jobId: 'another-job' }, { scope: 'partial' }, { jobAttempt: 1 }]) {
    await assert.rejects(verifyOrcaApprovalTranscript(evidence.dispatchId, 'succeeded', async () => page(JSON.stringify(structuredDelivery(evidence, patch))), { evidence }), { code: 'reconciliation_approval_unverified' });
  }
});

test('structured worker_done approval requires the exact terminal and task result', () => {
  const evidence = { jobId: 'agency-reconcile', jobAttempt: 2, stage: 'qa', runId: 'run_generic0001', taskId: 'task_qa00000', dispatchId: 'ctx_qa000001', state: 'succeeded', parentTaskId: null, approvalEvidence: 'structured' };
  const delivery = structuredDelivery();
  const body = JSON.stringify(delivery);
  const records = { terminalHandle: 'term_qa00001', inbox: { count: 1, messages: [{ id: 'msg_qa00001', type: 'worker_done', run_id: evidence.runId,
    to_handle: 'run:' + evidence.runId, from_handle: 'term_qa00001', body, payload: { dispatchId: evidence.dispatchId, taskId: evidence.taskId, outcome: 'succeeded' } }] },
    taskList: { runId: evidence.runId, legacyReadOnly: false, count: 1, tasks: [{ id: evidence.taskId, run_id: evidence.runId, parent_id: null, status: 'completed',
      result: { outcome: 'succeeded', messageId: 'msg_qa00001', reportedBy: 'term_qa00001', body } }] } };
  assert.equal(verifyOrcaRunRecords(evidence, records).delivery.approval, 'approved');
  assert.throws(() => verifyOrcaRunRecords(evidence, { ...records, terminalHandle: 'term_another' }), { code: 'reconciliation_receipt_mismatch' });
});

test('destination verifier observes existing branch and full SHA without network or mutations', async () => {
  const workspace = path.resolve('test-checkout');
  const job = { workspace, destination: { checkout: 'workspaces/test-checkout' } };
  const destination = { checkout: job.destination.checkout, branch: 'feature/observed', sha: sha.slice(0, 8), verified: true };
  const calls = [];
  const inspect = async (...args) => { calls.push(args); return { checkout: destination.checkout, workspace, branch: destination.branch }; };
  const git = (args, options) => { calls.push({ args, options }); return { status: 0, stdout: sha + '\n' }; };
  assert.equal((await verifyReconciliationDestination('fixture-root', job, destination, { inspect, git })).sha, sha);
  assert.deepEqual(calls[0], ['fixture-root', destination.checkout, destination.branch]);
  assert.deepEqual(calls[1].args, ['rev-parse', '--verify', 'HEAD']);
  assert.equal(calls[1].options.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(calls[1].options.shell, false);
  await assert.rejects(verifyReconciliationDestination('fixture-root', job, destination, { inspect, git: () => ({ status: 0, stdout: '1'.repeat(40) }) }));
  await assert.rejects(verifyReconciliationDestination('fixture-root', job, destination, { inspect: async () => ({ workspace: path.dirname(workspace) }), git }));
});
