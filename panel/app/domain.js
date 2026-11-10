// Domain logic for the new panel. Ported from panel/dashboard/app.js (attentionItems, lifecycle,
// jobActionButtons) so behaviour and API calls are the same; only the presentation differs.
import { h, stepNames } from './lib.js';

export async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'No se pudo completar la operación.');
  return value;
}

// What waits on the owner: jobs needing review, pending questions, coordinator notices that may not have arrived.
export function attentionItems(data) {
  const items = [];
  for (const job of data.jobs.filter(item => item.state === 'needs_attention')) {
    const step = job.workflow?.steps?.find(item => item.key === job.workflow?.currentStage);
    const evidence = [];
    if (step?.summary || step?.delivery?.summary) evidence.push({ label: `Informe de ${step.label}`, level: 'reported' });
    if (job.error?.code) evidence.push({ label: `Código ${job.error.code}`, level: 'observed' });
    if (step?.dispatchId) evidence.push({ label: `Dispatch ${step.dispatchId}`, level: 'observed' });
    items.push({ id: `job-${job.id}`, kind: 'blocked', group: 'Trabajos que necesitan revisión', label: 'Revisión', tone: 'warn', job,
      title: job.title, context: job.projectName || '', run: job.id, at: job.finishedAt || job.createdAt,
      what: job.error?.message || 'El trabajo se detuvo y necesita revisión.',
      why: `Etapa ${step?.label || job.workflow?.currentStage || 'sin confirmar'} · intento ${job.attempts}/${job.maxAttempts}. Hasta que decidas, el trabajo no sigue.`,
      where: 'Las opciones están aquí debajo y en la ficha del trabajo; cada una pide confirmación.', evidence });
  }
  for (const question of data.questions.filter(item => item.status === 'pending')) {
    items.push({ id: `question-${question.id}`, kind: 'question', group: 'Preguntas para ti', label: 'Pregunta', tone: 'accent', question,
      title: question.question, context: question.projectName || question.jobTitle || '', at: question.createdAt,
      what: question.context || 'Un agente o el coordinador necesita tu criterio para continuar.',
      why: 'La respuesta se une a las decisiones del encargo; el agente sigue con lo que no depende de ella.',
      where: 'Puedes responder aquí mismo; queda guardado en Obsidian si está conectado.', evidence: [] });
  }
  for (const request of (data.coordinatorRequests || []).filter(item => ['unknown', 'needs_attention'].includes(item.notification?.status))) {
    items.push({ id: `request-${request.id}`, kind: 'notice', group: 'Avisos al coordinador', label: 'Aviso', tone: 'warn', request,
      title: request.snapshot?.title || 'Solicitud del panel', context: request.projectName || request.snapshot?.projectName || '', at: request.createdAt,
      what: request.notification?.reason || 'No consta que el aviso llegara al coordinador.',
      why: 'Mientras no se confirme la entrega, el coordinador puede no haber visto la solicitud.',
      where: 'Consulta la entrega en Orca; el panel no reenvía nada sin que lo pidas.', evidence: [] });
  }
  return items;
}

// Ejecución → Revisión → Aceptación → Integración, from the job, its report and its integration record.
export function lifecycle(job, report, integrationRecord) {
  const step = key => job.workflow?.steps?.find(item => item.key === key);
  const dev = step('developer') || step('planner');
  const review = step('reviewer');
  const v2 = review?.workflowV2;
  const phase = (s, map) => map[s?.status] || ['wait', s ? (stepNames[s.status] || s.status) : 'Sin iniciar'];
  const exec = phase(dev, { succeeded: ['done', 'Terminada'], running: ['active', 'En curso'], blocked: ['fail', 'Detenida'], failed: ['fail', 'Falló'] });
  let rev;
  if (v2) rev = v2.outcome === 'rejected' ? ['fail', 'Rechazada'] : v2.outcome === 'owner_pending' ? ['ok', 'Recomienda aceptar'] : ['unk', v2.status || 'Sin estado'];
  else rev = phase(review, { succeeded: ['ok', 'Aprobada'], running: ['active', 'En curso'], blocked: ['fail', 'Rechazada'], failed: ['fail', 'Falló'] });
  const acceptance = v2 ? (v2.status === 'aprobado' ? ['ok', 'Aceptada por ti'] : ['wait', 'Pendiente de tu decisión']) : ['na', 'No aplica'];
  let integration;
  if (!job.autoIntent?.eligible) integration = ['na', 'Manual'];
  else if (!integrationRecord && !report?.integration?.phase) integration = ['unk', 'Sin registro'];
  else if ((integrationRecord?.phase || report?.integration?.phase) === 'complete') integration = ['ok', 'Integrada'];
  else integration = ['active', integrationRecord?.phase || report?.integration?.phase];
  const level = (tone, exact) => tone === 'na' ? 'na' : ['unk', 'wait'].includes(tone) ? 'unknown' : exact ? 'observed' : 'reported';
  return [
    { k: 'Ejecución', tone: exec[0], state: exec[1], note: dev ? (dev.dispatchId ? `Dispatch ${dev.dispatchId}` : dev.label) : 'Sin etapa de ejecución', level: level(exec[0], dev?.dispatchId) },
    { k: 'Revisión', tone: rev[0], state: rev[1], note: v2 ? 'Workflow V2' : review?.delivery?.findings?.length ? `${review.delivery.findings.length} hallazgos` : review ? review.label : 'Sin revisión todavía', level: level(rev[0], review?.dispatchId || v2) },
    { k: 'Aceptación', tone: acceptance[0], state: acceptance[1], note: v2 ? `Tarea ${v2.task || ''}` : 'El Centro integra tras su Revisión', level: level(acceptance[0], v2) },
    { k: 'Integración', tone: integration[0], state: integration[1], note: integrationRecord?.mergeSha ? `Merge ${integrationRecord.mergeSha.slice(0, 7)}` : integrationRecord?.prUrl ? 'PR abierta' : !job.autoIntent?.eligible ? 'Fuera del Centro' : '', level: level(integration[0], true) },
  ];
}

