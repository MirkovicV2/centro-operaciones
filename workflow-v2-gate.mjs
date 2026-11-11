// Workflow V2 as the Revisión gate of a project (optional, off by default).
//
// A project listed in data/workflow-v2.json is "governed by Workflow V2": after QA,
// the Centro does not run its own Revisión stage. It hands the checkout to
// `wfv2 submit` (Engineering System), which freezes the candidate, classifies it,
// runs the policy checks in Bubblewrap and launches the isolated reviewer. Without
// the file, or for any project not listed in it, nothing changes.
//
// Phase A (default): the Centro never integrates a governed job. V2's review is a
// recommendation and only the owner decides, in V2, so the job stops with the V2
// state and the owner's next step.
//
// Phase B (per project, "integrateAfterApproval": true): the same stop, and then the owner
// approves in V2 (`wfv2 approve`) and retries the job in the Centro. The retry does not
// submit again: it reads `wfv2 status` for the V2 task bound to this exact candidate and
// integrates only if V2 shows "aprobado" for the identity and evidence recorded at submit
// and the checkout still has the fingerprint QA validated. Each candidate gets its own V2
// task (job id + fingerprint prefix), so a changed candidate needs a new approval.
//
// Decision on GitHub (per project, "ownerDecision": "github", needs phase B): when V2 recommends accepting,
// the Centro does not wait for `wfv2 approve`. It opens the PR with exactly that candidate and never merges
// it: the owner's merge on GitHub is the decision, and closing the PR is the rejection. A V2 rejection or
// block still stops the job. The V2 task stays in pendiente_owner; the merged PR is the record.
//
// data/workflow-v2.json (local, private, gitignored like the rest of data/):
//   { "version": 1, "engineeringSystem": "<checkout of engineering-system>", "python": "python3",
//     "projects": { "<projectId>": { "stateRoot": "<dir outside the checkout>",
//       "reviewerConfig": "<reviewer.json>" | null, "allowedPaths": ["src/"], "checks": ["unit-tests"],
//       "risks": [], "declaredTier": null, "timeoutMs": 3600000, "integrateAfterApproval": false,
//       "pythonEnv": "<virtualenv for checks declaring python_env>" | null, "ownerDecision": "v2" | "github" } } }
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ProviderError } from './providers.mjs';
import { excerpt } from './redaction.mjs';

export const WORKFLOW_V2_FILE = 'workflow-v2.json';
const TIERS = new Set(['FAST', 'STANDARD', 'CRITICAL']);
const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const OUTPUT_LIMIT = 1 << 20;

const fail = message => { throw new ProviderError('workflow_v2_config_invalid', `data/${WORKFLOW_V2_FILE}: ${message}`, { uncertain: false }); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0');
const strings = (value, test = s => typeof s === 'string' && s.length > 0 && s.length <= 300) => Array.isArray(value) && value.length <= 100 && value.every(test);

export function normalizeWorkflowV2(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) fail('se esperaba version 1.');
  if (!absolute(value.engineeringSystem)) fail('engineeringSystem debe ser una ruta absoluta.');
  const python = value.python ?? 'python3';
  if (typeof python !== 'string' || !/^[A-Za-z0-9._/+-]+$/.test(python)) fail('python no es un ejecutable válido.');
  if (!value.projects || typeof value.projects !== 'object' || Array.isArray(value.projects)) fail('projects debe ser un objeto.');
  const projects = {};
  for (const [id, entry] of Object.entries(value.projects)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(id)) fail(`identificador de proyecto inválido: ${id}`);
    if (!entry || typeof entry !== 'object') fail(`${id}: configuración inválida.`);
    if (!absolute(entry.stateRoot)) fail(`${id}: stateRoot debe ser una ruta absoluta.`);
    if (entry.reviewerConfig != null && !absolute(entry.reviewerConfig)) fail(`${id}: reviewerConfig debe ser una ruta absoluta o null.`);
    if (!strings(entry.allowedPaths) || !entry.allowedPaths.length) fail(`${id}: allowedPaths debe listar al menos una ruta.`);
    if (!strings(entry.checks ?? [], s => NAME.test(s))) fail(`${id}: checks debe ser una lista de nombres de la política.`);
    if (!strings(entry.risks ?? [], s => NAME.test(s))) fail(`${id}: risks debe ser una lista de nombres.`);
    if (entry.declaredTier != null && !TIERS.has(entry.declaredTier)) fail(`${id}: declaredTier debe ser FAST, STANDARD, CRITICAL o null.`);
    if (entry.integrateAfterApproval != null && typeof entry.integrateAfterApproval !== 'boolean') fail(`${id}: integrateAfterApproval debe ser true o false.`);
    if (entry.pythonEnv != null && !absolute(entry.pythonEnv)) fail(`${id}: pythonEnv debe ser una ruta absoluta o null.`);
    const ownerDecision = entry.ownerDecision ?? 'v2';
    if (!['v2', 'github'].includes(ownerDecision)) fail(`${id}: ownerDecision debe ser "v2" o "github".`);
    if (ownerDecision === 'github' && entry.integrateAfterApproval !== true) fail(`${id}: ownerDecision "github" necesita integrateAfterApproval: true.`);
    const timeoutMs = entry.timeoutMs ?? 3_600_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 4 * 3_600_000) fail(`${id}: timeoutMs entre 60000 y 14400000.`);
    projects[id] = { stateRoot: entry.stateRoot, reviewerConfig: entry.reviewerConfig ?? null, allowedPaths: [...entry.allowedPaths],
      checks: [...(entry.checks ?? [])], risks: [...(entry.risks ?? [])], declaredTier: entry.declaredTier ?? null, timeoutMs,
      integrateAfterApproval: entry.integrateAfterApproval === true, pythonEnv: entry.pythonEnv ?? null, ownerDecision };
  }
  return { engineeringSystem: value.engineeringSystem, python, projects };
}

