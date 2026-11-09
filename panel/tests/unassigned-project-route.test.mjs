import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createProject, updateProject, createIdea, loadDashboardState, changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToCoordinator, routeCoordinatorIdea, sendIdeaToQueue } from '../agency-assistant/idea-workflow.mjs';
import { loadState, acquireLock, releaseLock } from '../queue.mjs';
import { readAutoRun, setAutoRun, confirmSubmission } from '../../auto-run.mjs';

const notification = { status: 'sent', runId: 'run_agency_fixture', senderId: 'term_agency_fixture', coordinatorId: 'agency', coordinatorName: 'Coordinador Agencia', messageId: 'msg_fixture01' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unassigned-project-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const createConfigured = async (name, business = 'agency') => {
    const project = await createProject(root, name, business);
    const checkout = `workspaces/${name.toLowerCase()}`;
    await fs.mkdir(path.join(root, checkout), { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: path.join(root, checkout), windowsHide: true, stdio: 'ignore' });
    return updateProject(root, project.id, { checkout, branch: 'main', baseBranch: 'main', repository: `fixture/${name.toLowerCase()}` });
  };
  const project = await createConfigured('Prueba');
  const idea = await createIdea(root, 'agency', 'Crear una lista de tareas en un proyecto de pruebas independiente.', '', 'unassigned-test-idea');
  const submitted = await sendIdeaToCoordinator(root, idea.id, { notify: async () => notification });
  const confirm = target => ({ projectId: target.id, checkout: target.checkout, branch: target.branch, baseBranch: target.baseBranch,
    objective: 'Implementar la lista de tareas de prueba', successCriteria: 'Añadir, completar, eliminar y conservar tareas al recargar.', productAcceptance: ['Añadir tareas.', 'Completar tareas.', 'Eliminar tareas.', 'Conservar tareas al recargar.'] });
  return { root, project, idea, request: submitted.request, createConfigured, confirm };
}

test('explicit same-business destination assigns an unclassified idea without changing its original revision', async t => {
  const { root, project, idea, request, confirm } = await fixture(t);
  await setAutoRun(root, 'agency', true, { confirm: true });
  const originalSnapshot = structuredClone(request.snapshot), originalCapture = structuredClone(idea.capture);
  const result = await routeCoordinatorIdea(root, request.id, 'code', confirm(project));
  const state = await loadDashboardState(root), savedIdea = state.ideas.find(item => item.id === idea.id);
  assert.equal(result.request.id, request.id); assert.equal(result.request.status, 'routed');
  assert.equal(savedIdea.projectId, project.id); assert.equal(savedIdea.focus, 'code');
  assert.equal(savedIdea.version, 1); assert.equal(savedIdea.text, idea.text); assert.deepEqual(savedIdea.capture, originalCapture);
  assert.deepEqual(result.request.snapshot, originalSnapshot); assert.equal(result.request.ideaVersion, 1);
  assert.equal(result.request.route.projectId, project.id); assert.equal(result.request.route.focus, 'code');
  assert.deepEqual(result.request.route.confirmation, { ...confirm(project), version: 1 });
  assert.equal(result.job.projectId, project.id); assert.equal(result.job.coordination.projectId, project.id);
  assert.equal(result.job.coordination.requestId, request.id); assert.equal(result.job.coordination.runId, notification.runId);
  assert.equal(result.job.destination.repository, 'fixture/prueba'); assert.equal(result.job.destination.baseBranch, 'main');
  assert.match(result.job.prompt, /Foco del trabajo: Código/);
  assert.equal(result.job.workflow.steps.at(-1).key, 'integration', 'GitHub workflow remains enabled by the explicit automatic receipt');
  assert.equal(result.job.attempts, 0, 'routing does not start a worker in these fixtures');
  const replay = await routeCoordinatorIdea(root, request.id, 'code', confirm(project));
  assert.equal(replay.job.id, result.job.id); assert.equal(replay.existing, true);
  assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await readAutoRun(root)).receipts.length, 1);
  assert.equal((await loadDashboardState(root)).coordinatorRequests.length, 1);
});

