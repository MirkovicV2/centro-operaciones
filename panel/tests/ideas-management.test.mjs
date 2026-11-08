import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createIdea, createProject, mutateIdea, loadDashboardState, changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToQueue, reconcileIdeaRequests } from '../agency-assistant/idea-workflow.mjs';
import { classification, ideaBrief } from '../agency-assistant/idea-model.mjs';
import { loadState, acquireLock, releaseLock } from '../queue.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ideas-management-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = await createProject(root, 'Proyecto fixture', 'agency');
  const idea = await createIdea(root, 'agency', 'Una idea de prueba íntegra', project.id, 'capture-fixture', { focus: 'ux', tags: [' Diseño ', 'DISEÑO', 'mobile'] });
  return { root, project, idea };
}
const edit = idea => ({ title: idea.title, text: idea.text, focus: idea.focus || '', tags: idea.tags || [], projectId: idea.projectId || '', version: idea.version || 1 });

test('schema validates focus and tags and never infers legacy classification', async t => {
  const { root, idea } = await fixture(t);
  assert.deepEqual(idea.tags, ['Diseño', 'mobile']);
  for (const args of [['bad', []], ['ux', ['a'.repeat(25)]], ['ux', ['1','2','3','4','5','6']], ['ux', [2]]]) assert.throws(() => classification(...args));
  const legacy = await createIdea(root, 'games', 'Sin clasificar y sin Git');
  assert.equal(legacy.focus, '');
  assert.equal((await sendIdeaToQueue(root, legacy.id, 'analysis')).job, undefined);
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('editing versions keeps capture, business, jobs and snapshot destinations immutable', async t => {
  const { root, idea } = await fixture(t);
  const result = await sendIdeaToQueue(root, idea.id, 'analysis');
  const previous = structuredClone((await loadState(root)).jobs);
  const other = await createProject(root, 'Otro proyecto', 'agency');
  const foreign = await createProject(root, 'Proyecto juego', 'games');
  await assert.rejects(mutateIdea(root, idea.id, 'update', { ...edit(idea), projectId: foreign.id }));
  const updated = await mutateIdea(root, idea.id, 'update', { ...edit(idea), projectId: other.id, text: 'Texto revisado posterior', focus: 'code' });
  assert.deepEqual(updated.capture, idea.capture); assert.equal(updated.version, 2);
  assert.equal(updated.projectId, other.id); assert.equal(updated.versions[0].snapshot.text, idea.text);
  await assert.rejects(mutateIdea(root, idea.id, 'update', edit(idea)), /otra ventana/);
  assert.deepEqual((await loadState(root)).jobs, previous);
  assert.equal((await sendIdeaToQueue(root, idea.id, 'analysis')).job.id, result.job.id);
  assert.equal((await createIdea(root, 'agency', idea.text, idea.projectId, 'capture-fixture', { focus: 'ux', tags: idea.tags })).id, idea.id);
});

test('trash restore idempotence conserves original identity and capture without jobs', async t => {
  const { root, idea } = await fixture(t);
  const trashed = await mutateIdea(root, idea.id, 'trash', { version: 1 });
  assert.equal(trashed.status, 'trash');
  assert.equal((await mutateIdea(root, idea.id, 'trash', { version: 1 })).version, 2);
  await assert.rejects(sendIdeaToQueue(root, idea.id, 'analysis'), /Restaura/);
  const restored = await mutateIdea(root, idea.id, 'restore', { version: 2 });
  assert.equal(restored.id, idea.id); assert.deepEqual(restored.capture, idea.capture);
  assert.equal(restored.createdAt, idea.createdAt); assert.equal((await loadState(root)).jobs.length, 0);
  assert.equal((await loadDashboardState(root)).ideas.length, 1);
});

test('linked ideas require archive confirmation; restore never queues', async t => {
  const { root, idea } = await fixture(t);
  await sendIdeaToQueue(root, idea.id, 'analysis');
  const jobs = structuredClone((await loadState(root)).jobs);
  await assert.rejects(mutateIdea(root, idea.id, 'trash', { version: 1 }), /Archivar/);
  const archived = await mutateIdea(root, idea.id, 'archive', { version: 1 });
  await assert.rejects(sendIdeaToQueue(root, idea.id, 'analysis'), /Restaura/);
  await mutateIdea(root, idea.id, 'restore', { version: archived.version });
  assert.deepEqual((await loadState(root)).jobs, jobs);
});

test('pending intent locks edits and retirement, then reconciles one immutable prompt', async t => {
  const { root, idea } = await fixture(t);
  const lock = await acquireLock(root);
  try {
    const results = await Promise.all([sendIdeaToQueue(root, idea.id, 'analysis'), mutateIdea(root, idea.id, 'trash', { version: 1 }).catch(error => error)]);
    assert.equal(results[0].job, undefined); assert.match(results[1].message, /pendiente/);
    await assert.rejects(mutateIdea(root, idea.id, 'update', edit(idea)), /pendiente/);
  } finally { await releaseLock(lock); }
  const snapshot = (await loadDashboardState(root)).ideas[0].requests.analysis.snapshot;
  await reconcileIdeaRequests(root); await reconcileIdeaRequests(root);
  const jobs = (await loadState(root)).jobs;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].prompt, snapshot); assert.equal(jobs[0].attempts, 0);
  assert.equal(jobs[0].ideaId, idea.id);
});

