import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runOrca } from '../orca-provider.mjs';
import { normalizeWorkerStatus, checkWorkerIdentity, saveDispatchSpec, verifyDispatchSpec } from '../orca-evidence.mjs';

const identity = { dispatchId: 'ctx_native001', taskId: 'task_native001', runId: 'run_native001' };
const terminal = 'term_native001';
function nativeStatus({ state = 'succeeded', exited = true, exact = true } = {}) {
  return {
    dispatch: { id: identity.dispatchId, taskId: identity.taskId, task_id: identity.taskId, runId: identity.runId, assigneeHandle: terminal, status: exited ? 'completed' : 'pending' },
    worker: { dispatchId: identity.dispatchId, state, stage: exited ? 'settled' : 'dispatch_input', agentTerminalHandle: terminal, worktreeId: 'workspace-native' },
    projection: { id: identity.dispatchId, ...identity, stage: { worker: state, dispatch: exited ? 'completed' : 'pending' },
      outcome: exited ? state : 'in_progress', liveness: { verdict: exited ? 'unverifiable' : 'live', reason: exited ? 'missing_status' : 'exact_worker' }, workspace: { id: 'workspace-native' } },
    terminal: { handle: terminal, worktreeId: 'workspace-native', worktreePath: 'C:/isolated/native', connected: !exited, writable: !exited, orphaned: true },
    observation: { status: exited ? 'exited' : 'live', exactWorker: exact }, terminalResource: null, autoReleaseAt: null,
  };
}

test('Orca reports a stopped process as a failed dispatch with exact exit', () => {
  const shown = nativeStatus({ state: 'stopped' });
  shown.dispatch.status = shown.projection.stage.dispatch = shown.projection.outcome = 'failed';
  assert.equal(normalizeWorkerStatus(shown).state, 'stopped');
  assert.equal(normalizeWorkerStatus(shown).liveness, 'exited');
  assert.equal(normalizeWorkerStatus({ ...shown, observation: { status: 'exited', exactWorker: false } }).liveness, 'unverifiable');
});

test('full native exact exit evidence survives an unverifiable concise projection', () => {
  const result = normalizeWorkerStatus(nativeStatus());
  checkWorkerIdentity(result, identity, { strict: true });
  assert.equal(result.liveness, 'exited');
  assert.equal(result.exitEvidence, 'native_exact_observation');
  assert.equal(result.terminal, terminal);
  assert.equal(result.workspace, 'C:/isolated/native');
  assert.equal(normalizeWorkerStatus({ ...identity, state: 'succeeded', liveness: 'exited' }).liveness, 'exited');
  const working = normalizeWorkerStatus(nativeStatus({ state: 'start_unknown', exited: false }));
  assert.equal(working.state, 'start_unknown');
  assert.equal(working.liveness, 'live');
});

test('unverifiable, absent resources and closed-looking terminals alone never prove exit', () => {
  for (const change of [value => { delete value.observation; }, value => { value.observation.exactWorker = false; },
    value => { delete value.terminal; }, value => { value.terminal.connected = true; }, value => { value.terminal.writable = true; }]) {
    const value = nativeStatus(); change(value);
    assert.equal(normalizeWorkerStatus(value).liveness, 'unverifiable');
  }
  assert.equal(normalizeWorkerStatus(nativeStatus({ state: 'start_unknown', exited: false, exact: false })).liveness, 'unverifiable');
});

