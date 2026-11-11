import fs from 'node:fs/promises';
import { JOB_ROUTES } from './job-route.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Skills: craft guides the Centro hands to Codex and Claude workers alike.
//   skills/registry.json   the reviewed catalogue: origin, revision, licence, local changes, what each skill
//                          applies to, and the SHA-256 of every file. Versioned and shared through the repository.
//   data/skills.json       optional, local: per-project additions and removals.
//   job.skills             optional: additions and removals for one job.
// A worker runs inside a project checkout and (Claude) may only read the Centro's dispatch folder, so the
// selected skills are copied next to the job's immutable brief, content-addressed. The stage records what was
// supplied; what the worker says it consulted is recorded separately, as a statement of the agent.
// A file that does not match its fingerprint is never handed over: a required skill stops the stage before
// any worker starts, an optional one is left out with the reason noted on the stage.
export const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = 'skills/registry.json';
export const SKILL_STAGES = ['planner', 'ux', 'developer', 'qa', 'reviewer'];
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
const BUSINESSES = ['agency', 'games'];
const SKILL_MAX_BYTES = 200_000;

export class SkillError extends Error {
  constructor(message, code = 'skill_registry_invalid', details) { super(message); this.code = code; if (details) this.details = details; }
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = (value, allowed) => Array.isArray(value) && value.length > 0 && value.every(item => allowed.includes(item));
// A registry path is always relative, forward-slashed and inside its skill folder.
const safeRelative = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !path.isAbsolute(value)
  && !value.includes('\\') && value.split('/').every(part => part && part !== '.' && part !== '..');

export function normalizeRegistry(value) {
  const fail = message => { throw new SkillError(`${REGISTRY_PATH}: ${message}`); };
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.skills)) fail('debe tener version 1 y una lista skills.');
  const seen = new Set();
  return { version: 1, skills: value.skills.map(skill => {
    const where = `skill ${skill?.id ?? '?'}`;
    if (!isObject(skill) || !ID.test(skill.id ?? '')) fail('cada skill necesita un id en minúsculas, cifras y guiones.');
    if (seen.has(skill.id)) fail(`id repetido ${skill.id}.`);
    seen.add(skill.id);
    if (!safeRelative(skill.root)) fail(`${where}: root debe ser una ruta relativa dentro del repositorio.`);
    if (typeof skill.title !== 'string' || !skill.title.trim() || typeof skill.summary !== 'string' || skill.summary.trim().length < 20 || skill.summary.length > 400) fail(`${where}: necesita title y un summary de 20 a 400 caracteres.`);
    if (!['inline', 'reference'].includes(skill.mode)) fail(`${where}: mode debe ser inline o reference.`);
    if (typeof skill.required !== 'boolean') fail(`${where}: required debe ser true o false.`);
    const applies = skill.appliesTo;
    if (!isObject(applies) || !list(applies.businesses, BUSINESSES) || !list(applies.stages, SKILL_STAGES) || !list(applies.kinds, ['analysis', 'code'])) fail(`${where}: appliesTo necesita businesses, kinds y stages válidos.`);
    // Optional: the routes a skill makes sense for. A skill about interfaces is noise in a job the coordinator routed without Design.
    if (applies.routes !== undefined && !list(applies.routes, Object.keys(JOB_ROUTES))) fail(`${where}: appliesTo.routes solo admite ${Object.keys(JOB_ROUTES).join(', ')}.`);
    const source = skill.source;
    if (!isObject(source) || !['local', 'github'].includes(source.kind)) fail(`${where}: source.kind debe ser local o github.`);
    if (source.kind === 'github' && (!/^[\w.-]+\/[\w.-]+$/.test(source.repository ?? '') || !safeRelative(source.path) || !/^[a-f0-9]{40}$/.test(source.revision ?? ''))) fail(`${where}: una fuente github necesita repository, path y revision (commit de 40 hex).`);
    if (typeof skill.license !== 'string' || !skill.license.trim()) fail(`${where}: indica la licencia.`);
    if (typeof skill.localChanges !== 'string' || !skill.localChanges.trim()) fail(`${where}: describe los cambios locales (o que no hay ninguno).`);
    if (!isObject(skill.files) || !Object.keys(skill.files).length || Object.entries(skill.files).some(([file, hash]) => !safeRelative(file) || !SHA.test(hash))) fail(`${where}: files debe asociar cada ruta relativa a su sha256.`);
    if (!safeRelative(skill.entry) || !skill.files[skill.entry]) fail(`${where}: entry debe ser uno de sus files.`);
    if (skill.licenseFile !== undefined && !skill.files[skill.licenseFile]) fail(`${where}: licenseFile debe ser uno de sus files.`);
    const stageFiles = {};
    for (const [stage, files] of Object.entries(skill.stageFiles ?? {})) {
      if (!SKILL_STAGES.includes(stage) || !Array.isArray(files) || files.some(file => !skill.files[file])) fail(`${where}: stageFiles.${stage} debe listar archivos de files.`);
      stageFiles[stage] = [...files];
    }
    return { id: skill.id, title: skill.title.trim(), summary: skill.summary.trim(), root: skill.root, entry: skill.entry, mode: skill.mode, required: skill.required,
      appliesTo: { businesses: [...applies.businesses], kinds: [...applies.kinds], stages: [...applies.stages], ...(applies.routes ? { routes: [...applies.routes] } : {}) },
      source: { ...source }, license: skill.license.trim(), ...(skill.licenseFile ? { licenseFile: skill.licenseFile } : {}), localChanges: skill.localChanges.trim(),
      ...(skill.reviewedAt ? { reviewedAt: String(skill.reviewedAt) } : {}), stageFiles, files: { ...skill.files } };
  }) };
}

