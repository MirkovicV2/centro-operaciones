// Model choice per stage, in three layers (the most specific wins):
//   default  data/orca-launch-levels.json roles → level → agents[agent][level]
//   project  data/orca-launch-levels.json projects[projectId].roles → level
//   job      job.launch, chosen when the job is created (forms in validateJobLaunch)
// This file keeps the per-agent primitives. The agent of each stage and the full precedence
// (general → empresa → proyecto → encargo) are resolved in pipeline-config.mjs.
// The resolved choice is recorded on the stage, so the report shows what each stage was launched with.
export const LAUNCH_ROLES = ['planificador', 'ux', 'desarrollador', 'qa', 'revisor'];
export const LAUNCH_AGENTS = ['codex', 'claude'];
export const flagValue = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export class LaunchChoiceError extends Error {
  constructor(message) { super(message); this.code = 'launch_choice_invalid'; }
}

const ESCALATION_TEXT = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;

// Two forms, both kept:
//   legacy  { agent, roles: { <role>: { model?, effort? } } }   bound to that agent; ignored if the stage runs with another
//   current { roles: { <role>: { agent?, model?, effort? } } }  a role may choose its own agent (a model always needs one)
// A role may instead request a configured escalation: { escalada, motivo, alcance, resultado }.
export function validateJobLaunch(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || (value.agent !== undefined && !LAUNCH_AGENTS.includes(value.agent))
    || Object.keys(value).some(key => !['agent', 'roles'].includes(key))) {
    throw new LaunchChoiceError('launch admite agent (codex o claude) y roles.');
  }
  if (!value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles) || !Object.keys(value.roles).length) {
    throw new LaunchChoiceError('launch.roles debe elegir agente, modelo y/o esfuerzo para al menos un rol.');
  }
  const roles = {};
  for (const [role, flags] of Object.entries(value.roles)) {
    if (!LAUNCH_ROLES.includes(role)) throw new LaunchChoiceError(`Rol desconocido ${role}; usa ${LAUNCH_ROLES.join(', ')}.`);
    if (flags && typeof flags === 'object' && !Array.isArray(flags) && flags.escalada !== undefined) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(flags.escalada) || Object.keys(flags).some(key => !['escalada', 'motivo', 'alcance', 'resultado'].includes(key))
        || !['motivo', 'alcance', 'resultado'].every(key => ESCALATION_TEXT(flags[key]))) {
        throw new LaunchChoiceError(`${role}: una escalada necesita escalada, motivo, alcance y resultado verificable (textos de hasta 500 caracteres).`);
      }
      roles[role] = { escalada: flags.escalada, motivo: flags.motivo.trim(), alcance: flags.alcance.trim(), resultado: flags.resultado.trim() };
      continue;
    }
    if (!flags || typeof flags !== 'object' || Array.isArray(flags) || !['agent', 'model', 'effort'].some(key => flags[key] !== undefined)
      || (flags.model !== undefined && !flagValue(flags.model)) || (flags.effort !== undefined && !flagValue(flags.effort))
      || Object.keys(flags).some(key => !['agent', 'model', 'effort'].includes(key))) {
      throw new LaunchChoiceError(`${role} necesita agent, model y/o effort; model y effort con caracteres [A-Za-z0-9._:-].`);
    }
    if (flags.agent !== undefined && !LAUNCH_AGENTS.includes(flags.agent)) throw new LaunchChoiceError(`${role}: agent debe ser codex o claude.`);
    if (flags.model !== undefined && flags.agent === undefined && value.agent === undefined) {
      throw new LaunchChoiceError(`${role}: un model pertenece a un proveedor; indica agent (codex o claude) en el rol o en launch.`);
    }
    roles[role] = Object.fromEntries(['agent', 'model', 'effort'].filter(key => flags[key] !== undefined).map(key => [key, flags[key]]));
  }
  return { ...(value.agent !== undefined ? { agent: value.agent } : {}), roles };
}

export function normalizeProjectLevels(value, levelNames, fail) {
  const projects = {};
  if (value === undefined) return projects;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('projects debe ser un objeto por id de proyecto.');
  for (const [id, entry] of Object.entries(value)) {
    if (!PROJECT_ID.test(id)) fail(`id de proyecto inválido ${id}.`);
    if (!entry || typeof entry !== 'object' || !entry.roles || typeof entry.roles !== 'object' || Array.isArray(entry.roles)) fail(`projects.${id} necesita roles.`);
    projects[id] = { roles: {} };
    for (const [role, level] of Object.entries(entry.roles)) {
      if (!LAUNCH_ROLES.includes(role)) fail(`rol desconocido ${role} en projects.${id}.`);
      if (!levelNames.includes(level)) fail(`nivel desconocido ${level} para ${role} en projects.${id}; usa ${levelNames.join(', ')}.`);
      projects[id].roles[role] = level;
    }
  }
  return projects;
}

// Returns what a stage is launched with and where it came from. model/effort null = the agent's own default.
export function resolveLaunch({ roleName, agent, levels, projectId = null, jobLaunch = null, fallbackRoles = {} }) {
  const chosen = jobLaunch?.agent === agent ? jobLaunch.roles?.[roleName] : undefined;
  if (chosen) return { agent, level: null, model: chosen.model ?? null, effort: chosen.effort ?? null, source: 'encargo' };
  const projectLevel = projectId ? levels.projects?.[projectId]?.roles?.[roleName] : undefined;
  const level = projectLevel ?? levels.roles?.[roleName] ?? fallbackRoles[roleName];
  const flags = levels.agents?.[agent]?.[level];
  return { agent, level: level ?? null, model: flags?.model ?? null, effort: flags?.effort ?? null, source: projectLevel ? 'proyecto' : 'por defecto' };
}

export const launchArgs = launch => [...(launch.model ? ['--model', launch.model] : []), ...(launch.effort ? ['--effort', launch.effort] : [])];