test('retirement wins race without orphan or enqueue; uncertain requests block mutation', async t => {
  const { root, idea } = await fixture(t);
  const results = await Promise.allSettled([mutateIdea(root, idea.id, 'trash', { version: 1 }), sendIdeaToQueue(root, idea.id, 'analysis')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((await loadState(root)).jobs.length, 0);
  await mutateIdea(root, idea.id, 'restore', { version: 2 });
  await changeDashboardState(root, state => { state.ideas[0].requests = { code: { status: 'uncertain' } }; });
  await assert.rejects(mutateIdea(root, idea.id, 'update', { ...edit(idea), version: 3 }), /incierto/);
});

test('brief carries all context, checks full UTF8 bytes and preserves oversized capture', async t => {
  const { root, project, idea } = await fixture(t);
  for (const focus of ['ux', 'code', 'mixed']) {
    const prompt = ideaBrief({ ...idea, focus }, project, 'analysis', 'Objetivo verificable', 'Criterio verificable');
    for (const value of [`[IDEA_ID:${idea.id}]`, 'Empresa: agency', project.id, 'Foco del trabajo:', 'Etiquetas: Diseño, mobile', idea.text, 'Objetivo verificable', 'Criterio verificable']) assert.ok(prompt.includes(value));
  }
  const long = await createIdea(root, 'agency', '界'.repeat(5000), project.id, '', { focus: 'mixed' });
  const result = await sendIdeaToQueue(root, long.id, 'analysis');
  assert.match(result.message, /12.000 bytes/); assert.equal(result.job, undefined);
  assert.equal((await loadState(root)).jobs.length, 0);
  assert.equal((await loadDashboardState(root)).ideas.find(item => item.id === long.id).text, long.text);
});

test('AND filters, five stable orders, missing values last, isolated business and no array mutation', async () => {
  const context = vm.createContext({}); vm.runInContext(await fs.readFile(new URL('../dashboard/ideas-view.js', import.meta.url), 'utf8'), context);
  const { select, defaults } = context.IdeaView;
  const ideas = [
    { id:'b', business:'agency', title:'B', projectId:'p', projectName:'Z', focus:'code', tags:['Mobile'], createdAt:'2026-01-02' },
    { id:'a', business:'agency', title:'A', projectId:'p', projectName:'Z', focus:'ux', tags:['Mobile'], createdAt:'2026-01-02' },
    { id:'c', business:'agency', title:'C', createdAt:'2026-01-01' },
    { id:'foreign', business:'games', title:'A', createdAt:'2026-01-03' },
  ];
  const before = structuredClone(ideas), ids = prefs => Array.from(select(ideas, 'agency', { ...defaults(), ...prefs }), item => item.id);
  assert.deepEqual(ids({}), ['a','b','c']); assert.deepEqual(ids({order:'old'}), ['c','a','b']);
  for (const order of ['title','project','focus']) assert.deepEqual(ids({order}), ['a','b','c']);
  assert.deepEqual(ids({ project:'p', focus:'code', tag:'mobile' }), ['b']);
  assert.deepEqual(ids({ project:'none', focus:'none' }), ['c']); assert.deepEqual(ideas, before);
});
