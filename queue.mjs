import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_JOBS = 500;
const ACTIVE = new Set(['queued', 'running', 'retry_wait', 'needs_attention']);
export class QueueError extends Error {
  constructor(message, code = 'queue_error') { super(message); this.code = code; }
}
const emptyState = () => ({ schema: 1, revision: 0, jobs: [], budget: { limitUsd: 0, reservedUsd: 0, estimatedSpentUsd: 0, model: '', inputPerMillion: 0, outputPerMillion: 0 } });
const dir = root => path.join(root, 'data');
const ledger = root => path.join(dir(root), 'events.jsonl');
const stamp = () => new Date().toISOString();
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
  try { await fs.rename(temp, destination); } catch (e) { await fs.rm(temp, { force: true }); throw e; }
}

const commitChains = new WeakMap();
function commit(root, state, type, patch = {}, details = {}) {
  const pending = (commitChains.get(state) ?? Promise.resolve()).then(() => writeCommit(root, state, type, patch, details));
  commitChains.set(state, pending);
  return pending;
}
async function writeCommit(root, state, type, patch = {}, details = {}) {
  const event = { schema: 1, revision: state.revision + 1, at: stamp(), type, details, patch };
  const handle = await fs.open(ledger(root), 'a');
  try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
  applyEvent(state, event);
  // Ledger is authoritative if the process dies before snapshot replacement.
  await atomicSnapshot(root, state);
}

