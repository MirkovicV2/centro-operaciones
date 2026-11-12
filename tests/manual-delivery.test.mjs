import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, persistIntegration, readAutoRun, recordManualDelivery, setAutoRun } from '../auto-run.mjs';
import { loadState, resolveJob } from '../queue.mjs';

const mergeSha = 'c'.repeat(40);
// Job that finished ux/developer/qa, never completed the review and whose integration never got a PR.
async function stuckJob(t, { close = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-delivery-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await setAutoRun(root, 'agency', true, { confirm: true });
  const workspace = path.join(root, 'workspaces', 'hf'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sent = await confirmSubmission(root, 'receipt-md', { id: 'md-job', business: 'agency', kind: 'code', title: 'HF', provider: 'orca', projectId: 'hf',
    prompt: 'Objetivo: integrar. Criterio: la PR queda fusionada.', workspace, isolated: true, branch: 'centro/hf',
    destination: { checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', baseBranch: 'main' },
    autoIntent: { receiptId: 'receipt-md', eligible: true } });
  const verify = async () => ({ checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', origin: 'https://github.com/owner/hf.git',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseBranch: 'main', verified: true });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    for (const key of ['ux', 'developer', 'qa']) await ctx.reportStage({ key, status: 'succeeded', summary: `${key} listo` });
    await ctx.reportStage({ key: 'reviewer', status: 'running' });
    await persistIntegration(root, { jobId: job.id, receiptId: 'receipt-md', repository: 'owner/hf', sourceBranch: 'centro/hf', baseBranch: 'main', phase: 'validation_pending', status: 'validation_pending' });
    throw Object.assign(new Error('Interrumpido'), { code: 'interrupted', uncertain: true });
  } }).tick();
  if (close) await resolveJob(root, sent.job.id, { confirm: true });
  return { root, jobId: sent.job.id };
}
const merged = n => ({ number: n, state: 'MERGED', mergedAt: '2026-11-12T00:40:00Z', mergeCommit: { oid: String(n).repeat(40).slice(0, 40) }, baseRefName: 'main', headRefName: 'centro/hf' });

for (const close of [false, true]) test(`a hand-integrated job is closed as delivered without approving the review (closed by operator: ${close})`, async t => {
  const { root, jobId } = await stuckJob(t, { close });
  assert.equal((await loadState(root)).jobs[0].state, close ? 'cancelled' : 'needs_attention');
  const calls = [];
  const gh = async args => { calls.push(args); return JSON.stringify(merged(Number(args[2]))); };
  await assert.rejects(recordManualDelivery(root, jobId, { prNumbers: [3, 4], evidence: 'x', gh }), /Confirma/);
  await assert.rejects(recordManualDelivery(root, jobId, { prNumbers: [3, 4], evidence: '', confirm: true, gh }), /informe/);
  const job = await recordManualDelivery(root, jobId, { prNumbers: [3, 4], evidence: 'Arreglo hecho por Claude; sin revisión independiente.', confirm: true, gh });
  assert.equal(job.state, 'succeeded');
  assert.equal(job.result.provider, 'owner-manual-delivery');
  const steps = Object.fromEntries(job.workflow.steps.map(step => [step.key, step.status]));
  assert.equal(steps.integration, 'succeeded');
  assert.notEqual(steps.reviewer, 'succeeded', 'the review that did not happen is never approved');
  assert.equal(steps.reviewer, 'skipped');
  assert.deepEqual(job.result.manualDelivery.skippedSteps, ['reviewer']);
  assert.deepEqual(job.result.manualDelivery.pullRequests.map(pr => pr.number), [3, 4]);
  const saved = await readAutoRun(root);
  assert.equal(saved.receipts[0].status, 'completed');
  assert.match(saved.receipts[0].reason, /sin revisión/);
  assert.equal(saved.integrations['receipt-md'].manual, true);
  assert.ok(calls.every(args => args[0] === 'pr' && args[1] === 'view'), 'read-only towards GitHub');
  await assert.rejects(recordManualDelivery(root, jobId, { prNumbers: [3], evidence: 'x', confirm: true, gh }), /parado|cerrado/, 'only once');
});

test('nothing is recorded when a PR is open, unmerged, from another branch or aimed at another base', async t => {
  for (const pr of [{ state: 'OPEN' }, { state: 'CLOSED' }, { headRefName: 'otra' }, { baseRefName: 'develop' }]) {
    const { root, jobId } = await stuckJob(t);
    await assert.rejects(recordManualDelivery(root, jobId, { prNumbers: [3], evidence: 'x', confirm: true, gh: async () => JSON.stringify({ ...merged(3), ...pr }) }));
    assert.equal((await loadState(root)).jobs[0].state, 'needs_attention');
  }
});

test('a job whose development or tests never succeeded cannot be delivered by hand', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manual-delivery-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await setAutoRun(root, 'agency', true, { confirm: true });
  const workspace = path.join(root, 'workspaces', 'hf'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sent = await confirmSubmission(root, 'receipt-nd', { id: 'nd-job', business: 'agency', kind: 'code', title: 'HF', provider: 'orca', projectId: 'hf',
    prompt: 'Objetivo: x. Criterio: y.', workspace, isolated: true, branch: 'centro/hf',
    destination: { checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', baseBranch: 'main' },
    autoIntent: { receiptId: 'receipt-nd', eligible: true } });
  const verify = async () => ({ checkout: 'workspaces/hf', workspace, branch: 'centro/hf', repository: 'owner/hf', origin: 'https://github.com/owner/hf.git',
    sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseBranch: 'main', verified: true });
  await createAutoRunner(root, { verify, worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'ux', status: 'succeeded', summary: 'ux listo' });
    await ctx.reportStage({ key: 'developer', status: 'running' });
    throw Object.assign(new Error('Interrumpido'), { code: 'interrupted', uncertain: true });
  } }).tick();
  await assert.rejects(recordManualDelivery(root, sent.job.id, { prNumbers: [3], evidence: 'x', confirm: true, gh: async () => JSON.stringify(merged(3)) }), /desarrollo y las pruebas/);
});
