import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { addJob, loadState, runQueue, recoverDashboardQueue, retryJob, validateSpec } from './queue.mjs';
import { verifyGitHubDestination } from './project-destination.mjs';

const location = root => path.join(path.resolve(root), 'data', 'auto-run.json');
const empty = () => ({ schema: 1, businesses: { agency: false, games: false }, receipts: [], history: [], integrations: {} });
const hooks = new Map();
const changes = new Map();
const now = () => new Date().toISOString();
const businessCheck = business => { if (!['agency', 'games'].includes(business)) throw new Error('Empresa inválida.'); };
export async function readAutoRun(root) {
  try {
    const value = JSON.parse(await fs.readFile(location(root), 'utf8'));
    if (value.schema !== 1 || !Array.isArray(value.receipts) || !Array.isArray(value.history)) throw new Error('Registro de autoejecución inválido; requiere revisión.');
    return { ...value, integrations: value.integrations || {}, businesses: { agency: value.businesses?.agency === true, games: value.businesses?.games === true } };
  } catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}

export async function persistIntegration(root, record) {
  if (!record?.receiptId || !record?.jobId) throw new Error('Registro de integración sin recibo/job.');
  return change(root, state => {
    const receipt = state.receipts.find(item => item.id === record.receiptId);
    if (!receipt || receipt.jobId !== record.jobId || receipt.eligible !== true) throw new Error('Recibo no elegible para persistir integración.');
    state.integrations ||= {};
    state.integrations[record.receiptId] = { ...state.integrations[record.receiptId], ...record };
    audit(state, 'github_integration', { receiptId: record.receiptId, jobId: record.jobId, phase: record.phase });
    return state.integrations[record.receiptId];
  });
}
export async function readIntegration(root, receiptId) {
  return (await readAutoRun(root)).integrations?.[receiptId] || null;
}

// Separate short lock: pausing and confirming remain possible while runQueue
// owns runner.lock for a long-lived Orca dispatch. Stale locks fail closed.
function change(root, action) {
  const key = path.resolve(root);
  const pending = (changes.get(key) || Promise.resolve()).then(() => writeChange(key, action));
  changes.set(key, pending.catch(() => {}));
  return pending;
}
async function writeChange(root, action) {
  const file = location(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let lock;
  try { lock = await fs.open(`${file}.lock`, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Registro de autoejecución ocupado o interrumpido; consulta y revisa antes de repetir.'); throw error; }
  let temporary;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: now() })); await lock.sync();
    const state = await readAutoRun(root);
    const result = await action(state);
    temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(state, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    // Windows may briefly refuse replacement while a reader/AV holds a handle.
    // Retry only this local atomic rename, never admission or external dispatch.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    return result;
  } finally {
    if (temporary) await fs.rm(temporary, { force: true });
    await lock.close(); await fs.unlink(`${file}.lock`);
  }
}
function audit(state, type, detail) { state.history.push({ at: now(), type, ...detail }); }
export async function setAutoRun(root, business, enabled, { confirm = false } = {}) {
  businessCheck(business);
  if (!confirm || typeof enabled !== 'boolean') throw new Error('Confirma explícitamente activar o pausar esta empresa.');
  return change(root, state => {
    state.businesses[business] = enabled;
    audit(state, 'setting_changed', { business, enabled });
    return { business, enabled };
  });
}

