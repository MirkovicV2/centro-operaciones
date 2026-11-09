import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runOrca } from '../orca-provider.mjs';
import { saveStageReport } from '../orca-evidence.mjs';
import { verifyUnicodeDeliveryTransport } from '../orca-delivery-transport.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const criterion = 'Añadir mediante botón y tecla Enter.';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'unicode-provider-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const runId = 'run_unicode001', jobId = 'unicode-provider-job';
  const identities = Object.fromEntries(['qa', 'reviewer'].map(stage => [stage, {
    jobId, jobAttempt: 2, stage, dispatchId: `ctx_unicode_${stage}`, taskId: `task_unicode_${stage}`, runId, workerState: 'succeeded',
  }]));
  const deliveries = Object.fromEntries(Object.entries(identities).map(([stage, identity]) => {
    const delivery = { version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: `${stage}: validación íntegra.`, approval: 'approved',
      acceptance: [{ criterion, status: 'passed', evidence: 'Comprobé el botón y Enter.' }], evidence: ['Comprobación local registrada.'], questions: [], decisions: [] };
    delete delivery.workerState; return [stage, delivery];
  }));
  const originals = Object.fromEntries(Object.entries(deliveries).map(([stage, delivery]) => [stage, JSON.stringify(delivery)]));
  const damaged = Object.fromEntries(Object.entries(originals).map(([stage, text]) => [stage, text.replace(/[^\x00-\x7f]/g, '?')]));
  const artifact = await saveStageReport(root, identities.qa, damaged.qa, null);
  const qa = { key: 'qa', ...identities.qa, attempt: 2, taskInputAttempt: 2, status: 'blocked', dispatchStatus: 'completed', dispatchSettled: true,
    error: 'delivery_acceptance_missing', artifact, summary: 'Damaged report retained.', deliveryVersion: 1 };
  const job = { id: jobId, kind: 'code', provider: 'orca', business: 'agency', attempts: 2, maxAttempts: 2, title: 'Validar Unicode', prompt: 'Validar el botón y Enter.',
    contract: { version: 1, acceptance: [criterion] }, workspace, branch: 'feature', isolated: true,
    destination: { workspace, checkout: 'workspaces/checkout', branch: 'feature', baseBranch: 'main', repository: 'fixture/repo' },
    autoIntent: { receiptId: 'receipt-unicode-provider', eligible: true }, workflow: { runId, currentStage: 'qa', steps: [
      { key: 'ux', status: 'succeeded', summary: 'UX aprobada.', dispatchId: 'ctx_unicode_ux', taskId: 'task_unicode_ux', runId },
      { key: 'developer', status: 'succeeded', summary: 'Desarrollo terminado.', dispatchId: 'ctx_unicode_dev', taskId: 'task_unicode_dev', runId },
      qa, { key: 'reviewer', status: 'queued' },
    ] } };
  const starts = [], updates = [], archiveReads = [], verifications = [];
  let integrated = 0;
  const command = async args => {
    if (args[0] === 'repo' && args[1] === 'list') return { repos: [{ path: workspace }] };
    if (args[1] === 'worker-start') {
      assert.ok(args.includes('--spec')); starts.push('reviewer');
      assert.ok(args.includes(JSON.stringify([identities.qa.taskId])));
      return { dispatchId: identities.reviewer.dispatchId, taskId: identities.reviewer.taskId };
    }
    if (args[1] === 'worker-show') {
      const identity = Object.values(identities).find(item => item.dispatchId === args[args.indexOf('--dispatch') + 1]);
      assert.ok(identity); return { ...identity, state: 'succeeded', liveness: 'exited', workspace };
    }
    if (args[1] === 'inbox') return { messages: ['qa', ...(starts.length ? ['reviewer'] : [])].map(stage => ({
      id: `msg_unicode_${stage}`, type: 'worker_done', run_id: runId, to_handle: `run:${runId}`,
      payload: { ...identities[stage], outcome: 'succeeded' }, body: damaged[stage],
    })) };
    assert.fail('Unexpected native command: ' + args.join(' '));
  };
  const readArchivedFinal = async identity => {
    assert.deepEqual(identity, identities[identity.stage]); archiveReads.push(identity.stage);
    return { text: originals[identity.stage], sourceIdentity: `verified-fixture-${identity.stage}`, messageId: `final_unicode_${identity.stage}`,
      sha256: sha(originals[identity.stage]), provenance: { source: 'native_archived_transcript' } };
  };
  const repaired = await verifyUnicodeDeliveryTransport(root, job, qa, { command, readArchive: readArchivedFinal });
  job.livenessResume = { mode: 'same_attempt_delivery_transport', phase: 'consumed', stage: 'qa', dispatchId: identities.qa.dispatchId,
    deliveryTransport: repaired.proof };
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, history: [],
    receipts: [{ id: job.autoIntent.receiptId, jobId, eligible: true }], integrations: { [job.autoIntent.receiptId]: {
      jobId, receiptId: job.autoIntent.receiptId, phase: 'validation_pending', validation: { version: 1, jobId, receiptId: job.autoIntent.receiptId,
        attempt: 2, runId, workspace, branch: job.branch, developerTaskId: 'task_unicode_dev', developerDispatchId: 'ctx_unicode_dev',
        developerArtifactSha256: null, cycleId: 'attempt-2', snapshot: sha('fixture reviewed changes'), capturedAt: '2026-11-08T12:00:00Z' },
    } } }));
  const ctx = { root, signal: new AbortController().signal, registerCleanup() {}, async reportStage(update) { updates.push(update); } };
  const dependencies = { command, readArchivedFinal,
    verifyDestination: async (_root, _job, options) => { verifications.push(options); assert.equal(options.requireClean, false); return job.destination; },
    captureSnapshot: async () => sha('fixture reviewed changes'),
    integrate: async value => { integrated++; assert.equal(value.attempts, 2); return { phase: 'complete' }; },
  };
  return { root, job, qa, originals, damaged, starts, updates, archiveReads, ctx, dependencies, deliveries, integrated: () => integrated };
}