test('a destination from another business is rejected before persisting a route or assignment', async t => {
  const { root, idea, request, createConfigured, confirm } = await fixture(t);
  const foreign = await createConfigured('OtroNegocio', 'games');
  await assert.rejects(routeCoordinatorIdea(root, request.id, 'code', confirm(foreign)), /otra empresa/);
  const state = await loadDashboardState(root);
  assert.deepEqual(state.ideas.find(item => item.id === idea.id), idea);
  assert.equal(state.coordinatorRequests[0].status, 'pending'); assert.equal(state.coordinatorRequests[0].route, undefined);
  assert.equal((await loadState(root)).jobs.length, 0); assert.equal((await readAutoRun(root)).receipts.length, 0);
});

test('routing cannot move an already assigned idea to another same-business project', async t => {
  const { root, project, idea, request, createConfigured, confirm } = await fixture(t);
  const other = await createConfigured('OtroProyecto');
  await changeDashboardState(root, state => { const current = state.ideas.find(item => item.id === idea.id); current.projectId = project.id; current.projectName = project.name; });
  await assert.rejects(routeCoordinatorIdea(root, request.id, 'code', confirm(other)), /ya pertenece a otro proyecto/);
  assert.equal((await loadDashboardState(root)).ideas[0].projectId, project.id);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('failed destination confirmation leaves the idea untouched and can be corrected on the same request', async t => {
  const { root, project, idea, request, confirm } = await fixture(t);
  const failed = await routeCoordinatorIdea(root, request.id, 'code', { ...confirm(project), checkout: 'workspaces/unconfirmed' });
  assert.equal(failed.request.status, 'needs_attention'); assert.equal(failed.job, undefined);
  assert.deepEqual((await loadDashboardState(root)).ideas.find(item => item.id === idea.id), idea);
  assert.equal((await readAutoRun(root)).receipts.length, 0);
  const corrected = await routeCoordinatorIdea(root, request.id, 'code', { ...confirm(project), revise: true });
  assert.equal(corrected.request.id, request.id); assert.equal(corrected.request.routeHistory.length, 1);
  assert.equal(corrected.job.projectId, project.id); assert.deepEqual(corrected.request.snapshot, request.snapshot);
  assert.equal((await loadDashboardState(root)).ideas[0].version, 1);
});

test('a saved route keeps its selected project during recovery and repairs assignment after a job-first checkpoint', async t => {
  const { root, project, idea, request, createConfigured, confirm } = await fixture(t);
  const other = await createConfigured('OtraPrueba');
  await changeDashboardState(root, state => {
    const current = state.coordinatorRequests.find(item => item.id === request.id);
    current.status = 'routing'; current.route = { kind: 'code', confirmation: { ...confirm(project), version: 1 }, reason: 'Destino ya confirmado.', decisions: [] };
  });
  const recovered = await routeCoordinatorIdea(root, request.id, 'code', confirm(other));
  assert.equal(recovered.job.projectId, project.id, 'recovery uses the saved decision, not new arguments');
  await changeDashboardState(root, state => {
    const current = state.ideas.find(item => item.id === idea.id);
    current.projectId = null; current.projectName = ''; current.focus = ''; delete current.requests;
    const route = state.coordinatorRequests.find(item => item.id === request.id);
    route.status = 'routing'; delete route.jobId; delete route.receiptId;
  });
  const resumed = await routeCoordinatorIdea(root, request.id, 'code', {});
  assert.equal(resumed.job.id, recovered.job.id);
  assert.equal((await loadDashboardState(root)).ideas[0].projectId, project.id);
  assert.equal((await loadDashboardState(root)).ideas[0].focus, 'code');
  assert.equal((await loadDashboardState(root)).ideas[0].requests.code.jobId, recovered.job.id);
  assert.equal(resumed.request.receiptId, recovered.request.receiptId);
  assert.deepEqual(resumed.request.snapshot, request.snapshot);
  assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await readAutoRun(root)).receipts.length, 1);
});

