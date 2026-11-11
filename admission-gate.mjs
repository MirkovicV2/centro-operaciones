import { readQuota, quotaDecision } from './quota.mjs';
import { readPipeline, resolveStageLaunch, STAGE_ROLES } from './pipeline-config.mjs';
import { configuredOrcaAgent } from './local-tools.mjs';

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

// Gates run in order; the first that asks to wait wins. Other gates (execution claim between PCs) are added here.
export const ADMISSION_GATES = [quotaHold];
export async function admissionHold(job, context) {
  for (const gate of ADMISSION_GATES) { const hold = await gate(job, context); if (hold) return hold; }
  return null;
}
