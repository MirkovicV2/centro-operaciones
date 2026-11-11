import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { acceptLesson, listProposals, memoryContext, memoryKey, normalizeEntry, normalizeMemory, proposeLesson, readSharedMemory } from '../project-knowledge.mjs';
import { queryJobContext } from '../panel/knowledge-access.mjs';

const reference = { descripcion: 'Versión de referencia de la prueba.' }, provenance = { origen: 'usuario', detalle: 'Decisión del equipo en la prueba.' };
const entry = (id, tipo, estado, extra = {}) => ({ id, tipo, estado, titulo: `Entrada ${id}`, texto: `Texto de ${id}.`, fecha: '2026-11-11', referencia: reference, procedencia: provenance, ...extra });
const lesson = (id, extra = {}) => ({ id, titulo: 'El audio se desincroniza al pausar', fecha: '2026-11-11', referencia: reference, problema: 'Al reanudar, las notas llegan tarde.', causa: 'El reloj de juego seguía el tiempo de proceso y no el de audio.',
  solucion: 'Derivar la posición de la carta del reloj de reproducción de audio.', aplicaCuando: 'Cualquier pantalla con pausa y juicio por tiempo.', procedencia: { origen: 'agente', detalle: 'Propuesta por Desarrollo.', jobId: 'job-leccion', etapa: 'developer' },
  evidencia: [{ tipo: 'informe', jobId: 'job-leccion', etapa: 'qa' }], ...extra });

test('Flecha Trampa: the fast StepMania-style rhythm is the decision in force; match-3 appears only as replaced', async () => {
  const memory = await readSharedMemory({ business: 'games', projectName: 'Flecha Trampa' });
  assert.equal(memory.file, 'memoria/games/flecha-trampa.json');
  assert.equal((await readSharedMemory({ business: 'games', projectName: 'FlechaTrampa' })).key, 'flecha-trampa', 'found by its alias too');
  assert.equal(await readSharedMemory({ business: 'agency', projectName: 'Flecha Trampa' }), null, 'memory never crosses businesses');
  assert.equal(await readSharedMemory({ business: 'games', projectName: 'Otro juego' }), null);
  const current = memoryContext(memory);
  assert.deepEqual(current.vigente.map(item => `${item.id}:${item.estado}`), ['ritmo-rapido-stepmania:vigente']);
  assert.match(current.vigente[0].texto, /ritmo rápido tipo StepMania/);
  assert.deepEqual([current.historial, current.historialOmitido], [undefined, 1], 'a replaced decision is not handed over unless history is asked for');
  assert.equal(JSON.stringify(current).includes('match-3'), true, 'the current decision says what it replaces');
  assert.equal(current.vigente[0].sustituye[0], 'planteamiento-match-3');
  const history = memoryContext(memory, { includeHistory: true });
  assert.deepEqual(history.historial.map(item => `${item.id}:${item.estado}:${item.sustituidaPor}`), ['planteamiento-match-3:sustituida:ritmo-rapido-stepmania']);
  assert.match(history.aviso, /historial .* no es vigente/);
});

