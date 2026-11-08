import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { inspectDestination, verifyGitHubDestination } from './project-destination.mjs';
import { ProviderError, validateWorkspace } from './providers.mjs';
import { captureIntegrationSnapshot, integrateGitHubDefault } from './github-integration.mjs';
import { persistIntegration, readIntegration } from './auto-run.mjs';

const ORCA_EXE = process.env.ORCA_CLI || 'C:\\Users\\brank\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe';
const PROFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.codex', 'agents');
const ROLES = {
  planificador: { name: 'planificador', stageKey: 'planner', label: 'Planificación', model: 'gpt-6-luna', effort: 'high' },
  ux: { name: 'ux', stageKey: 'ux', label: 'Diseño UX', model: 'gpt-6.1-sol', effort: 'medium' },
  desarrollador: { name: 'desarrollador', stageKey: 'developer', label: 'Implementación', model: 'gpt-6.1-sol', effort: 'medium' },
  qa: { name: 'qa', stageKey: 'qa', label: 'Control de calidad', model: 'gpt-6.1-sol', effort: 'medium' },
  revisor: { name: 'revisor', stageKey: 'reviewer', label: 'Revisión de código', model: 'gpt-6.1-sol', effort: 'medium' },
};

function run(exe, args, { cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    const collect = (target) => (chunk) => {
      if (target.value.length < 256_000) target.value += chunk.toString().slice(0, 256_000 - target.value.length);
    };
    const out = { value: '' }, err = { value: '' };
    child.stdout.on('data', collect(out)); child.stderr.on('data', collect(err));
    const stop = () => { child.kill(); };
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', () => { signal?.removeEventListener('abort', stop); reject(new ProviderError('orca_start_failed', 'No se pudo iniciar Orca CLI; comprueba que Orca esté instalado y abierto.')); });
    child.once('close', (code) => {
      stdout = out.value; stderr = err.value; signal?.removeEventListener('abort', stop);
      if (signal?.aborted) reject(signal.reason);
      else if (code !== 0) reject(new ProviderError('orca_command_failed', 'Orca no pudo completar la operación; revisa el estado local de Orca.'));
      else resolve({ stdout, stderr });
    });
  });
}

async function jsonCommand(args, cwd, signal) {
  const { stdout } = await run(ORCA_EXE, [...args, '--json'], { cwd, signal });
  let value;
  try { value = JSON.parse(stdout); } catch { throw new ProviderError('orca_invalid_response', 'Orca devolvió una respuesta ilegible; revisa el flujo antes de repetir.'); }
  if (value.ok === false) throw new ProviderError('orca_command_rejected', 'Orca rechazó la operación; revisa su contexto y la cola local.');
  return value.result ?? value;
}

function profileInstructions(text) {
  const match = text.match(/developer_instructions\s*=\s*"""([\s\S]*?)"""/);
  return match?.[1]?.trim() ?? '';
}

async function ensureRepo(workspace, kind, cwd, signal, command = jsonCommand) {
  const repos = await command(['repo', 'list'], cwd, signal);
  const known = repos.repos?.some((repo) => path.resolve(repo.path).toLowerCase() === workspace.toLowerCase());
  if (!known) await command(['repo', 'add', '--path', workspace, '--kind', kind], cwd, signal);
}

async function createJobRun(job, ctx, command = jsonCommand) {
  const existing = job.workflow?.runId;
  if (/^run_[a-zA-Z0-9_-]{6,80}$/.test(existing ?? '')) return existing;
  const created = await command(['orchestration', 'run-create', '--objective', `${job.title} (${job.id})`], ctx.root, ctx.signal);
  const runId = created.runId ?? created.run?.id;
  if (!/^run_[a-zA-Z0-9_-]{6,80}$/.test(runId ?? '')) {
    throw new ProviderError('orca_run_unknown', 'Orca no confirmó el Run de este trabajo; requiere revisión antes de reintentar.', { uncertain: true });
  }
  return runId;
}