export async function readWorkflowV2(root) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'data', WORKFLOW_V2_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { fail('JSON ilegible.'); }
  return normalizeWorkflowV2(value);
}

// The project entry when this job is governed by V2, otherwise null.
export async function workflowV2For(root, job) {
  if (job.kind !== 'code' || !job.projectId) return null;
  const config = await readWorkflowV2(root);
  const entry = config?.projects[job.projectId];
  return entry ? { ...entry, engineeringSystem: config.engineeringSystem, python: config.python } : null;
}

export const v2TaskId = job => String(job.id).replace(/[^A-Za-z0-9_-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 120) || 'job';
const HEX64 = /^[a-f0-9]{64}$/i;
// Phase B: one V2 task per candidate, so an approval can never be reused for other files.
export const v2CandidateTaskId = (job, snapshot) => `${v2TaskId(job).slice(0, 107)}-${String(snapshot).slice(0, 12).toLowerCase()}`;
const taskIdFor = (job, entry) => entry.integrateAfterApproval && HEX64.test(job.workflowV2Snapshot ?? '') ? v2CandidateTaskId(job, job.workflowV2Snapshot) : v2TaskId(job);

// The latest V2 submission recorded for exactly this QA fingerprint (current workflow first, then history).
export function priorV2Submission(job, snapshot) {
  if (!HEX64.test(snapshot ?? '')) return null;
  for (const workflow of [job.workflow, ...[...(job.workflowHistory ?? [])].reverse()]) {
    const step = workflow?.steps?.find(item => item.key === 'reviewer');
    const v2 = step?.workflowV2;
    if (v2?.qaSnapshot === snapshot && typeof v2.task === 'string' && v2.task && typeof v2.identity === 'string' && v2.identity
      && typeof v2.evidenceId === 'string' && v2.evidenceId && HEX64.test(v2.candidate ?? '')) return v2;
  }
  return null;
}

// The V2 TASK from the job contract: each acceptance criterion is judged by the V2 reviewer
// (manual evidence); each configured check must pass in the sandbox.
export function buildV2Task(job, entry) {
  const acceptance = job.contract?.acceptance ?? [];
  return {
    schema: 'wfv2-task', version: 1, id: taskIdFor(job, entry),
    title: String(job.title || job.contract?.objective || job.id).slice(0, 300),
    declared_tier: entry.declaredTier, risks: entry.risks, allowed_paths: entry.allowedPaths, checks: entry.checks,
    criteria: [
      ...entry.checks.map((check, index) => ({ id: `k${index + 1}`, text: `La comprobación ${check} pasa en el sandbox.`, evidence: { check } })),
      ...acceptance.map((text, index) => ({ id: `c${index + 1}`, text, evidence: { manual: 'revisor Workflow V2' } })),
    ],
  };
}

function defaultRun(argv, { cwd, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    const out = [], err = [];
    let size = 0, timedOut = false;
    const take = (list, chunk) => { size += chunk.length; if (size <= OUTPUT_LIMIT) list.push(chunk); };
    child.stdout.on('data', chunk => take(out, chunk));
    child.stderr.on('data', chunk => take(err, chunk));
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    });
  });
}

