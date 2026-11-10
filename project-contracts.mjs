import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// B (contracts and skills per scope): optional role instructions kept in the Centro's own data, never in the
// checkout an agent edits. Three layers, all optional, applied in this order:
//   data/contracts/global/<stage>.md              every project
//   data/contracts/empresa-<business>/<stage>.md  one business (agency, games)
//   data/contracts/proyecto-<projectId>/<stage>.md one project
// A layer specialises the role; it never changes permissions, publication or the delivery contract,
// which stay under the Centro's control (the brief says so and the Centro's rules come after it).
export const CONTRACT_STAGES = ['planner', 'ux', 'developer', 'qa', 'reviewer'];
export const CONTRACT_MAX_BYTES = 16_000;
const SCOPE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export class ContractFileError extends Error {
  constructor(message) { super(message); this.code = 'project_contract_invalid'; }
}

async function readContract(root, scope, stage) {
  const relative = path.join('data', 'contracts', scope, `${stage}.md`);
  const file = path.join(root, relative);
  let info;
  try { info = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  for (const part of [path.join(root, 'data', 'contracts'), path.join(root, 'data', 'contracts', scope)]) {
    if ((await fs.lstat(part)).isSymbolicLink()) throw new ContractFileError(`La carpeta de contratos ${path.relative(root, part)} no puede ser un enlace.`);
  }
  if (!info.isFile()) throw new ContractFileError(`El contrato ${relative} debe ser un archivo normal, no un enlace ni una carpeta.`);
  if (info.size > CONTRACT_MAX_BYTES) throw new ContractFileError(`El contrato ${relative} supera ${CONTRACT_MAX_BYTES} bytes; resúmelo.`);
  const bytes = await fs.readFile(file);
  const text = bytes.toString('utf8').replace(/^﻿/, '').trim();
  if (!text) return null;
  return { scope, path: relative.split(path.sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, text };
}

export async function readStageContracts(root, { business, projectId, stage }) {
  if (!CONTRACT_STAGES.includes(stage)) return [];
  const scopes = ['global'];
  if (SCOPE_ID.test(business ?? '')) scopes.push(`empresa-${business}`);
  if (SCOPE_ID.test(projectId ?? '')) scopes.push(`proyecto-${projectId}`);
  const found = [];
  for (const scope of scopes) {
    const contract = await readContract(path.resolve(root), scope, stage);
    if (contract) found.push(contract);
  }
  return found;
}

const scopeLabel = scope => scope === 'global' ? 'global' : scope.startsWith('empresa-') ? `empresa ${scope.slice(8)}` : `proyecto ${scope.slice(9)}`;

export function contractsBrief(contracts) {
  if (!contracts.length) return '';
  return [
    'CONTRATOS DE ROL DEL CENTRO (global → empresa → proyecto; el más específico concreta al anterior). Especializan tu perfil.',
    'No cambian permisos, publicación, el contrato de entrega ni las reglas de esta asignación: si algo choca con el encargo o con esas reglas, prevalecen el encargo y el Centro, y lo indicas en tu entrega.',
    ...contracts.map(item => `--- CONTRATO ${scopeLabel(item.scope)} · ${item.path} · sha256 ${item.sha256}\n${item.text}`),
  ].join('\n');
}
