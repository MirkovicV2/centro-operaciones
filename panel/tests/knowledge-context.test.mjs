import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveDashboardConfig, writeJobNote, writeIdeaNote, writeAnswerNote, readAgentContext, buildKnowledgeGraph } from '../agency-assistant/knowledge.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'centro-knowledge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  await saveDashboardConfig(root, { vaultPath: vault });
  return { root, vault };
}

function job(overrides = {}) {
  return {
    id: 'same-job', business: 'games', projectId: 'project-game', projectName: 'Juego', title: 'Una entrega',
    state: 'succeeded', attempts: 1, finishedAt: '2026-11-08T12:00:00Z',
    prompt: 'ENCARGO EXTENSO '.repeat(400), result: { provider: 'fake', text: 'RESULTADO ÚTIL: conservar las decisiones verificadas.' },
    ...overrides,
  };
}

test('corrected content creates an immutable version, retains history and publishes one current state', async t => {
  const { root, vault } = await fixture(t);
  const first = await writeJobNote(root, job(), { revision: 8 });
  const original = await fs.readFile(path.join(vault, first.path), 'utf8');
  const updated = await writeJobNote(root, job({ result: { text: 'Corrección comprobada del mismo intento.' } }), { revision: 9 });
  assert.notEqual(first.path, updated.path);
  assert.equal(first.currentPath, updated.currentPath);
  assert.equal(await fs.readFile(path.join(vault, first.path), 'utf8'), original);
  assert.match(await fs.readFile(path.join(vault, updated.currentPath), 'utf8'), /revision_estado: 9/);
  assert.ok((await fs.readFile(path.join(vault, updated.currentPath), 'utf8')).includes(updated.path));
  const repeat = await writeJobNote(root, job({ result: { text: 'Corrección comprobada del mismo intento.' } }), { revision: 9 });
  assert.equal(repeat.created, false);
  assert.equal(repeat.path, updated.path);
  const stale = await writeJobNote(root, job(), { revision: 8 });
  assert.equal(stale.current, false);
  const context = await readAgentContext(root, 'games', 5000, 'project-game');
  assert.match(context, /Corrección comprobada/);
  assert.doesNotMatch(context, /RESULTADO ÚTIL|ENCARGO EXTENSO/);
  assert.equal((context.match(/^### /gm) || []).length, 1);
});

test('withdrawn successes remain in history but cannot return as current valid results', async t => {
  const { root, vault } = await fixture(t);
  const first = await writeJobNote(root, job(), { revision: 10 });
  const cancelled = await writeJobNote(root, job({ state: 'cancelled', error: { code: 'false_success_retracted', message: 'No hubo implementación.' } }), { revision: 11 });
  assert.match(await fs.readFile(path.join(vault, cancelled.currentPath), 'utf8'), /éxito retirado/);
  assert.match(await fs.readFile(path.join(vault, first.path), 'utf8'), /RESULTADO ÚTIL/);
  // A restored file's mtime must not override the explicit current projection.
  await fs.utimes(path.join(vault, first.path), new Date('2030-01-01'), new Date('2030-01-01'));
  const context = await readAgentContext(root, 'games', 5000, 'project-game');
  assert.match(context, /estado vigente: cancelled/);
  assert.match(context, /éxito retirado/);
  assert.doesNotMatch(context, /RESULTADO ÚTIL/);
  const graph = await buildKnowledgeGraph(root, 'games');
  assert.ok(graph.edges.some(edge => edge.source === cancelled.currentPath.replace(/\.md$/, '').toLowerCase() && edge.target === cancelled.path.replace(/\.md$/, '').toLowerCase()));
});

test('context extracts outcomes after long briefs and budgets the complete string including paths', async t => {
  const { root } = await fixture(t);
  await writeJobNote(root, job());
  const context = await readAgentContext(root, 'games', 900, 'project-game');
  assert.match(context, /RESULTADO ÚTIL/);
  assert.doesNotMatch(context, /ENCARGO EXTENSO/);
  assert.ok(context.length <= 900);
  for (const limit of [0, -1, 20, 80, 200, 500, 1200, 5000]) {
    assert.ok((await readAgentContext(root, 'games', limit, 'project-game')).length <= Math.max(0, limit));
  }
  assert.equal(await readAgentContext(root, 'games', NaN, 'project-game'), '');
  assert.equal(await readAgentContext(root, 'agency', 5000, 'project-game'), '');
  assert.equal(await readAgentContext(root, 'games', 5000, 'other-project'), '');
});

test('answers inherit local project metadata, expose decisions first and link to an actual stable note', async t => {
  const { root, vault } = await fixture(t);
  const parent = job();
  await fs.writeFile(path.join(root, 'data', 'state.json'), JSON.stringify({ jobs: [parent] }));
  const exported = await writeJobNote(root, parent);
  const question = { id: 'question-1', jobId: parent.id, business: 'games', title: parent.title, question: '¿Qué opción?', createdAt: '2026-11-08T12:01:00Z' };
  const answer = await writeAnswerNote(root, question, 'DECISIÓN CONFIRMADA: usar la opción accesible.');
  const text = await fs.readFile(path.join(vault, answer.path), 'utf8');
  assert.match(text, /proyecto_id: "project-game"/);
  assert.ok(text.includes(exported.currentPath.replace(/\.md$/, '')));
  const context = await readAgentContext(root, 'games', 900, 'project-game');
  assert.match(context, /DECISIÓN CONFIRMADA/);
  assert.ok(context.indexOf('Decisión de Daniel') < context.indexOf('Pregunta:'));
  assert.equal((await writeAnswerNote(root, question, 'DECISIÓN CONFIRMADA: usar la opción accesible.')).created, false);
  const missing = await writeAnswerNote(root, { ...question, id: 'missing', jobId: 'not-exported' }, 'Decisión sin enlace inventado.');
  assert.match(await fs.readFile(path.join(vault, missing.path), 'utf8'), /sin nota exportada/);
});

test('legacy snapshots use recorded time instead of mtime and context isolates projects', async t => {
  const { root, vault } = await fixture(t);
  const directory = path.join(vault, 'Centro de Operaciones', 'Trabajos', 'Videojuegos');
  await fs.mkdir(directory, { recursive: true });
  for (const [name, state, date, result] of [
    ['old', 'needs_attention', '2026-11-07T12:00:00Z', 'BLOQUEO ANTIGUO'],
    ['new', 'succeeded', '2026-11-08T12:00:00Z', 'RESULTADO LEGACY VIGENTE'],
  ]) await fs.writeFile(path.join(directory, `${name}.md`), `---\ntipo: "resultado-agente"\nempresa: "games"\nproyecto_id: "project-game"\ntrabajo: "legacy"\nestado: "${state}"\nfinalizado: "${date}"\n---\n# Legacy\n## Encargo\n${'BRIEF '.repeat(300)}\n## Resultado del agente\n${result}\n`);
  await fs.utimes(path.join(directory, 'old.md'), new Date('2030-01-01'), new Date('2030-01-01'));
  const contextDirectory = path.join(vault, 'Centro de Operaciones', 'Contexto', 'Videojuegos');
  await fs.mkdir(contextDirectory, { recursive: true });
  await fs.writeFile(path.join(contextDirectory, 'foreign.md'), '---\nproyecto_id: "other-project"\n---\nCONTEXTO AJENO');
  await fs.writeFile(path.join(contextDirectory, 'global.md'), '# Contexto\nREGLA COMÚN');
  const context = await readAgentContext(root, 'games', 5000, 'project-game');
  assert.match(context, /RESULTADO LEGACY VIGENTE/);
  assert.match(context, /REGLA COMÚN/);
  assert.doesNotMatch(context, /BLOQUEO ANTIGUO|CONTEXTO AJENO|BRIEF/);
});

test('idea versions retain original text and select the newest declared revision once', async t => {
  const { root, vault } = await fixture(t);
  const idea = { id: 'idea-1', business: 'games', projectId: 'project-game', title: 'Idea', createdAt: '2026-11-08T12:00:00Z', version: 1, text: 'IDEA ORIGINAL' };
  const original = await writeIdeaNote(root, idea);
  const updated = await writeIdeaNote(root, { ...idea, version: 2, text: 'IDEA REVISADA' });
  assert.notEqual(original.path, updated.path);
  assert.match(await fs.readFile(path.join(vault, original.path), 'utf8'), /IDEA ORIGINAL/);
  const context = await readAgentContext(root, 'games', 1000, 'project-game');
  assert.match(context, /IDEA REVISADA/);
  assert.doesNotMatch(context, /IDEA ORIGINAL/);
  assert.equal((context.match(/^### /gm) || []).length, 1);
  const long = await writeIdeaNote(root, { ...idea, id: 'long-idea', text: `${'CONTEXTO '.repeat(800)}FINAL SIN RECORTAR` });
  assert.match(await fs.readFile(path.join(vault, long.path), 'utf8'), /FINAL SIN RECORTAR/);
});
