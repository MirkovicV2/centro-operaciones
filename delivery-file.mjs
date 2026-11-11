// Delivery by file. Passing the whole report as a shell argument broke it three different ways in the first real pilots
// (accents, double escaping, apostrophes eaten by single quotes). The worker writes the JSON to a file the Centro gives
// it and sends only an ASCII line with the file's sha256: nothing in that line can be damaged by quoting or encoding.
// The Orca message stays the proof of who delivered and when; the hash binds it to exactly these bytes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ContractError } from './workflow-contract.mjs';

export const DELIVERY_DIR = 'entregas';
export const DELIVERY_FILE_MAX_BYTES = 128_000;
const MARKER = /^centro-delivery-file sha256=([a-f0-9]{64})$/;
const SAFE = /^[A-Za-z0-9_.-]{1,160}$/;

export function deliveryFilePath(root, { jobId, stage, jobAttempt }) {
  if (!SAFE.test(jobId || '') || !SAFE.test(stage || '') || !Number.isInteger(jobAttempt) || jobAttempt < 1) throw new ContractError('Identidad de entrega inválida.', 'delivery_file_invalid');
  return path.join(path.resolve(root), DELIVERY_DIR, jobId, `${stage}-${jobAttempt}.json`);
}

export const isDeliveryFileMarker = text => MARKER.test(String(text ?? '').trim());

// The worker's text as it should be parsed: a marker becomes the centro-delivery block read from the file; anything else
// is returned unchanged, so a worker that delivers inline as before keeps working.
export async function resolveDeliveryText(root, identity, text) {
  const match = MARKER.exec(String(text ?? '').trim());
  if (!match) return text;
  const file = deliveryFilePath(root, identity);
  let info;
  try { info = await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') throw new ContractError(`El trabajador anunció su entrega en ${path.relative(path.resolve(root), file)}, pero el archivo no existe.`, 'delivery_file_missing'); throw error; }
  if (!info.isFile()) throw new ContractError('La entrega por archivo debe ser un archivo normal, no un enlace.', 'delivery_file_invalid');
  if (info.size > DELIVERY_FILE_MAX_BYTES) throw new ContractError('La entrega por archivo supera el límite.', 'delivery_file_invalid');
  const bytes = await fs.readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw new ContractError('El archivo de entrega no tiene la huella anunciada en Orca: cambió después de enviarse o es otro.', 'delivery_file_mismatch');
  const body = bytes.toString('utf8').replace(/^﻿/, '').trim().replace(/^```(?:centro-delivery|json)?\s*/, '').replace(/\s*```$/, '');
  return '```centro-delivery\n' + body + '\n```';
}

// Empty when the stage has no complete identity yet (legacy or simulated jobs): those keep the inline delivery only.
export function deliveryFileInstructions(root, identity) {
  let file;
  try { file = deliveryFilePath(root, identity); } catch { return ''; }
  return [
    `ENTREGA POR ARCHIVO (preferida): escribe el objeto JSON de tu entrega, sin el cercado de bloque, en ${JSON.stringify(file)} con tu herramienta de escritura de archivos (no con la terminal). Escríbelo tal cual, en UTF-8 y sin escapes \\uXXXX.`,
    'Calcula su sha256 con la misma orden de huella de la línea VERIFICACIÓN, cambiando la ruta por la de este archivo, y envía worker_done con --body exactamente `centro-delivery-file sha256=<64 hex>` y nada más. No modifiques el archivo después de enviarlo.',
    'Solo si no puedes escribir ese archivo, usa el bloque centro-delivery dentro del body como se indica abajo.',
  ].join('\n');
}
