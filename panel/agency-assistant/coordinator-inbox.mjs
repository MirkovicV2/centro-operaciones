import { createHash } from 'node:crypto';
import path from 'node:path';
import { confirmSubmission, readAutoRun } from '../../auto-run.mjs';
import { acceptanceFromSuccessCriteria, productJobContract } from '../../workflow-contract.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { loadDashboardState, changeDashboardState, recordJobConfirmation } from './dashboard-state.mjs';
import { loadState } from '../queue.mjs';
import { notifyCoordinatorRequest } from '../coordinator-bridge.mjs';
import { withInboxLock } from './inbox-lock.mjs';
import { validateJobLaunch } from '../../launch-choice.mjs';
import { validateJobRoute } from '../../job-route.mjs';
import { deliverCoordinatorNotice } from './coordinator-notice.mjs';
import { assertCoordinatorQuestionsAnswered, coordinatorDecisions, coordinatorJobLink, checkCoordinatorAnswerNotices } from './coordinator-dialogue.mjs';

const pending = new Map();
const routes = new Map();
const keyFor = value => `coord-${createHash('sha256').update(String(value)).digest('hex').slice(0, 32)}`;
const confirmationValue = value => value ? { ...Object.fromEntries(['projectId', 'checkout', 'branch', 'baseBranch', 'objective', 'successCriteria'].map(key => [key, value[key] || ''])), ...(Object.hasOwn(value, 'productAcceptance') ? { productAcceptance: value.productAcceptance } : {}) } : null;

export function submitTaskToCoordinator(root, input, { notify = notifyCoordinatorRequest } = {}) {
  const operationId = String(input.operationId || '').trim();
  const business = String(input.business || '');
  const intent = input.intent || 'task';
  if (!['task', 'consultation'].includes(intent)) return Promise.reject(new Error('Intención de solicitud inválida.'));
  const consultation = intent === 'consultation';
  if (consultation && (input.kind === 'code' || input.confirmation)) return Promise.reject(new Error('Una consulta directa no confirma código ni un destino de ejecución.'));
  const text = String(input.prompt || (consultation ? input.text : '') || '').trim();
  const title = String(input.title || (consultation ? text.split(/\r?\n/)[0].slice(0, 160) : '')).trim();
  const successCriteria = String(input.successCriteria || (consultation ? 'Responder a la consulta con claridad, identificando los datos disponibles y las limitaciones relevantes.' : '')).trim();
  const requestedKind = consultation ? 'consultation' : input.kind === 'code' ? 'code' : 'analysis';
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId)) return Promise.reject(new Error('Falta una operación idempotente válida para la solicitud.'));
  if (!['agency', 'games'].includes(business)) return Promise.reject(new Error('Selecciona una empresa válida.'));
  if (title.length < 1 || title.length > 160 || text.length < 4 || text.length > 10_000 || successCriteria.length < 4 || successCriteria.length > 1800) return Promise.reject(new Error('Revisa título, objetivo y criterio de éxito antes de enviar al coordinador.'));
  // Optional split chosen for this job in the panel; validated here so a bad choice never reaches the coordinator.
  let launch;
  try { launch = consultation ? undefined : validateJobLaunch(input.launch ?? undefined); } catch (error) { return Promise.reject(new Error(error.message)); }
  const inflightKey = `${root}:${business}:${operationId}`;
  const signature = JSON.stringify({ business, title, text, successCriteria, projectId: input.projectId || null, intent, kind: requestedKind, confirmation: input.kind === 'code' ? confirmationValue(input.confirmation) : null, ...(launch ? { launch } : {}) });
  if (pending.has(inflightKey)) return pending.get(inflightKey).signature === signature ? pending.get(inflightKey).promise : Promise.reject(new Error('Esta operación ya identifica otro encargo.'));
  const task = withInboxLock(root, `submission:${business}:${operationId}`, async () => {
    const inbox = await loadDashboardState(root);
    const projectId = String(input.projectId || '');
    const project = projectId ? inbox.projects.find(item => item.id === projectId && item.business === business) : null;
    if (projectId && !project) throw new Error('El proyecto no existe o pertenece a otra empresa.');
    const id = keyFor(`${business}:${operationId}`);
    let request = inbox.coordinatorRequests.find(item => item.id === id);
    if (request && ((request.intent || 'task') !== intent || request.snapshot.title !== title || request.snapshot.text !== text || request.snapshot.successCriteria !== successCriteria || request.projectId !== (project?.id || null) || request.snapshot.requestedKind !== requestedKind || JSON.stringify(request.snapshot.launch ?? null) !== JSON.stringify(launch ?? null) || JSON.stringify(confirmationValue(request.snapshot.destinationConfirmation)) !== JSON.stringify(input.kind === 'code' ? confirmationValue(input.confirmation) : null))) throw new Error('Esta operación ya identifica otro encargo; conserva su ID para reintentar o crea una intención nueva.');
    if (!request) {
      request = {
        id, kind: 'task', intent, status: 'pending', notification: { status: 'pending' }, operationId,
        business, projectId: project?.id || null, projectName: project?.name || '', createdAt: new Date().toISOString(),
        snapshot: {
          schemaVersion: 1, version: 1, business, projectId: project?.id || null, projectName: project?.name || '', title, text, objective: text, successCriteria, decisions: [],
          intent, requestedKind,
          destinationConfirmation: input.kind === 'code' ? input.confirmation || null : null,
          ...(launch ? { launch } : {}),
        },
      };
      request = await changeDashboardState(root, state => {
        const existing = state.coordinatorRequests.find(item => item.id === id);
        if (existing) return existing;
        state.coordinatorRequests.push(request);
        return request;
      });
    }
    if (request.status === 'withdrawn') throw new Error('La solicitud se retiró; crea una nueva intención para volver a enviarla.');
    if (request.status === 'answered') return { request, existing: true, message: 'La consulta ya tiene una respuesta guardada del coordinador.' };
    if (request.status === 'routing') return { request, message: 'La decisión del coordinador ya está guardada; el panel continuará el mismo checkpoint sin crear otro trabajo.' };
    if (request.status === 'routed' || request.notification?.status === 'sent') return { request, message: request.status === 'routed' ? `El coordinador ya enrutó esta solicitud al trabajo ${request.jobId}.` : 'Solicitud guardada y aviso ya entregado al coordinador.' };
    const updated = await deliverCoordinatorNotice(root, id, notify);
    return { request: updated, message: updated.notification?.status === 'sent' ? 'Solicitud guardada y enviada al coordinador; aún no existe job ni dispatch.' : updated.notification?.reason || 'Solicitud guardada en la bandeja del coordinador; aviso pendiente.' };
  }).finally(() => pending.delete(inflightKey));
  pending.set(inflightKey, { signature, promise: task });
  return task;
}

