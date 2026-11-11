import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SHARED_CONTRACTS_ROOT = path.dirname(fileURLToPath(import.meta.url));

// Optional role instructions kept outside the checkout an agent edits. Two places, both optional:
//   contratos/<scope>/<stage>.md        shared: versioned in the Centro's repository, the same on every PC
//   data/contracts/<scope>/<stage>.md   local: this installation only
// Scopes, applied in this order (the most specific concretises the previous one; within a scope, shared then local):
//   global              every project
//   empresa-<business>  one business (agency, games)
//   proyecto-<id>       one project
// A layer specialises the role; it never changes permissions, publication or the delivery contract,
// which stay under the Centro's control (the brief says so and the Centro's rules come after it).
export const CONTRACT_STAGES = ['planner', 'ux', 'developer', 'qa', 'reviewer'];
export const CONTRACT_MAX_BYTES = 16_000;
const SCOPE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export class ContractFileError extends Error {
  constructor(message) { super(message); this.code = 'project_contract_invalid'; }
}

async function readContract(root, scope, stage, base = ['data', 'contracts']) {
  const relative = path.join(...base, scope, `${stage}.md`);
  const file = path.join(root, relative);
  let info;
  try { info = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  for (const part of [path.join(root, ...base), path.join(root, ...base, scope)]) {
    if ((await fs.lstat(part)).isSymbolicLink()) throw new ContractFileError(`La carpeta de contratos ${path.relative(root, part)} no puede ser un enlace.`);
  }
  if (!info.isFile()) throw new ContractFileError(`El contrato ${relative} debe ser un archivo normal, no un enlace ni una carpeta.`);
  if (info.size > CONTRACT_MAX_BYTES) throw new ContractFileError(`El contrato ${relative} supera ${CONTRACT_MAX_BYTES} bytes; resúmelo.`);
  const bytes = await fs.readFile(file);
  const text = bytes.toString('utf8').replace(/^﻿/, '').trim();
  if (!text) return null;
  return { scope, shared: base[0] === 'contratos', path: relative.split(path.sep).join('/'), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, text };
}

export async function readStageContracts(root, { business, projectId, stage, sharedRoot = SHARED_CONTRACTS_ROOT }) {
  if (!CONTRACT_STAGES.includes(stage)) return [];
  const scopes = ['global'];
  if (SCOPE_ID.test(business ?? '')) scopes.push(`empresa-${business}`);
  if (SCOPE_ID.test(projectId ?? '')) scopes.push(`proyecto-${projectId}`);
  const found = [];
  for (const scope of scopes) {
    const shared = sharedRoot ? await readContract(path.resolve(sharedRoot), scope, stage, ['contratos']) : null;
    if (shared) found.push(shared);
    const contract = await readContract(path.resolve(root), scope, stage);
    if (contract) found.push(contract);
  }
  return found;
}

const scopeLabel = scope => scope === 'global' ? 'global' : scope.startsWith('empresa-') ? `empresa ${scope.slice(8)}` : `proyecto ${scope.slice(9)}`;

export function contractsBrief(contracts) {
  if (!contracts.length) return '';
  return [
    'CONTRATOS DE ROL DEL CENTRO (global → empresa → proyecto; el más específico concreta al anterior; en cada ámbito, primero el compartido del repositorio y después el local de esta instalación). Especializan tu perfil.',
    'No cambian permisos, publicación, el contrato de entrega ni las reglas de esta asignación: si algo choca con el encargo o con esas reglas, prevalecen el encargo y el Centro, y lo indicas en tu entrega.',
    ...contracts.map(item => `--- CONTRATO ${scopeLabel(item.scope)}${item.shared ? ' (compartido)' : ''} · ${item.path} · sha256 ${item.sha256}\n${item.text}`),
  ].join('\n');
}

// Files a contract tells the worker to read that live outside what a Claude worker may read without asking: its checkout,
// the Centro's dispatch specs and stage reports, and whatever `Read(...)` rules the checkout's own settings allow.
// A contract that cites `~/dev/es-skills/x/SKILL.md` made the first real pilot wait 18 minutes at a permission dialog.
// Only backticked paths to a file are considered, so prose that merely names a folder is not flagged.
export async function unreadableReferences(contracts, { workspace, root, home = os.homedir() }) {
  const cited = new Set();
  for (const contract of contracts) for (const match of contract.text.matchAll(/`((?:~|\/)[^`\r\n]{2,300}\.[A-Za-z0-9]{1,8})`/g)) cited.add(match[1].trim());
  if (!cited.size) return [];
  const allowed = [path.resolve(workspace), path.resolve(root, 'data', 'dispatch-specs'), path.resolve(root, 'data', 'stage-reports')];
  try {
    const settings = JSON.parse(await fs.readFile(path.join(workspace, '.claude', 'settings.local.json'), 'utf8'));
    for (const rule of settings?.permissions?.allow ?? []) {
      const match = /^Read\((.+)\)$/.exec(typeof rule === 'string' ? rule : '');
      if (!match) continue;
      const target = match[1].startsWith('//') ? match[1].slice(1) : match[1].startsWith('~/') ? path.join(home, match[1].slice(2)) : null;
      if (target) allowed.push(path.resolve(target.replace(/\/?\*\*.*$/, '').replace(/\*.*$/, '')));
    }
  } catch { /* no settings or unreadable: only the built-in locations count */ }
  const inside = (file, base) => file === base || file.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
  return [...cited].filter(reference => {
    const file = path.resolve(reference.startsWith('~/') ? path.join(home, reference.slice(2)) : reference);
    return !allowed.some(base => inside(file, base));
  }).sort();
}
