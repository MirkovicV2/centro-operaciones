import fs from 'node:fs/promises';
import path from 'node:path';
import { ContractError, fingerprint, validateDelivery, parseDelivery } from './workflow-contract.mjs';

export const ORCA_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

export function isOrcaStatusReadError(code) {
  return ['orca_identity_mismatch', 'orca_liveness_conflict', 'orca_status_invalid', 'orca_invalid_response',
    'orca_command_failed', 'orca_response_too_large'].includes(code);
}

// The full native record retains exact exit evidence after the concise
// projection loses live terminal status. Missing status is never proof of exit.
export function normalizeWorkerStatus(value) {
  if (!value || typeof value !== 'object') throw new ContractError('Estado Orca ilegible.', 'orca_status_invalid');
  if (!value.worker && !value.dispatch && !value.projection) return value;
  const { worker = {}, dispatch = {}, projection = {}, terminal, observation = {} } = value;
  const same = (name, values) => {
    const present = values.filter(item => item !== undefined && item !== null);
    if (present.some(item => typeof item !== 'string' || !item) || new Set(present).size > 1) {
      throw new ContractError('La evidencia Orca contradice ' + name + '.', 'orca_identity_mismatch');
    }
    return present[0];
  };
  const dispatchId = same('dispatchId', [dispatch.id, dispatch.dispatchId, worker.dispatchId, projection.id, projection.dispatchId]);
  const taskId = same('taskId', [dispatch.taskId, dispatch.task_id, worker.taskId, projection.taskId]);
  const runId = same('runId', [dispatch.runId, worker.runId, projection.runId]);
  const terminalStates = ['succeeded', 'failed', 'cancelled', 'abandoned', 'stopped', 'rejected'];
  // A stopped process settles its dispatch as failed in Orca's projection.
  const outcome = worker.state === 'stopped' && projection.stage?.worker === 'stopped'
    && dispatch.status === 'failed' && projection.outcome === 'failed' ? 'stopped' : projection.outcome;
  const state = same('state', [worker.state, projection.stage?.worker,
    terminalStates.includes(outcome) ? outcome : undefined]);
  if (terminalStates.includes(state) && outcome != null && outcome !== state) {
    throw new ContractError('La evidencia Orca contradice el resultado terminal.', 'orca_identity_mismatch');
  }
  const dispatchStatus = same('dispatchStatus', [dispatch.status, projection.stage?.dispatch]);
  const terminalHandle = same('terminal', [dispatch.assigneeHandle, worker.agentTerminalHandle, terminal?.handle]);
  const worktreeId = same('workspace', [worker.worktreeId, projection.workspace?.id, terminal?.worktreeId]);
  const verdict = projection.liveness?.verdict;
  const exactExit = observation.status === 'exited' && observation.exactWorker === true
    && terminalHandle && terminal?.handle === terminalHandle && terminal.connected === false && terminal.writable === false;
  if (exactExit && verdict === 'live') throw new ContractError('La evidencia Orca contradice el cierre del trabajador.', 'orca_liveness_conflict');
  return {
    dispatchId, taskId, runId, state, dispatchStatus,
    liveness: exactExit ? 'exited' : verdict === 'exited' || verdict === 'live' && observation.exactWorker !== true ? 'unverifiable' : verdict ?? 'unverifiable',
    terminal: terminalHandle, worktreeId, workspace: terminal?.worktreePath,
    exactWorker: observation.exactWorker === true,
    exitEvidence: exactExit ? 'native_exact_observation' : null,
  };
}

export async function saveDispatchSpec(root, identity, text) {
  const directory = path.join(path.resolve(root), 'data', 'dispatch-specs', identity.jobId);
  await fs.mkdir(directory, { recursive: true });
  if (identity.validationCycle && !/^[a-f0-9]{64}$/.test(identity.validationCycle)) throw new ContractError('Ciclo de validación inválido.', 'dispatch_spec_mismatch');
  const suffix = identity.validationCycle ? '-validation-' + identity.validationCycle : '';
  const file = path.join(directory, identity.stage + '-attempt-' + identity.jobAttempt + suffix + '.txt');
  const sha256 = fingerprint(text);
  try { await fs.writeFile(file, text, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fingerprint(await fs.readFile(file)) !== sha256) throw new ContractError('El encargo inmutable de la Task cambió.', 'dispatch_spec_mismatch');
  }
  return { path: file, sha256, chars: text.length, bytes: Buffer.byteLength(text) };
}