// 23 (D2): Orca 1.4.253 runs Claude as a structured chat worker when agents open as Chat.
// worker-show then returns terminal: null; the exact observation plus the released resource prove the exit.
function structuredStatus({ exited = true, exact = true, verdict, released = true, owner = identity.dispatchId } = {}) {
  const handle = 'structworker_native001', worktreeId = 'c372c5e2::/home/user/dev/centro/workspaces/sandbox';
  return {
    dispatch: { id: identity.dispatchId, taskId: identity.taskId, task_id: identity.taskId, runId: identity.runId, assigneeHandle: handle, status: exited ? 'completed' : 'dispatched' },
    worker: { dispatchId: identity.dispatchId, state: exited ? 'succeeded' : 'running', stage: exited ? 'settled' : 'dispatch_input', agentTerminalHandle: handle, worktreeId },
    projection: { id: identity.dispatchId, ...identity, stage: { worker: exited ? 'succeeded' : 'running', dispatch: exited ? 'completed' : 'dispatched' },
      outcome: exited ? 'succeeded' : 'in_progress', liveness: { verdict: verdict ?? (exited ? 'exited' : 'live'), source: 'resource_release' }, workspace: { id: worktreeId } },
    terminal: null,
    observation: { status: exited ? 'exited' : 'live', exactWorker: exact, addressable: false },
    terminalResource: { id: 'wtr_native001', ownershipState: released ? 'released' : 'owned', releaseState: released ? 'released' : 'not_requested',
      terminalHandle: handle, worktreeId, originDispatchId: owner, ownerDispatchId: owner },
    autoReleaseAt: null,
  };
}

test('a structured worker without terminal proves its exit through the exact observation and the released resource', () => {
  const result = normalizeWorkerStatus(structuredStatus());
  checkWorkerIdentity(result, identity, { strict: true });
  assert.equal(result.state, 'succeeded');
  assert.equal(result.liveness, 'exited');
  assert.equal(result.exitEvidence, 'native_exact_observation');
  assert.equal(result.surface, 'structured');
  assert.equal(result.terminal, 'structworker_native001');
  assert.equal(result.workspace, '/home/user/dev/centro/workspaces/sandbox');
  // Terminal workers keep their terminal-based proof and path.
  assert.equal(normalizeWorkerStatus(nativeStatus()).surface, undefined);
  assert.equal(normalizeWorkerStatus(nativeStatus()).workspace, 'C:/isolated/native');
});

test('a structured worker that is live, not exactly observed, unreleased or owned by another dispatch never proves exit', () => {
  const live = normalizeWorkerStatus(structuredStatus({ exited: false }));
  assert.equal(live.liveness, 'live'); assert.equal(live.exitEvidence, null); assert.equal(live.workspace, undefined);
  for (const [label, value] of [
    ['inexact observation', structuredStatus({ exact: false })],
    ['projection still unverifiable', structuredStatus({ verdict: 'unverifiable' })],
    ['resource not released', structuredStatus({ released: false })],
    ['resource of another dispatch', structuredStatus({ owner: 'ctx_other0001' })],
    ['resource missing', { ...structuredStatus(), terminalResource: null }],
    ['resource handle of another worker', { ...structuredStatus(), terminalResource: { ...structuredStatus().terminalResource, terminalHandle: 'structworker_other' } }],
  ]) {
    const result = normalizeWorkerStatus(value);
    assert.equal(result.liveness, 'unverifiable', label); assert.equal(result.exitEvidence, null, label); assert.equal(result.surface, undefined, label);
  }
  // A live projection verdict with an exited observation is not accepted as exit either.
  const contradictory = normalizeWorkerStatus(structuredStatus({ verdict: 'live' }));
  assert.notEqual(contradictory.liveness, 'exited'); assert.equal(contradictory.exitEvidence, null);
});

