import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { notifyCoordinatorRequest, verifyCoordinatorBinding } from '../coordinator-bridge.mjs';
const env = { ORCA_COORDINATOR_RUN_ID: 'run_12345678', ORCA_COORDINATOR_SENDER: 'terminal_owner123' };
const request = { id: 'coord-1234567890abcdef', createdAt: '2026-11-08T12:00:00Z', snapshot: { business: 'games', projectId: 'flecha', title: 'Probar idea', text: 'Una solicitud', successCriteria: 'Validar reglas', destinationConfirmation: { checkout: 'workspaces/fixture', branch: 'develop' } } };
const owner = { run: { id: env.ORCA_COORDINATOR_RUN_ID, coordinator_handle: env.ORCA_COORDINATOR_SENDER } };
async function fixture(t, config) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-bridge-'));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, 'data'));
  if (config) await fs.writeFile(path.join(cwd, 'data', 'coordinator-bindings.json'), JSON.stringify(config));
  return cwd;
}

test('verified explicit owner receives complete contract after durable send intent', async t => {
  const cwd = await fixture(t);
  const calls = []; let checkpoint = false;
  const result = await notifyCoordinatorRequest(request, { cwd, env, beforeSend: async target => { assert.equal(target.senderId, env.ORCA_COORDINATOR_SENDER); checkpoint = true; }, command: async args => {
    calls.push(args);
    if (args[1] === 'run-show') return owner;
    if (args[1] === 'inbox') return { messages: [] };
    assert.equal(checkpoint, true);
    assert.equal(args[args.indexOf('--from') + 1], env.ORCA_COORDINATOR_SENDER);
    const body = args[args.indexOf('--body') + 1];
    assert.match(body, /Validar reglas/); assert.match(body, /workspaces\/fixture/); assert.match(body, /PANEL_COORDINATOR_REQUEST/);
    assert.match(body, /productAcceptance es un array obligatorio/);
    assert.match(body, /no le pidas que escriba este campo técnico/);
    assert.match(body, /Conserva successCriteria íntegro/);
    assert.match(body, /no hay una opción para suprimirlas/);
    return { messageId: 'msg_12345678' };
  } });
  assert.equal(result.status, 'sent'); assert.equal(calls.length, 3);
});
test('missing identity never guesses a terminal from working directory', async t => {
  const cwd = await fixture(t);
  const result = await notifyCoordinatorRequest(request, { cwd, env: {}, command: async () => assert.fail('no CLI query without identity') });
  assert.equal(result.status, 'pending'); assert.equal(result.code, 'coordinator_identity_required');
});
test('a new project idea and its follow-up consultation carry distinct types and actions', async t => {
  const cwd = await fixture(t);
  const snapshot = { ...request.snapshot, projectId: null, destinationConfirmation: null };
  async function notice(input) {
    let body;
    const result = await notifyCoordinatorRequest(input, { cwd, env: { ...env, CENTRO_ORCA_AGENT: 'claude' }, beforeSend: async () => {}, command: async args => {
      if (args[1] === 'run-show') return owner;
      if (args[1] === 'inbox') return { messages: [] };
      assert.equal(args[1], 'send');
      body = args[args.indexOf('--body') + 1];
      return { messageId: 'msg_notice' };
    } });
    assert.equal(result.status, 'sent');
    return body;
  }
  const idea = await notice({ ...request, kind: 'idea', snapshot });
  assert.match(idea.split('\n')[1], /kind=idea.*coordinación de encargo/);
  assert.ok(idea.split('\n')[2].includes('/api/coordinator/requests/' + request.id));
  assert.match(idea, /COORDINATOR_PREPARATION\.md/);
  assert.match(idea, /--agent claude/);
  assert.doesNotMatch(idea, /Intención: task|\/response/);

  const followup = await notice({ ...request, id: 'coord-0987654321abcdef', kind: 'task', intent: 'consultation', snapshot });
  assert.match(followup.split('\n')[1], /kind=task.*intent=consultation/);
  assert.match(followup, /coord-0987654321abcdef\/response/);
  assert.doesNotMatch(followup, /COORDINATOR_PREPARATION\.md|Para aplicar la decisión/);
});
test('unowned Run or mismatched owner cannot send', async t => {
  const cwd = await fixture(t);
  for (const coordinator_handle of [null, 'terminal_other']) {
    const calls = [];
    const result = await notifyCoordinatorRequest(request, { cwd, env, command: async args => { calls.push(args); return { run: { id: env.ORCA_COORDINATOR_RUN_ID, coordinator_handle } }; } });
    assert.equal(result.status, 'pending'); assert.equal(calls.length, 1);
  }
});
test('existing marker reconciles ambiguous send without another message', async t => {
  const cwd = await fixture(t);
  const result = await notifyCoordinatorRequest({ ...request, notification: { status: 'sending', runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER } }, { cwd, env, command: async args => {
    if (args[1] === 'run-show') return owner;
    assert.equal(args[1], 'inbox'); return { messages: [{ id: 'msg_saved', body: `[PANEL_COORDINATOR_REQUEST:${request.id}]` }] };
  } });
  assert.equal(result.status, 'sent'); assert.equal(result.deduplicated, true);
});
test('missing ambiguous message and changed target never cause resend', async t => {
  const cwd = await fixture(t);
  const prior = { ...request, notification: { status: 'unknown', runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER } };
  const result = await notifyCoordinatorRequest(prior, { cwd, env, command: async args => { if (args[1] === 'run-show') return owner; assert.equal(args[1], 'inbox'); return { messages: [] }; } });
  assert.equal(result.status, 'unknown');
  const changed = await notifyCoordinatorRequest(prior, { cwd, env: { ...env, ORCA_COORDINATOR_RUN_ID: 'run_other123' }, command: async () => assert.fail('cannot retarget') });
  assert.equal(changed.code, 'coordinator_identity_changed');
});
test('transport errors expose only stable code and no raw output', async t => {
  const cwd = await fixture(t);
  const result = await notifyCoordinatorRequest(request, { cwd, env, command: async () => { throw Object.assign(new Error('secret stderr token'), { code: 'no_active_sender_terminal' }); } });
  assert.equal(result.code, 'no_active_sender_terminal'); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(result.requestId, request.id); assert.equal(result.stage, 'run-show'); assert.equal(result.uncertain, false);
});