// What the V2 summary means for the Centro. V2 never approves here; the owner does.
export function interpretV2(summary) {
  const reviews = Array.isArray(summary?.reviews) ? summary.reviews : [];
  const last = reviews.at(-1);
  if (summary?.status === 'pendiente_owner') return { outcome: 'owner_pending', code: 'workflow_v2_owner_pending' };
  if (summary?.status === 'revision' && last?.recommendation === 'ACCEPT') return { outcome: 'owner_pending', code: 'workflow_v2_owner_pending' };
  if (summary?.status === 'revision' && last?.recommendation === 'REJECT') return { outcome: 'rejected', code: 'workflow_v2_rejected' };
  if (summary?.status === 'revision') return { outcome: 'reviewer_missing', code: 'workflow_v2_reviewer_missing' };
  if (summary?.status === 'preparacion') return { outcome: 'checks_failed', code: 'workflow_v2_checks_failed' };
  if (summary?.status === 'bloqueado') return { outcome: 'blocked', code: 'workflow_v2_blocked' };
  return { outcome: 'unexpected', code: 'workflow_v2_unexpected' };
}

const MESSAGES = {
  owner_pending: 'Workflow V2 terminó su revisión y recomienda aceptar. Decide tú en V2; el Centro no integra un encargo gobernado por V2.',
  owner_pending_b: 'Workflow V2 terminó su revisión y recomienda aceptar. Decide tú en V2; si apruebas, reintenta este trabajo en el Centro y se integrará solo este candidato.',
  rejected: 'El revisor de Workflow V2 rechazó el candidato. Lee el informe en V2, registra tu veredicto y corrige.',
  reviewer_missing: 'Workflow V2 necesita una revisión, pero el proyecto no tiene revisor configurado (reviewerConfig).',
  checks_failed: 'Las comprobaciones de Workflow V2 fallaron en el sandbox; no se lanzó ninguna revisión.',
  blocked: 'Workflow V2 quedó bloqueado por un fallo operativo; no es un rechazo del producto. Corrige la causa, desbloquéalo en V2 (wfv2 unblock) y pulsa Reintentar: se reenvía el mismo candidato, sin volver a lanzar agentes.',
  unexpected: 'Workflow V2 devolvió un estado que el Centro no reconoce.',
};

// With "ownerDecision": "github", a V2 summary in which every required review recommends accepting stands in
// for the owner's V2 approval: the binding the integration is tied to. Null otherwise. Pure.
export function githubRecommendation(entry, summary, prior) {
  if (entry?.ownerDecision !== 'github' || !entry.integrateAfterApproval) return null;
  const reviews = Array.isArray(summary?.reviews) ? summary.reviews : [];
  const accepts = reviews.length > 0 && reviews.every(review => review?.recommendation === 'ACCEPT');
  if (!accepts || !['pendiente_owner', 'revision', 'aprobado'].includes(summary?.status)) return null;
  const identity = summary.identity ?? prior?.identity, evidenceId = summary.evidence_id ?? prior?.evidenceId;
  if (typeof identity !== 'string' || !identity || typeof evidenceId !== 'string' || !evidenceId || !HEX64.test(prior?.candidate ?? '') || !HEX64.test(prior?.qaSnapshot ?? '')) return null;
  if ((prior.identity && prior.identity !== identity) || (prior.evidenceId && prior.evidenceId !== evidenceId)) return null;
  const binding = { task: prior.task, identity, evidenceId, candidate: prior.candidate, qaSnapshot: prior.qaSnapshot };
  return { binding, record: { ...prior, ...binding, outcome: 'recommended', decision: 'github', status: String(summary.status) },
    summary: `Workflow V2 recomienda aceptar (tarea ${prior.task}${summary.tier ? `, nivel ${summary.tier}` : ''}). Tu decisión es la PR: fusiónala si te convence o ciérrala para rechazar. El Centro no la fusiona.` };
}

