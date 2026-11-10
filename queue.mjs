import * as fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { replaceLocalFile } from './atomic-file.mjs';
import { containsSecret } from './redaction.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeJobContract, validateContinuation, validateDelivery, IDENTIFIERS } from './workflow-contract.mjs';
import { jobCoordination } from './coordination.mjs';
import { isOrcaStatusReadError, readCompleteTranscript } from './orca-evidence.mjs';
import { parseDelivery, deliveryApproved } from './workflow-contract.mjs';
import { assertContractRevisionCheckpoint, assertContractRevisionProof, contractRevisionHash } from './contract-revision.mjs';

export const QUEUE_BUSINESSES = Object.freeze(['agency', 'games']);
const MAX_JOBS = 500;
const MAX_JOB_ATTEMPTS = 5;
const ACTIVE = new Set(['queued', 'running', 'retry_wait', 'needs_attention']);
const WORKFLOW_STAGES = [
  { key: 'ux', label: 'Diseño UX', profile: 'ux' },
  { key: 'developer', label: 'Implementación', profile: 'desarrollador' },
  { key: 'qa', label: 'Control de calidad', profile: 'qa' },
  { key: 'reviewer', label: 'Revisión de código', profile: 'revisor' },
];
const ANALYSIS_STAGE = [{ key: 'planner', label: 'Planificación', profile: 'planificador' }];
const GAME_STAGE_LABELS = { ux: 'Diseño de videojuegos', developer: 'Desarrollo de videojuegos (Godot)' };
function workflowFor(kind, provider, business, eligible = false) {
  if (provider !== 'orca') return null;
  const stages = kind === 'analysis' ? ANALYSIS_STAGE : [...WORKFLOW_STAGES, ...(eligible ? [{ key: 'integration', label: 'Integración GitHub', profile: null, executor: 'deterministic' }] : [])];
  return { version: 1, name: kind === 'analysis' ? 'analysis-v1' : 'ui-quality-v1', status: 'queued', currentStage: null, updatedAt: stamp(), steps: stages.map(stage => ({ ...stage, label: (business === 'games' ? GAME_STAGE_LABELS[stage.key] : null) || stage.label, profile: stage.profile && kind === 'code' && ['agency', 'games'].includes(business) ? `${stage.profile}_${business}` : stage.profile, status: 'queued' })) };
}
export class QueueError extends Error {
  constructor(message, code = 'queue_error') { super(message); this.code = code; }
}
const emptyState = () => ({ schema: 1, revision: 0, jobs: [], budget: { limitUsd: 0, reservedUsd: 0, estimatedSpentUsd: 0, model: '', inputPerMillion: 0, outputPerMillion: 0 } });
const dir = root => path.join(root, 'data');
const ledger = root => path.join(dir(root), 'events.jsonl');
const stamp = () => new Date().toISOString();
// 7: who acts. The panel and the CLI run their work inside actorContext.run({ actor, role });
// ledger events and new jobs record the actor when present. Old entries simply lack it.
export const actorContext = new AsyncLocalStorage();
export const currentActor = () => { const actor = actorContext.getStore()?.actor; return typeof actor === 'string' && actor.trim() ? actor.trim().slice(0, 200) : undefined; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const applyEvent = (state, event) => {
  if (event.revision !== state.revision + 1 || event.schema !== 1 || !event.patch) throw new QueueError('Registro de eventos inconsistente: requiere revisión manual.', 'ledger_corrupt');
  for (const job of event.patch.jobs ?? []) {
    const i = state.jobs.findIndex(j => j.id === job.id);
    if (i < 0) state.jobs.push(job); else state.jobs[i] = job;
  }
  if (event.patch.budget) state.budget = event.patch.budget;
  state.revision = event.revision;
};

async function readLedger(root, repair = false) {
  let raw;
  try { raw = await fs.readFile(ledger(root), 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    try { await fs.access(path.join(dir(root), 'state.json')); } catch (err) { if (err.code === 'ENOENT') return emptyState(); throw err; }
    throw new QueueError('Falta el registro de eventos, pero existe una instantánea. Revisión manual necesaria.', 'ledger_missing');
  }
  const state = emptyState();
  const complete = raw.lastIndexOf('\n') + 1;
  for (const line of raw.slice(0, complete).split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { throw new QueueError('Registro de eventos dañado. Revisión manual necesaria.', 'ledger_corrupt'); }
    applyEvent(state, event);
  }
  // A torn final write was never committed. Only the lock owner may trim it.
  if (repair && complete < raw.length) await fs.truncate(ledger(root), Buffer.byteLength(raw.slice(0, complete)));
  return state;
}

export async function loadState(root) { return readLedger(path.resolve(root)); }

async function atomicSnapshot(root, state) {
  const destination = path.join(dir(root), 'state.json');
  const temp = `${destination}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); } finally { await handle.close(); }
  try { await replaceLocalFile(temp, destination); } catch (e) { await fs.rm(temp, { force: true }); throw e; }
}

const commitChains = new WeakMap();
function commit(root, state, type, patch = {}, details = {}) {
  const pending = (commitChains.get(state) ?? Promise.resolve()).then(() => writeCommit(root, state, type, patch, details));
  commitChains.set(state, pending);
  return pending;
}
async function writeCommit(root, state, type, patch = {}, details = {}) {
  const actor = currentActor();
  const event = { schema: 1, revision: state.revision + 1, at: stamp(), type, details, patch, ...(actor ? { actor } : {}) };
  const handle = await fs.open(ledger(root), 'a');
  try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
  applyEvent(state, event);
  // Ledger is authoritative if the process dies before snapshot replacement.
  await atomicSnapshot(root, state);
}

const lockAcquisitions = new Map();
export async function acquireLock(root, business) {
  if (business !== undefined && !QUEUE_BUSINESSES.includes(business)) throw new QueueError('Empresa inválida.');
  const lockName = business ? `runner-${business}` : 'runner';
  root = path.resolve(root);
  const lockPath = path.join(dir(root), lockName + '.lock');
  // Do not let a sibling lane read the file between exclusive open and sync.
  const previous = lockAcquisitions.get(lockPath);
  const pending = (previous?.catch(() => {}) ?? Promise.resolve()).then(() => acquireLockFile(root, lockName, lockPath));
  lockAcquisitions.set(lockPath, pending);
  try { return await pending; }
  finally { if (lockAcquisitions.get(lockPath) === pending) lockAcquisitions.delete(lockPath); }
}

const windowsLockSharingError = error => process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);

async function acquireLockFile(root, lockName, lockPath) {
  await fs.mkdir(dir(root), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    let handle;
    try { handle = await fs.open(lockPath, 'wx'); }
    catch (e) {
      // A just-unlinked Windows file may briefly remain unavailable.
      if (windowsLockSharingError(e)) { await wait(25 + attempt * 25); continue; }
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        if (windowsLockSharingError(error)) { await wait(25 + attempt * 25); continue; }
        const incomplete = new QueueError('Bloqueo incompleto: comprueba que no hay un ejecutor antes de revisarlo manualmente.', 'lock_uncertain');
        incomplete.initializing = true;
        throw incomplete;
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new QueueError('Bloqueo inválido: revisión manual necesaria.', 'lock_uncertain');
      if (owner.unsafe) throw new QueueError('No se pudo confirmar la parada de un proceso anterior; revisa procesos y bloqueo manualmente.', 'lock_uncertain');
      if (alive(owner.pid)) throw new QueueError('Ya hay un ejecutor u otra operación de escritura en marcha.', 'locked');
      // Serialize reclamation: two stale-lock readers must never unlink a new owner's lock.
      const recoveryPath = path.join(dir(root), lockName + '.recovery.lock');
      let recovery;
      try { recovery = await fs.open(recoveryPath, 'wx'); }
      catch (err) { if (err.code === 'EEXIST') throw new QueueError('Recuperación de bloqueo en marcha o interrumpida; requiere revisión.', 'lock_uncertain'); throw err; }
      try {
        await recovery.writeFile(JSON.stringify({ pid: process.pid, at: stamp() }));
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (current.token === owner.token && !alive(current.pid)) await fs.unlink(lockPath);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      finally { await recovery.close(); await fs.unlink(recoveryPath).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: stamp() }));
      await handle.sync();
    } finally { await handle.close(); }
    return { root, path: lockPath, token };
  }
  throw new QueueError('No se pudo adquirir el bloqueo.', 'locked');
}

export async function releaseLock(lock) {
  if (lock.retain) return;
  for (let attempt = 0; ; attempt++) {
    try {
      const owner = JSON.parse(await fs.readFile(lock.path, 'utf8'));
      if (owner.token === lock.token) await fs.unlink(lock.path);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (attempt >= 2 || !windowsLockSharingError(error)) throw error;
      await wait(25 + attempt * 25);
    }
  }
}

export async function acquireLedgerLock(root, waitMs) {
  const started = performance.now();
  for (;;) {
    try { return await acquireLock(root); }
    catch (error) {
      const elapsed = performance.now() - started;
      if (elapsed >= waitMs || error.code !== 'locked' && !(error.initializing && elapsed < 100)) throw error;
      await wait(25);
    }
  }
}

async function mutate(root, action, waitMs = 0) {
  root = path.resolve(root);
  const lock = await acquireLedgerLock(root, waitMs);
  try { return await action(await readLedger(root, true), lock); } finally { await releaseLock(lock); }
}

// Unscoped CLI execution keeps its existing exclusive semantics. An automatic
// lane owns only its company lock while it waits for Orca. Both modes take the
// shared lock first on entry so a legacy runner cannot overlap a scoped one.
async function withExecutors(root, business, action) {
  if (!business) {
    return mutate(root, async (state, lock) => {
      const lanes = [];
      try {
        for (const company of QUEUE_BUSINESSES) lanes.push(await acquireLock(root, company));
        return await action(operation => operation(state), lock);
      } finally {
        await Promise.all(lanes.map(releaseLock));
      }
    });
  }
  const sharedLock = await acquireLedgerLock(root, 2000);
  let lock;
  try {
    try { lock = await acquireLock(root, business); }
    finally { await releaseLock(sharedLock); }
    return await action(operation => mutate(root, operation, 60_000), lock);
  } finally { if (lock) await releaseLock(lock); }
}

function defaultExecutionTimeoutMs(kind) {
  return kind === 'code' ? 1_800_000 : 180_000;
}

export function executionTimeoutMs(job) {
  const legacyDefault = defaultExecutionTimeoutMs(job.kind);
  // Older Orca records stored the default as if it were an explicit override.
  if (job.provider === 'orca' && (job.timeoutMs == null
    || job.timeoutMs === legacyDefault && job.timeoutExplicit !== true)) return null;
  return job.timeoutMs ?? legacyDefault;
}

export function executionTimeExhausted(job, elapsedMs) {
  const timeoutMs = executionTimeoutMs(job);
  return timeoutMs !== null && elapsedMs >= timeoutMs;
}

function attemptLimit(spec) {
  const limit = spec.maxAttempts ?? ((spec.provider ?? 'orca') === 'orca' ? MAX_JOB_ATTEMPTS : 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOB_ATTEMPTS) {
    throw new QueueError(`maxAttempts debe estar entre 1 y ${MAX_JOB_ATTEMPTS}.`);
  }
  return limit;
}

export function validateSpec(spec) {
  jobCoordination(spec.coordination, spec);
  if (!['games', 'agency'].includes(spec.business)) throw new QueueError('business debe ser games o agency.');
  if (!['analysis', 'code'].includes(spec.kind)) throw new QueueError('kind debe ser analysis o code.');
  if (!spec.title || spec.title.length > 160) throw new QueueError('El título debe tener entre 1 y 160 caracteres.');
  if (!spec.prompt || Buffer.byteLength(spec.prompt, 'utf8') > 12_000) throw new QueueError('La instrucción debe tener entre 1 y 12.000 bytes.');
  if (containsSecret(spec.prompt + spec.title)) throw new QueueError('No guardes claves en títulos o instrucciones; usa solo variables de entorno.');
  attemptLimit(spec);
  if (!Number.isInteger(spec.timeoutMs ?? 180_000) || (spec.timeoutMs ?? 180_000) < 10 || (spec.timeoutMs ?? 180_000) > 1_800_000) throw new QueueError('timeoutMs debe estar entre 10 y 1.800.000.');
  if (!Number.isFinite(spec.maxUsd ?? 0.1) || (spec.maxUsd ?? 0.1) <= 0) throw new QueueError('maxUsd debe ser positivo.');
  if (!['orca', 'auto', 'codex', 'api'].includes(spec.provider ?? 'orca')) throw new QueueError('provider debe ser orca, auto, codex o api.');
  if (spec.kind === 'code' && (!spec.workspace || !spec.isolated)) throw new QueueError('Los trabajos de código requieren workspace y confirmación isolated.');
}

export async function addJob(root, spec) {
  validateSpec(spec);
  const contract = normalizeJobContract(spec);
  const continuation = spec.continuation ? validateContinuation(spec.continuation) : undefined;
  return mutate(root, async state => {
    if (state.jobs.length >= MAX_JOBS) throw new QueueError('Cola limitada a 500 trabajos; archiva manualmente antes de ampliar.');
    const id = spec.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new QueueError('Identificador inválido.');
    if (state.jobs.some(job => job.id === id)) throw new QueueError('Este identificador ya existe; no se añadirá dos veces.', 'duplicate');
    const provider = spec.provider ?? 'orca';
    const workflow = workflowFor(spec.kind, provider, spec.business, spec.kind === 'code' && spec.autoIntent?.eligible === true);
    const job = { id, ...(spec.autoIntent ? { autoIntent: spec.autoIntent } : {}), ...(spec.ideaId ? { ideaId: spec.ideaId, ideaVersion: spec.ideaVersion } : {}), business: spec.business, kind: spec.kind, projectId: spec.projectId, projectName: spec.projectName, title: spec.title, prompt: spec.prompt, provider, workflow, workspace: spec.workspace ? path.resolve(spec.workspace) : null, branch: spec.branch || null, destination: spec.destination || null, isolated: !!spec.isolated, maxAttempts: attemptLimit(spec), timeoutMs: spec.timeoutMs ?? (provider === 'orca' ? null : defaultExecutionTimeoutMs(spec.kind)),
      ...(provider === 'orca' && spec.timeoutMs != null ? { timeoutExplicit: true } : {}), maxUsd: spec.maxUsd ?? 0.1, maxOutputTokens: 1024, attempts: 0, state: 'queued', createdAt: stamp(), reservedUsd: 0,
      ...(currentActor() ? { actor: currentActor() } : {}) };
    job.contract = contract;
    if (spec.coordination) job.coordination = jobCoordination(spec.coordination, spec);
    if (continuation) job.continuation = continuation;
    await commit(root, state, 'job_added', { jobs: [job] }, { jobId: id });
    return job;
  });
}

export async function routeJob(root, id, provider) {
  if (!['orca', 'auto', 'codex', 'api'].includes(provider)) throw new QueueError('provider debe ser orca, auto, api o codex.');
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous || previous.state !== 'queued' || previous.attempts !== 0)
      throw new QueueError('Solo se puede cambiar el proveedor de un trabajo pendiente que aún no se haya ejecutado.');
    const job = { ...previous, provider, workflow: workflowFor(previous.kind, provider, previous.business, previous.autoIntent?.eligible === true) };
    await commit(root, state, 'job_routed', { jobs: [job] }, { jobId: id, provider });
    return job;
  });
}

export async function reconfirmJobDestination(root, id, {
  confirm = false, expectedDispatchId, expectedBranch, destination, reason,
} = {}) {
  if (!confirm) throw new QueueError('Confirma explícitamente el cambio de destino del job.');
  if (!/^ctx_[a-zA-Z0-9_-]{6,80}$/.test(expectedDispatchId ?? '') || !expectedBranch || !destination?.checkout || !destination?.workspace || !destination?.branch || !String(reason ?? '').trim()) {
    throw new QueueError('Indica dispatch, rama anterior, checkout, rama nueva y motivo de la decisión.');
  }
  if (destination.branch.includes('..') || /[\\\x00\r\n]/.test(destination.branch) || destination.branch.startsWith('-') || destination.branch.startsWith('/')) {
    throw new QueueError('La nueva rama no es válida.');
  }
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    const developer = previous?.workflow?.steps?.find(step => step.key === 'developer');
    if (!previous || previous.kind !== 'code' || previous.state !== 'needs_attention' || developer?.status !== 'blocked') {
      throw new QueueError('Solo se puede confirmar un nuevo destino para un job de código bloqueado que requiere atención.');
    }
    if (previous.branch !== expectedBranch || previous.destination?.branch !== expectedBranch || developer.dispatchId !== expectedDispatchId) {
      throw new QueueError('El destino o dispatch cambió desde la confirmación; revisa el historial antes de continuar.', 'stale_destination');
    }
    if (destination.checkout !== previous.destination.checkout || path.resolve(destination.workspace) !== path.resolve(previous.workspace)) {
      throw new QueueError('El cambio de rama debe conservar el checkout confirmado del mismo repositorio.');
    }
    if (destination.branch === expectedBranch) throw new QueueError('El nuevo destino debe diferir de la rama anterior.');
    const changedAt = stamp();
    const decision = {
      at: changedAt,
      by: 'coordinator',
      reason: String(reason).trim().slice(0, 1000),
      dispatchId: expectedDispatchId,
      from: { checkout: previous.destination.checkout, branch: previous.branch, sha: previous.destination.sha || null },
      to: { checkout: destination.checkout, branch: destination.branch, sha: destination.sha || null },
      remoteVerified: destination.verified === true,
    };
    const job = {
      ...previous,
      workspace: path.resolve(destination.workspace),
      branch: destination.branch,
      destination: { ...destination, checkedAt: destination.checkedAt || changedAt },
      destinationHistory: [...(previous.destinationHistory ?? []), decision].slice(-12),
      coordinatorDecision: decision,
      updatedAt: changedAt,
    };
    await commit(root, state, 'job_destination_reconfirmed', { jobs: [job] }, {
      jobId: id, expectedDispatchId, fromBranch: expectedBranch, toBranch: destination.branch,
      checkout: destination.checkout, reason: decision.reason, remoteVerified: decision.remoteVerified,
    });
    return job;
  });
}

export async function reconcileOrcaJob(root, id, { confirm = false, dispatchId, evidence = '' } = {}) {
  if (!confirm) throw new QueueError('Verifica el resultado en Orca antes de reconciliar; usa --confirm-reviewed.');
  if (!/^ctx_[a-zA-Z0-9_-]{6,80}$/.test(dispatchId ?? '') || typeof evidence !== 'string' || !evidence.trim() || Buffer.byteLength(evidence, 'utf8') > 12_000)
    throw new QueueError('Indica el dispatch de Orca y evidencia breve (hasta 12.000 bytes).');
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous || previous.provider !== 'orca' || previous.kind !== 'analysis' || previous.state !== 'needs_attention' || previous.error?.code !== 'orca_empty_result')
      throw new QueueError('Solo se puede reconciliar un análisis Orca que terminó y cuya respuesta no pudo leerse.');
    const job = {
      ...previous,
      state: 'succeeded',
      error: null,
      result: { provider: 'coordinator-reviewed-orca', dispatchId, text: evidence.trim() },
      finishedAt: stamp(),
      reviewedAt: stamp(),
      deliveryReviewed: true,
    };
    await commit(root, state, 'orca_result_reconciled', { jobs: [job] }, { jobId: id, dispatchId });
    return job;
  });
}

const DISPATCH_ID = /^ctx_[a-zA-Z0-9_-]{6,80}$/;
const TASK_ID = /^task_[a-zA-Z0-9_-]{6,80}$/;
const COMMIT_ID = /^(?:[a-f0-9]{7,40})$/i;
const APPROVAL_MARKER = 'RESULTADO: APROBADO';
const hasOnlyKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key))
  && keys.every(key => Object.hasOwn(value, key));
const finalNonemptyLine = value => typeof value === 'string'
  ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1)
  : undefined;

/** Read every exact transcript page and accept only the exact worker's terminal approval report. */
export async function verifyOrcaApprovalTranscript(dispatchId, expectedState, readPage, { maxPages = 100, evidence = {}, includeDelivery = false } = {}) {
  if (!DISPATCH_ID.test(dispatchId ?? '') || expectedState !== 'succeeded' || typeof readPage !== 'function'
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new QueueError('No se puede verificar el transcript de aprobación.', 'reconciliation_approval_unverified');
  }
  try {
    const report = await readCompleteTranscript({ ...evidence, dispatchId }, async cursor => {
      const page = await readPage({ dispatchId, cursor });
      if (page?.archived !== true || page.status?.worker !== expectedState || page.projection?.outcome !== expectedState) {
        throw new Error('Transcript no archivado o estado no final.');
      }
      return page;
    }, { maxPages });
    const delivery = parseDelivery(report.text, { ...evidence, dispatchId });
    if (delivery ? !deliveryApproved(delivery) : finalNonemptyLine(report.text) !== APPROVAL_MARKER) throw new Error('Falta aprobación final explícita.');
    return includeDelivery ? { approved: true, delivery } : true;
  } catch {
    throw new QueueError('El transcript completo del dispatch no acredita una aprobación final correlacionada.', 'reconciliation_approval_unverified');
  }
}

export function verifyOrcaWorkerRecord(evidence, observed) {
  const dispatch = observed?.dispatch;
  const worker = observed?.worker;
  const projection = observed?.projection;
  const expectedDispatchStatus = evidence?.state === 'failed' ? 'failed' : 'completed';
  if (!dispatch || !worker || !projection || dispatch.id !== evidence.dispatchId
    || dispatch.taskId !== evidence.taskId || dispatch.runId !== evidence.runId || dispatch.status !== expectedDispatchStatus
    || worker.dispatchId !== evidence.dispatchId || worker.state !== evidence.state || typeof worker.agentTerminalHandle !== 'string' || !worker.agentTerminalHandle
    || dispatch.assigneeHandle !== worker.agentTerminalHandle
    || projection.dispatchId !== evidence.dispatchId || projection.taskId !== evidence.taskId
    || projection.runId !== evidence.runId || projection.outcome !== evidence.state
    || (projection.parent?.taskId ?? null) !== evidence.parentTaskId
    || (dispatch.retryOfDispatchId ?? null) !== evidence.retryOfDispatchId) {
    throw new QueueError('Los IDs, estado, retry o vínculo parent/task no coinciden con worker-show.', 'reconciliation_dispatch_mismatch');
  }
  return {
    dispatchId: dispatch.id, taskId: dispatch.taskId, runId: dispatch.runId, state: worker.state,
    parentTaskId: projection.parent?.taskId ?? null, retryOfDispatchId: dispatch.retryOfDispatchId ?? null,
    terminalHandle: worker.agentTerminalHandle,
  };
}

function parseJsonRecord(value, label) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid record');
    return parsed;
  } catch { throw new QueueError(`El registro ${label} no contiene metadata íntegra.`, 'reconciliation_records_invalid'); }
}

function receiptBodyIsComplete(message) {
  if (message?.contentComplete === false || message?.truncated === true || message?.clipped === true
    || (Array.isArray(message?.warnings) && message.warnings.length > 0)
    || (Array.isArray(message?.clipping) && message.clipping.length > 0)
    || typeof message?.body !== 'string' || !message.body.trim()) return false;
  return !/(?:\[\s*(?:cut off|partial|truncated|clipped)(?:\s+[^\]]*)?\]|<\s*(?:truncated|clipped)\s*>|(?:\.\.\.|…)[ \t]*\[(?:truncated|clipped)\])/i.test(message.body);
}

/** Correlate full coordinator worker_done receipts with their completed Run tasks. */
export function verifyOrcaRunRecords(evidence, { inbox, taskList, terminalHandle, relatedDispatches, limit = 500, approvalTranscriptVerified = false } = {}) {
  const runId = evidence?.runId;
  if (!/^run_[a-zA-Z0-9_-]{6,80}$/.test(runId ?? '') || !Number.isInteger(limit) || limit < 1
    || !inbox || !Array.isArray(inbox.messages) || !Number.isInteger(inbox.count)
    || inbox.count !== inbox.messages.length || inbox.count >= limit
    || typeof terminalHandle !== 'string' || !terminalHandle
    || !taskList || taskList.runId !== runId || taskList.legacyReadOnly !== false
    || !Array.isArray(taskList.tasks) || !Number.isInteger(taskList.count)
    || taskList.count !== taskList.tasks.length || taskList.count >= limit) {
    throw new QueueError('Inbox o task-list incompletos, truncados o fuera del Run esperado.', 'reconciliation_records_invalid');
  }
  const receipts = [];
  for (const message of inbox.messages) {
    if (message.type !== 'worker_done' || message.run_id !== runId) continue;
    const payload = parseJsonRecord(message.payload, 'worker_done');
    receipts.push({ message, payload });
  }
  const taskIds = new Set();
  for (const task of taskList.tasks) {
    if (taskIds.has(task.id)) throw new QueueError('task-list contiene tasks duplicados.', 'reconciliation_records_invalid');
    taskIds.add(task.id);
  }
  const matchingReceipts = receipts.filter(({ payload }) => payload.dispatchId === evidence.dispatchId);
  if (matchingReceipts.length !== 1) throw new QueueError('Inbox debe contener exactamente un worker_done para cada dispatch.', 'reconciliation_receipt_mismatch');
  const { message, payload } = matchingReceipts[0];
  if (payload.taskId !== evidence.taskId || payload.dispatchId !== evidence.dispatchId
    || payload.outcome !== evidence.state || message.run_id !== runId || message.to_handle !== `run:${runId}`
    || message.from_handle !== terminalHandle || typeof message.id !== 'string' || !message.id.trim()
    || inbox.messages.filter(item => item.id === message.id).length !== 1 || !receiptBodyIsComplete(message)) {
    throw new QueueError('El recibo worker_done no coincide con dispatch, task, Run u outcome.', 'reconciliation_receipt_mismatch');
  }
  const taskRows = taskList.tasks.filter(task => task.id === evidence.taskId);
  if (taskRows.length !== 1) throw new QueueError('task-list debe tener exactamente una fila para el task verificado.', 'reconciliation_task_mismatch');
  const task = taskRows[0];
  if (task.run_id !== runId || task.parent_id !== evidence.parentTaskId || task.status !== 'completed') {
    throw new QueueError('El task no está completado en el Run esperado o su parent no coincide.', 'reconciliation_task_mismatch');
  }
  const result = parseJsonRecord(task.result, 'task result');
  let resultReceipt = message;
  if (evidence.state === 'failed') {
    let retry = evidence;
    const seenRetries = new Set([evidence.dispatchId]);
    while (retry.state === 'failed') {
      const retries = Array.isArray(relatedDispatches) ? relatedDispatches.filter(item => item?.stage === evidence.stage
        && item.taskId === evidence.taskId && item.runId === runId && item.jobAttempt === evidence.jobAttempt
        && item.retryOfDispatchId === retry.dispatchId) : [];
      if (retries.length !== 1 || seenRetries.has(retries[0].dispatchId)) {
        throw new QueueError('El dispatch fallido necesita una cadena única de retry de la misma decisión para validar task.result.', 'reconciliation_task_mismatch');
      }
      retry = retries[0]; seenRetries.add(retry.dispatchId);
    }
    if (retry.state !== 'succeeded') throw new QueueError('La cadena de retry no acredita un resultado final satisfactorio.', 'reconciliation_task_mismatch');
    const retryReceipts = receipts.filter(({ payload }) => payload.dispatchId === retry.dispatchId);
    if (retryReceipts.length !== 1) throw new QueueError('Inbox debe contener exactamente un worker_done para el retry esperado.', 'reconciliation_receipt_mismatch');
    const { message: retryMessage, payload: retryPayload } = retryReceipts[0];
    if (retryPayload.taskId !== evidence.taskId || retryPayload.dispatchId !== retry.dispatchId || retryPayload.outcome !== 'succeeded'
      || retryMessage.run_id !== runId || retryMessage.to_handle !== `run:${runId}`
      || typeof retryMessage.from_handle !== 'string' || !retryMessage.from_handle
      || typeof retryMessage.id !== 'string' || !retryMessage.id.trim()
      || inbox.messages.filter(item => item.id === retryMessage.id).length !== 1
      || !receiptBodyIsComplete(retryMessage)) {
      throw new QueueError('El recibo worker_done del retry esperado no es completo o no coincide con task/Run/outcome.', 'reconciliation_receipt_mismatch');
    }
    resultReceipt = retryMessage;
  }
  if (result.outcome !== 'succeeded' || typeof result.messageId !== 'string' || !result.messageId.trim()
    || result.messageId !== resultReceipt.id
    || result.reportedBy !== resultReceipt.from_handle || result.body !== resultReceipt.body) {
    throw new QueueError('El resultado del task no corresponde al recibo worker_done exacto.', 'reconciliation_task_mismatch');
  }
  const approvalRequired = evidence.state === 'succeeded' && ['qa', 'reviewer'].includes(evidence.stage);
  let delivery;
  try { delivery = parseDelivery(message.body, evidence); }
  catch { throw new QueueError('El contrato de entrega no coincide con el dispatch verificado.', 'reconciliation_approval_unverified'); }
  if (approvalRequired && !(delivery ? deliveryApproved(delivery)
    : finalNonemptyLine(message.body) === APPROVAL_MARKER || approvalTranscriptVerified === true)) {
    throw new QueueError('QA/Revisión no tienen una aprobación explícita en la entrega o el transcript verificado.', 'reconciliation_approval_unverified');
  }
  return { receiptId: message.id, approvalVerified: approvalRequired, ...(delivery ? { delivery } : {}) };
}

function validateReconciliationDecision(decision) {
  const keys = decision?.schema === 2
    ? ['schema', 'decisionId', 'jobId', 'scope', 'dispatches', 'destination', 'evidence']
    : ['schema', 'decisionId', 'dispatches', 'destination', 'evidence'];
  if (!hasOnlyKeys(decision, keys) || ![1, 2].includes(decision.schema)
    || (decision.schema === 2 && (!/^[a-zA-Z0-9_-]{1,80}$/.test(decision.jobId ?? '') || !['complete', 'partial'].includes(decision.scope)))
    || typeof decision.decisionId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(decision.decisionId)
    || !Array.isArray(decision.dispatches) || !decision.dispatches.length || decision.dispatches.length > 100
    || !hasOnlyKeys(decision.destination, ['checkout', 'branch', 'sha', 'verified'])
    || typeof decision.destination.checkout !== 'string' || !decision.destination.checkout.trim()
    || typeof decision.destination.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(decision.destination.branch)
    || decision.destination.branch.includes('..') || decision.destination.branch.endsWith('/')
    || typeof decision.destination.sha !== 'string' || !COMMIT_ID.test(decision.destination.sha)
    || decision.destination.verified !== true || typeof decision.evidence !== 'string'
    || !decision.evidence.trim() || Buffer.byteLength(decision.evidence, 'utf8') > 12_000) {
    throw new QueueError('El manifiesto de reconciliación no cumple el esquema o contiene metadata inválida.', 'reconciliation_invalid');
  }
  const seenDispatches = new Set();
  for (const item of decision.dispatches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new QueueError('Dispatch inválido en el manifiesto.', 'reconciliation_invalid');
    const approvalRequired = item.state === 'succeeded' && ['qa', 'reviewer'].includes(item.stage);
    const dispatchKeys = ['stage', 'dispatchId', 'taskId', 'runId', 'state', 'sequence', 'jobAttempt', 'parentTaskId', 'retryOfDispatchId', 'approvalEvidence'];
    if (decision.schema === 2 && Object.hasOwn(item, 'queueAttempt')) dispatchKeys.push('queueAttempt');
    if (!hasOnlyKeys(item, dispatchKeys)
      || !WORKFLOW_STAGES.some(stage => stage.key === item.stage)
      || !DISPATCH_ID.test(item.dispatchId ?? '') || !TASK_ID.test(item.taskId ?? '')
      || !/^run_[a-zA-Z0-9_-]{6,80}$/.test(item.runId ?? '') || !['succeeded', 'failed'].includes(item.state)
      || !Number.isInteger(item.sequence) || item.sequence < 1
      || !Number.isInteger(item.jobAttempt) || item.jobAttempt < 1
      || (Object.hasOwn(item, 'queueAttempt') && (!Number.isInteger(item.queueAttempt) || item.queueAttempt < item.jobAttempt))
      || !(item.parentTaskId === null || TASK_ID.test(item.parentTaskId ?? ''))
      || !(item.retryOfDispatchId === null || DISPATCH_ID.test(item.retryOfDispatchId ?? ''))
      || (approvalRequired
        ? ![APPROVAL_MARKER, ...(decision.schema === 2 ? ['structured'] : [])].includes(item.approvalEvidence)
        : item.approvalEvidence !== null)) {
      throw new QueueError('Los dispatches necesitan identidad, intento, secuencia y evidencia de aprobación válidos.', 'reconciliation_invalid');
    }
    if (seenDispatches.has(item.dispatchId)) throw new QueueError('La decisión contiene dispatch IDs duplicados.', 'reconciliation_duplicate');
    seenDispatches.add(item.dispatchId);
  }
}

// Derive the admissible ordered prefix from this job, not from a particular incident.
function reconciliationTimeline(job, decision) {
  const stages = job.workflow?.steps?.filter(step => step.key !== 'integration');
  if (!stages?.length || new Set(stages.map(step => step.key)).size !== stages.length
    || stages.some(step => !WORKFLOW_STAGES.some(role => role.key === step.key))) {
    throw new QueueError('El workflow no contiene etapas reconciliables inequívocas.', 'reconciliation_job_mismatch');
  }
  const groups = new Map();
  let stageIndex = -1;
  const taskOwners = new Map();
  for (const item of decision.dispatches) {
    const index = stages.findIndex(step => step.key === item.stage);
    if (index < 0 || index < stageIndex || index > stageIndex + 1 || item.runId !== job.workflow.runId
      || item.jobAttempt > job.attempts || (item.queueAttempt ?? item.jobAttempt) > job.attempts) {
      throw new QueueError('Orden, Run o intento incompatibles con el workflow.', 'reconciliation_dispatch_mismatch');
    }
    stageIndex = index;
    const group = groups.get(item.stage) ?? [];
    const previous = group.at(-1);
    const priorStage = index > 0 ? groups.get(stages[index - 1].key)?.at(-1) : null;
    if (item.sequence !== group.length + 1
      || (previous ? previous.state !== 'failed' || item.taskId !== previous.taskId || item.jobAttempt !== previous.jobAttempt
        || item.retryOfDispatchId !== previous.dispatchId || item.parentTaskId !== previous.parentTaskId
        || (item.queueAttempt !== undefined && previous.queueAttempt !== undefined && item.queueAttempt < previous.queueAttempt)
        : item.retryOfDispatchId !== null)
      || (priorStage && priorStage.state !== 'succeeded')
      || (item.parentTaskId !== null && item.parentTaskId !== priorStage?.taskId)
      || (taskOwners.has(item.taskId) && taskOwners.get(item.taskId) !== item.stage)) {
      throw new QueueError('La dependencia o cadena de reintentos no corresponde al workflow.', 'reconciliation_dispatch_mismatch');
    }
    taskOwners.set(item.taskId, item.stage);
    group.push(item); groups.set(item.stage, group);
  }
  if ([...groups.values()].some(group => group.at(-1).state !== 'succeeded')) {
    throw new QueueError('Cada etapa reconciliada debe terminar con evidencia de éxito.', 'reconciliation_dispatch_mismatch');
  }
  if (decision.schema === 2 && decision.scope === 'complete' && groups.size !== stages.length) {
    throw new QueueError('Un alcance completo exige todas las etapas del workflow.', 'reconciliation_incomplete');
  }
  let anchored = false;
  for (const step of stages) {
    const group = groups.get(step.key);
    if (step.dispatchId) {
      const checkpoint = group?.find(item => item.dispatchId === step.dispatchId);
      if (!checkpoint || checkpoint.taskId !== step.taskId || checkpoint.jobAttempt !== (step.taskInputAttempt ?? step.attempt ?? job.attempts)
        || (checkpoint.queueAttempt !== undefined && checkpoint.queueAttempt !== (step.attempt ?? job.attempts))
        || (step.runId && step.runId !== checkpoint.runId)
        || (step.status === 'succeeded' && (checkpoint.state !== 'succeeded' || group.at(-1) !== checkpoint))) {
        throw new QueueError('El manifiesto no conserva el checkpoint durable de la etapa.', 'reconciliation_dispatch_mismatch');
      }
      anchored = true;
    } else if (group?.some(item => item.jobAttempt !== job.attempts || (item.queueAttempt !== undefined && item.queueAttempt !== job.attempts))) {
      throw new QueueError('Una etapa nueva no puede atribuirse a un intento anterior.', 'reconciliation_dispatch_mismatch');
    }
  }
  if (!anchored) throw new QueueError('No hay un dispatch durable que vincule el manifiesto a este job.', 'reconciliation_dispatch_mismatch');
  return { stages, groups };
}

/** Reconcile external evidence without executing a worker or publishing a delivery. */
export async function reconcileCodeJob(root, id, { confirm = false, decision, verifyDispatch, verifyDestination } = {}) {
  if (!confirm) throw new QueueError('Confirma que revisaste Orca y el destino antes de reconciliar.');
  validateReconciliationDecision(decision);
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (previous?.reconciliationDecisionId === decision.decisionId) {
      const prior = previous.coordinatorDecision;
      const sameDecision = prior?.manifest
        ? JSON.stringify(prior.manifest) === JSON.stringify(decision)
        : decision.schema === 1 && prior?.evidence === decision.evidence.trim()
          && JSON.stringify(prior?.dispatches) === JSON.stringify(decision.dispatches)
          && prior?.destination?.checkout === decision.destination.checkout
          && prior?.destination?.branch === decision.destination.branch
          && prior?.destination?.sha === decision.destination.sha
          && prior?.destination?.verified === decision.destination.verified;
      if (!sameDecision) throw new QueueError('decisionId ya usado con metadata distinta.', 'reconciliation_duplicate');
      return { ...previous, idempotent: true };
    }
    if (!previous || previous.kind !== 'code' || !['games', 'agency'].includes(previous.business) || previous.provider !== 'orca'
      || previous.state !== 'needs_attention' || !previous.workflow?.runId
      || (decision.schema === 2 && decision.jobId !== id)) {
      throw new QueueError('Solo se reconcilia el job Orca de código bloqueado y su Run existente.', 'reconciliation_job_mismatch');
    }
    const workflow = previous.workflow;
    const { stages, groups } = reconciliationTimeline(previous, decision);
    if (typeof verifyDispatch !== 'function') throw new QueueError('La CLI debe verificar todos los dispatches con Orca antes de reconciliar.', 'reconciliation_verifier_required');
    if (typeof verifyDestination !== 'function') throw new QueueError('El destino debe verificarse en el sistema local antes de reconciliar.', 'reconciliation_destination_verifier_required');
    if (decision.destination.checkout !== previous.destination?.checkout
      || path.resolve(previous.destination?.workspace ?? '') !== path.resolve(previous.workspace ?? '')) {
      throw new QueueError('El manifiesto no corresponde al checkout confirmado del job.', 'reconciliation_destination_mismatch');
    }
    const observedDestination = await verifyDestination(root, previous, decision.destination);
    if (!observedDestination || path.resolve(observedDestination.workspace ?? '') !== path.resolve(previous.workspace)
      || observedDestination.checkout !== decision.destination.checkout || observedDestination.branch !== decision.destination.branch
      || !/^[a-f0-9]{40}$/i.test(observedDestination.sha ?? '')
      || !observedDestination.sha.toLowerCase().startsWith(decision.destination.sha.toLowerCase())) {
      throw new QueueError('La observación real de checkout, rama o commit no coincide con el manifiesto.', 'reconciliation_destination_mismatch');
    }
    const verified = new Map();
    for (const evidence of decision.dispatches) {
      const actual = await verifyDispatch({ ...evidence, jobId: id }, { relatedDispatches: decision.dispatches });
      const approvalRequired = evidence.state === 'succeeded' && ['qa', 'reviewer'].includes(evidence.stage);
      if (!actual || actual.dispatchId !== evidence.dispatchId || actual.taskId !== evidence.taskId
        || actual.runId !== workflow.runId || actual.state !== evidence.state
        || (actual.parentTaskId ?? null) !== evidence.parentTaskId
        || (actual.retryOfDispatchId ?? null) !== evidence.retryOfDispatchId
        || (actual.approvalVerified === true) !== approvalRequired) {
        throw new QueueError(`La evidencia Orca de ${evidence.stage} no coincide con la decisión o no acredita su aprobación.`, 'reconciliation_dispatch_mismatch');
      }
      if (actual.delivery) {
        try { actual.delivery = validateDelivery(actual.delivery, { ...evidence, jobId: id, acceptance: previous.contract?.acceptance }); }
        catch { throw new QueueError('El contrato estructurado verificado no corresponde al job/etapa/intento.', 'reconciliation_dispatch_mismatch'); }
      }
      if (evidence.approvalEvidence === 'structured' && !deliveryApproved(actual.delivery)) {
        throw new QueueError('No se verificó la aprobación estructurada declarada.', 'reconciliation_approval_unverified');
      }
      if (evidence.state === 'succeeded' && actual.delivery
        && (actual.delivery.outcome !== 'completed' || (decision.schema === 2 && decision.scope === 'complete' && actual.delivery.scope !== 'complete'))) {
        throw new QueueError('La entrega verificada declara bloqueo, preguntas pendientes o alcance parcial.', 'reconciliation_incomplete');
      }
      verified.set(evidence.dispatchId, actual);
    }
    const finalDestination = await verifyDestination(root, previous, decision.destination);
    if (!finalDestination || ['checkout', 'workspace', 'branch', 'sha'].some(key => finalDestination[key] !== observedDestination[key])) {
      throw new QueueError('El destino cambió durante la verificación de Orca; vuelve a revisarlo.', 'reconciliation_destination_mismatch');
    }
    const scope = decision.schema === 2 ? decision.scope : 'partial';
    const hasIntegration = workflow.steps.some(step => step.key === 'integration');
    const completed = scope === 'complete' && groups.size === stages.length && !hasIntegration;
    const reconciledSteps = workflow.steps.map(current => {
      if (current.key === 'integration') return { ...current, status: 'blocked', error: 'delivery_wip', updatedAt: stamp() };
      const group = groups.get(current.key);
      if (!group) return current;
      const latest = group.at(-1);
      const history = group.map(item => ({ ...item, receiptId: verified.get(item.dispatchId)?.receiptId ?? null }));
      const actual = verified.get(latest.dispatchId);
      const stagePartial = actual.delivery?.scope === 'partial';
      const sameDispatch = current.dispatchId === latest.dispatchId;
      const preserved = { ...current };
      if (!sameDispatch) {
        // Prior evidence remains in the ledger/history, never attached to a new dispatch.
        for (const key of ['artifact', 'delivery', 'summary', 'summaryTruncated', 'approvalOutcome', 'approvalDispatchId', 'resultMessageId', 'outputChars']) delete preserved[key];
      } else if (actual.delivery && JSON.stringify(actual.delivery) !== JSON.stringify(current.delivery)) {
        delete preserved.artifact;
      }
      return {
        ...preserved,
        status: stagePartial ? 'blocked' : 'succeeded',
        dispatchId: latest.dispatchId,
        taskId: latest.taskId,
        dispatchStatus: 'completed',
        // Native worker retries reuse the task input identity even in a later queue attempt.
        attempt: latest.queueAttempt ?? (sameDispatch ? current.attempt ?? previous.attempts : previous.attempts),
        taskInputAttempt: latest.jobAttempt,
        dispatchHistory: history,
        dispatchSettled: true,
        resultMessageId: actual.receiptId ?? null,
        error: stagePartial ? 'delivery_wip' : null,
        ...(actual.delivery ? { delivery: actual.delivery } : {}),
        ...(['qa', 'reviewer'].includes(current.key) ? { approvalOutcome: 'approved', approvalDispatchId: latest.dispatchId } : {}),
        updatedAt: stamp(),
        ...(actual.delivery ? { summary: actual.delivery.summary } : current.key === 'developer' ? { summary: decision.evidence.trim() } : {}),
      };
    });
    const changedAt = stamp();
    const coordinatorDecision = {
      schema: decision.schema,
      decisionId: decision.decisionId,
      by: 'coordinator',
      at: changedAt,
      evidence: decision.evidence.trim(),
      dispatches: decision.dispatches.map(item => ({ ...item })),
      destination: { ...decision.destination, ...observedDestination, checkedAt: changedAt },
      manifest: structuredClone(decision),
      scope,
      deliveryStatus: completed ? 'complete' : 'wip',
    };
    const job = {
      ...previous,
      state: completed ? 'succeeded' : 'needs_attention',
      error: completed ? null : { code: 'delivery_wip', message: 'Evidencia reconciliada; el alcance parcial o la integración pendiente requieren revisión.' },
      result: { provider: 'coordinator-reconciled-orca', text: decision.evidence.trim() },
      finishedAt: changedAt,
      reviewedAt: changedAt,
      deliveryReviewed: true,
      deliveryStatus: completed ? 'complete' : 'wip',
      destination: { ...previous.destination, ...decision.destination, ...observedDestination, workspace: previous.workspace, checkedAt: changedAt },
      branch: decision.destination.branch,
      coordinatorDecision,
      reconciliationDecisionId: decision.decisionId,
      workflow: {
        ...workflow,
        status: completed ? 'succeeded' : 'delivery_wip',
        currentStage: completed ? null : reconciledSteps.find(step => step.key !== 'integration' && step.status !== 'succeeded')?.key ?? (hasIntegration ? 'integration' : null),
        updatedAt: changedAt,
        steps: reconciledSteps,
      },
    };
    await commit(root, state, 'code_job_reconciled', { jobs: [job] }, {
      jobId: id, decisionId: decision.decisionId, dispatchIds: decision.dispatches.map(item => item.dispatchId),
      destination: { checkout: decision.destination.checkout, branch: decision.destination.branch, sha: decision.destination.sha },
      deliveryStatus: job.deliveryStatus,
    });
    return job;
  });
}

export async function setBudget(root, patch) {
  for (const key of ['limitUsd', 'inputPerMillion', 'outputPerMillion']) if (!Number.isFinite(patch[key]) || patch[key] < 0) throw new QueueError(`${key} debe ser un número no negativo.`);
  if (!patch.model || !/^[\w.:-]{1,100}$/.test(patch.model)) throw new QueueError('Indica un modelo válido.');
  return mutate(root, async state => {
    const budget = { ...state.budget, ...patch };
    if (budget.limitUsd < budget.estimatedSpentUsd + budget.reservedUsd) throw new QueueError('El límite no puede bajar del gasto ya reservado/estimado.');
    await commit(root, state, 'budget_set', { budget });
    return budget;
  });
}

// 2 + 15: typed errors may carry details for the operator. Only bounded primitives
// reach the ledger; the message itself still comes from a typed safeMessage.
export function boundedErrorDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const entries = Object.entries(details)
    .filter(([key, value]) => /^[a-zA-Z0-9_]{1,40}$/.test(key) && ['string', 'number', 'boolean'].includes(typeof value) && value !== '')
    .slice(0, 20)
    .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 600) : value]);
  return entries.length ? { details: Object.fromEntries(entries) } : {};
}

export function elapsedAttemptMs(job) {
  const segments = (job.attemptHistory ?? []).filter(item => item.attempt === job.attempts);
  if (!segments.length || segments.some(item => !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0)) throw new QueueError('Falta evidencia del tiempo consumido por este intento.', 'resume_elapsed_unknown');
  return segments.reduce((sum, item) => sum + item.elapsedMs, 0);
}

export function isSameAttemptRecoveryMode(mode) {
  return ['same_attempt_liveness', 'same_attempt_delivery_transport', 'same_attempt_integration_validation', 'same_attempt_integration_reconcile', 'same_attempt_ux_return', 'same_attempt_developer_decision', 'same_attempt_stage_decision'].includes(mode);
}

export const recoveryFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assertCommittedIntegrationRecord(job, record) {
  const validation = record?.validation, steps = integrationValidationSteps(job);
  const developer = steps.find(item => item.stage === 'developer');
  if (!record || !['pr_intent', 'pr_confirmed', 'checks_pending', 'merge_intent'].includes(record.phase)
    || record.jobId !== job.id || record.receiptId !== job.autoIntent?.receiptId || record.repository !== job.destination?.repository
    || record.sourceBranch !== job.branch || record.baseBranch !== job.destination?.baseBranch || record.sourceBranch === record.baseBranch
    || !/^[a-f0-9]{40,64}$/.test(record.commitSha || '') || !/^[a-f0-9]{64}$/.test(record.manifest || '')
    || record.remoteBaseSha !== job.destination?.baseSha || record.baseline !== job.destination?.sha
    || !validation || validation.snapshot !== record.manifest || validation.jobId !== job.id || validation.receiptId !== record.receiptId
    || validation.attempt !== job.attempts || validation.runId !== job.workflow.runId || validation.workspace !== job.workspace || validation.branch !== job.branch
    || validation.cycleId !== (job.validationCycle || `attempt-${job.attempts}`)
    || validation.developerTaskId !== developer.taskId || validation.developerDispatchId !== developer.dispatchId || validation.developerArtifactSha256 !== developer.artifactSha256) {
    throw new QueueError('La integración no conserva el commit, manifiesto y validación aprobados.', 'integration_reconcile_invalid');
  }
  for (const stage of ['qa', 'reviewer']) {
    const step = job.workflow.steps.find(item => item.key === stage), approval = validation.approvals?.[stage];
    if (!deliveryApproved(step.delivery) || approval?.taskId !== step.taskId || approval.dispatchId !== step.dispatchId || approval.artifactSha256 !== step.artifact.sha256) {
      throw new QueueError('Las aprobaciones guardadas no corresponden a las etapas originales.', 'integration_reconcile_invalid');
    }
    validateDelivery(step.delivery, { jobId: job.id, jobAttempt: step.taskInputAttempt, stage, runId: step.runId, taskId: step.taskId,
      dispatchId: step.dispatchId, acceptance: job.contract?.acceptance });
  }
  return steps;
}

export function assertIntegrationReconcileProof(job, recovery, proof) {
  const record = recovery.originalIntegrationRecord;
  assertCommittedIntegrationRecord(job, record);
  if (!proof || proof.kind !== 'committed_integration' || recovery.integrationRecordHash !== recoveryFingerprint(record)
    || ['jobId', 'receiptId', 'commitSha', 'manifest', 'phase', 'repository', 'sourceBranch', 'baseBranch'].some(key => proof[key] !== record[key])
    || proof.baseSha !== record.remoteBaseSha || proof.prBaseSha !== record.remoteBaseSha || proof.prHeadSha !== record.commitSha
    || !Number.isInteger(proof.prNumber) || proof.prNumber < 1 || record.prNumber && proof.prNumber !== record.prNumber
    || typeof proof.prUrl !== 'string' || proof.prUrl.toLowerCase() !== `https://github.com/${record.repository}/pull/${proof.prNumber}`.toLowerCase()
    || !(proof.prState === 'OPEN' || record.phase === 'merge_intent' && proof.prState === 'MERGED' && /^[a-f0-9]{40,64}$/.test(proof.mergeSha || ''))) {
    throw new QueueError('La PR observada no corresponde a la integración aprobada.', 'integration_reconcile_invalid');
  }
  return structuredClone(proof);
}

export function recoverableChecksTimeout(job, record, code = job?.error?.code) {
  return code === 'github_checks_timeout' && job?.workflow?.currentStage === 'integration'
    && record?.phase === 'checks_pending' && record.checkState === 'waiting' && record.waitTimedOut === true
    && Number.isSafeInteger(record.prNumber) && record.prNumber > 0 && Boolean(record.commitSha);
}

function assertIntegrationReconcileResume(job, recovery) {
  const step = job.workflow?.steps?.find(item => item.key === 'integration');
  if (recovery?.mode !== 'same_attempt_integration_reconcile' || (recovery.originalError !== 'github_integration_needs_attention'
    && !recoverableChecksTimeout(job, recovery.originalIntegrationRecord, recovery.originalError))
    || recovery.jobId !== job.id || recovery.receiptId !== job.autoIntent?.receiptId || recovery.attempt !== job.attempts
    || recovery.runId !== job.workflow?.runId || recovery.observedState !== 'succeeded' || recovery.liveness !== 'exited'
    || job.workflow.currentStage !== 'integration' || step?.status !== 'blocked' || step.error !== 'integration_needs_attention'
    || recovery.checkpointHash !== recoveryFingerprint(job.workflow) || recovery.elapsedMs !== elapsedAttemptMs(job)
    || recovery.timeoutMs !== job.timeoutMs || executionTimeExhausted(job, recovery.elapsedMs)) throw new QueueError('El checkpoint o tiempo de integración cambió.', 'integration_reconcile_invalid');
  assertIntegrationReconcileProof(job, recovery, recovery.integrationProof);
}

export async function queueIntegrationReconcileResume(root, id, recovery) {
  return mutate(root, async state => {
    const previous = state.jobs.find(item => item.id === id);
    if (previous?.state === 'queued' && previous.livenessResume?.id === recovery.id) { assertIntegrationReconcileResume(previous, previous.livenessResume); return previous; }
    if (previous?.state !== 'needs_attention' || previous.error?.code !== recovery.originalError || previous.reservedUsd !== 0
      || previous.livenessRecoveryHistory?.some(item => item.mode === recovery.mode && item.integrationRecordHash === recovery.integrationRecordHash)) {
      throw new QueueError('Este registro de integración ya fue reanudado o no está bloqueado.', 'integration_reconcile_invalid');
    }
    assertIntegrationReconcileResume(previous, recovery);
    const marker = { ...recovery, phase: 'ready', queuedAt: stamp() };
    const job = { ...previous, state: 'queued', error: null, nextAttemptAt: null, livenessResume: marker,
      workflowHistory: [...(previous.workflowHistory || []), { ...previous.workflow, attempt: previous.attempts, savedAt: stamp(), recoveryId: recovery.id }],
      livenessRecoveryHistory: [...(previous.livenessRecoveryHistory || []), marker] };
    await commit(root, state, 'integration_reconcile_queued', { jobs: [job] }, { jobId: id, recoveryId: recovery.id, attempt: job.attempts }); return job;
  }, 2000);
}

function settledQualityBlock(job, stage) {
  const workflow = job?.workflow;
  const block = workflow?.steps?.find(item => item.key === stage);
  const downstream = stage === 'qa' ? ['reviewer', 'integration'] : ['integration'];
  if (job?.state !== 'needs_attention' || job.kind !== 'code' || job.provider !== 'orca'
    || job.error?.code !== 'delivery_incomplete' || workflow?.currentStage !== stage || block?.status !== 'blocked'
    || block.dispatchSettled !== true || !['failed', 'completed'].includes(block.dispatchStatus)
    || !['blocked', 'failed'].includes(block.delivery?.outcome) || block.delivery.scope !== 'complete' || !block.resultMessageId
    || !downstream.every(key => workflow.steps.some(item => item.key === key && item.status === 'queued' && !item.taskId && !item.dispatchId))) return null;
  return block;
}

export function settledQaRevalidation(job, qualityAction) {
  const revalidations = job?.livenessRecoveryHistory?.filter(item => item.mode === 'same_attempt_integration_validation' && item.stage === 'qa').length ?? 0;
  return !qualityAction && revalidations >= (job?.maxAttempts ?? 1) - 1 ? null : settledQualityBlock(job, 'qa');
}

export const settledReviewerRevalidation = job => settledQualityBlock(job, 'reviewer');

export function qualityCorrection(job) {
  const block = settledQualityBlock(job, 'qa') || settledQualityBlock(job, 'reviewer');
  const findings = (block?.delivery.acceptance || []).filter(item => item.status === 'failed' && item.evidence.trim()
    && job.contract?.acceptance.includes(item.criterion));
  const rounds = (job.livenessRecoveryHistory || []).filter(item => item.qualityAction?.type === 'correction');
  const criteria = findings.map(item => item.criterion).sort();
  const previous = rounds.at(-1)?.qualityAction.findings.map(item => item.criterion).sort();
  return findings.length && rounds.length < 5 && (!previous || recoveryFingerprint(previous) !== recoveryFingerprint(criteria))
    ? { findings, round: rounds.length + 1 } : null;
}

export function assertQualityAction(job, action) {
  if (!action) return;
  const block = settledQualityBlock(job, 'qa') || settledReviewerRevalidation(job);
  if (!block || !job.coordination || action.dispatchId !== block.dispatchId || action.messageId !== block.resultMessageId
    || !Array.isArray(action.answers) || action.answers.some(item => !item.questionId || !item.question || !item.answer?.trim())
    || (action.type === 'answer' ? !action.answers.length : action.type !== 'correction'
      || recoveryFingerprint({ findings: action.findings, round: action.round }) !== recoveryFingerprint(qualityCorrection(job)))) {
    throw new QueueError('La continuación no corresponde al informe de calidad o alcanzó su límite de correcciones.', 'qa_quality_action_invalid');
  }
}

export function integrationValidationSteps(job, scope = 'integration', qualityAction) {
  const block = scope === 'qa' ? settledQaRevalidation(job, qualityAction)
    : scope === 'reviewer' && qualityAction ? settledReviewerRevalidation(job) : null;
  if (scope !== 'integration' && !block) throw new QueueError('La etapa de calidad no acredita un cierre bloqueado.', 'integration_recovery_invalid');
  const keys = scope === 'qa' ? ['ux', 'developer', 'qa'] : ['ux', 'developer', 'qa', 'reviewer'];
  const steps = keys.map(stage => {
    const step = job?.workflow?.steps?.find(item => item.key === stage);
    if (!(step && (step.status === 'succeeded' || step === block)) || step.runId !== job.workflow.runId || !IDENTIFIERS.taskId.test(step.taskId || '')
      || !IDENTIFIERS.dispatchId.test(step.dispatchId || '') || !Number.isInteger(step.taskInputAttempt) || step.taskInputAttempt < 1
      || !/^[a-f0-9]{64}$/.test(step.artifact?.sha256 || '')) throw new QueueError('Falta una etapa original aprobada y verificable.', 'integration_recovery_invalid');
    return { stage, runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId, taskInputAttempt: step.taskInputAttempt, artifactSha256: step.artifact.sha256,
      ...(step === block ? { workerState: block.dispatchStatus === 'failed' ? 'failed' : 'succeeded' } : {}) };
  });
  return steps;
}

export function assertIntegrationValidationProof(recovery, proof) {
  if (!proof || !/^[a-f0-9]{64}$/.test(proof.candidateSnapshot || '')
    || !/^[a-f0-9]{64}$/.test(recovery.originalWorkflowHash || '') || !/^[a-f0-9]{64}$/.test(recovery.integrationRecordHash || '')
    || !Array.isArray(recovery.originalSteps) || recovery.originalSteps.length !== (recovery.stage === 'qa' ? 3 : 4)
    || proof.originalWorkflowHash !== recovery.originalWorkflowHash || proof.integrationRecordHash !== recovery.integrationRecordHash
    || recoveryFingerprint(proof.originalSteps) !== recoveryFingerprint(recovery.originalSteps)) {
    throw new QueueError('La nueva validación no conserva la identidad y evidencia originales.', 'integration_recovery_invalid');
  }
  return { candidateSnapshot: proof.candidateSnapshot, originalWorkflowHash: proof.originalWorkflowHash,
    integrationRecordHash: proof.integrationRecordHash, originalSteps: structuredClone(proof.originalSteps) };
}

function validationResetStages(recovery) {
  if (recovery.qualityAction?.type === 'correction') return ['developer', 'qa', 'reviewer', 'integration'];
  return recovery.stage === 'reviewer' ? ['reviewer', 'integration'] : ['qa', 'reviewer', 'integration'];
}

function assertIntegrationValidationResume(job, recovery) {
  const proof = assertIntegrationValidationProof(recovery, recovery.integrationValidation);
  const resetStages = validationResetStages(recovery);
  if (recovery.mode !== 'same_attempt_integration_validation'
    || recovery.originalError !== (recovery.stage === 'integration' ? 'github_integration_needs_attention' : 'delivery_incomplete')
    || recovery.jobId !== job.id || recovery.receiptId !== job.autoIntent?.receiptId || recovery.attempt !== job.attempts
    || recovery.runId !== job.workflow?.runId || recovery.observedState !== 'succeeded' || recovery.liveness !== 'exited'
    || job.validationCycle !== recovery.id || recovery.queuedWorkflowHash !== recoveryFingerprint(job.workflow)
    || job.workflow.currentStage !== resetStages[0]
    || resetStages.some(key => {
      const step = job.workflow.steps.find(item => item.key === key); return !step || step.status !== 'queued' || step.taskId || step.dispatchId || step.delivery || step.artifact;
    }) || recovery.elapsedMs !== elapsedAttemptMs(job) || recovery.timeoutMs !== job.timeoutMs || executionTimeExhausted(job, recovery.elapsedMs)
    || !proof.candidateSnapshot) throw new QueueError('El checkpoint de nueva validación cambió o agotó su tiempo.', 'integration_recovery_invalid');
}

export async function queueIntegrationValidationResume(root, id, recovery) {
  return mutate(root, async state => {
    const previous = state.jobs.find(item => item.id === id);
    if (previous?.state === 'queued' && previous.livenessResume?.id === recovery.id) { assertIntegrationValidationResume(previous, previous.livenessResume); return previous; }
    const integration = previous?.workflow?.steps?.find(item => item.key === 'integration');
    if (recovery.qualityAction) assertQualityAction(previous, recovery.qualityAction);
    const recoverable = recovery.stage === 'qa' ? settledQaRevalidation(previous, recovery.qualityAction)
      : recovery.stage === 'reviewer' && recovery.qualityAction ? settledReviewerRevalidation(previous)
      : previous?.error?.code === 'github_integration_needs_attention' && previous.workflow?.currentStage === 'integration'
        && integration?.status === 'blocked' && integration.error === 'integration_needs_attention';
    if (previous?.state !== 'needs_attention' || !recoverable
      || (recovery.stage === 'integration' && previous.validationCycle) || previous.reservedUsd !== 0 || recovery.originalWorkflowHash !== recoveryFingerprint(previous.workflow)
      || recoveryFingerprint(integrationValidationSteps(previous, recovery.stage, recovery.qualityAction)) !== recoveryFingerprint(recovery.originalSteps)) {
      throw new QueueError('Solo se revalida una vez la integración sin manifiesto original.', 'integration_recovery_invalid');
    }
    assertIntegrationValidationProof(recovery, recovery.integrationValidation);
    const resetStages = validationResetStages(recovery);
    const workflow = { ...previous.workflow, status: 'queued', currentStage: resetStages[0], updatedAt: stamp(),
      steps: previous.workflow.steps.map(step => resetStages.includes(step.key)
        ? { key: step.key, label: step.label, ...(step.profile ? { profile: step.profile } : {}), status: 'queued', validationCycle: recovery.id,
          ...(step.key === 'developer' || step.key === recovery.stage && recovery.stage !== 'integration'
            ? { predecessorTaskId: recovery.originalSteps.find(item => item.stage === step.key).taskId } : {}) } : step) };
    const marker = { ...recovery, phase: 'ready', queuedAt: stamp(), queuedWorkflowHash: recoveryFingerprint(workflow) };
    const answers = recovery.qualityAction?.answers ?? [];
    const qualityAnswers = [...(previous.qualityAnswers || []), ...answers.map(answer => ({ ...answer,
      ...(recovery.stage === 'reviewer' ? { reviewerDispatchId: recovery.qualityAction.dispatchId } : { qaDispatchId: recovery.qualityAction.dispatchId }),
      candidateSnapshot: recovery.integrationValidation.candidateSnapshot }))];
    const job = { ...previous, state: 'queued', error: null, nextAttemptAt: null, validationCycle: recovery.id, livenessResume: marker, workflow,
      ...(answers.length ? { qualityAnswers } : {}),
      workflowHistory: [...(previous.workflowHistory || []), { ...previous.workflow, attempt: previous.attempts, savedAt: stamp(), recoveryId: recovery.id, originalWorkflowHash: recovery.originalWorkflowHash }],
      livenessRecoveryHistory: [...(previous.livenessRecoveryHistory || []), marker] };
    assertIntegrationValidationResume(job, marker);
    await commit(root, state, 'integration_validation_queued', { jobs: [job] }, { jobId: id, recoveryId: recovery.id, attempt: job.attempts });
    return job;
  }, 2000);
}

export function deliveryTransportError(job) {
  const step = job?.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  if (!step || step.status !== 'blocked' || step.dispatchStatus !== 'completed' || step.dispatchSettled !== true
    || !Number.isInteger(step.taskInputAttempt) || step.taskInputAttempt < 1 || !/^[a-f0-9]{64}$/i.test(step.artifact?.sha256 || '')) return null;
  if (['qa', 'reviewer'].includes(step.key) && step.error === 'delivery_acceptance_missing') return step.error;
  if (step.key === 'ux' && step.error === 'delivery_invalid' && job.contract?.acceptanceScope === 'product'
    && job.workflow.steps.every(item => item === step || item.status === 'queued' && !item.taskId && !item.dispatchId)) return step.error;
  return null;
}
export const isDeliveryTransportCheckpoint = job => Boolean(deliveryTransportError(job));

// The native inspector authenticates this proof. Queue admission binds it to the
// unchanged failed report; it never accepts a replacement approval from a caller.
export function assertDeliveryTransportProof(job, proof) {
  const step = job?.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  const checkpointError = deliveryTransportError(job);
  if (checkpointError === 'delivery_invalid') {
    const fields = ['kind', 'jobId', 'jobAttempt', 'stage', 'runId', 'taskId', 'dispatchId', 'originalArtifactSha256', 'reportSha256', 'deliverySha256'];
    if (proof?.kind !== 'ux_product_acceptance_array' || proof.jobId !== job.id || proof.jobAttempt !== step.taskInputAttempt
      || proof.stage !== 'ux' || proof.runId !== job.workflow.runId || proof.runId !== step.runId
      || proof.taskId !== step.taskId || proof.dispatchId !== step.dispatchId || proof.originalArtifactSha256 !== step.artifact.sha256
      || ['reportSha256', 'deliverySha256'].some(key => !/^[a-f0-9]{64}$/.test(proof[key] || ''))) {
      throw new QueueError('La recuperación UX no corresponde al informe original.', 'delivery_transport_unverified');
    }
    return Object.fromEntries(fields.map(key => [key, proof[key]]));
  }
  const hashes = ['originalArtifactSha256', 'receiptSha256', 'transcriptSha256', 'deliverySha256'];
  if (!isDeliveryTransportCheckpoint(job) || !['unicode_loss', 'criteria_normalized'].includes(proof?.kind)
    || proof.jobId !== job.id || proof.jobAttempt !== step.taskInputAttempt || proof.stage !== step.key
    || proof.runId !== job.workflow.runId || proof.runId !== step.runId || proof.taskId !== step.taskId || proof.dispatchId !== step.dispatchId
    || hashes.some(key => !/^[a-f0-9]{64}$/i.test(proof[key] || '')) || proof.originalArtifactSha256 !== step.artifact.sha256
    || !/^msg_[A-Za-z0-9_-]{6,100}$/.test(proof.receiptMessageId || '')
    || typeof proof.transcriptSourceIdentity !== 'string' || !proof.transcriptSourceIdentity.trim()
    || proof.transcriptSourceIdentity.length > 4000 || /[\x00-\x1f]/.test(proof.transcriptSourceIdentity)) {
    throw new QueueError('La evidencia de transporte no corresponde al informe y asignación originales.', 'delivery_transport_unverified');
  }
  return Object.fromEntries(['kind', 'jobId', 'jobAttempt', 'stage', 'runId', 'taskId', 'dispatchId',
    'originalArtifactSha256', 'receiptMessageId', 'receiptSha256', 'transcriptSourceIdentity', 'transcriptSha256', 'deliverySha256'].map(key => [key, proof[key]]));
}

export function settledOrcaObservation(job, code = job?.error?.code) {
  const step = job?.workflow?.steps?.find(item => item.key === job.workflow.currentStage);
  if (job?.provider !== 'orca' || job.kind !== 'code' || !step
    || !IDENTIFIERS.dispatchId.test(step.dispatchId ?? '') || !IDENTIFIERS.taskId.test(step.taskId ?? '')
    || !IDENTIFIERS.runId.test(step.runId ?? '') || step.runId !== job.workflow.runId || step.attempt !== job.attempts) return null;
  if (code === 'delivery_invalid' && ['qa', 'reviewer'].includes(step.key) && step.status === 'blocked' && step.error === code
    && step.dispatchSettled === true && step.dispatchStatus === 'completed' && step.artifact && !step.delivery) return step;
  if (step.artifact) return null;
  // An executor interruption leaves the exact developer dispatch blocked; recovery observes that same dispatch.
  if (code === 'interrupted' && step.key === 'developer' && step.status === 'blocked' && step.error === code) return step;
  if (code === 'orca_response_too_large' && step.dispatchStatus === 'awaiting_exit'
    && (step.status === 'running' && !step.error || step.status === 'blocked' && step.error === code)) return step;
  if (code === 'orca_dispatch_status_unknown' && step.status === 'blocked' && step.dispatchStatus === 'unknown'
    && isOrcaStatusReadError(step.error)) return step;
  return null;
}

export function settledUxReturnStep(job) {
  const workflow = job?.workflow;
  const step = workflow?.steps?.find(item => item.key === 'developer');
  if (job?.state !== 'needs_attention' || job.error?.code !== 'delivery_incomplete'
    || job.business !== 'games' || job.kind !== 'code' || job.provider !== 'orca' || !job.autoIntent?.eligible
    || workflow?.currentStage !== 'developer' || step?.status !== 'blocked' || step.dispatchSettled !== true
    || step.dispatchStatus !== 'failed' || !step.artifact || step.delivery?.scope !== 'partial'
    || step.delivery.outcome !== 'blocked' || !step.delivery.questions.some(item => item.required)
    || step.delivery.questions.some(item => item.required && !/^UX-I[1-3]-return$/i.test(item.decisionKey || ''))
    || !workflow.steps.some(item => item.key === 'ux' && item.status === 'succeeded' && item.artifact)
    || !['qa', 'reviewer', 'integration'].every(key => workflow.steps.some(item => item.key === key && item.status === 'queued' && !item.dispatchId))
    || (job.livenessRecoveryHistory || []).filter(item => item.mode === 'same_attempt_ux_return').length >= 6) return null;
  return step;
}

export function uxReturnSource(job, handoff) {
  const step = settledUxReturnStep(job);
  if (!step || !handoff || handoff.jobId !== job.id || handoff.business !== job.business || handoff.projectId !== (job.projectId || null)
    || handoff.runId !== job.workflow.runId || handoff.runId !== job.coordination?.runId || handoff.authorizedBy !== job.coordination?.senderId
    || handoff.fromStage !== 'developer' || handoff.toStage !== 'ux' || handoff.taskId !== step.taskId || handoff.dispatchId !== step.dispatchId
    || handoff.attempt !== job.attempts || !/^msg_[a-zA-Z0-9_-]{6,100}$/.test(handoff.approvalMessageId ?? '')) return null;
  return step;
}

export function stageDecisionSource(job, value) {
  if (!value || job?.state !== 'needs_attention' || !['delivery_incomplete', 'needs_input'].includes(job.error?.code)
    || job.provider !== 'orca' || !job.coordination || !job.autoIntent?.eligible
    || !(job.kind === 'analysis' ? job.workflow?.currentStage === 'planner'
      : job.kind === 'code' && ['ux', 'developer', 'qa', 'reviewer'].includes(job.workflow?.currentStage))) return null;
  const index = job.workflow.steps.findIndex(item => item.key === job.workflow.currentStage);
  const step = job.workflow.steps[index];
  if (step?.status !== 'blocked' || step.dispatchSettled !== true || !['failed', 'completed'].includes(step.dispatchStatus)
    || !['blocked', 'needs_input'].includes(step.delivery?.outcome) || !step.artifact
    || job.workflow.steps.slice(0, index).some(item => item.status !== 'succeeded' || !item.artifact)
    || job.workflow.steps.slice(index + 1).some(item => item.status !== 'queued' || item.taskId || item.dispatchId)) return null;
  const continuation = validateContinuation(value);
  if (continuation.parentJobId !== job.id || continuation.rootJobId !== job.id) return null;
  const required = step.delivery.questions.filter(item => item.required);
  return required.length && required.every(question => !/^UX-I[1-3]-return$/i.test(question.decisionKey || '')
    && continuation.decisions.some(item => continuation.questionIds.includes(item.questionId)
      && item.decisionKey === (question.decisionKey || question.id) && item.question === question.text)) ? step : null;
}

export function developerDecisionSource(job, value) {
  return job?.workflow?.currentStage === 'developer' ? stageDecisionSource(job, value) : null;
}

export const isPartialStageResume = mode => ['same_attempt_ux_return', 'same_attempt_developer_decision', 'same_attempt_stage_decision'].includes(mode);

function assertPartialResume(job, recovery) {
  const source = job.state === 'queued' ? job.workflowHistory?.find(item => item.recoveryId === recovery.id) : job.workflow;
  const original = source && { ...source };
  if (original && job.state === 'queued') for (const key of ['attempt', 'savedAt', 'recoveryId']) delete original[key];
  if (!original || recovery.jobId !== job.id || recovery.receiptId !== job.autoIntent?.receiptId || recovery.attempt !== job.attempts
    || recovery.runId !== job.workflow.runId || recovery.stage !== original?.currentStage
    || !(recovery.mode === 'same_attempt_ux_return' ? recovery.observedState === 'failed' : ['failed', 'succeeded'].includes(recovery.observedState)) || recovery.liveness !== 'exited'
    || (job.kind === 'code' && !/^[a-f0-9]{64}$/.test(recovery.snapshot || '')) || recoveryFingerprint(original) !== recovery.originalWorkflowHash
    || (job.state === 'queued' ? recoveryFingerprint(job.workflow) !== recovery.queuedWorkflowHash
      : recovery.mode === 'same_attempt_ux_return' ? !uxReturnSource(job, recovery.uxHandoff) : !stageDecisionSource(job, recovery.stageDecision || recovery.developerDecision))
    || recovery.elapsedMs !== elapsedAttemptMs(job) || recovery.timeoutMs !== job.timeoutMs || executionTimeExhausted(job, recovery.elapsedMs)) {
    throw new QueueError('La continuación perdió la evidencia del candidato o de su autorización.', 'partial_resume_invalid');
  }
}

function assertLivenessResume(job, recovery) {
  if (isPartialStageResume(recovery?.mode)) return assertPartialResume(job, recovery);
  if (recovery?.mode === 'same_attempt_integration_validation') return assertIntegrationValidationResume(job, recovery);
  if (recovery?.mode === 'same_attempt_integration_reconcile') return assertIntegrationReconcileResume(job, recovery);
  const step = job.workflow?.steps?.find(item => item.key === recovery?.stage);
  const transport = recovery?.mode === 'same_attempt_delivery_transport';
  const observation = recovery?.error && settledOrcaObservation(job, recovery.error);
  const originalError = transport ? deliveryTransportError(job) : observation ? recovery.error : 'orca_liveness_unconfirmed';
  if (!isSameAttemptRecoveryMode(recovery?.mode) || recovery.error !== originalError || transport && recovery.originalError !== originalError
    || recovery.attempt !== job.attempts || recovery.runId !== job.workflow?.runId
    || recovery.stage !== job.workflow?.currentStage || !step || (!observation && (step.status !== 'blocked' || step.error !== originalError))
    || step.runId !== recovery.runId || step.taskId !== recovery.taskId || step.dispatchId !== recovery.dispatchId
    || createHash('sha256').update(JSON.stringify(step)).digest('hex') !== recovery.checkpointHash
    || !['succeeded', ...(observation ? ['failed', 'cancelled'] : [])].includes(recovery.observedState) || recovery.liveness !== 'exited'
    || recovery.elapsedMs !== elapsedAttemptMs(job) || recovery.timeoutMs !== job.timeoutMs || executionTimeExhausted(job, recovery.elapsedMs)) {
    throw new QueueError('La reanudación no acredita el mismo cierre, checkpoint y tiempo restante.', 'liveness_resume_invalid');
  }
  if (transport) assertDeliveryTransportProof(job, recovery.deliveryTransport);
}

export function isEffectFreeLivenessPreflight(job, recovery = job?.livenessResume) {
  const marker = job?.livenessResume;
  const last = job?.attemptHistory?.at(-1);
  const step = job?.workflow?.steps?.find(item => item.key === marker?.stage);
  const stageIndex = job?.workflow?.steps?.findIndex(item => item.key === marker?.stage) ?? -1;
  return Boolean(job?.state === 'needs_attention' && job.error?.code === 'worker_error'
    && marker?.mode === 'same_attempt_liveness' && marker.phase === 'consumed' && recovery?.phase === 'consumed' && recovery.id === marker.id
    && marker.error === 'orca_liveness_unconfirmed' && marker.observedState === 'succeeded' && marker.liveness === 'exited'
    && last?.attempt === job.attempts && last.recoveryId === marker.id && last.error === 'worker_error'
    && last.metrics?.orcaCliCalls === 0 && (last.metrics.dispatchStarts === undefined || last.metrics.dispatchStarts === 0)
    && (last.metrics.polls === undefined || last.metrics.polls === 0)
    && marker.attempt === job.attempts && marker.stage === job.workflow.currentStage && marker.runId === job.workflow.runId
    && step?.status === 'blocked' && step.error === 'orca_liveness_unconfirmed'
    && stageIndex >= 0 && job.workflow.steps.slice(stageIndex + 1).every(item => item.status === 'queued' && !item.dispatchId && !item.taskId)
    && ['runId', 'taskId', 'dispatchId', 'checkpointHash', 'attempt', 'stage'].every(key => recovery[key] === marker[key])
    && step.runId === marker.runId && step.taskId === marker.taskId && step.dispatchId === marker.dispatchId
    && createHash('sha256').update(JSON.stringify(step)).digest('hex') === marker.checkpointHash);
}

export async function queueKnownLivenessResume(root, id, recovery) {
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous) throw new QueueError('No existe el trabajo.');
    if (previous.state === 'queued' && previous.livenessResume?.id === recovery?.id && previous.livenessResume.phase === 'ready') {
      assertLivenessResume(previous, previous.livenessResume); return previous;
    }
    const rearm = recovery?.rearmedFrom === previous.livenessResume?.id && isEffectFreeLivenessPreflight(previous)
      && recovery.preflightSegmentHash === createHash('sha256').update(JSON.stringify(previous.attemptHistory.at(-1))).digest('hex');
    const transport = recovery?.mode === 'same_attempt_delivery_transport' && previous.error?.code === deliveryTransportError(previous);
    const uxReturn = recovery?.mode === 'same_attempt_ux_return' && uxReturnSource(previous, recovery.uxHandoff);
    const stageDecision = recovery?.mode === 'same_attempt_stage_decision' ? stageDecisionSource(previous, recovery.stageDecision)
      : recovery?.mode === 'same_attempt_developer_decision' && developerDecisionSource(previous, recovery.developerDecision);
    const observation = previous.error?.code === recovery?.error && settledOrcaObservation(previous);
    if (previous.state !== 'needs_attention' || (previous.error?.code !== 'orca_liveness_unconfirmed' && !uxReturn && !stageDecision && !observation && !transport && !rearm) || previous.reservedUsd !== 0) {
      throw new QueueError('Solo se reanuda el mismo intento por cierre físico aún no confirmado.', 'liveness_resume_invalid');
    }
    assertLivenessResume(previous, recovery);
    const workflow = uxReturn || stageDecision ? { ...previous.workflow, status: 'queued', currentStage: uxReturn ? 'ux' : recovery.stage, updatedAt: stamp(),
      steps: previous.workflow.steps.map(step => step.key === recovery.stage || uxReturn && step.key === 'ux'
        ? { key: step.key, label: step.label, profile: step.profile, status: 'queued', predecessorTaskId: step.taskId }
        : step) } : previous.workflow;
    const marker = { ...recovery, phase: 'ready', queuedAt: stamp(), ...(uxReturn || stageDecision ? { queuedWorkflowHash: recoveryFingerprint(workflow) } : {}) };
    const job = { ...previous, state: 'queued', error: null, nextAttemptAt: null, livenessResume: marker, workflow,
      ...(uxReturn ? { uxReturnId: marker.id, stageDecisionId: null, developerDecisionId: null } : {}),
      ...(stageDecision ? { stageDecisionId: marker.id, continuation: validateContinuation(recovery.stageDecision || recovery.developerDecision) } : {}),
      workflowHistory: [...(previous.workflowHistory ?? []), { ...previous.workflow, attempt: previous.attempts, savedAt: stamp(), recoveryId: recovery.id }],
      livenessRecoveryHistory: [...(previous.livenessRecoveryHistory ?? []), ...(rearm ? [{ ...previous.livenessResume, archivedAt: stamp() }] : []), marker] };
    await commit(root, state, 'liveness_resume_queued', { jobs: [job] }, { jobId: id, recoveryId: recovery.id, attempt: job.attempts, dispatchId: recovery.dispatchId, elapsedMs: recovery.elapsedMs });
    return job;
  }, 2000);
}