test('the context names the project version it is read against and keeps every state apart', () => {
  const memory = normalizeMemory({ version: 1, proyecto: 'Juego', empresa: 'games', entradas: [
    entry('ritmo', 'decision', 'vigente', { sustituye: ['puzle'] }), entry('puzle', 'decision', 'sustituida', { sustituidaPor: 'ritmo' }), entry('paleta', 'contexto', 'vigente'),
    entry('modo-infinito', 'candidato', 'en_evaluacion'), entry('combo-x8', 'candidato', 'descartado', { motivoDescarte: 'Rompía la curva de dificultad en las pruebas.' }),
    { ...lesson('audio-pausa'), tipo: 'leccion', estado: 'validada', procedencia: provenance, evidencia: [{ tipo: 'nota', texto: 'Comprobado por el equipo en dispositivo.' }] }] });
  const published = { mergeSha: 'a'.repeat(40), branch: 'main', mergedAt: '2026-11-10T10:00:00Z' };
  const context = memoryContext(memory, { published });
  assert.deepEqual(context.versionDeReferencia, { mergeSha: 'a'.repeat(40), rama: 'main', integradaEn: '2026-11-10T10:00:00Z' });
  assert.equal(memoryContext(memory).versionDeReferencia, null, 'no verified integration yet is said, not invented');
  assert.deepEqual(context.vigente.map(item => item.id), ['ritmo', 'paleta', 'audio-pausa']);
  assert.deepEqual(context.enEvaluacion.map(item => `${item.id}:${item.estado}`), ['modo-infinito:en_evaluacion']);
  assert.equal(context.historialOmitido, 2);
  // A discarded trial keeps its state and its reason whenever it is looked up later.
  const discarded = memoryContext(memory, { includeHistory: true, published }).historial.find(item => item.id === 'combo-x8');
  assert.deepEqual([discarded.estado, discarded.motivoDescarte], ['descartado', 'Rompía la curva de dificultad en las pruebas.']);
  assert.match(context.sha256, /^[a-f0-9]{64}$/);
  const lessonView = context.vigente.at(-1);
  assert.deepEqual(Object.keys(lessonView).filter(key => ['problema', 'causa', 'solucion', 'aplicaCuando', 'evidencia'].includes(key)), ['problema', 'causa', 'solucion', 'aplicaCuando', 'evidencia']);
  // Bounded: history and candidates are dropped before anything current.
  const small = memoryContext(memory, { includeHistory: true, limit: 1500 });
  assert.equal(small.truncado, true); assert.ok(small.vigente.length >= 1); assert.equal(small.historial.length, 0);
});

test('an entry cannot claim a state it does not justify, and a secret is refused', () => {
  const bad = (entries, message, code = 'project_memory_invalid') => assert.throws(() => normalizeMemory({ version: 1, proyecto: 'Juego', empresa: 'games', entradas: entries }), error => error.code === code && message.test(error.message), JSON.stringify(entries.map(item => item.id)));
  bad([entry('dec-a', 'decision', 'descartado')], /un decision admite estado vigente o sustituida/);
  bad([entry('dec-a', 'candidato', 'vigente')], /un candidato admite estado en_evaluacion o descartado/);
  bad([entry('dec-a', 'decision', 'sustituida')], /indica sustituidaPor/);
  bad([entry('dec-a', 'decision', 'sustituida', { sustituidaPor: 'dec-b' }), entry('dec-b', 'decision', 'vigente')], /que la incluya en sustituye/);
  bad([entry('dec-a', 'decision', 'vigente', { sustituye: ['dec-b'] }), entry('dec-b', 'decision', 'vigente')], /no figura como sustituida por ella/);
  bad([entry('dec-a', 'candidato', 'descartado')], /conserva motivoDescarte/);
  bad([entry('dec-a', 'contexto', 'vigente'), entry('dec-a', 'contexto', 'vigente')], /id repetido/);
  bad([{ ...entry('dec-a', 'contexto', 'vigente'), referencia: {} }], /qué versión del proyecto sirve de referencia/);
  bad([{ ...entry('dec-a', 'contexto', 'vigente'), procedencia: { origen: 'rumor', detalle: 'x' } }], /procedencia necesita origen/);
  bad([entry('dec-a', 'contexto', 'vigente', { texto: 'La clave es ghp_' + 'a'.repeat(36) })], /no guardes secretos/, 'project_memory_secret');
  for (const field of ['problema', 'causa', 'solucion', 'aplicaCuando']) assert.throws(() => normalizeEntry({ ...lesson('lec'), tipo: 'leccion', estado: 'validada', [field]: '' }), new RegExp(`una lección necesita ${field}`));
  assert.throws(() => normalizeEntry({ ...lesson('lec'), tipo: 'leccion', estado: 'validada', evidencia: [] }), /evidencia debe tener entre 1 y 12/);
  assert.throws(() => normalizeEntry({ ...lesson('lec'), tipo: 'leccion', estado: 'validada', evidencia: [{ tipo: 'archivo', ruta: '../fuera.md' }] }), /ruta relativa al proyecto/);
  assert.equal(memoryKey('Flecha Trampa: Edición Ñ'), 'flecha-trampa-edicion-n');
});