// This receipt is the confirmation boundary. It is fsynced BEFORE enqueue and
// includes the immutable brief and the setting observed at that moment.
export async function confirmSubmission(root, receiptId, spec) {
  validateSpec(spec);
  businessCheck(spec.business);
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(receiptId || '')) throw new Error('Falta el identificador estable del envío; conserva el mismo al reintentar.');
  if (spec.provider && spec.provider !== 'orca') throw new Error('El panel utiliza exclusivamente el pipeline Orca.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ ...spec, destination: spec.destination ? { checkout: spec.destination.checkout, workspace: spec.destination.workspace, branch: spec.destination.branch, baseBranch: spec.destination.baseBranch, repository: spec.destination.repository } : null })).digest('hex');
  const receipt = await change(root, state => {
    const previous = state.receipts.find(item => item.id === receiptId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Este recibo pertenece a otro encargo; consulta el envío original.');
      return previous;
    }
    const item = { id: receiptId, jobId: spec.id || `send-${createHash('sha256').update(receiptId).digest('hex').slice(0, 32)}`, business: spec.business, eligible: state.businesses[spec.business] === true, status: 'pending', confirmedAt: now(), fingerprint, spec: { ...spec, provider: 'orca' } };
    state.receipts.push(item); audit(state, 'submission_confirmed', { receiptId, jobId: item.jobId, business: item.business, eligible: item.eligible });
    return item;
  });
  let job;
  try { job = await materialize(root, receipt); }
  finally { hooks.get(path.resolve(root))?.(); }
  return { receipt, job };
}

async function materialize(root, receipt) {
  const existing = (await loadState(root)).jobs.find(job => job.id === receipt.jobId);
  if (existing) {
    if (existing.autoIntent?.receiptId !== receipt.id) throw new Error('Job ID ocupado por otro envío; revisión necesaria.');
    return existing;
  }
  if (receipt.status !== 'pending') throw new Error('Recibo ya admitido sin job recuperable; no se vuelve a encolar. Requiere revisión.');
  try {
    return await addJob(root, { ...receipt.spec, id: receipt.jobId, autoIntent: { receiptId: receipt.id, eligible: receipt.eligible, confirmedAt: receipt.confirmedAt } });
  } catch (error) {
    if (['locked', 'lock_uncertain'].includes(error.code)) return null;
    if (error.code === 'duplicate') {
      const found = (await loadState(root)).jobs.find(job => job.id === receipt.jobId);
      if (found?.autoIntent?.receiptId === receipt.id) return found;
    }
    throw error;
  }
}