function finalText(result) {
  const completion = result.messages?.find((message) => {
    if (message.type !== 'worker_done' || !message.body?.trim()) return false;
    try {
      const payload = JSON.parse(message.payload ?? '{}');
      if (result.dispatchId) return payload.dispatchId === result.dispatchId;
      return Boolean(result.taskId && payload.taskId === result.taskId);
    } catch { return false; }
  });
  if (completion) return completion.body.trim();
  const messages = result.transcript?.messages ?? [];
  const candidates = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.blocks ?? []).filter((block) => block.type === 'text' && block.text?.trim());
  return candidates.at(-1)?.text?.trim() ?? '';
}

const STAGE_SUMMARY_LIMIT = 12_000;
function summarizeStage(text) {
  const value = String(text ?? '');
  if (value.length <= STAGE_SUMMARY_LIMIT) return { summary: value, summaryTruncated: false };
  const half = Math.floor((STAGE_SUMMARY_LIMIT - 80) / 2);
  return {
    summary: `${value.slice(0, half)}\n\n[… informe truncado; final conservado …]\n\n${value.slice(-half)}`,
    summaryTruncated: true,
  };
}

function approvalEvidence(roleKey, text, dispatchId) {
  if (!['qa', 'revisor'].includes(roleKey)) return {};
  return {
    approvalOutcome: approved(text) ? 'approved' : 'missing_marker',
    approvalDispatchId: dispatchId,
  };
}

