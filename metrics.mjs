import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const metricNames = ['orcaCliCalls', 'dispatchStarts', 'polls', 'modelCalls', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'completedTurns', 'measuredTurns'];
const terminalEvents = new Set(['job_succeeded', 'operator_required', 'retry_scheduled', 'interrupted_jobs_recovered']);
const validNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const counts = values => {
  const result = new Map();
  for (const value of values) { const key = String(value ?? 'unknown'); result.set(key, (result.get(key) || 0) + 1); }
  return Object.fromEntries(result);
};
const duration = (start, end) => {
  const elapsed = Date.parse(end) - Date.parse(start);
  return validNumber(elapsed);
};

function applyMeasurements(record, values, source, complete) {
  if (!values || typeof values !== 'object') return;
  for (const name of metricNames) {
    if (!Object.hasOwn(values, name)) continue;
    record.measurements[name] = { value: validNumber(values[name]), source, complete };
  }
}

function aggregateMeasurement(records, name) {
  const relevant = ['orcaCliCalls', 'dispatchStarts', 'polls'].includes(name)
    ? records.filter(record => record.provider === 'orca')
    : ['completedTurns', 'measuredTurns'].includes(name)
      ? records.filter(record => record.provider === 'codex' || record.resultProvider === 'codex-chatgpt')
      : records;
  const measured = relevant.filter(record => record.measurements[name]?.value !== null && record.measurements[name]?.value !== undefined);
  const complete = measured.filter(record => record.measurements[name].complete);
  const observed = measured.reduce((sum, record) => sum + record.measurements[name].value, 0);
  const observedTotal = measured.length && Number.isSafeInteger(observed) ? observed : null;
  return {
    total: relevant.length && complete.length === relevant.length ? observedTotal : null,
    observedTotal,
    measuredAttempts: measured.length,
    completeAttempts: complete.length,
    eligibleAttempts: relevant.length,
  };
}

/** Aggregate recorded evidence. Never derives tokens from text or interprets success as quality. */
// What the split of the pipeline produced, from what each stage recorded: launches per role and per
// agent/model, how they ended, and the signals a change of split should be judged by (returns to Desarrollo,
// defects found, substitutions, people's interventions, time to acceptance). Counts only; nothing is estimated.
export function pipelineMetrics(jobs = []) {
  const launches = new Map(), seen = new Set();
  const tally = (job, step, current) => {
    if (!step.launch?.agent || !step.dispatchId || seen.has(step.dispatchId)) return;
    seen.add(step.dispatchId);
    const key = JSON.stringify([step.key, step.launch.agent, step.launch.model ?? null, step.launch.effort ?? null]);
    if (!launches.has(key)) launches.set(key, { stage: step.key, agent: step.launch.agent, model: step.launch.model ?? null, effort: step.launch.effort ?? null, launched: 0, succeeded: 0, blocked: 0, failed: 0, other: 0, substituted: 0 });
    const record = launches.get(key);
    record.launched++; record[['succeeded', 'blocked', 'failed'].includes(step.status) ? step.status : 'other']++;
    if (step.launch.substitutedFrom) record.substituted++;
  };
  let corrections = 0, findings = 0, humanAnswers = 0, quotaStops = 0;
  const acceptance = [];
  for (const job of jobs) {
    for (const workflow of job.workflowHistory ?? []) for (const step of workflow.steps ?? []) tally(job, step, false);
    for (const step of job.workflow?.steps ?? []) { tally(job, step, true); findings += (step.delivery?.findings ?? []).filter(item => item.severity === 'blocking').length; }
    corrections += (job.livenessRecoveryHistory ?? []).filter(item => item.qualityAction?.type === 'correction').length;
    humanAnswers += (job.qualityAnswers?.length ?? 0) + (job.continuation?.decisions?.length ?? 0);
    quotaStops += (job.attemptHistory ?? []).filter(item => ['provider_quota_wait', 'provider_quota_exhausted'].includes(item.error)).length;
    const elapsed = job.state === 'succeeded' ? Date.parse(job.finishedAt) - Date.parse(job.createdAt) : NaN;
    if (Number.isFinite(elapsed) && elapsed >= 0) acceptance.push(elapsed);
  }
  acceptance.sort((a, b) => a - b);
  return { stages: [...launches.values()].sort((a, b) => a.stage.localeCompare(b.stage) || a.agent.localeCompare(b.agent)),
    returnsToDevelopment: corrections, blockingFindings: findings, humanAnswers, quotaStops,
    timeToAcceptanceMs: { jobs: acceptance.length, median: acceptance.length ? acceptance[Math.floor((acceptance.length - 1) / 2)] : null, max: acceptance.at(-1) ?? null } };
}