async function lessonFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-local-')), codeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-compartida-'));
  t.after(() => Promise.all([root, codeRoot].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  const report = path.join(root, 'data', 'stage-reports', 'qa.txt'); await fs.mkdir(path.dirname(report), { recursive: true }); await fs.writeFile(report, 'QA: la pausa conserva la sincronía.');
  const artifact = { path: report, sha256: createHash('sha256').update(await fs.readFile(report)).digest('hex') };
  const jobs = [{ id: 'job-leccion', business: 'games', projectId: 'project-juego', workflow: { steps: [{ key: 'qa', status: 'succeeded', artifact }] } },
    { id: 'job-ajeno', business: 'games', projectId: 'project-otro', workflow: { steps: [{ key: 'qa', status: 'succeeded', artifact }] } }];
  const checkout = path.join(root, 'workspaces', 'juego'); await fs.mkdir(checkout, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '--quiet'); await fs.writeFile(path.join(checkout, 'audio.gd'), 'extends Node\n'); git('add', '.'); git('commit', '--quiet', '-m', 'audio');
  const scope = { business: 'games', projectName: 'Juego de ritmo' };
  const accept = (id, extra = {}) => acceptLesson(root, { ...scope, id, jobs, projectId: 'project-juego', checkout, codeRoot, acceptedBy: 'david', today: '2026-11-12', ...extra });
  return { root, codeRoot, report, jobs, checkout, commit: git('rev-parse', 'HEAD'), scope, accept };
}

test('a lesson proposed by a model has no effect until its provenance and every reference are verified', async t => {
  const f = await lessonFixture(t);
  const full = lesson('audio-pausa', { evidencia: [{ tipo: 'informe', jobId: 'job-leccion', etapa: 'qa' }, { tipo: 'commit', sha: f.commit }, { tipo: 'archivo', ruta: 'audio.gd' }] });
  assert.deepEqual(await proposeLesson(f.root, { ...f.scope, lesson: full }), { id: 'audio-pausa', key: 'juego-de-ritmo' });
  assert.equal((await listProposals(f.root, f.scope))[0].estado, 'propuesta');
  assert.equal(await readSharedMemory({ ...f.scope, codeRoot: f.codeRoot }), null, 'a proposal is local and reaches no brief');
  await assert.rejects(proposeLesson(f.root, { ...f.scope, lesson: full }), { code: 'project_memory_duplicate' });
  const accepted = await f.accept('audio-pausa');
  assert.equal(accepted.file, 'memoria/games/juego-de-ritmo.json');
  const memory = await readSharedMemory({ ...f.scope, codeRoot: f.codeRoot });
  const saved = memory.entradas[0];
  assert.deepEqual([saved.estado, saved.procedencia.origen, saved.procedencia.jobId, saved.procedencia.registradoPor], ['validada', 'agente', 'job-leccion', 'david']);
  assert.deepEqual(saved.evidencia.map(item => `${item.tipo}:${item.verificadoEn}:${Boolean(item.sha256 || item.sha)}`), ['informe:2026-11-12:true', 'commit:2026-11-12:true', 'archivo:2026-11-12:true']);
  assert.deepEqual(await listProposals(f.root, f.scope), [], 'an accepted proposal leaves the local list');
  assert.equal(memoryContext(memory).vigente[0].id, 'audio-pausa');
});

test('a lesson is refused when its origin or any reference does not hold', async t => {
  const f = await lessonFixture(t);
  const propose = (id, extra) => proposeLesson(f.root, { ...f.scope, lesson: lesson(id, extra) });
  const refused = async (id, message) => { await assert.rejects(f.accept(id), error => error.code === 'project_memory_unverified' && message.test(error.message), id); assert.equal(await readSharedMemory({ ...f.scope, codeRoot: f.codeRoot }), null); };
  await propose('otro-proyecto', { procedencia: { origen: 'agente', detalle: 'De otro proyecto.', jobId: 'job-ajeno', etapa: 'qa' } });
  await refused('otro-proyecto', /nombra un encargo que no existe en este proyecto/);
  await propose('sin-encargo', { procedencia: { origen: 'coordinador', detalle: 'Sin encargo.' } });
  await refused('sin-encargo', /nombra un encargo que no existe/);
  await propose('informe-ajeno', { evidencia: [{ tipo: 'informe', jobId: 'job-ajeno', etapa: 'qa' }] });
  await refused('informe-ajeno', /no existe el informe de qa del encargo job-ajeno/);
  await propose('commit-inventado', { evidencia: [{ tipo: 'commit', sha: 'f'.repeat(40) }] });
  await refused('commit-inventado', /el commit f{40} no existe/);
  await propose('archivo-inventado', { evidencia: [{ tipo: 'archivo', ruta: 'no-existe.gd' }] });
  await refused('archivo-inventado', /el archivo no-existe\.gd no existe/);
  await propose('huella-distinta', { evidencia: [{ tipo: 'archivo', ruta: 'audio.gd', sha256: '0'.repeat(64) }] });
  await refused('huella-distinta', /no coincide con la huella indicada/);
  await propose('solo-palabra', { evidencia: [{ tipo: 'nota', texto: 'Confía en mí, funciona.' }] });
  await refused('solo-palabra', /una nota sin referencia solo vale .* cuando la aporta el usuario/);
  await propose('informe-cambiado');
  await fs.appendFile(f.report, '\n(editado después)');
  await refused('informe-cambiado', /cambió desde que se registró/);
  await assert.rejects(f.accept('no-propuesta'), { code: 'project_memory_unknown' });
  assert.equal((await listProposals(f.root, f.scope)).length, 8, 'refused proposals stay local for review');
  // The user's own statement is accepted as what it is: a note with the user as origin.
  await propose('decision-de-uso', { procedencia: { origen: 'usuario', detalle: 'Observado por Dani en su teléfono.' }, evidencia: [{ tipo: 'nota', texto: 'A 120 Hz la ventana de juicio se percibe más estrecha.' }] });
  assert.equal((await f.accept('decision-de-uso')).evidencia[0].tipo, 'nota');
});

test('accepted decisions reach a worker even when Obsidian cannot be read', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memoria-contexto-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  const run = { runId: 'run_memoria01', taskId: 'task_memoria01', dispatchId: 'ctx_memoria01' };
  const jobs = [{ id: 'job-ritmo', business: 'games', projectId: 'project-flecha', state: 'running', attempts: 1, kind: 'code', coordination: { requestId: 'request-ritmo01', runId: run.runId },
    workflow: { runId: run.runId, currentStage: 'developer', steps: [{ key: 'developer', status: 'running', ...run, attempt: 1, taskInputAttempt: 1 }] } }];
  await fs.writeFile(path.join(root, 'data', 'operations-inbox.json'), JSON.stringify({ schema: 1, exportedJobs: {}, questions: [], ideas: [], coordinatorRequests: [], projects: [{ id: 'project-flecha', name: 'Flecha Trampa', business: 'games' }] }));
  await fs.writeFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: 1, patch: { jobs } }) + '\n');
  // The configured vault does not exist: the usual "temporarily unreachable" case.
  await fs.writeFile(path.join(root, 'data', 'operations-dashboard.json'), JSON.stringify({ vaultPath: path.join(root, 'boveda-desconectada') }));
  const ask = extra => queryJobContext(root, 'job-ritmo', { stage: 'developer', ...run, jobAttempt: 1, query: 'ritmo del juego', ...extra });
  const context = await ask({ consultationId: 'contexto-1' });
  assert.equal(context.connected, false); assert.deepEqual(context.sources, []);
  assert.deepEqual(context.sharedMemory.vigente.map(item => item.id), ['ritmo-rapido-stepmania']);
  assert.equal(context.sharedMemory.archivo, 'memoria/games/flecha-trampa.json');
  assert.equal(context.sharedMemory.historial, undefined);
  const withHistory = await ask({ consultationId: 'contexto-2', includeHistory: true });
  assert.deepEqual(withHistory.sharedMemory.historial.map(item => `${item.id}:${item.estado}`), ['planteamiento-match-3:sustituida']);
  // The same consultation replayed returns the evidence it delivered the first time.
  assert.deepEqual((await ask({ consultationId: 'contexto-1' })).sharedMemory, context.sharedMemory);
});
