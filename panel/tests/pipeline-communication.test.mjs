import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { addJob, loadState, acquireLock, releaseLock } from '../queue.mjs';
import { captureJobQuestions, answerQuestion, loadDashboardState, changeDashboardState, reconcileContinuations, jobQuestions } from '../agency-assistant/dashboard-state.mjs';
import { withInboxLock, recoverInboxLock } from '../agency-assistant/inbox-lock.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-communication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function finished(root, id, extra = {}) {
  const job = await addJob(root, { id, business: 'games', projectId: 'fixture-project', projectName: 'Fixture', kind: 'analysis', provider: 'codex', title: 'Diseñar un tablero', prompt: 'Objetivo: diseñar tablero. Criterio de éxito: reglas verificables.', ...extra });
  const state = await loadState(root);
  const done = { ...job, state: 'succeeded', attempts: 1, finishedAt: new Date().toISOString(), result: { text: 'Plan original sin decisiones cerradas.' } };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), `${JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [done] } })}\n`);
  return done;
}
function subprocess(source, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(error || `fixture exited ${code}`)));
  });
}

test('three answers produce one continuation with all decisions and preserve repeat idempotency', async t => {
  const root = await fixture(t), parent = await finished(root, 'original');
  const questions = await captureJobQuestions(root, parent, ['¿Cómo activar?', '¿Cuántas piezas?', '¿Qué plataforma?']);
  await answerQuestion(root, questions[0].id, 'Elige tú dentro del objetivo.');
  assert.equal((await loadState(root)).jobs.length, 1);
  await Promise.all([answerQuestion(root, questions[1].id, 'Tres piezas como máximo.'), answerQuestion(root, questions[2].id, 'Android prioritario.')]);
  const queue = await loadState(root), inbox = await loadDashboardState(root);
  assert.equal(queue.jobs.length, 2); assert.equal(inbox.continuations.length, 1);
  const next = queue.jobs.find(job => job.id !== parent.id);
  for (const text of ['Elige tú', 'Tres piezas', 'Android prioritario']) assert.ok(next.prompt.includes(text));
  assert.equal(next.continuation.rootJobId, parent.id); assert.equal(next.continuation.decisions.length, 3);
  assert.equal(inbox.questions.every(question => question.followUpJobId === next.id), true);
  await answerQuestion(root, questions[2].id, 'Android prioritario.'); await reconcileContinuations(root);
  assert.equal((await loadState(root)).jobs.length, 2);
  await assert.rejects(answerQuestion(root, questions[2].id, 'Otra plataforma.'), /otra respuesta/);
});

test('saved answer and intent survive queue lock and reconcile without duplication', async t => {
  const root = await fixture(t), parent = await finished(root, 'interrupted');
  const [question] = await captureJobQuestions(root, parent, ['¿Continuar?']);
  const lock = await acquireLock(root);
  try {
    await answerQuestion(root, question.id, 'Continuar con el alcance acordado.');
    assert.equal((await loadDashboardState(root)).questions[0].status, 'answered');
    assert.equal((await loadDashboardState(root)).continuations[0].status, 'pending');
    assert.equal((await loadState(root)).jobs.length, 1);
  } finally { await releaseLock(lock); }
  await reconcileContinuations(root); await reconcileContinuations(root);
  assert.equal((await loadState(root)).jobs.length, 2);
});

