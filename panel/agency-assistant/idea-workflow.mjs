import { validateJobRoute } from '../../job-route.mjs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addJob, loadState } from '../queue.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { confirmSubmission, readAutoRun } from '../../auto-run.mjs';
import { acceptanceFromSuccessCriteria, productJobContract } from '../../workflow-contract.mjs';
import { changeDashboardState, loadDashboardState } from './dashboard-state.mjs';
import { notifyCoordinatorRequest } from '../coordinator-bridge.mjs';
import { withInboxLock } from './inbox-lock.mjs';
import { deliverCoordinatorNotice } from './coordinator-notice.mjs';
import { assertCoordinatorQuestionsAnswered, coordinatorDecisions, coordinatorJobLink } from './coordinator-dialogue.mjs';

import { withIdeaLock, ideaBusy, ideaBrief, classification } from './idea-model.mjs';
const sends = new Map();
const coordinatorSends = new Map();
const coordinatorRoutes = new Map();
export function ideaSubmissionIds(idea, kind) {
  const version = idea.version || 1;
  const revisionKey = `${idea.id}-v${version}`;
  const key = revisionKey.length <= 62 ? revisionKey : createHash('sha256').update(revisionKey).digest('hex').slice(0, 40);
  return { jobId: `idea-${key}-${kind}`, receiptId: `idea-send-${key}-${kind}` };
}
function requestVersion(request) {
  return request?.ideaVersion || Number(request?.snapshot?.match(/Revisión:\s*(\d+)/)?.[1]) || 1;
}