function waitForPoll(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runStage(job, ctx, roleKey, workspace, runId, instruction, prior = '', command = jsonCommand) {
  const baseRole = ROLES[roleKey];
  const recorded = job.workflow?.steps?.find(step => step.key === baseRole.stageKey)?.profile;
  const name = roleKey === 'planificador' ? roleKey : recorded && [roleKey, `${roleKey}_${job.business}`].includes(recorded) ? recorded : `${roleKey}_${job.business}`;
  const role = { ...baseRole, name, label: job.business === 'games' && roleKey === 'desarrollador' ? 'Desarrollo de videojuegos (Godot)' : baseRole.label };
  const profilePath = path.join(PROFILE_DIR, `${role.name}.toml`);
  let profile;
  try { profile = profileInstructions(await fs.readFile(profilePath, 'utf8')); }
  catch { throw new ProviderError('orca_profile_missing', `No existe el perfil Orca configurado: ${role.name}.`); }
  const savedStep = job.workflow?.steps?.find(step => step.key === role.stageKey);
  if (savedStep?.status === 'succeeded' && savedStep.summary) {
    return {
      text: savedStep.summary,
      dispatchId: savedStep.dispatchId,
      taskId: savedStep.taskId,
      approvalOutcome: savedStep.approvalOutcome,
      approvalDispatchId: savedStep.approvalDispatchId,
      recovered: true,
    };
  }
  const resumeCompleted = savedStep?.status === 'failed' && ['completed', 'unknown'].includes(savedStep.dispatchStatus);
  const existingDispatch = (['running', 'blocked'].includes(savedStep?.status) || resumeCompleted) ? savedStep.dispatchId : null;
  if ((['running', 'blocked'].includes(savedStep?.status) || resumeCompleted) && !existingDispatch) {
    await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', dispatchStatus: 'unknown', error: 'dispatch_id_missing' });
    throw new ProviderError('orca_dispatch_unknown', `No se confirmó el dispatch de ${role.name}; revisa Orca antes de iniciar otra ejecución.`, { uncertain: true });
  }
  const spec = [
    `PERFIL EXISTENTE: ${role.name}. Respeta el alcance del perfil y no crees ni delegues en otros agentes.`,
    profile,
    `EMPRESA: ${job.business}.`,
    job.branch ? `DESTINO CONFIRMADO: ${workspace}; rama ${job.branch}. No crees ni cambies ramas.` : '',
    `TAREA: ${job.title}.`,
    `ENCARGO Y CRITERIO DE ÉXITO:\n${job.prompt}`,
    prior ? `RESULTADOS DE ETAPAS ANTERIORES:\n${prior}` : '',
    instruction,
    job.kind === 'code' ? 'Usa exclusivamente el checkout aislado asignado. No hagas commit, push, merge, publicación ni despliegue.' : 'Es una tarea de análisis: no cambies código ni archivos.',
  ].filter(Boolean).join('\n\n');
  let dispatchId = existingDispatch;
  let taskId = savedStep?.taskId;
  if (!dispatchId) {
    if (job.kind === 'code' && job.branch) {
      if (job.autoIntent) await verifyGitHubDestination(ctx.root, job);
      else await inspectDestination(ctx.root, path.relative(ctx.root, workspace), job.branch);
    }
    await ctx.reportStage?.({ key: role.stageKey, profile: role.name, label: role.label, runId, attempt: job.attempts, status: 'running', dispatchStatus: 'starting' });
    let started;
    try {
      started = await command([
        'orchestration', 'worker-start', '--spec', spec, '--agent', 'codex', '--model', role.model,
        '--effort', role.effort, '--worktree', `path:${workspace}`, '--run', runId, '--task-title', `${job.title} — ${role.label}`,
      ], ctx.root, ctx.signal);
    } catch (error) {
      const rejected = error.code === 'orca_command_rejected';
      await ctx.reportStage?.({ key: role.stageKey, status: rejected ? 'failed' : 'blocked', dispatchStatus: rejected ? 'rejected' : 'unknown', error: error.code ?? 'orca_start_failed' });
      throw new ProviderError(error.code ?? 'orca_start_failed', rejected
        ? `Orca rechazó los argumentos de ${role.name}; no confirmó un trabajador.`
        : `No se pudo confirmar si Orca inició ${role.name}; revisa el dispatch antes de repetir.`, { uncertain: !rejected });
    }
    dispatchId = started.dispatchId ?? started.dispatch?.dispatchId;
    taskId = started.taskId ?? started.task?.id;
    if (!/^ctx_[a-zA-Z0-9_-]{6,80}$/.test(dispatchId ?? '')) {
      await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', dispatchStatus: 'unknown', error: 'orca_dispatch_unknown' });
      throw new ProviderError('orca_dispatch_unknown', 'Orca no confirmó el identificador del trabajador; revisa antes de iniciar otra ejecución.', { uncertain: true });
    }
    await ctx.reportStage?.({ key: role.stageKey, profile: role.name, label: role.label, runId, attempt: job.attempts, status: 'running', dispatchStatus: 'active', dispatchId, taskId });
  } else {
    await ctx.reportStage?.({ key: role.stageKey, runId, attempt: job.attempts, status: 'running', dispatchStatus: 'checking', dispatchId, taskId });
  }

  let settled = false;
  let stopping = false;
  await ctx.reportStage?.({ key: role.stageKey, status: 'running', runId, dispatchId, taskId });
  ctx.registerCleanup(async () => {
    if (settled || stopping) return;
    stopping = true;
    await jsonCommand(['orchestration', 'worker-stop', '--dispatch', dispatchId], ctx.root, undefined).catch(() => {});
  });
  while (!ctx.signal?.aborted) {
    let worker;
    try { worker = await command(['orchestration', 'worker-show', '--dispatch', dispatchId], ctx.root, ctx.signal); }
    catch (error) {
      await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', dispatchStatus: 'unknown', dispatchId, error: error.code ?? 'worker_status_unknown' });
      throw new ProviderError('orca_dispatch_status_unknown', `No se pudo confirmar el estado de ${role.name}; no se lanzará otro dispatch.`, { uncertain: true });
    }
    if (['start_unknown', 'unknown', 'abandoned', 'stopped'].includes(worker.state) || worker.state === 'rejected') {
      const dispatchStatus = ['abandoned', 'stopped', 'rejected'].includes(worker.state) ? worker.state : 'unknown';
      await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', dispatchStatus, dispatchId, error: `worker_${worker.state}` });
      throw new ProviderError('orca_dispatch_status_unknown', `El estado de ${role.name} es ${worker.state}; revisa Orca y no se iniciará un duplicado.`, { uncertain: true });
    }
    if (['succeeded', 'failed', 'cancelled', 'abandoned'].includes(worker.state)) {
      settled = true;
      if (worker.state !== 'succeeded') {
        await ctx.reportStage?.({ key: role.stageKey, status: 'failed', dispatchStatus: worker.state, dispatchId, error: `worker_${worker.state}` });
        throw new ProviderError('orca_worker_failed', `El perfil ${role.name} terminó en estado ${worker.state}; revisa su tarea Orca antes de reintentar.`, { uncertain: true });
      }
      let output = { ...worker, dispatchId, taskId: worker.taskId ?? taskId, runId };
      if (runId) {
        const inbox = await command(['orchestration', 'inbox', '--terminal', `run:${runId}`, '--limit', '30', '--full'], ctx.root, ctx.signal);
        output = { ...output, messages: inbox.messages };
      }
      if (!finalText(output)) {
        const transcript = await command(['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript', '--limit', '30'], ctx.root, ctx.signal);
        output = { ...output, transcript: transcript.transcript };
      }
      const text = finalText(output);
      if (!text) {
        await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', dispatchId, dispatchStatus: 'completed', error: 'orca_empty_result' });
        throw new ProviderError('orca_empty_result', `El perfil ${role.name} terminó sin una respuesta legible; revisa la tarea Orca.`, { uncertain: true });
      }
      const evidence = approvalEvidence(roleKey, text, dispatchId);
      await ctx.reportStage?.({
        key: role.stageKey, status: 'succeeded', runId, dispatchId,
        dispatchStatus: 'completed', taskId: worker.taskId, attempt: job.attempts,
        ...summarizeStage(text), ...evidence,
      });
      return { text, dispatchId, taskId: worker.taskId, ...evidence };
    }
    await waitForPoll(ctx.signal, 2_000);
  }
  throw ctx.signal.reason;
}

export function approved(text) {
  const finalLine = String(text ?? '').trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return finalLine === 'RESULTADO: APROBADO';
}
const brief = text => text.slice(0, 3500);
async function enforceGate(ctx, roleKey, output) {
  const persistedApproval = output.approvalOutcome === 'approved'
    && output.approvalDispatchId
    && output.approvalDispatchId === output.dispatchId;
  if (output.recovered ? persistedApproval : approved(output.text)) return;
  const role = ROLES[roleKey];
  await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', ...summarizeStage(output.text) });
  const sequence = ['ux', 'desarrollador', 'qa', 'revisor'];
  const blockedAt = sequence.indexOf(roleKey);
  for (const laterRole of sequence.slice(blockedAt + 1)) {
    const later = ROLES[laterRole];
    await ctx.reportStage?.({ key: later.stageKey, status: 'skipped', summary: `No iniciada: ${role.label} bloqueó la entrega.` });
  }
  throw new ProviderError('quality_gate_blocked', `${role.label} no aprobó la entrega; la cola queda pendiente de revisión y el informe está en el panel.`, { uncertain: false });
}

export async function runOrca(job, ctx, { command = jsonCommand } = {}) {
  const workspace = job.kind === 'code' ? await validateWorkspace(job, ctx.root) : path.join(ctx.root, 'analysis');
  if (job.kind === 'code' && job.branch) {
    if (job.autoIntent) await verifyGitHubDestination(ctx.root, job);
    else await inspectDestination(ctx.root, path.relative(ctx.root, workspace), job.branch);
  }
  await ensureRepo(workspace, job.kind === 'code' ? 'git' : 'folder', ctx.root, ctx.signal, command);
  const runId = await createJobRun(job, ctx, command);
  if (job.kind === 'analysis') {
    const result = await runStage(job, ctx, 'planificador', workspace, runId, 'Entrega un plan breve con pasos, criterios de aceptación y preguntas imprescindibles. No modifiques código ni archivos.', '', command);
    return { provider: 'orca-planificador', ...result };
  }
  if (job.kind !== 'code') throw new ProviderError('orca_unsupported_job', 'Tipo de trabajo no compatible con los perfiles Orca configurados.');

  const ux = await runStage(job, ctx, 'ux', workspace, runId, 'Prepara una especificación de UX para esta tarea, sin editar archivos. Si no hay interfaz que diseñar, indícalo y concreta las restricciones de consistencia con el producto.', '', command);
  const developer = await runStage(job, ctx, 'desarrollador', workspace, runId,
    'Implementa el encargo en el checkout aislado. Sigue la especificación UX cuando aplique; no cambies alcance ni dejes el resultado en un mockup.',
    `Especificación UX:\n${brief(ux.text)}`, command);
  const integrationSnapshot = job.autoIntent?.eligible === true ? await captureIntegrationSnapshot(workspace) : null;
  const qa = await runStage(job, ctx, 'qa', workspace, runId,
    'Valida los cambios sin editarlos. Revisa los scripts del proyecto y ejecuta comprobaciones acotadas y relevantes de tipos, lint, compilación y comportamiento; no instales paquetes ni uses red. No añadas ni ejecutes suites de pruebas salvo que el encargo lo solicite expresamente. Termina con una línea exacta RESULTADO: APROBADO o RESULTADO: BLOQUEADO. Si la validación falla, aporta el comando y el error reproducible.',
    `Resumen de implementación:\n${brief(developer.text)}`, command);
  await enforceGate(ctx, 'qa', qa);
  const review = await runStage(job, ctx, 'revisor', workspace, runId,
    'Haz una revisión independiente y de solo lectura del diff, el encargo, la especificación UX y la evidencia de QA. Busca defectos funcionales, accesibilidad, regresiones y omisiones; no edites. Termina con una línea exacta RESULTADO: APROBADO o RESULTADO: BLOQUEADO.',
    `Especificación UX:\n${brief(ux.text)}\n\nImplementación:\n${brief(developer.text)}\n\nQA:\n${brief(qa.text)}`, command);
  await enforceGate(ctx, 'revisor', review);
  let integration = { status: 'skipped', reason: 'not_eligible' };
  if (job.autoIntent?.eligible === true) {
    await ctx.reportStage?.({ key: 'integration', status: 'running', summary: 'Revisión aprobada; preparando preflight de integración.' });
    try {
      integration = await integrateGitHubDefault({ ...job, integrationSnapshot }, ctx, { previous: await readIntegration(ctx.root, job.autoIntent.receiptId), persist: record => persistIntegration(ctx.root, record) });
      if (integration?.phase !== 'complete') throw new Error('La integración no confirmó su estado terminal remoto; necesita revisión.');
    } catch (error) {
      const prior = await readIntegration(ctx.root, job.autoIntent.receiptId);
      const record = { ...(prior || {}), jobId: job.id, receiptId: job.autoIntent.receiptId, status: 'needs_attention', needsAttention: true, error: error.message, updatedAt: new Date().toISOString() };
      await persistIntegration(ctx.root, record);
      await ctx.reportStage?.({ key: 'integration', status: 'blocked', summary: error.message, error: 'integration_needs_attention' });
      error.uncertain = true;
      error.code ||= 'github_integration_needs_attention';
      throw error;
    }
  } else if (job.workflow?.steps?.some(step => step.key === 'integration')) {
    await ctx.reportStage?.({ key: 'integration', status: 'skipped', summary: 'Recibo ausente o no elegible; integración omitida.' });
  }
  return {
    provider: 'orca-quality-workflow',
    runId,
    dispatchId: review.dispatchId,
    taskId: review.taskId,
    stages: { ux: ux.dispatchId, developer: developer.dispatchId, qa: qa.dispatchId, reviewer: review.dispatchId },
    integration,
    text: [`UX:\n${ux.text}`, `Implementación:\n${developer.text}`, `QA:\n${qa.text}`, `Revisión:\n${review.text}`].join('\n\n'),
  };
}
