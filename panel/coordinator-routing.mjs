import * as fs from 'node:fs/promises';
import path from 'node:path';

const RUN_ID = /^run_[A-Za-z0-9_-]{6,80}$/;
const SENDER = /^[A-Za-z0-9_.:-]{6,160}$/;
const COORDINATOR_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{6,200}$/;
const WORKTREE_ID = /^(?:[A-Za-z0-9_-]+::[^\r\n\u0000]+|folder:[A-Za-z0-9_-]{6,80}|wt2:[A-Za-z0-9_.:-]+)$/;
const businesses = new Set(['agency', 'games']);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const fail = (code, message, binding) => { throw Object.assign(new Error(message), { code, ...(binding ? { binding } : {}) }); };

export function isCoordinatorIdentity(value) {
  return typeof value?.runId === 'string' && RUN_ID.test(value.runId)
    && typeof value?.senderId === 'string' && SENDER.test(value.senderId);
}

export function validatedConfig(config) {
  const invalid = () => fail('coordinator_bindings_invalid', 'La configuración de coordinadores no es válida; revísala antes de enviar.');
  if (!plainObject(config) || config.schemaVersion !== 1 || !Array.isArray(config.coordinators)
    || !plainObject(config.projects) || !plainObject(config.businesses)) invalid();
  const seen = new Set();
  const coordinators = config.coordinators.map(item => {
    if (!plainObject(item) || typeof item.id !== 'string' || !COORDINATOR_ID.test(item.id) || seen.has(item.id)
      || !text(item.name, 160) || !businesses.has(item.business) || !isCoordinatorIdentity(item)
      || (item.worktreeId != null && (!text(item.worktreeId, 2048) || !WORKTREE_ID.test(item.worktreeId)))
      || (item.sessionId != null && (typeof item.sessionId !== 'string' || !SESSION_ID.test(item.sessionId)))) invalid();
    seen.add(item.id);
    return { id: item.id, name: item.name, business: item.business, runId: item.runId, senderId: item.senderId,
      worktreeId: item.worktreeId ?? null, sessionId: item.sessionId ?? null };
  });
  const byId = new Map(coordinators.map(item => [item.id, item]));
  for (const [scope, mappings] of [['project', config.projects], ['business', config.businesses]]) {
    for (const [key, id] of Object.entries(mappings)) {
      if (!(scope === 'business' ? businesses.has(key) : PROJECT_ID.test(key)) || typeof id !== 'string' || !byId.has(id)) invalid();
      if (scope === 'business' && byId.get(id).business !== key) invalid();
    }
  }
  return { schemaVersion: 1, coordinators, projects: { ...config.projects }, businesses: { ...config.businesses } };
}

// Absence enables the legacy environment route. Any other read/parse failure is closed.
export async function readCoordinatorBindings(root) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'data', 'coordinator-bindings.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    fail('coordinator_bindings_unreadable', 'No se puede leer la configuración de coordinadores; no se enviará el aviso.');
  }
  let config;
  try { config = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { fail('coordinator_bindings_invalid', 'El archivo de coordinadores contiene JSON inválido; no se enviará el aviso.'); }
  return validatedConfig(config);
}

