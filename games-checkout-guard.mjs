import { execFile as execFileCallback } from 'node:child_process';
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const unknownValues = new Set(['unknown', 'desconocida', 'unavailable', 'no disponible']);

function isKnown(value) {
  return typeof value === 'string' && value.trim() !== '' && !unknownValues.has(value.trim().toLowerCase());
}

function denied(code, message) {
  return { allowed: false, code, message };
}

function canonicalBranchRef(value) {
  if (!isKnown(value) || value !== value.trim()) return null;
  const name = value.startsWith('refs/heads/') ? value.slice(11) : value;
  // Only local branches qualify; never reinterpret another namespace as a branch.
  if (!isKnown(name) || name.startsWith('refs/') || name.startsWith('/') || name.endsWith('/') ||
      name.endsWith('.') || name.includes('..') || name.includes('@{') || name === '@' ||
      /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name) ||
      name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) return null;
  return `refs/heads/${name}`;
}

// Pure decision function: it only validates the confirmed values and the local observations it receives.
export function evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch, observations = {}) {
  if (typeof confirmedPath !== 'string' || confirmedPath.trim() === '') {
    return denied('confirmed-path-empty', 'La ruta confirmada está vacía; detenerse antes de inspeccionar el checkout.');
  }
  if (!path.isAbsolute(confirmedPath) || path.normalize(confirmedPath) !== confirmedPath) {
    return denied('confirmed-path-invalid', 'La ruta confirmada debe ser absoluta y estar normalizada; detenerse antes de inspeccionar el checkout.');
  }
  if (!canonicalBranchRef(confirmedBranch)) {
    return denied('confirmed-branch-unknown', 'La rama confirmada está vacía o no es verificable; detenerse antes de inspeccionar el checkout.');
  }
  if (observations.realPathError || typeof observations.realPath !== 'string' || observations.realPath.trim() === '') {
    return denied('current-path-unknown', 'No se pudo verificar la ruta local mediante realpath; detenerse antes de inspeccionar el checkout.');
  }

  const observedPath = path.normalize(observations.realPath);
  if (!path.isAbsolute(observedPath)) {
    return denied('current-path-unknown', 'realpath no produjo una ruta absoluta verificable; detenerse antes de inspeccionar el checkout.');
  }
  if (observedPath !== confirmedPath) {
    return denied('path-mismatch', `La ruta real (${observedPath}) no coincide exactamente con la ruta confirmada (${confirmedPath}).`);
  }
  if (observations.branchError || !canonicalBranchRef(observations.branchRef)) {
    return denied('current-branch-unknown', 'No se pudo verificar la branch ref activa; detenerse antes de inspeccionar el checkout.');
  }
  if (canonicalBranchRef(observations.branchRef) !== canonicalBranchRef(confirmedBranch)) {
    return denied('branch-mismatch', `La branch ref activa (${observations.branchRef}) no coincide exactamente con la confirmada (${confirmedBranch}).`);
  }
  return { allowed: true, code: 'match', message: 'Ruta canónica y branch ref coinciden exactamente.' };
}

async function readBranchRef(checkoutPath) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  }
  const { stdout } = await execFile('git', ['symbolic-ref', '--quiet', 'HEAD'], {
    cwd: checkoutPath,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 5000,
    env,
  });
  return stdout.trim();
}

// Collect only filesystem canonicalization and the current Git branch ref; neither operation writes to the checkout.
export async function checkGamesCheckoutGuard(confirmedPath, confirmedBranch, dependencies = {}) {
  const invalid = evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch);
  if (invalid.code !== 'current-path-unknown') return invalid;

  let realPath;
  try {
    realPath = await (dependencies.realpath || fsRealpath)(confirmedPath);
  } catch {
    return evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch, { realPathError: true });
  }

  const pathCheck = evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch, { realPath });
  if (pathCheck.code !== 'current-branch-unknown') return pathCheck;

  let branchRef;
  try {
    branchRef = await (dependencies.readBranchRef || readBranchRef)(realPath);
  } catch {
    return evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch, { realPath, branchError: true });
  }
  return evaluateGamesCheckoutGuard(confirmedPath, confirmedBranch, { realPath, branchRef });
}

async function main(args) {
  if (args.length !== 2) {
    process.stderr.write('Uso: node games-checkout-guard.mjs <ruta-absoluta-confirmada> <branch-ref-confirmada>\n');
    process.exitCode = 2;
    return;
  }
  const result = await checkGamesCheckoutGuard(args[0], args[1]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.allowed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
