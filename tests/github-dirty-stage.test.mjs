import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyGitHubDestination } from '../project-destination.mjs';
import { runOrca } from '../orca-provider.mjs';
import { confirmSubmission, createAutoRunner, readAutoRun, setAutoRun } from '../auto-run.mjs';

const sourceSha = 'a'.repeat(40), baseSha = 'b'.repeat(40);
async function fixture(t, { dirtyAt = 'afterDeveloper', completed = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'github-dirty-stage-'));
  const workspace = path.join(root, 'workspaces', 'checkout');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { dirty: dirtyAt === 'admission' || completed.includes('developer'), commands: [], checks: [], starts: [], snapshots: [], integrations: [] };
  const job = {
    id: 'dirty-stage-job', business: 'agency', kind: 'code', provider: 'orca', attempts: 1,
    title: 'Implementar y validar', prompt: 'Implementar el cambio y comprobarlo.', workspace, isolated: true, branch: 'develop',
    destination: { checkout: 'workspaces/checkout', workspace, branch: 'develop', repository: 'owner/repo', baseBranch: 'main', remoteSha: sourceSha, baseSha },
    autoIntent: { receiptId: 'receipt-dirty-stage', eligible: true },
    ...(completed.length ? { workflow: { runId: 'run_abcdef', steps: completed.map(key => ({
      key, status: 'succeeded', summary: `${key} terminado.\nRESULTADO: APROBADO`, dispatchId: `ctx_${key}0001`, taskId: `task_${key}0001`,
      ...(key === 'qa' ? { approvalOutcome: 'approved', approvalDispatchId: 'ctx_qa0001' } : {}),
    })) } } : {}),
  };
  const inspect = async () => ({ checkout: 'workspaces/checkout', workspace, branch: 'develop', valid: true });
  const git = async args => {
    state.commands.push(args);
    if (args[0] === 'remote') return state.origin ?? 'https://github.com/owner/repo.git';
    if (args[0] === 'symbolic-ref') return state.branch ?? 'develop';
    if (args[0] === 'rev-parse') return sourceSha;
    if (args[0] === 'status') return state.dirty ? ' M index.html' : '';
    if (args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/develop') return `${state.remoteSha ?? sourceSha}\trefs/heads/develop`;
    if (args[0] === 'ls-remote' && args.at(-1) === 'refs/heads/main') return state.missingBase ? '' : `${baseSha}\trefs/heads/main`;
    assert.fail(`Unexpected Git command: ${args.join(' ')}`);
  };
  const verify = (targetRoot, targetJob, options = {}) => {
    state.checks.push({ requireClean: options.requireClean ?? true, dirty: state.dirty });
    return verifyGitHubDestination(targetRoot, targetJob, { ...options, git, inspect });
  };
  const ctx = { root, signal: new AbortController().signal, updates: [], registerCleanup() {}, async reportStage(update) { this.updates.push(update); } };
  let active;
  const command = async args => {
    if (args[0] === 'repo') {
      if (dirtyAt === 'ux') state.dirty = true;
      return { repos: [{ path: workspace }] };
    }
    if (args[1] === 'run-create') return { runId: 'run_abcdef' };
    if (args[1] === 'worker-start') {
      active = ctx.updates.at(-1).key;
      state.starts.push(active);
      return { dispatchId: `ctx_${active}0001`, taskId: `task_${active}0001` };
    }
    if (args[1] === 'worker-show') {
      if (active === 'developer' || (active === 'ux' && dirtyAt === 'developer')) state.dirty = true;
      return { state: 'succeeded', runId: 'run_abcdef', taskId: `task_${active}0001` };
    }
    if (args[1] === 'inbox') return { messages: [{ type: 'worker_done', body: `${active} terminado.\nRESULTADO: APROBADO`, payload: JSON.stringify({ dispatchId: `ctx_${active}0001` }) }] };
    assert.fail(`Unexpected Orca command: ${args.join(' ')}`);
  };
  const dependencies = {
    command, verifyDestination: verify,
    captureSnapshot: async location => { assert.equal(location, workspace); assert.equal(state.dirty, true); state.snapshots.push('d'.repeat(64)); return 'd'.repeat(64); },
    integrate: async value => { state.integrations.push(value); assert.equal(value.integrationSnapshot, 'd'.repeat(64)); return { phase: 'complete' }; },
  };
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  const previous = completed.includes('qa') ? { jobId: job.id, receiptId: job.autoIntent.receiptId, phase: 'validation_pending', validation: {
    version: 1, jobId: job.id, receiptId: job.autoIntent.receiptId, attempt: 1, runId: 'run_abcdef', workspace, branch: job.branch,
    developerTaskId: 'task_developer0001', developerDispatchId: 'ctx_developer0001', developerArtifactSha256: null,
    cycleId: 'attempt-1', snapshot: 'd'.repeat(64), capturedAt: '2026-11-08T12:00:00Z',
  } } : null;
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1,
    receipts: dirtyAt === 'admission' ? [] : [{ id: job.autoIntent.receiptId, jobId: job.id, eligible: true }], history: [],
    integrations: previous ? { [job.autoIntent.receiptId]: previous } : {} }));
  return { root, workspace, job, ctx, state, git, inspect, verify, dependencies };
}