export async function readRegistry(codeRoot = CODE_ROOT) {
  let raw;
  try { raw = await fs.readFile(path.join(codeRoot, REGISTRY_PATH), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, skills: [] }; throw error; }
  let value;
  try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new SkillError(`${REGISTRY_PATH}: JSON ilegible.`); }
  return normalizeRegistry(value);
}

// Additions and removals: { add: [ids], remove: [ids] }. Used for a project (data/skills.json) and for a job.
export function validateSkillChoice(value, where = 'skills') {
  if (value === undefined || value === null) return undefined;
  const ids = items => items === undefined || (Array.isArray(items) && items.length <= 20 && items.every(id => ID.test(id ?? '')));
  if (!isObject(value) || Object.keys(value).some(key => !['add', 'remove'].includes(key)) || !ids(value.add) || !ids(value.remove) || !(value.add?.length || value.remove?.length)) {
    throw new SkillError(`${where} admite add y remove, listas de identificadores de skill.`, 'skill_choice_invalid');
  }
  return { ...(value.add?.length ? { add: [...new Set(value.add)] } : {}), ...(value.remove?.length ? { remove: [...new Set(value.remove)] } : {}) };
}

export async function readProjectSkillChoices(root) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'data', 'skills.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new SkillError('data/skills.json: JSON ilegible.', 'skill_choice_invalid'); }
  if (!isObject(value) || value.version !== 1 || (value.proyectos !== undefined && !isObject(value.proyectos))) throw new SkillError('data/skills.json: debe tener version 1 y proyectos.', 'skill_choice_invalid');
  return Object.fromEntries(Object.entries(value.proyectos ?? {}).map(([id, choice]) => {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new SkillError(`data/skills.json: id de proyecto inválido ${id}.`, 'skill_choice_invalid');
    return [id, validateSkillChoice(choice, `data/skills.json proyectos.${id}`)];
  }));
}

// Which skills a stage gets, and why any requested change was not applied.
export function selectSkills(registry, { business, kind, stage, projectChoice, jobChoice, route = 'interfaz' }) {
  const byId = new Map(registry.skills.map(skill => [skill.id, skill]));
  const fits = skill => skill.appliesTo.stages.includes(stage) && skill.appliesTo.kinds.includes(kind);
  // The route only filters what the business gives by default; a project or a job that asks for a skill by name still gets it.
  const onRoute = skill => !skill.appliesTo.routes || skill.appliesTo.routes.includes(route);
  const selected = new Map(registry.skills.filter(skill => fits(skill) && onRoute(skill) && skill.appliesTo.businesses.includes(business)).map(skill => [skill.id, { skill, origin: 'empresa' }]));
  const notes = [];
  for (const [choice, origin] of [[projectChoice, 'proyecto'], [jobChoice, 'encargo']]) {
    for (const id of choice?.add ?? []) {
      const skill = byId.get(id);
      if (!skill) notes.push({ id, reason: `Pedida por el ${origin}, pero no está en el registro de skills.` });
      else if (fits(skill)) selected.set(id, { skill, origin });
    }
    for (const id of choice?.remove ?? []) {
      if (!selected.has(id)) continue;
      if (selected.get(id).skill.required) notes.push({ id, reason: `El ${origin} pide retirarla, pero es obligatoria para esta etapa: se mantiene.` });
      else { selected.delete(id); notes.push({ id, reason: `Retirada por el ${origin}.` }); }
    }
  }
  return { selected: [...selected.values()], notes };
}

