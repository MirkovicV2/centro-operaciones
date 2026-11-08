import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_FILE = path.join(ROOT, 'data', 'agency-assistant.json');

const emptyState = () => ({
  schema: 1,
  nextTaskId: 1,
  nextDomainId: 1,
  lastUpdateId: 0,
  tasks: [],
  domains: [],
  notifiedQueueEvents: [],
});

let writes = Promise.resolve();

export async function loadState() {
  let raw;
  try {
    raw = await fs.readFile(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw new Error('No se pudo leer el registro local.');
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error('El registro local no es válido; no se sobrescribirá.');
  }
  if (
    state?.schema !== 1 ||
    !Number.isInteger(state.nextTaskId) ||
    !Number.isInteger(state.nextDomainId) ||
    !Number.isInteger(state.lastUpdateId) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.domains) ||
    !Array.isArray(state.notifiedQueueEvents)
  ) {
    throw new Error('El formato del registro local no es compatible.');
  }
  return state;
}

async function writeState(state) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const temporary = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, DATA_FILE);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function changeState(change) {
  const pending = writes.then(async () => {
    const state = await loadState();
    const result = await change(state);
    await writeState(state);
    return result;
  });
  writes = pending.catch(() => {});
  return pending;
}

export async function acquireInstanceLock() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  const lockPath = `${DATA_FILE}.lock`;
  let handle;
  let ownsLock = false;
  try {
    handle = await fs.open(lockPath, 'wx');
    ownsLock = true;
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.sync();
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        'El asistente parece estar en marcha. Si se cerró de forma inesperada, comprueba el proceso antes de retirar data/agency-assistant.json.lock.',
      );
    }
    if (ownsLock) await fs.rm(lockPath, { force: true }).catch(() => {});
    throw new Error('No se pudo iniciar el almacén local.');
  } finally {
    await handle?.close();
  }

  return async () => {
    try {
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      if (lock.pid === process.pid) await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}