export async function queueContractRevisionRetry(root, id, revision) {
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous) throw new QueueError('No existe el trabajo.');
    if (previous.state === 'queued' && previous.contractRevision?.id === revision.id) {
      assertContractRevisionCheckpoint(previous, previous.contractRevision); return previous;
    }
    if (previous.state !== 'needs_attention' || previous.contractRevision || previous.error?.code !== 'delivery_incomplete') throw new QueueError('La rectificación ya se aplicó o el trabajo cambió.', 'contract_revision_invalid');
    assertContractRevisionCheckpoint(previous, revision, { queued: false });
    if (!revision.nativeProof || !['verified', 'lock_released'].includes(revision.phase)) throw new QueueError('Falta la comprobación nativa de la rectificación.', 'contract_revision_invalid');
    assertContractRevisionProof(revision, { state: 'settled', liveness: 'exited', runId: revision.runId, contractRevision: revision.nativeProof });
    const qa = previous.workflow.steps.find(step => step.key === 'qa');
    const workflow = { ...previous.workflow, status: 'queued', currentStage: 'qa', updatedAt: stamp(),
      steps: previous.workflow.steps.map(step => ['qa', 'reviewer', 'integration'].includes(step.key)
        ? { key: step.key, label: step.label, ...(step.profile ? { profile: step.profile } : {}), status: 'queued',
          ...(step.key === 'qa' ? { predecessorTaskId: qa.taskId, supersedesDispatchId: qa.dispatchId } : {}) } : step) };
    const marker = { ...revision, phase: 'ready', queuedWorkflowHash: contractRevisionHash(workflow), queuedAt: stamp() };
    const job = { ...previous, contract: revision.contract, contractRevision: marker, workflow, state: 'queued', error: null,
      nextAttemptAt: null, orphanRisk: false, reviewedAt: stamp(),
      contractHistory: [...(previous.contractHistory || []), { revisionId: revision.id, attempt: previous.attempts, contract: previous.contract, contractHash: revision.previousContractHash, reason: revision.reason, savedAt: stamp() }],
      workflowHistory: [...(previous.workflowHistory || []), { ...previous.workflow, attempt: previous.attempts, contractRevisionId: revision.id, savedAt: stamp() }] };
    assertContractRevisionCheckpoint(job, marker);
    await commit(root, state, 'job_contract_revised', { jobs: [job] }, { jobId: id, revisionId: revision.id, fromAttempt: revision.fromAttempt, toAttempt: revision.toAttempt }); return job;
  });
}

