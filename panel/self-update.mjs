// «Actualizar el Centro» desde el panel (también desde el móvil, por Tailscale): ver si `main` tiene commits nuevos y,
// con un clic de un admin, traerlos. Nada se aplica sin pasar antes las pruebas de esa versión en una copia aparte, y el
// panel solo se reinicia si no hay trabajos en marcha. No hay actualización automática: decide una persona.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BRANCH = 'main', REMOTE = 'origin';
const FETCH_EVERY_MS = 5 * 60_000;
const SHA = /^[0-9a-f]{40}$/;

export function runCommand(argv, { cwd, timeoutMs = 60_000, env = process.env } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: String(error.message), timedOut: false }); return; }
    const out = [], err = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => { if (err.reduce((size, item) => size + item.length, 0) < 64_000) err.push(chunk); });
    child.once('error', error => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(error.message), timedOut }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut }); });
  });
}

const tail = text => String(text ?? '').trim().split('\n').slice(-6).join('\n').slice(-600);

export function createSelfUpdate(root, { run = runCommand, now = () => Date.now(), jobsRunning = async () => 0, restart = defaultRestart, tmpdir = os.tmpdir() } = {}) {
  const git = (args, options = {}) => run(['git', ...args], { cwd: root, ...options });
  let lastFetch = 0, fetchError = null;
  let operation = { phase: 'idle' };

  async function status({ fresh = false } = {}) {
    if (fresh || now() - lastFetch >= FETCH_EVERY_MS) {
      const fetched = await git(['fetch', '--quiet', REMOTE, BRANCH], { timeoutMs: 60_000 });
      lastFetch = now();
      fetchError = fetched.code === 0 ? null : (tail(fetched.stderr) || 'git fetch falló.');
    }
    const read = async args => { const result = await git(args); return result.code === 0 ? result.stdout.trim() : null; };
    const branch = await read(['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = await read(['rev-parse', 'HEAD']);
    const remote = await read(['rev-parse', `refs/remotes/${REMOTE}/${BRANCH}`]);
    const base = { branch, head, remote, checkedAt: new Date(lastFetch || now()).toISOString(), fetchError, operation };
    if (!head || !remote) return { ...base, available: false, canUpdate: false, behind: 0, ahead: 0, commits: [], reason: 'No se puede leer el repositorio o su rama remota.' };
    const behind = Number(await read(['rev-list', '--count', `HEAD..${remote}`]) ?? 0);
    const ahead = Number(await read(['rev-list', '--count', `${remote}..HEAD`]) ?? 0);
    const dirty = Boolean(await read(['status', '--porcelain', '--untracked-files=no']));
    const log = behind ? await read(['log', '--format=%h%x09%an%x09%cI%x09%s', '-n', '30', `HEAD..${remote}`]) : '';
    const commits = (log ?? '').split('\n').filter(Boolean).map(line => { const [sha, author, date, ...subject] = line.split('\t'); return { sha, author, date, subject: subject.join('\t').slice(0, 200) }; });
    const reason = branch !== BRANCH ? `La carpeta está en la rama «${branch}», no en ${BRANCH}: actualízala a mano.`
      : dirty ? 'Hay cambios sin guardar en archivos del repositorio: actualízala a mano.'
        : ahead ? `Tienes ${ahead} commit(s) locales que no están en ${REMOTE}/${BRANCH}: actualízala a mano.`
          : !behind ? 'Ya tienes la última versión.' : null;
    return { ...base, available: behind > 0, canUpdate: behind > 0 && !reason, behind, ahead, dirty, commits, reason };
  }

  // Starts in the background and returns at once; progress is in status().operation.
  async function start({ target } = {}) {
    if (['probando', 'actualizando', 'reiniciando'].includes(operation.phase)) throw Object.assign(new Error('Ya hay una actualización en curso.'), { status: 409 });
    const current = await status({ fresh: true });
    if (!current.canUpdate) throw Object.assign(new Error(current.reason ?? 'No hay nada que actualizar.'), { status: 409 });
    if (!SHA.test(target ?? '') || target !== current.remote) throw Object.assign(new Error('La versión disponible ha cambiado desde que la viste; revísala de nuevo.'), { status: 409 });
    if (await jobsRunning() > 0) throw Object.assign(new Error('Hay trabajos en marcha: espera a que terminen para actualizar.'), { status: 409 });
    operation = { phase: 'probando', target, from: current.head, startedAt: new Date(now()).toISOString(), message: `Pasando las pruebas de ${target.slice(0, 7)} en una copia aparte…` };
    void apply(target, current.head);
    return operation;
  }

  async function apply(target, from) {
    const fail = message => { operation = { ...operation, phase: 'error', message, finishedAt: new Date(now()).toISOString() }; };
    const copy = path.join(tmpdir, `centro-actualizacion-${target.slice(0, 12)}-${now()}`);
    try {
      const added = await git(['worktree', 'add', '--detach', copy, target]);
      if (added.code !== 0) return fail(`No se pudo preparar la copia de prueba: ${tail(added.stderr)}`);
      const tested = await run([process.execPath, 'tests/run-tests.mjs'], { cwd: copy, timeoutMs: 15 * 60_000 });
      if (tested.code !== 0) {
        const summary = (tested.stdout.match(/^# (?:pass|fail) \d+$/gm) ?? []).join(' · ');
        return fail(`Las pruebas de la versión nueva no pasan${summary ? ` (${summary})` : ''}; no se ha cambiado nada.${tested.timedOut ? ' Se agotó el tiempo.' : ''}`);
      }
    } finally {
      await git(['worktree', 'remove', '--force', copy]);
      await fs.rm(copy, { recursive: true, force: true }).catch(() => {});
    }
    const again = await status();
    if (again.head !== from || again.branch !== BRANCH || again.dirty) return fail('El repositorio cambió mientras se probaba la versión nueva; no se ha actualizado.');
    if (await jobsRunning() > 0) return fail('Empezó un trabajo mientras se probaba la versión nueva; no se ha actualizado. Inténtalo cuando termine.');
    operation = { ...operation, phase: 'actualizando', message: 'Pruebas correctas. Trayendo la versión nueva…' };
    const merged = await git(['merge', '--ff-only', target]);
    if (merged.code !== 0) return fail(`No se pudo avanzar a la versión nueva: ${tail(merged.stderr)}`);
    operation = { ...operation, phase: 'reiniciando', message: 'Versión nueva instalada. Reiniciando el panel…' };
    try { await restart(root); }
    catch (error) { fail(`La versión nueva está instalada, pero el panel no se pudo reiniciar solo: ${String(error.message).slice(0, 200)}. Reinícialo a mano.`); }
  }

  return { status, start, get operation() { return operation; } };
}

// The restart scripts run the same checks as by hand (no jobs running, the PID is the panel) without repeating the tests.
async function defaultRestart(root) {
  const script = process.platform === 'win32'
    ? ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'panel', 'reiniciar-panel.ps1'), '-SinPruebas']
    : ['bash', path.join(root, 'panel', 'reiniciar-panel.sh'), '--sin-pruebas'];
  const child = spawn(script[0], script.slice(1), { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}
