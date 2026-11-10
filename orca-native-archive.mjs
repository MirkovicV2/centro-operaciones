import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { IDENTIFIERS, parseDelivery } from './workflow-contract.mjs';
import { orcaUserDataDir } from './local-tools.mjs';

const execute = promisify(execFile);
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const CLIP_SUFFIX = '\n… (truncated)';
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceHash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url').slice(0, 32);
function fail(message) {
  const error = new Error(message);
  error.code = 'orca_archived_transcript_unverified';
  throw error;
}
function requireProof(condition, message) { if (!condition) fail(message); }
function unwrap(value) {
  if (value?.ok === false) fail('ORCA no pudo acreditar el archivo del trabajador.');
  return value?.result ?? value;
}
function textOf(message) {
  return (message?.blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}
function canonicalPath(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// An exact, read-only query. No database import, migration, write or session search.
const SQLITE_READ = String.raw`
import sys,json,sqlite3,pathlib
db,dispatch,resource=sys.argv[1:4]
c=sqlite3.connect(pathlib.Path(db).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
c.row_factory=sqlite3.Row
c.execute('PRAGMA query_only=ON')
c.execute('BEGIN')
try:
 a=c.execute('SELECT dispatch_id,resource_id,kind,created_at,length(CAST(content AS BLOB)) AS bytes FROM worker_terminal_archives WHERE dispatch_id=?',(dispatch,)).fetchone()
 r=c.execute('SELECT * FROM worker_terminal_resources WHERE id=? AND owner_dispatch_id=?',(resource,dispatch)).fetchone()
 if a is None or r is None or a['bytes']>2097152:
  raise ValueError('Exact bounded worker archive unavailable')
 content=c.execute('SELECT content FROM worker_terminal_archives WHERE dispatch_id=? AND resource_id=?',(dispatch,resource)).fetchone()
 if content is None: raise ValueError('Worker archive resource mismatch')
 print(json.dumps({'archive':dict(a),'resource':dict(r),'content':content[0]},ensure_ascii=True))
finally:
 c.close()
`;

async function readArchive(databasePath, identity, resourceId) {
  try {
    const { stdout } = await execute(process.platform === 'win32' ? 'python' : 'python3',
      ['-c', SQLITE_READ, databasePath, identity.dispatchId, resourceId],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true });
    return JSON.parse(stdout);
  } catch { fail('No se pudo leer el archivo nativo exacto en modo de solo lectura.'); }
}

function validateShown(shown, identity) {
  const { dispatch, worker, terminal, terminalResource: resource, observation, projection } = shown ?? {};
  requireProof(dispatch?.id === identity.dispatchId && dispatch.runId === identity.runId
    && dispatch.taskId === identity.taskId && (dispatch.task_id === undefined || dispatch.task_id === identity.taskId)
    && worker?.dispatchId === identity.dispatchId && worker.state === 'succeeded' && dispatch.status === 'completed'
    && projection?.dispatchId === identity.dispatchId && projection.runId === identity.runId
    && projection.taskId === identity.taskId && projection.outcome === 'succeeded', 'La identidad o el resultado nativo no coincide.');
  requireProof(resource?.ownerDispatchId === identity.dispatchId && resource.originDispatchId === identity.dispatchId
    && /^wtr_[a-zA-Z0-9]+$/.test(resource.id ?? '') && resource.releaseState === 'released'
    && resource.ownershipState === 'released' && resource.archive?.source === 'transcript'
    && resource.archive.status === 'captured' && observation?.status === 'exited' && observation.exactWorker === true,
  'No hay prueba exacta de cierre y archivo del trabajador.');
  requireProof(terminal?.handle === worker.agentTerminalHandle && terminal.handle === dispatch.assigneeHandle
    && terminal.handle === resource.terminalHandle && terminal.connected === false && terminal.writable === false
    && worker.worktreeId === resource.worktreeId && terminal.worktreeId === resource.worktreeId
    && projection.workspace?.id === resource.worktreeId
    && dispatch.processIncarnation === resource.endpointIncarnation,
  'El recurso, proceso o terminal archivado pertenece a otro trabajador.');
  return resource;
}

function validateNative(page, identity) {
  requireProof(page?.dispatchId === identity.dispatchId && page.source === 'transcript'
    && page.sourceExact === true && page.archived === true && page.provider === 'codex'
    && typeof page.sourceIdentity === 'string' && /^[\w-]{32}$/.test(page.sourceIdentity)
    && page.status?.worker === 'succeeded' && page.status.terminal === 'exited' && page.status.liveness === 'exited'
    && page.projection?.runId === identity.runId && page.projection.taskId === identity.taskId
    && page.projection.dispatchId === identity.dispatchId && page.projection.outcome === 'succeeded'
    && Array.isArray(page.transcript?.messages), 'La lectura nativa no acredita el transcript exacto.');
  requireProof((page.clipping ?? []).every(value => ['transcript_payload', 'message_limit'].includes(value))
    && (page.warnings ?? []).every(value => ['Oversized transcript text was clipped.', 'Oversized tool input was clipped.'].includes(value)),
  'La lectura archivada contiene omisiones o advertencias no admitidas.');
}

async function boundedSession(filePath, sessionRoot) {
  requireProof(typeof filePath === 'string' && path.isAbsolute(filePath) && path.extname(filePath) === '.jsonl',
    'La sesión archivada no proporciona una ruta JSONL absoluta.');
  const [rootReal, fileReal] = await Promise.all([fs.realpath(sessionRoot), fs.realpath(filePath)]);
  const relative = path.relative(rootReal, fileReal);
  requireProof(relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)
    && canonicalPath(fileReal) === canonicalPath(filePath), 'La sesión archivada sale de su carpeta autorizada.');
  const handle = await fs.open(fileReal, 'r');
  try {
    const before = await handle.stat();
    requireProof(before.isFile() && before.size > 0 && before.size <= MAX_SESSION_BYTES, 'La sesión excede el límite de lectura.');
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const raw = buffer.subarray(0, count);
    const after = await handle.stat();
    const atPath = await fs.stat(filePath);
    requireProof(raw.length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs
      && atPath.ino === after.ino && atPath.dev === after.dev && atPath.size === after.size
      && canonicalPath(await fs.realpath(filePath)) === canonicalPath(fileReal), 'La sesión cambió durante la lectura.');
    requireProof(!raw.toString('utf8').includes('\uFFFD'), 'La sesión no conserva texto UTF-8 íntegro.');
    const lines = raw.toString('utf8').split(/\r?\n/);
    const rows = lines.flatMap((line, index) => {
      if (!line.trim()) return [];
      requireProof(Buffer.byteLength(line) <= 4 * 1024 * 1024, 'Una línea de la sesión excede el límite.');
      return [{ value: JSON.parse(line), line: index + 1, sha256: sha(line) }];
    });
    return { raw, rows, path: fileReal };
  } finally { await handle.close(); }
}

