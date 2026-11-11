import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Who this installation is and what its PC can do.
//   equipos/equipos.json   shared, versioned: every PC of the team, its system and its resources (no secrets)
//   data/equipo.json       local: which of those this installation is, how many jobs it runs at once and
//                          whether it reserves branches on the project's remote before working on them
// Without data/equipo.json the installation behaves as before: one job at a time per lane, no resource
// checks, no reservations. Its jobs are still stamped with a team id derived from the host name.
export const TEAM_RESOURCES = ['godot', 'emuladorAndroid', 'telefonoFisico', 'gpu', 'navegador'];
export const RESOURCE_NAMES = { godot: 'Godot', emuladorAndroid: 'emulador de Android', telefonoFisico: 'teléfono físico', gpu: 'GPU', navegador: 'navegador automatizable' };
const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class TeamError extends Error {
  constructor(message) { super(message); this.code = 'team_config_invalid'; }
}
export const hostTeamId = () => (os.hostname().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'equipo-local');

async function readJson(file, label) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return JSON.parse(raw.replace(/^﻿/, '')); } catch { throw new TeamError(`${label}: JSON ilegible.`); }
}

export function normalizeTeams(value) {
  const fail = message => { throw new TeamError(`equipos/equipos.json: ${message}`); };
  if (value === null) return {};
  if (!isObject(value) || value.version !== 1 || !isObject(value.equipos)) fail('debe tener version 1 y equipos.');
  return Object.fromEntries(Object.entries(value.equipos).map(([id, team]) => {
    if (!ID.test(id)) fail(`identificador de equipo inválido ${id}.`);
    if (!isObject(team) || typeof team.nombre !== 'string' || !team.nombre.trim() || !['windows', 'ubuntu', 'macos'].includes(team.sistema)) fail(`${id} necesita nombre y sistema (windows, ubuntu o macos).`);
    if (!Array.isArray(team.recursos) || team.recursos.some(item => !TEAM_RESOURCES.includes(item))) fail(`${id}.recursos debe listar recursos de ${TEAM_RESOURCES.join(', ')}.`);
    return [id, { nombre: team.nombre.trim(), sistema: team.sistema, recursos: [...new Set(team.recursos)] }];
  }));
}

export function normalizeLocalTeam(value, teams) {
  const fail = message => { throw new TeamError(`data/equipo.json: ${message}`); };
  if (!isObject(value) || value.version !== 1 || !ID.test(value.id ?? '')) fail('debe tener version 1 e id (minúsculas, cifras y guiones).');
  if (!teams[value.id]) fail(`el equipo ${value.id} no está en equipos/equipos.json; añádelo allí para que el otro PC lo conozca.`);
  const concurrency = value.concurrencia ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('concurrencia debe estar entre 1 y 4.');
  const claims = value.reservas ?? {};
  if (!isObject(claims) || (claims.activas !== undefined && typeof claims.activas !== 'boolean')) fail('reservas.activas debe ser true o false.');
  const ttl = claims.caducidadMinutos ?? 30;
  if (!Number.isInteger(ttl) || ttl < 5 || ttl > 720) fail('reservas.caducidadMinutos debe estar entre 5 y 720.');
  const remote = claims.remoto ?? 'origin';
  if (typeof remote !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(remote)) fail('reservas.remoto debe ser el nombre de un remoto de Git.');
  return { id: value.id, concurrencia: concurrency, reservas: { activas: claims.activas === true, caducidadMinutos: ttl, remoto: remote } };
}

// The team this installation acts as. configured:false = no data/equipo.json (previous behaviour).
export async function readTeam(root, { codeRoot = CODE_ROOT } = {}) {
  const teams = normalizeTeams(await readJson(path.join(codeRoot, 'equipos', 'equipos.json'), 'equipos/equipos.json'));
  const local = await readJson(path.join(root, 'data', 'equipo.json'), 'data/equipo.json');
  if (local === null) return { configured: false, id: hostTeamId(), nombre: os.hostname(), recursos: null, concurrencia: 1, reservas: { activas: false, caducidadMinutos: 30, remoto: 'origin' }, equipos: teams };
  const mine = normalizeLocalTeam(local, teams);
  return { configured: true, ...mine, nombre: teams[mine.id].nombre, sistema: teams[mine.id].sistema, recursos: teams[mine.id].recursos, equipos: teams };
}

// Resources a job needs on the PC that runs it. Explicit ones come with the job; a games code job always needs the engine.
export function requiredResources(job) {
  const explicit = Array.isArray(job.requires) ? job.requires : [];
  return [...new Set([...(job.business === 'games' && job.kind === 'code' ? ['godot'] : []), ...explicit])];
}
export function validateRequires(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.length || value.some(item => !TEAM_RESOURCES.includes(item))) throw new TeamError(`requires debe listar recursos de ${TEAM_RESOURCES.join(', ')}.`);
  return [...new Set(value)];
}
// Which resources are missing here and which other PCs have them all.
export function missingResources(team, job) {
  if (!team.configured) return { missing: [], elsewhere: [] };
  const needed = requiredResources(job), missing = needed.filter(item => !team.recursos.includes(item));
  const elsewhere = missing.length ? Object.entries(team.equipos).filter(([id, other]) => id !== team.id && needed.every(item => other.recursos.includes(item))).map(([id, other]) => ({ id, nombre: other.nombre })) : [];
  return { missing, elsewhere };
}
