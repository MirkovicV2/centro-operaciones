import { safeMarkdownText } from './agency-assistant/knowledge.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
const at = job => job.workflow?.updatedAt || job.finishedAt || job.createdAt || '';
const summary = value => safeMarkdownText(value).replace(/\s+/g, ' ').trim().slice(0, 430);
const locallyApproved = job => ['qa', 'reviewer'].every(key => job?.workflow?.steps?.some(item => item.key === key
  && item.status === 'succeeded' && item.delivery?.approval === 'approved'));

export function projectMemory(scope, jobs, { jobId } = {}) {
  if (!scope.projectId) return null;
  const related = jobs.filter(job => job.projectId === scope.projectId && job.business === scope.business && job.kind === 'code');
  if (!related.some(job => job.coordination)) return null;
  const byTime = (a, b) => at(b).localeCompare(at(a)) || a.id.localeCompare(b.id);
  const published = related.filter(job => {
    const result = job.result?.integration;
    return job.state === 'succeeded' && result?.phase === 'complete' && result.status === 'completed'
      && result.jobId === job.id && result.receiptId === job.autoIntent?.receiptId
      && result.receiptId && sha(result.commitSha) && sha(result.mergeSha) && result.mergedAt;
  }).sort((a, b) => b.result.integration.mergedAt.localeCompare(a.result.integration.mergedAt) || byTime(a, b))[0];
  const released = published?.result.integration;
  const local = related.filter(job => job.state === 'succeeded' && !job.result?.integration?.mergeSha && locallyApproved(job)).sort(byTime)[0];
  const withdrawn = related.filter(job => job.state === 'cancelled').sort(byTime)[0];
  const active = related.filter(job => ['running', 'queued', 'retry_wait', 'needs_attention'].includes(job.state)).sort(byTime);
  const working = active.find(job => job.id === jobId) || active[0];
  const stage = working?.workflow?.currentStage;
  const steps = (working?.workflow?.steps || []).map(item => ({
    stage: item.key, label: item.label || item.key, state: item.status,
    ...(item.dispatchId ? { dispatchId: item.dispatchId } : {}),
    ...(item.delivery?.summary ? { summary: summary(item.delivery.summary) } : {}),
  }));
  const seen = new Set();
  const history = (working?.workflowHistory || []).slice().reverse().flatMap(workflow => (workflow.steps || []).filter(item =>
    ['blocked', 'failed'].includes(item.status) && item.dispatchSettled && item.dispatchId && item.delivery?.summary && !seen.has(item.dispatchId) && seen.add(item.dispatchId))
    .map(item => ({ stage: item.key, dispatchId: item.dispatchId, summary: summary(item.delivery.summary) }))).slice(0, 3);
  return {
    projectId: scope.projectId, business: scope.business,
    published: released ? { jobId: published.id, title: published.title, sourceSha: released.commitSha,
      mergeSha: released.mergeSha, branch: released.baseBranch, mergedAt: released.mergedAt,
      ...(released.prUrl ? { prUrl: released.prUrl } : {}) } : null,
    ...(local ? { localApproval: { jobId: local.id, title: local.title, at: at(local) } } : {}),
    ...(withdrawn ? { lastWithdrawn: { jobId: withdrawn.id, title: withdrawn.title, at: at(withdrawn),
      ...(withdrawn.error?.message ? { reason: summary(withdrawn.error.message) } : {}) } } : {}),
    working: working ? { jobId: working.id, title: working.title, state: working.state, stage, steps, history,
      locallyApproved: locallyApproved(working) } : null,
  };
}
