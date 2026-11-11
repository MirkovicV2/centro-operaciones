import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceLocalFile } from './atomic-file.mjs';

// Shared project memory: what the team has accepted about a project, versioned in the Centro's repository so both
// PCs have it and it stays readable when Obsidian is not. One file per project: memoria/<empresa>/<clave>.json.
// Every entry says what it is and in which state, so an old idea can never pass for a current one:
//   decision   vigente | sustituida (names the entry that replaced it)
//   contexto   vigente                      accepted facts about the product
//   candidato  en_evaluacion | descartado   a discarded trial keeps its state and its reason for ever
//   leccion    validada                     problem, cause, solution, evidence and when it applies
// A lesson can be proposed by anyone, a model included (data/memory-proposals, local). It only enters this shared
// memory through acceptLesson, which checks where it comes from and that every reference really exists.
// Secrets, credentials and operational state never belong here: the folder is shared through the repository.
export const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_DIR = 'memoria';
const STATES = Object.freeze({ decision: ['vigente', 'sustituida'], contexto: ['vigente'], candidato: ['en_evaluacion', 'descartado'], leccion: ['validada'] });
const ORIGINS = ['usuario', 'coordinador', 'agente'];
const EVIDENCE_KINDS = ['informe', 'commit', 'archivo', 'nota'];
const ID = /^[a-z0-9][a-z0-9-]{1,59}$/;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, min = 4) => typeof value === 'string' && value.trim().length >= min && value.length <= max;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// A secret must never be written into a shared, versioned file. Same shapes the queue refuses in prompts.
const SECRET = /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|\b\d{8,10}:[A-Za-z0-9_-]{30,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export class MemoryError extends Error {
  constructor(message, code = 'project_memory_invalid') { super(message); this.code = code; }
}
export const memoryKey = name => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

function normalizeProvenance(value, where) {
  if (!isObject(value) || !ORIGINS.includes(value.origen) || !text(value.detalle, 300)) throw new MemoryError(`${where}: procedencia necesita origen (${ORIGINS.join(', ')}) y detalle.`);
  return { origen: value.origen, detalle: value.detalle.trim(), ...(text(value.jobId, 80, 1) ? { jobId: value.jobId } : {}), ...(text(value.etapa, 20, 1) ? { etapa: value.etapa } : {}), ...(text(value.registradoPor, 200, 1) ? { registradoPor: value.registradoPor } : {}) };
}
function normalizeReference(value, where) {
  if (!isObject(value) || !text(value.descripcion, 300)) throw new MemoryError(`${where}: referencia necesita descripcion (qué versión del proyecto sirve de referencia).`);
  if (value.commit !== undefined && value.commit !== null && !/^[a-f0-9]{7,64}$/.test(value.commit)) throw new MemoryError(`${where}: referencia.commit debe ser un SHA.`);
  return { descripcion: value.descripcion.trim(), ...(value.commit ? { commit: value.commit } : {}) };
}
function normalizeEvidence(value, where) {
  if (!Array.isArray(value) || !value.length || value.length > 12) throw new MemoryError(`${where}: evidencia debe tener entre 1 y 12 referencias.`);
  return value.map(item => {
    if (!isObject(item) || !EVIDENCE_KINDS.includes(item.tipo)) throw new MemoryError(`${where}: cada evidencia necesita tipo (${EVIDENCE_KINDS.join(', ')}).`);
    if (item.tipo === 'informe' && (!text(item.jobId, 80, 1) || !text(item.etapa, 20, 1))) throw new MemoryError(`${where}: una evidencia informe necesita jobId y etapa.`);
    if (item.tipo === 'commit' && !/^[a-f0-9]{7,64}$/.test(item.sha ?? '')) throw new MemoryError(`${where}: una evidencia commit necesita sha.`);
    if (item.tipo === 'archivo' && (!text(item.ruta, 300, 1) || path.isAbsolute(item.ruta) || item.ruta.split(/[\\/]/).includes('..'))) throw new MemoryError(`${where}: una evidencia archivo necesita una ruta relativa al proyecto.`);
    if (item.tipo === 'nota' && !text(item.texto, 600)) throw new MemoryError(`${where}: una evidencia nota necesita texto.`);
    if (item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256)) throw new MemoryError(`${where}: sha256 inválido.`);
    return Object.fromEntries(['tipo', 'jobId', 'etapa', 'sha', 'ruta', 'texto', 'sha256', 'verificadoEn'].filter(key => item[key] !== undefined).map(key => [key, item[key]]));
  });
}