export function createAutoRunner(root, { worker, run = runQueue, verify = verifyGitHubDestination, intervalMs = 1500 } = {}) {
  root = path.resolve(root);
  let busy = false, stopped = false, timer;
  const update = (id, status, detail = {}) => change(root, state => {
    const receipt = state.receipts.find(item => item.id === id);
    Object.assign(receipt, { status, updatedAt: now(), ...detail });
    audit(state, status, { receiptId: id, jobId: receipt.jobId, ...detail });
  });
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const executor = await recoverDashboardQueue(root);
      if (!executor.available) return;
      let queue = await loadState(root);
      const saved = await readAutoRun(root);
      // Never repeat a claimed/started submission, even when no dispatch receipt
      // was returned: transport uncertainty is not evidence of non-execution.
      for (const receipt of saved.receipts) {
        const job = queue.jobs.find(item => item.id === receipt.jobId);
        const reviewedRetry = job?.state === 'queued' && receipt.retryAuthorizedAttempt === job.attempts;
        if (receipt.status === 'claimed' || (receipt.status === 'pending' && job?.attempts > 0 && !reviewedRetry)) {
          await update(receipt.id, job?.state === 'succeeded' ? 'completed' : 'needs_attention', { reason: 'Intento previo o despacho incierto; consulta Orca y revisa efectos antes de decidir.' });
        }
      }
      let state = await readAutoRun(root);
      if (state.receipts.some(item => ['needs_attention', 'blocked', 'retrying'].includes(item.status)) || queue.jobs.some(job => ['needs_attention', 'running'].includes(job.state))) return;
      // Recover confirmed outbox entries, including manual ones, without ever
      // promoting their original eligibility when settings change.
      for (const receipt of state.receipts.filter(item => item.status === 'pending')) {
        const existing = queue.jobs.find(job => job.id === receipt.jobId);
        if (existing?.autoIntent?.receiptId === receipt.id) continue;
        try { await materialize(root, receipt); }
        catch (error) { await update(receipt.id, 'blocked', { reason: `No se pudo recuperar el envío: ${error.message}` }); return; }
      }
      queue = await loadState(root);
      state = await readAutoRun(root);
      try { await fs.access(path.join(root, 'data', 'PAUSE')); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const receipt = state.receipts.find(item => item.status === 'pending' && item.eligible && state.businesses[item.business] && queue.jobs.some(job => job.id === item.jobId && job.state === 'queued' && (job.attempts === 0 || item.retryAuthorizedAttempt === job.attempts)));
      if (!receipt) return;
      let checkoutLock, lockPath, admitted = false, uncertain = false;
      try {
        const result = await run(root, { execute: true, maxJobs: 1, jobId: receipt.jobId, worker,
          beforeStart: async job => {
            const reviewedRetry = job.attempts > 0 && receipt.retryAuthorizedAttempt === job.attempts;
            if (job.id !== receipt.jobId || (job.attempts !== 0 && !reviewedRetry) || job.autoIntent?.receiptId !== receipt.id || !job.autoIntent.eligible) throw new Error('El recibo y el job no coinciden; requiere revisión.');
            let destination = job.destination;
            let admittedJob = job;
            if (job.kind === 'code') {
              const receiptSpec = (await readAutoRun(root)).receipts.find(item => item.id === receipt.id)?.spec;
              if (!destination?.baseBranch && receiptSpec?.id === job.id && receiptSpec?.destination?.baseBranch) {
                destination = { ...destination, baseBranch: receiptSpec.destination.baseBranch };
              }
              if (destination?.workspace !== job.workspace || destination?.branch !== job.branch || !destination?.baseBranch) throw new Error('Destino sin coincidencia exacta con el recibo confirmado; requiere revisión.');
              admittedJob = { ...job, destination };
              destination = await verify(root, admittedJob);
              lockPath = path.join(destination.workspace, '.git', 'centro-executor.lock');
              try { checkoutLock = await fs.open(lockPath, 'wx'); }
              catch (error) { throw new Error(`Checkout ocupado o bloqueo pendiente; revisa ${lockPath}. ${error.code}`); }
              await checkoutLock.writeFile(JSON.stringify({ jobId: job.id, receiptId: receipt.id, pid: process.pid, at: now() })); await checkoutLock.sync();
            }
            // Recheck pause immediately at the durable admission boundary.
            return change(root, async current => {
              const entry = current.receipts.find(item => item.id === receipt.id);
              let paused = false;
              try { await fs.access(path.join(root, 'data', 'PAUSE')); paused = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
              if (!current.businesses[job.business] || paused || entry.status !== 'pending') return false;
              entry.status = 'claimed'; entry.claimedAt = now(); entry.destination = destination;
              audit(current, 'claimed', { receiptId: entry.id, jobId: job.id, destination });
              admitted = true;
              return { destination };
            });
          },
        });
        const job = result.jobs?.find(item => item.id === receipt.jobId);
        if (admitted) {
          uncertain = !job || job.state !== 'succeeded';
          await update(receipt.id, uncertain ? 'needs_attention' : 'completed', { reason: uncertain ? 'El intento no terminó aprobado; revisa job, etapa y dispatch, sin reintento automático.' : 'Entrega local completada; sin publicación.' });
        }
      } catch (error) {
        if (['locked', 'lock_uncertain'].includes(error.code) && !admitted) return;
        uncertain = admitted;
        await update(receipt.id, admitted ? 'needs_attention' : 'blocked', { reason: error.message });
      } finally {
        if (checkoutLock) { await checkoutLock.close(); if (!uncertain) await fs.unlink(lockPath); }
      }
    } finally { busy = false; }
  }
  function wake() { setImmediate(() => { void tick().catch(() => {}); }); }
  return {
    tick,
    start() { stopped = false; hooks.set(root, wake); timer = setInterval(wake, intervalMs); timer.unref(); wake(); },
    stop() { stopped = true; clearInterval(timer); hooks.delete(root); },
  };
}

