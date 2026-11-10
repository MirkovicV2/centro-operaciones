import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, reconcileOwnerMergedIntegration, setAutoRun } from '../auto-run.mjs';
import { loadState } from '../queue.mjs';

const commitSha = 'd'.repeat(40), mergeSha = 'c'.repeat(40);
async function stuckJob(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owner-merge-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await setAutoRun(root, 'agency', true, { confirm: true });
  const workspace = path.join(root, 'workspaces', 'hf'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sent = await confirmSubmission(root, 'receipt-om', { id: 'om-job', business: 'agency', kind: 'code', title: 'HF', provider: 'orca', projectId: 'hf',
    prompt: 'Objetivo: integrar. Criterio: la PR queda fusionada.', workspace, isolated: true, branch: 'centro/hf',
    destination: { checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', baseBranch: 'main' },
    autoIntent: { receiptId: 'receipt-om', eligible: true } });
  const verify = async () => ({ checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', origin: 'https://github.com/owner/hf.git',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseBranch: 'main', baseSha: 'b'.repeat(40), verified: true });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    for (const key of ['ux', 'developer', 'qa', 'reviewer']) await ctx.reportStage({ key, status: 'succeeded', summary: `${key} listo` });
    await persistIntegration(root, { jobId: job.id, receiptId: 'receipt-om', repository: 'owner/hf', sourceBranch: 'centro/hf', baseBranch: 'main',
      phase: 'checks_pending', status: 'checks_pending', prNumber: 1, prUrl: 'https://github.com/owner/hf/pull/1', commitSha, checkState: 'waiting' });
    await ctx.reportStage({ key: 'integration', status: 'blocked', error: 'integration_needs_attention', summary: 'PR pendiente de revisión: La PR dejó de estar abierta.' });
    throw Object.assign(new Error('PR pendiente de revisión: La PR dejó de estar abierta.'), { code: 'github_checks_blocked', uncertain: true });
  } }).tick();
  return { root, jobId: sent.job.id };
}
const identity = { number: 1, url: 'https://github.com/owner/hf/pull/1', isCrossRepository: false, headRepository: { name: 'hf' }, headRepositoryOwner: { login: 'owner' },
  headRefName: 'centro/hf', baseRefName: 'main', headRefOid: commitSha, baseRefOid: 'b'.repeat(40) };

test('a PR the owner merged by hand closes the stuck job as integrated, after checking it on GitHub', async t => {
  const { root, jobId } = await stuckJob(t);
  assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  const calls = [];
  const gh = async args => { calls.push(args); return JSON.stringify({ ...identity, state: 'MERGED', mergedAt: '2026-11-10T23:26:00Z', mergeCommit: { oid: mergeSha } }); };
  await assert.rejects(reconcileOwnerMergedIntegration(root, jobId, { gh }), /Confirma/);
  const job = await reconcileOwnerMergedIntegration(root, jobId, { confirm: true, gh });
  assert.equal(job.state, 'succeeded');
  assert.equal(job.workflow.steps.find(step => step.key === 'integration').status, 'succeeded');
  assert.equal(job.result.integration.mergeSha, mergeSha);
  const saved = await readAutoRun(root);
  assert.equal(saved.receipts[0].status, 'completed');
  assert.match(saved.receipts[0].reason, /integrada/);
  assert.equal(saved.integrations['receipt-om'].phase, 'complete');
  assert.equal(saved.integrations['receipt-om'].mergedBy, 'owner');
  assert.ok(calls.every(args => args[0] === 'pr' && args[1] === 'view'), 'read-only towards GitHub');
  await assert.rejects(reconcileOwnerMergedIntegration(root, jobId, { confirm: true, gh }), /no tiene una PR/, 'only once');
});

test('nothing is reconciled when the PR is open, closed unmerged or points at another commit', async t => {
  for (const pr of [{ state: 'OPEN' }, { state: 'CLOSED' }, { state: 'MERGED', mergedAt: '2026-11-10T23:26:00Z', mergeCommit: { oid: mergeSha }, headRefOid: 'e'.repeat(40) },
    { state: 'MERGED', mergedAt: '2026-11-10T23:26:00Z', mergeCommit: { oid: mergeSha }, baseRefName: 'develop' }]) {
    const { root, jobId } = await stuckJob(t);
    await assert.rejects(reconcileOwnerMergedIntegration(root, jobId, { confirm: true, gh: async () => JSON.stringify({ ...identity, ...pr }) }));
    assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
    assert.equal((await readAutoRun(root)).integrations['receipt-om'].phase, 'checks_pending');
  }
});
