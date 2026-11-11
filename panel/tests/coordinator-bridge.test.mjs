import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nudgeCoordinator, nudgeText, notifyCoordinatorRequest, verifyCoordinatorBinding } from '../coordinator-bridge.mjs';
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
  assert.deepEqual(fake.calls.map(args => `${args[0]} ${args[1]}`), ['orchestration run-show', 'terminal show', 'orchestration inbox', 'orchestration send', 'terminal wait']);
  assert.equal(result.nudge.status, 'busy', 'a terminal that does not report idle is never typed into');
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

test('after a confirmed send the coordinator terminal gets one fixed line, only when idle and with no dialog on screen', async () => {
  const binding = { runId: 'run_abcdef123456', senderId: 'term_11111111-2222-3333-4444-555555555555' };
  const item = { id: 'coord-0123456789abcdef', snapshot: { title: 'x\nrm -rf; título con "comillas"' } };
  const orca = screen => { const calls = []; return { calls, command: async args => { calls.push(args);
    if (args[1] === 'wait') { if (screen === 'busy') throw Object.assign(new Error('timeout'), { code: 'orca_command_timeout' }); return { idle: true }; }
    if (args[1] === 'read') return { screen }; if (args[1] === 'send') return { ok: true }; assert.fail(args.join(' ')); } }; };
  const idle = orca('❯ \n  ⏵⏵ auto mode on');
  const delivered = await nudgeCoordinator(binding, item, { command: idle.command, env: { CENTRO_OPERATIONS_PORT: '4187' } });
  assert.deepEqual([delivered.status, delivered.attempts, delivered.tries], ['delivered', 1, 1]);
  const sent = idle.calls.at(-1);
  assert.deepEqual(sent.slice(0, 4), ['terminal', 'send', '--terminal', binding.senderId]); assert.equal(sent.at(-1), '--enter');
  const text = sent[sent.indexOf('--text') + 1];
  assert.match(text, /coord-0123456789abcdef/); assert.doesNotMatch(text, /[\r\n]|rm -rf|comillas/, 'user text never reaches the terminal');
  assert.equal(text, nudgeText(item, { CENTRO_OPERATIONS_PORT: '4187' }));
  // An approval dialog is on screen: a person has to answer it. Nothing is typed.
  const dialog = orca('Allow this read outside the working directories?\n❯ 1. Yes, and keep allowing\n  Esc to cancel');
  const blocked = await nudgeCoordinator(binding, item, { command: dialog.command, previous: delivered });
  assert.deepEqual([blocked.status, blocked.attempts, blocked.tries], ['needs_person', 1, 2]);
  assert.equal(dialog.calls.some(args => args[1] === 'send'), false);
  const busy = orca('busy');
  assert.equal((await nudgeCoordinator(binding, item, { command: busy.command })).status, 'busy'); assert.equal(busy.calls.length, 1);
  assert.equal((await nudgeCoordinator(binding, item, { command: () => assert.fail('disabled'), env: { CENTRO_COORDINATOR_NUDGE: '0' } })).status, 'disabled');
  assert.equal((await nudgeCoordinator({ ...binding, senderId: 'session:abcdef' }, item, { command: () => assert.fail('not a terminal') })).status, 'unsupported');
  assert.equal((await nudgeCoordinator(binding, { id: 'x; rm' }, { command: () => assert.fail('invalid id') })).status, 'unsupported');
});