test('QA and reviewer inspect developer changes while the original GitHub guards remain active', async t => {
  const f = await fixture(t);
  const result = await runOrca(f.job, f.ctx, f.dependencies);
  assert.deepEqual(f.state.starts, ['ux', 'developer', 'qa', 'reviewer']);
  assert.deepEqual(f.state.checks, [
    { requireClean: true, dirty: false }, { requireClean: true, dirty: false }, { requireClean: true, dirty: false },
    { requireClean: false, dirty: true }, { requireClean: false, dirty: true },
  ]);
  assert.equal(f.state.commands.filter(args => args[0] === 'ls-remote').length, 10);
  assert.deepEqual(f.state.snapshots, ['d'.repeat(64), 'd'.repeat(64)]);
  assert.equal(f.state.integrations.length, 1);
  assert.equal(result.integration.phase, 'complete');
});

for (const completed of [['ux', 'developer'], ['ux', 'developer', 'qa']]) {
  test(`recovery after ${completed.at(-1)} preserves dirty changes and does not repeat completed stages`, async t => {
    const f = await fixture(t, { completed });
    await runOrca(f.job, f.ctx, f.dependencies);
    assert.deepEqual(f.state.starts, ['ux', 'developer', 'qa', 'reviewer'].filter(key => !completed.includes(key)));
    assert.ok(f.state.checks.every(check => check.requireClean === false && check.dirty));
    assert.equal(f.state.integrations.length, 1);
  });
}

for (const dirtyAt of ['admission', 'ux', 'developer']) {
  test(`${dirtyAt} still refuses a dirty checkout before starting that stage`, async t => {
    const f = await fixture(t, { dirtyAt });
    await assert.rejects(runOrca(f.job, f.ctx, f.dependencies), /no estaba limpio/);
    assert.deepEqual(f.state.starts, dirtyAt === 'developer' ? ['ux'] : []);
    assert.equal(f.state.integrations.length, 0);
    assert.equal(f.state.checks.at(-1).requireClean, true);
  });
}

test('an unfinished developer checkpoint cannot obtain the recovery exemption', async t => {
  const f = await fixture(t, { completed: ['ux', 'developer'] });
  f.job.workflow.steps[1].status = 'blocked';
  await assert.rejects(runOrca(f.job, f.ctx, f.dependencies), /no estaba limpio/);
  assert.deepEqual(f.state.starts, []);
});

test('the real provider consumes the completed developer dispatch on exact liveness recovery with a dirty checkout', async t => {
  const f = await fixture(t, { completed: ['ux', 'developer'] });
  const step = f.job.workflow.steps[1];
  Object.assign(step, { status: 'blocked', error: 'orca_liveness_unconfirmed', dispatchStatus: 'unknown', runId: 'run_abcdef', attempt: 1 });
  f.job.workflow.currentStage = 'developer';
  f.job.livenessResume = { mode: 'same_attempt_liveness', phase: 'consumed', jobId: f.job.id, receiptId: f.job.autoIntent.receiptId, attempt: 1,
    stage: 'developer', runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId, observedState: 'succeeded', liveness: 'exited',
    checkpointHash: createHash('sha256').update(JSON.stringify(step)).digest('hex') };
  const original = f.dependencies.command; let developerRead = false;
  f.dependencies.command = async args => {
    if (args[1] === 'worker-show' && args[3] === step.dispatchId) { developerRead = true; return { state: 'succeeded', liveness: 'exited', runId: step.runId, taskId: step.taskId, dispatchId: step.dispatchId }; }
    if (args[1] === 'inbox' && developerRead) { developerRead = false; return { messages: [{ type: 'worker_done', body: 'Developer completed.\nRESULTADO: APROBADO', payload: { dispatchId: step.dispatchId } }] }; }
    return original(args);
  };
  await runOrca(f.job, f.ctx, f.dependencies);
  assert.deepEqual(f.state.starts, ['qa', 'reviewer']);
  assert.ok(f.state.checks.every(check => !check.requireClean && check.dirty));
  assert.equal(f.state.integrations.length, 1);
  for (const patch of [{ phase: 'ready' }, { dispatchId: 'ctx_foreign01' }, { observedState: 'failed' }, { checkpointHash: 'changed' }]) {
    const saved = f.job.livenessResume; f.job.livenessResume = { ...saved, ...patch };
    await assert.rejects(runOrca(f.job, f.ctx, f.dependencies), /no estaba limpio/);
    f.job.livenessResume = saved;
  }
});