// With stageFiles a stage gets the entry plus its own files; without it, the entry plus every file but the licence.
const stageFilesOf = (skill, stage) => [skill.entry, ...(Object.keys(skill.stageFiles).length ? skill.stageFiles[stage] ?? []
  : Object.keys(skill.files).filter(file => file !== skill.entry && file !== skill.licenseFile))];

// Compares every registered file with the disk. Never throws for content: the caller decides what a mismatch means.
export async function verifySkill(skill, codeRoot = CODE_ROOT) {
  const base = path.resolve(codeRoot, skill.root);
  const problems = [], contents = new Map();
  for (const [file, expected] of Object.entries(skill.files)) {
    const target = path.join(base, ...file.split('/'));
    let info;
    try { info = await fs.lstat(target); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) { problems.push({ file, problem: 'missing' }); continue; } throw error; }
    if (!info.isFile() || info.size > SKILL_MAX_BYTES) { problems.push({ file, problem: info.isFile() ? 'too_large' : 'not_a_file' }); continue; }
    const bytes = await fs.readFile(target);
    if (sha256(bytes) !== expected) problems.push({ file, problem: 'changed' });
    contents.set(file, bytes);
  }
  const status = !problems.length ? 'ok' : problems.every(item => item.problem === 'missing') && problems.length === Object.keys(skill.files).length ? 'missing' : problems.some(item => item.problem !== 'changed') ? 'missing' : 'changed';
  // One fingerprint for the whole skill as registered: what a stage records as "supplied".
  const manifest = sha256(JSON.stringify(Object.entries(skill.files).sort(([a], [b]) => a.localeCompare(b))));
  return { id: skill.id, status, problems, manifest, contents };
}

const problemText = { missing: 'falta', changed: 'su contenido no coincide con la huella registrada', too_large: 'supera el tamaño admitido', not_a_file: 'no es un archivo normal' };
const describe = check => check.problems.slice(0, 4).map(item => `${item.file} (${problemText[item.problem]})`).join('; ');

