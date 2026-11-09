import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { inspectDestination } from './project-destination.mjs';

// Read-only observation of the already confirmed independent checkout. Never fetches,
// changes a branch, creates Git metadata, or treats a manifest boolean as evidence.
export async function verifyReconciliationDestination(root, job, destination, {
  inspect = inspectDestination,
  git = (args, options) => spawnSync('git', args, options),
} = {}) {
  if (!job?.workspace || destination?.checkout !== job.destination?.checkout) throw new Error('El checkout no corresponde al job confirmado.');
  const observed = await inspect(root, destination.checkout, destination.branch);
  if (path.normalize(observed.workspace) !== path.normalize(path.resolve(job.workspace))) throw new Error('La ruta canónica no coincide con el checkout del job.');
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  }
  const result = git(['rev-parse', '--verify', 'HEAD'], {
    cwd: observed.workspace, encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000, env,
  });
  const sha = result.stdout?.trim();
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}$/i.test(sha ?? '')
    || !/^[a-f0-9]{7,40}$/i.test(destination.sha ?? '') || !sha.toLowerCase().startsWith(destination.sha.toLowerCase())) {
    throw new Error('El commit observado no coincide con el manifiesto de reconciliación.');
  }
  return { checkout: observed.checkout, workspace: observed.workspace, branch: observed.branch, sha: sha.toLowerCase(), verified: true };
}
