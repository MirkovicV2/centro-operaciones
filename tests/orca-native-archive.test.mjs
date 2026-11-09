import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readVerifiedArchivedFinal } from '../orca-native-archive.mjs';

const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const identity = { jobId: 'archive-test', jobAttempt: 2, stage: 'qa', runId: 'run_archive01', taskId: 'task_archive01', dispatchId: 'ctx_archive01', acceptance: ['Añadir tareas con botón.'] };
const sessionId = '01a1bca8-873d-7601-879f-0b47d8f5a1a9';
const messageId = 'msg_archive_final';
const databaseFixture = String.raw`
import sqlite3,json,sys
x=json.load(open(sys.argv[2],encoding='utf8'))
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE worker_terminal_archives (dispatch_id TEXT PRIMARY KEY,resource_id TEXT,kind TEXT,created_at TEXT,content TEXT)')
c.execute('CREATE TABLE worker_terminal_resources (id TEXT PRIMARY KEY,origin_dispatch_id TEXT,owner_dispatch_id TEXT,terminal_handle TEXT,worktree_id TEXT,process_incarnation TEXT,endpoint_incarnation TEXT,release_state TEXT,ownership_state TEXT,archive_source TEXT,archive_status TEXT,resume_session TEXT)')
a=x['archive'];c.execute('INSERT INTO worker_terminal_archives VALUES (?,?,?,?,?)',(a['dispatch_id'],a['resource_id'],a['kind'],a['created_at'],json.dumps(x['snapshot'],ensure_ascii=False,separators=(',',':'))))
r=x['stored'];keys=list(r);c.execute('INSERT INTO worker_terminal_resources ('+','.join(keys)+') VALUES ('+','.join('?' for _ in keys)+')',[json.dumps(r[k],ensure_ascii=False) if k=='resume_session' else r[k] for k in keys])
c.commit();c.close()
`;

