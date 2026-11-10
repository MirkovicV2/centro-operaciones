import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { githubRepository, sameRepository } from './project-destination.mjs';
import { excerpt } from './redaction.mjs';

const sha = value => /^[a-f0-9]{40,64}$/i.test(String(value || ''));
const branchOk = value => typeof value === 'string' && value.length > 0 && !value.includes('..') && !/[\\\x00\r\n]/.test(value) && !value.startsWith('-');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
export const pullRequestIdentityFields = 'number,url,state,headRefOid,baseRefOid,headRefName,baseRefName,isCrossRepository,headRepository,headRepositoryOwner';
export function sameRepositoryPullRequest(pr, repository, sourceBranch, baseBranch) {
  const [owner, name] = repository.split('/');
  return Number.isSafeInteger(pr?.number) && pr.number > 0 && pr.isCrossRepository === false
    && pr.headRepositoryOwner?.login?.toLowerCase() === owner.toLowerCase()
    && pr.headRepository?.name?.toLowerCase() === name.toLowerCase()
    && (!pr.headRepository.nameWithOwner || pr.headRepository.nameWithOwner.toLowerCase() === repository.toLowerCase())
    && pr.headRefName === sourceBranch && pr.baseRefName === baseBranch
    && typeof pr.url === 'string' && pr.url.toLowerCase() === `https://github.com/${repository}/pull/${pr.number}`.toLowerCase();
}
export function sameRepositoryPullRequests(prs, repository, sourceBranch, baseBranch) {
  if (!Array.isArray(prs) || prs.length >= 100 || prs.some(pr => typeof pr?.isCrossRepository !== 'boolean' || !pr.headRepositoryOwner?.login
    || !pr.headRepository?.name || typeof pr.headRefName !== 'string' || typeof pr.baseRefName !== 'string')) {
    throw new Error('GitHub no acreditó el repositorio y las ramas de las PR consultadas.');
  }
  return prs.filter(pr => sameRepositoryPullRequest(pr, repository, sourceBranch, baseBranch));
}
function addField(hash, value) {
  const data = bytes(value);
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(length).update(data);
}

