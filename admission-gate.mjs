import { readQuota, quotaDecision } from './quota.mjs';
import { readPipeline, resolveStageLaunch, STAGE_ROLES } from './pipeline-config.mjs';
import { configuredOrcaAgent } from './local-tools.mjs';
import { readTeam, missingResources, RESOURCE_NAMES } from './team.mjs';
import { acquireClaim, releaseClaim } from './execution-claim.mjs';

// Decides, before an attempt starts and without consuming it, whether a job has to wait. Today: quota.
// A job is checked against every provider its pending stages would use, so it does not start work it would
// have to interrupt half way. Returns null to go ahead or { code, message, provider?, until? } to wait.
export async function quotaHold(job, { root, now = Date.now() }) {
  if (job.provider !== 'orca' || !job.workflow) return null;
  let quota;
  try { quota = await readQuota(root); }
  catch (error) { if (error.code !== 'quota_config_invalid') throw error; return { code: 'quota', message: `${error.message} Sin una política de cuota válida no se lanza trabajo.` }; }
  if (!Object.keys(quota.proveedores).length && quota.sinDatos === 'admitir') return null; // no policy configured on this PC
  // Loaded here because orca-provider imports the queue, which imports this gate.
  const { readLaunchLevels, LAUNCH_LEVELS, DEFAULT_LAUNCH_LEVELS } = await import('./orca-provider.mjs');
  let levels, pipeline;
  try { levels = await readLaunchLevels(root); pipeline = await readPipeline(root, { levelNames: LAUNCH_LEVELS }); }
  catch { return null; } // an invalid split is reported by the stage itself, with its own message
  const pending = job.workflow.steps.filter(step => STAGE_ROLES[step.key] && !['succeeded', 'skipped'].includes(step.status));
  const agents = new Set();
  for (const step of pending) {
    // A stage already assigned keeps its provider; one not launched yet resolves the split in force.
    if (step.dispatchId || step.retryOf) { agents.add(step.orcaAgent ?? step.retryOf?.launch?.agent ?? step.retryOf?.orcaAgent ?? 'codex'); continue; }
    try { agents.add(step.substitution?.to ?? resolveStageLaunch({ roleName: STAGE_ROLES[step.key], business: job.business, projectId: job.projectId, jobLaunch: job.launch, levels, pipeline, defaultAgent: configuredOrcaAgent(), fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles }).agent); }
    catch { return null; }
  }
  for (const agent of agents) {
    const decision = quotaDecision(quota, agent, now);
    if (decision.action === 'wait') return { code: 'quota', provider: agent, state: decision.status.state, message: decision.status.reason, ...(decision.until ? { until: decision.until } : {}) };
  }
  return null;
}

// The PC that runs a job must be the one it belongs to, have what the job needs and have a free slot.
export async function teamHold(job, { root, jobs = [] }) {
  let team;
  try { team = await readTeam(root); }
  catch (error) { if (error.code !== 'team_config_invalid') throw error; return { code: 'team', message: `${error.message} Sin un equipo válido no se despacha.` }; }
  if (!team.configured) return null;
  // A provisional team (stamped before this PC had a data/equipo.json) is only the host name: it is replaced, not enforced.
  if (job.team?.id && !job.team.provisional && job.team.id !== team.id) return { code: 'team', message: `Este encargo pertenece al equipo ${job.team.nombre || job.team.id}; este PC (${team.nombre}) no lo ejecuta.` };
  const { missing, elsewhere } = missingResources(team, job);
  if (missing.length) return { code: 'resource', message: `Este PC (${team.nombre}) no dispone de ${missing.map(item => RESOURCE_NAMES[item]).join(' ni ')}, que el encargo necesita. ${elsewhere.length ? `Lo tiene: ${elsewhere.map(item => item.nombre).join(', ')}.` : 'Ningún equipo registrado lo tiene.'}` };
  const running = jobs.filter(item => item.id !== job.id && item.state === 'running').length;
  if (running >= team.concurrencia) return { code: 'concurrency', message: `Este PC ejecuta ${team.concurrencia} trabajo${team.concurrencia === 1 ? '' : 's'} a la vez y ya hay ${running} en marcha.` };
  return null;
}

const claimable = job => job.kind === 'code' && job.provider === 'orca' && job.workspace && job.branch;
// Takes or renews the reservation of the job's branch on the project's remote. null = held (or reservations are off).
export async function claimHold(job, { root, now = Date.now(), acquire = acquireClaim }) {
  if (!claimable(job)) return null;
  let team;
  try { team = await readTeam(root); } catch { return null; } // reported by teamHold
  if (!team.configured || !team.reservas.activas) return null;
  try {
    const result = await acquire({ workspace: job.workspace, remote: team.reservas.remoto, branch: job.branch, team: team.id, jobId: job.id, ttlMs: team.reservas.caducidadMinutos * 60_000, now });
    if (result.held) return null;
    const holder = team.equipos[result.by]?.nombre ?? result.by;
    return { code: 'claim', message: `La rama ${job.branch} está reservada por ${holder}${result.jobId ? ` (encargo ${result.jobId})` : ''}${result.expiresAt ? ` hasta ${result.expiresAt}` : ''}.`, ...(result.expiresAt ? { until: result.expiresAt } : {}) };
  } catch (error) {
    if (!String(error.code ?? '').startsWith('claim_')) throw error;
    return { code: 'claim', message: `${error.message} Sin reserva confirmada no se despacha.` };
  }
}
export async function releaseJobClaim(job, root, { release = releaseClaim } = {}) {
  if (!claimable(job)) return;
  const team = await readTeam(root).catch(() => null);
  if (!team?.configured || !team.reservas.activas) return;
  await release({ workspace: job.workspace, remote: team.reservas.remoto, branch: job.branch, team: team.id, jobId: job.id });
}

// Gates run in order; the first that asks to wait wins. The reservation goes last: it is the only one that uses the network.
export const ADMISSION_GATES = [quotaHold, teamHold, claimHold];
export async function admissionHold(job, context) {
  for (const gate of ADMISSION_GATES) { const hold = await gate(job, context); if (hold) return hold; }
  // Nothing to wait for: the job starts on this PC, which becomes its responsible team if it had none.
  const team = await readTeam(context.root).catch(() => null);
  if (!team) return null;
  return { admit: { team: job.team && !job.team.provisional ? job.team : { id: team.id, nombre: team.nombre, ...(team.configured ? {} : { provisional: true }) } } };
}
