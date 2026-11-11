import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

// Execution claim: one PC at a time works on a project branch.
// Each installation has its own queue, so the thing two PCs can really collide on is the shared repository:
// two jobs editing and integrating the same branch at once. The claim lives where both PCs already meet —
// the project's remote — as a ref refs/centro/claims/<branch> pointing at a small commit whose message says
// who holds it, for which job and until when.
// Every change is a compare-and-swap done by the Git server (push --force-with-lease with the exact
// expected value), so two PCs asking at the same moment cannot both win.
//   take      the ref must not exist
//   renew     the ref must still be my commit
//   take over the ref must still be the expired commit I read
//   release   the ref must still be my commit
// Offline, nothing can be claimed: the job waits. A claim that is not renewed expires and can be taken over.
export const CLAIM_NAMESPACE = 'refs/centro/claims/';
const GIT_TIMEOUT_MS = 20_000;
const IDENTITY = { GIT_AUTHOR_NAME: 'Centro de Operaciones', GIT_AUTHOR_EMAIL: 'centro@localhost', GIT_COMMITTER_NAME: 'Centro de Operaciones', GIT_COMMITTER_EMAIL: 'centro@localhost' };

export class ClaimError extends Error {
  constructor(message, code = 'claim_unavailable') { super(message); this.code = code; }
}

export function claimRef(branch) {
  const slug = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'rama';
  return `${CLAIM_NAMESPACE}${slug}-${createHash('sha256').update(String(branch)).digest('hex').slice(0, 8)}`;
}

function git(cwd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout).trim()));
    if (input !== undefined) child.stdin.end(input);
  });
}

// What the remote holds now: null, or { sha, claim }. A ref that is not one of ours is reported, never overwritten.
export async function readClaim(workspace, remote, ref, run = git) {
  let listed;
  try { listed = await run(workspace, ['ls-remote', remote, ref]); }
  catch (error) { throw new ClaimError(`No se pudo consultar ${remote} para la reserva: sin conexión o sin acceso.`, 'claim_offline'); }
  const sha = listed.split(/\s+/)[0];
  if (!/^[a-f0-9]{40,64}$/.test(sha ?? '')) return null;
  try {
    await run(workspace, ['fetch', '--quiet', '--no-tags', remote, ref]);
    const body = await run(workspace, ['cat-file', 'commit', sha]);
    const claim = JSON.parse(body.slice(body.indexOf('\n\n') + 2));
    if (!claim || typeof claim.team !== 'string' || typeof claim.jobId !== 'string' || !Number.isFinite(Date.parse(claim.expiresAt))) throw new Error('shape');
    return { sha, claim };
  } catch (error) { if (error instanceof ClaimError) throw error; throw new ClaimError(`${ref} existe en ${remote} pero no es una reserva del Centro legible. No se sobrescribe.`, 'claim_unreadable'); }
}

async function writeCommit(workspace, claim, run) {
  const tree = await run(workspace, ['mktree'], { input: '' });
  return run(workspace, ['commit-tree', tree, '-m', JSON.stringify(claim)]);
}
// expected: '' = the ref must not exist; a sha = the ref must still be exactly that commit.
async function swap(workspace, remote, ref, expected, next, run) {
  try { await run(workspace, ['push', '--quiet', `--force-with-lease=${ref}:${expected}`, remote, `${next ?? ''}:${ref}`]); return true; }
  catch (error) {
    if (/stale info|rejected|already exists|non-fast-forward|failed to push some refs/i.test(error.stderr ?? '')) return false;
    throw new ClaimError(`No se pudo escribir la reserva en ${remote}: sin conexión o sin permiso de escritura.`, 'claim_offline');
  }
}

// Takes, renews or takes over the claim for one job. Returns { held: true, expiresAt } or { held: false, by, expiresAt }.
export async function acquireClaim({ workspace, remote = 'origin', branch, team, jobId, ttlMs, now = Date.now(), run = git }) {
  const ref = claimRef(branch);
  const current = await readClaim(workspace, remote, ref, run);
  const mine = current?.claim.team === team && current.claim.jobId === jobId;
  const expired = current && Date.parse(current.claim.expiresAt) <= now;
  if (current && !mine && !expired) return { held: false, ref, by: current.claim.team, jobId: current.claim.jobId, expiresAt: current.claim.expiresAt };
  const claim = { version: 1, team, jobId, branch, takenAt: mine ? current.claim.takenAt : new Date(now).toISOString(), renewedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    ...(current && !mine ? { tookOverFrom: { team: current.claim.team, jobId: current.claim.jobId, expiredAt: current.claim.expiresAt } } : {}) };
  const sha = await writeCommit(workspace, claim, run);
  if (await swap(workspace, remote, ref, current ? current.sha : '', sha, run)) return { held: true, ref, sha, expiresAt: claim.expiresAt, ...(claim.tookOverFrom ? { tookOverFrom: claim.tookOverFrom } : {}) };
  // Someone else changed the ref between our read and our write: they won.
  const winner = await readClaim(workspace, remote, ref, run);
  return { held: false, ref, by: winner?.claim.team ?? 'otro equipo', jobId: winner?.claim.jobId ?? null, expiresAt: winner?.claim.expiresAt ?? null };
}

// Gives the branch back. Only removes the claim if it is still ours; someone else's (after a takeover) is left alone.
export async function releaseClaim({ workspace, remote = 'origin', branch, team, jobId, run = git }) {
  const ref = claimRef(branch);
  const current = await readClaim(workspace, remote, ref, run);
  if (!current || current.claim.team !== team || current.claim.jobId !== jobId) return { released: false };
  return { released: await swap(workspace, remote, ref, current.sha, null, run) };
}
