import { rename as renameFile } from 'node:fs/promises';

// Retry only replacement of an already prepared local file. Never rerun the
// transaction, admission, worker or another external effect on a sharing error.
export async function replaceLocalFile(source, destination, {
  rename = renameFile, clock = () => performance.now(),
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), retryMs = 1500,
} = {}) {
  const deadline = clock() + retryMs;
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || clock() >= deadline) throw error;
      // Nonmatching intervals avoid repeatedly colliding with a polling reader.
      await wait(Math.min(113, 17 + attempt * 13, Math.max(1, deadline - clock())));
    }
  }
}