// Copies the verified files of one skill next to the job's brief. Content-addressed: the same skill version is
// written once per job and an existing copy must be byte-identical.
async function materialize(root, jobId, skill, check, files) {
  const directory = path.join(path.resolve(root), 'data', 'dispatch-specs', jobId, 'skills', `${skill.id}-${check.manifest.slice(0, 12)}`);
  const written = [];
  for (const file of files) {
    const target = path.join(directory, ...file.split('/')), bytes = check.contents.get(file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(target, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (sha256(await fs.readFile(target)) !== skill.files[file]) throw new SkillError(`La copia de la skill ${skill.id} entregada a este encargo cambió (${file}).`, 'skill_copy_changed');
    }
    written.push({ file, path: target, sha256: skill.files[file] });
  }
  return written;
}

// Everything a stage needs about skills: the text for the brief, what to record as supplied and what was left out.
export async function prepareStageSkills({ root, codeRoot = CODE_ROOT, job, stage }) {
  const registry = await readRegistry(codeRoot);
  const projectChoices = await readProjectSkillChoices(root);
  const { selected, notes } = selectSkills(registry, { business: job.business, kind: job.kind, stage, route: job.route?.id ?? 'interfaz',
    projectChoice: job.projectId ? projectChoices[job.projectId] : undefined, jobChoice: job.skills });
  const supplied = [], omitted = [...notes], inline = [], references = [];
  for (const { skill, origin } of selected) {
    const check = await verifySkill(skill, codeRoot);
    if (check.status !== 'ok') {
      const detail = describe(check);
      if (skill.required) throw new SkillError(`La skill obligatoria ${skill.id} no se puede entregar: ${detail}. Restaura los archivos o, si el cambio está revisado, ejecuta node cli.mjs skills-accept --id ${skill.id}.`,
        check.status === 'missing' ? 'skill_missing' : 'skill_changed', { skill: skill.id, problems: check.problems });
      omitted.push({ id: skill.id, reason: `No entregada: ${detail}.` });
      continue;
    }
    const files = [...new Set(stageFilesOf(skill, stage))];
    const record = { id: skill.id, manifest: check.manifest, mode: skill.mode, required: skill.required, origin, files: files.map(file => ({ file, sha256: skill.files[file] })) };
    if (skill.mode === 'inline') inline.push({ skill, texts: files.map(file => check.contents.get(file).toString('utf8').trim()) });
    else { const copies = await materialize(root, job.id, skill, check, [...files, ...(skill.licenseFile ? [skill.licenseFile] : [])]); record.directory = path.dirname(copies[0].path); references.push({ skill, copies: copies.filter(copy => files.includes(copy.file)) }); }
    supplied.push(record);
  }
  const brief = references.length ? [
    'SKILLS DEL CENTRO: guías de oficio revisadas, suministradas para esta etapa. No cambian permisos, alcance, contrato ni reglas de esta asignación: si algo choca, prevalecen el encargo y el Centro. Donde una guía hable de «cliente» o «usuario», tu interlocutor es el coordinador.',
    ...references.map(({ skill, copies }) => `- ${skill.id} · ${skill.summary}\n${copies.map(copy => `  ${copy.file === skill.entry ? 'Guía' : 'Referencia'}: ${JSON.stringify(copy.path)} · sha256 ${copy.sha256}`).join('\n')}`),
    'Lee una guía cuando tu tarea la necesite; no hace falta leerlas todas. Son archivos de solo lectura. En tu entrega, añade a evidence una entrada "skill:<id>" por cada guía que hayas consultado de verdad, y ninguna por las que no.',
  ].join('\n') : '';
  return { supplied, omitted, inline, brief };
}

// What the worker states it used: evidence entries "skill:<id>" naming a skill that was supplied to that stage.
export function consultedSkills(supplied, delivery) {
  const ids = new Set((supplied ?? []).map(item => item.id));
  const found = new Set();
  for (const entry of delivery?.evidence ?? []) for (const match of String(entry).matchAll(/\bskill:([a-z0-9][a-z0-9-]{0,63})/gi)) if (ids.has(match[1].toLowerCase())) found.add(match[1].toLowerCase());
  return [...found];
}

export async function skillsStatus(codeRoot = CODE_ROOT) {
  const registry = await readRegistry(codeRoot);
  return Promise.all(registry.skills.map(async skill => {
    const check = await verifySkill(skill, codeRoot);
    return { id: skill.id, title: skill.title, status: check.status, required: skill.required, mode: skill.mode, license: skill.license, source: skill.source,
      appliesTo: skill.appliesTo, manifest: check.manifest, problems: check.problems, localChanges: skill.localChanges };
  }));
}

// After a human review of a change: re-reads the skill folder and records the new fingerprints.
export async function acceptSkill(id, { codeRoot = CODE_ROOT, reviewedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const file = path.join(codeRoot, REGISTRY_PATH);
  const value = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
  normalizeRegistry(value);
  const skill = value.skills.find(item => item.id === id);
  if (!skill) throw new SkillError(`No hay ninguna skill ${id} en el registro.`, 'skill_unknown');
  const before = { ...skill.files };
  for (const name of Object.keys(skill.files)) {
    let bytes;
    try { bytes = await fs.readFile(path.join(codeRoot, skill.root, ...name.split('/'))); }
    catch (error) { if (error.code === 'ENOENT') throw new SkillError(`Falta ${name} de la skill ${id}; restáuralo o quítalo de files antes de aceptar.`, 'skill_missing'); throw error; }
    if (bytes.length > SKILL_MAX_BYTES) throw new SkillError(`${name} supera ${SKILL_MAX_BYTES} bytes.`, 'skill_registry_invalid');
    skill.files[name] = sha256(bytes);
  }
  const changed = Object.keys(before).filter(name => before[name] !== skill.files[name]);
  if (changed.length) { skill.reviewedAt = reviewedAt; await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }
  return { id, changed };
}