test('structured blocked stage questions retain project and prior decisions without asking again', async t => {
  const root = await fixture(t);
  const job = { id: 'structured', state: 'needs_attention', attempts: 1, business: 'games', projectId: 'p1', projectName: 'Fixture', title: 'Demo', continuation: { rootJobId: 'original', decisions: [{ decisionKey: 'activation', answer: 'Elige tú.' }] }, workflow: { runId: 'run_fixture01', currentStage: 'developer', steps: [{ key: 'developer', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01', taskInputAttempt: 1, delivery: { version: 1, jobId: 'structured', jobAttempt: 1, runId: 'run_fixture01', taskId: 'task_fixture01', dispatchId: 'ctx_fixture01', stage: 'developer', outcome: 'needs_input', questions: [{ id: 'activation-q', text: '¿Cómo activar?', decisionKey: 'activation', required: true }, { id: 'export-q', text: '¿Qué exportación?', decisionKey: 'export', required: true }] } }] } };
  const questions = await captureJobQuestions(root, job, jobQuestions(job));
  assert.equal(questions[0].status, 'answered'); assert.equal(questions[0].inherited, true);
  assert.equal(questions[1].status, 'pending'); assert.equal(questions[1].projectId, 'p1');
  assert.equal((await captureJobQuestions(root, job)).length, 0);
  job.continuation.decisions[0].question = '¿Dónde activar?';
  const [changed] = await captureJobQuestions(root, job, [{ id: 'activation-q2', text: '¿Cómo activar?', decisionKey: 'activation', required: true, _roundId: 'otra-ronda' }]);
  assert.equal(changed.status, 'pending');
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('answers resume the same confirmed needs_input task and never replace an uncertain or active dispatch', async t => {
  for (const dispatchStatus of ['completed', 'unknown', 'active']) {
    const root = await fixture(t);
    const parent = await addJob(root, { id: `waiting-${dispatchStatus}`, business: 'games', kind: 'analysis', provider: 'orca', title: 'Planificar demo', prompt: 'Objetivo original íntegro y verificable.', maxAttempts: 3 });
    const delivery = { version: 1, jobId: parent.id, jobAttempt: 1, stage: 'planner', runId: 'run_fixture123', taskId: 'task_fixture123', dispatchId: 'ctx_fixture123', outcome: 'needs_input', scope: 'partial', summary: 'Falta plataforma', approval: 'not_applicable', acceptance: [], evidence: [], questions: [{ id: 'platform', text: '¿Plataforma?', required: true }], decisions: [] };
    const waiting = { ...parent, state: dispatchStatus === 'active' ? 'running' : 'needs_attention', attempts: 1, result: { delivery }, workflow: { ...parent.workflow, runId: delivery.runId, currentStage: 'planner', status: dispatchStatus === 'active' ? 'running' : 'needs_attention', steps: [{ key: 'planner', profile: 'planificador', status: dispatchStatus === 'active' ? 'running' : 'blocked', dispatchId: delivery.dispatchId, taskId: delivery.taskId, dispatchStatus, taskInputAttempt: 1, delivery }] } };
    const state = await loadState(root);
    await fs.appendFile(path.join(root, 'data', 'events.jsonl'), `${JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [waiting] } })}\n`);
    const [question] = await captureJobQuestions(root, waiting);
    await answerQuestion(root, question.id, 'Android.');
    await reconcileContinuations(root);
    const jobs = (await loadState(root)).jobs, inbox = await loadDashboardState(root);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].id, parent.id);
    if (dispatchStatus === 'completed') {
      assert.equal(jobs[0].state, 'queued'); assert.equal(inbox.continuations[0].status, 'resumed');
      assert.equal(jobs[0].workflow.steps[0].predecessorTaskId, delivery.taskId);
      assert.equal(jobs[0].workflowHistory[0].steps[0].dispatchId, delivery.dispatchId);
      assert.ok(jobs[0].prompt.includes('Android.')); assert.ok(jobs[0].prompt.includes(parent.prompt));
    } else if (dispatchStatus === 'active') {
      assert.equal(jobs[0].state, 'running'); assert.equal(inbox.continuations[0].status, 'pending');
      assert.equal(inbox.continuations[0].reason, 'waiting_existing_dispatch');
      assert.equal(jobs[0].attempts, 1); assert.equal(jobs[0].workflow.steps[0].dispatchId, delivery.dispatchId);
      const beforeSettlement = await loadState(root);
      const settled = { ...jobs[0], state: 'needs_attention', workflow: { ...jobs[0].workflow, status: 'needs_attention', steps: jobs[0].workflow.steps.map(step => ({ ...step, status: 'blocked', dispatchStatus: 'completed' })) } };
      await fs.appendFile(path.join(root, 'data', 'events.jsonl'), `${JSON.stringify({ schema: 1, revision: beforeSettlement.revision + 1, patch: { jobs: [settled] } })}\n`);
      await reconcileContinuations(root); await reconcileContinuations(root);
      const resumed = (await loadState(root)).jobs;
      const after = await loadDashboardState(root);
      assert.equal(resumed.length, 1); assert.equal(resumed[0].id, parent.id); assert.equal(resumed[0].state, 'queued');
      assert.equal(resumed[0].attempts, 1, 'preparing the resume cannot reset or spend the execution budget');
      assert.equal(resumed[0].workflowHistory.length, 1);
      assert.equal(resumed[0].workflowHistory[0].steps[0].dispatchId, delivery.dispatchId);
      assert.equal(after.continuations.length, 1); assert.equal(after.continuations[0].id, inbox.continuations[0].id);
      assert.equal(after.continuations[0].status, 'resumed'); assert.equal(after.continuations[0].reason, undefined);
    } else {
      assert.equal(jobs[0].state, waiting.state); assert.equal(inbox.continuations[0].status, 'needs_attention');
      assert.equal(jobs[0].workflow.steps[0].dispatchId, delivery.dispatchId);
    }
  }
});

test('questions from another attempt or dispatch are ignored; current result delivery remains readable', () => {
  const delivery = { version: 1, jobId: 'test-questions', jobAttempt: 2, stage: 'planner', runId: 'run_fixture123', taskId: 'task_fixture123', dispatchId: 'ctx_fixture123', outcome: 'needs_input', questions: [{ id: 'required', text: 'Decisión actual', required: true }] };
  const job = { id: delivery.jobId, state: 'needs_attention', attempts: 2, result: { delivery } };
  assert.equal(jobQuestions(job).length, 1);
  assert.equal(jobQuestions({ ...job, attempts: 3 }).length, 0);
  const running = { ...job, state: 'running', workflow: { runId: delivery.runId, currentStage: 'planner', steps: [{ key: 'planner', taskId: delivery.taskId, dispatchId: 'ctx_other123', taskInputAttempt: 2, delivery }] } };
  assert.equal(jobQuestions(running).length, 0);
});

test('interprocess inbox writers do not lose updates', async t => {
  const root = await fixture(t);
  const module = new URL('../agency-assistant/dashboard-state.mjs', import.meta.url).href;
  const source = `const { changeDashboardState } = await import(process.argv[2]); for(let i=0;i<12;i++) await changeDashboardState(process.argv[1], async state => { const n=state.counter||0; await new Promise(r=>setTimeout(r,2)); state.counter=n+1; });`;
  const outcomes = await Promise.allSettled([subprocess(source, [root, module]), subprocess(source, [root, module])]);
  for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.reason?.message);
  assert.equal((await loadDashboardState(root)).counter, 24);
});

test('interrupted inbox owner requires review and never gets silently displaced', async t => {
  const root = await fixture(t);
  const module = new URL('../agency-assistant/inbox-lock.mjs', import.meta.url).href;
  await subprocess(`const { withInboxLock }=await import(process.argv[2]); await withInboxLock(process.argv[1], 'state', async()=>process.exit(0));`, [root, module]);
  await assert.rejects(changeDashboardState(root, state => { state.counter = 1; }), error => error.code === 'inbox_lock_stale');
  await assert.rejects(recoverInboxLock(root, 'state'), error => error.code === 'review_required');
  await recoverInboxLock(root, 'state', { confirmReviewed: true });
  await changeDashboardState(root, state => { state.counter = 2; });
  assert.equal((await loadDashboardState(root)).counter, 2);
  await withInboxLock(root, 'state', async () => {
    await assert.rejects(recoverInboxLock(root, 'state', { confirmReviewed: true }), error => error.code === 'inbox_lock_uncertain');
  });
});