test('full native conflicting IDs, states, terminal or workspace are rejected', () => {
  for (const [section, key, value] of [
    ['dispatch', 'runId', 'run_foreign001'], ['dispatch', 'task_id', 'task_foreign001'], ['worker', 'dispatchId', 'ctx_foreign001'],
    ['projection', 'outcome', 'failed'], ['projection', 'outcome', 'in_progress'], ['dispatch', 'status', 'pending'],
    ['terminal', 'handle', 'term_foreign001'], ['terminal', 'worktreeId', 'workspace-other'],
  ]) {
    const record = nativeStatus(); record[section][key] = value;
    assert.throws(() => normalizeWorkerStatus(record), { code: 'orca_identity_mismatch' });
  }
  const conflicting = nativeStatus(); conflicting.projection.liveness.verdict = 'live';
  assert.throws(() => normalizeWorkerStatus(conflicting), { code: 'orca_liveness_conflict' });
  assert.throws(() => checkWorkerIdentity(normalizeWorkerStatus({ state: 'succeeded' }), identity, { strict: true }), { code: 'orca_identity_mismatch' });
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-transport-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = { id: 'transport-fixture', business: 'agency', kind: 'analysis', title: 'Encargo completo', prompt: 'DETALLE '.repeat(2200) + 'FINAL OBLIGATORIO', attempts: 1,
    contract: { version: 1, objective: 'Planificar.', acceptance: [] } };
  const updates = [], calls = [];
  const ctx = { root, signal: new AbortController().signal, registerCleanup() {}, reportStage: async update => updates.push(update) };
  const result = { version: 1, ...identity, jobId: job.id, jobAttempt: 1, stage: 'planner', outcome: 'completed', scope: 'complete', summary: 'Plan comprobado.',
    approval: 'not_applicable', acceptance: [], evidence: ['Archivo completo verificado.'], decisions: [], questions: [] };
  let shown = 0;
  const command = async args => {
    calls.push(args);
    if (args[0] === 'repo') return { repos: [{ path: path.join(root, 'analysis') }] };
    if (args[1] === 'run-create') return { runId: identity.runId };
    if (args[1] === 'worker-start') return identity;
    if (args[1] === 'worker-show') { assert.ok(args.includes('--full')); shown++; return nativeStatus(); }
    if (args[1] === 'inbox') return { messages: [{ id: 'msg_native001', type: 'worker_done', run_id: identity.runId, to_handle: 'run:' + identity.runId,
      payload: { ...identity, outcome: 'succeeded' }, body: JSON.stringify(result) }] };
    assert.fail(`Unexpected command ${args.join(' ')}`);
  };
  return { root, job, ctx, updates, calls, command, result, shown: () => shown };
}

test('a short native spec references the full immutable contract by path and byte hash', async t => {
  const f = await fixture(t);
  await runOrca(f.job, f.ctx, { command: f.command });
  const start = f.calls.find(args => args[1] === 'worker-start');
  assert.equal(start.includes('--spec-file'), false);
  const brief = start[start.indexOf('--spec') + 1];
  assert.ok(brief.length < 2000);
  const file = JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]);
  const content = await fs.readFile(file);
  const hash = createHash('sha256').update(content).digest('hex');
  assert.match(brief, new RegExp('SPEC_SHA256: ' + hash));
  assert.match(content.toString(), /FINAL OBLIGATORIO/);
  assert.match(content.toString(), /CONTRATO DE ENTREGA v1/);
  const checkpoint = f.updates.find(update => update.specArtifact);
  assert.deepEqual(checkpoint.specArtifact, { path: file, sha256: hash, chars: content.toString().length, bytes: content.length });
  assert.equal(checkpoint.launchInputChars, brief.length);
  assert.equal(checkpoint.taskInputAttempt, 1);
  assert.equal((await verifyDispatchSpec(f.root, checkpoint.specArtifact)).sha256, hash);
  await assert.rejects(saveDispatchSpec(f.root, { jobId: f.job.id, stage: 'planner', jobAttempt: 1 }, 'sustitución'), { code: 'dispatch_spec_mismatch' });
  await fs.appendFile(file, '\nmodificado');
  await assert.rejects(verifyDispatchSpec(f.root, checkpoint.specArtifact), { code: 'dispatch_spec_mismatch' });
});

test('an oversized inbox is read in smaller pages without redispatching the worker', async t => {
  const f = await fixture(t);
  const sizes = [];
  const command = async args => {
    if (args[1] === 'inbox') {
      const size = Number(args[args.indexOf('--limit') + 1]);
      sizes.push(size);
      if (size > 5) throw Object.assign(new Error('Oversized page'), { code: 'orca_response_too_large' });
    }
    return f.command(args);
  };
  const output = await runOrca(f.job, f.ctx, { command });
  assert.deepEqual(sizes, [20, 5]);
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1);
  assert.equal(output.delivery.summary, f.result.summary);
});

