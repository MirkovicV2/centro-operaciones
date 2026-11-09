#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadState, runQueue } from './queue.mjs';
import { createWorker } from './providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
function stopError(reason) {
  return Object.assign(new Error('El vigilante solicitó detener la ejecución; revisa posibles efectos.'), {
    code: reason, safeMessage: 'Ejecución detenida por el vigilante; revisa posibles efectos antes de reintentar.', uncertain: true,
  });
}
async function paused(root) {
  try { await fs.access(path.join(root, 'data', 'PAUSE')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}
function validate({ hours, maxJobs, pollMs }) {
  if (!Number.isFinite(hours) || hours < 1 / 3600 || hours > 24) throw new Error('hours debe estar entre 1 segundo (0.000278 horas) y 24 horas.');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) throw new Error('max-jobs debe ser un entero entre 1 y 100.');
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error('pollMs debe estar entre 100 y 60000.');
}

/** Polls local state only. Dependencies make idle, pause and caps testable without AI or disk writes. */
export async function watch({ root = ROOT, execute = false, hours = 8, maxJobs = 10, pollMs = 5000, signal, onEvent = () => {} } = {}, injected = {}) {
  validate({ hours, maxJobs, pollMs });
  const dependencies = { loadState, runQueue, createWorker, paused, clock: Date.now, sleep, ...injected };
  root = path.resolve(root);
  const started = dependencies.clock();
  const duration = hours * 3600_000;
  const deadline = started + duration;
  const controller = new AbortController();
  let reason = 'time_limit';
  let attempts = 0;
  let worker;
  let lastStatus;
  const event = (type, extra = {}) => onEvent({ type, attempts, ...extra });
  const status = (type, extra = {}) => {
    const signature = JSON.stringify({ type, ...extra });
    if (signature !== lastStatus) { lastStatus = signature; event(type, extra); }
  };
  const stop = value => {
    reason = value;
    if (!controller.signal.aborted) controller.abort(stopError(value));
  };
  const externalStop = () => stop('signal');
  signal?.addEventListener('abort', externalStop, { once: true });
  if (signal?.aborted) externalStop();
  const timer = setTimeout(() => stop('time_limit'), duration);
  event('started', { execute: !!execute, hours, maxJobs, pid: process.pid });
  try {
    while (!controller.signal.aborted && attempts < maxJobs && dependencies.clock() < deadline) {
      if (await dependencies.paused(root)) status('paused');
      else {
        const state = await dependencies.loadState(root);
        // An interrupted native child may still exist: let the operator recover it explicitly.
        if (state.jobs.some(job => job.state === 'running' || (job.state === 'needs_attention' && job.orphanRisk))) {
          reason = 'needs_attention'; status('needs_attention'); break;
        }
        const ready = state.jobs.some(job => job.state === 'queued' || (job.state === 'retry_wait' && Date.parse(job.nextAttemptAt) <= dependencies.clock()));
        if (!ready) status('idle');
        else if (!execute) status('dry_run_ready');
        else if (!controller.signal.aborted && dependencies.clock() < deadline && !(await dependencies.paused(root))) {
          worker ??= dependencies.createWorker();
          let dispatched = false;
          const boundedWorker = async (job, ctx) => {
            // Queue lock is held here; count starts, including failed attempts and provider fallback.
            dispatched = true;
            attempts++;
            event('attempt_started', { jobId: job.id, business: job.business, kind: job.kind });
            if (controller.signal.aborted || dependencies.clock() >= deadline || await dependencies.paused(root)) throw stopError('watch_dispatch_stopped');
            const combined = new AbortController();
            const abortRun = () => combined.abort(controller.signal.reason);
            const abortJob = () => combined.abort(ctx.signal.reason);
            controller.signal.addEventListener('abort', abortRun, { once: true });
            ctx.signal.addEventListener('abort', abortJob, { once: true });
            if (controller.signal.aborted) abortRun();
            if (ctx.signal.aborted) abortJob();
            try { return await worker(job, { ...ctx, signal: combined.signal }); }
            finally {
              controller.signal.removeEventListener('abort', abortRun);
              ctx.signal.removeEventListener('abort', abortJob);
            }
          };
          try {
            const result = await dependencies.runQueue(root, { execute: true, maxJobs: 1, worker: boundedWorker });
            if (dispatched) event('attempt_finished', { state: result.jobs?.[0]?.state || 'unknown' });
            if (result.blockedNeedsAttention?.length || result.jobs?.some(job => job.state === 'needs_attention')) {
              if (!controller.signal.aborted) reason = 'needs_attention';
              break;
            }
          } catch (error) {
            if (error.code === 'locked') status('busy');
            else { reason = 'local_error'; event('local_error', { code: /^[a-z_]{1,40}$/.test(error.code || '') ? error.code : 'watch_error' }); break; }
          }
        }
      }
      if (attempts >= maxJobs) { reason = 'job_limit'; break; }
      if (!controller.signal.aborted) await dependencies.sleep(Math.max(0, Math.min(pollMs, deadline - dependencies.clock())), controller.signal);
    }
    if (attempts >= maxJobs && !controller.signal.aborted) reason = 'job_limit';
    const result = { reason, attempts, elapsedMs: Math.max(0, dependencies.clock() - started) };
    event('stopped', { reason });
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', externalStop); }
}

function parse(args) {
  const options = {};
  while (args.length) {
    const arg = args.shift();
    const key = arg === '--max-jobs' ? 'maxJobs' : arg.slice(2);
    if (!['--execute', '--help', '--hours', '--max-jobs'].includes(arg) || key in options) throw new Error('Opción desconocida o repetida. Usa --help.');
    if (arg === '--execute' || arg === '--help') options[key] = true;
    else { if (!args.length || args[0].startsWith('--')) throw new Error('Falta el valor de una opción.'); options[key] = Number(args.shift()); }
  }
  return options;
}
async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) {
    console.log('node watch.mjs [--execute] [--hours 8] [--max-jobs 10]\nSimulación por defecto. Consulta local cada 5 segundos; data/PAUSE impide nuevos trabajos.\nLímites: 1 segundo a 24 horas; 1 a 100 intentos. SIGINT/SIGTERM solicita parada segura.');
    return;
  }
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const result = await watch({ ...options, signal: shutdown.signal, onEvent: event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })) });
    if (['local_error', 'needs_attention'].includes(result.reason)) process.exitCode = 2;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('No se pudo iniciar el vigilante. Comprueba opciones con node watch.mjs --help.');
  process.exitCode = 1;
});