export function stoppedDeveloperCheckpoint(job) {
  const workflow = job?.workflow;
  const stage = workflow?.steps?.find(step => step.key === 'developer');
  const ux = workflow?.steps?.find(step => step.key === 'ux');
  if (job?.provider !== 'orca' || job.error?.code !== 'timeout' || executionTimeoutMs(job) !== null
    || workflow?.currentStage !== 'developer' || ux?.status !== 'succeeded'
    || stage?.status !== 'running' || stage.dispatchStatus !== 'active' || stage.attempt !== job.attempts
    || stage.runId !== workflow.runId || !IDENTIFIERS.runId.test(stage.runId ?? '')
    || !IDENTIFIERS.taskId.test(stage.taskId ?? '') || !IDENTIFIERS.dispatchId.test(stage.dispatchId ?? '')
    || stage.delivery || stage.artifact || !stage.specArtifact?.sha256
    || workflow.steps.some(step => step !== ux && step !== stage && (step.status !== 'queued' || step.taskId || step.dispatchId))) return null;
  return stage;
}

// This changes the cap only. The runner still owns the current attempt and
// only verified recovery paths can authorize another dispatch.
export async function increaseJobAttemptLimit(root, id, maxAttempts) {
  const limit = attemptLimit({ maxAttempts });
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous || previous.provider !== 'orca' || !ACTIVE.has(previous.state) || previous.contractRevision) {
      throw new QueueError('Solo se amplía el límite de un encargo Orca activo sin rectificación de contrato.');
    }
    if (limit < previous.maxAttempts) throw new QueueError('Este comando solo amplía el límite de intentos.');
    if (limit === previous.maxAttempts) return previous;
    const job = { ...previous, maxAttempts: limit };
    await commit(root, state, 'job_attempt_limit_increased', { jobs: [job] },
      { jobId: id, from: previous.maxAttempts, to: limit });
    return job;
  }, 2000);
}