test('a contradictory status sample retries the same dispatch and accepts only the exact result', async t => {
  const f = await fixture(t);
  let polls = 0, waits = 0;
  const command = async args => {
    if (args[1] === 'worker-show' && ++polls === 1) {
      const contradictory = nativeStatus();
      contradictory.worker.taskId = 'task_wrong01';
      return contradictory;
    }
    return f.command(args);
  };
  const output = await runOrca(f.job, f.ctx, { command, polling: { wait: async () => { waits++; } } });
  assert.equal(waits, 1);
  assert.equal(output.dispatchId, identity.dispatchId);
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1);
  assert.equal(f.updates.some(update => update.statusReadError === 'orca_identity_mismatch'), true);
});

test('a live start_unknown waits on the same dispatch until exact completion without wake or duplicate start', async t => {
  const f = await fixture(t);
  let polls = 0, waits = 0;
  const command = async args => {
    if (args[1] === 'worker-show' && ++polls < 3) { f.calls.push(args); return nativeStatus({ state: 'start_unknown', exited: false }); }
    if (args[1] === 'inbox' && polls < 3) { f.calls.push(args); return { messages: [] }; }
    return f.command(args);
  };
  const output = await runOrca(f.job, f.ctx, { command, polling: { wait: async () => { waits++; } } });
  assert.equal(output.dispatchId, identity.dispatchId);
  assert.equal(waits, 2);
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1);
  assert.equal(f.calls.some(args => ['send', 'worker-stop'].includes(args[1])), false);
  assert.equal(f.updates.filter(update => update.dispatchStatus === 'start_unknown').length, 1);
});

test('live unknown start remains bounded and never becomes successful by elapsed time', async t => {
  const f = await fixture(t);
  let clock = 0;
  const command = async args => {
    if (args[1] === 'worker-show') { f.calls.push(args); return nativeStatus({ state: 'start_unknown', exited: false }); }
    if (args[1] === 'inbox') return { messages: [] };
    return f.command(args);
  };
  await assert.rejects(runOrca(f.job, f.ctx, { command, polling: { now: () => clock++, startUnknownTimeoutMs: 3, wait: async () => {} } }), { code: 'orca_start_unknown_timeout' });
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1);
  assert.equal(f.updates.some(update => update.status === 'succeeded'), false);
  assert.equal(f.calls.some(args => ['send', 'worker-stop'].includes(args[1])), false);
});

test('native success without positive exit stays blocked and does not read completion as approval', async t => {
  const f = await fixture(t);
  const command = async args => {
    if (args[1] === 'worker-show') { const value = nativeStatus(); delete value.observation; return value; }
    return f.command(args);
  };
  let clock = 0;
  await assert.rejects(runOrca(f.job, f.ctx, { command, polling: { now: () => clock++, exitTimeoutMs: 3, wait: async () => {} } }), { code: 'orca_liveness_unconfirmed' });
  assert.equal(f.calls.some(args => args[1] === 'inbox'), false);
});

test('completed work waits for delayed native release then consumes the same delivery once', async t => {
  const f = await fixture(t);
  let polls = 0, waits = 0;
  const command = async args => {
    if (args[1] === 'worker-show' && ++polls < 4) {
      f.calls.push(args);
      const value = nativeStatus();
      value.observation = { status: 'live', exactWorker: true };
      value.projection.liveness = { verdict: 'live' };
      value.terminal.connected = true; value.terminal.writable = true;
      return value;
    }
    return f.command(args);
  };
  const output = await runOrca(f.job, f.ctx, { command, polling: { wait: async () => { waits++; } } });
  assert.equal(output.dispatchId, identity.dispatchId);
  assert.equal(waits, 3);
  assert.equal(f.calls.filter(args => args[1] === 'worker-start').length, 1);
  assert.equal(f.calls.filter(args => args[1] === 'inbox').length, 1);
  assert.equal(f.updates.filter(update => update.dispatchStatus === 'awaiting_exit').length, 1);
  assert.equal(f.calls.some(args => ['send', 'worker-stop'].includes(args[1])), false);
});
