import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ProviderError, validateWorkspace } from './providers.mjs';

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

async function ensureRepo(workspace, kind, cwd, signal) {
  const repos = await jsonCommand(['repo', 'list'], cwd, signal);
  const known = repos.repos?.some((repo) => path.resolve(repo.path).toLowerCase() === workspace.toLowerCase());
  if (!known) await jsonCommand(['repo', 'add', '--path', workspace, '--kind', kind], cwd, signal);
}

function finalText(result) {
  const completion = result.messages?.find((message) => {
    if (message.type !== 'worker_done' || !message.body?.trim()) return false;
    try {
      const payload = JSON.parse(message.payload ?? '{}');
      return payload.dispatchId === result.dispatchId || payload.taskId === result.taskId;
    } catch { return false; }
  });
  if (completion) return completion.body.trim();
  const messages = result.transcript?.messages ?? [];
  const candidates = messages.filter((message) => message.role === 'assistant').flatMap((message) => message.blocks ?? []).filter((block) => block.type === 'text' && block.text?.trim());
  return candidates.at(-1)?.text?.trim() ?? '';
}

function waitForPoll(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runStage(job, ctx, roleKey, workspace, instruction, prior = '') {
  const role = ROLES[roleKey];
  const profilePath = path.join(PROFILE_DIR, `${role.name}.toml`);
  let profile;
  try { profile = profileInstructions(await fs.readFile(profilePath, 'utf8')); }
  catch { throw new ProviderError('orca_profile_missing', `No existe el perfil Orca configurado: ${role.name}.`); }
  await ctx.reportStage?.({ key: role.stageKey, profile: role.name, label: role.label, status: 'running' });
  const spec = [
    `PERFIL EXISTENTE: ${role.name}. Respeta el alcance del perfil y no crees ni delegues en otros agentes.`,
    profile,
    `EMPRESA: ${job.business}.`,
    `TAREA: ${job.title}.`,
    `ENCARGO Y CRITERIO DE ÉXITO:\n${job.prompt}`,
    prior ? `RESULTADOS DE ETAPAS ANTERIORES:\n${prior}` : '',
    instruction,
    job.kind === 'code' ? 'Usa exclusivamente el checkout aislado asignado. No hagas commit, push, merge, publicación ni despliegue.' : 'Es una tarea de análisis: no cambies código ni archivos.',
  ].filter(Boolean).join('\n\n');
  let started;
  try {
    started = await jsonCommand([
      'orchestration', 'worker-start', '--spec', spec, '--agent', 'codex', '--model', role.model,
      '--effort', role.effort, '--worktree', `path:${workspace}`, '--task-title', `${job.title} — ${role.label}`,
      '--display-name', `${role.name}: ${job.title}`,
    ], ctx.root, ctx.signal);
  } catch (error) {
    await ctx.reportStage?.({ key: role.stageKey, status: 'failed', error: error.code ?? 'orca_start_failed' });
    throw error;
  }
  const dispatchId = started.dispatchId ?? started.dispatch?.dispatchId;
  if (!dispatchId) {
    await ctx.reportStage?.({ key: role.stageKey, status: 'failed', error: 'orca_dispatch_unknown' });
    throw new ProviderError('orca_dispatch_unknown', 'Orca no confirmó el identificador del trabajador; la tarea requiere revisión manual.', { uncertain: true });
  }

  let settled = false;
  let stopping = false;
  await ctx.reportStage?.({ key: role.stageKey, status: 'running', dispatchId, taskId: started.taskId ?? started.task?.id });
  ctx.registerCleanup(async () => {
    if (settled || stopping) return;
    stopping = true;
    await jsonCommand(['orchestration', 'worker-stop', '--dispatch', dispatchId], ctx.root, undefined).catch(() => {});
  });
  while (!ctx.signal?.aborted) {
    const worker = await jsonCommand(['orchestration', 'worker-show', '--dispatch', dispatchId], ctx.root, ctx.signal);
    if (['succeeded', 'failed', 'cancelled', 'abandoned'].includes(worker.state)) {
      settled = true;
      if (worker.state !== 'succeeded') {
        await ctx.reportStage?.({ key: role.stageKey, status: 'failed', dispatchId, error: `worker_${worker.state}` });
        throw new ProviderError('orca_worker_failed', `El perfil ${role.name} terminó en estado ${worker.state}; revisa su tarea Orca antes de reintentar.`, { uncertain: true });
      }
      let output = { ...worker, dispatchId, taskId: worker.taskId };
      if (worker.runId) {
        const inbox = await jsonCommand(['orchestration', 'inbox', '--terminal', `run:${worker.runId}`, '--limit', '30', '--full'], ctx.root, ctx.signal);
        output = { ...output, messages: inbox.messages };
      }
      if (!finalText(output)) {
        const transcript = await jsonCommand(['orchestration', 'worker-read', '--dispatch', dispatchId, '--source', 'transcript', '--limit', '30'], ctx.root, ctx.signal);
        output = { ...output, transcript: transcript.transcript };
      }
      const text = finalText(output);
      if (!text) {
        await ctx.reportStage?.({ key: role.stageKey, status: 'failed', dispatchId, error: 'orca_empty_result' });
        throw new ProviderError('orca_empty_result', `El perfil ${role.name} terminó sin una respuesta legible; revisa la tarea Orca.`, { uncertain: true });
      }
      await ctx.reportStage?.({ key: role.stageKey, status: 'succeeded', dispatchId, taskId: worker.taskId, summary: text.slice(0, 6000) });
      return { text, dispatchId, taskId: worker.taskId };
    }
    await waitForPoll(ctx.signal, 2_000);
  }
  throw ctx.signal.reason;
}

function approved(text) { return /^RESULTADO:\s*APROBADO\s*$/im.test(text); }
const brief = text => text.slice(0, 3500);
async function enforceGate(ctx, roleKey, output) {
  if (approved(output.text)) return;
  const role = ROLES[roleKey];
  await ctx.reportStage?.({ key: role.stageKey, status: 'blocked', summary: output.text.slice(0, 6000) });
  const sequence = ['ux', 'desarrollador', 'qa', 'revisor'];
  const blockedAt = sequence.indexOf(roleKey);
  for (const laterRole of sequence.slice(blockedAt + 1)) {
    const later = ROLES[laterRole];
    await ctx.reportStage?.({ key: later.stageKey, status: 'skipped', summary: `No iniciada: ${role.label} bloqueó la entrega.` });
  }
  throw new ProviderError('quality_gate_blocked', `${role.label} no aprobó la entrega; la cola queda pendiente de revisión y el informe está en el panel.`, { uncertain: false });
}

export async function runOrca(job, ctx) {
  const workspace = job.kind === 'code' ? await validateWorkspace(job, ctx.root) : path.join(ctx.root, 'analysis');
  await ensureRepo(workspace, job.kind === 'code' ? 'git' : 'folder', ctx.root, ctx.signal);
  if (job.kind === 'analysis') {
    const result = await runStage(job, ctx, 'planificador', workspace, 'Entrega un plan breve con pasos, criterios de aceptación y preguntas imprescindibles. No modifiques código ni archivos.');
    return { provider: 'orca-planificador', ...result };
  }
  if (job.kind !== 'code') throw new ProviderError('orca_unsupported_job', 'Tipo de trabajo no compatible con los perfiles Orca configurados.');

  const ux = await runStage(job, ctx, 'ux', workspace, 'Prepara una especificación de UX para esta tarea, sin editar archivos. Si no hay interfaz que diseñar, indícalo y concreta las restricciones de consistencia con el producto.');
  const developer = await runStage(job, ctx, 'desarrollador', workspace,
    'Implementa el encargo en el checkout aislado. Sigue la especificación UX cuando aplique; no cambies alcance ni dejes el resultado en un mockup.',
    `Especificación UX:\n${brief(ux.text)}`);
  const qa = await runStage(job, ctx, 'qa', workspace,
    'Valida los cambios sin editarlos. Revisa los scripts del proyecto y ejecuta comprobaciones acotadas y relevantes de tipos, lint, compilación y comportamiento; no instales paquetes ni uses red. No añadas ni ejecutes suites de pruebas salvo que el encargo lo solicite expresamente. Termina con una línea exacta RESULTADO: APROBADO o RESULTADO: BLOQUEADO. Si la validación falla, aporta el comando y el error reproducible.',
    `Resumen de implementación:\n${brief(developer.text)}`);
  await enforceGate(ctx, 'qa', qa);
  const review = await runStage(job, ctx, 'revisor', workspace,
    'Haz una revisión independiente y de solo lectura del diff, el encargo, la especificación UX y la evidencia de QA. Busca defectos funcionales, accesibilidad, regresiones y omisiones; no edites. Termina con una línea exacta RESULTADO: APROBADO o RESULTADO: BLOQUEADO.',
    `Especificación UX:\n${brief(ux.text)}\n\nImplementación:\n${brief(developer.text)}\n\nQA:\n${brief(qa.text)}`);
  await enforceGate(ctx, 'revisor', review);
  return {
    provider: 'orca-quality-workflow',
    dispatchId: review.dispatchId,
    taskId: review.taskId,
    stages: { ux: ux.dispatchId, developer: developer.dispatchId, qa: qa.dispatchId, reviewer: review.dispatchId },
    text: [`UX:\n${ux.text}`, `Implementación:\n${developer.text}`, `QA:\n${qa.text}`, `Revisión:\n${review.text}`].join('\n\n'),
  };
}
