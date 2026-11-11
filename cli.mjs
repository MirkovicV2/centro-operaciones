#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addJob, addJobStage, loadState, runQueue, setBudget, retryJob, increaseJobAttemptLimit, resolveJob, cancelQueuedJob, routeJob, reconcileOrcaJob, reconcileCodeJob, verifyOrcaWorkerRecord, verifyOrcaRunRecords, verifyOrcaApprovalTranscript, retractFalseSuccess, completeReviewedCodeJob, summarize, QueueError, actorContext } from './queue.mjs';
import { reconcileOwnerMergedIntegration } from './auto-run.mjs';
import { createWorker } from './providers.mjs';
import { ORCA_EXE, configuredOrcaAgent } from './local-tools.mjs';
import { readPipeline, previewPipeline, previewText } from './pipeline-config.mjs';
import { readQuota } from './quota.mjs';
import { skillsStatus, acceptSkill } from './skills-registry.mjs';
import { readSharedMemory, proposeLesson, listProposals, acceptLesson } from './project-knowledge.mjs';
import { readLaunchLevels, LAUNCH_LEVELS, DEFAULT_LAUNCH_LEVELS } from './orca-provider.mjs';
import { installLocalConfig } from './instalacion.mjs';
import { linkCoordinator } from './panel/coordinator-link.mjs';
import { verifyReconciliationDestination } from './reconciliation-destination.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HELP = `Centro de operaciones local — videojuegos (games) y agencia (agency)

node cli.mjs status
node cli.mjs instalar [--sin-pipeline]
  Crea en data/ lo que falte de la configuración compartida del equipo (reparto de modelos por etapa e identidad de este PC). No sobrescribe nada.
node cli.mjs vincular --business agency|games --run run_ID [--id ID] [--name "Nombre"]
  Escribe data/coordinator-bindings.json con el propietario de esa Run según Orca (y su terminal, si está conectada). Guarda una copia del archivo anterior.
node cli.mjs add --business games|agency --kind analysis|code --title "Título" --prompt-file "instruccion.txt" [--id identificador]
  [--provider orca|auto|api|codex] [--max-attempts 1-5] [--timeout-seconds SEGUNDOS] [--max-usd 0.10]
  Intentos por defecto: Orca 5; otros proveedores 2. Orca no tiene límite de duración por defecto.
  Código: --workspace "${path.join(ROOT, 'workspaces', 'checkout-aislado')}" --isolated [--branch RAMA_OBSERVADA]
  Criterios: --acceptance-file "criterios.json" (lista JSON de criterios, o un criterio por línea en texto plano)
  Reparto de este encargo: --launch-file "reparto.json" ({"roles":{"desarrollador":{"agent":"claude","model":"sonnet","effort":"high"},"qa":{"agent":"codex","effort":"high"}}})
  Ruta de un trabajo de código: --route interfaz|funcional|documentacion [--reason "por qué"] (por defecto interfaz: Diseño → Desarrollo → QA → Revisión;
  funcional y documentacion omiten Diseño y exigen el motivo; QA y Revisión nunca se omiten. docs/RUTAS.md)
  Skills de este encargo: --skills-file "skills.json" ({"add":["web-testing"],"remove":["frontend-design"]}; las obligatorias no se retiran)
  Recursos que necesita el PC que lo ejecute: --requires godot,emuladorAndroid,telefonoFisico,gpu,navegador (docs/EQUIPOS.md)
node cli.mjs skills                    Estado de cada skill del registro frente a su huella (docs/SKILLS.md)
node cli.mjs skills-accept --id SKILL  Tras revisar un cambio, registra las nuevas huellas de esa skill
node cli.mjs memory --business games|agency --title "Nombre del proyecto"          Memoria compartida del proyecto y propuestas locales (docs/MEMORIA.md)
node cli.mjs memory-propose --business … --title "Proyecto" --evidence-file "leccion.json"   Propone una lección (queda local, sin efecto)
node cli.mjs memory-accept --business … --title "Proyecto" --id LECCION --confirm-reviewed   Comprueba procedencia y referencias y la incorpora a memoria/
node cli.mjs add-stage --id IDENTIFICADOR --stage ux --reason "por qué cambia el alcance"
  Añade Diseño a un trabajo cuya ruta lo omitía, mientras Desarrollo no tenga asignación.
