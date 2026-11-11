// Configuración local por defecto del equipo. `node cli.mjs instalar` crea en data/ lo que falte a partir de lo
// versionado en perfil-equipo/ y equipos/equipos.json. Nunca sobrescribe un archivo existente, no toca la cola, la
// bóveda de Obsidian, los vínculos con Orca ni credenciales: eso es de cada equipo.
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCH_LEVELS } from './orca-provider.mjs';
import { PIPELINE_FILE, normalizePipeline } from './pipeline-config.mjs';
import { normalizeTeams, normalizeLocalTeam } from './team.mjs';

const CODE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SYSTEMS = { win32: 'windows', linux: 'ubuntu', darwin: 'macos' };
const readJson = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));

async function createIfMissing(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, text, { flag: 'wx' }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

export async function installLocalConfig(root, { codeRoot = CODE_ROOT, platform = os.platform(), pipeline = true } = {}) {
  const report = { created: [], kept: [], notes: [] };
  const note = (file, created) => (created ? report.created : report.kept).push(file);

  if (pipeline) {
    const shared = await readJson(path.join(codeRoot, 'perfil-equipo', 'pipeline.json'));
    normalizePipeline(shared, { levelNames: LAUNCH_LEVELS }); // a broken shared profile must never reach a PC
    note(`data/${PIPELINE_FILE}`, await createIfMissing(path.join(root, 'data', PIPELINE_FILE), `${JSON.stringify(shared, null, 2)}\n`));
  }

  const teams = normalizeTeams(await readJson(path.join(codeRoot, 'equipos', 'equipos.json')));
  const system = SYSTEMS[platform];
  const candidates = Object.entries(teams).filter(([, team]) => team.sistema === system).map(([id]) => id);
  if (candidates.length === 1) {
    const local = { _comentario: 'Local. Identidad de este PC en equipos/equipos.json (docs/EQUIPOS.md). Creado por `node cli.mjs instalar`; edítalo si este PC es otro.', version: 1, id: candidates[0], concurrencia: 1, reservas: { activas: false, caducidadMinutos: 30, remoto: 'origin' } };
    normalizeLocalTeam(local, teams);
    note('data/equipo.json', await createIfMissing(path.join(root, 'data', 'equipo.json'), `${JSON.stringify(local, null, 2)}\n`));
  } else {
    report.notes.push(candidates.length ? `Hay varios equipos de ${system} en equipos/equipos.json (${candidates.join(', ')}); copia ejemplos/equipo.example.json a data/equipo.json con el id de este PC.`
      : `Este sistema (${platform}) no tiene equipo en equipos/equipos.json; añádelo allí y copia ejemplos/equipo.example.json a data/equipo.json.`);
  }
  return report;
}