// Runs `wfv2 submit` on the checkout and reports the reviewer stage. It ends by throwing (the job stops for the
// owner), except with the decision on GitHub, where a recommendation to accept returns the binding to integrate.
export async function runWorkflowV2Gate(job, ctx, entry, workspace, { run = defaultRun } = {}) {
  const task = buildV2Task(job, entry);
  await ctx.reportStage?.({ key: 'reviewer', status: 'running', summary: `Workflow V2: enviando el candidato (tarea ${task.id}).`, workflowV2: { task: task.id } });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'centro-wfv2-'));
  let result;
  try {
    const taskFile = path.join(temp, 'task.json');
    await fs.writeFile(taskFile, JSON.stringify(task, null, 2));
    const argv = [entry.python, '-m', 'wfv2.cli', '--repo', entry.stateRoot, 'submit', task.id,
      '--worktree', workspace, '--task-file', taskFile, ...(entry.reviewerConfig ? ['--reviewer-config', entry.reviewerConfig] : []),
      ...(entry.pythonEnv ? ['--python-env', entry.pythonEnv] : [])];
    result = await run(argv, { cwd: entry.engineeringSystem, timeoutMs: entry.timeoutMs, signal: ctx.signal });
  } catch (error) {
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: 'No se pudo ejecutar Workflow V2.', error: 'workflow_v2_unavailable' });
    throw new ProviderError('workflow_v2_unavailable', `No se pudo ejecutar Workflow V2: ${excerpt(error.message)}`.slice(0, 500), { uncertain: false });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
  if (result.timedOut || result.code !== 0) {
    const detail = result.timedOut ? 'se agotó el tiempo' : (excerpt(result.stderr.trim().split('\n').at(-1)) || `salida ${result.code}`);
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: `Workflow V2 rechazó el envío: ${detail}`.slice(0, 1000), error: 'workflow_v2_refused' });
    throw new ProviderError('workflow_v2_refused', `Workflow V2 rechazó el envío: ${detail}`.slice(0, 500), { uncertain: result.timedOut });
  }
  let summary;
  try { summary = JSON.parse(result.stdout); } catch {
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: 'La salida de Workflow V2 no es JSON.', error: 'workflow_v2_unexpected' });
    throw new ProviderError('workflow_v2_unexpected', 'La salida de Workflow V2 no es JSON.', { uncertain: false });
  }
  const { outcome, code } = interpretV2(summary);
  const candidate = Array.isArray(summary?.steps) ? summary.steps.find(step => step?.unit === 'U1')?.candidate ?? null : null;
  if (summary?.task !== task.id || (['owner_pending', 'rejected'].includes(outcome) && !/^[a-f0-9]{64}$/i.test(candidate ?? ''))) {
    const error = new ProviderError('workflow_v2_identity_mismatch', 'Workflow V2 no acredita la tarea enviada y la huella de su candidato.', { uncertain: true });
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: error.message, error: error.code });
    throw error;
  }
  if (job.workflowV2Snapshot && await ctx.captureSnapshot(workspace) !== job.workflowV2Snapshot) {
    const error = new ProviderError('workflow_v2_candidate_changed', 'El checkout cambió durante el envío a Workflow V2. Revisa la evidencia antes de continuar.', { uncertain: true });
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: error.message, error: error.code });
    throw error;
  }
  const workflowV2 = { task: task.id, outcome, status: summary.status, tier: summary.tier ?? null, candidate, qaSnapshot: job.workflowV2Snapshot ?? null,
    identity: summary.identity ?? null, evidenceId: summary.evidence_id ?? null, reviews: summary.reviews ?? [],
    blockedReason: summary.blocked_reason ?? null, next: summary.next ?? null };
  // Decision on GitHub: V2's recommendation to accept is enough to open the PR; the owner decides by merging it.
  const recommendation = githubRecommendation(entry, summary, workflowV2);
  if (recommendation) {
    await ctx.reportStage?.({ key: 'reviewer', status: 'succeeded', summary: recommendation.summary, workflowV2: recommendation.record });
    return recommendation.binding;
  }
  const line = [MESSAGES[entry.integrateAfterApproval && outcome === 'owner_pending' ? 'owner_pending_b' : outcome], summary.tier ? `Nivel ${summary.tier}.` : '', summary.blocked_reason ? `Motivo: ${summary.blocked_reason}.` : '',
    summary.next ? `Siguiente: ${summary.next}` : ''].filter(Boolean).join(' ');
  await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: line.slice(0, 1000), error: code, workflowV2 });
  const error = new ProviderError(code, line.slice(0, 500), { uncertain: false });
  error.details = { v2Task: task.id, v2Status: String(summary.status ?? ''), v2Tier: String(summary.tier ?? ''),
    v2Candidate: candidate ?? '', v2Next: String(summary.next ?? '') };
  // Phase B keeps the integration step pending: it runs after the owner's approval, on retry.
  if (!entry.integrateAfterApproval && job.workflow?.steps?.some(step => step.key === 'integration')) {
    await ctx.reportStage?.({ key: 'integration', status: 'skipped', summary: 'Gobernado por Workflow V2: el Centro no integra; decide el owner en V2.' });
  }
  throw error;
}

const STATUS_STOPS = {
  pendiente_owner: ['workflow_v2_owner_pending', 'Workflow V2 aún no tiene tu aprobación para este candidato. Aprueba en V2 y vuelve a reintentar.', false],
  revision: ['workflow_v2_owner_pending', 'Workflow V2 todavía espera tu veredicto sobre la revisión. Decide en V2 y vuelve a reintentar.', false],
  rechazado: ['workflow_v2_rejected', 'Rechazaste este candidato en Workflow V2; no se integra. Corrige y vuelve a pasar QA y V2.', false],
  escalado: ['workflow_v2_rejected', 'Workflow V2 escaló este candidato; resuélvelo en V2. No se integra.', false],
  cerrada: ['workflow_v2_rejected', 'La tarea de Workflow V2 está cerrada sin aprobación; no se integra.', false],
  bloqueado: ['workflow_v2_blocked', 'Workflow V2 está bloqueado para este candidato; desbloquéalo en V2.', false],
};

