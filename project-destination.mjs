import * as fs from 'node:fs/promises';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { homedir } from 'node:os';
import { validateWorkspace } from './providers.mjs';
import { excerpt } from './redaction.mjs';

// 2: destination failures keep a stable code and bounded, redacted details for the ledger and the panel.
export class DestinationError extends Error {
  constructor(code, message, details) {
    super(message); this.code = code; this.safeMessage = message; this.uncertain = false;
    if (details) this.details = details;
  }
}

// Observation only: never creates a checkout, branch, or Git metadata.
export async function inspectDestination(root, checkout, expectedBranch = '') {
  if (!checkout || path.isAbsolute(checkout)) throw new Error('Selecciona un checkout relativo bajo workspaces.');
  const workspace = await validateWorkspace({ workspace: path.resolve(root, checkout), isolated: true }, root);
  const protectedGame = path.join(homedir(), 'Documents', 'Proyectos', 'FlechaTrampa').replaceAll('\\', '/').toLowerCase();
  const normalizedWorkspace = workspace.replaceAll('\\', '/').toLowerCase();
  if (normalizedWorkspace === protectedGame || normalizedWorkspace.startsWith(`${protectedGame}/`)) throw new Error('El repositorio original FlechaTrampa está protegido; selecciona un checkout independiente.');
  const realRoot = await fs.realpath(root);
  const realBase = await fs.realpath(path.join(root, 'workspaces'));
  if (path.relative(realRoot, realBase).replaceAll('\\', '/') !== 'workspaces') throw new Error('workspaces debe pertenecer al centro de operaciones.');
  for (const metadata of ['commondir', 'gitdir', 'objects/info/alternates']) {
    try { await fs.access(path.join(workspace, '.git', metadata)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('No se admiten metadatos Git compartidos.');
  }
  for (const metadata of ['HEAD', 'config', 'objects']) {
    const stat = await fs.lstat(path.join(workspace, '.git', metadata));
    if (stat.isSymbolicLink() || (metadata === 'objects' ? !stat.isDirectory() : !stat.isFile())) throw new Error('El checkout requiere metadatos Git propios.');
  }
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const result = spawnSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000,
    env,
  });
  const branch = result.stdout?.trim();
  if (result.status !== 0 || !branch) throw new Error('No se pudo comprobar la rama; HEAD separado o Git no disponible.');
  if (expectedBranch && branch !== expectedBranch) throw new Error(`La rama cambió: esperada ${expectedBranch}, observada ${branch}. Revisa el destino.`);
  return { checkout, workspace, branch, checkedAt: new Date().toISOString(), valid: true };
}

// 13 (F9): the owner/repo keeps the case GitHub shows; comparisons use sameRepository.
export function githubRepository(origin) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin || '');
  if (!match || match[1].split('/').some(part => part === '.' || part === '..')) throw new Error('Origin debe ser un repositorio GitHub HTTPS o SSH, sin credenciales ni rutas locales.');
  return match[1];
}
export { sameRepository } from './repository-name.mjs';
import { sameRepository } from './repository-name.mjs';

// Turns a failed Git call of the destination check into the error a person can act on.
// Two causes need no stderr reading: the repository is gone (or this account cannot see it), and the branch is not on
// the remote (`ls-remote --exit-code` answers 2 with nothing on stderr).
export function destinationGitError(args, error, repository) {
  const stderr = String(error?.stderr || '');
  const details = {
    command: 'git ' + args[0], ...(Number.isInteger(error?.code) ? { exitCode: error.code } : {}),
    ...(typeof error?.code === 'string' ? { reason: error.code } : {}), ...(error?.killed ? { timedOut: true } : {}),
    ...(stderr ? { stderr: excerpt(stderr) } : {}),
  };
  if (args[0] === 'ls-remote' && /repository not found|does not appear to be a git repository/i.test(stderr)) {
    return new DestinationError('destination_repository_missing', `El repositorio ${repository} no existe en GitHub o las credenciales de este equipo no lo ven. Créalo de nuevo o corrige el proyecto.`, details);
  }
  if (args[0] === 'ls-remote' && error?.code === 2 && !stderr.trim()) {
    return new DestinationError('destination_remote_branch_missing', `La rama ${String(args.at(-1)).replace('refs/heads/', '')} no existe en origin. Súbela o corrige el proyecto.`, details);
  }
  return new DestinationError('destination_git_failed', 'Git no pudo verificar el destino; revisa conexión, permisos, origin y rama antes de continuar.', details);
}

