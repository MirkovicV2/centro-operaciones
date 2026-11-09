const RUN = /^run_[A-Za-z0-9_-]{6,80}$/;
const SENDER = /^[A-Za-z0-9_.:-]{6,160}$/;

export const coordinatedStages = Object.freeze(['planner', 'ux', 'developer', 'qa', 'reviewer', 'integration']);

// The coordinator's routed contract grants the ordinary stage sequence and
// bounded corrections of reproducible findings inside the same product scope.
export function stageAuthorization(job, to, source, correction) {
  if (!job.coordination) return undefined;
  const { requestId, runId, senderId, coordinatorName } = jobCoordination(job.coordination, job);
  const origin = correction?.originalSteps.find(item => item.stage === correction.stage);
  return {
    requestId, jobId: job.id, runId, senderId, coordinatorName: coordinatorName || 'Coordinador',
    business: job.business, to, mode: correction ? 'contract_correction' : 'routed_sequence',
    ...(origin ? { from: origin.stage, taskId: origin.taskId, dispatchId: origin.dispatchId,
      messageId: correction.qualityAction.messageId, round: correction.qualityAction.round }
      : source ? { from: source.stage, taskId: source.taskId, dispatchId: source.dispatchId } : {}),
  };
}

// A receipt fixes the coordinator as well as the project. Later configuration
// changes cannot silently transfer an admitted job to another agent.
export function jobCoordination(value, spec) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || !RUN.test(value.runId || '') || !SENDER.test(value.senderId || '')
    || !/^[A-Za-z0-9_-]{8,100}$/.test(value.requestId || '')
    || value.business !== spec.business || (value.projectId || null) !== (spec.projectId || null)) {
    throw Object.assign(new Error('La coordinación no coincide con el encargo y su proyecto.'), { code: 'coordinator_job_mismatch' });
  }
  return Object.fromEntries(['requestId', 'coordinatorId', 'coordinatorName', 'runId', 'senderId', 'business', 'projectId']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}
