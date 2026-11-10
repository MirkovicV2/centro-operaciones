import fs from 'node:fs/promises';
import path from 'node:path';
import { githubRepository, sameRepository } from './project-destination.mjs';
import { createIntegrationCommandAdapters, pullRequestIdentityFields, sameRepositoryPullRequest, sameRepositoryPullRequests } from './github-integration.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
const branch = value => typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !value.startsWith('/') && !value.includes('..') && !/[\\\x00\r\n]/.test(value);
function assert(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'github_integration_recovery_invalid', uncertain: true });
}
const text = value => Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value ?? '').trim();
const length = value => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value ?? ''));

/** Inspect an already recorded commit and its one exact PR. No Git/GitHub mutation or new snapshot. */
export async function inspectCommittedIntegration(root, job, record, { git, gh } = {}) {
  const defaults = createIntegrationCommandAdapters();
  git ??= defaults.git; gh ??= defaults.gh;
  const baseRoot = path.resolve(root), workspace = path.resolve(job?.workspace || '');
  const relative = path.relative(path.join(baseRoot, 'workspaces'), workspace);
  assert(path.isAbsolute(job?.workspace || '') && relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'El checkout de recuperación está fuera de workspaces.');
  assert(await fs.realpath(baseRoot) === baseRoot && await fs.realpath(workspace) === workspace, 'El checkout de recuperación no es canónico.');
  const gitDirectory = path.join(workspace, '.git');
  const metadata = await fs.lstat(gitDirectory);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink() && await fs.realpath(gitDirectory) === gitDirectory, 'La recuperación exige metadatos Git propios.');
  for (const name of ['commondir', 'index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock']) {
    try { await fs.access(path.join(gitDirectory, name)); assert(false, 'El checkout tiene metadatos compartidos o un bloqueo Git pendiente.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const destination = job.destination ?? {};
  assert(job.autoIntent?.eligible === true && job.autoIntent.receiptId && job.state !== 'cancelled'
    && record?.jobId === job.id && record.receiptId === job.autoIntent.receiptId
    && sameRepository(record.repository, destination.repository) && record.sourceBranch === job.branch && record.baseBranch === destination.baseBranch
    && branch(job.branch) && branch(destination.baseBranch) && job.branch !== destination.baseBranch
    && ['pr_intent', 'pr_confirmed', 'checks_pending', 'merge_intent'].includes(record.phase)
    && sha(record.commitSha) && sha(record.remoteBaseSha) && /^[a-f0-9]{64}$/i.test(record.manifest ?? '')
    && (record.prNumber === undefined || Number.isSafeInteger(record.prNumber) && record.prNumber > 0),
  'El registro no acredita una integración con commit y PR recuperable del mismo encargo.');
  assert(destination.workspace === workspace && destination.branch === job.branch
    && destination.baseSha === record.remoteBaseSha, 'El destino original no coincide con la integración registrada.');
  const repository = githubRepository('https://github.com/' + record.repository);
  assert(repository && sameRepository(repository, record.repository), 'Repositorio de recuperación inválido.');
  const g = args => git(args, workspace), h = args => gh(args, workspace);
  assert(sameRepository(githubRepository(text(await g(['remote', 'get-url', 'origin']))), repository), 'Origin cambió desde la integración registrada.');
  assert(text(await g(['symbolic-ref', '--quiet', '--short', 'HEAD'])) === job.branch, 'La rama activa cambió desde la integración registrada.');
  assert(text(await g(['check-ref-format', '--branch', job.branch])) === job.branch
    && text(await g(['check-ref-format', '--branch', destination.baseBranch])) === destination.baseBranch, 'Las ramas registradas no son válidas.');
  assert(length(await g(['status', '--porcelain=v1', '-z'])) === 0, 'El checkout cambió después del commit registrado.');
  assert(text(await g(['rev-parse', 'HEAD'])) === record.commitSha, 'HEAD no coincide con el commit registrado.');
  const listing = JSON.parse(text(await h(['pr', 'list', '--repo', repository, '--head', job.branch, '--base', destination.baseBranch,
    '--state', record.phase === 'merge_intent' ? 'all' : 'open', '--limit', '100', '--json', pullRequestIdentityFields])) || '[]');
  assert(Array.isArray(listing) && listing.length < 100, 'La búsqueda de PR es ambigua o está limitada.');
  const candidates = sameRepositoryPullRequests(listing, repository, job.branch, destination.baseBranch)
    .filter(pr => pr.headRefOid === record.commitSha && (pr.state === 'OPEN' || record.phase === 'merge_intent' && pr.state === 'MERGED'));
  assert(candidates.length === 1, 'No hay una única PR del mismo repositorio para el commit registrado.');
  const candidate = candidates[0];
  assert(record.prNumber === undefined || record.prNumber === candidate.number, 'La PR encontrada no coincide con la PR registrada.');
  const pr = JSON.parse(text(await h(['pr', 'view', String(candidate.number), '--repo', repository, '--json', pullRequestIdentityFields + ',mergedAt,mergeCommit'])));
  assert(sameRepositoryPullRequest(pr, repository, job.branch, destination.baseBranch) && pr.number === candidate.number
    && pr.headRefOid === record.commitSha && pr.baseRefOid === record.remoteBaseSha
    && (!record.prUrl || record.prUrl === pr.url), 'La identidad, el commit fuente o la base de la PR cambiaron.');
  const merged = record.phase === 'merge_intent' && pr.state === 'MERGED' && pr.mergedAt && sha(pr.mergeCommit?.oid);
  assert(pr.state === 'OPEN' || merged, 'La PR no está abierta ni acredita el merge pendiente.');
  const remoteSource = text(await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).split(/\s+/)[0];
  const remoteBase = text(await g(['ls-remote', '--exit-code', '--heads', 'origin', destination.baseBranch])).split(/\s+/)[0];
  assert(remoteSource === record.commitSha && remoteBase === (merged ? pr.mergeCommit.oid : record.remoteBaseSha), 'Las ramas remotas no coinciden con el commit y la base registrados.');
  return { kind: 'committed_integration', jobId: job.id, receiptId: record.receiptId, commitSha: record.commitSha,
    manifest: record.manifest, phase: record.phase, repository, sourceBranch: job.branch, baseBranch: destination.baseBranch,
    baseSha: record.remoteBaseSha, prNumber: pr.number, prUrl: pr.url, prHeadSha: pr.headRefOid, prBaseSha: pr.baseRefOid,
    prState: pr.state, ...(merged ? { mergeSha: pr.mergeCommit.oid } : {}) };
}

const EFFECT_KEYS = ['manifest', 'commitSha', 'prNumber', 'prUrl', 'mergeSha', 'pushedAt', 'mergedAt'];
const PRE_EFFECT_PHASES = [undefined, 'validation_pending', 'validation_approved'];

/** A failed integration record that never reached a durable effect intent. Pure; no I/O. */
export function effectFreeIntegrationRecord(record, history = [], jobId = record?.jobId) {
  return Boolean(record) && record.status === 'needs_attention' && PRE_EFFECT_PHASES.includes(record.phase)
    && EFFECT_KEYS.every(key => record[key] === undefined)
    && !history.some(item => item?.jobId === jobId && item.type === 'github_integration' && !PRE_EFFECT_PHASES.includes(item.phase));
}

/** Confirm with the remote that a pre-effect integration failure left no commit, push or PR. Read-only. */
export async function inspectEffectFreeIntegration(root, job, record, { git, gh, history = [] } = {}) {
  const defaults = createIntegrationCommandAdapters();
  git ??= defaults.git; gh ??= defaults.gh;
  assert(effectFreeIntegrationRecord(record, history, job?.id), 'El registro de integración no acredita un fallo anterior a cualquier efecto.');
  const destination = job?.destination ?? {};
  const workspace = path.resolve(job?.workspace || '');
  assert(path.isAbsolute(job?.workspace || '') && record.jobId === job.id && sameRepository(record.repository, destination.repository)
    && record.sourceBranch === job.branch && record.baseBranch === destination.baseBranch
    && branch(job.branch) && branch(destination.baseBranch) && sha(destination.sha) && sha(destination.remoteSha) && sha(destination.baseSha),
  'El destino registrado no permite comprobar la ausencia de efectos.');
  const repository = githubRepository('https://github.com/' + record.repository);
  const g = args => git(args, workspace), h = args => gh(args, workspace);
  assert(sameRepository(githubRepository(text(await g(['remote', 'get-url', 'origin']))), repository), 'Origin cambió desde la integración registrada.');
  const head = text(await g(['rev-parse', 'HEAD']));
  assert(head === destination.sha, 'El checkout tiene un commit posterior al baseline aprobado; revisa antes de continuar.');
  const remoteSource = text(await g(['ls-remote', '--exit-code', '--heads', 'origin', job.branch])).split(/\s+/)[0];
  assert(remoteSource === destination.remoteSha, 'La rama remota cambió desde el baseline; no se descarta un push.');
  const remoteBase = text(await g(['ls-remote', '--exit-code', '--heads', 'origin', destination.baseBranch])).split(/\s+/)[0];
  assert(remoteBase === destination.baseSha, 'La rama base remota cambió desde el baseline; revisa antes de continuar.');
  let openPullRequests = 0;
  if (job.branch !== destination.baseBranch) {
    const listing = JSON.parse(text(await h(['pr', 'list', '--repo', repository, '--head', job.branch, '--base', destination.baseBranch,
      '--state', 'open', '--limit', '100', '--json', pullRequestIdentityFields])) || '[]');
    openPullRequests = sameRepositoryPullRequests(listing, repository, job.branch, destination.baseBranch).length;
    assert(openPullRequests === 0, 'Existe una PR abierta para esta rama; la integración no fue inocua.');
  }
  return { kind: 'effect_free_integration', jobId: job.id, receiptId: record.receiptId, phase: record.phase ?? null,
    repository, sourceBranch: job.branch, baseBranch: destination.baseBranch, headSha: head, remoteSourceSha: remoteSource, remoteBaseSha: remoteBase, openPullRequests };
}