export async function acquireLock(root) {
  root = path.resolve(root);
  await fs.mkdir(dir(root), { recursive: true });
  const lockPath = path.join(dir(root), 'runner.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID();
    try {
      const h = await fs.open(lockPath, 'wx');
      try { await h.writeFile(JSON.stringify({ pid: process.pid, token, at: stamp() })); await h.sync(); } finally { await h.close(); }
      return { root, path: lockPath, token };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
      catch { throw new QueueError('Bloqueo incompleto: comprueba que no hay un ejecutor antes de revisarlo manualmente.', 'lock_uncertain'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token) throw new QueueError('Bloqueo inválido: revisión manual necesaria.', 'lock_uncertain');
      if (owner.unsafe) throw new QueueError('No se pudo confirmar la parada de un proceso anterior; revisa procesos y bloqueo manualmente.', 'lock_uncertain');
      if (alive(owner.pid)) throw new QueueError('Ya hay un ejecutor u otra operación de escritura en marcha.', 'locked');
      // Serialize reclamation: two stale-lock readers must never unlink a new owner's lock.
      const recoveryPath = path.join(dir(root), 'runner.recovery.lock');
      let recovery;
      try { recovery = await fs.open(recoveryPath, 'wx'); }
      catch (err) { if (err.code === 'EEXIST') throw new QueueError('Recuperación de bloqueo en marcha o interrumpida; requiere revisión.', 'lock_uncertain'); throw err; }
      try {
        await recovery.writeFile(JSON.stringify({ pid: process.pid, at: stamp() }));
        const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        if (current.token === owner.token && !alive(current.pid)) await fs.unlink(lockPath);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      finally { await recovery.close(); await fs.unlink(recoveryPath).catch(err => { if (err.code !== 'ENOENT') throw err; }); }
    }
  }
  throw new QueueError('No se pudo adquirir el bloqueo.', 'locked');
}

export async function releaseLock(lock) {
  if (lock.retain) return;
  try {
    const owner = JSON.parse(await fs.readFile(lock.path, 'utf8'));
    if (owner.token === lock.token) await fs.unlink(lock.path);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function mutate(root, action) {
  root = path.resolve(root);
  const lock = await acquireLock(root);
  try { return await action(await readLedger(root, true), lock); } finally { await releaseLock(lock); }
}

function validateSpec(spec) {
  if (!['games', 'agency'].includes(spec.business)) throw new QueueError('business debe ser games o agency.');
  if (!['analysis', 'code'].includes(spec.kind)) throw new QueueError('kind debe ser analysis o code.');
  if (!spec.title || spec.title.length > 160) throw new QueueError('El título debe tener entre 1 y 160 caracteres.');
  if (!spec.prompt || Buffer.byteLength(spec.prompt, 'utf8') > 12_000) throw new QueueError('La instrucción debe tener entre 1 y 12.000 bytes.');
  if (/\bsk-[A-Za-z0-9_-]{12,}/.test(spec.prompt + spec.title) || ['OPENAI_API_KEY', 'CODEX_API_KEY'].some(name => process.env[name] && (spec.prompt + spec.title).includes(process.env[name]))) throw new QueueError('No guardes claves en títulos o instrucciones; usa solo variables de entorno.');
  if (!Number.isInteger(spec.maxAttempts ?? 2) || (spec.maxAttempts ?? 2) < 1 || (spec.maxAttempts ?? 2) > 3) throw new QueueError('maxAttempts debe estar entre 1 y 3.');
  if (!Number.isInteger(spec.timeoutMs ?? 180_000) || (spec.timeoutMs ?? 180_000) < 10 || (spec.timeoutMs ?? 180_000) > 1_800_000) throw new QueueError('timeoutMs debe estar entre 10 y 1.800.000.');
  if (!Number.isFinite(spec.maxUsd ?? 0.1) || (spec.maxUsd ?? 0.1) <= 0) throw new QueueError('maxUsd debe ser positivo.');
  if (!['auto', 'codex', 'api'].includes(spec.provider ?? 'auto')) throw new QueueError('provider debe ser auto, api o codex.');
  if (spec.kind === 'code' && (!spec.workspace || !spec.isolated)) throw new QueueError('Los trabajos de código requieren workspace y confirmación isolated.');
}

export async function addJob(root, spec) {
  validateSpec(spec);
  return mutate(root, async state => {
    if (state.jobs.length >= MAX_JOBS) throw new QueueError('Cola limitada a 500 trabajos; archiva manualmente antes de ampliar.');
    const id = spec.id ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new QueueError('Identificador inválido.');
    if (state.jobs.some(job => job.id === id)) throw new QueueError('Este identificador ya existe; no se añadirá dos veces.', 'duplicate');
    const job = { id, business: spec.business, kind: spec.kind, title: spec.title, prompt: spec.prompt, provider: spec.kind === 'code' ? 'codex' : (spec.provider ?? 'auto'), workspace: spec.workspace ? path.resolve(spec.workspace) : null, isolated: !!spec.isolated, maxAttempts: spec.maxAttempts ?? 2, timeoutMs: spec.timeoutMs ?? 180_000, maxUsd: spec.maxUsd ?? 0.1, maxOutputTokens: 1024, attempts: 0, state: 'queued', createdAt: stamp(), reservedUsd: 0 };
    await commit(root, state, 'job_added', { jobs: [job] }, { jobId: id });
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

export async function retryJob(root, id, { confirm = false } = {}) {
  if (!confirm) throw new QueueError('Revisa los resultados/efectos previos y usa --confirm-reviewed para reintentar.');
  return mutate(root, async state => {
    const previous = state.jobs.find(j => j.id === id);
    if (!previous || previous.state !== 'needs_attention') throw new QueueError('Solo se pueden reabrir trabajos needs_attention.');
    if (previous.attempts >= previous.maxAttempts) throw new QueueError('Se alcanzó el máximo de intentos; crea otro trabajo con un identificador distinto.');
    const amount = previous.reservedUsd;
    const job = { ...previous, state: 'queued', error: null, nextAttemptAt: null, orphanRisk: false, reservedUsd: 0, estimatedUsd: (previous.estimatedUsd ?? 0) + amount, costUncertain: previous.costUncertain || amount > 0, reviewedAt: stamp() };
    const budget = { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - amount), estimatedSpentUsd: state.budget.estimatedSpentUsd + amount };
    await commit(root, state, 'operator_retry', { jobs: [job], budget }, { jobId: id });
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

export async function recoverRunning(root, state) {
  const jobs = state.jobs.filter(j => j.state === 'running').map(j => ({ ...j, state: 'needs_attention', orphanRisk: true, error: { code: 'interrupted', message: 'Ejecución interrumpida: comprueba que no quedan procesos activos y revisa resultados antes de continuar.' }, finishedAt: stamp() }));
  if (jobs.length) await commit(root, state, 'interrupted_jobs_recovered', { jobs });
}

export async function runQueue(root, { execute = false, worker, now, clock = Date.now, maxJobs = 5 } = {}) {
  root = path.resolve(root);
  if (typeof clock !== 'function') throw new QueueError('clock debe ser una función.');
  const eligibleAt = now ?? clock();
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 20) throw new QueueError('maxJobs debe estar entre 1 y 20.');
  if (!execute) {
    const state = await loadState(root);
    return { dryRun: true, jobs: state.jobs.filter(j => j.state === 'queued' || (j.state === 'retry_wait' && Date.parse(j.nextAttemptAt) <= eligibleAt)).slice(0, maxJobs), budget: state.budget };
  }
  if (typeof worker !== 'function') throw new QueueError('Falta el ejecutor.');
  return mutate(root, async (state, lock) => {
    await recoverRunning(root, state);
    const interrupted = state.jobs.filter(j => j.state === 'needs_attention' && j.orphanRisk);
    if (interrupted.length) return { dryRun: false, jobs: [], blockedNeedsAttention: interrupted.map(j => j.id), budget: state.budget };
    const selected = state.jobs.filter(j => j.state === 'queued' || (j.state === 'retry_wait' && Date.parse(j.nextAttemptAt) <= eligibleAt)).slice(0, maxJobs);
    const results = [];
    for (const selectedJob of selected) {
      let job = { ...selectedJob, state: 'running', attempts: selectedJob.attempts + 1, startedAt: stamp(), error: null };
      await commit(root, state, 'job_started', { jobs: [job] }, { jobId: job.id, attempt: job.attempts });
      let active = true;
      let cleanup = async () => {};
      const controller = new AbortController();
      let operations = Promise.resolve();
      const operation = action => {
        const pending = operations.then(() => {
          if (!active) throw new QueueError('Intento ya cerrado.', 'attempt_closed');
          return action();
        });
        // Expected validation errors need not poison later independent operations.
        // Persistence errors remain rejected in commitChains and fail the runner closed.
        operations = pending.catch(() => {});
        return pending;
      };
      const ctx = {
        root,
        signal: controller.signal,
        registerCleanup: fn => { if (!active) throw new QueueError('Intento ya cerrado.', 'attempt_closed'); cleanup = fn; },
        budget: () => ({ ...state.budget }),
        reserve: amount => operation(async () => {
          const current = state.jobs.find(j => j.id === job.id);
          if (!Number.isFinite(amount) || amount <= 0 || (current.estimatedUsd ?? 0) + current.reservedUsd + amount > job.maxUsd + 1e-9 || state.budget.estimatedSpentUsd + state.budget.reservedUsd + amount > state.budget.limitUsd + 1e-9) throw new QueueError('El límite local de presupuesto impide esta llamada.', 'budget_limit');
          job = { ...current, reservedUsd: current.reservedUsd + amount };
          await commit(root, state, 'budget_reserved', { jobs: [job], budget: { ...state.budget, reservedUsd: state.budget.reservedUsd + amount } }, { jobId: job.id, estimatedUsd: amount });
        }),
        settle: (estimatedUsd, { uncertain = false } = {}) => operation(async () => {
          const current = state.jobs.find(j => j.id === job.id);
          const reserved = current.reservedUsd;
          const charged = uncertain ? reserved : Math.max(0, Number(estimatedUsd) || 0);
          job = { ...current, reservedUsd: 0, estimatedUsd: (current.estimatedUsd ?? 0) + charged, costUncertain: uncertain };
          await commit(root, state, 'budget_settled', { jobs: [job], budget: { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - reserved), estimatedSpentUsd: state.budget.estimatedSpentUsd + charged } }, { jobId: job.id, estimatedUsd: charged, uncertain });
        })
      };
      let timer;
      let timeoutCleanup = Promise.resolve();
      try {
        const timedOut = new Promise((_, reject) => {
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
          }, job.timeoutMs);
        });
        const output = await Promise.race([worker(job, ctx), timedOut]);
        if (controller.signal.aborted) throw controller.signal.reason;
        clearTimeout(timer);
        active = false;
        await operations;
        await commitChains.get(state);
        job = { ...state.jobs.find(j => j.id === job.id), state: 'succeeded', finishedAt: stamp(), result: output };
        await commit(root, state, 'job_succeeded', { jobs: [job] }, { jobId: job.id });
      } catch (error) {
        clearTimeout(timer);
        await timeoutCleanup;
        active = false;
        await operations;
        await commitChains.get(state);
        job = state.jobs.find(j => j.id === job.id);
        if (job.reservedUsd > 0) {
          const amount = job.reservedUsd;
          job = { ...job, reservedUsd: 0, costUncertain: true, estimatedUsd: (job.estimatedUsd ?? 0) + amount };
          await commit(root, state, 'uncertain_cost_retained', { jobs: [job], budget: { ...state.budget, reservedUsd: Math.max(0, state.budget.reservedUsd - amount), estimatedSpentUsd: state.budget.estimatedSpentUsd + amount } }, { jobId: job.id, estimatedUsd: amount });
        }
        // Automatic retries are only permitted for errors known to have rejected work.
        const retry = error.retryable === true && error.uncertain !== true && job.attempts < job.maxAttempts;
        job = { ...job, state: retry ? 'retry_wait' : 'needs_attention', finishedAt: stamp(), nextAttemptAt: retry ? new Date(clock() + Math.min(300_000, 30_000 * 2 ** (job.attempts - 1))).toISOString() : null, error: { code: error.code || 'worker_error', message: error.safeMessage || 'El ejecutor falló; revisa el trabajo y su resultado antes de continuar.' } };
        await commit(root, state, retry ? 'retry_scheduled' : 'operator_required', { jobs: [job] }, { jobId: job.id, code: job.error.code });
      } finally { active = false; clearTimeout(timer); }
      results.push(job);
      if (lock.retain) break;
    }
    return { dryRun: false, jobs: results, budget: state.budget };
  });
}

export function summarize(state) {
  return { revision: state.revision, budget: state.budget, counts: Object.fromEntries(['queued', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'cancelled'].map(s => [s, state.jobs.filter(j => j.state === s).length])), jobs: state.jobs.map(({ id, business, kind, title, state, attempts, maxAttempts, nextAttemptAt, error }) => ({ id, business, kind, title, state, attempts, maxAttempts, nextAttemptAt, error })), active: state.jobs.filter(j => ACTIVE.has(j.state)).length };
}