export async function reviewAutoReceipt(root, id, { confirm = false } = {}) {
  if (!confirm) throw new Error('Confirma la revisión de efectos y dispatches.');
  return change(root, async state => {
    const receipt = state.receipts.find(item => item.id === id);
    if (!receipt || !['blocked', 'needs_attention'].includes(receipt.status)) throw new Error('El recibo no está pendiente de revisión.');
    const job = (await loadState(root)).jobs.find(item => item.id === receipt.jobId);
    if (job && ['running', 'needs_attention'].includes(job.state)) throw new Error('Revisa y resuelve primero el job mediante las acciones manuales.');
    receipt.status = 'reviewed'; receipt.reviewedAt = now();
    audit(state, 'reviewed', { receiptId: id, jobId: receipt.jobId });
    return receipt;
  });
}

// Reopen only a reviewed, pre-dispatch auto-run failure. The immutable receipt
// remains the source of destination truth; uncertain or started stages stay blocked.
export async function retryAutoReceipt(root, jobId, { confirm = false, noDispatchConfirmed = false } = {}) {
  if (!confirm || !noDispatchConfirmed) throw new Error('Confirma que consultaste Orca: no existe Run/dispatch para este intento y no hay agentes activos.');
  const candidate = await change(root, async state => {
    const receipt = state.receipts.find(item => item.jobId === jobId);
    const job = (await loadState(root)).jobs.find(item => item.id === jobId);
    const untouched = job?.workflow?.status === 'queued' && job.workflow.currentStage == null
      && job.workflow.steps?.every(step => step.status === 'queued' && !step.runId && !step.taskId && !step.dispatchId)
      && !job.result && job.attempts < job.maxAttempts;
    if (!receipt || receipt.status !== 'needs_attention' || !receipt.eligible
      || !job || job.state !== 'needs_attention' || job.autoIntent?.receiptId !== receipt.id
      || receipt.spec?.id !== job.id || receipt.spec?.workspace !== job.workspace
      || receipt.spec?.destination?.workspace !== job.workspace || receipt.spec?.destination?.branch !== job.branch || !untouched) {
      throw new Error('Este intento no es un fallo previo al dispatch verificable; consulta Orca y conserva el estado para revisión.');
    }
    receipt.status = 'retrying'; receipt.updatedAt = now();
    audit(state, 'retrying', { receiptId: receipt.id, jobId, reason: 'Reintento confirmado: workflow sin dispatch ni resultado.' });
    return { receiptId: receipt.id, workspace: job.workspace };
  });
  try {
    const workspacesRoot = path.resolve(root, 'workspaces');
    const workspace = path.resolve(candidate.workspace);
    const relative = path.relative(workspacesRoot, workspace);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Checkout fuera de workspaces; no se libera ningún bloqueo.');
    const lockPath = path.join(workspace, '.git', 'centro-executor.lock');
    try {
      const lockOwner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lockOwner.jobId !== jobId || lockOwner.receiptId !== candidate.receiptId) throw new Error('Bloqueo del checkout pertenece a otro trabajo; requiere revisión.');
      await fs.unlink(lockPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const job = await retryJob(root, jobId, { confirm: true });
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (!receipt || receipt.status !== 'retrying') throw new Error('El recibo cambió durante el reintento; requiere revisión.');
      receipt.status = 'pending'; receipt.retryAuthorizedAttempt = job.attempts; receipt.updatedAt = now();
      audit(state, 'retry_authorized', { receiptId: receipt.id, jobId, attempt: job.attempts });
    });
    return job;
  } catch (error) {
    await change(root, state => {
      const receipt = state.receipts.find(item => item.id === candidate.receiptId);
      if (receipt?.status === 'retrying') { receipt.status = 'needs_attention'; receipt.updatedAt = now(); audit(state, 'retry_blocked', { receiptId: receipt.id, jobId, reason: error.message }); }
    });
    throw error;
  }
}