export async function verifyDispatchSpec(root, artifact) {
  if (!artifact?.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new ContractError('Referencia de encargo inválida.', 'dispatch_spec_mismatch');
  const base = await fs.realpath(path.join(root, 'data', 'dispatch-specs'));
  const file = await fs.realpath(artifact.path);
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || fingerprint(await fs.readFile(file)) !== artifact.sha256) {
    throw new ContractError('El encargo de la Task cambió o está fuera del directorio asignado.', 'dispatch_spec_mismatch');
  }
  return artifact;
}

export function checkWorkerIdentity(worker, expected, { strict = false } = {}) {
  for (const key of ['dispatchId', 'taskId', 'runId']) {
    if ((strict && !worker?.[key]) || (worker?.[key] && expected[key] && worker[key] !== expected[key])) {
      throw new ContractError('La consulta Orca devolvió otro ' + key + '.', 'orca_identity_mismatch');
    }
  }
}

export function matchingCompletion(messages, expected, { strict = false } = {}) {
  const matching = [];
  for (const message of messages ?? []) {
    if (message.type !== 'worker_done' || typeof message.body !== 'string' || !message.body.trim()) continue;
    let payload;
    try { payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload; } catch { continue; }
    if (payload?.dispatchId !== expected.dispatchId) continue;
    if (message.contentComplete === false || message.truncated === true || message.clipped === true
      || message.warnings?.length || message.clipping?.length) throw new ContractError('El recibo de entrega está recortado.', 'orca_receipt_incomplete');
    if ((strict && payload.taskId !== expected.taskId) || (payload.taskId && payload.taskId !== expected.taskId)
      || (message.run_id && message.run_id !== expected.runId)
      || (message.to_handle && message.to_handle !== 'run:' + expected.runId)
      || (message.to && message.to !== 'run:' + expected.runId)
      || (payload.outcome && payload.outcome !== (expected.workerState ?? 'succeeded'))) {
      throw new ContractError('El recibo de entrega no corresponde a la Task/Run/resultado esperado.', 'orca_receipt_mismatch');
    }
    matching.push({ text: message.body.trim(), messageId: message.id ?? null });
  }
  if (new Set(matching.map(item => item.text)).size > 1) throw new ContractError('Hay entregas contradictorias para el mismo Dispatch.', 'orca_receipt_ambiguous');
  return matching[0] ?? null;
}

const askPrefix = 'centro-ask-v1.';