async function fixture(t, mutate = () => {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-archive-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionRoot = path.join(root, 'sessions');
  await fs.mkdir(sessionRoot);
  const transcriptPath = path.join(sessionRoot, 'rollout-' + sessionId + '.jsonl');
  const worktreePath = path.join(root, 'checkout');
  const resourceId = 'wtr_archive01', terminal = 'term_archive01', incarnation = 'checkout@@process:incarnation', worktree = 'workspace::' + worktreePath;
  const delivery = { version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: 'Comprobación de botón y acentos correcta.', approval: 'approved',
    acceptance: identity.acceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Comprobación local correcta.' })),
    evidence: ['Comprobación sin red.'], questions: [], decisions: [] };
  const text = '```centro-delivery\n' + JSON.stringify(delivery, null, 2) + '\n```\n\nRESULTADO: APROBADO';
  const prefix = text.slice(0, 220) + '\n… (truncated)';
  const finalMessage = { id: messageId, role: 'assistant', blocks: [{ type: 'text', text: prefix }], source: 'transcript', timestamp: 1234 };
  const archive = { dispatch_id: identity.dispatchId, resource_id: resourceId, kind: 'transcript_pin', created_at: '2026-11-08 19:41:03' };
  const snapshot = { version: 2, agent: 'codex', processIncarnation: incarnation, limited: true, clipping: ['transcript_payload'], warnings: ['Oversized transcript text was clipped.'], messages: [finalMessage] };
  const sourceIdentity = createHash('sha256').update(JSON.stringify(['released-transcript-snapshot', resourceId, incarnation, archive.created_at])).digest('base64url').slice(0, 32);
  const stored = { id: resourceId, origin_dispatch_id: identity.dispatchId, owner_dispatch_id: identity.dispatchId, terminal_handle: terminal, worktree_id: worktree,
    process_incarnation: incarnation, endpoint_incarnation: incarnation, release_state: 'released', ownership_state: 'released', archive_source: 'transcript', archive_status: 'captured',
    resume_session: { agent: 'codex', providerSession: { key: 'session_id', id: sessionId, transcriptPath, cwd: worktreePath }, connectionId: null } };
  const shown = { dispatch: { id: identity.dispatchId, runId: identity.runId, taskId: identity.taskId, task_id: identity.taskId, assigneeHandle: terminal, status: 'completed', processIncarnation: incarnation },
    worker: { dispatchId: identity.dispatchId, state: 'succeeded', agentTerminalHandle: terminal, worktreeId: worktree },
    projection: { ...identity, outcome: 'succeeded', workspace: { id: worktree } },
    observation: { status: 'exited', exactWorker: true }, terminal: { handle: terminal, worktreeId: worktree, worktreePath, connected: false, writable: false },
    terminalResource: { id: resourceId, ownerDispatchId: identity.dispatchId, originDispatchId: identity.dispatchId, releaseState: 'released', ownershipState: 'released', terminalHandle: terminal,
      endpointIncarnation: incarnation, worktreeId: worktree, archive: { source: 'transcript', status: 'captured' } } };
  const native = { dispatchId: identity.dispatchId, source: 'transcript', sourceIdentity, sourceExact: true, archived: true, provider: 'codex',
    status: { worker: 'succeeded', terminal: 'exited', liveness: 'exited' }, projection: shown.projection,
    contentComplete: false, clipping: ['transcript_payload'], warnings: ['Oversized transcript text was clipped.'],
    transcript: { messages: [structuredClone(finalMessage)], limited: true, nextCursor: 'native-cursor', returnedMessageCount: 1 } };
  const rows = [
    { type: 'session_meta', payload: { id: sessionId, session_id: sessionId, cwd: worktreePath } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: 'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour task ID is: ' + identity.taskId + '\n--dispatch-id ' + identity.dispatchId }] } },
    { type: 'response_item', payload: { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }, metadata: { retained_source: { id: { message_id: messageId, turn_id: 'turn_exact', role: 'assistant' }, complete: false } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn_exact', last_agent_message: text } },
  ];
  const data = { root, sessionRoot, transcriptPath, worktreePath, archive, stored, snapshot, shown, native, rows, text };
  await mutate(data);
  await fs.writeFile(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const fixturePath = path.join(root, 'fixture.json'), databasePath = path.join(root, 'orchestration.db');
  await fs.writeFile(fixturePath, JSON.stringify(data));
  await execute(process.platform === 'win32' ? 'python' : 'python3', ['-c', databaseFixture, databasePath, fixturePath]);
  const calls = [];
  const command = async args => {
    calls.push(args);
    assert.equal(args[0], 'orchestration');
    assert.ok(['worker-read', 'worker-show'].includes(args[1]));
    assert.equal(args[args.indexOf('--dispatch') + 1], identity.dispatchId);
    return structuredClone(args[1] === 'worker-show' ? shown : native);
  };
  return { ...data, databasePath, command, calls, options: { command, databasePath, sessionRoot } };
}

test('reads the exact archived native source and complete UTF-8 final without changing its database or session', async t => {
  const f = await fixture(t);
  const beforeDb = digest(await fs.readFile(f.databasePath)), beforeSession = digest(await fs.readFile(f.transcriptPath));
  const result = await readVerifiedArchivedFinal(identity, f.options);
  assert.equal(result.text, f.text);
  assert.equal(result.messageId, messageId);
  assert.equal(result.sourceIdentity, f.native.sourceIdentity);
  assert.equal(result.sha256, digest(f.text));
  assert.equal(result.provenance.responseLine, 3);
  assert.equal(result.provenance.taskCompleteLine, 4);
  assert.equal(result.provenance.nativePrefixChars, 220);
  assert.equal(result.provenance.transcriptSha256, beforeSession);
  assert.equal(digest(await fs.readFile(f.databasePath)), beforeDb);
  assert.equal(digest(await fs.readFile(f.transcriptPath)), beforeSession);
  assert.equal(f.calls.length, 2);
});

test('accepts supplied exact worker-show and pages the native source without changing identity', async t => {
  const f = await fixture(t);
  let calls = 0;
  const command = async args => {
    assert.equal(args[1], 'worker-read');
    calls++;
    return { ok: true, result: calls === 1 ? { ...f.native, transcript: { messages: [], nextCursor: 'next-exact', limited: true } } : f.native };
  };
  const result = await readVerifiedArchivedFinal(identity, { ...f.options, command, shown: { ok: true, result: f.shown } });
  assert.equal(result.text, f.text);
  assert.equal(calls, 2);
});

const rejected = [
  ['foreign native task', f => { f.shown.dispatch.taskId = 'task_foreign01'; }],
  ['unconfirmed exit', f => { f.shown.observation.exactWorker = false; }],
  ['connected terminal', f => { f.shown.terminal.connected = true; }],
  ['foreign process incarnation', f => { f.shown.dispatch.processIncarnation = 'foreign'; }],
  ['foreign native owner', f => { f.shown.terminalResource.ownerDispatchId = 'ctx_foreign01'; }],
  ['foreign stored owner', f => { f.stored.owner_dispatch_id = 'ctx_foreign01'; }],
  ['foreign archive resource', f => { f.archive.resource_id = 'wtr_foreign01'; }],
  ['altered snapshot incarnation', f => { f.snapshot.processIncarnation = 'foreign'; }],
  ['different native archive source hash', f => { f.archive.created_at = '2026-11-08 19:41:04'; }],
  ['foreign session metadata', f => { f.rows[0].payload.id = '01a1bca8-873d-7601-879f-0b47d8f5a1a8'; }],
  ['foreign session cwd', f => { f.rows[0].payload.cwd = f.root; }],
  ['foreign preamble task', f => { f.rows[1].payload.content[0].text = f.rows[1].payload.content[0].text.replace(identity.taskId, 'task_foreign01'); }],
  ['foreign final message id', f => { f.rows[2].metadata.retained_source.id.message_id = 'msg_foreign'; }],
  ['different native message prefix', f => { f.native.transcript.messages[0].blocks[0].text = 'not the archive'; }],
  ['different full message prefix', f => { f.rows[2].payload.content[0].text = 'changed' + f.text; f.rows[3].payload.last_agent_message = 'changed' + f.text; }],
  ['different task_complete text', f => { f.rows[3].payload.last_agent_message = 'different'; }],
  ['different task_complete turn', f => { f.rows[3].payload.turn_id = 'turn_foreign'; }],
  ['full candidate still clipped', f => { f.rows[2].payload.content[0].text = f.text + '\n… (truncated)'; f.rows[3].payload.last_agent_message = f.rows[2].payload.content[0].text; }],
  ['duplicate final message', f => { f.rows.splice(3, 0, structuredClone(f.rows[2])); }],
  ['unknown native warning', f => { f.native.warnings.push('Secrets removed.'); }],
  ['unsupported archive kind', f => { f.archive.kind = 'terminal_tail'; }],
  ['remote provider session', f => { f.stored.resume_session.connectionId = 'remote-connection'; }],
  ['session path outside root', f => { f.stored.resume_session.providerSession.transcriptPath = path.join(f.root, 'other.jsonl'); }],
];
for (const [name, mutate] of rejected) test('rejects ' + name, async t => {
  const f = await fixture(t, mutate);
  await assert.rejects(readVerifiedArchivedFinal(identity, f.options), { code: 'orca_archived_transcript_unverified' });
});

test('rejects malformed delivery despite matching native prefix and completion', async t => {
  const f = await fixture(t, value => {
    const text = value.text.replace('"approval": "approved"', '"approval": "not_applicable"');
    value.rows[2].payload.content[0].text = text;
    value.rows[3].payload.last_agent_message = text;
  });
  await assert.rejects(readVerifiedArchivedFinal(identity, f.options), { code: 'orca_archived_transcript_unverified' });
});

test('rejects oversized session before reading it', async t => {
  const f = await fixture(t);
  await fs.truncate(f.transcriptPath, 32 * 1024 * 1024 + 1);
  await assert.rejects(readVerifiedArchivedFinal(identity, f.options), { code: 'orca_archived_transcript_unverified' });
});

test('missing database stays absent and cannot be created by the reader', async t => {
  const f = await fixture(t);
  const absent = path.join(f.root, 'absent.db');
  await assert.rejects(readVerifiedArchivedFinal(identity, { ...f.options, databasePath: absent }), { code: 'orca_archived_transcript_unverified' });
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
});