test('direct send without a coordinator decision does not invent a classification', async t => {
  const { root, project, idea, confirm } = await fixture(t);
  const result = await sendIdeaToQueue(root, idea.id, 'code', project.id, confirm(project));
  assert.equal(result.job, undefined); assert.match(result.message, /foco/);
  assert.equal((await loadDashboardState(root)).ideas[0].projectId, null);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('a busy queue preserves the fixed destination but leaves the idea unassigned until its one job exists', async t => {
  const { root, project, idea, request, createConfigured, confirm } = await fixture(t);
  const other = await createConfigured('Alternativa');
  const lock = await acquireLock(root);
  let first;
  try {
    first = await routeCoordinatorIdea(root, request.id, 'code', confirm(project));
    assert.equal(first.job, undefined); assert.ok(first.receipt);
    assert.equal(first.request.status, 'routing'); assert.equal(first.request.jobId, undefined);
    assert.equal(first.request.route.completedAt, undefined);
    const state = await loadDashboardState(root), savedIdea = state.ideas.find(item => item.id === idea.id);
    assert.equal(savedIdea.projectId, null); assert.equal(savedIdea.focus, ''); assert.equal(savedIdea.version, 1);
    assert.deepEqual(savedIdea.capture, idea.capture); assert.deepEqual(first.request.snapshot, request.snapshot);
    assert.equal(savedIdea.requests.code.status, 'pending');
    assert.equal(savedIdea.requests.code.confirmation.projectId, project.id);
    const repeated = await routeCoordinatorIdea(root, request.id, 'code', { ...confirm(other), revise: true });
    assert.equal(repeated.receipt.id, first.receipt.id);
    assert.equal(repeated.request.route.confirmation.projectId, project.id);
    assert.equal((await readAutoRun(root)).receipts.length, 1); assert.equal((await loadState(root)).jobs.length, 0);
  } finally { await releaseLock(lock); }
  const resumed = await routeCoordinatorIdea(root, request.id, 'code', {});
  assert.equal(resumed.request.status, 'routed'); assert.equal(resumed.job.id, first.receipt.jobId);
  assert.equal(resumed.request.receiptId, first.receipt.id);
  const savedIdea = (await loadDashboardState(root)).ideas.find(item => item.id === idea.id);
  assert.equal(savedIdea.projectId, project.id); assert.equal(savedIdea.focus, 'code'); assert.equal(savedIdea.version, 1);
  assert.equal(savedIdea.requests.code.status, 'queued');
  assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await readAutoRun(root)).receipts.length, 1);
  assert.equal(resumed.job.attempts, 0);
});

test('receipt-first recovery repairs an unassigned idea after the outbox materializes the exact job', async t => {
  const { root, project, idea, request, confirm } = await fixture(t);
  const lock = await acquireLock(root);
  let pending;
  try { pending = await routeCoordinatorIdea(root, request.id, 'code', confirm(project)); }
  finally { await releaseLock(lock); }
  await changeDashboardState(root, state => {
    // Simulate interruption after durable receipt creation, before inbox links.
    delete state.ideas.find(item => item.id === idea.id).requests;
    delete state.coordinatorRequests.find(item => item.id === request.id).receiptId;
  });
  const materialized = await confirmSubmission(root, pending.receipt.id, pending.receipt.spec);
  assert.equal((await loadDashboardState(root)).ideas[0].projectId, null);
  const resumed = await routeCoordinatorIdea(root, request.id, 'code', {});
  assert.equal(resumed.job.id, materialized.job.id); assert.equal(resumed.existing, true);
  assert.equal(resumed.request.receiptId, pending.receipt.id); assert.equal(resumed.request.status, 'routed');
  const savedIdea = (await loadDashboardState(root)).ideas.find(item => item.id === idea.id);
  assert.equal(savedIdea.projectId, project.id); assert.equal(savedIdea.focus, 'code'); assert.equal(savedIdea.version, 1);
  assert.equal(savedIdea.requests.code.receiptId, pending.receipt.id); assert.equal(savedIdea.requests.code.status, 'queued');
  assert.deepEqual(resumed.request.snapshot, request.snapshot);
  assert.equal((await readAutoRun(root)).receipts.length, 1); assert.equal((await loadState(root)).jobs.length, 1);
  assert.equal(resumed.job.attempts, 0);
});