const persistent = () => ({ schemaVersion: 1, coordinators: [
  { id: 'project-games', name: 'Flecha · Coordinador', business: 'games', runId: 'run_project123', senderId: 'term_project123', worktreeId: 'repo-fixture::C:/fixtures/game', sessionId: null },
  { id: 'default-games', name: 'Videojuegos · Coordinador', business: 'games', runId: 'run_default123', senderId: 'term_default123', worktreeId: 'repo-fixture::C:/fixtures/default', sessionId: null },
], projects: { flecha: 'project-games' }, businesses: { games: 'default-games' } });

function simulator(binding, { connected = true, messages = [] } = {}) {
  const calls = [];
  return { calls, command: async args => {
    calls.push(args);
    if (args[0] === 'orchestration' && args[1] === 'run-show') {
      assert.equal(args[args.indexOf('--id') + 1], binding.runId);
      return { run: { id: binding.runId, coordinator_handle: binding.senderId } };
    }
    if (args[0] === 'terminal' && args[1] === 'show') return { terminal: { handle: binding.senderId, worktreeId: binding.worktreeId, connected, writable: connected, orphaned: true } };
    if (args[1] === 'inbox') return { messages };
    assert.equal(args[1], 'send'); assert.equal(args[args.indexOf('--to') + 1], `run:${binding.runId}`);
    assert.equal(args[args.indexOf('--from') + 1], binding.senderId);
    return { messageId: 'msg_configured123' };
  } };
}

