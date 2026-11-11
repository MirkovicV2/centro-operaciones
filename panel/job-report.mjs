import { matchesCriterion } from '../workflow-contract.mjs';

// E (per-job report): one read-only summary of what was asked, what each stage did and with which evidence.
// Each fact carries a level, so nobody mistakes what an agent said for what the Centro verified:
//   observed  the Centro saw it itself (exact Orca dispatch settled, Git/GitHub effect confirmed)
//   reported  an agent stated it in its delivery (summary, criteria, findings)
//   unknown   nobody has shown it yet
// Built only from the job and its integration record; it never changes either.
const STAGES = [['ux', 'UX'], ['developer', 'Desarrollo'], ['qa', 'QA'], ['reviewer', 'Revisión'], ['integration', 'Integración']];
const isSha = value => /^[a-f0-9]{40}$/i.test(value ?? '');
const clip = (value, limit = 600) => String(value ?? '').slice(0, limit);

// What the Centro launched the stage with. Older stages only recorded the agent and level: the model is unknown.
const sources = { escalada: 'escalada pedida en el encargo', encargo: 'elegido en el encargo', proyecto: 'por defecto del proyecto', empresa: 'perfil de la empresa', general: 'perfil general', 'por defecto': 'por defecto' };
function launchText(step) {
  const launch = step.launch;
  if (launch?.agent) {
    const model = launch.model ? `${launch.model}${launch.effort ? ` · esfuerzo ${launch.effort}` : ''}` : `modelo por defecto de ${launch.agent}${launch.effort ? ` · esfuerzo ${launch.effort}` : ''}`;
    return { value: `${launch.agent} · ${model} (${sources[launch.source] || launch.source}${launch.level ? `, nivel ${launch.level}` : ''})`, level: 'observed' };
  }
  if (step.orcaAgent) return { value: `${step.orcaAgent}${step.launchLevel ? ` · nivel ${step.launchLevel}` : ''} · modelo no registrado`, level: 'unknown' };
  return null;
}

function stageReport(job, key, label) {
  const step = job.workflow?.steps?.find(item => item.key === key);
  if (!step) return { key, label, status: 'not_started', level: 'unknown', facts: [] };
  // Left out by the job's route: not a failure and not pending. The reason is the Centro's own record.
  if (step.status === 'skipped' && step.routeOmitted) return { key, label, status: 'omitted', level: 'observed', facts: [{ label: 'Etapa omitida', value: clip(step.summary), level: 'observed' }] };
  const exact = Boolean(step.runId && step.taskId && step.dispatchId);
  const facts = [{ label: 'Estado', value: step.status, level: exact && ['succeeded', 'blocked', 'failed'].includes(step.status) ? 'observed' : 'unknown' }];
  if (exact) facts.push({ label: 'Dispatch', value: step.dispatchId, level: 'observed' });
  const launched = launchText(step);
  if (launched) facts.push({ label: 'Modelo', ...launched });
  if (step.skills?.length) facts.push({ label: 'Skills suministradas', value: step.skills.map(skill => `${skill.id} (${skill.manifest.slice(0, 12)})`).join(', '), level: 'observed' });
  if (step.skills?.length && step.skillsConsulted) facts.push({ label: 'Skills consultadas', value: step.skillsConsulted.length ? step.skillsConsulted.join(', ') : 'Ninguna declarada', level: 'reported' });
  for (const item of step.skillsOmitted ?? []) facts.push({ label: 'Skill no entregada', value: clip(`${item.id}: ${item.reason}`), level: 'observed' });
  const delivery = step.delivery;
  if (delivery?.summary) facts.push({ label: 'Resumen del agente', value: clip(delivery.summary), level: 'reported' });
  else if (step.summary) facts.push({ label: 'Resumen', value: clip(step.summary), level: 'reported' });
  for (const finding of delivery?.findings ?? []) {
    facts.push({ label: finding.severity === 'blocking' ? 'Hallazgo bloqueante' : 'Hallazgo menor', value: clip(finding.summary), evidence: clip(finding.evidence), level: 'reported' });
  }
  if (delivery?.candidate) facts.push({ label: 'Candidato revisado', value: delivery.candidate, level: 'reported' });
  return { key, label, status: step.status, level: exact ? 'observed' : 'unknown', facts };
}

// The latest verdict on each contract criterion: Revisión first, then QA. A criterion nobody covered is unknown.
function criteriaReport(job) {
  const deliveries = ['reviewer', 'qa'].map(key => [key, job.workflow?.steps?.find(step => step.key === key)?.delivery]).filter(([, delivery]) => delivery);
  return (job.contract?.acceptance ?? []).map(criterion => {
    for (const [stage, delivery] of deliveries) {
      const item = (delivery.acceptance ?? []).find(entry => matchesCriterion(entry, criterion));
      if (item) return { criterion, status: item.status, stage, evidence: clip(item.evidence), level: 'reported' };
    }
    return { criterion, status: 'unverified', stage: null, evidence: '', level: 'unknown' };
  });
}

function integrationReport(job, record) {
  if (!job.autoIntent?.eligible) return { applies: false, facts: [] };
  if (!record) return { applies: true, phase: null, facts: [{ label: 'Integración', value: 'sin registro', level: 'unknown' }] };
  const facts = [{ label: 'Fase', value: record.phase, level: 'observed' }];
  if (isSha(record.commitSha)) facts.push({ label: 'Commit', value: record.commitSha, level: 'observed' });
  if (record.prUrl) facts.push({ label: 'PR', value: record.prUrl, level: 'observed' });
  if (record.checkState) facts.push({ label: 'Checks', value: record.checkState, level: 'observed' });
  if (isSha(record.mergeSha)) facts.push({ label: 'Merge', value: record.mergeSha, level: 'observed' });
  else if (record.sourceBranch !== record.baseBranch) facts.push({ label: 'Merge', value: 'no confirmado', level: 'unknown' });
  return { applies: true, phase: record.phase, facts };
}

export function jobReport(job, integration = null) {
  const criteria = criteriaReport(job);
  const stages = STAGES.filter(([key]) => key !== 'integration').map(([key, label]) => stageReport(job, key, label));
  const integrationPart = integrationReport(job, integration);
  const all = [...stages.flatMap(stage => stage.facts), ...criteria, ...integrationPart.facts];
  const count = level => all.filter(item => item.level === level).length;
  return {
    jobId: job.id, title: clip(job.title, 160), state: job.state, attempt: job.attempts ?? null,
    asked: { objective: clip(job.contract?.objective || job.prompt || '', 1200), criteria: job.contract?.acceptance ?? [] },
    stages, criteria, integration: integrationPart,
    totals: { observed: count('observed'), reported: count('reported'), unknown: count('unknown') },
  };
}
