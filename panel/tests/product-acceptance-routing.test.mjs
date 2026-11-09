import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIdea, createProject, updateProject, changeDashboardState, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToCoordinator, routeCoordinatorIdea } from '../agency-assistant/idea-workflow.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator } from '../agency-assistant/coordinator-inbox.mjs';
import { readAutoRun, confirmSubmission, setAutoRun } from '../../auto-run.mjs';
import { acquireLock, releaseLock, loadState } from '../../queue.mjs';
import { normalizeJobContract } from '../../workflow-contract.mjs';

const productAcceptance = ['Añadir una tarea con Enter.', 'Rechazar tareas vacías.', 'Completar y borrar tareas.', 'Persistir al recargar.', 'Permitir teclado a 320 px.'];
const successCriteria = 'Lista funcional con sus cinco comportamientos, QA y revisión aprobadas, checks verdes y merge completado.';
const notify = async () => ({ status: 'sent', runId: 'run_product1', messageId: 'msg_product1' });

async function fixture(t, type) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-acceptance-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'workspaces', 'product'); await fs.mkdir(checkout, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=develop'], { cwd: checkout, windowsHide: true, stdio: 'ignore' });
  const project = await createProject(root, 'Producto', 'agency');
  await updateProject(root, project.id, { checkout: 'workspaces/product', branch: 'develop', baseBranch: 'main', repository: 'fixture/product' });
  await setAutoRun(root, 'agency', true, { confirm: true });
  const confirmation = { projectId: project.id, checkout: 'workspaces/product', branch: 'develop', baseBranch: 'main', objective: 'Implementar los cinco comportamientos de la lista.', successCriteria, productAcceptance };
  let request;
  if (type === 'idea') {
    const idea = await createIdea(root, 'agency', confirmation.objective, project.id, 'product-idea-0001', { focus: 'code' });
    request = (await sendIdeaToCoordinator(root, idea.id, { notify })).request;
  } else request = (await submitTaskToCoordinator(root, { operationId: 'product-task-0001', business: 'agency', projectId: project.id, title: 'Lista', prompt: confirmation.objective, successCriteria }, { notify })).request;
  const route = value => type === 'idea' ? routeCoordinatorIdea(root, request.id, 'code', value) : routeTaskFromCoordinator(root, request.id, 'code', { confirmation: value });
  return { root, request, confirmation, route };
}

for (const type of ['idea', 'task']) {
  test(`${type}: missing product criteria create no receipt or job and can be corrected on the same request`, async t => {
    const { root, request, confirmation, route } = await fixture(t, type);
    const missing = { ...confirmation }; delete missing.productAcceptance;
    if (type === 'idea') {
      const result = await route(missing); assert.equal(result.code, 'product_acceptance_required'); assert.equal(result.request.status, 'needs_attention');
    } else await assert.rejects(route(missing), { code: 'product_acceptance_required', status: 400 });
    assert.equal((await readAutoRun(root)).receipts.length, 0); assert.equal((await loadState(root)).jobs.length, 0);
    const result = await route({ ...confirmation, revise: true });
    assert.equal(result.request.id, request.id); assert.deepEqual(result.request.snapshot, request.snapshot);
    assert.deepEqual(result.job.contract.acceptance, productAcceptance); assert.equal(result.job.contract.acceptanceScope, 'product');
    assert.deepEqual(result.job.contract.endToEndCriteria, [successCriteria]); assert.ok(result.job.prompt.includes(successCriteria));
    assert.deepEqual(result.job.workflow.steps.map(step => step.key), ['ux', 'developer', 'qa', 'reviewer', 'integration']);
    assert.equal(result.job.attempts, 0); assert.deepEqual(result.request.route.confirmation.productAcceptance, productAcceptance);
    assert.equal((await readAutoRun(root)).receipts.length, 1); assert.equal((await loadState(root)).jobs.length, 1);
  });

  for (const legacyContract of [false, true]) test(`${type}: historical pending receipt ${legacyContract ? 'explicit aggregate' : 'without contract'} is replayed unchanged without new confirmation fields`, async t => {
    const { root, request, confirmation, route } = await fixture(t, type);
    const lock = await acquireLock(root);
    let historical;
    try {
      await route(confirmation);
      const state = await readAutoRun(root), receipt = state.receipts[0], spec = structuredClone(receipt.spec);
      if (legacyContract) spec.contract = normalizeJobContract({ title: spec.title, kind: 'code', contract: { acceptance: [successCriteria], completionCondition: 'Cierre global original.' } });
      else delete spec.contract;
      state.receipts = []; await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
      historical = (await confirmSubmission(root, receipt.id, spec)).receipt;
      await changeDashboardState(root, inbox => {
        const saved = inbox.coordinatorRequests.find(item => item.id === request.id);
        saved.status = 'routing'; delete saved.route.confirmation.productAcceptance;
        for (const idea of inbox.ideas) if (idea.requests?.code?.confirmation) delete idea.requests.code.confirmation.productAcceptance;
      });
    } finally { await releaseLock(lock); }
    const replay = await route();
    assert.deepEqual(replay.job.contract, normalizeJobContract(historical.spec));
    assert.equal(Object.hasOwn(replay.job.contract, 'acceptanceScope'), false);
    const after = (await readAutoRun(root)).receipts[0]; assert.deepEqual(after.spec, historical.spec); assert.equal(after.fingerprint, historical.fingerprint);
    assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await loadDashboardState(root)).coordinatorRequests.length, 1);
  });
}

test('task submission idempotency includes explicit product criteria instead of accepting a second contract under the same operation', async t => {
  const { root, confirmation } = await fixture(t, 'task');
  const input = { operationId: 'separate-code-intent', business: 'agency', projectId: confirmation.projectId, kind: 'code', title: 'Lista', prompt: confirmation.objective, successCriteria, confirmation };
  await submitTaskToCoordinator(root, input, { notify });
  await assert.rejects(submitTaskToCoordinator(root, { ...input, confirmation: { ...confirmation, productAcceptance: ['Un alcance distinto.'] } }, { notify }), /otro encargo/);
  assert.equal((await readAutoRun(root)).receipts.length, 0); assert.equal((await loadState(root)).jobs.length, 0);
});