function savedBinding(request, business, projectId) {
  let binding = null;
  for (const value of [request.sendIntent, request.notification]) {
    if (!value || (!Object.hasOwn(value, 'runId') && !Object.hasOwn(value, 'senderId'))) continue;
    if (!isCoordinatorIdentity(value)) fail('coordinator_saved_identity_invalid', 'La solicitud contiene un destinatario incompleto o inválido; requiere revisión.');
    if ((value.business != null && value.business !== business)
      || (value.coordinatorId != null && (typeof value.coordinatorId !== 'string' || !COORDINATOR_ID.test(value.coordinatorId)))
      || (value.coordinatorName != null && !text(value.coordinatorName, 160))
      || (value.routeScope != null && !['project', 'business', 'legacy'].includes(value.routeScope))
      || (value.routeKey != null && value.routeKey !== (value.routeScope === 'project' ? projectId : business))
      || (value.worktreeId != null && (!text(value.worktreeId, 2048) || !WORKTREE_ID.test(value.worktreeId)))
      || (value.sessionId != null && (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)))) {
      fail('coordinator_saved_identity_invalid', 'La identidad guardada del coordinador no coincide con la solicitud.');
    }
    if (binding && (binding.runId !== value.runId || binding.senderId !== value.senderId
      || binding.coordinatorId && value.coordinatorId && binding.coordinatorId !== value.coordinatorId)) {
      fail('coordinator_saved_identity_conflict', 'El intento de envío y la notificación contienen destinatarios distintos.', binding);
    }
    binding = { ...binding, runId: value.runId, senderId: value.senderId, business,
      ...Object.fromEntries(['coordinatorId', 'coordinatorName', 'routeScope', 'routeKey', 'worktreeId', 'sessionId']
        .filter(key => value[key] != null).map(key => [key, value[key]])) };
  }
  return binding;
}

// Returns a destination, never launches/discovers a session. Labels are not identities.
export function selectCoordinatorBinding(request, config, { env = process.env } = {}) {
  const business = request?.snapshot?.business;
  const projectId = request?.snapshot?.projectId || null;
  if (!businesses.has(business) || (request.business != null && request.business !== business)
    || (projectId !== null && (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)))
    || (request.projectId != null && request.projectId !== projectId)) {
    fail('coordinator_request_mismatch', 'La empresa o el proyecto de la solicitud no son coherentes.');
  }
  const saved = savedBinding(request, business, projectId);
  let selected;
  if (config !== null && config !== undefined) {
    config = validatedConfig(config);
    const projectRoute = projectId !== null && Object.hasOwn(config.projects, projectId);
    const routeScope = projectRoute ? 'project' : 'business';
    const routeKey = projectRoute ? projectId : business;
    const id = projectRoute ? config.projects[projectId] : config.businesses[business];
    const coordinator = config.coordinators.find(item => item.id === id);
    if (!coordinator) fail('coordinator_binding_missing', 'No hay un coordinador asignado a este proyecto o empresa.', saved);
    if (coordinator.business !== business) fail('coordinator_binding_mismatch', 'El coordinador asignado pertenece a otra empresa; no se usará una ruta alternativa.', saved);
    selected = { coordinatorId: coordinator.id, coordinatorName: coordinator.name, business,
      runId: coordinator.runId, senderId: coordinator.senderId, worktreeId: coordinator.worktreeId,
      sessionId: coordinator.sessionId, routeScope, routeKey };
  } else {
    const runId = env.ORCA_COORDINATOR_RUN_ID || '';
    const senderId = env.ORCA_COORDINATOR_SENDER || env.ORCA_TERMINAL_HANDLE || '';
    if (runId || senderId) {
      if (!isCoordinatorIdentity({ runId, senderId })) fail('coordinator_identity_required', 'Configura la Run y el remitente propietario del coordinador.', saved);
      selected = { coordinatorId: null, coordinatorName: 'Coordinador configurado por entorno', business,
        runId, senderId, worktreeId: null, sessionId: null, routeScope: 'legacy', routeKey: business };
    }
  }
  if (saved) {
    if (selected && (saved.runId !== selected.runId || saved.senderId !== selected.senderId
      || saved.coordinatorId && selected.coordinatorId && saved.coordinatorId !== selected.coordinatorId
      || saved.worktreeId && selected.worktreeId && saved.worktreeId !== selected.worktreeId
      || saved.sessionId && selected.sessionId && saved.sessionId !== selected.sessionId)) {
      fail('coordinator_identity_changed', 'La solicitud conserva otro destinatario; revisa esa entrega antes de cambiar de coordinador.', saved);
    }
    return { coordinatorId: null, coordinatorName: 'Coordinador original', routeScope: 'legacy', routeKey: business,
      worktreeId: null, sessionId: null, ...selected, ...saved };
  }
  if (!selected) fail('coordinator_identity_required', 'Configura la Run y el remitente propietario del coordinador; la carpeta del panel no identifica una sesión.');
  return selected;
}
