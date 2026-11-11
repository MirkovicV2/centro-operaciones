// Route of a code job: which stages run, decided when the job is admitted and justified.
//   interfaz        Diseño → Desarrollo → QA → Revisión (default; the route every job had before this file)
//   funcional       Desarrollo → QA → Revisión           a functional change with no interface or gameplay to design
//   documentacion   Desarrollo → QA → Revisión           editing documentation, with checks that fit documentation
// Only Diseño can be left out. QA, Revisión and the integration checks are never optional: a job that
// touches security, data, saves, permissions or publication keeps every verification whatever its route.
// A stage left out stays in the workflow as `skipped` with its reason, so the panel can show why.
export const DEFAULT_ROUTE = 'interfaz';
export const JOB_ROUTES = Object.freeze({
  interfaz: Object.freeze({ label: 'Interfaz o jugabilidad', omits: Object.freeze([]) }),
  funcional: Object.freeze({ label: 'Cambio funcional sin interfaz', omits: Object.freeze(['ux']) }),
  documentacion: Object.freeze({ label: 'Documentación', omits: Object.freeze(['ux']) }),
});
export const OPTIONAL_STAGES = Object.freeze(['ux']);
const STAGE_NAMES = { ux: 'Diseño' };

export class JobRouteError extends Error {
  constructor(message, code = 'job_route_invalid') { super(message); this.code = code; }
}
const reasonText = value => typeof value === 'string' && value.trim().length >= 4 && value.trim().length <= 500;

// Accepts { id, reason } from the CLI, the coordinator or a saved job, and returns the stored form.
export function validateJobRoute(value, kind) {
  if (value === undefined || value === null) return undefined;
  if (kind !== 'code') throw new JobRouteError('La ruta solo aplica a trabajos de código; el análisis usa Planificación.');
  if (typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(JOB_ROUTES, value.id ?? '')) {
    throw new JobRouteError(`route.id debe ser ${Object.keys(JOB_ROUTES).join(', ')}.`);
  }
  const route = JOB_ROUTES[value.id];
  if (route.omits.length && !reasonText(value.reason)) {
    throw new JobRouteError(`La ruta ${value.id} omite ${route.omits.map(stage => STAGE_NAMES[stage]).join(', ')}: indica el motivo (4–500 caracteres).`);
  }
  if (value.reason !== undefined && value.reason !== '' && !reasonText(value.reason)) throw new JobRouteError('route.reason debe tener entre 4 y 500 caracteres.');
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  const stillOmitted = Array.isArray(value.omitted) ? value.omitted.map(item => item?.stage) : route.omits;
  return {
    id: value.id, label: route.label, ...(reason ? { reason } : {}),
    omitted: route.omits.filter(stage => stillOmitted.includes(stage)).map(stage => ({ stage, reason })),
    ...(Array.isArray(value.added) && value.added.length ? { added: value.added } : {}),
  };
}

// Reason a stage is left out of this job, or null when it runs.
export function routeOmission(job, stage) {
  const item = job?.route?.omitted?.find(entry => entry.stage === stage);
  return item ? `Omitida por la ruta «${job.route.label}»: ${item.reason}` : null;
}
export const routeOmits = (job, stage) => Boolean(job?.route?.omitted?.some(entry => entry.stage === stage));
export const stageSatisfied = step => step.status === 'succeeded' || (step.status === 'skipped' && step.routeOmitted === true);

// Scope changed: the coordinator puts a stage back. Returns the new route; the caller rewrites the step.
export function routeWithStage(route, stage, { reason, actor = null, at = new Date().toISOString() }) {
  if (!OPTIONAL_STAGES.includes(stage)) throw new JobRouteError(`Solo se puede añadir ${OPTIONAL_STAGES.map(key => STAGE_NAMES[key]).join(', ')}; QA y Revisión siempre forman parte de la ruta.`);
  if (!route?.omitted?.some(entry => entry.stage === stage)) throw new JobRouteError(`${STAGE_NAMES[stage]} ya forma parte de la ruta de este encargo.`, 'job_route_stage_present');
  if (!reasonText(reason)) throw new JobRouteError('Indica por qué cambia el alcance (4–500 caracteres).');
  return { ...route, omitted: route.omitted.filter(entry => entry.stage !== stage),
    added: [...(route.added ?? []), { stage, reason: reason.trim(), at, ...(actor ? { actor } : {}) }] };
}