export function aggregateMetrics({ events = [], state = { jobs: [], revision: 0 }, source = {} } = {}) {
  const records = new Map(), dispatches = new Set(), messages = new Set();
  const attemptFor = (job, attempt = job.attempts, origin = 'ledger') => {
    if (typeof job.id !== 'string' || !Number.isInteger(attempt) || attempt < 1) return null;
    const key = JSON.stringify([job.id, attempt]);
    if (!records.has(key)) records.set(key, {
      jobId: job.id, attempt, provider: job.provider || 'unknown', business: job.business || 'unknown', origin,
      startedAt: null, finishedAt: null, elapsedMs: null, timingSource: null, outcome: 'unknown', error: null, measurements: {},
    });
    return records.get(key);
  };
  const observeReferences = job => {
    if (typeof job.result?.dispatchId === 'string') dispatches.add(job.result.dispatchId);
    for (const step of job.workflow?.steps || []) {
      if (typeof step.dispatchId === 'string') dispatches.add(step.dispatchId);
      if (typeof step.resultMessageId === 'string') messages.add(step.resultMessageId);
      for (const history of step.dispatchHistory || []) if (typeof history.dispatchId === 'string') dispatches.add(history.dispatchId);
    }
  };
  for (const event of events) {
    for (const job of event.patch?.jobs || []) {
      observeReferences(job);
      if (event.type === 'job_started') {
        const record = attemptFor(job);
        if (record) {
          record.startedAt = event.at;
          record.outcome = 'running';
          record.origin = 'ledger_start';
        }
      }
      if (event.type === 'job_stage_updated') {
        const record = attemptFor(job);
        const stage = job.workflow?.steps?.find(step => step.key === event.details?.stage);
        // Orca counters are cumulative per attempt, not additive per stage update.
        if (record && stage?.metrics) applyMeasurements(record, stage.metrics, 'stage_checkpoint', false);
      }
      if (terminalEvents.has(event.type)) {
        const record = attemptFor(job);
        if (!record || record.finishedAt) continue;
        record.finishedAt = event.at;
        record.outcome = event.type === 'interrupted_jobs_recovered' ? 'interrupted' : job.state || 'unknown';
        record.error = job.error?.code || null;
        record.elapsedMs = duration(record.startedAt, event.at);
        record.timingSource = record.elapsedMs === null ? null : event.type === 'interrupted_jobs_recovered' ? 'recovery_interval' : 'ledger_interval';
        // A later operator correction cannot replace this attempt's original timing/result.
        if (event.type === 'job_succeeded') {
          record.resultProvider = job.result?.provider || null;
          applyMeasurements(record, job.result, 'terminal_result', true);
          applyMeasurements(record, job.result?.metrics, 'terminal_result', true);
        }
      }
    }
  }
  for (const job of state.jobs || []) {
    observeReferences(job);
    for (const history of job.attemptHistory || []) {
      const record = attemptFor(job, history.attempt, 'attempt_history');
      if (!record) continue;
      record.startedAt ||= history.startedAt || null;
      record.finishedAt ||= history.finishedAt || null;
      if (record.outcome === 'unknown' || record.outcome === 'running') record.outcome = history.outcome || record.outcome;
      record.error ||= history.error || null;
      if (validNumber(history.elapsedMs) !== null) {
        record.elapsedMs = history.elapsedMs;
        record.timingSource = 'attempt_history';
      }
      applyMeasurements(record, history.metrics, 'attempt_history', true);
    }
    const declaredAttempts = Number.isSafeInteger(job.attempts) && job.attempts >= 0 && job.attempts <= 10000 ? job.attempts : 0;
    for (let attempt = 1; attempt <= declaredAttempts; attempt++) attemptFor(job, attempt, 'counter_only');
    // Snapshot-only records lack a trustworthy start/end pair: finishedAt can be an operator correction.
    const last = attemptFor(job, job.attempts, 'counter_only');
    if (last && last.origin === 'counter_only') {
      last.outcome = job.state || 'unknown';
      last.error = job.error?.code || null;
    }
  }
  const attempts = [...records.values()].sort((a, b) => a.jobId.localeCompare(b.jobId) || a.attempt - b.attempt);
  const timed = attempts.filter(attempt => attempt.elapsedMs !== null && attempt.timingSource !== 'recovery_interval');
  const recovery = attempts.filter(attempt => attempt.elapsedMs !== null && attempt.timingSource === 'recovery_interval');
  const observedMs = timed.length ? timed.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) : null;
  return {
    schema: 1,
    source: { revision: state.revision ?? null, eventCount: events.length, ...source },
    jobs: { total: state.jobs?.length || 0, byState: counts((state.jobs || []).map(job => job.state)), byProvider: counts((state.jobs || []).map(job => job.provider)), byBusiness: counts((state.jobs || []).map(job => job.business)) },
    attempts: {
      total: attempts.length, byOutcome: counts(attempts.map(attempt => attempt.outcome)), byProvider: counts(attempts.map(attempt => attempt.provider)),
      timing: { totalMs: attempts.length && timed.length === attempts.length ? observedMs : null, observedMs, timedAttempts: timed.length, unknownAttempts: attempts.length - timed.length - recovery.length,
        recoveryIntervalsMs: recovery.length ? recovery.reduce((sum, attempt) => sum + attempt.elapsedMs, 0) : null, recoveryIntervals: recovery.length },
      metrics: Object.fromEntries(metricNames.map(name => [name, aggregateMeasurement(attempts, name)])),
    },
    events: { byType: counts(events.map(event => event.type)), manualRetries: events.filter(event => event.type === 'operator_retry').length,
      reportedFalseSuccesses: events.filter(event => event.type === 'false_success_retracted').length },
    references: { observedDispatches: dispatches.size || null, observedCompletionMessages: messages.size || null },
    pipeline: pipelineMetrics(state.jobs),
    notes: [
      'Los estados succeeded son estados registrados; no equivalen a calidad verificada.',
      'Los tiempos suman intervalos de intento; no miden exclusivamente latencia del modelo ni duración total de calendario.',
      'Los intervalos de recuperación pueden incluir tiempo sin ejecutor o espera humana y se separan del tiempo de intentos.',
      'total es null cuando falta cobertura completa; observedTotal suma solo medidas disponibles. Los checkpoints pueden ser parciales.',
      'dispatchStarts cuenta llamadas worker-start, incluidas las rechazadas; no demuestra arranques confirmados ni llamadas al modelo.',
      'No se estiman tokens, facturación ni ahorro; los recuentos de mensajes incluyen solo identificadores conservados.',
    ],
    records: attempts,
  };
}

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readMetrics(root) {
  const directory = path.join(path.resolve(root), 'data');
  const [rawLedger, rawSnapshot] = await Promise.all([readOptional(path.join(directory, 'events.jsonl')), readOptional(path.join(directory, 'state.json'))]);
  let snapshot = null, snapshotStatus = 'absent';
  if (rawSnapshot !== null) {
    try {
      snapshot = JSON.parse(rawSnapshot);
      if (!snapshot || !Array.isArray(snapshot.jobs) || snapshot.jobs.some(job => !job || typeof job.id !== 'string'
        || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 10000)) throw new Error('invalid');
      snapshotStatus = 'available';
    } catch { snapshotStatus = 'invalid'; snapshot = null; }
  }
  if (rawLedger === null) {
    if (snapshotStatus === 'invalid') throw new Error('La instantánea no es válida y falta el registro de eventos.');
    return aggregateMetrics({ state: snapshot || { jobs: [], revision: 0 }, source: { kind: snapshot ? 'snapshot' : 'empty', snapshotStatus, ignoredTrailingBytes: 0,
      warnings: snapshot ? ['Falta el ledger: los intentos y tiempos históricos solo pueden recuperarse de attemptHistory.'] : [] } });
  }
  const complete = rawLedger.lastIndexOf('\n') + 1;
  const ignoredTrailingBytes = Buffer.byteLength(rawLedger.slice(complete));
  const events = [], jobs = new Map();
  let revision = 0;
  for (const [index, line] of rawLedger.slice(0, complete).split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw new Error(`Registro de eventos ilegible en línea ${index + 1}.`); }
    if (event.schema !== 1 || event.revision !== revision + 1 || !event.patch || (event.patch.jobs !== undefined && !Array.isArray(event.patch.jobs))) {
      throw new Error(`Secuencia de eventos inconsistente en línea ${index + 1}.`);
    }
    for (const job of event.patch.jobs || []) {
      if (!job || typeof job.id !== 'string' || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || job.attempts > 10000) throw new Error(`Datos de trabajo inválidos en línea ${index + 1}.`);
      jobs.set(job.id, job);
    }
    revision = event.revision; events.push(event);
  }
  const state = { jobs: [...jobs.values()], revision };
  if (snapshot) snapshotStatus = snapshot.revision === revision && isDeepStrictEqual(snapshot.jobs, state.jobs) ? 'matches' : 'differs';
  const warnings = [];
  if (ignoredTrailingBytes) warnings.push('Se ignora el fragmento final sin salto de línea; no se modifica ni repara el ledger.');
  if (snapshotStatus === 'differs') warnings.push('La instantánea difiere del ledger; las métricas usan el ledger confirmado.');
  if (snapshotStatus === 'invalid') warnings.push('La instantánea es ilegible; las métricas usan el ledger confirmado.');
  return aggregateMetrics({ events, state, source: { kind: 'ledger', snapshotStatus, ignoredTrailingBytes, warnings } });
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
      process.stdout.write('Uso: node metrics.mjs [--root CARPETA]\nSolo lectura; imprime JSON sin reparar ni modificar archivos.\n');
    } else {
      if (args.length && !(args.length === 2 && args[0] === '--root' && args[1])) throw new Error('Uso: node metrics.mjs [--root CARPETA]');
      const root = args[1] || path.dirname(fileURLToPath(import.meta.url));
      process.stdout.write(JSON.stringify(await readMetrics(root), null, 2) + '\n');
    }
  } catch (error) { process.stderr.write((error?.message || 'No se pudieron leer las métricas.') + '\n'); process.exitCode = 1; }
}