export async function retryJob(root, id, { confirm = false, stoppedDeveloperRecovery } = {}) {
  if (!confirm) throw new QueueError('Revisa los resultados/efectos previos y usa --confirm-reviewed para reintentar.');
  return mutate(root, async state => {
    const previous = state.jobs.find(j => j.id === id);
    if (!previous || previous.state !== 'needs_attention') throw new QueueError('Solo se pueden reabrir trabajos needs_attention.');
    if (previous.attempts >= previous.maxAttempts) throw new QueueError('Se alcanzó el máximo de intentos; revisa la tarea y conserva su identidad antes de decidir otra ejecución.');
    if (previous.deliveryStatus === 'wip') throw new QueueError('Una entrega WIP necesita una decisión de alcance; no se reejecuta como un fallo de transporte.', 'delivery_wip');
    const amount = previous.reservedUsd;
    const workflow = previous.workflow;
    const stageIndex = workflow?.steps?.findIndex(step => step.key === workflow.currentStage) ?? -1;
    const activeStep = stageIndex >= 0 ? workflow.steps[stageIndex] : workflow?.steps?.find(step => ['failed', 'blocked', 'running'].includes(step.status));
    if (activeStep && ['running', 'blocked'].includes(activeStep.status) && !activeStep.dispatchId
      && (activeStep.error === 'interrupted' || ['starting', 'unknown'].includes(activeStep.dispatchStatus))) {
      throw new QueueError('El despacho de esta etapa no quedó confirmado. Comprueba Orca antes de reintentar; la cola no iniciará una copia nueva.', 'dispatch_unknown');
    }
    const recovery = stoppedDeveloperRecovery;
    if (recovery && (stoppedDeveloperCheckpoint(previous) !== activeStep || recovery.mode !== 'retry_stopped_developer'
      || recovery.phase !== 'lock_released' || recovery.jobId !== id || recovery.receiptId !== previous.autoIntent?.receiptId
      || recovery.attempt !== previous.attempts || recovery.observedState !== 'stopped' || recovery.liveness !== 'exited'
      || recovery.taskId !== activeStep?.taskId || recovery.dispatchId !== activeStep?.dispatchId
      || recovery.checkpointHash !== recoveryFingerprint(activeStep))) {
      throw new QueueError('La parada confirmada no corresponde a la etapa de desarrollo original.');
    }
    const safelyRetryableStage = activeStep && (recovery ||
      (activeStep.status === 'failed' && ['rejected', 'failed', 'cancelled', 'abandoned'].includes(activeStep.dispatchStatus)) ||
      (activeStep.status === 'blocked' && !['interrupted', 'orca_empty_result'].includes(activeStep.error)
        && ['rejected', 'failed', 'cancelled', 'abandoned', 'completed'].includes(activeStep.dispatchStatus))
    );
    const workflowHistory = workflow
      ? [...(previous.workflowHistory ?? []), { ...workflow, attempt: previous.attempts, savedAt: stamp() }]
      : previous.workflowHistory;
    // Interrupted or uncertain dispatches are kept verbatim so the provider can
    // inspect the same dispatch. Only a confirmed failed/rejected stage is reset.
    let nextWorkflow = workflow;
    if (workflow && safelyRetryableStage) {
      const resetAt = workflow.steps.findIndex(step => step.key === activeStep.key);
      nextWorkflow = {
        ...workflow,
        status: 'queued',
        currentStage: activeStep.key,
        steps: workflow.steps.map((step, index) => index < resetAt
          ? step
          : { key: step.key, label: step.label, profile: step.profile, status: 'queued',
            ...(index === resetAt && IDENTIFIERS.taskId.test(step.taskId ?? '') && IDENTIFIERS.dispatchId.test(step.dispatchId ?? '') && (recovery || ['failed', 'cancelled', 'abandoned'].includes(step.dispatchStatus))
              ? { retryOf: { taskId: step.taskId, dispatchId: step.dispatchId, dispatchStatus: recovery ? 'stopped' : step.dispatchStatus,
                ...(recovery ? { recoveryId: recovery.id } : {}), ...(step.orcaAgent ? { orcaAgent: step.orcaAgent } : {}),
                taskInputAttempt: step.taskInputAttempt ?? step.attempt ?? previous.attempts } }
              : {}),
          }),
        updatedAt: stamp(),
      };
    }
    const job = {
      ...previous,
      ...(workflow ? { workflow: nextWorkflow, workflowHistory } : {}),
      state: 'queued', error: null, nextAttemptAt: null, orphanRisk: false, reservedUsd: 0,
      estimatedUsd: (previous.estimatedUsd ?? 0) + amount,
      costUncertain: previous.costUncertain || amount > 0, reviewedAt: stamp(),
    };
    const budget = { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - amount), estimatedSpentUsd: state.budget.estimatedSpentUsd + amount };
    await commit(root, state, 'operator_retry', { jobs: [job], budget }, { jobId: id });
    return job;
  });
}