// Phase B: reads `wfv2 status` for the task submitted for this candidate. Returns the approval binding
// only when V2 shows "aprobado" for the same identity and evidence recorded at submit; otherwise
// reports the reviewer stage and throws. Read-only on the V2 side.
export async function resolveWorkflowV2Approval(job, ctx, entry, prior, { run = defaultRun } = {}) {
  const argv = [entry.python, '-m', 'wfv2.cli', '--repo', entry.stateRoot, 'status', prior.task];
  let result;
  try { result = await run(argv, { cwd: entry.engineeringSystem, timeoutMs: 120_000, signal: ctx.signal }); }
  catch (error) {
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: 'No se pudo consultar Workflow V2.', error: 'workflow_v2_unavailable' });
    throw new ProviderError('workflow_v2_unavailable', `No se pudo consultar Workflow V2: ${excerpt(error.message)}`.slice(0, 500), { uncertain: false });
  }
  let status;
  try { if (result.timedOut || result.code !== 0) throw new Error(); status = JSON.parse(result.stdout); }
  catch {
    const detail = result?.timedOut ? 'se agotó el tiempo' : excerpt(result?.stderr?.trim().split('\n').at(-1) ?? '') || `salida ${result?.code}`;
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: `No se pudo leer el estado de Workflow V2: ${detail}`.slice(0, 1000), error: 'workflow_v2_unavailable' });
    throw new ProviderError('workflow_v2_unavailable', `No se pudo leer el estado de Workflow V2: ${detail}`.slice(0, 500), { uncertain: false });
  }
  const binding = { task: prior.task, identity: prior.identity, evidenceId: prior.evidenceId, candidate: prior.candidate, qaSnapshot: prior.qaSnapshot };
  const record = (outcome, extra = {}) => ({ ...prior, outcome, status: String(status?.status ?? ''), ...extra });
  if (status?.task !== prior.task) {
    const error = new ProviderError('workflow_v2_identity_mismatch', 'Workflow V2 devolvió el estado de otra tarea.', { uncertain: true });
    await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: error.message, error: error.code, workflowV2: record('identity_mismatch') });
    throw error;
  }
  const recommended = githubRecommendation(entry, status, prior);
  if (recommended && status.status !== 'aprobado') {
    if (job.workflow?.steps?.find(step => step.key === 'reviewer')?.status !== 'succeeded') {
      await ctx.reportStage?.({ key: 'reviewer', status: 'running', summary: `Workflow V2: comprobando la recomendación (tarea ${prior.task}).` });
    }
    await ctx.reportStage?.({ key: 'reviewer', status: 'succeeded', summary: recommended.summary, workflowV2: recommended.record });
    return recommended.binding;
  }
  if (status.status === 'aprobado') {
    if (!('identity' in status) || !('evidence_id' in status)) {
      const error = new ProviderError('workflow_v2_unavailable', 'Esta versión de Engineering System no muestra a qué identidad está atada la aprobación (wfv2 status). Actualízala; no se integra sin comprobarlo.', { uncertain: false });
      await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: error.message, error: error.code });
      throw error;
    }
    if (status.identity !== prior.identity || status.evidence_id !== prior.evidenceId) {
      const error = new ProviderError('workflow_v2_approval_mismatch', 'La aprobación de Workflow V2 está atada a otra identidad o evidencia que el candidato enviado. No se integra; vuelve a pasar QA y V2.', { uncertain: false });
      await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: error.message, error: error.code, workflowV2: record('approval_mismatch') });
      throw error;
    }
    const approved = record('approved', { approvedSeenAt: new Date().toISOString() });
    // The queue moves a stopped stage through running before it can succeed; an already approved one stays.
    if (job.workflow?.steps?.find(step => step.key === 'reviewer')?.status !== 'succeeded') {
      await ctx.reportStage?.({ key: 'reviewer', status: 'running', summary: `Workflow V2: comprobando tu aprobación (tarea ${prior.task}).` });
    }
    await ctx.reportStage?.({ key: 'reviewer', status: 'succeeded', summary: `Aprobado por ti en Workflow V2 (tarea ${prior.task}). Se integrará solo este candidato.`, workflowV2: approved });
    return binding;
  }
  const [code, message] = STATUS_STOPS[status.status] ?? ['workflow_v2_unexpected', `Workflow V2 devolvió un estado que el Centro no reconoce: ${String(status.status).slice(0, 40)}.`];
  await ctx.reportStage?.({ key: 'reviewer', status: 'blocked', summary: message, error: code, workflowV2: record(code === 'workflow_v2_owner_pending' ? 'owner_pending' : code.replace('workflow_v2_', '')) });
  const error = new ProviderError(code, message, { uncertain: false });
  error.details = { v2Task: prior.task, v2Status: String(status.status ?? '') };
  throw error;
}