// 3: Orca keeps orchestration.db under the platform's user data directory. Windows
// keeps its historical APPDATA default; Linux follows XDG (verified on Ubuntu 26.10:
// ~/.config/orca/orchestration.db); macOS uses Application Support (not verified here).
export function defaultOrcaDatabasePath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const directory = orcaUserDataDir({ platform, env, home });
  return (platform === 'win32' ? path.win32 : path.posix).join(directory, 'orchestration.db');
}

/** Recover one completed, exact archived Codex final message; never searches sessions or changes ORCA. */
export async function readVerifiedArchivedFinal(identity, {
  command, shown,
  databasePath = defaultOrcaDatabasePath(),
  sessionRoot = path.join(os.homedir(), '.codex', 'sessions'),
} = {}) {
  try {
    requireProof(typeof command === 'function' && IDENTIFIERS.runId.test(identity?.runId ?? '')
      && IDENTIFIERS.taskId.test(identity?.taskId ?? '') && IDENTIFIERS.dispatchId.test(identity?.dispatchId ?? ''), 'Falta la identidad exacta de la entrega.');
    const nativeShown = unwrap(shown ?? await command(['orchestration', 'worker-show', '--dispatch', identity.dispatchId, '--full']));
    const resource = validateShown(nativeShown, identity);
    let native = unwrap(await command(['orchestration', 'worker-read', '--dispatch', identity.dispatchId, '--source', 'transcript', '--limit', '100', '--full']));
    validateNative(native, identity);
    const { archive, resource: stored, content } = await readArchive(databasePath, identity, resource.id);
    const snapshot = JSON.parse(content);
    const resume = JSON.parse(stored.resume_session);
    const sourceInputs = ['released-transcript-snapshot', resource.id, snapshot.processIncarnation, archive.created_at];
    requireProof(archive.dispatch_id === identity.dispatchId && archive.resource_id === resource.id && archive.kind === 'transcript_pin'
      && snapshot.version === 2 && snapshot.agent === 'codex' && Array.isArray(snapshot.messages)
      && snapshot.messages.length > 0 && snapshot.messages.length <= 1000
      && stored.id === resource.id && stored.owner_dispatch_id === identity.dispatchId && stored.origin_dispatch_id === identity.dispatchId
      && stored.release_state === 'released' && stored.ownership_state === 'released'
      && stored.archive_source === 'transcript' && stored.archive_status === 'captured'
      && stored.terminal_handle === resource.terminalHandle && stored.worktree_id === resource.worktreeId
      && stored.process_incarnation === resource.endpointIncarnation && stored.endpoint_incarnation === resource.endpointIncarnation
      && snapshot.processIncarnation === resource.endpointIncarnation && sourceHash(sourceInputs) === native.sourceIdentity,
    'El archivo local no coincide con la fuente que acredita ORCA.');
    requireProof(resume?.agent === 'codex' && resume.connectionId === null && resume.providerSession?.key === 'session_id'
      && /^[a-f0-9-]{36}$/i.test(resume.providerSession.id ?? '') && !resume.wslDistro
      && canonicalPath(resume.providerSession.cwd) === canonicalPath(nativeShown.terminal.worktreePath),
    'La sesión local archivada no coincide con el espacio de trabajo.');
    const final = snapshot.messages.findLast(message => message.role === 'assistant' && textOf(message));
    requireProof(final && typeof final.id === 'string', 'El archivo nativo no conserva un mensaje final.');
    const sourceIdentity = native.sourceIdentity;
    const seen = new Set();
    let matching = native.transcript.messages.find(message => message.id === final.id);
    for (let page = 0; !matching && page < 10; page++) {
      const cursor = native.transcript.nextCursor ?? native.cursor;
      requireProof(typeof cursor === 'string' && !seen.has(cursor), 'No se pudo acreditar el mensaje final en la lectura nativa.');
      seen.add(cursor);
      native = unwrap(await command(['orchestration', 'worker-read', '--dispatch', identity.dispatchId, '--source', 'transcript', '--limit', '100', '--full', '--cursor', cursor]));
      validateNative(native, identity);
      requireProof(native.sourceIdentity === sourceIdentity, 'La fuente nativa cambió al leer el archivo.');
      matching = native.transcript.messages.find(message => message.id === final.id);
    }
    requireProof(matching?.role === 'assistant' && textOf(matching) === textOf(final), 'El mensaje archivado no coincide con el mensaje nativo.');
    const session = await boundedSession(resume.providerSession.transcriptPath, sessionRoot);
    const metadata = session.rows.filter(row => row.value.type === 'session_meta');
    requireProof(metadata.length === 1 && metadata[0].value.payload?.id === resume.providerSession.id
      && (metadata[0].value.payload.session_id === undefined || metadata[0].value.payload.session_id === resume.providerSession.id)
      && canonicalPath(metadata[0].value.payload.cwd) === canonicalPath(resume.providerSession.cwd), 'La cabecera de la sesión archivada no coincide.');
    const preambles = session.rows.filter(row => row.value.type === 'response_item' && row.value.payload?.role === 'user')
      .map(row => (row.value.payload.content ?? []).map(block => block.text ?? '').join('\n'))
      .filter(text => text.startsWith('You are working inside Orca, a multi-agent IDE. You are a dispatched worker.'));
    requireProof(preambles.some(text => text.includes('Your task ID is: ' + identity.taskId + '\n')
      && new RegExp('--dispatch-id\\s+' + identity.dispatchId + '(?=\\s|$)').test(text)), 'La sesión no contiene el encargo nativo esperado.');
    const finals = session.rows.filter(row => row.value.type === 'response_item' && row.value.payload?.role === 'assistant'
      && row.value.payload.phase === 'final_answer');
    const found = finals.filter(row => row.value.metadata?.retained_source?.id?.message_id === final.id);
    requireProof(found.length === 1 && finals.at(-1) === found[0], 'La sesión no contiene un único mensaje final nativo vigente.');
    const row = found[0];
    requireProof(row.value.metadata.retained_source.id.role === 'assistant', 'La identidad del mensaje final no corresponde al asistente.');
    const text = row.value.payload.content.filter(block => block.type === 'output_text').map(block => block.text).join('\n');
    const turnId = row.value.metadata.retained_source.id.turn_id;
    const complete = session.rows.findLast(item => item.value.type === 'event_msg' && item.value.payload?.type === 'task_complete');
    requireProof(typeof text === 'string' && text.length > 0 && text.length <= 128000 && !text.includes('… (truncated)')
      && typeof turnId === 'string' && complete?.value.payload?.turn_id === turnId
      && complete.value.payload.last_agent_message === text, 'La sesión no acredita una respuesta final completa.');
    const archivedText = textOf(final);
    const clipped = archivedText.endsWith(CLIP_SUFFIX);
    const prefix = clipped ? archivedText.slice(0, -CLIP_SUFFIX.length) : archivedText;
    requireProof(prefix.length > 0 && (clipped ? text.startsWith(prefix) && text.length > prefix.length : text === prefix),
      'La respuesta completa difiere del contenido acreditado por ORCA.');
    parseDelivery(text, identity, { required: true });
    return { text, sourceIdentity, messageId: final.id, sha256: sha(text), provenance: {
      source: 'native_archived_transcript', databasePath: path.resolve(databasePath), resourceId: resource.id,
      archiveCreatedAt: archive.created_at, archiveContentSha256: sha(content), sourceIdentityInputs: sourceInputs,
      processIncarnation: snapshot.processIncarnation, sessionId: resume.providerSession.id,
      transcriptPath: session.path, transcriptSha256: sha(session.raw), transcriptBytes: session.raw.length,
      responseLine: row.line, responseLineSha256: row.sha256, taskCompleteLine: complete.line,
      turnId, nativePrefixChars: prefix.length, nativeClipped: clipped,
    } };
  } catch (error) {
    if (error?.code === 'orca_archived_transcript_unverified') throw error;
    fail('La entrega archivada no superó la verificación estricta de integridad.');
  }
}