test('requireClean defaults to true and false preserves origin, branch, remote SHA, base and lock checks', async t => {
  const f = await fixture(t, { dirtyAt: 'admission' });
  await assert.rejects(f.verify(f.root, f.job), /no estaba limpio/);
  const verified = await f.verify(f.root, f.job, { requireClean: false });
  assert.equal(verified.remoteSha, sourceSha);
  assert.equal(verified.baseSha, baseSha);
  for (const [key, value, error] of [
    ['origin', 'https://github.com/other/repo', /Origin/], ['branch', 'other', /Rama cambiada/],
    ['remoteSha', 'c'.repeat(40), /SHA local\/remoto distinto/], ['missingBase', true, /Rama base ausente/],
  ]) {
    f.state[key] = value;
    await assert.rejects(f.verify(f.root, f.job, { requireClean: false }), error);
    delete f.state[key];
  }
  await fs.writeFile(path.join(f.workspace, '.git', 'index.lock'), '');
  await assert.rejects(f.verify(f.root, f.job, { requireClean: false }), /bloqueo/);
});

test('automatic admission keeps the default clean guard and never dispatches dirty work', async t => {
  const f = await fixture(t, { dirtyAt: 'admission' });
  await setAutoRun(f.root, 'agency', true, { confirm: true });
  await confirmSubmission(f.root, f.job.autoIntent.receiptId, f.job);
  const runner = createAutoRunner(f.root, { verify: f.verify, worker: async () => assert.fail('Dirty checkout must not dispatch') });
  await runner.tick();
  assert.deepEqual(f.state.checks, [{ requireClean: true, dirty: true }]);
  assert.equal((await readAutoRun(f.root)).receipts[0].status, 'blocked');
});

test('integration recovery reuses the manifest of its recorded commit without fingerprinting a clean checkout', async t => {
  const f = await fixture(t, { completed: ['ux', 'developer', 'qa', 'reviewer'] });
  const previous = { jobId: f.job.id, receiptId: f.job.autoIntent.receiptId, phase: 'commit_confirmed', commitSha: 'c'.repeat(40), manifest: 'd'.repeat(64) };
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, receipts: [], history: [], integrations: { [previous.receiptId]: previous } }));
  f.dependencies.captureSnapshot = async () => assert.fail('An already committed manifest must not be reconstructed');
  f.dependencies.integrate = async (job, _ctx, options) => {
    assert.equal(job.integrationSnapshot, previous.manifest);
    assert.deepEqual(options.previous, previous);
    return { phase: 'complete' };
  };
  // Cached QA/reviewer approvals still refer to their original dispatches.
  const review = f.job.workflow.steps.at(-1);
  review.approvalOutcome = 'approved'; review.approvalDispatchId = review.dispatchId;
  await runOrca(f.job, f.ctx, f.dependencies);
  assert.deepEqual(f.state.starts, []);
});

test('a recorded commit without its approved manifest blocks before integration or any new stage', async t => {
  const f = await fixture(t, { completed: ['ux', 'developer'] });
  await fs.mkdir(path.join(f.root, 'data'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, receipts: [], history: [], integrations: {
    [f.job.autoIntent.receiptId]: { jobId: f.job.id, receiptId: f.job.autoIntent.receiptId, phase: 'commit_confirmed', commitSha: 'c'.repeat(40) },
  } }));
  f.dependencies.captureSnapshot = async () => assert.fail('Missing manifest must not be replaced');
  f.dependencies.integrate = async () => assert.fail('Missing manifest must block');
  await assert.rejects(runOrca(f.job, f.ctx, f.dependencies), { code: 'github_manifest_missing' });
  assert.deepEqual(f.state.starts, []);
});