// Retry / resolve for a job that needs review. Same conditions, labels, texts and request bodies as the classic panel.
export function jobActions(job, data, receipt, confirmAction, after) {
  if (job.state !== 'needs_attention') return [];
  const interruptedDevelopment = job.provider === 'orca' && job.autoIntent?.eligible && receipt?.status === 'needs_attention'
    && job.error?.code === 'timeout' && job.workflow?.currentStage === 'developer';
  const qa = job.workflow?.steps?.find(step => step.key === 'qa');
  const qaRevalidations = job.livenessRecoveryHistory?.filter(item => item.mode === 'same_attempt_integration_validation' && item.stage === 'qa').length ?? 0;
  const revalidate = job.autoIntent?.eligible && receipt?.status === 'needs_attention' && qaRevalidations < job.maxAttempts - 1
    && job.error?.code === 'delivery_incomplete' && job.workflow?.currentStage === 'qa' && qa?.dispatchSettled
    && ['blocked', 'failed'].includes(qa.delivery?.outcome) && qa.delivery.scope === 'complete' && qa.resultMessageId;
  const retryLabel = revalidate ? 'Revalidar QA' : interruptedDevelopment ? 'Retomar Desarrollo' : 'Reintentar después de revisar';
  return [['retry', retryLabel], ['resolve', 'Cerrar trabajo']].map(([action, label], index) => {
    const disabled = !data.executor?.available || (action === 'retry' && !revalidate && job.attempts >= job.maxAttempts);
    const title = !data.executor?.available ? data.executor?.reason : action === 'retry' && !revalidate && job.attempts >= job.maxAttempts ? 'Máximo de intentos alcanzado' : '';
    const button = h('button', { type: 'button', class: index === 0 ? 'btn primary' : 'btn', disabled, title: title || undefined, text: label });
    button.addEventListener('click', async () => {
      const autoRetry = action === 'retry' && job.autoIntent?.eligible && receipt?.status === 'needs_attention';
      const reviewText = action === 'retry' && revalidate
        ? 'El panel comprobará el candidato y volverá a ejecutar QA conservando Desarrollo y el informe anterior.'
        : action === 'retry' && interruptedDevelopment
        ? 'El panel verificará en Orca que el trabajador anterior salió y retomará la misma tarea con los cambios guardados.'
        : autoRetry
        ? 'Consulta Orca y confirma que no hay Run ni dispatch para este intento y que no hay agentes activos. El mismo trabajo se reintentará una vez con su recibo confirmado.'
        : 'Confirma que revisaste los efectos y que no queda ningún agente activo.';
      const ok = await confirmAction(`${label}: ${job.title}`, `Motivo: ${job.error?.message || 'Requiere revisión'}. ${reviewText} ${action === 'retry' ? 'Se volverá a encolar este trabajo.' : 'Se cerrará sin cancelar dispatches de Orca.'}`, label);
      if (!ok) return;
      button.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: JSON.stringify({ confirmReviewed: true, noDispatchConfirmed: autoRetry && !interruptedDevelopment && !revalidate }) });
        await after(`${label}: hecho.`);
      } catch (error) { await after(error.message, true); button.disabled = false; }
    });
    return button;
  });
}