// Answers amend one existing objective; an uncertain/live Dispatch is never replaced.
export async function resumeJobWithDecisions(root, id, { continuation, prompt } = {}) {
  continuation = validateContinuation(continuation);
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (previous?.continuation?.decisionRevision === continuation.decisionRevision && previous.continuation.parentJobId === continuation.parentJobId) return previous;
    if (!previous || continuation.parentJobId !== id || previous.state !== 'needs_attention') throw new QueueError('El trabajo ya no espera estas decisiones.', 'continuation_stale');
    if (previous.attempts >= previous.maxAttempts) throw new QueueError('Decisiones guardadas; el límite de intentos requiere revisión.', 'continuation_review_required');
    validateSpec({ ...previous, prompt });
    const index = previous.workflow?.steps.findIndex(step => step.key === previous.workflow.currentStage) ?? -1;
    const stage = previous.workflow?.steps[index];
    if (!stage?.delivery || stage.delivery.outcome !== 'needs_input'
      || !(stage.dispatchStatus === 'completed' || stage.dispatchSettled === true && stage.dispatchStatus === 'failed')
      || !IDENTIFIERS.dispatchId.test(stage.dispatchId ?? '')) {
      throw new QueueError('Las respuestas no autorizan reemplazar un Dispatch activo o incierto.', 'continuation_review_required');
    }
    validateDelivery(stage.delivery, { jobId: id, stage: stage.key, dispatchId: stage.dispatchId, taskId: stage.taskId, runId: previous.workflow.runId, jobAttempt: stage.taskInputAttempt ?? stage.attempt });
    const answers = new Map(continuation.decisions.map(decision => [decision.decisionKey || decision.questionId, decision.answer]));
    if (stage.delivery.questions.filter(q => q.required).some(q => !answers.has(q.decisionKey || q.id)
      && !continuation.decisions.some(d => d.questionId === q.id || d.questionId.endsWith('-' + q.id)))) {
      throw new QueueError('Aún quedan decisiones imprescindibles sin respuesta.', 'continuation_incomplete');
    }
    const workflow = {
      ...previous.workflow, status: 'queued', updatedAt: stamp(),
      steps: previous.workflow.steps.map((item, i) => i < index ? item : {
        key: item.key, label: item.label, profile: item.profile, status: 'queued',
        ...(i === index ? { predecessorTaskId: stage.taskId, supersedesDispatchId: stage.dispatchId } : {}),
      }),
    };
    const job = { ...previous, state: 'queued', prompt, continuation, workflow, error: null,
      workflowHistory: [...(previous.workflowHistory ?? []), { ...previous.workflow, attempt: previous.attempts, savedAt: stamp() }],
      nextAttemptAt: null, updatedAt: stamp() };
    await commit(root, state, 'job_decisions_applied', { jobs: [job] }, { jobId: id, decisionRevision: continuation.decisionRevision, dispatchId: stage.dispatchId });
    return job;
  });
}

