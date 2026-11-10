// Model choice per stage, in three layers (the most specific wins):
//   default  data/orca-launch-levels.json roles → level → agents[agent][level]
//   project  data/orca-launch-levels.json projects[projectId].roles → level
//   job      job.launch = { agent, roles: { <role>: { model?, effort? } } }, chosen when the job is created
// A job choice names its agent because model names are agent-specific; for another agent it is ignored.
// The resolved choice is recorded on the stage, so the report shows what each stage was launched with.
export const LAUNCH_ROLES = ['planificador', 'ux', 'desarrollador', 'qa', 'revisor'];
export const LAUNCH_AGENTS = ['codex', 'claude'];
export const flagValue = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value);
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,80}$/;

export class LaunchChoiceError extends Error {
  constructor(message) { super(message); this.code = 'launch_choice_invalid'; }
}

export function validateJobLaunch(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value) || !LAUNCH_AGENTS.includes(value.agent)) {
    throw new LaunchChoiceError('launch necesita agent (codex o claude) y roles.');
  }
  if (!value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles) || !Object.keys(value.roles).length) {
    throw new LaunchChoiceError('launch.roles debe elegir modelo y/o esfuerzo para al menos un rol.');
  }
  const roles = {};
  for (const [role, flags] of Object.entries(value.roles)) {
    if (!LAUNCH_ROLES.includes(role)) throw new LaunchChoiceError(`Rol desconocido ${role}; usa ${LAUNCH_ROLES.join(', ')}.`);
    if (!flags || typeof flags !== 'object' || Array.isArray(flags) || (flags.model === undefined && flags.effort === undefined)
      || (flags.model !== undefined && !flagValue(flags.model)) || (flags.effort !== undefined && !flagValue(flags.effort))
      || Object.keys(flags).some(key => !['model', 'effort'].includes(key))) {
      throw new LaunchChoiceError(`${role} necesita model y/o effort con caracteres [A-Za-z0-9._:-].`);
    }
    roles[role] = { ...(flags.model !== undefined ? { model: flags.model } : {}), ...(flags.effort !== undefined ? { effort: flags.effort } : {}) };
  }
  return { agent: value.agent, roles };
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