const BINDING_KEYS = ['task', 'identity', 'evidenceId', 'candidate', 'qaSnapshot'];
// Phase B: before any Git or GitHub effect, the integration record is bound to the V2 approval. A restart
// or retry finds the same binding and continues; a record bound to another approval, or with effects and
// no binding, stops the job instead of integrating.
export async function bindWorkflowV2Approval(job, approval, { previous, persist }) {
  const saved = previous?.workflowV2Approval;
  if (saved) {
    if (BINDING_KEYS.some(key => saved[key] !== approval[key])) {
      throw new ProviderError('workflow_v2_approval_mismatch', 'La integración registrada pertenece a otra aprobación de Workflow V2. No se integra este candidato; revisa el registro.', { uncertain: true });
    }
    return previous;
  }
  const effects = ['commitSha', 'manifest', 'prNumber', 'prUrl', 'mergeSha'].some(key => previous?.[key] != null);
  if (effects || (previous?.phase && !['validation_pending', 'validation_approved'].includes(previous.phase))) {
    throw new ProviderError('workflow_v2_integration_unbound', 'Ya hay una integración registrada sin la aprobación de Workflow V2. Revísala antes de continuar.', { uncertain: true });
  }
  const record = { ...previous, jobId: job.id, receiptId: job.autoIntent.receiptId, repository: job.destination?.repository,
    sourceBranch: job.branch, baseBranch: job.destination?.baseBranch, phase: 'validation_approved', status: 'validated', needsAttention: false, error: null,
    workflowV2Approval: { ...Object.fromEntries(BINDING_KEYS.map(key => [key, approval[key]])), boundAt: new Date().toISOString() } };
  await persist(record);
  return record;
}

// Phase B: a job the owner resumed after approving in V2 is admitted again with its candidate still
// uncommitted in the checkout, so admission must not demand a clean tree. Integration later checks
// that the checkout is exactly the QA snapshot V2 reviewed. Pure.
export function workflowV2Readmissible(job) {
  if (job?.state !== 'queued' || job.kind !== 'code') return false;
  const steps = job.workflow?.steps ?? [];
  const reviewer = steps.find(step => step.key === 'reviewer'), v2 = reviewer?.workflowV2;
  // A resubmission (V2 blocked before producing evidence) carries the same uncommitted candidate but no evidence yet.
  const evidenceless = reviewer?.status === 'blocked' && reviewer.error === 'workflow_v2_blocked' && !v2?.evidenceId && !(v2?.reviews?.length);
  return Boolean(v2?.task && v2.identity && (v2.evidenceId || evidenceless) && HEX64.test(v2.qaSnapshot ?? '') && HEX64.test(v2.candidate ?? '')
    && steps.find(step => step.key === 'qa')?.status === 'succeeded');
}

// Phase B: whether a stopped job can be resumed to read the owner's V2 approval and integrate. Pure.
// Either the job stopped waiting for the owner, or the approval was already seen and the integration
// step stopped (interrupted by a restart, or blocked); integration resumes from its own record.
const RESUMABLE_V2_STOPS = new Set(['workflow_v2_owner_pending', 'workflow_v2_unavailable']);
// V2 stopped before producing any evidence (an operational block, e.g. a check without its Python environment) and
// the owner unblocked it: the same candidate is submitted again. No review exists yet, so nothing can be repeated.
export function workflowV2Resubmittable(job) {
  if (job?.state !== 'needs_attention' || job.kind !== 'code') return false;
  const steps = job.workflow?.steps ?? [];
  const reviewer = steps.find(step => step.key === 'reviewer'), integration = steps.find(step => step.key === 'integration');
  const v2 = reviewer?.workflowV2;
  return reviewer?.status === 'blocked' && reviewer.error === 'workflow_v2_blocked' && Boolean(v2?.task) && !v2.evidenceId && !(v2.reviews?.length)
    && HEX64.test(v2.qaSnapshot ?? '') && steps.find(step => step.key === 'qa')?.status === 'succeeded'
    && (!integration || integration.status === 'queued');
}
export function workflowV2Resumable(job) {
  if (workflowV2Resubmittable(job)) return true;
  if (job?.state !== 'needs_attention' || job.kind !== 'code') return false;
  const steps = job.workflow?.steps ?? [];
  const reviewer = steps.find(step => step.key === 'reviewer'), integration = steps.find(step => step.key === 'integration');
  const v2 = reviewer?.workflowV2;
  if (!v2?.task || !v2.identity || !v2.evidenceId || !HEX64.test(v2.qaSnapshot ?? '') || !HEX64.test(v2.candidate ?? '')) return false;
  if (steps.find(step => step.key === 'qa')?.status !== 'succeeded') return false;
  if (reviewer.status === 'blocked') return RESUMABLE_V2_STOPS.has(reviewer.error) && (!integration || integration.status === 'queued');
  return reviewer.status === 'succeeded' && v2.outcome === 'approved' && integration?.status === 'blocked' && !integration.dispatchId;
}