export async function resolveJob(root, id, { confirm = false } = {}) {
  if (!confirm) throw new QueueError('Comprueba resultados y que no queda ningún trabajador activo; usa --confirm-reviewed.');
  return mutate(root, async state => {
    const previous = state.jobs.find(j => j.id === id);
    if (!previous || previous.state !== 'needs_attention') throw new QueueError('Solo se pueden cerrar trabajos needs_attention.');
    const amount = previous.reservedUsd;
    const job = { ...previous, state: 'cancelled', reservedUsd: 0, orphanRisk: false, estimatedUsd: (previous.estimatedUsd ?? 0) + amount, costUncertain: previous.costUncertain || amount > 0, reviewedAt: stamp() };
    const budget = { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - amount), estimatedSpentUsd: state.budget.estimatedSpentUsd + amount };
    await commit(root, state, 'operator_closed', { jobs: [job], budget }, { jobId: id });
    return job;
  });
}

export async function retractFalseSuccess(root, id, { confirm = false } = {}) {
  if (!confirm) throw new QueueError('Comprueba la respuesta y el checkout; usa --confirm-reviewed para retirar el falso éxito.');
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    const report = previous?.result?.text ?? '';
    const refusal = /no he podido implementar|no pude implementar|no se han modificado archivos|no he modificado archivos|no pude modificar|solo lectura|no he modificado ning[uú]n archivo/i.test(report);
    if (!previous || previous.kind !== 'code' || previous.state !== 'succeeded' || !refusal) {
      throw new QueueError('Solo se puede retirar un falso éxito de código cuya respuesta guardada documente que no hubo implementación.');
    }
    const job = {
      ...previous,
      state: 'cancelled',
      error: { code: 'false_success_retracted', message: 'Éxito retirado: la respuesta guardada confirma que no hubo cambios de código.' },
      finishedAt: stamp(),
      reviewedAt: stamp(),
      retractedSuccess: true,
    };
    await commit(root, state, 'false_success_retracted', { jobs: [job] }, { jobId: id });
    return job;
  });
}