node cli.mjs preview --business games|agency --kind analysis|code [--project ID_PROYECTO] [--launch-file "reparto.json"]
  Muestra con qué agente, modelo y esfuerzo se lanzaría cada etapa. No crea el encargo ni lanza nada (docs/PIPELINE_CONFIG.md).
node cli.mjs run                       Simulación: no ejecuta trabajadores ni modifica estado
node cli.mjs run --execute [--max-jobs 5] [--id IDENTIFICADOR]
  Con el panel abierto en el puerto configurado (CENTRO_OPERATIONS_PORT, 4187 por defecto) la CLI no despacha:
  Orca admite un consumidor por Run y rechazaría el worker-start con consumer_fenced. Usa el panel o ciérralo antes.
node cli.mjs show --id IDENTIFICADOR
node cli.mjs route --id IDENTIFICADOR --provider orca
node cli.mjs reconcile --id IDENTIFICADOR --dispatch-id ctx_... --evidence-file "resultado.md" --confirm-reviewed
node cli.mjs reconcile-code --id IDENTIFICADOR --decision-file "decision.json" --confirm-reviewed
  Verifica cada dispatch y las aprobaciones QA/Revisión en Orca antes de registrar la decisión.
node cli.mjs retry --id IDENTIFICADOR --confirm-reviewed
  Con otro proveedor: añade --substitute codex|claude --reason "por qué". Solo si el trabajador anterior terminó de forma confirmada;
  conserva sus efectos y su informe (docs/CUOTA.md).
node cli.mjs attempt-limit --id IDENTIFICADOR --max-attempts 5
node cli.mjs resolve --id IDENTIFICADOR --confirm-reviewed
node cli.mjs cancel --id IDENTIFICADOR --confirm-reviewed   Solo trabajos en cola que no han arrancado nunca
node cli.mjs retract --id IDENTIFICADOR --confirm-reviewed
node cli.mjs reconcile-owner-merge --id IDENTIFICADOR --confirm-reviewed   La PR de integración la fusionaste tú: la comprueba en GitHub y cierra el trabajo como integrado
node cli.mjs complete --id IDENTIFICADOR --evidence-file "informe.md" --confirm-reviewed
node cli.mjs budget --usd LIMITE_TOTAL --model MODELO --input-per-million TARIFA --output-per-million TARIFA