// ---- The owner's decision, seen from the panel (read-only) ----
//
// The Centro never records a V2 verdict: approval stays a typed confirmation of the owner in the
// terminal. The panel shows what V2 waits for, the exact command for this state and the files of
// the candidate, and refuses a retry that could only find the same stop (it spent an attempt).

const shellQuote = value => /^[A-Za-z0-9._/+:=@-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;

// What the owner does next in V2 for this status. Pure.
export function nextV2Step(entry, task, summary) {
  const base = `cd ${shellQuote(entry.engineeringSystem)} && ${entry.python} -m wfv2.cli --repo ${shellQuote(entry.stateRoot)}`;
  const status = String(summary?.status ?? '');
  const required = Array.isArray(summary?.required_reviews) ? summary.required_reviews.map(String) : [];
  const accepted = new Set(Array.isArray(summary?.accepted) ? summary.accepted.map(String) : []);
  const reviewed = new Set((Array.isArray(summary?.reviews) ? summary.reviews : []).map(review => String(review?.role ?? '')));
  if (entry.ownerDecision === 'github' && ['pendiente_owner', 'revision', 'aprobado'].includes(status)) {
    return { action: 'github', text: 'En este proyecto decides en GitHub: fusiona la PR si te convence o ciérrala para rechazar. No hace falta aprobar en V2.' };
  }
  switch (status) {
    case 'pendiente_owner':
      return { action: 'approve', text: 'Las revisiones obligatorias están aceptadas: falta tu aprobación final de la tarea. Si no te convence, usa reject.', command: `${base} approve ${task}` };
    case 'revision': {
      const role = required.find(item => !accepted.has(item) && reviewed.has(item) && /^[a-z0-9_-]+$/.test(item));
      return role
        ? { action: 'verdict', text: `Lee la revisión «${role}» y registra tu veredicto (accepted o rejected).`, command: `${base} verdict ${task} ${role} accepted` }
        : { action: 'wait', text: 'V2 espera una revisión que todavía no existe; consulta su estado.', command: `${base} status ${task}` };
    }
    case 'bloqueado':
      return { action: 'unblock', text: 'V2 está bloqueado por un fallo operativo: corrige la causa y desbloquéalo; después pulsa Reintentar.', command: `${base} unblock ${task}` };
    case 'preparacion':
      return { action: 'retry', text: 'Desbloqueada: pulsa Reintentar y el Centro reenviará el mismo candidato.' };
    case 'aprobado':
      return { action: 'integrate', text: 'Aprobada por ti: pulsa Integrar y el Centro integrará solo este candidato.' };
    default:
      return { action: 'none', text: `Estado «${status.slice(0, 40)}»: resuélvelo en V2.`, command: `${base} status ${task}` };
  }
}

// Live V2 status of the task recorded on the reviewer step, or null when the job is not governed by V2.
export async function workflowV2Live(root, job, { run = defaultRun } = {}) {
  const task = job?.workflow?.steps?.find(step => step.key === 'reviewer')?.workflowV2?.task;
  if (typeof task !== 'string' || !task) return null;
  const entry = await workflowV2For(root, job);
  if (!entry) return null;
  const unavailable = detail => ({ task, available: false, error: `No se pudo consultar Workflow V2: ${detail}`.slice(0, 300) });
  let result;
  try { result = await run([entry.python, '-m', 'wfv2.cli', '--repo', entry.stateRoot, 'status', task], { cwd: entry.engineeringSystem, timeoutMs: 30_000 }); }
  catch (error) { return unavailable(excerpt(error.message)); }
  if (result.timedOut || result.code !== 0) return unavailable(result.timedOut ? 'se agotó el tiempo' : excerpt(result.stderr.trim().split('\n').at(-1) ?? '') || `salida ${result.code}`);
  let summary;
  try { summary = JSON.parse(result.stdout); } catch { return unavailable('la salida no es JSON'); }
  if (summary?.task !== task) return unavailable('devolvió el estado de otra tarea');
  const list = value => Array.isArray(value) ? value.map(item => String(item).slice(0, 40)) : [];
  return { task, available: true, status: String(summary.status ?? ''), tier: summary.tier ?? null,
    required: list(summary.required_reviews), accepted: list(summary.accepted),
    reviews: (Array.isArray(summary.reviews) ? summary.reviews : []).slice(0, 10).map(review => ({ role: String(review?.role ?? ''),
      recommendation: String(review?.recommendation ?? ''), isolation: String(review?.isolation ?? '') })),
    blockedReason: summary.blocked_reason ? excerpt(String(summary.blocked_reason)) : null, next: nextV2Step(entry, task, summary) };
}

// A retry that would only meet the same V2 stop is refused before touching the queue. Pure.
export function workflowV2RetryRefusal(job, live) {
  if (!live?.available) return null;
  const reviewer = job?.workflow?.steps?.find(step => step.key === 'reviewer');
  if (reviewer?.status !== 'blocked') return null;
  const command = live.next?.command ? ` Comando: ${live.next.command}` : '';
  if (reviewer.error === 'workflow_v2_owner_pending' && live.status !== 'aprobado') {
    return `Falta tu decisión en Workflow V2 (estado: ${live.status}). ${live.next.text}${command} No se ha gastado ningún intento.`;
  }
  if (reviewer.error === 'workflow_v2_blocked' && live.status === 'bloqueado') {
    return `Workflow V2 sigue bloqueado. ${live.next.text}${command} No se ha gastado ningún intento.`;
  }
  return null;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|webm|wav|ogg|woff2?|ttf|otf|eot|sqlite3?|db|bin|exe|dll|so|dylib|pyc|class|jar)$/i;
const CHANGE = { '??': 'nuevo', A: 'nuevo', M: 'modificado', D: 'borrado', R: 'renombrado', C: 'copiado', T: 'modificado', U: 'en conflicto' };
// The files of the uncommitted candidate in the checkout (read-only `git status`), new binaries flagged.
export async function candidateFiles(workspace, { run = defaultRun, limit = 500 } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return { files: [], error: 'Sin checkout.' };
  let result;
  try { result = await run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: workspace, timeoutMs: 30_000 }); }
  catch (error) { return { files: [], error: excerpt(error.message) }; }
  if (result.timedOut || result.code !== 0) return { files: [], error: excerpt(result.stderr.trim()) || 'git status falló.' };
  const entries = result.stdout.split('\0').filter(Boolean), files = [];
  for (let index = 0; index < entries.length; index++) {
    const code = entries[index].slice(0, 2), file = entries[index].slice(3);
    if (code[0] === 'R' || code[0] === 'C') index++; // the origin path follows a rename or copy
    const key = code === '??' ? '??' : (code[0] !== ' ' ? code[0] : code[1]);
    files.push({ path: file, change: CHANGE[key] ?? 'modificado', binary: BINARY.test(file) });
  }
  return { files: files.slice(0, limit), total: files.length };
}

