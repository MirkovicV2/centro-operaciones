import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addJob, loadState, resumeJobWithDecisions } from '../queue.mjs';
import { runOrca } from '../orca-provider.mjs';
import { ProviderError } from '../providers.mjs';
import { jobCoordination } from '../coordination.mjs';
import { authorizeDecisionResume, confirmSubmission, createAutoRunner, readAutoRun, setAutoRun } from '../auto-run.mjs';

const coordination = { requestId: 'coord-request-fixture', coordinatorId: 'coordinator-games', coordinatorName: 'Games', runId: 'run_owned123', senderId: 'term_owner123', business: 'games', projectId: 'project-game' };
const spec = { id: 'owned-job', business: 'games', projectId: 'project-game', kind: 'analysis', provider: 'orca', title: 'Plan verificable', prompt: 'Objetivo: analizar. Criterio: resultado verificable.', coordination };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-execution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function patchJob(root, mutate) {
  const state = await loadState(root), job = structuredClone(state.jobs[0]); mutate(job);
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1,
    at: new Date().toISOString(), type: 'fixture_changed', patch: { jobs: [job] } }) + '\n');
  return job;
}

test('coordinator binding is validated and persisted on the job and admission receipt', async t => {
  const root = await fixture(t);
  const result = await confirmSubmission(root, 'receipt-owned-fixture', spec);
  assert.deepEqual(result.job.coordination, coordination);
  assert.deepEqual((await loadState(root)).jobs[0].coordination, coordination);
  assert.deepEqual((await readAutoRun(root)).receipts[0].spec.coordination, coordination);
  for (const patch of [{ business: 'agency' }, { projectId: 'project-other' }, { runId: 'invalid' }, { senderId: '' }, { requestId: '../invalid' }]) {
    assert.throws(() => jobCoordination({ ...coordination, ...patch }, spec), { code: 'coordinator_job_mismatch' });
  }
  await assert.rejects(addJob(root, { ...spec, id: 'wrong-project', projectId: 'project-other' }), { code: 'coordinator_job_mismatch' });
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('every pipeline stage reuses its verified coordinator Run and exact sender without creating another Run', async t => {
  const root = await fixture(t), workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const calls = [], starts = [], updates = [];
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-show') return { run: { id: coordination.runId, coordinator_handle: coordination.senderId } };
    if (args[1] === 'worker-start') {
      const index = starts.length, entry = { dispatchId: `ctx_stage${index}123`, taskId: `task_stage${index}123`, runId: coordination.runId };
      starts.push({ args, ...entry }); return entry;
    }
    if (args[1] === 'worker-show') return { ...starts.at(-1), state: 'succeeded', liveness: 'exited' };
    if (args[1] === 'inbox') return { messages: [{ id: `message_stage${starts.length}`, type: 'worker_done',
      payload: { dispatchId: starts.at(-1).dispatchId, taskId: starts.at(-1).taskId },
      body: starts.length > 2 ? 'Evidencia correcta.\nRESULTADO: APROBADO' : 'Etapa completada.' }] };
    assert.fail(`Unexpected command: ${args.slice(0, 2).join(' ')}`);
  };
  await runOrca({ ...spec, kind: 'code', isolated: true, workspace, attempts: 1 }, { root, signal: new AbortController().signal,
    registerCleanup() {}, reportStage: async update => updates.push(update) }, { command });
  assert.equal(starts.length, 4); assert.equal(calls.some(args => args[1] === 'run-create'), false);
  for (const [index, entry] of starts.entries()) {
    assert.equal(entry.args[entry.args.indexOf('--run') + 1], coordination.runId);
    assert.equal(entry.args[entry.args.indexOf('--from') + 1], coordination.senderId);
    assert.equal(entry.args[entry.args.indexOf('--worktree') + 1], `path:${workspace}`);
    if (index) assert.deepEqual(JSON.parse(entry.args[entry.args.indexOf('--deps') + 1]), [starts[index - 1].taskId]);
  }
  assert.equal(updates.filter(update => update.status === 'succeeded').length, 4);
});

test('wrong coordinator owner or a previously different Run blocks before any worker start', async t => {
  const root = await fixture(t);
  for (const workflow of [undefined, { runId: 'run_foreign123' }]) {
    const calls = [];
    await assert.rejects(runOrca({ ...spec, attempts: 1, workflow }, { root, signal: new AbortController().signal, registerCleanup() {} }, { command: async args => {
      calls.push(args);
      if (args[0] === 'repo') return { repos: [{ path: path.join(root, 'analysis') }] };
      assert.equal(args[1], 'run-show');
      return { run: { id: coordination.runId, coordinator_handle: 'term_foreign123' } };
    } }), error => ['coordinator_owner_unverified', 'coordinator_job_mismatch'].includes(error.code));
    assert.equal(calls.some(args => ['run-create', 'worker-start'].includes(args[1])), false);
  }
});

async function decisionFixture(t) {
  const root = await fixture(t);
  await setAutoRun(root, 'games', true, { confirm: true });
  await confirmSubmission(root, 'receipt-decisions-fixture', spec);
  const runner = createAutoRunner(root, { worker: async (job, ctx) => {
    const identity = { jobId: job.id, jobAttempt: job.attempts, runId: coordination.runId, taskId: 'task_pending123', dispatchId: 'ctx_pending123', stage: 'planner' };
    const delivery = { version: 1, ...identity, outcome: 'needs_input', scope: 'partial', summary: 'Falta una decisión.', approval: 'not_applicable',
      acceptance: [], evidence: [], questions: [{ id: 'scope', text: 'Qué alcance?', required: true, decisionKey: 'scope' }], decisions: [] };
    await ctx.reportStage({ key: 'planner', status: 'blocked', runId: identity.runId, taskId: identity.taskId, dispatchId: identity.dispatchId,
      attempt: job.attempts, taskInputAttempt: job.attempts, dispatchStatus: 'completed', dispatchSettled: true, delivery });
    throw new ProviderError('needs_input', 'Falta decisión.', { uncertain: false });
  } });
  await runner.tick();
  const blocked = (await loadState(root)).jobs[0];
  assert.equal(blocked.state, 'needs_attention');
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
  const continuation = { version: 1, rootJobId: blocked.id, parentJobId: blocked.id, decisionRevision: 1, questionIds: ['scope'],
    decisions: [{ questionId: 'scope', decisionKey: 'scope', question: 'Qué alcance?', answer: 'Una demo.' }] };
  await resumeJobWithDecisions(root, blocked.id, { continuation, prompt: 'Objetivo original. Alcance: una demo. Criterio: resultado verificable.' });
  return { root, blocked };
}

test('settled needs_input resumes the same eligible receipt once without advancing its queue attempt', async t => {
  const { root, blocked } = await decisionFixture(t);
  const first = await authorizeDecisionResume(root, blocked.id);
  assert.equal(first.status, 'pending'); assert.equal(first.retryAuthorizedAttempt, blocked.attempts);
  assert.equal(first.decisionRevision, 1);
  const second = await authorizeDecisionResume(root, blocked.id); assert.equal(second.id, first.id);
  const state = await readAutoRun(root);
  assert.equal(state.history.filter(item => item.type === 'decisions_resume_authorized').length, 1);
  assert.equal((await loadState(root)).jobs[0].attempts, blocked.attempts);
});

for (const change of [
  ['unknown dispatch', job => { job.workflowHistory.at(-1).steps[0].dispatchStatus = 'unknown'; }],
  ['unsettled dispatch', job => { job.workflowHistory.at(-1).steps[0].dispatchSettled = false; }],
  ['foreign superseded dispatch', job => { job.workflow.steps[0].supersedesDispatchId = 'ctx_foreign123'; }],
  ['foreign predecessor Task', job => { job.workflow.steps[0].predecessorTaskId = 'task_foreign123'; }],
  ['different queue attempt', job => { job.workflowHistory.at(-1).attempt = job.attempts + 1; }],
  ['different stage attempt', job => { job.workflowHistory.at(-1).steps[0].attempt = job.attempts + 1; }],
]) test(`decision receipt cannot reopen from ${change[0]}`, async t => {
  const { root, blocked } = await decisionFixture(t);
  await patchJob(root, change[1]);
  await assert.rejects(authorizeDecisionResume(root, blocked.id));
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
});