export async function checkoutChoices(root) {
  let entries;
  try { entries = await fs.readdir(path.join(root, 'workspaces'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(async entry => {
    const value = `workspaces/${entry.name}`;
    try {
      const destination = await inspectDestination(root, value);
      return { value, ...destination };
    } catch (error) { return { value, valid: false, reason: error.message }; }
  }));
}

export function sendIdeaToQueue(root, id, kind, projectId = '', confirmation = {}) {
  const key = `${path.resolve(root)}:${id}:${kind}`;
  if (sends.has(key)) return sends.get(key);
  const pending = withIdeaLock(root, id, () => sendOnce(root, id, kind, projectId, confirmation)).finally(() => sends.delete(key));
  sends.set(key, pending);
  return pending;
}

async function sendOnce(root, id, kind, projectId, confirmation) {
  if (!['analysis', 'code'].includes(kind)) throw new Error('Destino de idea inválido.');
  const inbox = await loadDashboardState(root);
  const idea = inbox.ideas.find(item => item.id === id);
  if (!idea) throw new Error('No encuentro esa idea guardada.');
  if (['trash', 'archived'].includes(idea.status)) throw new Error('Restaura la idea antes de enviar.');
  const version = idea.version || 1;
  const coordinatorRequest = inbox.coordinatorRequests.find(item => item.kind === 'idea' && item.ideaId === id
    && item.ideaVersion === version && item.route?.kind === kind && ['routing', 'routed'].includes(item.status) && item.notification?.status === 'sent');
  if (coordinatorRequest) assertCoordinatorQuestionsAnswered(coordinatorRequest, inbox.questions);
  const savedRequest = idea.requests?.[kind];
  const currentRequest = savedRequest && requestVersion(savedRequest) === version ? savedRequest : null;
  const requestedProjectId = projectId || confirmation.projectId || currentRequest?.confirmation?.projectId || '';
  if (projectId && confirmation.projectId && projectId !== confirmation.projectId) throw new Error('El proyecto solicitado y el confirmado no coinciden.');
  if (idea.projectId && requestedProjectId && idea.projectId !== requestedProjectId) return { idea, message: 'La idea ya pertenece a otro proyecto; la ruta no puede cambiarlo.' };
  const targetProjectId = idea.projectId || (kind === 'code' ? requestedProjectId : '');
  const project = inbox.projects.find(item => item.id === targetProjectId && item.business === idea.business);
  if (targetProjectId && !project) throw new Error('El proyecto confirmado no existe o pertenece a otra empresa.');
  if (!project) return { idea, message: 'Idea guardada; confirma el proyecto de destino antes de enviarla.' };
  // Classification is a routing decision, not a user preference or a new idea revision.
  const focus = idea.focus || (kind === 'code' && coordinatorRequest ? coordinatorRequest.route?.focus || 'code' : '');
  const ids = ideaSubmissionIds(idea, kind);
  const jobId = currentRequest?.jobId || ids.jobId;
  const jobs = (await loadState(root)).jobs;
  const direct = jobs.find(job => job.id === jobId);
  if (direct && (direct.business !== idea.business || direct.kind !== kind || direct.projectId !== project.id)) throw new Error('El identificador guardado pertenece a otro encargo; requiere revisión.');
  const existing = direct || jobs.find(job => job.business === idea.business && job.projectId === project.id && job.kind === kind && (job.ideaId === id || job.prompt?.includes(`[IDEA_ID:${id}]`)) && (job.ideaVersion || 1) === version);
  if (existing) {
    const receipt = existing.autoIntent?.receiptId ? (await readAutoRun(root)).receipts.find(item => item.id === existing.autoIntent.receiptId) : undefined;
    await changeDashboardState(root, state => {
      const current = state.ideas.find(item => item.id === id);
      if (!current || ['trash', 'archived'].includes(current.status) || (current.version || 1) !== version) throw new Error('La idea cambió durante el envío.');
      if (current.projectId && current.projectId !== project.id) throw new Error('El proyecto de la idea cambió; requiere revisión.');
      current.projectId = project.id; current.projectName = project.name;
      if (!current.focus && focus) current.focus = focus;
      if (!current.requests?.[kind] || requestVersion(current.requests[kind]) !== version || current.requests[kind].status === 'pending') {
        if (current.requests?.[kind] && requestVersion(current.requests[kind]) !== version) current.requestHistory = [...(current.requestHistory || []), { kind, ...current.requests[kind] }];
        current.requests = { ...current.requests, [kind]: { ...currentRequest, jobId: existing.id, ideaVersion: version, status: 'queued', snapshot: currentRequest?.snapshot || existing.prompt, ...(receipt ? { receiptId: receipt.id } : {}) } };
      }
    });
    return { idea, job: existing, receipt, existing: true, message: 'La idea ya tiene un trabajo; revisa su estado.' };
  }
  if (!focus) return { idea, message: 'Idea guardada; confirma el foco del trabajo antes de enviar.' };
  classification(focus, idea.tags);
  if (Object.values(idea.requests || {}).some(request => ['active', 'uncertain'].includes(request.status))) throw new Error('Solicitud activa o incierta; requiere revisión.');
  if (confirmation.version !== undefined && confirmation.version !== (idea.version || 1)) throw new Error('La idea cambió; confirma la versión actual.');
  if (ideaBusy(idea) && !currentRequest?.snapshot) throw new Error('Solicitud ambigua: requiere revisión antes de enviar.');
  // Read an existing intent before enforcing the new confirmation schema. Its
  // exact contract (including absence of one) must survive historical replays.
  const legacyPending = currentRequest?.status === 'pending' && !currentRequest.receiptId;
  const receiptId = currentRequest?.receiptId || ids.receiptId;
  const savedReceipt = legacyPending ? null : (await readAutoRun(root)).receipts.find(item => item.id === receiptId);
  let destination, productContract, objective = 'Convertir esta idea en un resultado verificable del proyecto.', successCriteria = 'Entregar un plan priorizado, criterios de aceptación y preguntas imprescindibles, sin modificar archivos.';
  if (kind === 'code') {
    try {
      if (!project.checkout) throw new Error('Sin checkout configurado.');
      if (!project.baseBranch) throw new Error('Sin rama base GitHub configurada.');
      const saved = currentRequest?.confirmation;
      const confirmed = confirmation?.projectId ? confirmation : saved || {};
      objective = String(confirmed.objective || '').trim();
      successCriteria = String(confirmed.successCriteria || '').trim();
      if (objective.length < 4 || objective.length > 1800 || successCriteria.length < 4 || successCriteria.length > 1800) throw new Error('Indica objetivo y criterio de éxito verificables (4–1800 caracteres).');
      if (confirmed.projectId !== project.id || confirmed.checkout !== project.checkout || !confirmed.branch || confirmed.branch !== project.branch || (confirmed.baseBranch || '') !== (project.baseBranch || '')) throw new Error('Confirma el proyecto, checkout y ramas fuente/base configuradas.');
      if (!savedReceipt && !legacyPending) productContract = productJobContract({ objective, successCriteria, productAcceptance: confirmed.productAcceptance });
      destination = await inspectDestination(root, project.checkout, confirmed.branch);
      destination.repository = project.repository || '';
      destination.baseBranch = project.baseBranch || '';
    } catch (error) {
      if (error.code === 'product_acceptance_required') return { idea, code: error.code, message: error.message };
      return { idea, message: `Idea guardada; configura un checkout válido para enviarla a desarrollo. ${error.message}` };
    }
  }
  const savedPrompt = currentRequest?.snapshot;
  const basePrompt = savedPrompt || ideaBrief({ ...idea, focus }, project, kind, objective, successCriteria, destination);
  const routeReason = String(confirmation.reason || '').trim().slice(0, 1000);
  const decisions = coordinatorRequest ? coordinatorRequest.route?.decisions ?? coordinatorDecisions(coordinatorRequest, inbox.questions) : [];
  const prompt = savedPrompt || [basePrompt, routeReason ? `Decisión del coordinador: ${routeReason}` : '',
    decisions.length ? `Decisiones confirmadas: ${JSON.stringify(decisions)}` : ''].filter(Boolean).join('\n\n');
  if (Buffer.byteLength(prompt, 'utf8') > 12_000) return { idea, message: 'Idea guardada íntegramente; el encargo supera el límite de 12.000 bytes de la cola. Divide la idea en encargos más acotados antes de enviarla.' };
  // Old inbox-only pending entries predate automatic intent and stay manual.
  const explicitContract = savedReceipt
    ? (Object.hasOwn(savedReceipt.spec, 'contract') ? { contract: savedReceipt.spec.contract } : {})
    : legacyPending ? {} : { contract: productContract || { objective, acceptance: acceptanceFromSuccessCriteria(successCriteria) } };
  const submissionSpec = {
    id: jobId, ideaId: id, ideaVersion: idea.version || 1, business: idea.business, projectId: project.id, projectName: project.name,
    kind, provider: 'orca', title: `${kind === 'code' ? 'Desarrollar' : 'Planificar'}: ${idea.title}`.slice(0, 160), prompt,
    ...explicitContract,
    ...(coordinatorRequest && coordinatorJobLink(coordinatorRequest, project.id) ? { coordination: coordinatorJobLink(coordinatorRequest, project.id) } : {}),
    ...(kind === 'code' ? { workspace: destination.workspace, branch: destination.branch, destination, isolated: true } : {}),
    // The coordinator's choice of stages; a receipt saved earlier keeps its exact spec.
    ...(savedReceipt ? (savedReceipt.spec.route ? { route: savedReceipt.spec.route } : {}) : kind === 'code' && confirmation.pipelineRoute ? { route: validateJobRoute(confirmation.pipelineRoute, kind) } : {}),
  };
  // Legacy recovery uses addJob with no auto receipt; activation cannot promote it.
  const submission = legacyPending ? { job: await addJob(root, submissionSpec).catch(error => { if (error.code === 'locked') return null; throw error; }) }
    : await confirmSubmission(root, receiptId, submissionSpec);
  await changeDashboardState(root, state => {
    const current = state.ideas.find(item => item.id === id);
    if (!current || ['trash', 'archived'].includes(current.status) || (current.version || 1) !== (idea.version || 1)) throw new Error('La idea cambió durante el envío.');
    if (current.projectId && current.projectId !== project.id) throw new Error('El proyecto de la idea cambió; requiere revisión.');
    // A durable receipt can precede the job while the queue is locked. Keep the
    // captured idea unassigned until that exact job has materialized.
    if (submission.job) {
      current.projectId = project.id;
      current.projectName = project.name;
      if (!current.focus) current.focus = focus;
    }
    if (current.requests?.[kind] && requestVersion(current.requests[kind]) !== version) current.requestHistory = [...(current.requestHistory || []), { kind, ...current.requests[kind] }];
    current.requests = { ...current.requests, [kind]: { jobId, ideaVersion: version, status: submission.job ? 'queued' : 'pending', snapshot: prompt, ...(!legacyPending ? { receiptId } : {}), ...(kind === 'code' ? { confirmation: { objective, successCriteria, ...(explicitContract.contract?.acceptanceScope === 'product' ? { productAcceptance: explicitContract.contract.productAcceptance } : {}), projectId: project.id, checkout: destination.checkout, branch: destination.branch, baseBranch: destination.baseBranch } } : {}) } };
  });
  try {
    const job = submission.job;
    if (!job) return { idea, receipt: submission.receipt, message: 'Envío confirmado y guardado; espera al ejecutor disponible. Consulta este recibo antes de repetir.' };
    return { idea, job, receipt: submission.receipt, created: true, message: submission.receipt?.eligible ? 'En cola automática; el recibo confirma la intención, el dispatch se mostrará cuando Orca lo confirme.' : 'En cola manual; autoejecución pausada al confirmar.' };
  } catch (error) {
    if (error.code === 'duplicate') return { idea, job: (await loadState(root)).jobs.find(job => job.id === jobId), existing: true, message: 'Trabajo ya creado.' };
    if (['locked', 'lock_uncertain'].includes(error.code)) return { idea, message: `Idea guardada; solicitud pendiente de añadir a la cola cuando sea seguro. ${error.message}` };
    throw error;
  }
}

export function sendIdeaToCoordinator(root, id, { notify = notifyCoordinatorRequest } = {}) {
  const key = `${path.resolve(root)}:${id}`;
  if (coordinatorSends.has(key)) return coordinatorSends.get(key);
  const pending = withIdeaLock(root, id, async () => {
    const inbox = await loadDashboardState(root);
    const idea = inbox.ideas.find(item => item.id === id);
    if (!idea) throw new Error('No encuentro esa idea guardada.');
    if (['trash', 'archived'].includes(idea.status)) throw new Error('Restaura la idea antes de pedir una decisión al coordinador.');
    if (ideaBusy(idea)) throw new Error('La idea ya tiene un envío activo o incierto; revisa ese trabajo antes de crear otra solicitud.');
    const version = idea.version || 1;
    const requestId = `coord-${createHash('sha256').update(`${idea.business}:${idea.id}:${version}`).digest('hex').slice(0, 32)}`;
    let request = inbox.coordinatorRequests.find(item => item.id === requestId);
    if (!request) {
      const project = inbox.projects.find(item => item.id === idea.projectId && item.business === idea.business);
      request = {
        id: requestId, kind: 'idea', ideaId: idea.id, ideaVersion: version, business: idea.business,
        status: 'pending', notification: { status: 'pending' }, createdAt: new Date().toISOString(),
        snapshot: { schemaVersion: 1, business: idea.business, projectId: project?.id || null, projectName: project?.name || idea.projectName || '', version, focus: idea.focus || '', tags: [...(idea.tags || [])], title: idea.title, text: idea.text, objective: idea.text, successCriteria: 'Definir un resultado verificable y sus decisiones imprescindibles; confirmar criterios y destino antes de encolar código.', destinationConfirmation: null, decisions: [] },
      };
      await changeDashboardState(root, state => { state.coordinatorRequests.push(request); });
    }
    return request;
  }).then(async request => {
    if (request.status === 'withdrawn') throw new Error('La solicitud se retiró; edita la idea y envía su nueva revisión.');
    if (request.status === 'routing') return { request, message: `La decisión del coordinador ya está guardada (${request.route?.kind || 'ruta pendiente'}); el panel reanudará el mismo job, sin crear otro.` };
    if (request.status === 'routed' || request.notification?.status === 'sent') return {
      request,
      message: request.status === 'routed' ? `El coordinador ya enrutó esta idea al trabajo ${request.jobId}.` : 'Solicitud guardada y aviso ya entregado al coordinador.',
    };
    const updated = await deliverCoordinatorNotice(root, request.id, notify);
    return {
      request: updated,
      message: updated.notification?.status === 'sent'
        ? 'Idea guardada y enviada al coordinador de Orca. Aún no hay job ni dispatch; el coordinador decidirá la ruta.'
        : updated.notification?.reason || 'Idea guardada en la bandeja del coordinador; el aviso queda pendiente.',
    };
  }).finally(() => coordinatorSends.delete(key));
  coordinatorSends.set(key, pending);
  return pending;
}

export function routeCoordinatorIdea(root, requestId, kind, confirmation = {}) {
  if (!['analysis', 'code'].includes(kind)) return Promise.reject(new Error('El coordinador debe elegir análisis o código.'));
  const key = `${path.resolve(root)}:${requestId}`;
  const activeRoute = coordinatorRoutes.get(key);
  if (activeRoute) return activeRoute.kind === kind ? activeRoute.promise : Promise.reject(new Error('Esta solicitud ya se está enrutando con otra decisión; revisa el estado antes de continuar.'));
  const pending = withInboxLock(root, `route:${requestId}`, async () => {
    const inbox = await loadDashboardState(root);
    const request = inbox.coordinatorRequests.find(item => item.id === requestId);
    if (!request || request.kind !== 'idea') throw new Error('No encuentro esa solicitud del coordinador.');
    if (request.status === 'routed') {
      const job = (await loadState(root)).jobs.find(item => item.id === request.jobId);
      if (job) return { request, job, existing: true, message: 'La decisión del coordinador ya se aplicó a este trabajo.' };
      if (!request.receiptId || !request.route?.kind) throw new Error('La ruta no conserva un trabajo ni un recibo recuperable; requiere revisión.');
    }
    const mayAmend = request.status === 'needs_attention' && !request.jobId && !request.receiptId && confirmation.revise === true;
    if (mayAmend) {
      const jobs = (await loadState(root)).jobs;
      const receipts = (await readAutoRun(root)).receipts;
      const ids = ideaSubmissionIds({ id: request.ideaId, version: request.ideaVersion }, request.route?.kind || kind);
      if (jobs.some(job => job.id === ids.jobId) || receipts.some(receipt => receipt.id === ids.receiptId)) throw new Error('Ya existe una intención durable; no puede cambiarse su confirmación.');
    }
    if (request.route?.kind && !mayAmend) {
      if (request.route.kind !== kind) throw new Error('La decisión de ruta ya se guardó; hay que continuar esa misma ruta.');
      confirmation = request.route.confirmation || {};
    }
    if (request.notification?.status !== 'sent') throw new Error('El aviso al coordinador no está confirmado; no encolo la idea. Revisa primero su estado.');
    assertCoordinatorQuestionsAnswered(request, inbox.questions);
    const idea = inbox.ideas.find(item => item.id === request.ideaId);
    if (!idea || ['trash', 'archived'].includes(idea.status) || (idea.version || 1) !== request.ideaVersion) {
      await changeDashboardState(root, state => {
        const current = state.coordinatorRequests.find(item => item.id === requestId);
        if (current) { current.status = 'needs_attention'; current.reason = 'La idea se retiró o cambió desde que se avisó al coordinador.'; current.updatedAt = new Date().toISOString(); }
      });
      throw new Error('La idea cambió desde la solicitud; recárgala y vuelve a enviarla al coordinador.');
    }
    const routeReason = String(confirmation.reason || request.route?.reason || '').trim().slice(0, 1000);
    if (kind === 'code' && confirmation.projectId) {
      if (idea.projectId && confirmation.projectId !== idea.projectId) throw new Error('La idea ya pertenece a otro proyecto; la ruta no puede cambiarlo.');
      if (!inbox.projects.some(project => project.id === confirmation.projectId && project.business === idea.business)) throw new Error('El proyecto confirmado no existe o pertenece a otra empresa.');
    }
    const routeConfirmation = kind === 'code' ? {
      projectId: confirmation.projectId || '', checkout: confirmation.checkout || '', branch: confirmation.branch || '',
      baseBranch: confirmation.baseBranch || '', objective: String(confirmation.objective || '').trim(),
      successCriteria: String(confirmation.successCriteria || '').trim(), version: request.ideaVersion,
      ...(Object.hasOwn(confirmation, 'productAcceptance') ? { productAcceptance: structuredClone(confirmation.productAcceptance) } : {}),
      ...(confirmation.pipelineRoute ? { pipelineRoute: validateJobRoute(confirmation.pipelineRoute, kind) } : {}),
    } : { version: request.ideaVersion };
    await changeDashboardState(root, state => {
      const current = state.coordinatorRequests.find(item => item.id === requestId);
      if (!mayAmend && current.route?.kind && current.route.kind !== kind) throw new Error('La decisión de ruta ya se guardó; no se permite cambiarla durante la recuperación.');
      if (current.status !== 'routing') {
        if (mayAmend) current.routeHistory = [...(current.routeHistory || []), { ...current.route, supersededAt: new Date().toISOString() }];
        current.status = 'routing';
        delete current.reason;
        current.route = { kind, at: new Date().toISOString(), reason: routeReason, confirmation: routeConfirmation,
          projectId: idea.projectId || routeConfirmation.projectId || null, focus: idea.focus || (kind === 'code' ? 'code' : ''),
          decisions: coordinatorDecisions(request, inbox.questions) };
        current.updatedAt = new Date().toISOString();
      }
      return current;
    });
    const result = await sendIdeaToQueue(root, idea.id, kind, idea.projectId || routeConfirmation.projectId || '', { ...routeConfirmation, reason: routeReason, version: request.ideaVersion });
    if (!result.job && !result.receipt) {
      await changeDashboardState(root, state => {
        const current = state.coordinatorRequests.find(item => item.id === requestId);
        if (current) { current.status = 'needs_attention'; current.reason = result.message; current.updatedAt = new Date().toISOString(); }
      });
      return { ...result, request: (await loadDashboardState(root)).coordinatorRequests.find(item => item.id === requestId) };
    }
    const updated = await changeDashboardState(root, state => {
      const current = state.coordinatorRequests.find(item => item.id === requestId);
      current.status = result.job ? 'routed' : 'routing';
      current.route = { ...current.route, kind, reason: routeReason };
      if (result.job) {
        current.route.completedAt = new Date().toISOString();
        current.jobId = result.job.id;
      } else {
        delete current.route.completedAt;
        delete current.jobId;
      }
      current.receiptId = result.receipt?.id || current.receiptId || null;
      current.updatedAt = new Date().toISOString();
      return current;
    });
    return { ...result, request: updated, message: result.job ? `El coordinador eligió ${kind === 'code' ? 'el pipeline de código' : 'Planificador'}; trabajo ${result.job.id} enrutado.` : 'Decisión guardada; el job queda pendiente de materializar en la cola.' };
  }).finally(() => coordinatorRoutes.delete(key));
  coordinatorRoutes.set(key, { kind, promise: pending });
  return pending;
}

export async function reconcileIdeaRequests(root) {
  const inbox = await loadDashboardState(root);
  for (const idea of inbox.ideas) {
    for (const [kind, request] of Object.entries(idea.requests || {})) {
      if (request.status === 'pending') {
        try {
          const result = await sendIdeaToQueue(root, idea.id, kind);
          if (!result.job) await changeDashboardState(root, state => {
            const current = state.ideas.find(item => item.id === idea.id);
            if (current?.requests?.[kind]?.status === 'pending') current.requests[kind].error = result.message;
          });
        }
        catch (error) {
          await changeDashboardState(root, state => {
            const current = state.ideas.find(item => item.id === idea.id);
            current.requests[kind].error = error.message;
          });
        }
      }
    }
  }
}