test('an unanswered delivered notice is reminded a bounded number of times and never once it has a route', async t => {
  const { changeDashboardState, loadDashboardState } = await import('../agency-assistant/dashboard-state.mjs');
  const { remindCoordinator } = await import('../agency-assistant/coordinator-notice.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remind-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'coord-0123456789abcdef';
  await changeDashboardState(root, state => { state.coordinatorRequests.push({ id, kind: 'task', status: 'pending', snapshot: { title: 't', business: 'agency' },
    notification: { status: 'sent', runId: 'run_abcdef123456', senderId: 'term_11111111-2222-3333-4444-555555555555', nudge: { status: 'busy', attempts: 0, tries: 1, at: new Date(0).toISOString() } } }); });
  let clock = 1_000_000, typed = 0;
  const nudge = async (binding, request, { previous }) => { typed++; return { status: 'delivered', attempts: (previous?.attempts ?? 0) + 1, tries: (previous?.tries ?? 0) + 1, at: new Date(clock).toISOString() }; };
  assert.equal((await remindCoordinator(root, id, { nudge, now: () => clock })).attempts, 1);
  assert.equal(await remindCoordinator(root, id, { nudge, now: () => clock + 60_000 }), null, 'not again within two minutes of a delivered line');
  clock += 130_000; assert.equal((await remindCoordinator(root, id, { nudge, now: () => clock })).attempts, 2);
  clock += 130_000; assert.equal((await remindCoordinator(root, id, { nudge, now: () => clock })).attempts, 3);
  clock += 130_000; assert.equal(await remindCoordinator(root, id, { nudge, now: () => clock }), null, 'three lines at most');
  assert.equal(typed, 3); assert.equal((await loadDashboardState(root)).coordinatorRequests[0].notification.nudge.attempts, 3);
  await changeDashboardState(root, state => { state.coordinatorRequests[0].status = 'routed'; state.coordinatorRequests[0].notification.nudge = undefined; });
  assert.equal(await remindCoordinator(root, id, { nudge, now: () => clock + 999_999 }), null); assert.equal(typed, 3);
});

test('destination preparation is launched at the lightest level, on Codex when the profile is mixed, and follows the quota policy', async t => {
  const { preparationLaunch } = await import('../coordinator-bridge.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prep-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  assert.deepEqual(await preparationLaunch(root, { CENTRO_ORCA_AGENT: 'claude' }), { agent: 'claude', model: null, effort: null }, 'single agent: its own lightest level');
  assert.deepEqual(await preparationLaunch(root, {}), { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  await fs.writeFile(path.join(root, 'data', 'pipeline.json'), JSON.stringify({ version: 1, general: { roles: { desarrollador: { agent: 'claude', model: 'sonnet' }, qa: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } } } }));
  assert.deepEqual(await preparationLaunch(root, { CENTRO_ORCA_AGENT: 'claude' }), { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' }, 'mixed profile: Codex ligero');
  const now = new Date().toISOString(), later = new Date(Date.now() + 86_400_000).toISOString();
  await fs.writeFile(path.join(root, 'data', 'quota.json'), JSON.stringify({ version: 1, alAgotar: 'sustituir', sustituciones: { codex: 'claude' },
    proveedores: { codex: { autenticacion: 'suscripcion', usadoPorcentaje: 93, observadoEn: now, reiniciaEn: later }, claude: { autenticacion: 'suscripcion', usadoPorcentaje: 40, observadoEn: now } } }));
  const moved = await preparationLaunch(root, { CENTRO_ORCA_AGENT: 'claude' });
  assert.deepEqual([moved.agent, moved.model, moved.substitutedFrom.agent], ['claude', null, 'codex']);
});

test('a panel request is confirmed before the reminder line is written, and the line follows on its own', async t => {
  const { changeDashboardState, loadDashboardState } = await import('../agency-assistant/dashboard-state.mjs');
  const { deliverCoordinatorNotice } = await import('../agency-assistant/coordinator-notice.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notice-later-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'coord-0123456789abcdef';
  await changeDashboardState(root, state => { state.coordinatorRequests.push({ id, kind: 'task', status: 'pending', snapshot: { title: 't', business: 'agency' }, notification: { status: 'pending' } }); });
  let modes = [], release, reminded = false;
  const gate = new Promise(resolve => { release = resolve; });
  const notify = async (request, options) => { modes.push(options.nudge); return { status: 'sent', code: 'coordinator_message_sent', runId: 'run_abcdef123456', senderId: 'term_11111111-2222-3333-4444-555555555555', messageId: 'msg_1' }; };
  const remind = async () => { await gate; reminded = true; };
  const delivered = await deliverCoordinatorNotice(root, id, notify, { remind });
  assert.deepEqual(modes, ['later']); assert.equal(delivered.notification.status, 'sent'); assert.equal(reminded, false, 'the answer does not wait for the terminal');
  release(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(reminded, true);
  assert.equal((await loadDashboardState(root)).coordinatorRequests[0].notification.status, 'sent');
});
