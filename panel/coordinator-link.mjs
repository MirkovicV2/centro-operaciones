// `node cli.mjs vincular`: writes this PC's data/coordinator-bindings.json from what Orca itself reports,
// instead of copying runId and senderId by hand. The binding stays local: it names live Orca sessions of
// this PC (see docs/COMUN_Y_LOCAL.md). Only Orca's own answers are written, and only after checking them.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { validatedConfig, isCoordinatorIdentity } from './coordinator-routing.mjs';
import { coordinatorCommand } from './coordinator-bridge.mjs';

const DEFAULTS = { agency: { id: 'agencia-local', name: 'Coordinador de Agencia' }, games: { id: 'videojuegos-local', name: 'Coordinador de Videojuegos' } };
const WORKTREE_ID = /^(?:[A-Za-z0-9_-]+::[^\r\n\u0000]+|folder:[A-Za-z0-9_-]{6,80}|wt2:[A-Za-z0-9_.:-]+)$/;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export async function linkCoordinator(root, { business, runId, id, name } = {}, { command = coordinatorCommand, now = () => new Date() } = {}) {
  if (!DEFAULTS[business]) fail('link_business', 'Indica --business agency o --business games.');
  if (typeof runId !== 'string' || !/^run_[A-Za-z0-9_-]{6,80}$/.test(runId)) fail('link_run', 'Indica --run con el id de la Run del coordinador (run_…), el que devolvió orchestration run-create.');
  const cwd = path.resolve(root);
  let shown;
  try { shown = await command(['orchestration', 'run-show', '--id', runId, '--full'], { cwd }); }
  catch (error) { fail('link_run_unreadable', `Orca no pudo mostrar ${runId}: ${String(error.message ?? error).slice(0, 200)}`); }
  const senderId = shown?.run?.coordinator_handle;
  if (shown?.run?.id !== runId || !isCoordinatorIdentity({ runId, senderId })) fail('link_owner_unknown', `Orca no devolvió el propietario de ${runId}; crea la Run desde la sesión del coordinador.`);
  let worktreeId = null;
  if (senderId.startsWith('term_')) {
    let terminal;
    try { terminal = (await command(['terminal', 'show', '--terminal', senderId], { cwd }))?.terminal; }
    catch (error) { fail('link_terminal_unreadable', `Orca no pudo mostrar la terminal ${senderId}: ${String(error.message ?? error).slice(0, 200)}`); }
    if (terminal?.handle !== senderId) fail('link_terminal_unknown', `Orca no acredita la terminal ${senderId}.`);
    if (terminal.connected !== true || terminal.writable !== true) fail('link_terminal_closed', `La terminal del coordinador (${senderId}) no está conectada o no admite mensajes: deja abierta su sesión y repite.`);
    if (typeof terminal.worktreeId === 'string' && WORKTREE_ID.test(terminal.worktreeId)) worktreeId = terminal.worktreeId;
  }

  const file = path.join(cwd, 'data', 'coordinator-bindings.json');
  let previous = null, raw = null;
  try { raw = await fs.readFile(file, 'utf8'); previous = validatedConfig(JSON.parse(raw)); }
  catch (error) {
    if (error.code !== 'ENOENT') fail('link_existing_invalid', 'data/coordinator-bindings.json existe pero no es válido; revísalo o muévelo antes de vincular.');
  }
  const config = previous ?? { schemaVersion: 1, coordinators: [], projects: {}, businesses: {} };
  const coordinatorId = id ?? config.businesses[business] ?? DEFAULTS[business].id;
  const existing = config.coordinators.find(item => item.id === coordinatorId);
  if (existing && existing.business !== business) fail('link_id_conflict', `El coordinador ${coordinatorId} es de otra empresa (${existing.business}).`);
  const entry = { id: coordinatorId, name: name ?? existing?.name ?? DEFAULTS[business].name, business, runId, senderId,
    ...(worktreeId ? { worktreeId } : {}), ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}) };
  const compact = item => Object.fromEntries(Object.entries(item).filter(([, value]) => value != null));
  const validated = validatedConfig({ ...config, coordinators: [...config.coordinators.filter(item => item.id !== coordinatorId), entry].map(compact),
    businesses: { ...config.businesses, [business]: coordinatorId } });
  const next = { ...validated, coordinators: validated.coordinators.map(compact) }; // no "sessionId": null in the file
  const unchanged = existing && existing.runId === runId && existing.senderId === senderId && (existing.worktreeId ?? null) === worktreeId && config.businesses[business] === coordinatorId;
  let backup = null;
  if (!unchanged) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (raw !== null) {
      backup = `${file}.anterior-${now().toISOString().replace(/[:.]/g, '-')}`;
      await fs.writeFile(backup, raw, { flag: 'wx' });
    }
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`);
    await fs.rename(temporary, file);
  }
  return { coordinator: coordinatorId, business, runId, senderId, worktreeId, changed: !unchanged, backup: backup && path.relative(cwd, backup) };
}