test('persistent project destination and route metadata are durable before send and retained in the receipt', async t => {
  const config = persistent(), cwd = await fixture(t, config), selected = config.coordinators[0];
  const fake = simulator(selected); let saved;
  const command = async args => {
    if (args[1] === 'send') assert.equal(saved?.coordinatorId, selected.id);
    return fake.command(args);
  };
  const result = await notifyCoordinatorRequest(request, { cwd, env, command, beforeSend: async target => {
    saved = target;
    const changed = persistent(); changed.projects.flecha = 'default-games';
    await fs.writeFile(path.join(cwd, 'data', 'coordinator-bindings.json'), JSON.stringify(changed));
  } });
  assert.equal(result.status, 'sent'); assert.equal(result.coordinatorId, selected.id);
  assert.equal(result.coordinatorName, selected.name); assert.equal(result.routeScope, 'project');
  assert.equal(result.runId, saved.runId); assert.equal(result.senderId, saved.senderId);
  assert.deepEqual(fake.calls.map(args => `${args[0]} ${args[1]}`), ['orchestration run-show', 'terminal show', 'orchestration inbox', 'orchestration send']);
  const replay = await notifyCoordinatorRequest({ ...request, notification: { ...result, status: 'unknown' } }, { cwd, env, command: async () => assert.fail('changed routing cannot query or send another destination') });
  assert.equal(replay.code, 'coordinator_identity_changed'); assert.equal(replay.runId, selected.runId); assert.equal(replay.coordinatorId, selected.id);
});

test('malformed configuration and cross-company binding never fall back to environment', async t => {
  const config = persistent(), cwd = await fixture(t, config);
  await fs.writeFile(path.join(cwd, 'data', 'coordinator-bindings.json'), '{invalid secret payload');
  const broken = await notifyCoordinatorRequest(request, { cwd, env, command: async () => assert.fail('invalid config cannot call Orca') });
  assert.equal(broken.code, 'coordinator_bindings_invalid'); assert.equal(broken.status, 'needs_attention');
  assert.ok(!JSON.stringify(broken).includes('secret payload'));
  config.coordinators[0].business = 'agency';
  await fs.writeFile(path.join(cwd, 'data', 'coordinator-bindings.json'), JSON.stringify(config));
  const mismatch = await notifyCoordinatorRequest(request, { cwd, env, command: async () => assert.fail('wrong company cannot call Orca') });
  assert.equal(mismatch.code, 'coordinator_binding_mismatch');
});

test('confirmed notification is not resent even when its message is outside the inbox page', async t => {
  const cwd = await fixture(t), notification = { status: 'sent', runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER, messageId: 'msg_confirmed' };
  const result = await notifyCoordinatorRequest({ ...request, notification }, { cwd, env, command: async () => assert.fail('a confirmed notice does not need another send') });
  assert.equal(result.status, 'sent'); assert.equal(result.messageId, notification.messageId); assert.equal(result.deduplicated, true);
});

test('explicit terminal liveness requires exact writable connection and ignores orphaned UI metadata', async t => {
  const cwd = await fixture(t), selected = persistent().coordinators[0];
  const connected = simulator(selected);
  assert.equal((await verifyCoordinatorBinding(selected, { cwd, command: connected.command })).liveness, 'connected');
  const closed = simulator(selected, { connected: false });
  const result = await notifyCoordinatorRequest(request, { cwd, env: { ORCA_COORDINATOR_RUN_ID: selected.runId, ORCA_COORDINATOR_SENDER: selected.senderId }, command: closed.command, beforeSend: async () => assert.fail('closed coordinator cannot reach send intent') });
  assert.equal(result.code, 'coordinator_disconnected'); assert.equal(result.status, 'pending');
  assert.equal(closed.calls.length, 2);
  const wrong = await verifyCoordinatorBinding(selected, { cwd, command: async args => args[0] === 'terminal'
    ? { terminal: { handle: 'term_other123', connected: true, writable: true } }
    : { run: { id: selected.runId, coordinator_handle: selected.senderId } } });
  assert.equal(wrong.ok, false); assert.equal(wrong.liveness, 'unverified');
  const legacy = await verifyCoordinatorBinding({ runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER }, { cwd, command: async args => { assert.equal(args[0], 'orchestration'); return owner; } });
  assert.equal(legacy.ok, true); assert.equal(legacy.liveness, 'unverified');
});