export async function completeReviewedCodeJob(root, id, { confirm = false, evidence = '' } = {}) {
  if (!confirm) throw new QueueError('Comprueba los cambios y comprobaciones antes de cerrar como entregado; usa --confirm-reviewed.');
  if (typeof evidence !== 'string' || !evidence.trim() || Buffer.byteLength(evidence, 'utf8') > 12_000)
    throw new QueueError('El informe de evidencia debe tener entre 1 y 12.000 bytes.');
  root = path.resolve(root);
  return mutate(root, async state => {
    const previous = state.jobs.find(job => job.id === id);
    if (!previous || previous.kind !== 'code' || previous.state !== 'cancelled' || !previous.retractedSuccess || previous.error?.code !== 'false_success_retracted')
      throw new QueueError('Solo se puede completar tras revisión un trabajo de código cuyo falso éxito ya se retiró.');
    const base = await fs.realpath(path.join(root, 'workspaces'));
    const workspace = await fs.realpath(previous.workspace);
    const relative = path.relative(base, workspace);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new QueueError('El checkout de evidencia debe permanecer dentro de workspaces.');
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: workspace, encoding: 'utf8', windowsHide: true, shell: false,
    });
    if (status.error || status.status !== 0 || !status.stdout.trim())
      throw new QueueError('No hay cambios de código visibles para respaldar la entrega revisada.');
    const job = {
      ...previous,
      state: 'succeeded',
      error: null,
      retractedAttemptResult: previous.result,
      result: { provider: 'coordinator-reviewed', text: evidence.trim() },
      finishedAt: stamp(),
      reviewedAt: stamp(),
      retractedSuccess: false,
      deliveryReviewed: true,
    };
    await commit(root, state, 'code_delivery_reviewed', { jobs: [job] }, { jobId: id, reviewer: 'coordinator' });
    return job;
  });
}

