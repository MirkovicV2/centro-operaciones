// Recreates the GitHub repository of an already registered project from its local checkout.
// Deterministic on purpose: `gh repo create` and two pushes need no model. It publishes to GitHub, so the caller
// must carry the person's explicit confirmation, and it only runs when the destination check says the repository is gone.
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { DestinationError, githubRepository, verifyGitHubDestination } from './project-destination.mjs';
import { excerpt } from './redaction.mjs';

const BRANCH = /^(?![-/.])[A-Za-z0-9._/-]{1,200}$/;
const run = promisify(execFile);
const execute = (file, args, cwd) => run(file, args, { cwd, encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 256_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' } });

export async function destinationCheck(root, project, { verify = verifyGitHubDestination } = {}) {
  if (!project?.checkout || !project.branch || !project.repository) return { ok: false, code: 'destination_unconfigured', reason: 'El proyecto no tiene repositorio, checkout y rama configurados.' };
  const job = { workspace: path.resolve(root, project.checkout), branch: project.branch, destination: { repository: project.repository, baseBranch: project.baseBranch || null } };
  try {
    const observed = await verify(root, job, { requireClean: false });
    return { ok: true, repository: observed.repository, branch: observed.branch, sha: observed.sha };
  } catch (error) {
    if (!(error instanceof DestinationError)) return { ok: null, code: 'destination_check_unavailable', reason: 'No se pudo comprobar el destino desde el panel.' };
    return { ok: false, code: error.code, reason: error.message, ...(error.details ? { details: error.details } : {}) };
  }
}

export async function createMissingRemote(root, project, { confirm = false, check = destinationCheck, exec = execute } = {}) {
  if (!confirm) throw Object.assign(new Error('Confirma que quieres crear el repositorio en GitHub y subir las ramas.'), { status: 400 });
  const before = await check(root, project);
  if (before.code !== 'destination_repository_missing') throw Object.assign(new Error(before.ok ? 'El repositorio ya existe; no hay nada que crear.' : `Solo se crea un repositorio que no existe. Estado actual: ${before.reason}`), { status: 409 });
  const repository = githubRepository(`https://github.com/${project.repository}`);
  const { branch, baseBranch } = project;
  if (!BRANCH.test(branch || '') || !BRANCH.test(baseBranch || '') || branch.includes('..') || baseBranch.includes('..')) throw Object.assign(new Error('Configura rama de trabajo y rama base válidas antes de crear el repositorio.'), { status: 400 });
  const workspace = path.resolve(root, project.checkout);
  const step = async (label, file, args) => {
    try { await exec(file, args, workspace); }
    catch (error) { throw Object.assign(new Error(`${label} falló. ${excerpt(String(error?.stderr || error?.message || ''), 300)}`.trim()), { status: 502, code: 'remote_create_failed' }); }
  };
  await step('Crear el repositorio', 'gh', ['repo', 'create', repository, '--private']);
  // The local base goes up as it is, even if stale: pushing the work branch as the base would publish unreviewed commits
  // as if they had been merged. Only a checkout without a local base uses the work branch for both.
  let hasBase = true;
  try { await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`], workspace); } catch { hasBase = false; }
  await step('Subir la rama base', 'git', ['push', 'origin', `refs/heads/${hasBase ? baseBranch : branch}:refs/heads/${baseBranch}`]);
  if (branch !== baseBranch) await step('Subir la rama de trabajo', 'git', ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  return { repository, visibility: 'private', pushed: [...new Set([baseBranch, branch])], baseFrom: hasBase ? baseBranch : branch, after: await check(root, project) };
}