test('a durable send-intent failure cannot send and a recovered intent never resends blindly', async t => {
  const cwd = await fixture(t), fake = simulator({ runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER });
  await assert.rejects(notifyCoordinatorRequest(request, { cwd, env, command: fake.command, beforeSend: async () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
  assert.equal(fake.calls.some(args => args[1] === 'send'), false);
  const replay = await notifyCoordinatorRequest({ ...request, sendIntent: { runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER } }, { cwd, env, command: fake.command });
  assert.equal(replay.status, 'unknown'); assert.equal(fake.calls.some(args => args[1] === 'send'), false);
});

test('a closed coordinator can still reconcile an ambiguous delivery in its original inbox without sending', async t => {
  const config = persistent(), cwd = await fixture(t, config), selected = config.coordinators[0];
  const fake = simulator(selected, { connected: false, messages: [{ id: 'msg_original', body: `[PANEL_COORDINATOR_REQUEST:${request.id}]` }] });
  const result = await notifyCoordinatorRequest({ ...request, notification: { status: 'unknown', runId: selected.runId, senderId: selected.senderId } },
    { cwd, env, command: fake.command, beforeSend: async () => assert.fail('never send to a closed coordinator') });
  assert.equal(result.status, 'sent'); assert.equal(result.messageId, 'msg_original');
  assert.equal(fake.calls.some(args => args[1] === 'send'), false);
});

test('answer notice uses original request URLs and current decisions while retaining its own delivery marker', async t => {
  const cwd = await fixture(t), fake = simulator({ runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER });
  const answer = { ...request, id: `${request.id}-answers-round-1`, kind: 'answers', parentRequestId: request.id,
    snapshot: { ...request.snapshot, decisions: [{ questionId: 'scope', question: 'Alcance?', answer: 'Una demo vertical.' }] },
    notification: { status: 'pending', runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER } };
  await notifyCoordinatorRequest(answer, { cwd, env, command: fake.command });
  const send = fake.calls.find(args => args[1] === 'send'), body = send[send.indexOf('--body') + 1];
  assert.ok(body.includes(`[PANEL_COORDINATOR_REQUEST:${answer.id}]`));
  assert.match(body, /Decisiones del usuario/); assert.match(body, /Una demo vertical/);
  assert.ok(body.includes(`/api/coordinator/requests/${request.id}/questions`));
  assert.ok(!body.includes(`/api/coordinator/requests/${answer.id}`));
});

test('worker decisions point only to the original ask and never authorize routing or another job', async t => {
  const cwd = await fixture(t), fake = simulator({ runId: env.ORCA_COORDINATOR_RUN_ID, senderId: env.ORCA_COORDINATOR_SENDER });
  const origin = { jobId: 'job_fixture', runId: env.ORCA_COORDINATOR_RUN_ID, taskId: 'task_fixture123', dispatchId: 'ctx_fixture123', messageId: 'msg_question123' };
  const answer = { ...request, kind: 'worker-decisions', snapshot: { ...request.snapshot, origin, decisions: [{ questionId: 'target', answer: 'Solo el checkout confirmado.' }] } };
  await notifyCoordinatorRequest(answer, { cwd, env, command: fake.command });
  const send = fake.calls.find(args => args[1] === 'send'), body = send[send.indexOf('--body') + 1];
  assert.match(body, /orchestration reply --id msg_question123 --from TU_IDENTIDAD/);
  assert.ok(body.includes(JSON.stringify(origin))); assert.match(body, /Solo el checkout confirmado/);
  assert.ok(!body.includes('/api/coordinator/requests/')); assert.match(body, /Si el trabajador terminó/);
});