No se ejecuta nada en segundo plano. El presupuesto API inicial es 0 USD.
Las tarifas y el gasto mostrado son estimaciones locales; consulta el consumo del proveedor.
Las instrucciones se guardan localmente. Nunca incluyas claves o contraseñas.
`;
const FLAGS = new Set(['execute', 'isolated', 'confirm-reviewed', 'help', 'sin-pipeline']);
const KNOWN = new Set([...FLAGS, 'business', 'kind', 'title', 'prompt-file', 'id', 'evidence-file', 'decision-file', 'dispatch-id', 'provider', 'max-attempts', 'timeout-seconds', 'max-usd', 'workspace', 'branch', 'acceptance-file', 'launch-file', 'project', 'route', 'reason', 'stage', 'skills-file', 'substitute', 'requires', 'max-jobs', 'usd', 'model', 'input-per-million', 'output-per-million', 'run', 'name']);
function parse(args) {
  const command = args.shift() ?? 'help';
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !KNOWN.has(flag.slice(2))) throw new QueueError(`Opción desconocida: ${flag}`);
    const key = flag.slice(2);
    if (key in options) throw new QueueError(`Opción repetida: ${flag}`);
    if (FLAGS.has(key)) options[key] = true;
    else { if (!args.length || args[0].startsWith('--')) throw new QueueError(`Falta el valor de ${flag}.`); options[key] = args.shift(); }
  }
  return { command, options };
}
async function readLaunchFile(file) {
  if (!file) return undefined;
  const launchPath = path.resolve(file);
  if ((await fs.stat(launchPath)).size > 8_000) throw new QueueError('El archivo de reparto supera los 8.000 bytes.');
  try { return JSON.parse((await fs.readFile(launchPath, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new QueueError('El archivo de reparto no es JSON válido.', 'launch_choice_invalid'); }
}
const numeric = (value, fallback) => value === undefined ? fallback : Number(value);

// 6 (F5): the CLI accepts the same structured criteria as the coordinated path.
// A JSON array of strings, or one criterion per non-empty line of plain text.
export function parseAcceptanceFile(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!source) throw new QueueError('El archivo de criterios está vacío.');
  let items;
  if (source.startsWith('[') || source.startsWith('{')) {
    try { items = JSON.parse(source); } catch { throw new QueueError('El archivo de criterios no es una lista JSON válida.'); }
    if (!Array.isArray(items)) throw new QueueError('El archivo de criterios debe ser una lista JSON de cadenas.');
  } else items = source.split(/\r?\n/).map(line => line.replace(/^\s*(?:\d+[.)]|[-*+•])\s+/, '').trim()).filter(Boolean);
  if (!items.length || items.length > 50 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 2000 || /[\r\n]/.test(item))) {
    throw new QueueError('Los criterios deben ser entre 1 y 50 cadenas de una línea, de hasta 2000 caracteres.');
  }
  const normalized = items.map(item => item.trim());
  if (new Set(normalized.map(item => item.replace(/\s+/g, ' ').toLowerCase())).size !== normalized.length) throw new QueueError('Los criterios no pueden repetirse.');
  return normalized;
}
export function validateBranchOption(branch) {
  if (branch === undefined) return undefined;
  const value = String(branch).trim();
  if (!value || value.length > 200 || value.includes('..') || /[\\\x00\r\n\s~^:?*[]/.test(value) || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.lock')) {
    throw new QueueError('--branch debe ser una rama Git válida existente en el checkout.');
  }
  return value;
}

// 16 + 19: Orca accepts one consumer per Run. A live panel already consumes the
// configured Runs, so a CLI dispatch would be fenced (consumer_fenced) after
// creating state. Probe the panel port first and explain instead of dispatching.
export function panelPort(env = process.env) {
  const port = Number(env.CENTRO_OPERATIONS_PORT || 4187);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 4187;
}
export function probePanel(port, { timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: timeoutMs, agent: false, headers: { host: `127.0.0.1:${port}` } }, response => {
      response.resume();
      resolve({ alive: true, status: response.statusCode });
    });
    request.on('timeout', () => { request.destroy(); resolve({ alive: false, reason: 'timeout' }); });
    request.on('error', error => resolve({ alive: false, reason: error.code || 'error' }));
  });
}
export async function assertPanelNotRunning({ port = panelPort(), probe = probePanel } = {}) {
  const result = await probe(port);
  if (!result?.alive) return { port, alive: false };
  throw new QueueError(`El panel está abierto en http://127.0.0.1:${port}. Orca admite un único consumidor por Run y rechazaría este despacho con consumer_fenced tras crear estado. Usa el panel para ejecutar o ciérralo antes de run --execute.`, 'panel_active');
}
const runRecordsCache = new Map();

export function reconcileCodeSummary(job) {
  return {
    id: job.id,
    state: job.state,
    workflow: { status: job.workflow?.status ?? null, currentStage: job.workflow?.currentStage ?? null },
    branch: job.branch ?? null,
    destination: { branch: job.destination?.branch ?? null, sha: job.destination?.sha ?? null },
    deliveryStatus: job.deliveryStatus ?? null,
    decisionId: job.reconciliationDecisionId ?? null,
    dispatchIds: (job.coordinatorDecision?.dispatches ?? []).map(item => item.dispatchId),
  };
}