// `git` and `gh` are injected command adapters. Tests use deterministic fakes;
// production calls are only reached from the explicitly eligible auto-run path.
// 17: a bounded default wait for checks (15 min, the maximum the validation below
// allows) instead of an unbounded one, and an actionable no_checks state when the
// PR never registers any check.
export const DEFAULT_CHECKS_TIMEOUT_MS = 900_000;
// Checks can register minutes after the push; only a PR still without any check after
// this grace is reported as no_checks (before the generic timeout, with a clearer action).
export const DEFAULT_NO_CHECKS_GRACE_MS = 600_000;
export async function integrateGitHub(job, ctx, { git, gh, persist = async () => {}, previous = null, now = () => new Date().toISOString(),
  clock = () => Date.now(), wait = (ms, signal) => delay(ms, undefined, { signal }), checksTimeoutMs = DEFAULT_CHECKS_TIMEOUT_MS, checksIntervalMs = 15_000, noChecksGraceMs = DEFAULT_NO_CHECKS_GRACE_MS } = {}) {
  const intent = job.autoIntent;
  if (!intent || intent.eligible !== true || !intent.receiptId || job.state === 'cancelled') return { status: 'skipped', reason: 'not_eligible' };
  const dest = job.destination || {};
  const root = path.resolve(ctx.root), workspace = path.resolve(job.workspace || '');
  if (!path.isAbsolute(job.workspace || '') || !workspace.startsWith(`${root}${path.sep}workspaces${path.sep}`)) throw new Error('Checkout absoluto fuera de workspaces; integración bloqueada.');
  if (await fs.realpath(workspace) !== workspace || await fs.realpath(root) !== root) throw new Error('Checkout/root no canónico; integración bloqueada.');
  if (!dest.repository || !branchOk(job.branch) || !branchOk(dest.baseBranch)) throw new Error('Configura repositorio y ramas fuente/base existentes antes de integrar.');
  if (!git || !gh) throw new Error('Adaptadores de GitHub no configurados; necesita revisión.');
  if (checksTimeoutMs !== null && (!Number.isFinite(checksTimeoutMs) || checksTimeoutMs < 0 || checksTimeoutMs > 900_000)
    || !Number.isFinite(checksIntervalMs) || checksIntervalMs < 1 || checksIntervalMs > 30_000
    || noChecksGraceMs !== null && (!Number.isFinite(noChecksGraceMs) || noChecksGraceMs < 0)) throw new Error('Límites de espera de checks inválidos.');
  if (previous && (['jobId', 'receiptId', 'sourceBranch', 'baseBranch'].some(key => previous[key] !== ({ jobId: job.id, receiptId: intent.receiptId, sourceBranch: job.branch, baseBranch: dest.baseBranch })[key])
    || !sameRepository(previous.repository, dest.repository))) throw new Error('El registro de integración pertenece a otro encargo o destino.');
  if (previous?.commitSha && (!/^[a-f0-9]{64}$/i.test(previous.manifest || '') || previous.manifest !== job.integrationSnapshot)) throw new Error('Falta el manifest original del commit aprobado; no se sustituye por otro snapshot.');
  if (previous?.phase === 'complete') return previous;
  if (previous?.status === 'needs_attention' && !['commit_confirmed', 'push_intent', 'push_confirmed', 'pr_intent', 'pr_confirmed', 'checks_pending', 'merge_intent'].includes(previous.phase)) throw new Error('Integración previa requiere revisión manual; no se repetirá a ciegas.');
  const record = { ...previous, jobId: job.id, receiptId: intent.receiptId, repository: dest.repository, sourceBranch: job.branch, baseBranch: dest.baseBranch, status: 'preflight', attempts: previous?.attempts || 0, updatedAt: now() };
  const save = async (phase, extra = {}) => {
    Object.assign(record, extra, { phase, status: phase === 'complete' ? 'completed' : phase === 'needs_attention' || phase === 'checks_pending' ? phase : 'running', needsAttention: false, error: extra.error ?? null, updatedAt: now() });
    await persist(structuredClone(record));
    const labels = { preflight_complete: 'Preflight aprobado; commit local preparado.', commit_intent: 'Commit local solicitado.', commit_confirmed: 'Commit local confirmado.', push_intent: 'Push solicitado; confirmación pendiente.', push_confirmed: 'Push remoto confirmado.', pr_intent: 'Creación de PR solicitada.', pr_confirmed: 'PR confirmada; checks pendientes.', checks_pending: 'Esperando comprobaciones de GitHub sobre la PR existente.', merge_intent: 'Merge solicitado; confirmación pendiente.', complete: 'Integración remota confirmada.', needs_attention: 'Necesita revisión manual.' };
    const summary = [labels[phase] || phase, extra.commitSha ? `SHA ${extra.commitSha}` : '', extra.prUrl || '', extra.mergeSha ? `Merge ${extra.mergeSha}` : '', extra.error || ''].filter(Boolean).join(' · ');
    await ctx.reportStage?.({ key: 'integration', status: phase === 'needs_attention' ? 'blocked' : phase === 'complete' || phase === 'skipped' ? 'succeeded' : 'running', summary, ...extra });
  };
  const checkAbort = () => ctx.signal?.throwIfAborted();
  const g = args => { checkAbort(); return git(args, workspace); }, h = args => { checkAbort(); return gh(args, workspace); };
  const repo = githubRepository(`https://github.com/${dest.repository}`);
  const origin = githubRepository(await g(['remote', 'get-url', 'origin']));
  if (!sameRepository(repo, origin)) throw new Error('Origin GitHub y mapping confirmado no coinciden.');
  const branch = (await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (branch !== job.branch) throw new Error('Branch activa no coincide con la fuente confirmada.');
  if ((await g(['check-ref-format', '--branch', job.branch])).trim() !== job.branch || (await g(['check-ref-format', '--branch', dest.baseBranch])).trim() !== dest.baseBranch) throw new Error('Rama fuente/base inválida.');
  const ghUser = (await h(['api', 'user', '--jq', '.login'])).trim().toLowerCase();
  if (ghUser !== repo.split('/')[0].toLowerCase()) throw new Error('La cuenta gh activa no coincide con el propietario del repositorio.');
  if (previous?.phase === 'merge_intent' && previous.prNumber) {
    const state = JSON.parse(await h(['pr', 'view', String(previous.prNumber), '--repo', repo, '--json', pullRequestIdentityFields + ',mergedAt,mergeCommit']));
    if (!sameRepositoryPullRequest(state, repo, job.branch, dest.baseBranch) || state.number !== previous.prNumber || state.headRefOid !== previous.commitSha) throw new Error('La PR del merge pendiente no coincide con la identidad y commit registrados.');
    if (state.state === 'MERGED' && state.mergedAt && sha(state.mergeCommit?.oid)) {
      await save('complete', { prNumber: previous.prNumber, prUrl: previous.prUrl, commitSha: previous.commitSha, mergeSha: state.mergeCommit.oid, mergedAt: state.mergedAt, reconciled: true });
      return record;
    }
    // Never rewind an unresolved mutation into pr_confirmed: a later replay
    // must still see the original merge intent and must not repeat the effect.
    throw new Error('Merge previo ambiguo y no confirmado; consulta la misma PR antes de cualquier nueva acción.');
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
  const existing = await h(['pr', 'list', '--repo', repo, '--head', job.branch, '--base', dest.baseBranch, '--state', 'open', '--limit', '100', '--json', pullRequestIdentityFields]);
  const prs = sameRepositoryPullRequests(JSON.parse(existing || '[]'), repo, job.branch, dest.baseBranch);
  if (job.branch !== dest.baseBranch && prs.length > 1) throw new Error('Más de una PR abierta para head/base; requiere revisión.');
  if (job.branch === dest.baseBranch && base !== remoteHead) throw new Error('Rama fuente/base no sincronizada para push directo.');
  if (previous?.phase === 'push_intent' && remoteHead !== previous.commitSha) throw new Error('Push previo ambiguo y no confirmado; revisión manual necesaria.');
  if (previous?.phase === 'pr_intent' && !prs.length) throw new Error('Creación de PR ambigua; no hay PR observable. Revisión manual necesaria antes de repetir.');
  record.attempts = (record.attempts || 0) + 1;
  const originalBaseline = previous?.baseline || baselineHead;
  await save('preflight_complete', { baseline: originalBaseline, remoteBaseSha: base, remoteSourceSha: remoteHead, manifest: previous?.manifest || approvedSnapshot });
  let head = baselineHead;
  if (previous?.commitSha) {
    if (baselineHead !== previous.commitSha || bytes(status).length !== 0) throw new Error('El commit previamente registrado no coincide con el checkout; necesita revisión.');
    head = previous.commitSha;
  } else if (previous?.phase === 'commit_intent') {
    const candidate = (await g(['rev-parse', 'HEAD'])).trim();
    if (candidate === previous.baseline || bytes(status).length !== 0) throw new Error('Commit previo ambiguo; revisa el checkout antes de continuar.');
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
  const refreshedPrs = sameRepositoryPullRequests(JSON.parse((await h(['pr', 'list', '--repo', repo, '--head', job.branch, '--base', dest.baseBranch, '--state', 'open', '--limit', '100', '--json', pullRequestIdentityFields])) || '[]'), repo, job.branch, dest.baseBranch);
  if (refreshedPrs.length > 1) throw new Error('Más de una PR abierta para head/base; requiere revisión.');
  let pr = refreshedPrs[0] || prs[0];
  if (!pr && previous?.phase === 'pr_intent') throw new Error('Creación de PR ambigua; no hay PR observable. Revisión manual necesaria antes de repetir.');
  if (!pr) {
    await save('pr_intent', { commitSha: head });
    await h(['pr', 'create', '--repo', repo, '--head', `${repo.split('/')[0]}:${job.branch}`, '--base', dest.baseBranch, '--title', job.title.slice(0, 120), '--body', `Integración automática del job ${job.id} (recibo ${intent.receiptId}).`]);
    const found = await h(['pr', 'list', '--repo', repo, '--head', job.branch, '--base', dest.baseBranch, '--state', 'open', '--limit', '100', '--json', pullRequestIdentityFields]);
    const createdPrs = sameRepositoryPullRequests(JSON.parse(found || '[]'), repo, job.branch, dest.baseBranch);
    if (createdPrs.length > 1) throw new Error('Más de una PR abierta para head/base; requiere revisión.');
    pr = createdPrs[0];
    if (!pr) throw new Error('PR no confirmada tras crearla; necesita revisión.');
  }
  if (pr.headRefOid !== head) throw new Error('La PR abierta apunta a un commit diferente del aprobado.');
  await save('pr_confirmed', { prNumber: pr.number, prUrl: pr.url, commitSha: head });
  // 38: a fine-grained token cannot read check runs (statusCheckRollup answers «Resource not accessible»).
  // Only then, and from then on for this record, the checks come from the Actions API for the exact head.
  const readChecks = async () => {
    if (record.checksSource !== 'actions') {
      try {
        const detail = JSON.parse(await h(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergeable,statusCheckRollup,headRefOid,baseRefOid']));
        return { detail, checks: detail.statusCheckRollup };
      } catch (error) {
        if (!checksPermissionDenied(error)) throw error;
        record.checksSource = 'actions';
      }
    }
    const detail = JSON.parse(await h(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'state,mergeable,headRefOid,baseRefOid']));
    const runs = JSON.parse(await h(['api', '--method', 'GET', `repos/${repo}/actions/runs`, '-f', `head_sha=${head}`, '-f', 'per_page=100']));
    return { detail, checks: actionsRunsAsChecks(runs, head) };
  };
  const checkReadiness = async () => {
    const { detail, checks } = await readChecks();
    const summary = Array.isArray(checks) ? checks.slice(0, 80).map(check => ({ name: String(check?.name || check?.context || '').slice(0, 160), status: String(check?.status || '').slice(0, 40), conclusion: String(check?.conclusion || '').slice(0, 40) })) : [];
    let failure = detail.state !== 'OPEN' ? 'La PR dejó de estar abierta.'
      : detail.headRefOid !== head || detail.baseRefOid !== base ? 'La PR cambió de commit fuente o base; requiere nueva revisión.'
      : detail.mergeable === 'CONFLICTING' ? 'La PR tiene conflictos.' : '';
    if (!failure && Array.isArray(checks) && checks.some(check => check?.conclusion && !['SUCCESS', 'PENDING'].includes(check.conclusion))) failure = 'Un check terminó sin aprobación.';
    const ready = !failure && detail.mergeable === 'MERGEABLE' && Array.isArray(checks) && checks.length > 0
      && checks.every(check => check?.conclusion === 'SUCCESS' && !['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING'].includes(check.status));
    return { ready, failure, checks: summary, mergeable: detail.mergeable };
  };
  const deadline = checksTimeoutMs === null ? Infinity : clock() + checksTimeoutMs;
  const noChecksAt = noChecksGraceMs === null ? Infinity : clock() + noChecksGraceMs;
  let lastChecks;
  const waitUntilReady = async () => {
    for (;;) {
      checkAbort();
      const result = await checkReadiness();
      checkAbort();
      if (result.ready) {
        record.checks = result.checks;
        record.checkState = 'passed';
        record.checkedAt = now();
        delete record.waitTimedOut;
        return;
      }
      // A mergeable PR still without a single registered check after the grace has no CI to wait for.
      const noChecks = !result.failure && result.mergeable === 'MERGEABLE' && result.checks.length === 0 && clock() >= noChecksAt && clock() < deadline;
      const signature = JSON.stringify(result);
      if (signature !== lastChecks || result.failure || noChecks || clock() >= deadline) {
        lastChecks = signature;
        await save('checks_pending', { prNumber: pr.number, prUrl: pr.url, checks: result.checks,
          checkState: result.failure ? 'failed' : noChecks ? 'no_checks' : 'waiting', checkedAt: now(),
          ...(result.failure ? { error: result.failure } : noChecks ? { error: 'La PR no tiene checks registrados.' } : {}), ...(clock() >= deadline ? { waitTimedOut: true } : {}) });
      }
      if (result.failure) throw Object.assign(new Error(`PR pendiente de revisión: ${result.failure}`), { code: 'github_checks_blocked' });
      if (noChecks) throw Object.assign(new Error(`La PR ${pr.url} no tiene checks registrados: configura CI en la rama base o revisa y fusiona manualmente; la integración no fusiona sin checks aprobados.`), { code: 'github_no_checks' });
      if (clock() >= deadline) throw Object.assign(new Error('PR pendiente de checks al agotar la espera acotada; conserva esta PR para revisión.'), { code: 'github_checks_timeout' });
      await wait(Math.min(checksIntervalMs, deadline - clock(), Math.max(1, noChecksAt - clock())), ctx.signal);
    }
  };
  await waitUntilReady();
  // Re-read immediately before the mutation; a newly queued check is awaited
  // within the same deadline, while a changed head/base or terminal failure blocks.
  await waitUntilReady();
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
  const { git } = createIntegrationCommandAdapters({ timeoutMs: 10_000 });
  const run = args => git(args, workspace);
  return diffFingerprint(await run(['status', '--porcelain=v1', '-z']), await run(['diff', '--binary', 'HEAD']), await run(['diff', '--cached', '--binary']), await untrackedFingerprint(workspace, run));
}

// 28 (F13): the integration reads PR fields that older gh builds do not know
// (Ubuntu's gh 2.46.0 rejects baseRefOid; 2.103.3 from the official GitHub CLI
// repository works; the exact minimum was not determined offline). The typed error
// keeps the generic job code so the integration recovery paths still apply.
export const GH_REQUIRED_PR_FIELDS = Object.freeze(['number', 'url', 'state', 'headRefOid', 'baseRefOid', 'headRefName', 'baseRefName', 'isCrossRepository', 'headRepository', 'headRepositoryOwner', 'mergedAt', 'mergeCommit']);
export const GH_INSTALL_HINT = 'Instala GitHub CLI desde el repositorio oficial (https://github.com/cli/cli/blob/trunk/docs/install_linux.md) y comprueba gh --version; la versión 2.103.3 funciona y la 2.46.0 de Ubuntu no.';
const ghError = (cause, message, details = {}) => Object.assign(new Error(message), { code: 'github_integration_needs_attention', safeMessage: message, uncertain: false, details: { cause, ...details } });
const decode = value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');

/** Offline capability check: `gh pr list --json` without fields lists the supported fields (stderr, exit 1). */
export async function ghCapabilityPreflight({ executeCommand = exec, cwd, timeoutMs = 15_000 } = {}) {
  const run = async args => {
    try { const result = await executeCommand('gh', args, { cwd, env: safeEnv(), encoding: null, windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 1_000_000 }); return { ok: true, text: decode(result.stdout) + decode(result.stderr) }; }
    catch (error) { return { ok: false, text: decode(error?.stdout) + decode(error?.stderr), reason: error?.code }; }
  };
  const versionRun = await run(['--version']);
  const version = /gh version (\d+\.\d+\.\d+)/.exec(versionRun.text)?.[1] ?? null;
  if (!versionRun.ok || !version) throw ghError('gh_missing', `GitHub CLI (gh) no está disponible o no responde a --version. ${GH_INSTALL_HINT}`, { reason: typeof versionRun.reason === 'string' ? versionRun.reason : undefined });
  const listing = await run(['pr', 'list', '--json']);
  const fields = listing.text.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z]+$/.test(line));
  if (!fields.length) throw ghError('gh_capability_unknown', `gh ${version} no enumeró los campos JSON de pr list; comprueba la instalación. ${GH_INSTALL_HINT}`, { version });
  const missing = GH_REQUIRED_PR_FIELDS.filter(field => !fields.includes(field));
  if (missing.length) throw ghError('gh_version_unsupported', `gh ${version} no admite los campos ${missing.join(', ')} que usa la integración. ${GH_INSTALL_HINT}`, { version, missing: missing.join(',') });
  return { version, fields: fields.length };
}

// 38: the permission error of statusCheckRollup with a fine-grained token (check runs need the Checks
// permission, which fine-grained tokens do not offer). Any other failure keeps its own error.
export function checksPermissionDenied(error) {
  const text = [error?.message, error?.details?.stderr].filter(Boolean).join(' ');
  return /Resource not accessible by (personal access token|integration)/i.test(text);
}

// 38: GitHub Actions runs for the exact head, shaped like statusCheckRollup entries. Only the latest run of
// each workflow and event counts (a new run replaces an older one); an incomplete listing fails closed.
// Limitation: commit statuses and check runs from other CI apps are not visible through this API.
export function actionsRunsAsChecks(listing, head) {
  const runs = listing?.workflow_runs;
  if (!Array.isArray(runs) || !Number.isInteger(listing.total_count) || listing.total_count !== runs.length || runs.length >= 100) {
    throw new Error('La lista de ejecuciones de Actions está incompleta o limitada; revisa los checks a mano.');
  }
  const latest = new Map();
  for (const run of runs) {
    if (run?.head_sha !== head || !Number.isInteger(run.id) || run.workflow_id == null) continue;
    const key = `${run.workflow_id}:${run.event}`;
    if (!latest.has(key) || latest.get(key).id < run.id) latest.set(key, run);
  }
  return [...latest.values()].sort((a, b) => a.id - b.id).map(run => ({
    name: String(run.name || run.workflow_id), status: String(run.status || '').toUpperCase(), conclusion: run.conclusion ? String(run.conclusion).toUpperCase() : '',
  }));
}

export function createIntegrationCommandAdapters({ signal, executeCommand = exec, timeoutMs = 30_000 } = {}) {
  const invoke = async (exe, args, cwd) => {
    const binary = exe === 'git' && ['status', 'diff', 'ls-files'].includes(args[0]);
    try {
      const { stdout } = await executeCommand(exe, args, { cwd, env: safeEnv(), encoding: null, windowsHide: true, shell: false,
        signal, timeout: timeoutMs, maxBuffer: binary ? 2_000_000 : 1_000_000 });
      // These fields are length-framed bytes in the approval hash. Decoding or
      // trimming them changes porcelain columns, NUL paths and diff endings.
      return binary ? bytes(stdout) : bytes(stdout).toString('utf8').trim();
    }
    catch (error) {
      const unknownField = /Unknown JSON field:?\s*"?([A-Za-z]+)"?/.exec(decode(error?.stderr));
      if (exe === 'gh' && unknownField) throw ghError('gh_version_unsupported', `gh no admite el campo JSON ${unknownField[1]} que usa la integración. ${GH_INSTALL_HINT}`, { missing: unknownField[1] });
      // 39: keep what failed (subcommand, exit code or signal, bounded and redacted stderr) instead of a
      // bare generic message. The outcome stays uncertain: the remote must still be checked before continuing.
      const command = [exe, ...args.slice(0, exe === 'gh' ? 2 : 1).filter(arg => /^[a-z][a-z-]{0,30}$/.test(arg))].join(' ');
      const exit = Number.isInteger(error?.code) ? `salida ${error.code}` : error?.signal ? `señal ${error.signal}` : typeof error?.code === 'string' ? error.code : 'sin código';
      const stderr = excerpt(decode(error?.stderr), 300);
      const message = `${exe} falló o la respuesta fue ambigua; consulta el estado remoto antes de continuar. (${command}: ${exit}${stderr ? ` · ${stderr}` : ''})`;
      throw Object.assign(new Error(message), { code: 'github_integration_needs_attention', safeMessage: message,
        details: { cause: 'command_failed', command, exit, ...(stderr ? { stderr } : {}) } });
    }
  };
  return { git: (args, cwd) => invoke('git', args, cwd), gh: (args, cwd) => invoke('gh', args, cwd) };
}

// The capability preflight runs with the real gh. Injected command fakes skip it unless they pass their own preflight.
export async function integrateGitHubDefault(job, ctx, { executeCommand = exec, preflight = executeCommand === exec ? ghCapabilityPreflight : null, ...options } = {}) {
  if (preflight && job?.autoIntent?.eligible === true && job.autoIntent.receiptId && job.state !== 'cancelled') await preflight({ executeCommand, cwd: job.workspace });
  return integrateGitHub(job, ctx, { ...createIntegrationCommandAdapters({ signal: ctx.signal, executeCommand }), ...options });
}