// Inject Git in tests. Production only observes the configured existing remote;
// it never fetches, changes refs, creates branches, or writes to GitHub.
export async function verifyGitHubDestination(root, job, { git, inspect = inspectDestination, requireClean = true } = {}) {
  const checkout = path.relative(root, job.workspace || '').replaceAll('\\', '/');
  if (!job.branch || !job.destination?.repository) throw new DestinationError('destination_unconfigured', 'Configura y confirma repositorio GitHub y rama existente antes de ejecutar.');
  const observed = await inspect(root, checkout, job.branch);
  if (job.branch.includes('..') || /[\\\x00\r\n]/.test(job.branch) || job.branch.startsWith('/')) throw new DestinationError('destination_branch_invalid', 'Rama configurada inválida; confirma una rama Git existente.');
  for (const name of ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock', 'shallow.lock', `refs/heads/${job.branch}.lock`]) {
    try { await fs.access(path.join(observed.workspace, '.git', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new DestinationError('destination_git_locked', `Git tiene un bloqueo ${name}; revisa el proceso propietario antes de continuar.`, { lock: name });
  }
  const run = git || (async (args) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|SSH.*|ASKPASS)$/i.test(key)) delete env[key];
    try {
      const result = await promisify(execFile)('git', args, { cwd: observed.workspace, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000, env, maxBuffer: 64_000 });
      return result.stdout.trim();
    } catch (error) { throw destinationGitError(args, error, job.destination.repository); }
  });
  const origin = await run(['remote', 'get-url', 'origin']);
  const repository = githubRepository(origin);
  if (!sameRepository(repository, githubRepository(`https://github.com/${job.destination.repository}`))) throw new DestinationError('destination_origin_mismatch', 'Origin no coincide con el repositorio GitHub confirmado. Revisa el proyecto.', { expected: job.destination.repository, observed: repository });
  const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch !== job.branch) throw new DestinationError('destination_branch_changed', 'Rama cambiada o HEAD separado; restaura manualmente el checkout confirmado.', { expected: job.branch, observed: branch });
  const sha = await run(['rev-parse', '--verify', 'HEAD']);
  if (job.autoIntent?.eligible === true && requireClean) {
    const dirty = await run(['status', '--porcelain']);
    if (dirty) throw new DestinationError('destination_dirty', 'Checkout no estaba limpio al admitir el job; se requiere revisión antes de ejecutar.', { status: excerpt(dirty, 300) });
  }
  const remote = await run(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${job.branch}`]);
  const lines = remote.split(/\r?\n/).filter(Boolean);
  const [remoteSha, ref] = (lines[0] || '').split(/\s+/);
  if (lines.length !== 1 || ref !== `refs/heads/${job.branch}` || !/^[a-f0-9]{40,64}$/i.test(sha) || remoteSha !== sha) throw new DestinationError('destination_remote_mismatch', 'Rama remota ausente o SHA local/remoto distinto; sincroniza y revisa manualmente el checkout.', { branch: job.branch, localSha: sha, remoteSha: remoteSha ?? null });
  const baseBranch = job.destination?.baseBranch || null;
  let baseSha = null;
  if (job.autoIntent?.eligible === true) {
    if (!baseBranch || baseBranch.includes('..') || /[\\\x00\r\n]/.test(baseBranch) || baseBranch.startsWith('-')) throw new DestinationError('destination_base_unconfigured', 'Rama base no configurada; la integración automática queda bloqueada.');
    const baseRemote = await run(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${baseBranch}`]);
    const baseRows = baseRemote.split(/\r?\n/).filter(Boolean);
    const [candidate, baseRef] = (baseRows[0] || '').split(/\s+/);
    if (baseRows.length !== 1 || baseRef !== `refs/heads/${baseBranch}` || !/^[a-f0-9]{40,64}$/i.test(candidate)) throw new DestinationError('destination_base_missing', 'Rama base ausente o no verificable en origin.', { baseBranch });
    baseSha = candidate;
  }
  return { ...observed, repository, origin, sha, remoteSha, ...(baseBranch ? { baseBranch } : {}), ...(baseSha ? { baseSha } : {}), verified: true, checkedAt: new Date().toISOString() };
}
