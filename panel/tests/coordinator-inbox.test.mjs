import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIdea, createProject, loadDashboardState, mutateIdea, updateProject, changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToCoordinator, routeCoordinatorIdea } from '../agency-assistant/idea-workflow.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator } from '../agency-assistant/coordinator-inbox.mjs';
import { loadState, addJob } from '../queue.mjs';
import { readAutoRun, setAutoRun } from '../../auto-run.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-inbox-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root, 'Flecha Trampa', 'games');
  return { root, project };
}
const notice = async () => ({ status: 'sent', runId: 'run_fixture01', messageId: 'msg_fixture01' });

test('saving and notifying an idea creates no job until the coordinator chooses a route', async t => {
  const { root, project } = await fixture(t);
  await setAutoRun(root, 'games', true, { confirm: true });
  const idea = await createIdea(root, 'games', 'Mejorar el prototipo Godot', project.id, 'idea-coord-001', { focus: 'mixed', tags: ['godot'] });
  const [first, duplicate] = await Promise.all([
    sendIdeaToCoordinator(root, idea.id, { notify: notice }),
    sendIdeaToCoordinator(root, idea.id, { notify: notice }),
  ]);
  assert.equal(first.request.id, duplicate.request.id);
  assert.equal(first.request.notification.status, 'sent');
  assert.match(first.message, /no hay job ni dispatch/);
  assert.equal((await loadState(root)).jobs.length, 0);
  const beforeRoute = await readAutoRun(root);
  assert.equal(beforeRoute.businesses.games, true);
  assert.equal(beforeRoute.receipts.length, 0, 'coordinator notice must not create an auto-run receipt');
  await assert.rejects(mutateIdea(root, idea.id, 'update', { title: idea.title, text: idea.text, focus: idea.focus, tags: idea.tags, projectId: idea.projectId, version: idea.version }), /coordinador pendiente/);

  await changeDashboardState(root, state => {
    const request = state.coordinatorRequests.find(item => item.id === first.request.id);
    request.status = 'routing'; request.route = { kind: 'analysis', at: new Date().toISOString(), reason: 'Decisión persistida antes del recibo.' };
  });
  const routed = await routeCoordinatorIdea(root, first.request.id, 'analysis', { reason: 'Este motivo no debe sustituir el checkpoint.' });
  assert.equal(routed.job.kind, 'analysis');
  assert.equal(routed.job.attempts, 0);
  assert.match(routed.job.prompt, /Decisión del coordinador: Decisión persistida antes del recibo/);
  assert.equal((await loadState(root)).jobs.length, 1);
  assert.equal((await readAutoRun(root)).receipts[0].eligible, true);
  assert.equal((await loadDashboardState(root)).coordinatorRequests[0].status, 'routed');
  const replay = await routeCoordinatorIdea(root, first.request.id, 'analysis');
  assert.equal(replay.existing, true);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('generic task waits in coordinator inbox and routes only after an explicit decision', async t => {
  const { root, project } = await fixture(t);
  const input = { operationId: 'task-operation-0001', business: 'games', projectId: project.id, kind: 'analysis', title: 'Evaluar una idea', prompt: 'Inspeccionar la petición del usuario', successCriteria: 'Entregar decisión y criterios verificables' };
  const submitted = await submitTaskToCoordinator(root, input, { notify: notice });
  assert.equal(submitted.request.status, 'pending');
  assert.equal((await loadState(root)).jobs.length, 0);
  await changeDashboardState(root, state => {
    const request = state.coordinatorRequests.find(item => item.id === submitted.request.id);
    request.status = 'routing'; request.route = { kind: 'analysis', at: new Date().toISOString(), reason: 'Checkpoint de ruta durable.' };
  });
  const routed = await routeTaskFromCoordinator(root, submitted.request.id, 'analysis', { reason: 'Motivo nuevo que no debe sustituir la ruta.' });
  assert.equal(routed.job.state, 'queued');
  assert.equal(routed.job.attempts, 0);
  assert.match(routed.job.prompt, /Motivo de ruta: Checkpoint de ruta durable/);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('code routing stops unless the exact saved checkout and branch confirmation still matches', async t => {
  const { root, project } = await fixture(t);
  const checkout = path.join(root, 'workspaces', 'isolated');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await fs.writeFile(path.join(checkout, '.git', 'HEAD'), 'ref: refs/heads/develop\n');
  await fs.writeFile(path.join(checkout, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--initial-branch=develop'], { cwd: checkout, windowsHide: true, stdio: 'ignore' });
  const savedProject = await updateProject(root, project.id, { checkout: 'workspaces/isolated', branch: 'develop', baseBranch: 'main', repository: 'MirkovicV2/flecha-trampa' });
  const request = await submitTaskToCoordinator(root, {
    operationId: 'task-code-operation-001', business: 'games', projectId: project.id, kind: 'analysis',
    title: 'Cambiar tablero', prompt: 'Implementar el tablero solicitado', successCriteria: 'Validar reglas y guardado',
    confirmation: { projectId: project.id, checkout: savedProject.checkout, branch: savedProject.branch, baseBranch: savedProject.baseBranch, objective: 'Implementar el tablero solicitado', successCriteria: 'Validar reglas y guardado' },
  }, { notify: notice });
  await updateProject(root, project.id, { baseBranch: 'release' });
  await assert.rejects(routeTaskFromCoordinator(root, request.request.id, 'code'), /ya no coincide/);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('incomplete idea confirmation can be amended before any durable submission exists', async t => {
  const { root, project } = await fixture(t);
  const checkout = path.join(root, 'workspaces', 'isolated');
  await fs.mkdir(checkout, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--initial-branch=develop'], { cwd: checkout, windowsHide: true, stdio: 'ignore' });
  const configured = await updateProject(root, project.id, { checkout: 'workspaces/isolated', branch: 'develop', baseBranch: 'main', repository: 'fixture/demo' });
  const idea = await createIdea(root, 'games', 'Demo con controles táctiles', project.id, 'correctable-idea', { focus: 'mixed' });
  const submitted = await sendIdeaToCoordinator(root, idea.id, { notify: notice });
  const incomplete = await routeCoordinatorIdea(root, submitted.request.id, 'code', {});
  assert.equal(incomplete.request.status, 'needs_attention');
  assert.equal((await loadState(root)).jobs.length, 0);
  const confirmation = { revise: true, projectId: project.id, checkout: configured.checkout, branch: configured.branch, baseBranch: configured.baseBranch, objective: 'Implementar la demo táctil', successCriteria: 'Validar controles y guardado', productAcceptance: ['Validar controles.', 'Validar guardado.'], version: 1 };
  const corrected = await routeCoordinatorIdea(root, submitted.request.id, 'code', confirmation);
  assert.equal(corrected.request.status, 'routed');
  assert.equal(corrected.request.routeHistory.length, 1);
  assert.equal(corrected.job.kind, 'code');
  assert.equal((await routeCoordinatorIdea(root, submitted.request.id, 'code', confirmation)).job.id, corrected.job.id);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('generic analysis suggestion may route to code only with complete matching confirmation', async t => {
  const { root, project } = await fixture(t);
  const checkout = path.join(root, 'workspaces', 'isolated'); await fs.mkdir(checkout, { recursive: true });
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '--initial-branch=develop'], { cwd: checkout, windowsHide: true, stdio: 'ignore' });
  const configured = await updateProject(root, project.id, { checkout: 'workspaces/isolated', branch: 'develop', baseBranch: 'main', repository: 'fixture/demo' });
  const input = { operationId: 'route-with-confirmation', business: 'games', projectId: project.id, kind: 'analysis', title: 'Demo', prompt: 'Implementar controles', successCriteria: 'Validar controles' };
  const submitted = await submitTaskToCoordinator(root, input, { notify: notice });
  await assert.rejects(routeTaskFromCoordinator(root, submitted.request.id, 'code'), /confirmación/);
  const confirmation = { projectId: project.id, checkout: configured.checkout, branch: configured.branch, baseBranch: configured.baseBranch, objective: input.prompt, successCriteria: input.successCriteria, productAcceptance: ['Validar controles.'] };
  const routed = await routeTaskFromCoordinator(root, submitted.request.id, 'code', { confirmation });
  assert.equal(routed.job.kind, 'code'); assert.deepEqual(routed.request.route.confirmation, confirmation);
  await assert.rejects(submitTaskToCoordinator(root, { ...input, prompt: 'Otra intención distinta' }, { notify: notice }), /otro encargo/);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('a copied correlation marker in another project cannot claim a coordinator request', async t => {
  const { root, project } = await fixture(t);
  const submitted = await submitTaskToCoordinator(root, { operationId: 'scoped-correlation-001', business: 'games', projectId: project.id, kind: 'analysis', title: 'Plan actual', prompt: 'Analizar reglas actuales', successCriteria: 'Entregar criterios concretos' }, { notify: notice });
  await addJob(root, { id: 'other-project-job', business: 'games', projectId: 'different-project', kind: 'analysis', title: 'Otra consulta', prompt: `Referencia documental [COORDINATOR_REQUEST:${submitted.request.id}]` });
  const routed = await routeTaskFromCoordinator(root, submitted.request.id, 'analysis');
  assert.notEqual(routed.job.id, 'other-project-job');
  assert.equal(routed.job.projectId, project.id);
  assert.equal((await loadState(root)).jobs.length, 2);
  assert.equal(routed.request.snapshot.version, 1);
  assert.deepEqual(routed.request.snapshot.decisions, []);
});
