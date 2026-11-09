import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { inspectRecoveryDispatch } from '../dispatch-recovery.mjs';

const root = path.resolve('fixture-root');
const workspace = path.join(root, 'workspaces', 'fixture');
const binding = { runId: 'run_recovery123', senderId: 'term_coordinator123', business: 'agency' };
const expected = { jobId: 'fixture-job', stage: 'ux', runId: binding.runId, taskId: 'task_recovery123', dispatchId: 'ctx_recovery123' };
const job = { id: expected.jobId, workspace, coordination: binding,
  workflow: { runId: binding.runId, currentStage: 'ux', steps: [{ key: 'ux', taskId: expected.taskId, dispatchId: expected.dispatchId }] } };
function full() {
  const worktreeId = `repo-fixture::${workspace}`;
  return {
    dispatch: { id: expected.dispatchId, taskId: expected.taskId, runId: expected.runId, assigneeHandle: 'term_worker123', status: 'completed' },
    worker: { dispatchId: expected.dispatchId, state: 'succeeded', agentTerminalHandle: 'term_worker123', worktreeId },
    projection: { id: expected.dispatchId, dispatchId: expected.dispatchId, taskId: expected.taskId, runId: expected.runId,
      outcome: 'succeeded', stage: { worker: 'succeeded' }, workspace: { id: worktreeId }, liveness: { verdict: 'unverifiable' } },
    observation: { status: 'exited', exactWorker: true },
    terminal: { handle: 'term_worker123', worktreeId, worktreePath: workspace, connected: false, writable: false },
  };
}
function native(shown, owner = binding.senderId) {
  return async args => {
    if (args[1] === 'run-show') return { run: { id: binding.runId, coordinator_handle: owner } };
    if (args[0] === 'terminal') return { terminal: { handle: binding.senderId, connected: true, writable: true } };
    assert.equal(args[1], 'worker-show'); assert.ok(args.includes('--full'));
    assert.equal(args[args.indexOf('--dispatch') + 1], expected.dispatchId);
    return shown;
  };
}

test('recovery observes the original owner, worker and checkout with positive native closure', async () => {
  const observed = await inspectRecoveryDispatch(root, job, expected, { command: native(full()) });
  assert.equal(observed.liveness, 'exited'); assert.equal(observed.state, 'succeeded');
  assert.equal(observed.dispatchId, expected.dispatchId);
});
test('another owner, task or checkout cannot become recovery evidence', async () => {
  await assert.rejects(inspectRecoveryDispatch(root, job, expected, { command: native(full(), 'term_other123') }));
  await assert.rejects(inspectRecoveryDispatch(root, job, { ...expected, taskId: 'task_other123' }, { command: async () => assert.fail('no native call for a different saved task') }));
  const changed = full(); changed.terminal.worktreePath = path.join(root, 'workspaces', 'other');
  await assert.rejects(inspectRecoveryDispatch(root, job, expected, { command: native(changed) }), /checkout exacto/);
});
test('missing exit evidence remains unverifiable and is never promoted to physical closure', async () => {
  const shown = full(); shown.observation = { status: 'unknown', exactWorker: true };
  const observed = await inspectRecoveryDispatch(root, job, expected, { command: native(shown) });
  assert.equal(observed.liveness, 'unverifiable');
});
