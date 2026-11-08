import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { githubRepository } from './project-destination.mjs';

const sha = value => /^[a-f0-9]{40,64}$/i.test(String(value || ''));
const branchOk = value => typeof value === 'string' && value.length > 0 && !value.includes('..') && !/[\\\x00\r\n]/.test(value) && !value.startsWith('-');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
function addField(hash, value) {
  const data = bytes(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(length).update(data);
}

// `git` and `gh` are injected command adapters. Tests use deterministic fakes;
// production calls are only reached from the explicitly eligible auto-run path.
export async function integrateGitHub(job, ctx, { git, gh, persist = async () => {}, previous = null, now = () => new Date().toISOString() } = {}) {
  const intent = job.autoIntent;
  if (!intent || intent.eligible !== true || !intent.receiptId || job.state === 'cancelled') return { status: 'skipped', reason: 'not_eligible' };
  const dest = job.destination || {};
  const root = path.resolve(ctx.root), workspace = path.resolve(job.workspace || '');
  if (!path.isAbsolute(job.workspace || '') || !workspace.startsWith(`${root}${path.sep}workspaces${path.sep}`)) throw new Error('Checkout absoluto fuera de workspaces; integración bloqueada.');
  if (await fs.realpath(workspace) !== workspace || await fs.realpath(root) !== root) throw new Error('Checkout/root no canónico; integración bloqueada.');
  if (!dest.repository || !branchOk(job.branch) || !branchOk(dest.baseBranch)) throw new Error('Configura repositorio y ramas fuente/base existentes antes de integrar.');
  if (!git || !gh) throw new Error('Adaptadores de GitHub no configurados; necesita revisión.');
  if (previous?.phase === 'complete') return previous;
  if (previous?.status === 'needs_attention' && !['commit_confirmed', 'push_intent', 'push_confirmed', 'pr_intent', 'pr_confirmed', 'checks_pending', 'merge_intent'].includes(previous.phase)) throw new Error('Integración previa requiere revisión manual; no se repetirá a ciegas.');
  const unresolvedMergeIntent = previous?.phase === 'merge_intent';
  const record = { ...previous, jobId: job.id, receiptId: intent.receiptId, repository: dest.repository, sourceBranch: job.branch, baseBranch: dest.baseBranch, status: 'preflight', attempts: previous?.attempts || 0, updatedAt: now() };
  const save = async (phase, extra = {}) => {
    Object.assign(record, extra, { phase, status: phase === 'complete' ? 'completed' : phase === 'needs_attention' || phase === 'checks_pending' ? phase : 'running', needsAttention: false, updatedAt: now() });
    await persist(structuredClone(record));
    const labels = { preflight_complete: 'Preflight aprobado; commit local preparado.', commit_intent: 'Commit local solicitado.', commit_confirmed: 'Commit local confirmado.', push_intent: 'Push solicitado; confirmación pendiente.', push_confirmed: 'Push remoto confirmado.', pr_intent: 'Creación de PR solicitada.', pr_confirmed: 'PR confirmada; checks pendientes.', checks_pending: 'PR/checks pendientes o bloqueados.', merge_intent: 'Merge solicitado; confirmación pendiente.', complete: 'Integración remota confirmada.', needs_attention: 'Necesita revisión manual.' };
    const summary = [labels[phase] || phase, extra.commitSha ? `SHA ${extra.commitSha}` : '', extra.prUrl || '', extra.mergeSha ? `Merge ${extra.mergeSha}` : '', extra.error || ''].filter(Boolean).join(' · ');
    await ctx.reportStage?.({ key: 'integration', status: phase === 'needs_attention' ? 'blocked' : phase === 'complete' || phase === 'skipped' ? 'succeeded' : 'running', summary, ...extra });
  };
  const g = args => git(args, workspace), h = args => gh(args, workspace);
  const repo = githubRepository(`https://github.com/${dest.repository}`);
  const origin = githubRepository(await g(['remote', 'get-url', 'origin']));
  if (repo.toLowerCase() !== origin.toLowerCase()) throw new Error('Origin GitHub y mapping confirmado no coinciden.');
  const branch = (await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (branch !== job.branch) throw new Error('Branch activa no coincide con la fuente confirmada.');
  if ((await g(['check-ref-format', '--branch', job.branch])).trim() !== job.branch || (await g(['check-ref-format', '--branch', dest.baseBranch])).trim() !== dest.baseBranch) throw new Error('Rama fuente/base inválida.');
  const ghUser = (await h(['api', 'user', '--jq', '.login'])).trim().toLowerCase();
  if (ghUser !== repo.split('/')[0].toLowerCase()) throw new Error('La cuenta gh activa no coincide con el propietario del repositorio.');
  if (previous?.phase === 'merge_intent' && previous.prNumber) {
    const state = JSON.parse(await h(['pr', 'view', String(previous.prNumber), '--repo', repo, '--json', 'state,mergedAt,mergeCommit']));
    if (state.state === 'MERGED' && state.mergedAt && sha(state.mergeCommit?.oid)) {
      await save('complete', { prNumber: previous.prNumber, prUrl: previous.prUrl, commitSha: previous.commitSha, mergeSha: state.mergeCommit.oid, mergedAt: state.mergedAt, reconciled: true });
      return record;
    }
  }
  if (!(await g(['config', 'user.name'])).trim() || !(await g(['config', 'user.email'])).trim()) throw new Error('Falta identidad Git configurada.');
    const status = await g(['status', '--porcelain=v1', '-z']);
  const approvedSnapshot = job.integrationSnapshot;
  const baselineHead = (await g(['rev-parse', 'HEAD'])).trim();
  if (!sha(baselineHead)) throw new Error('HEAD no válido.');
  if (previous?.commitSha && baselineHead === previous.commitSha && bytes(status).length === 0) {
    // A previously approved commit is already durable; compare its recorded SHA.
  } else {
    const currentSnapshot = diffFingerprint(status, await g(['diff', '--binary', 'HEAD']), await g(['diff', '--cached', '--binary']), await untrackedFingerprint(workspace, g));
    if (!approvedSnapshot || currentSnapshot !== approvedSnapshot) throw new Error('El diff actual no coincide con la revisión aprobada.');
  }
  const base = (await g(['ls-remote', '--exit-code', '--heads', 'origin', dest.baseBranch])).trim().split(/\s+/)[0];
  const remoteHead = (await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).trim().split(/\s+/)[0];
  const reconciledPush = Boolean(previous?.commitSha && remoteHead === previous.commitSha);
  const reconciledBase = Boolean(previous?.commitSha && job.branch === dest.baseBranch && base === previous.commitSha);
  if (!sha(base) || !sha(remoteHead) || (remoteHead !== job.destination?.remoteSha && !reconciledPush) || (base !== job.destination?.baseSha && !reconciledBase)) throw new Error('Baseline remoto divergente o desactualizado.');
  const behind = (await g(['rev-list', '--count', `HEAD..${remoteHead}`])).trim();
  if (behind !== '0') throw new Error('La rama remota diverge del checkout; sincroniza y revisa manualmente.');
  const existing = await h(['pr', 'list', '--repo', repo, '--head', `${repo.split('/')[0]}:${job.branch}`, '--base', dest.baseBranch, '--state', 'open', '--json', 'number,url,headRefOid,baseRefOid']);
  const prs = JSON.parse(existing || '[]');
  if (job.branch !== dest.baseBranch && prs.length > 1) throw new Error('Más de una PR abierta para head/base; requiere revisión.');
  if (job.branch === dest.baseBranch && base !== remoteHead) throw new Error('Rama fuente/base no sincronizada para push directo.');
  record.attempts = (record.attempts || 0) + 1;
  const originalBaseline = previous?.baseline || baselineHead;
  await save('preflight_complete', { baseline: originalBaseline, remoteBaseSha: base, remoteSourceSha: remoteHead, manifest: approvedSnapshot });
  let head = baselineHead;
  if (previous?.commitSha) {
    if (baselineHead !== previous.commitSha || status) throw new Error('El commit previamente registrado no coincide con el checkout; necesita revisión.');
    head = previous.commitSha;
  } else if (previous?.phase === 'commit_intent') {
    const candidate = (await g(['rev-parse', 'HEAD'])).trim();
    if (candidate === previous.baseline || status) throw new Error('Commit previo ambiguo; revisa el checkout antes de continuar.');
    head = candidate;
    await save('commit_confirmed', { baseline: previous.baseline, commitSha: head, manifest: approvedSnapshot });
  } else {
    await save('commit_intent', { baseline: originalBaseline, manifest: approvedSnapshot });
    await g(['add', '--all']);
    await g(['commit', '-m', `Integrate ${job.id}: ${job.title.slice(0, 72)}`]);
    head = (await g(['rev-parse', 'HEAD'])).trim();
    if (!sha(head) || head === baselineHead) throw new Error('Git no confirmó el commit local; requiere revisión.');
    await save('commit_confirmed', { baseline: originalBaseline, commitSha: head, manifest: approvedSnapshot });
  }
  if (job.branch === dest.baseBranch) {
    if (previous?.phase === 'push_intent' || previous?.phase === 'commit_confirmed') {
      const observed = (await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).trim().split(/\s+/)[0];
      if (previous?.phase === 'push_intent' && observed === previous.commitSha) { await save('complete', { commitSha: observed, pushedAt: previous.pushedAt || now(), mergeSha: observed, reconciled: true }); return record; }
    }
    await save('push_intent', { commitSha: head });
    await g(['push', '--porcelain', 'origin', `HEAD:refs/heads/${job.branch}`]);
    const confirmed = (await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).trim().split(/\s+/)[0];
    if (confirmed !== head) throw new Error('Push ambiguo: remoto no confirma el SHA; necesita revisión.');
    await save('complete', { commitSha: head, pushedAt: now(), mergeSha: head });
    return record;
  }
  if (remoteHead !== head) {
    if (previous?.phase === 'push_intent') throw new Error('Push previo ambiguo y no confirmado; revisión manual necesaria.');
    await save('push_intent', { commitSha: head });
    await g(['push', '--porcelain', 'origin', `HEAD:refs/heads/${job.branch}`]);
  }
  const pushed = (await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).trim().split(/\s+/)[0];
  if (pushed !== head) throw new Error('Push ambiguo: remoto no confirma el SHA; necesita revisión.');
  await save('push_confirmed', { commitSha: head, pushedAt: now() });
  const refreshedPrs = JSON.parse((await h(['pr', 'list', '--repo', repo, '--head', `${repo.split('/')[0]}:${job.branch}`, '--base', dest.baseBranch, '--state', 'open', '--json', 'number,url,headRefOid,baseRefOid'])) || '[]');
  let pr = refreshedPrs[0] || prs[0];
  if (!pr && previous?.phase === 'pr_intent') throw new Error('Creación de PR ambigua; no hay PR observable. Revisión manual necesaria antes de repetir.');
  if (!pr) {
    await save('pr_intent', { commitSha: head });
    await h(['pr', 'create', '--repo', repo, '--head', `${repo.split('/')[0]}:${job.branch}`, '--base', dest.baseBranch, '--title', job.title.slice(0, 120), '--body', `Integración automática del job ${job.id} (recibo ${intent.receiptId}).`]);
    const found = await h(['pr', 'list', '--repo', repo, '--head', `${repo.split('/')[0]}:${job.branch}`, '--base', dest.baseBranch, '--state', 'open', '--json', 'number,url,headRefOid,baseRefOid']);
    pr = JSON.parse(found || '[]')[0];
    if (!pr) throw new Error('PR no confirmada tras crearla; necesita revisión.');
  }
  if (pr.headRefOid !== head) throw new Error('La PR abierta apunta a un commit diferente del aprobado.');
  await save('pr_confirmed', { prNumber: pr.number, prUrl: pr.url, commitSha: head });
  const checkReadiness = async () => {
    const detail = JSON.parse(await h(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergeable,statusCheckRollup,headRefOid,baseRefOid']));
    const checks = detail.statusCheckRollup;
    const ready = detail.state === 'OPEN' && detail.headRefOid === head && detail.mergeable === 'MERGEABLE'
      && Array.isArray(checks) && checks.length > 0
      && checks.every(check => check?.conclusion === 'SUCCESS');
    return { ready, detail };
  };
  const initialChecks = await checkReadiness();
  if (!initialChecks.ready) {
    await save('checks_pending', { prNumber: pr.number, prUrl: pr.url });
    throw new Error('PR pendiente de checks, conflicto o revisión; necesita atención.');
  }
  if (unresolvedMergeIntent) throw new Error('Merge previo ambiguo y la PR sigue abierta; confirma el estado en GitHub antes de cualquier nueva acción.');
  if (previous?.phase === 'merge_intent') {
    const state = JSON.parse(await h(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt,mergeCommit']));
    if (state.state === 'MERGED' && sha(state.mergeCommit?.oid)) { await save('complete', { prNumber: pr.number, prUrl: pr.url, commitSha: head, mergeSha: state.mergeCommit.oid, mergedAt: state.mergedAt, reconciled: true }); return record; }
  }
  // Re-read immediately before the mutation so a newly pending/failed check cannot race the merge.
  const finalChecks = await checkReadiness();
  if (!finalChecks.ready) {
    await save('checks_pending', { prNumber: pr.number, prUrl: pr.url });
    throw new Error('PR pendiente de checks, conflicto o revisión; necesita atención.');
  }
  await save('merge_intent', { prNumber: pr.number, prUrl: pr.url });
  await h(['pr', 'merge', String(pr.number), '--repo', repo, '--merge', '--match-head-commit', head]);
  const merged = JSON.parse(await h(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergedAt,mergeCommit']));
  const mergeSha = merged.mergeCommit?.oid;
  if (merged.state !== 'MERGED' || !merged.mergedAt || !sha(mergeSha)) throw new Error('Merge remoto no confirmado; necesita revisión.');
  await save('complete', { prNumber: pr.number, prUrl: pr.url, commitSha: head, mergeSha, mergedAt: merged.mergedAt });
  return record;
}

export function diffFingerprint(status, unstaged, staged, untracked = Buffer.alloc(0)) {
  const hash = createHash('sha256');
  addField(hash, 'integration-snapshot-v2');
  addField(hash, status);
  addField(hash, unstaged);
  addField(hash, staged);
  addField(hash, untracked);
  return hash.digest('hex');
}

const exec = promisify(execFile);
function safeEnv() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*|SSH.*|ASKPASS)$/i.test(key)) delete env[key];
  return env;
}
async function untrackedFingerprint(workspace, run) {
  const listing = bytes(await run(['ls-files', '--others', '--exclude-standard', '-z']));
  const files = [];
  let start = 0;
  for (let index = 0; index < listing.length; index++) {
    if (listing[index] === 0) {
      if (index > start) files.push(listing.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < listing.length) files.push(listing.subarray(start));
  files.sort(Buffer.compare);
  if (files.length === 0) return Buffer.alloc(0);
  const root = await fs.realpath(path.resolve(workspace));
  const hash = createHash('sha256');
  addField(hash, 'untracked-v2');
  addField(hash, String(files.length));
  for (const relativeBytes of files) {
    const relative = relativeBytes.toString('utf8');
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid untracked path.');
    const full = path.resolve(workspace, relative);
    if (!full.startsWith(`${path.resolve(workspace)}${path.sep}`)) throw new Error('Invalid untracked path.');
    const actual = await fs.realpath(full);
    const inside = path.relative(root, actual);
    if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error('Untracked path escapes checkout.');
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Untracked file is linked or non-regular.');
    addField(hash, relativeBytes);
    addField(hash, await fs.readFile(full));
  }
  return hash.digest();
}
export async function captureIntegrationSnapshot(workspace) {
  const run = async args => (await exec('git', args, { cwd: workspace, env: safeEnv(), encoding: null, windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 2_000_000 })).stdout;
  return diffFingerprint(await run(['status', '--porcelain=v1', '-z']), await run(['diff', '--binary', 'HEAD']), await run(['diff', '--cached', '--binary']), await untrackedFingerprint(workspace, run));
}export async function integrateGitHubDefault(job, ctx, options = {}) {
  const invoke = async (exe, args, cwd) => {
    try { return (await exec(exe, args, { cwd, env: safeEnv(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 1_000_000 })).stdout.trim(); }
    catch { throw new Error(`${exe} falló o la respuesta fue ambigua; consulta el estado remoto antes de continuar.`); }
  };
  return integrateGitHub(job, ctx, { git: (args, cwd) => invoke('git', args, cwd), gh: (args, cwd) => invoke('gh', args, cwd), ...options });
}
