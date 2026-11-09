import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createIdea, createProject, updateProject, loadDashboardState, changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToQueue } from '../agency-assistant/idea-workflow.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator } from '../agency-assistant/coordinator-inbox.mjs';
import { readAutoRun, confirmSubmission } from '../../auto-run.mjs';
import { acquireLock, releaseLock, loadState } from '../../queue.mjs';
import { normalizeJobContract } from '../../workflow-contract.mjs';

const criteria = ['1. Añadir tareas.', '2. Rechazar vacías.', '3. Completar y borrar.', '4. Persistir al recargar.', '5. Permitir teclado a 320 px.'];
const notify = async () => ({ status: 'sent', runId: 'run_criteria1', messageId: 'msg_criteria1' });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'criteria-submission-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'fixture');
  await fs.mkdir(workspace, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: workspace, windowsHide: true, stdio: 'ignore' });
  const project = await createProject(root, 'Proyecto fixture', 'agency');
  await updateProject(root, project.id, { checkout: 'workspaces/fixture', branch: 'main', baseBranch: 'main' });
  return { root, project };
}

async function ideaRoute(root, project) {
  const idea = await createIdea(root, 'agency', 'Idea con criterios independientes', project.id, 'criteria-idea-0001', { focus: 'code' });
  const confirmation = { projectId: project.id, checkout: 'workspaces/fixture', branch: 'main', baseBranch: 'main',
    objective: 'Implementar el alcance confirmado.', successCriteria: criteria.join('\r\n'), productAcceptance: criteria };
  return { route: () => sendIdeaToQueue(root, idea.id, 'code', '', confirmation), beforeReplay: async () => {}, idea, confirmation };
}

async function taskRoute(root, project) {
  const submitted = await submitTaskToCoordinator(root, { operationId: 'criteria-task-0001', business: 'agency', projectId: project.id,
    title: 'Criterios verificables', prompt: 'Analizar las decisiones del encargo.', successCriteria: criteria.join('\n') }, { notify });
  return { route: () => routeTaskFromCoordinator(root, submitted.request.id, 'analysis'), request: submitted.request,
    beforeReplay: () => changeDashboardState(root, state => {
      // Crash fixture: receipt was saved, but completing the route checkpoint was interrupted.
      state.coordinatorRequests.find(request => request.id === submitted.request.id).status = 'routing';
    }) };
}

for (const [name, prepare] of [['idea', ideaRoute], ['coordinator task', taskRoute]]) {
  test(`${name}: a new submission freezes five explicit criteria before queue materialization`, async t => {
    const { root, project } = await fixture(t);
    const { route, beforeReplay } = await prepare(root, project);
    const lock = await acquireLock(root);
    try {
      const pending = await route();
      assert.ok(!pending.job);
      const receipt = (await readAutoRun(root)).receipts[0];
      assert.deepEqual(receipt.spec.contract.acceptance, criteria);
      assert.equal((await loadState(root)).jobs.length, 0);
    } finally { await releaseLock(lock); }
    await beforeReplay();
    const before = structuredClone((await readAutoRun(root)).receipts[0]);
    const resumed = await route();
    assert.deepEqual(resumed.job.contract.acceptance, criteria);
    assert.equal(resumed.job.attempts, 0);
    assert.equal((await readAutoRun(root)).receipts[0].fingerprint, before.fingerprint);
    assert.deepEqual((await readAutoRun(root)).receipts[0].spec, before.spec);
    const replay = await route();
    assert.deepEqual(replay.job.contract, resumed.job.contract);
    assert.equal((await loadState(root)).jobs.length, 1);
  });

  test(`${name}: an existing legacy pending receipt keeps its original absent contract and interpretation`, async t => {
    const { root, project } = await fixture(t);
    const { route, beforeReplay } = await prepare(root, project);
    const lock = await acquireLock(root);
    let historical;
    try {
      await route();
      const state = await readAutoRun(root), receipt = state.receipts[0];
      const originalSpec = structuredClone(receipt.spec);
      delete originalSpec.contract;
      // Fixture of a confirmation written by the previous version, before its job existed.
      state.receipts = [];
      await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
      historical = (await confirmSubmission(root, receipt.id, originalSpec)).receipt;
      assert.equal(Object.hasOwn(historical.spec, 'contract'), false);
    } finally { await releaseLock(lock); }
    await beforeReplay();
    const resumed = await route();
    assert.deepEqual(resumed.job.contract, normalizeJobContract(historical.spec));
    assert.equal(resumed.job.contract.acceptance.length, 1);
    const after = (await readAutoRun(root)).receipts[0];
    assert.deepEqual(after.spec, historical.spec);
    assert.equal(after.fingerprint, historical.fingerprint);
    assert.equal((await loadState(root)).jobs.length, 1);
    assert.ok((await loadDashboardState(root)).projects.length);
  });
}