export function normalizeEntry(entry, where = 'entrada') {
  if (!isObject(entry) || !ID.test(entry.id ?? '')) throw new MemoryError(`${where}: id en minúsculas, cifras y guiones.`);
  where = `entrada ${entry.id}`;
  if (!Object.hasOwn(STATES, entry.tipo ?? '')) throw new MemoryError(`${where}: tipo debe ser ${Object.keys(STATES).join(', ')}.`);
  if (!STATES[entry.tipo].includes(entry.estado)) throw new MemoryError(`${where}: un ${entry.tipo} admite estado ${STATES[entry.tipo].join(' o ')}.`);
  if (!text(entry.titulo, 160)) throw new MemoryError(`${where}: titulo de 4 a 160 caracteres.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.fecha ?? '')) throw new MemoryError(`${where}: fecha AAAA-MM-DD.`);
  const base = { id: entry.id, tipo: entry.tipo, estado: entry.estado, titulo: entry.titulo.trim(), fecha: entry.fecha,
    referencia: normalizeReference(entry.referencia, where), procedencia: normalizeProvenance(entry.procedencia, where) };
  if (entry.tipo === 'leccion') {
    for (const field of ['problema', 'causa', 'solucion', 'aplicaCuando']) if (!text(entry[field], 800)) throw new MemoryError(`${where}: una lección necesita ${field}.`);
    Object.assign(base, { problema: entry.problema.trim(), causa: entry.causa.trim(), solucion: entry.solucion.trim(), aplicaCuando: entry.aplicaCuando.trim(), evidencia: normalizeEvidence(entry.evidencia, where) });
  } else {
    if (!text(entry.texto, 1200)) throw new MemoryError(`${where}: texto de 4 a 1200 caracteres.`);
    base.texto = entry.texto.trim();
  }
  if (entry.estado === 'sustituida') { if (!ID.test(entry.sustituidaPor ?? '')) throw new MemoryError(`${where}: una decisión sustituida indica sustituidaPor.`); base.sustituidaPor = entry.sustituidaPor; }
  if (entry.estado === 'descartado') { if (!text(entry.motivoDescarte, 600)) throw new MemoryError(`${where}: un candidato descartado conserva motivoDescarte.`); base.motivoDescarte = entry.motivoDescarte.trim(); }
  if (entry.sustituye !== undefined) { if (!Array.isArray(entry.sustituye) || entry.sustituye.some(id => !ID.test(id ?? ''))) throw new MemoryError(`${where}: sustituye debe listar ids.`); base.sustituye = [...new Set(entry.sustituye)]; }
  if (SECRET.test(JSON.stringify(base))) throw new MemoryError(`${where}: contiene algo con forma de clave o token. La memoria se comparte por el repositorio: no guardes secretos.`, 'project_memory_secret');
  return base;
}

export function normalizeMemory(value) {
  if (!isObject(value) || value.version !== 1 || !text(value.proyecto, 100, 2) || !['agency', 'games'].includes(value.empresa) || !Array.isArray(value.entradas)) {
    throw new MemoryError('la memoria necesita version 1, proyecto, empresa (agency o games) y entradas.');
  }
  const entries = value.entradas.map((entry, index) => normalizeEntry(entry, `entrada ${index + 1}`));
  const byId = new Map();
  for (const entry of entries) { if (byId.has(entry.id)) throw new MemoryError(`id repetido ${entry.id}.`); byId.set(entry.id, entry); }
  for (const entry of entries) {
    // A replaced decision must point at a decision that exists and says, in turn, that it replaces this one.
    if (entry.sustituidaPor) {
      const next = byId.get(entry.sustituidaPor);
      if (!next || next.tipo !== 'decision' || !next.sustituye?.includes(entry.id)) throw new MemoryError(`entrada ${entry.id}: sustituidaPor debe nombrar una decisión que la incluya en sustituye.`);
    }
    for (const id of entry.sustituye ?? []) if (byId.get(id)?.sustituidaPor !== entry.id) throw new MemoryError(`entrada ${entry.id}: sustituye a ${id}, que no figura como sustituida por ella.`);
  }
  const aliases = value.alias === undefined ? [] : value.alias;
  if (!Array.isArray(aliases) || aliases.some(item => !text(item, 100, 2))) throw new MemoryError('alias debe ser una lista de nombres.');
  return { version: 1, proyecto: value.proyecto.trim(), empresa: value.empresa, alias: [...aliases], entradas: entries };
}

// The memory of a project, found by its name (or an alias): project ids are random and differ between PCs.
export async function readSharedMemory({ business, projectName, codeRoot = CODE_ROOT }) {
  const key = memoryKey(projectName);
  if (!key || !['agency', 'games'].includes(business)) return null;
  const directory = path.join(codeRoot, MEMORY_DIR, business);
  let names;
  try { names = (await fs.readdir(directory)).filter(name => name.endsWith('.json')).sort(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const name of names) {
    let value;
    try { value = JSON.parse((await fs.readFile(path.join(directory, name), 'utf8')).replace(/^﻿/, '')); } catch { throw new MemoryError(`${MEMORY_DIR}/${business}/${name}: JSON ilegible.`); }
    const memory = normalizeMemory(value);
    if (memory.empresa !== business) throw new MemoryError(`${MEMORY_DIR}/${business}/${name}: la empresa del archivo no coincide con su carpeta.`);
    if ([name.replace(/\.json$/, ''), memoryKey(memory.proyecto), ...memory.alias.map(memoryKey)].includes(key)) return { key: name.replace(/\.json$/, ''), file: `${MEMORY_DIR}/${business}/${name}`, ...memory };
  }
  return null;
}

// What a worker or coordinator receives. Current knowledge always; replaced decisions and discarded candidates only
// when history is asked for, and always labelled with their state so they cannot be read as current.
export function memoryContext(memory, { includeHistory = false, published = null, limit = 4000 } = {}) {
  if (!memory) return null;
  const brief = entry => ({ id: entry.id, tipo: entry.tipo, estado: entry.estado, titulo: entry.titulo, fecha: entry.fecha, referencia: entry.referencia,
    ...(entry.tipo === 'leccion' ? { problema: entry.problema, causa: entry.causa, solucion: entry.solucion, aplicaCuando: entry.aplicaCuando, evidencia: entry.evidencia.length } : { texto: entry.texto }),
    ...(entry.sustituye?.length ? { sustituye: entry.sustituye } : {}), ...(entry.sustituidaPor ? { sustituidaPor: entry.sustituidaPor } : {}), ...(entry.motivoDescarte ? { motivoDescarte: entry.motivoDescarte } : {}) });
  const current = memory.entradas.filter(entry => ['vigente', 'validada'].includes(entry.estado)).map(brief);
  const evaluating = memory.entradas.filter(entry => entry.estado === 'en_evaluacion').map(brief);
  const past = memory.entradas.filter(entry => ['sustituida', 'descartado'].includes(entry.estado));
  const context = { proyecto: memory.proyecto, archivo: memory.file ?? null, sha256: sha256(JSON.stringify(memory.entradas)),
    // Which version of the project the current knowledge is read against.
    versionDeReferencia: published ? { mergeSha: published.mergeSha, rama: published.branch ?? null, integradaEn: published.mergedAt } : null,
    vigente: current, enEvaluacion: evaluating,
    ...(includeHistory ? { historial: past.map(brief) } : { historialOmitido: past.length }),
    aviso: 'vigente es lo aceptado por el equipo. enEvaluacion no está decidido. historial (sustituida, descartado) no es vigente: no lo apliques.' };
  // Bounded: current knowledge is kept whole first; evaluation and history are dropped before any current entry.
  for (const key of ['historial', 'enEvaluacion']) while (JSON.stringify(context).length > limit && context[key]?.length) { context[key].pop(); context.truncado = true; }
  while (JSON.stringify(context).length > limit && context.vigente.length > 1) { context.vigente.pop(); context.truncado = true; }
  return context;
}

const proposalsFile = (root, business, key) => path.join(root, 'data', 'memory-proposals', business, `${key}.json`);
async function readProposals(root, business, key) {
  try { return JSON.parse(await fs.readFile(proposalsFile(root, business, key), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await replaceLocalFile(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

// Anyone may propose a lesson. It stays local and has no effect on any brief until it is accepted.
export async function proposeLesson(root, { business, projectName, lesson }) {
  const key = memoryKey(projectName);
  if (!key) throw new MemoryError('Indica el proyecto de la lección.');
  const entry = normalizeEntry({ ...lesson, tipo: 'leccion', estado: 'validada' }); // same shape it must have once accepted
  const proposals = await readProposals(root, business, key);
  if (proposals.some(item => item.id === entry.id)) throw new MemoryError(`Ya hay una propuesta ${entry.id} para este proyecto.`, 'project_memory_duplicate');
  await writeJson(proposalsFile(root, business, key), [...proposals, { ...entry, estado: 'propuesta', propuestaEn: new Date().toISOString() }]);
  return { id: entry.id, key };
}
export const listProposals = (root, { business, projectName }) => readProposals(root, business, memoryKey(projectName));

const gitOk = (cwd, args) => new Promise(resolve => execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, error => resolve(!error)));

// Checks where a proposed lesson comes from and that each reference exists, then writes it to the shared memory.
// jobs: this installation's queue. checkout: the project's checkout, for commits and files.
export async function acceptLesson(root, { business, projectName, id, jobs = [], projectId = null, checkout = null, acceptedBy = null, codeRoot = CODE_ROOT, today = new Date().toISOString().slice(0, 10) }) {
  const key = memoryKey(projectName);
  const proposals = await readProposals(root, business, key);
  const proposal = proposals.find(item => item.id === id);
  if (!proposal) throw new MemoryError(`No hay ninguna propuesta ${id} para ${projectName}.`, 'project_memory_unknown');
  const refuse = message => { throw new MemoryError(`La lección ${id} no se incorpora: ${message}`, 'project_memory_unverified'); };
  const ownJob = jobId => jobs.find(job => job.id === jobId && job.business === business && (!projectId || job.projectId === projectId));
  // Provenance: a lesson from an agent or the coordinator must come from a real job of this project.
  if (proposal.procedencia.origen !== 'usuario') {
    if (!proposal.procedencia.jobId || !ownJob(proposal.procedencia.jobId)) refuse('su procedencia nombra un encargo que no existe en este proyecto.');
  }
  const verified = [];
  for (const item of proposal.evidencia) {
    if (item.tipo === 'nota') { if (proposal.procedencia.origen !== 'usuario') refuse('una nota sin referencia solo vale como evidencia cuando la aporta el usuario.'); verified.push(item); continue; }
    if (item.tipo === 'informe') {
      const step = ownJob(item.jobId)?.workflow?.steps?.find(candidate => candidate.key === item.etapa);
      if (!step?.artifact?.path || !/^[a-f0-9]{64}$/.test(step.artifact.sha256 ?? '')) refuse(`no existe el informe de ${item.etapa} del encargo ${item.jobId}.`);
      let bytes;
      try { bytes = await fs.readFile(step.artifact.path); } catch { refuse(`el informe de ${item.etapa} del encargo ${item.jobId} ya no está en disco.`); }
      if (sha256(bytes) !== step.artifact.sha256) refuse(`el informe de ${item.etapa} del encargo ${item.jobId} cambió desde que se registró.`);
      verified.push({ ...item, sha256: step.artifact.sha256, verificadoEn: today }); continue;
    }
    if (!checkout) refuse('hace falta el checkout del proyecto para comprobar commits y archivos.');
    if (item.tipo === 'commit') {
      if (!await gitOk(checkout, ['cat-file', '-e', `${item.sha}^{commit}`])) refuse(`el commit ${item.sha} no existe en el checkout del proyecto.`);
      verified.push({ ...item, verificadoEn: today }); continue;
    }
    let bytes;
    try { bytes = await fs.readFile(path.join(checkout, ...item.ruta.split(/[\\/]/))); } catch { refuse(`el archivo ${item.ruta} no existe en el checkout del proyecto.`); }
    if (item.sha256 && item.sha256 !== sha256(bytes)) refuse(`el archivo ${item.ruta} no coincide con la huella indicada.`);
    verified.push({ ...item, sha256: sha256(bytes), verificadoEn: today });
  }
  if (!verified.some(item => item.tipo !== 'nota') && proposal.procedencia.origen !== 'usuario') refuse('no aporta ninguna referencia comprobable.');
  const existing = await readSharedMemory({ business, projectName, codeRoot });
  const memory = existing ?? { version: 1, proyecto: projectName, empresa: business, alias: [], entradas: [], key, file: `${MEMORY_DIR}/${business}/${key}.json` };
  if (memory.entradas.some(entry => entry.id === id)) throw new MemoryError(`La memoria de ${projectName} ya tiene una entrada ${id}.`, 'project_memory_duplicate');
  const { propuestaEn, ...lesson } = proposal;
  const accepted = normalizeEntry({ ...lesson, estado: 'validada', evidencia: verified, procedencia: { ...lesson.procedencia, ...(acceptedBy ? { registradoPor: acceptedBy } : {}) } });
  const next = normalizeMemory({ version: 1, proyecto: memory.proyecto, empresa: memory.empresa, alias: memory.alias, entradas: [...memory.entradas, accepted] });
  await writeJson(path.join(codeRoot, MEMORY_DIR, business, `${memory.key}.json`), next);
  await writeJson(proposalsFile(root, business, key), proposals.filter(item => item.id !== id));
  return { id, file: `${MEMORY_DIR}/${business}/${memory.key}.json`, evidencia: verified };
}