// Before any agent runs: a V2 misconfiguration used to surface only after UX, Development and QA
// (Encargo 2 of home-finance lost 13 minutes of agents and half an hour of recovery). Checks the
// paths and that `wfv2` starts; it cannot know which checks need the Python environment.
export async function preflightWorkflowV2(entry, { run = defaultRun, stat = fs.stat } = {}) {
  const problems = [];
  const expect = async (target, kind, label) => {
    try {
      const info = await stat(target);
      if (kind === 'dir' ? !info.isDirectory() : !info.isFile()) problems.push(`${label} no es ${kind === 'dir' ? 'una carpeta' : 'un archivo'} (${target})`);
      return true;
    } catch { problems.push(`no existe ${label} (${target})`); return false; }
  };
  const system = await expect(entry.engineeringSystem, 'dir', 'engineeringSystem');
  await expect(entry.stateRoot, 'dir', 'stateRoot');
  if (entry.reviewerConfig) await expect(entry.reviewerConfig, 'file', 'reviewerConfig');
  if (entry.pythonEnv && await expect(entry.pythonEnv, 'dir', 'pythonEnv')) {
    const found = await Promise.any(['bin/python', 'Scripts/python.exe'].map(name => stat(path.join(entry.pythonEnv, name)))).then(() => true, () => false);
    if (!found) problems.push(`pythonEnv no contiene un intérprete (bin/python) (${entry.pythonEnv})`);
  }
  if (system) {
    try {
      const result = await run([entry.python, '-m', 'wfv2.cli', '--help'], { cwd: entry.engineeringSystem, timeoutMs: 30_000 });
      if (result.timedOut || result.code !== 0) problems.push(`wfv2 no arranca: ${result.timedOut ? 'se agotó el tiempo' : excerpt(result.stderr.trim().split('\n').at(-1) ?? '') || `salida ${result.code}`}`);
    } catch (error) { problems.push(`wfv2 no arranca: ${excerpt(error.message)}`); }
  }
  if (problems.length) {
    throw new ProviderError('workflow_v2_preflight_failed',
      `Workflow V2 no está listo para este proyecto; no se ha lanzado ningún agente. Corrige data/${WORKFLOW_V2_FILE}: ${problems.join('; ')}.`.slice(0, 900), { uncertain: false });
  }
}