export async function checkCoordinatorRequestNotice(root, requestId, { notify = notifyCoordinatorRequest } = {}) {
  await deliverCoordinatorNotice(root, requestId, notify);
  return checkCoordinatorAnswerNotices(root, requestId, { notify });
}

export function routeTaskFromCoordinator(root, requestId, kind, options = {}) {
  if (!['analysis', 'code'].includes(kind)) return Promise.reject(new Error('El coordinador debe elegir análisis o código.'));
  const key = `${path.resolve(root)}:${requestId}`;
  const existing = routes.get(key);
  if (existing) return existing.kind === kind ? existing.promise : Promise.reject(new Error('Esta solicitud ya se está enrutando con otra decisión; revisa el estado antes de continuar.'));
  const promise = withInboxLock(root, `route:${requestId}`, () => routeTaskOnce(root, requestId, kind, options)).finally(() => routes.delete(key));
  routes.set(key, { kind, promise });
  return promise;
}

async function routeTaskOnce(root, requestId, requestedKind, { reason = '', confirmation, route: requestedRoute } = {}) {
  let kind = requestedKind;
  if (!['analysis', 'code'].includes(kind)) throw new Error('El coordinador debe elegir análisis o código.');
  const inbox = await loadDashboardState(root);
  const request = inbox.coordinatorRequests.find(item => item.id === requestId && item.kind === 'task');
  if (!request) throw new Error('No encuentro esa solicitud de tarea del coordinador.');
  if (request.status === 'answered') throw new Error('La consulta ya fue respondida; conserva su respuesta y crea otra petición para un trabajo nuevo.');
  if (request.intent === 'consultation') throw new Error('Las consultas se responden directamente; no crean un job de análisis ni de código.');
  if (request.status === 'routed') {
    const job = (await loadState(root)).jobs.find(item => item.id === request.jobId);
    return { request, job, existing: true };
  }
  if (request.route?.kind) {
    if (request.route.kind !== kind) throw new Error('La decisión de ruta ya se guardó; hay que continuar esa misma ruta.');
    kind = request.route.kind;
    reason = request.route.reason || '';
    confirmation = request.route.confirmation;
    requestedRoute = request.route.pipelineRoute;
  }
  // The coordinator's choice of stages (job-route.mjs). Validated before anything is saved; kept with the route checkpoint.
  const pipelineRoute = kind === 'code' ? validateJobRoute(requestedRoute, kind) : undefined;
  if (request.notification?.status !== 'sent') throw new Error('El aviso al coordinador no está confirmado; no encolo la solicitud. Revisa primero su estado.');
  assertCoordinatorQuestionsAnswered(request, inbox.questions);
  const jobs = (await loadState(root)).jobs;
  const direct = jobs.find(job => job.id === `${request.id}-${kind}`);
  if (direct && (direct.business !== request.business || (direct.projectId || null) !== request.projectId || direct.kind !== kind)) throw new Error('El identificador de la solicitud pertenece a otro encargo; requiere revisión.');
  const correlated = direct || jobs.find(job => job.business === request.business && (job.projectId || null) === request.projectId && job.kind === kind && job.prompt?.includes(`[COORDINATOR_REQUEST:${request.id}]`));
  const conflicting = jobs.find(job => (job.id === `${request.id}-analysis` || job.id === `${request.id}-code`) && job.id !== `${request.id}-${kind}`);
  const markerConflict = jobs.find(job => job.business === request.business && (job.projectId || null) === request.projectId && job.prompt?.includes(`[COORDINATOR_REQUEST:${request.id}]`) && job.kind !== kind);
  if (conflicting || markerConflict) throw new Error('La solicitud ya tiene un trabajo asociado a otra ruta; requiere revisión antes de crear nada más.');
  if (correlated) {
    const restored = await changeDashboardState(root, state => {
      const current = state.coordinatorRequests.find(item => item.id === requestId);
      current.status = 'routed'; current.jobId = correlated.id; current.route = { kind, at: new Date().toISOString(), reason: String(reason).trim().slice(0, 1000) };
      return current;
    });
    return { request: restored, job: correlated, existing: true };
  }
  const project = request.projectId ? inbox.projects.find(item => item.id === request.projectId && item.business === request.business) : null;
  if (request.projectId && !project) throw new Error('El proyecto dejó de existir o cambió de empresa; revisa la solicitud.');
  const { snapshot } = request;
  const jobId = `${request.id}-${kind}`;
  const receiptId = `coordinator-send-${request.id}-${kind}`;
  const savedReceipt = (await readAutoRun(root)).receipts.find(item => item.id === receiptId);
  const title = `${kind === 'code' ? 'Desarrollar' : 'Planificar'}: ${snapshot.title}`.slice(0, 160);
  let destination, productContract;
  if (kind === 'code') {
    const confirmed = confirmation || snapshot.destinationConfirmation;
    if (!project || !project.checkout || !project.branch || !project.baseBranch) throw new Error('Configura checkout, rama fuente y rama base del proyecto antes de autorizar código.');
    if (!confirmed || confirmed.projectId !== project.id || confirmed.checkout !== project.checkout || confirmed.branch !== project.branch || confirmed.baseBranch !== project.baseBranch) throw new Error('La confirmación de destino ya no coincide con el proyecto. Revisa el checkout y las ramas desde el panel.');
    if (confirmed.objective !== snapshot.text || confirmed.successCriteria !== snapshot.successCriteria) throw new Error('Confirma exactamente el objetivo y criterio guardados; una decisión de ruta no sustituye el encargo.');
    if (!savedReceipt) productContract = productJobContract({ objective: title, successCriteria: snapshot.successCriteria, productAcceptance: confirmed.productAcceptance });
    destination = await inspectDestination(root, project.checkout, project.branch);
    destination.repository = project.repository || '';
    destination.baseBranch = project.baseBranch;
  }
  const decisions = request.route?.decisions ?? coordinatorDecisions(request, inbox.questions);
  const prompt = [
    `[COORDINATOR_REQUEST:${request.id}]`,
    `Empresa: ${request.business}`,
    `Proyecto: ${project?.name || 'Sin proyecto'}${project ? ` (${project.id})` : ''}`,
    `Decisión del coordinador: ${kind !== 'code' ? 'Planificador para análisis sin editar código' : pipelineRoute?.omitted.length ? `pipeline de código Desarrollo → QA → Revisión (ruta ${pipelineRoute.label}; sin Diseño: ${pipelineRoute.reason})` : 'pipeline de código UX → Desarrollo → QA → Revisión'}.`,
    reason ? `Motivo de ruta: ${String(reason).trim().slice(0, 1000)}` : '',
    `Objetivo solicitado: ${snapshot.text}`,
    `Criterio de éxito: ${snapshot.successCriteria}`,
    `Decisiones confirmadas: ${JSON.stringify(decisions)}`,
    `Destino: ${kind === 'code' ? `${destination.checkout} · ${destination.branch} → ${destination.baseBranch}` : 'análisis'}`,
    'La ruta es la decisión del coordinador para esta solicitud; no autoriza publicar, fusionar o desplegar fuera de la configuración del proyecto.',
  ].filter(Boolean).join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > 12_000) throw new Error('El brief supera 12.000 bytes; acota la solicitud sin truncar el original.');
  await changeDashboardState(root, state => {
    const current = state.coordinatorRequests.find(item => item.id === requestId);
    if (current.route?.kind && current.route.kind !== kind) throw new Error('La decisión de ruta ya se guardó; no se permite cambiarla durante la recuperación.');
    if (current.status !== 'routing') {
      current.status = 'routing';
      current.route = { kind, at: new Date().toISOString(), reason: String(reason).trim().slice(0, 1000), decisions, ...(kind === 'code' ? { confirmation: confirmation || snapshot.destinationConfirmation } : {}), ...(pipelineRoute ? { pipelineRoute } : {}) };
      current.updatedAt = new Date().toISOString();
    }
    return current;
  });
  const explicitContract = savedReceipt
    ? (Object.hasOwn(savedReceipt.spec, 'contract') ? { contract: savedReceipt.spec.contract } : {})
    : { contract: productContract || { objective: title, acceptance: acceptanceFromSuccessCriteria(snapshot.successCriteria) } };
  const submission = await confirmSubmission(root, receiptId, {
    id: jobId, business: request.business, projectId: project?.id, projectName: project?.name,
    kind, provider: 'orca', title, ...explicitContract,
    prompt, ...(coordinatorJobLink(request, project?.id || null) ? { coordination: coordinatorJobLink(request, project?.id || null) } : {}),
    ...(destination ? { workspace: destination.workspace, branch: destination.branch, destination, isolated: true } : {}),
    // A receipt saved before this field existed keeps its exact spec (and so its fingerprint).
    ...(snapshot.launch && (!savedReceipt || savedReceipt.spec.launch) ? { launch: snapshot.launch } : {}),
    ...(savedReceipt ? (savedReceipt.spec.route ? { route: savedReceipt.spec.route } : {}) : pipelineRoute ? { route: pipelineRoute } : {}),
  });
  if (destination && submission.receipt) await recordJobConfirmation(root, jobId, request.business, destination);
  const updated = await changeDashboardState(root, state => {
    const current = state.coordinatorRequests.find(item => item.id === requestId);
    current.status = 'routed'; current.jobId = submission.receipt?.jobId || jobId; current.receiptId = submission.receipt?.id || receiptId;
    current.route = { ...current.route, kind, reason: String(reason).trim().slice(0, 1000), completedAt: new Date().toISOString() };
    current.updatedAt = new Date().toISOString();
    return current;
  });
  return { request: updated, job: submission.job, receipt: submission.receipt, message: submission.job ? 'El coordinador enrutó la solicitud; el job queda sujeto a las compuertas y configuración actuales.' : 'Ruta decidida y recibo durable guardado; job pendiente de materializar.' };
}