// Native inbox pages are newest first. Only the exact current assignment can
// register a question. Text fallback represents a question, never an approval.
export function pendingStageDelivery(messages, expected) {
  for (const message of messages ?? []) {
    if (!['ask', 'question'].includes(message.type) || !message.id || message.run_id !== expected.runId
      || message.to_handle !== 'run:' + expected.runId
      || !(message.from_handle === `dispatch:${expected.dispatchId}` || expected.terminalHandle && message.from_handle === expected.terminalHandle)) continue;
    let payload;
    try { payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload; } catch { continue; }
    if (payload?.taskId !== expected.taskId || payload.dispatchId !== expected.dispatchId) continue;
    if (message.contentComplete === false || message.truncated || message.clipped || message.warnings?.length || message.clipping?.length) continue;
    const body = message.body;
    const encoded = typeof body === 'string' && body.startsWith(askPrefix);
    let delivery;
    try {
      const payloadText = encoded ? body.slice(askPrefix.length) : null;
      const decoded = payloadText && /^[a-zA-Z0-9_-]+$/.test(payloadText) && payloadText.length <= 172_000
        ? Buffer.from(payloadText, 'base64url') : null;
      if (!encoded || decoded?.toString('base64url') === payloadText) {
        delivery = parseDelivery(encoded ? new TextDecoder('utf-8', { fatal: true }).decode(decoded) : body, expected);
      }
    } catch (error) {
      if (error.code === 'delivery_identity_mismatch') throw error;
    }
    if (delivery && ['needs_input', 'blocked'].includes(delivery.outcome)) return { delivery, messageId: message.id };
    if (delivery || typeof body !== 'string' || payload.question !== body || !body.trim() || !/^msg_[a-zA-Z0-9_-]{6,80}$/.test(message.id)) continue;
    const damaged = encoded || /^\s*(?:\{|```)/.test(body);
    const summary = damaged
      ? 'Orca confirmó la pregunta, pero su formato estructurado llegó dañado. El coordinador puede revisar el mensaje original.'
      : 'Orca confirmó una pregunta de este trabajador.';
    const text = !encoded && body.length <= 4000 ? body : `${summary} Mensaje ${message.id}.`;
    const { jobId, jobAttempt, stage, runId, taskId, dispatchId } = expected;
    delivery = validateDelivery({ version: 1, jobId, jobAttempt, stage, runId, taskId, dispatchId,
      outcome: 'needs_input', scope: 'partial', approval: 'not_applicable', summary,
      acceptance: [], evidence: [], decisions: [], questions: [{ id: message.id, text, required: true }],
    }, expected);
    return { delivery, messageId: message.id, transport: damaged ? 'damaged' : 'native_text' };
  }
  return null;
}

export function stageAskAnswered(messages, { messageId, runId, dispatchId, terminalHandle }) {
  return (messages ?? []).some(message => message.type === 'status' && message.thread_id === messageId
    && message.run_id === runId && message.from_handle === 'run:' + runId
    && (message.to_handle === `dispatch:${dispatchId}` || terminalHandle && message.to_handle === terminalHandle));
}

export async function readCompleteTranscript(expected, readPage, { maxPages = 100, maxChars = 1000000 } = {}) {
  let cursor, sourceIdentity, lastText = '', count = 0;
  const seen = new Set();
  for (let n = 0; n < maxPages; n++) {
    const page = await readPage(cursor);
    if (page?.dispatchId !== expected.dispatchId || page.source !== 'transcript' || page.sourceExact !== true
      || typeof page.sourceIdentity !== 'string' || !page.sourceIdentity
      || (sourceIdentity && sourceIdentity !== page.sourceIdentity)
      || (page.status?.worker && page.status.worker !== (expected.workerState ?? 'succeeded'))
      || (page.projection?.outcome && page.projection.outcome !== (expected.workerState ?? 'succeeded'))
      || (page.warnings !== undefined && (!Array.isArray(page.warnings) || page.warnings.length))
      || (page.clipping !== undefined && (!Array.isArray(page.clipping) || page.clipping.length))
      || !Array.isArray(page.transcript?.messages)) {
      throw new ContractError('Transcript incompleto, recortado o de otra identidad.', 'orca_transcript_unverified');
    }
    sourceIdentity ??= page.sourceIdentity;
    for (const message of page.transcript.messages) {
      if (message.role !== 'assistant') continue;
      const text = (message.blocks ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
      count += text.length;
      if (count > maxChars) throw new ContractError('El transcript supera el límite de lectura verificable.', 'orca_transcript_limit');
      if (text) lastText = text;
    }
    const limited = page.transcript.limited ?? page.limited;
    if (limited === false && page.contentComplete === true) {
      if (!lastText) throw new ContractError('El transcript completo no contiene una entrega.', 'orca_empty_result');
      return { text: lastText, source: 'transcript', sourceIdentity, pages: n + 1 };
    }
    const next = page.transcript.nextCursor ?? page.nextCursor;
    if (limited !== true || typeof next !== 'string' || !next || seen.has(next) || next === cursor) {
      throw new ContractError('No se puede demostrar completitud o avanzar el cursor.', 'orca_transcript_unverified');
    }
    seen.add(next); cursor = next;
  }
  throw new ContractError('Transcript incompleto al alcanzar el límite de páginas.', 'orca_transcript_limit');
}

export async function saveStageReport(root, identity, text, delivery) {
  const directory = path.join(root, 'data', 'stage-reports', identity.jobId);
  await fs.mkdir(directory, { recursive: true });
  const body = JSON.stringify({ version: 1, identity, text, delivery }, null, 2) + '\n';
  const sha256 = fingerprint(body);
  const file = path.join(directory, identity.stage + '-' + identity.dispatchId + '-' + sha256.slice(0, 16) + '.json');
  try { await fs.writeFile(file, body, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fingerprint(await fs.readFile(file)) !== sha256) throw new ContractError('La evidencia persistida cambió.', 'artifact_mismatch');
  }
  return { path: file, sha256, chars: text.length, bytes: Buffer.byteLength(text) };
}

export async function readStageReport(root, artifact, expected) {
  if (!artifact?.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')) throw new ContractError('Referencia de informe inválida.', 'artifact_mismatch');
  const base = await fs.realpath(path.join(root, 'data', 'stage-reports'));
  const file = await fs.realpath(artifact.path);
  const relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ContractError('Informe fuera del directorio asignado.', 'artifact_mismatch');
  const body = await fs.readFile(file, 'utf8');
  if (fingerprint(body) !== artifact.sha256) throw new ContractError('El informe no coincide con su huella.', 'artifact_mismatch');
  const report = JSON.parse(body);
  if (expected) {
    for (const key of ['jobId', 'jobAttempt', 'stage', 'runId', 'taskId', 'dispatchId']) {
      if (report.identity?.[key] !== expected[key]) throw new ContractError('El informe pertenece a otra identidad: ' + key, 'artifact_identity_mismatch');
    }
    if (report.delivery) validateDelivery(report.delivery, expected);
  }
  return report;
}
