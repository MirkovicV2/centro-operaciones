import * as fs from 'node:fs/promises';
import path from 'node:path';
import { addJob, loadState } from '../queue.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { confirmSubmission } from '../../auto-run.mjs';
import { changeDashboardState, loadDashboardState } from './dashboard-state.mjs';

import { withIdeaLock, ideaBusy, ideaBrief, classification } from './idea-model.mjs';
const sends = new Map();
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
  const project = inbox.projects.find(item => item.id === idea.projectId && item.business === idea.business);
  if (!project) return { idea, message: 'Idea guardada; asóciala a un proyecto antes de enviarla.' };
  const jobId = `idea-${id}-${kind}`;
  const existing = (await loadState(root)).jobs.find(job => job.id === jobId || (job.kind === kind && job.prompt?.includes(`[IDEA_ID:${id}]`)));
  if (existing) {
    if (idea.requests?.[kind]?.status === 'pending') await changeDashboardState(root, state => {
      const current = state.ideas.find(item => item.id === id);
      current.requests[kind] = { ...current.requests[kind], jobId: existing.id, status: 'queued' };
    });
    return { idea, job: existing, existing: true, message: 'La idea ya tiene un trabajo; revisa su estado.' };
  }
  if (!idea.focus) return { idea, message: 'Idea guardada; confirma el foco del trabajo antes de enviar.' };
  classification(idea.focus, idea.tags);
  if (Object.values(idea.requests || {}).some(request => ['active', 'uncertain'].includes(request.status))) throw new Error('Solicitud activa o incierta; requiere revisión.');
  if (confirmation.version !== undefined && confirmation.version !== (idea.version || 1)) throw new Error('La idea cambió; confirma la versión actual.');
  if (ideaBusy(idea) && !idea.requests?.[kind]?.snapshot) throw new Error('Solicitud ambigua: requiere revisión antes de enviar.');
  let destination, objective = 'Convertir esta idea en un resultado verificable del proyecto.', successCriteria = 'Entregar un plan priorizado, criterios de aceptación y preguntas imprescindibles, sin modificar archivos.';
  if (kind === 'code') {
    try {
      if (!project.checkout) throw new Error('Sin checkout configurado.');
      if (!project.baseBranch) throw new Error('Sin rama base GitHub configurada.');
      const saved = idea.requests?.code?.confirmation;
      const confirmed = confirmation?.projectId ? confirmation : saved || {};
      objective = String(confirmed.objective || '').trim();
      successCriteria = String(confirmed.successCriteria || '').trim();
      if (objective.length < 4 || objective.length > 1800 || successCriteria.length < 4 || successCriteria.length > 1800) throw new Error('Indica objetivo y criterio de éxito verificables (4–1800 caracteres).');
      if (confirmed.projectId !== project.id || confirmed.checkout !== project.checkout || !confirmed.branch || confirmed.branch !== project.branch || (confirmed.baseBranch || '') !== (project.baseBranch || '')) throw new Error('Confirma el proyecto, checkout y ramas fuente/base configuradas.');
      destination = await inspectDestination(root, project.checkout, confirmed.branch);
      destination.repository = project.repository || '';
      destination.baseBranch = project.baseBranch || '';
    } catch (error) { return { idea, message: `Idea guardada; configura un checkout válido para enviarla a desarrollo. ${error.message}` }; }
  }
  const prompt = idea.requests?.[kind]?.snapshot || ideaBrief(idea, project, kind, objective, successCriteria, destination);
  if (Buffer.byteLength(prompt, 'utf8') > 12_000) return { idea, message: 'Idea guardada íntegramente; el encargo supera el límite de 12.000 bytes de la cola. Divide la idea en encargos más acotados antes de enviarla.' };
  // Old inbox-only pending entries predate automatic intent and stay manual.
  const legacyPending = idea.requests?.[kind]?.status === 'pending' && !idea.requests[kind].receiptId;
  const receiptId = `idea-send-${id}-${kind}`;
  const submissionSpec = {
    id: jobId, ideaId: id, ideaVersion: idea.version || 1, business: idea.business, projectId: project.id, projectName: project.name,
    kind, provider: 'orca', title: `${kind === 'code' ? 'Desarrollar' : 'Planificar'}: ${idea.title}`.slice(0, 160), prompt,
    ...(kind === 'code' ? { workspace: destination.workspace, branch: destination.branch, destination, isolated: true } : {}),
  };
  // Legacy recovery uses addJob with no auto receipt; activation cannot promote it.
  const submission = legacyPending ? { job: await addJob(root, submissionSpec).catch(error => { if (error.code === 'locked') return null; throw error; }) }
    : await confirmSubmission(root, receiptId, submissionSpec);
  await changeDashboardState(root, state => {
    const current = state.ideas.find(item => item.id === id);
    if (!current || ['trash', 'archived'].includes(current.status) || (current.version || 1) !== (idea.version || 1)) throw new Error('La idea cambió durante el envío.');
    current.projectId = project.id;
    current.projectName = project.name;
    current.requests = { ...current.requests, [kind]: { jobId, status: 'pending', snapshot: prompt, ...(!legacyPending ? { receiptId } : {}), ...(kind === 'code' ? { confirmation: { objective, successCriteria, projectId: project.id, checkout: destination.checkout, branch: destination.branch, baseBranch: destination.baseBranch } } : {}) } };
  });
  try {
    const job = submission.job;
    if (!job) return { idea, receipt: submission.receipt, message: 'Envío confirmado y guardado; espera al ejecutor disponible. Consulta este recibo antes de repetir.' };
    await changeDashboardState(root, state => {
      state.ideas.find(item => item.id === id).requests[kind] = { ...state.ideas.find(item => item.id === id).requests[kind], jobId, status: 'queued' };
    });
    return { idea, job, receipt: submission.receipt, created: true, message: submission.receipt?.eligible ? 'En cola automática; el recibo confirma la intención, el dispatch se mostrará cuando Orca lo confirme.' : 'En cola manual; autoejecución pausada al confirmar.' };
  } catch (error) {
    if (error.code === 'duplicate') return { idea, job: (await loadState(root)).jobs.find(job => job.id === jobId), existing: true, message: 'Trabajo ya creado.' };
    if (['locked', 'lock_uncertain'].includes(error.code)) return { idea, message: `Idea guardada; solicitud pendiente de añadir a la cola cuando sea seguro. ${error.message}` };
    throw error;
  }
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
