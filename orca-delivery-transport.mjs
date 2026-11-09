import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDelivery, deliveryApproved } from './workflow-contract.mjs';
import { matchingCompletion, readStageReport, normalizeWorkerStatus, checkWorkerIdentity } from './orca-evidence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'delivery_transport_unverified', uncertain: true });
function lossOnly(damaged, original) {
  if (typeof damaged !== typeof original || damaged === null || original === null) return damaged === original;
  if (typeof original === 'string') return damaged === original || damaged === original.replace(/[^\x00-\x7f]/g, '?');
  if (Array.isArray(original)) return Array.isArray(damaged) && damaged.length === original.length && original.every((value, index) => lossOnly(damaged[index], value));
  if (typeof original === 'object') {
    const keys = Object.keys(original).sort();
    return JSON.stringify(Object.keys(damaged).sort()) === JSON.stringify(keys) && keys.every(key => lossOnly(damaged[key], original[key]));
  }
  return damaged === original;
}

export function validateUnicodeDeliveryRepair(damagedText, originalText, expected) {
  let originalError;
  try { parseDelivery(damagedText, expected, { required: true }); }
  catch (error) { originalError = error; }
  if (originalError?.code !== 'delivery_acceptance_missing') throw fail('La entrega no corresponde a un rechazo de criterios causado por transporte.');
  const damaged = parseDelivery(damagedText, { ...expected, acceptance: [] }, { required: true });
  const original = parseDelivery(originalText, expected, { required: true });
  if (!deliveryApproved(original) || !lossOnly(damaged, original) || JSON.stringify(damaged) === JSON.stringify(original)) {
    throw fail('El recibo y el archivo original difieren en algo más que pérdida de Unicode; no se acepta la reparación.');
  }
  return original;
}

// Observation only: the queue and provider retain the damaged receipt and never
// rewrite native history. Native archive/session binding is checked by the reader.
export async function verifyUnicodeDeliveryTransport(root, job, step, { command, readArchive } = {}) {
  if (!['qa', 'reviewer'].includes(step?.key) || !step.artifact || typeof command !== 'function') throw fail('Falta la etapa o evidencia original de la entrega.');
  const identity = { jobId: job.id, jobAttempt: step.taskInputAttempt ?? step.attempt ?? job.attempts, stage: step.key,
    runId: step.runId || job.workflow?.runId, taskId: step.taskId, dispatchId: step.dispatchId, workerState: 'succeeded' };
  const shown = await command(['orchestration', 'worker-show', '--dispatch', identity.dispatchId, '--full']);
  const worker = normalizeWorkerStatus(shown); checkWorkerIdentity(worker, identity, { strict: true });
  const workspace = worker.workspace || worker.worktreeId?.split('::').slice(1).join('::');
  if (worker.state !== 'succeeded' || worker.liveness !== 'exited' || !workspace || path.resolve(workspace).toLowerCase() !== path.resolve(job.workspace).toLowerCase()) throw fail('La etapa no acredita cierre y checkout exactos.');
  const originalReport = await readStageReport(root, step.artifact, identity);
  const inbox = await command(['orchestration', 'inbox', '--terminal', `run:${identity.runId}`, '--limit', '100', '--full']);
  const receipt = matchingCompletion(inbox.messages, identity, { strict: true });
  if (!receipt?.messageId || receipt.text !== originalReport.text) throw fail('El recibo original no coincide con la evidencia guardada.');
  const reader = readArchive || (await import('./orca-native-archive.mjs')).readVerifiedArchivedFinal;
  const archived = await reader(identity, { command, shown });
  if (!archived?.sourceIdentity || !archived.messageId || archived.sha256 !== hash(archived.text || '')) throw fail('El archivo nativo no conserva su identidad y huella.');
  const delivery = validateUnicodeDeliveryRepair(receipt.text, archived.text, { ...identity, acceptance: job.contract?.acceptance || [] });
  const proof = { kind: 'unicode_loss', jobId: identity.jobId, jobAttempt: identity.jobAttempt, stage: identity.stage,
    runId: identity.runId, taskId: identity.taskId, dispatchId: identity.dispatchId, originalArtifactSha256: step.artifact.sha256,
    receiptMessageId: receipt.messageId, receiptSha256: hash(receipt.text), transcriptSourceIdentity: archived.sourceIdentity,
    transcriptSha256: archived.sha256, deliverySha256: hash(JSON.stringify(delivery)) };
  return { text: archived.text, delivery, proof, sourceMessageId: archived.messageId, provenance: archived.provenance };
}
