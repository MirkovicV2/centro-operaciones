import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createIdea, createProject, updateProject } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToQueue, reconcileIdeaRequests } from '../agency-assistant/idea-workflow.mjs';
import { loadState, acquireLock, releaseLock, addJob } from '../queue.mjs';
import { readDashboardConfig, saveDashboardConfig, buildKnowledgeGraph } from '../agency-assistant/knowledge.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'destination-safety-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checkout = 'workspaces/app';
  await fs.mkdir(path.join(root, checkout), { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: path.join(root, checkout), windowsHide: true });
  const project = await createProject(root, 'Proyecto temporal', 'agency');
  await updateProject(root, project.id, { checkout, baseBranch: 'main' });
  const idea = await createIdea(root, 'agency', 'Comportamiento verificable', project.id, '', { focus: 'code' });
  const confirmation = { projectId: project.id, checkout, branch: 'main', baseBranch: 'main', objective: 'Cambiar comportamiento definido', successCriteria: 'Comprobar el resultado del cambio', productAcceptance: ['Comprobar el resultado del cambio'] };
  return { root, checkout, project, idea, confirmation };
}

test('development requires explicit criteria and a matching destination, preserves ideas and never executes', async t => {
  const { root, checkout, project, idea, confirmation } = await fixture(t);
  for (const invalid of [{}, { ...confirmation, objective: '' }, { ...confirmation, branch: 'wrong' }, { ...confirmation, projectId: 'other' }, { ...confirmation, checkout: 'workspaces/other' }]) {
    assert.equal((await sendIdeaToQueue(root, idea.id, 'code', '', invalid)).job, undefined);
    assert.equal((await loadState(root)).jobs.length, 0);
  }
  // Branch observation is repeated on submission, not trusted from project configuration.
  await fs.writeFile(path.join(root, checkout, '.git', 'HEAD'), 'ref: refs/heads/changed\n');
  assert.equal((await sendIdeaToQueue(root, idea.id, 'code', '', confirmation)).job, undefined);
  await fs.writeFile(path.join(root, checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const result = await sendIdeaToQueue(root, idea.id, 'code', '', confirmation);
  assert.equal(result.job.state, 'queued'); assert.equal(result.job.attempts, 0);
  assert.equal(result.job.branch, 'main'); assert.equal(result.job.destination.baseBranch, 'main'); assert.equal(result.job.projectId, project.id);
  assert.deepEqual(result.job.workflow.steps.map(step => step.profile), ['ux_agency', 'desarrollador_agency', 'qa_agency', 'revisor_agency']);
  assert.equal((await loadState(root)).jobs.length, 1);
});

test('pending confirmed intent cannot silently follow a changed project destination', async t => {
  const { root, checkout, idea, confirmation } = await fixture(t);
  const lock = await acquireLock(root);
  try { await sendIdeaToQueue(root, idea.id, 'code', '', confirmation); }
  finally { await releaseLock(lock); }
  await fs.writeFile(path.join(root, checkout, '.git', 'HEAD'), 'ref: refs/heads/other\n');
  await reconcileIdeaRequests(root);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('capture without project or Git succeeds and business cannot borrow another project', async t => {
  const { root, project } = await fixture(t);
  const idea = await createIdea(root, 'games', 'Idea sin datos Git');
  assert.equal(idea.projectId, null);
  assert.equal((await sendIdeaToQueue(root, idea.id, 'analysis', project.id)).job, undefined);
  await assert.rejects(createIdea(root, 'games', 'Idea de otra empresa', project.id));
});

test('business profiles remain distinct, analysis retains planner, and config cannot enable automatic execution', async t => {
  const { root } = await fixture(t);
  for (const business of ['agency', 'games']) {
    const job = await addJob(root, { business, kind: 'code', provider: 'orca', title: 'Temporal', prompt: 'Objetivo temporal verificable', workspace: path.join(root, 'workspaces', 'app'), isolated: true });
    assert.deepEqual(job.workflow.steps.map(step => step.profile), ['ux', 'desarrollador', 'qa', 'revisor'].map(role => `${role}_${business}`));
  }
  const analysis = await addJob(root, { business: 'games', kind: 'analysis', provider: 'orca', title: 'Análisis temporal', prompt: 'Analizar sin cambiar código' });
  assert.equal(analysis.workflow.steps[0].profile, 'planificador');
  const vault = path.join(root, 'vault'); await fs.mkdir(vault);
  await saveDashboardConfig(root, { vaultPath: vault, autoRun: true });
  assert.equal((await readDashboardConfig(root)).autoRun, false);
  await fs.writeFile(path.join(vault, 'agency.md'), '---\nempresa: "agency"\n---\n[[games]]');
  await fs.writeFile(path.join(vault, 'games.md'), '---\nempresa: "games"\n---\n[[agency]]');
  await fs.writeFile(path.join(vault, 'unknown.md'), 'Sin empresa');
  const graph = await buildKnowledgeGraph(root, 'agency');
  assert.deepEqual(graph.nodes.map(node => node.id), ['agency']); assert.deepEqual(graph.edges, []);
});