// The ledger timestamp of the last event that persisted this job. The executor
// was alive at that moment, so it bounds the interrupted attempt more tightly
// than the detection time. Returns null without a usable timestamp.
async function lastPersistedEventAt(root, jobId) {
  let raw;
  try { raw = await fs.readFile(ledger(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let latest = null;
  for (const line of raw.split('\n').filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event?.patch?.jobs?.some(job => job?.id === jobId)) continue;
    latest = typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? event.at : null;
  }
  return latest;
}

// Records the interrupted segment so a same-attempt recovery can bound the time
// it already consumed. The segment ends at the job's last persisted event when the
// ledger has one after the segment start; otherwise at the detection time, which
// also counts the time the executor was down.
function interruptedSegment(job, detectedAt, lastEventAt) {
  const resumed = job.livenessResume?.phase === 'consumed' && job.livenessResume.attempt === job.attempts;
  const startedAt = resumed ? job.livenessResume.consumedAt : job.startedAt;
  const bounded = lastEventAt && Date.parse(lastEventAt) >= Date.parse(startedAt) && Date.parse(lastEventAt) <= Date.parse(detectedAt);
  const finishedAt = bounded ? lastEventAt : detectedAt;
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return [];
  return [{ attempt: job.attempts, startedAt, finishedAt, elapsedMs, outcome: 'needs_attention', error: 'interrupted',
    finishedAtSource: bounded ? 'last_persisted_event' : 'detection', ...(resumed ? { recoveryId: job.livenessResume.id } : {}) }];
}

export async function recoverRunning(root, state, business) {
  const finishedAt = stamp();
  const running = state.jobs.filter(j => j.state === 'running' && (!business || j.business === business));
  const lastEvents = new Map(await Promise.all(running.map(async j => [j.id, await lastPersistedEventAt(root, j.id)])));
  const jobs = running.map(j => ({
    ...j,
    state: 'needs_attention',
    attemptHistory: [...(j.attemptHistory ?? []), ...interruptedSegment(j, finishedAt, lastEvents.get(j.id))],
    ...(j.workflow ? {
      workflow: {
        ...j.workflow,
        status: 'needs_attention',
        steps: (j.workflow.steps ?? []).map(step => step.status === 'running'
          ? { ...step, status: 'blocked', error: 'interrupted', updatedAt: stamp() }
          : step),
        updatedAt: stamp(),
      },
    } : {}),
    orphanRisk: true,
    error: { code: 'interrupted', message: 'Ejecución interrumpida: comprueba el dispatch guardado antes de reanudar.' },
    finishedAt,
  }));
  if (jobs.length) await commit(root, state, 'interrupted_jobs_recovered', { jobs });
}

// The panel and CLI share this recovery path; a busy or uncertain lock is never displaced.
export async function recoverDashboardQueue(root, { business } = {}) {
  try {
    return await withExecutors(root, business, withState => withState(async state => {
      await recoverRunning(root, state, business);
      return { available: true };
    }));
  } catch (error) {
    if (['locked', 'lock_uncertain'].includes(error.code)) return { available: false, reason: error.message };
    throw error;
  }
}

export async function runQueue(root, { execute = false, worker, now, clock = Date.now, maxJobs = 5, jobId, business, beforeStart } = {}) {
  root = path.resolve(root);
  if (typeof clock !== 'function') throw new QueueError('clock debe ser una función.');
  if (business !== undefined && !QUEUE_BUSINESSES.includes(business)) throw new QueueError('Empresa inválida.');
  const inLane = job => !business || job.business === business;
  const eligibleAt = now ?? clock();
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20) throw new QueueError('maxJobs debe estar entre 1 y 20.');
  if (!execute) {
    const state = await loadState(root);
    return { dryRun: true, jobs: state.jobs.filter(inLane).filter(j => (!jobId || j.id === jobId) && (j.state === 'queued' || (j.state === 'retry_wait' && Date.parse(j.nextAttemptAt) <= eligibleAt))).slice(0, jobId ? 1 : maxJobs), budget: state.budget };
  }
  if (typeof worker !== 'function') throw new QueueError('Falta el ejecutor.');
  return withExecutors(root, business, async (withState, lock) => {
    const initial = await withState(async state => {
      await recoverRunning(root, state, business);
      return state;
    });
    const interrupted = initial.jobs.filter(inLane).filter(j => j.state === 'needs_attention');
    if (interrupted.length) return { dryRun: false, jobs: [], blockedNeedsAttention: interrupted.map(j => j.id), budget: initial.budget };
    const eligible = j => inLane(j) && (!jobId || j.id === jobId)
      && (j.state === 'queued' || j.state === 'retry_wait' && Date.parse(j.nextAttemptAt) <= eligibleAt);
    const selected = initial.jobs.filter(eligible).slice(0, jobId ? 1 : maxJobs);
    const results = [];
    for (const candidate of selected) {
      const admitted = await withState(async state => {
        const selectedJob = state.jobs.find(item => item.id === candidate.id);
        if (!selectedJob || !eligible(selectedJob) || state.jobs.some(item => inLane(item) && item.state === 'needs_attention')) return null;
        // Older manual runs may have left a live worker without a checkout file.
        if (business && selectedJob.kind === 'code' && state.jobs.some(item => item.id !== selectedJob.id
          && item.kind === 'code' && item.workspace && path.relative(item.workspace, selectedJob.workspace) === ''
          && (item.state === 'running' || item.state === 'needs_attention' && item.orphanRisk))) {
          throw new QueueError('El checkout está asignado a otra ejecución activa o sin cierre confirmado.', 'checkout_locked');
        }
        const sameAttempt = selectedJob.livenessResume?.phase === 'ready';
        const revisedContract = selectedJob.contractRevision?.phase === 'ready';
        if (revisedContract) assertContractRevisionCheckpoint(selectedJob, selectedJob.contractRevision);
        if (sameAttempt) assertLivenessResume(selectedJob, selectedJob.livenessResume);
        else if (selectedJob.attempts >= selectedJob.maxAttempts) throw new QueueError('Se alcanzó el máximo de intentos.', 'attempt_limit');
        // Auto-run admission runs under the existing exclusive queue lock.
        // A declined admission never changes the job or consumes an attempt.
        const admission = beforeStart ? await beforeStart(selectedJob) : {};
        if (admission === false) return null;
        if (revisedContract ? admission?.contractRevisionId !== selectedJob.contractRevision.id || admission?.contractRevision?.phase !== 'consumed'
          || admission.contractRevision.id !== selectedJob.contractRevision.id : admission?.contractRevisionId) {
          throw new QueueError('El recibo no consumió la rectificación exacta antes del nuevo intento.', 'contract_revision_unadmitted');
        }
        if (sameAttempt ? admission?.sameAttemptRecoveryId !== selectedJob.livenessResume.id : admission?.sameAttemptRecoveryId) {
          throw new QueueError('El recibo no consumió el marcador exacto de reanudación.', 'liveness_resume_unadmitted');
        }
        const stoppedRecoveryId = selectedJob.workflow?.steps?.find(step => step.key === 'developer' && step.status === 'queued' && step.retryOf?.dispatchStatus === 'stopped')?.retryOf.recoveryId;
        if (stoppedRecoveryId !== admission?.stoppedDeveloperRecoveryId) {
          throw new QueueError('El recibo no autorizó el reintento de Desarrollo detenido.', 'stopped_developer_retry_unadmitted');
        }
        const { sameAttemptRecoveryId, contractRevisionId, ...admittedFields } = admission || {};
        const segmentStartedAt = stamp();
        const timeoutMs = executionTimeoutMs(selectedJob);
        const remainingTimeoutMs = timeoutMs === null ? null : timeoutMs - (sameAttempt ? elapsedAttemptMs(selectedJob) : 0);
        const job = { ...selectedJob, ...admittedFields, state: 'running', attempts: selectedJob.attempts + (sameAttempt ? 0 : 1), startedAt: sameAttempt ? selectedJob.startedAt : segmentStartedAt, error: null,
          ...(sameAttempt ? { livenessResume: { ...selectedJob.livenessResume, phase: 'consumed', consumedAt: segmentStartedAt } } : {}) };
        const attemptStarted = Date.now();
        await commit(root, state, 'job_started', { jobs: [job] }, { jobId: job.id, attempt: job.attempts });
        return { job, sameAttempt, sameAttemptRecoveryId, segmentStartedAt, remainingTimeoutMs, attemptStarted, budget: state.budget };
      });
      if (!admitted) break;
      let { job, budget } = admitted;
      const { sameAttempt, sameAttemptRecoveryId, segmentStartedAt, remainingTimeoutMs, attemptStarted } = admitted;
      let active = true;
      let cleanup = async () => {};
      const controller = new AbortController();
      let operations = Promise.resolve(), persistenceFailure;
      const operation = action => {
        const pending = operations.then(() => withState(async state => {
          if (!active) throw new QueueError('Intento ya cerrado.', 'attempt_closed');
          try {
            await action(state);
            budget = state.budget;
          } catch (error) {
            await commitChains.get(state)?.catch(failure => { persistenceFailure = failure; });
            throw error;
          }
        }));
        // Expected validation errors need not poison later independent operations.
        operations = pending.catch(() => {});
        return pending;
      };
      const ctx = {
        root,
        signal: controller.signal,
        registerCleanup: fn => { if (!active) throw new QueueError('Intento ya cerrado.', 'attempt_closed'); cleanup = fn; },
        budget: () => ({ ...budget }),
        reserve: amount => operation(async state => {
          const current = state.jobs.find(j => j.id === job.id);
          if (!Number.isFinite(amount) || amount <= 0 || (current.estimatedUsd ?? 0) + current.reservedUsd + amount > job.maxUsd + 1e-9 || state.budget.estimatedSpentUsd + state.budget.reservedUsd + amount > state.budget.limitUsd + 1e-9) throw new QueueError('El límite local de presupuesto impide esta llamada.', 'budget_limit');
          job = { ...current, reservedUsd: current.reservedUsd + amount };
          await commit(root, state, 'budget_reserved', { jobs: [job], budget: { ...state.budget, reservedUsd: state.budget.reservedUsd + amount } }, { jobId: job.id, estimatedUsd: amount });
        }),
        settle: (estimatedUsd, { uncertain = false } = {}) => operation(async state => {
          const current = state.jobs.find(j => j.id === job.id);
          const reserved = current.reservedUsd;
          const charged = uncertain ? reserved : Math.max(0, Number(estimatedUsd) || 0);
          job = { ...current, reservedUsd: 0, estimatedUsd: (current.estimatedUsd ?? 0) + charged, costUncertain: uncertain };
          await commit(root, state, 'budget_settled', { jobs: [job], budget: { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - reserved), estimatedSpentUsd: state.budget.estimatedSpentUsd + charged } }, { jobId: job.id, estimatedUsd: charged, uncertain });
        }),
        reportStage: update => operation(async state => {
          if (!update?.key || !['queued', 'running', 'succeeded', 'blocked', 'failed', 'skipped'].includes(update.status)) throw new QueueError('Estado de etapa de flujo no válido.');
          const current = state.jobs.find(j => j.id === job.id);
          const stages = current.kind === 'analysis' ? ANALYSIS_STAGE : WORKFLOW_STAGES.map(stage => ({ ...stage, profile: `${stage.profile}_${current.business}` }));
          const workflow = current.workflow ?? { version: 1, name: current.kind === 'analysis' ? 'analysis-v1' : 'ui-quality-v1', status: 'running', currentStage: null, steps: stages.map(stage => ({ ...stage, status: 'queued' })) };
          const index = workflow.steps.findIndex(step => step.key === update.key);
          if (index < 0) throw new QueueError('La etapa no pertenece al flujo configurado.');
          const prior = workflow.steps[index];
          if (update.attempt !== undefined && update.attempt !== current.attempts) throw new QueueError('Actualización de otro intento.', 'stage_attempt_mismatch');
          if (update.runId && workflow.runId && update.runId !== workflow.runId) throw new QueueError('La etapa pertenece a otra Run.', 'stage_identity_mismatch');
          for (const key of ['dispatchId', 'taskId']) {
            if (update[key] && prior[key] && update[key] !== prior[key]) throw new QueueError('La identidad de etapa cambió sin un reintento registrado.', 'stage_identity_mismatch');
          }
          const transitions = {
            queued: ['queued', 'running', 'succeeded', 'blocked', 'failed', 'skipped'],
            running: ['running', 'succeeded', 'blocked', 'failed'],
            succeeded: ['succeeded', 'blocked'],
            blocked: ['blocked', 'running', 'failed'],
            failed: ['failed', 'running', 'blocked'],
            skipped: ['skipped'],
          };
          if (!transitions[prior.status]?.includes(update.status)) throw new QueueError('Transición de etapa no permitida.', 'stage_transition_invalid');
          if (['running', 'succeeded'].includes(update.status) && workflow.steps.slice(0, index).some(step => step.status !== 'succeeded')) {
            throw new QueueError('Faltan etapas previas aprobadas.', 'stage_dependencies_unmet');
          }
          if (update.delivery) validateDelivery(update.delivery, {
            jobId: current.id, stage: update.key, jobAttempt: update.taskInputAttempt ?? prior.taskInputAttempt ?? current.attempts,
            runId: update.runId ?? workflow.runId, dispatchId: update.dispatchId ?? prior.dispatchId, taskId: update.taskId ?? prior.taskId,
            acceptance: current.contract?.acceptance,
          });
          if ((update.deliveryVersion === 1 || prior.deliveryVersion === 1) && update.status === 'succeeded' && !update.delivery) {
            throw new QueueError('No se puede completar una etapa sin su entrega estructurada.', 'stage_delivery_missing');
          }
          const steps = [...workflow.steps];
          steps[index] = { ...steps[index], ...update, updatedAt: stamp() };
          if (!Object.hasOwn(update, 'error') && ['queued', 'running', 'succeeded'].includes(update.status)) delete steps[index].error;
          delete steps[index].key;
          steps[index].key = update.key;
          const workflowStatus = ['blocked', 'failed'].includes(update.status)
            ? 'needs_attention'
            : update.status === 'skipped' ? workflow.status : 'running';
          job = { ...current, workflow: { ...workflow, ...(update.runId ? { runId: update.runId } : {}), status: workflowStatus, currentStage: ['succeeded', 'skipped'].includes(update.status) ? workflow.currentStage : update.key, updatedAt: stamp(), steps } };
          await commit(root, state, 'job_stage_updated', { jobs: [job] }, { jobId: job.id, stage: update.key, status: update.status });
        })
      };
      let timer;
      let timeoutCleanup = Promise.resolve();
      try {
        const timedOut = remainingTimeoutMs === null ? null : new Promise((_, reject) => {
          timer = setTimeout(async () => {
            active = false;
            const error = new QueueError('Se agotó el tiempo; la ejecución puede haber tenido efectos.', 'timeout');
            error.uncertain = true;
            error.safeMessage = error.message;
            timeoutCleanup = (async () => {
              controller.abort(error);
              let cleanupTimer;
              try {
                await Promise.race([cleanup(), new Promise((_, fail) => { cleanupTimer = setTimeout(() => fail(new Error('cleanup_timeout')), 10_000); })]);
              } catch {
                lock.retain = true;
                await fs.writeFile(lock.path, JSON.stringify({ pid: process.pid, token: lock.token, unsafe: true, at: stamp() })).catch(() => {});
              } finally { clearTimeout(cleanupTimer); }
            })();
            await timeoutCleanup;
            reject(error);
          }, remainingTimeoutMs);
        });
        const output = timedOut ? await Promise.race([worker(job, ctx), timedOut]) : await worker(job, ctx);
        if (controller.signal.aborted) throw controller.signal.reason;
        clearTimeout(timer);
        active = false;
        await operations;
        if (persistenceFailure) throw persistenceFailure;
        if (output?.delivery && (output.delivery.outcome !== 'completed' || output.delivery.scope !== 'complete')) {
          const incomplete = new QueueError('La entrega no completa el alcance acordado.', 'delivery_incomplete');
          incomplete.partialResult = output;
          throw incomplete;
        }
        await withState(async state => {
          await commitChains.get(state);
          const current = state.jobs.find(j => j.id === job.id);
          job = { ...current, state: 'succeeded', finishedAt: stamp(), result: output,
            attemptHistory: [...(current.attemptHistory ?? []), { attempt: current.attempts, startedAt: segmentStartedAt, finishedAt: stamp(), elapsedMs: Date.now() - attemptStarted, outcome: 'succeeded', ...(sameAttempt ? { recoveryId: sameAttemptRecoveryId } : {}), promptChars: current.prompt.length, metrics: output?.metrics ?? null }],
            ...(current.workflow ? { workflow: { ...current.workflow, status: 'succeeded', currentStage: null, completedAt: stamp(), updatedAt: stamp() } } : {}) };
          await commit(root, state, 'job_succeeded', { jobs: [job] }, { jobId: job.id });
        }).catch(error => { persistenceFailure = error; throw error; });
      } catch (error) {
        clearTimeout(timer);
        await timeoutCleanup;
        active = false;
        await operations;
        if (persistenceFailure) throw persistenceFailure;
        await withState(async state => {
          await commitChains.get(state);
          job = state.jobs.find(j => j.id === job.id);
          if (job.reservedUsd > 0) {
            const amount = job.reservedUsd;
            job = { ...job, reservedUsd: 0, costUncertain: true, estimatedUsd: (job.estimatedUsd ?? 0) + amount };
            await commit(root, state, 'uncertain_cost_retained', { jobs: [job], budget: { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - amount), estimatedSpentUsd: state.budget.estimatedSpentUsd + amount } }, { jobId: job.id, estimatedUsd: amount });
          }
          // Automatic retries are only permitted for errors known to have rejected work.
          const retry = error.retryable === true && error.uncertain !== true && job.attempts < job.maxAttempts;
          job = { ...job, state: retry ? 'retry_wait' : 'needs_attention', finishedAt: stamp(), nextAttemptAt: retry ? new Date(clock() + Math.min(300_000, 30_000 * 2 ** (job.attempts - 1))).toISOString() : null,
            error: { code: error.code || 'worker_error', message: error.safeMessage || 'El ejecutor falló; revisa el trabajo y su resultado antes de continuar.', ...boundedErrorDetails(error.details) } };
          job = { ...job, ...(error.partialResult ? { result: error.partialResult } : {}),
            attemptHistory: [...(job.attemptHistory ?? []), { attempt: job.attempts, startedAt: segmentStartedAt, finishedAt: job.finishedAt, elapsedMs: Date.now() - attemptStarted, outcome: job.state, ...(sameAttempt ? { recoveryId: sameAttemptRecoveryId } : {}), promptChars: job.prompt.length, error: job.error.code,
              metrics: error.metrics ?? error.partialResult?.metrics ?? (job.workflow?.steps ?? []).filter(step => step.attempt === job.attempts && step.metrics).map(step => step.metrics).sort((a, b) => (b.orcaCliCalls ?? 0) - (a.orcaCliCalls ?? 0))[0] ?? null }],
          };
          await commit(root, state, retry ? 'retry_scheduled' : 'operator_required', { jobs: [job] }, { jobId: job.id, code: job.error.code });
        });
      } finally { active = false; clearTimeout(timer); }
      results.push(job);
      if (lock.retain || job.state === 'needs_attention') break;
    }
    return withState(state => ({ dryRun: false, jobs: results, budget: state.budget }));
  });
}

export function summarize(state) {
  return { revision: state.revision, budget: state.budget, counts: Object.fromEntries(['queued', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'cancelled'].map(s => [s, state.jobs.filter(j => j.state === s).length])), jobs: state.jobs.map(({ id, business, kind, title, state, attempts, maxAttempts, nextAttemptAt, error, workflow }) => ({ id, business, kind, title, state, attempts, maxAttempts, nextAttemptAt, error, workflow })), active: state.jobs.filter(j => ACTIVE.has(j.state)).length };
}