function orcaJsonResult(args) {
  const executable = ORCA_EXE;
  const result = spawnSync(executable, ['orchestration', ...args, '--json'], {
    encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new QueueError('No se pudo verificar la evidencia de Orca; no se modificó el ledger.', 'reconciliation_orca_unavailable');
  let response;
  try { response = JSON.parse(result.stdout); }
  catch { throw new QueueError('Orca devolvió evidencia ilegible; no se modificó el ledger.', 'reconciliation_orca_unavailable'); }
  if (response.ok !== true || !response.result) throw new QueueError('Orca no pudo confirmar la evidencia del dispatch; no se modificó el ledger.', 'reconciliation_orca_unavailable');
  return response.result;
}

function getOrcaRunRecords(runId) {
  if (!runRecordsCache.has(runId)) {
    const inbox = orcaJsonResult(['inbox', '--terminal', `run:${runId}`, '--limit', '500', '--full']);
    const taskList = orcaJsonResult(['task-list', '--run', runId, '--full']);
    runRecordsCache.set(runId, { inbox, taskList });
  }
  return runRecordsCache.get(runId);
}

async function verifyOrcaDispatch(evidence, { relatedDispatches } = {}) {
  const observed = orcaJsonResult(['worker-show', '--dispatch', evidence.dispatchId, '--full']);
  const workerRecord = verifyOrcaWorkerRecord(evidence, observed);
  const approvalRequired = evidence.state === 'succeeded' && ['qa', 'reviewer'].includes(evidence.stage);
  const transcriptApproval = approvalRequired && await verifyOrcaApprovalTranscript(evidence.dispatchId, evidence.state,
    async ({ dispatchId, cursor }) => orcaJsonResult(['worker-read', '--dispatch', dispatchId, '--source', 'transcript', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]),
    { evidence, includeDelivery: true });
  const runRecord = verifyOrcaRunRecords(evidence, { ...getOrcaRunRecords(evidence.runId), terminalHandle: workerRecord.terminalHandle, relatedDispatches, approvalTranscriptVerified: transcriptApproval?.approved === true });
  if (runRecord.delivery && transcriptApproval?.delivery && JSON.stringify(runRecord.delivery) !== JSON.stringify(transcriptApproval.delivery)) {
    throw new QueueError('El recibo estructurado contradice al transcript final.', 'reconciliation_approval_unverified');
  }
  return { ...workerRecord, ...runRecord, ...(transcriptApproval?.delivery ? { delivery: transcriptApproval.delivery } : {}) };
}

async function main() {
  const { command, options: o } = parse(process.argv.slice(2));
  if (command === 'help' || o.help) { console.log(HELP); return; }
  let result;
  switch (command) {
    case 'status': result = summarize(await loadState(ROOT)); break;
    case 'show': {
      result = (await loadState(ROOT)).jobs.find(job => job.id === o.id);
      if (!result) throw new QueueError('No se encontró el trabajo.');
      break;
    }
    case 'route': result = await routeJob(ROOT, o.id, o.provider); break;
    case 'reconcile': {
      if (!o['evidence-file']) throw new QueueError('Indica --evidence-file con el resultado revisado de Orca.');
      const evidencePath = path.resolve(o['evidence-file']);
      if ((await fs.stat(evidencePath)).size > 12_000) throw new QueueError('La evidencia supera los 12.000 bytes.');
      result = await reconcileOrcaJob(ROOT, o.id, { dispatchId: o['dispatch-id'], confirm: !!o['confirm-reviewed'], evidence: await fs.readFile(evidencePath, 'utf8') });
      break;
    }
    case 'reconcile-code': {
      if (!o['decision-file']) throw new QueueError('Indica --decision-file con la decisión explícita del coordinador.');
      const decisionPath = path.resolve(o['decision-file']);
      const decisionStat = await fs.stat(decisionPath);
      if (decisionStat.size > 24_000) throw new QueueError('El manifiesto de decisión supera los 24.000 bytes.');
      let decision;
      try { decision = JSON.parse(await fs.readFile(decisionPath, 'utf8')); }
      catch { throw new QueueError('El manifiesto de decisión no contiene JSON válido.', 'reconciliation_invalid'); }
      result = await reconcileCodeJob(ROOT, o.id, { decision, confirm: !!o['confirm-reviewed'], verifyDispatch: verifyOrcaDispatch, verifyDestination: verifyReconciliationDestination });
      break;
    }
    case 'instalar': {
      const report = await installLocalConfig(ROOT, { pipeline: !o['sin-pipeline'] });
      for (const file of report.created) console.log(`creado: ${file}`);
      for (const file of report.kept) console.log(`ya existía (sin tocar): ${file}`);
      for (const text of report.notes) console.log(`aviso: ${text}`);
      return;
    }
    case 'vincular': {
      let linked;
      try { linked = await linkCoordinator(ROOT, { business: o.business, runId: o.run, id: o.id, name: o.name }); }
      catch (error) { if (String(error.code ?? '').startsWith('link_')) throw new QueueError(error.message, error.code); throw error; }
      console.log(linked.changed ? `vinculado: ${linked.coordinator} (${linked.business}) → Run ${linked.runId}, terminal ${linked.senderId}` : `sin cambios: ${linked.coordinator} ya apuntaba a ${linked.runId}`);
      if (linked.backup) console.log(`copia del archivo anterior: ${linked.backup}`);
      console.log('Comprueba la conexión con curl -fsS http://127.0.0.1:4187/api/coordinators (el panel lee el archivo en cada envío).');
      return;
    }
    case 'preview': {
      try {
        const preview = previewPipeline({ business: o.business, kind: o.kind, projectId: o.project ?? null, launch: await readLaunchFile(o['launch-file']),
          levels: await readLaunchLevels(ROOT), pipeline: await readPipeline(ROOT, { levelNames: LAUNCH_LEVELS }), defaultAgent: configuredOrcaAgent(), fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles,
          quota: await readQuota(ROOT).catch(() => null) });
        console.log(previewText(preview));
      } catch (error) {
        // Configuration messages name a file and a field, never a secret: show them as they are.
        if (['pipeline_config_invalid', 'launch_choice_invalid', 'launch_levels_invalid'].includes(error.code)) throw new QueueError(error.message, error.code);
        throw error;
      }
      return;
    }
    case 'add': {
      if (!o['prompt-file']) throw new QueueError('Indica --prompt-file con la instrucción del trabajo.');
      const promptPath = path.resolve(o['prompt-file']);
      if ((await fs.stat(promptPath)).size > 12_000) throw new QueueError('La instrucción supera los 12.000 bytes.');
      const timeoutSeconds = o['timeout-seconds'] === undefined && (o.provider ?? 'orca') === 'orca'
        ? null : numeric(o['timeout-seconds'], 180);
      let acceptance;
      if (o['acceptance-file']) {
        const acceptancePath = path.resolve(o['acceptance-file']);
        if ((await fs.stat(acceptancePath)).size > 64_000) throw new QueueError('El archivo de criterios supera los 64.000 bytes.');
        acceptance = parseAcceptanceFile(await fs.readFile(acceptancePath, 'utf8'));
      }
      const launch = await readLaunchFile(o['launch-file']);
      const branch = validateBranchOption(o.branch);
      if (branch && o.kind !== 'code') throw new QueueError('--branch solo aplica a trabajos de código.');
      result = await addJob(ROOT, { id: o.id, business: o.business, kind: o.kind, title: o.title, prompt: await fs.readFile(promptPath, 'utf8'), provider: o.provider, workspace: o.workspace, isolated: o.isolated, maxAttempts: numeric(o['max-attempts'], undefined), timeoutMs: timeoutSeconds === null ? undefined : timeoutSeconds * 1000, maxUsd: numeric(o['max-usd'], 0.1),
        ...(branch ? { branch } : {}), ...(acceptance ? { contract: { version: 1, acceptance } } : {}), ...(launch ? { launch } : {}), ...(o.route ? { route: { id: o.route, reason: o.reason } } : {}), ...(o['skills-file'] ? { skills: await readLaunchFile(o['skills-file']) } : {}), ...(o.requires ? { requires: o.requires.split(',').map(item => item.trim()).filter(Boolean) } : {}) });
      break;
    }
    case 'run':
      if (o.execute) await assertPanelNotRunning();
      result = await runQueue(ROOT, { execute: !!o.execute, worker: createWorker(), maxJobs: numeric(o['max-jobs'], 5), jobId: o.id });
      break;
    case 'memory':
    case 'memory-propose':
    case 'memory-accept': {
      try {
        const scope = { business: o.business, projectName: o.title };
        if (!['agency', 'games'].includes(o.business) || !o.title) throw new QueueError('Indica --business y --title con el nombre del proyecto.');
        if (command === 'memory') result = { memoria: await readSharedMemory(scope), propuestas: await listProposals(ROOT, scope) };
        else if (command === 'memory-propose') {
          if (!o['evidence-file']) throw new QueueError('Indica --evidence-file con la lección en JSON.');
          result = await proposeLesson(ROOT, { ...scope, lesson: JSON.parse((await fs.readFile(path.resolve(o['evidence-file']), 'utf8')).replace(/^\uFEFF/, '')) });
        } else {
          if (!o['confirm-reviewed']) throw new QueueError('Revisa la propuesta y usa --confirm-reviewed para incorporarla a la memoria compartida.');
          const { loadDashboardState } = await import('./panel/agency-assistant/dashboard-state.mjs');
          const project = (await loadDashboardState(ROOT)).projects.find(item => item.business === o.business && item.name.toLowerCase() === o.title.toLowerCase());
          result = await acceptLesson(ROOT, { ...scope, id: o.id, jobs: (await loadState(ROOT)).jobs, projectId: project?.id ?? null,
            checkout: project?.checkout ? path.resolve(ROOT, project.checkout) : null, acceptedBy: `cli:${os.userInfo().username}` });
        }
      } catch (error) { if (String(error.code ?? '').startsWith('project_memory')) throw new QueueError(error.message, error.code); throw error; }
      break;
    }
    case 'skills':
    case 'skills-accept': {
      try { result = command === 'skills-accept' ? await acceptSkill(o.id) : (await skillsStatus()).map(({ manifest, ...skill }) => ({ ...skill, manifest: manifest.slice(0, 12) })); }
      catch (error) { if (String(error.code ?? '').startsWith('skill_')) throw new QueueError(error.message, error.code); throw error; }
      break;
    }
    case 'add-stage': result = await addJobStage(ROOT, o.id, { stage: o.stage, reason: o.reason }); break;
    case 'retry': result = await retryJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'], ...(o.substitute ? { substitute: o.substitute, reason: o.reason } : {}) }); break;
    case 'attempt-limit': {
      const job = await increaseJobAttemptLimit(ROOT, o.id, numeric(o['max-attempts'], NaN));
      result = { id: job.id, state: job.state, attempts: job.attempts, maxAttempts: job.maxAttempts };
      break;
    }
    case 'cancel': result = await cancelQueuedJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'resolve': result = await resolveJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'reconcile-owner-merge': result = await reconcileOwnerMergedIntegration(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'retract': result = await retractFalseSuccess(ROOT, o.id, { confirm: !!o['confirm-reviewed'] }); break;
    case 'complete': {
      if (!o['evidence-file']) throw new QueueError('Indica --evidence-file con el informe de entrega revisada.');
      const evidencePath = path.resolve(o['evidence-file']);
      if ((await fs.stat(evidencePath)).size > 12_000) throw new QueueError('El informe supera los 12.000 bytes.');
      result = await completeReviewedCodeJob(ROOT, o.id, { confirm: !!o['confirm-reviewed'], evidence: await fs.readFile(evidencePath, 'utf8') });
      break;
    }
    case 'budget': result = await setBudget(ROOT, { limitUsd: numeric(o.usd, NaN), model: o.model, inputPerMillion: numeric(o['input-per-million'], NaN), outputPerMillion: numeric(o['output-per-million'], NaN) }); break;
    default: throw new QueueError('Comando desconocido. Usa node cli.mjs help.');
  }
  console.log(JSON.stringify(command === 'reconcile-code' ? reconcileCodeSummary(result) : result, null, 2));
  if (command === 'run' && o.execute && (result.blockedNeedsAttention?.length || result.jobs?.some(job => job.state === 'needs_attention'))) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) actorContext.run({ actor: `cli:${os.userInfo().username}`, role: 'admin' }, main).catch(error => {
  // Do not print raw provider bodies, process stderr, environment, or credentials.
  console.error(JSON.stringify({ error: error.code || 'operation_failed', message: error instanceof QueueError ? error.message : 'No se pudo completar la operación local. Comprueba archivos, permisos y opciones.' }));
  process.exitCode = 1;
});
