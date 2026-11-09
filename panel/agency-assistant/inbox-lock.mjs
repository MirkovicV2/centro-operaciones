import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code });
const fileFor = (root, scope) => path.join(path.resolve(root), 'data', `.inbox-${createHash('sha256').update(scope).digest('hex').slice(0, 20)}.lock`);
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

// A dead PID is evidence of an interrupted transaction, not permission to erase
// its lock. Recovery requires an explicit review; an uncertain owner fails closed.
export async function withInboxLock(root, scope, action, { timeoutMs = 5000 } = {}) {
  const file = fileFor(root, scope);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID(), deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try { await fs.access(`${file}.recovery`); throw failure('inbox_lock_uncertain', 'Hay una recuperación de bloqueo en curso; vuelve a consultar.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { handle = await fs.open(file, 'wx'); }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch (readError) {
        if (readError.code === 'ENOENT') continue;
        // An owner may still be writing its initial record. Never steal it.
        if (Date.now() < deadline) { await delay(20); continue; }
        throw failure('inbox_lock_uncertain', 'El bloqueo de la bandeja no identifica a su propietario; requiere revisión.');
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw failure('inbox_lock_uncertain', 'Bloqueo de bandeja no válido; requiere revisión.');
      if (!alive(owner.pid)) throw failure('inbox_lock_stale', 'Una escritura anterior de la bandeja se interrumpió; revisa su bloqueo antes de recuperar.');
      if (Date.now() >= deadline) throw failure('inbox_locked', 'La bandeja está ocupada; vuelve a consultar la misma operación.');
      await delay(20); continue;
    }
    try { await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token, at: new Date().toISOString(), scope })); await handle.sync(); }
    finally { await handle.close(); }
    try { await fs.access(`${file}.recovery`); await fs.unlink(file); throw failure('inbox_lock_uncertain', 'La recuperación del bloqueo aún no ha terminado.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    break;
  }
  try { return await action(); }
  finally {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    if (owner.token !== token) throw failure('inbox_lock_uncertain', 'El propietario del bloqueo cambió; no se elimina el bloqueo.');
    // Windows can transiently refuse delete while a contender reads metadata.
    const releaseDeadline = Date.now() + 1000;
    while (true) {
      try { await fs.unlink(file); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= releaseDeadline) throw error;
        await delay(10);
      }
    }
  }
}

export async function recoverInboxLock(root, scope, { confirmReviewed = false } = {}) {
  if (!confirmReviewed) throw failure('review_required', 'Confirma que has revisado la operación interrumpida.');
  const file = fileFor(root, scope);
  const guard = await fs.open(`${file}.recovery`, 'wx');
  try {
  const original = await fs.readFile(file, 'utf8');
  let owner;
  try { owner = JSON.parse(original); } catch { throw failure('inbox_lock_uncertain', 'El bloqueo corrupto requiere revisión manual.'); }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.token || alive(owner.pid)) throw failure('inbox_lock_uncertain', 'No está confirmada la salida del propietario del bloqueo.');
  // Contenders never remove stale locks, so it cannot change beneath this check.
  if (await fs.readFile(file, 'utf8') !== original) throw failure('inbox_lock_uncertain', 'El bloqueo cambió durante la revisión.');
  await fs.unlink(file);
  } finally { await guard.close(); await fs.unlink(`${file}.recovery`); }
}