test('real provider repairs existing QA and later reviewer independently without starting QA or repeating prior stages', async t => {
  const f = await fixture(t), originalArtifact = await fs.readFile(f.qa.artifact.path, 'utf8');
  const result = await runOrca(f.job, f.ctx, f.dependencies);
  assert.deepEqual(f.starts, ['reviewer']); assert.equal(result.metrics.dispatchStarts, 1);
  assert.deepEqual(f.archiveReads, ['qa', 'qa', 'reviewer']); assert.equal(f.integrated(), 1);
  for (const stage of ['qa', 'reviewer']) {
    const completed = f.updates.find(update => update.key === stage && update.status === 'succeeded');
    assert.ok(completed); assert.deepEqual(completed.delivery, f.deliveries[stage]);
    assert.equal(completed.approvalOutcome, 'approved'); assert.equal(completed.attempt, 2);
    assert.equal(completed.deliveryTransport.kind, 'unicode_loss');
    assert.equal(completed.deliveryTransport.transcriptSourceIdentity, `verified-fixture-${stage}`);
    assert.equal(completed.resultMessageId, `msg_unicode_${stage}`);
    assert.notEqual(completed.artifact.sha256, completed.deliveryTransport.originalArtifactSha256);
  }
  assert.equal(await fs.readFile(f.qa.artifact.path, 'utf8'), originalArtifact);
  assert.equal(f.job.attempts, 2); assert.equal(f.job.maxAttempts, 2);
});

test('real provider blocks changed recovery proof before reviewer start or integration', async t => {
  const f = await fixture(t);
  f.job.livenessResume.deliveryTransport.transcriptSha256 = sha('foreign archived result');
  await assert.rejects(runOrca(f.job, f.ctx, f.dependencies), { code: 'delivery_acceptance_missing' });
  assert.deepEqual(f.starts, []); assert.equal(f.integrated(), 0);
  assert.ok(f.updates.some(update => update.key === 'qa' && update.status === 'blocked' && update.error === 'delivery_acceptance_missing'));
  assert.ok(!f.updates.some(update => update.key === 'qa' && update.status === 'succeeded'));
});
