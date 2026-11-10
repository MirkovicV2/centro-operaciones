import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { orcaCommandFailure, ORCA_NATIVE_CODE_HINTS } from '../orca-provider.mjs';
import { DestinationError, verifyGitHubDestination } from '../project-destination.mjs';
import { addJob, boundedErrorDetails, loadState, runQueue } from '../queue.mjs';
import { ProviderError } from '../providers.mjs';
import { redactSecrets, excerpt } from '../redaction.mjs';

// Improvements 2 and 15 (D1): failures keep a code, an actionable message and a
// bounded, redacted excerpt instead of a generic worker_error or commandFailure: {}.
const key = 'sk-' + 'A'.repeat(40);

test('orcaCommandFailure maps known native codes to actionable messages and keeps bounded redacted details', () => {
  const fenced = orcaCommandFailure({ ok: false, error: { code: 'consumer_fenced', message: `Run consumer fenced ${key}` }, requestId: 'req_1' }, 1, `stderr line ${key}\nsecond line`);
  assert.equal(fenced.code, 'orca_command_failed'); assert.equal(fenced.nativeCode, 'consumer_fenced'); assert.equal(fenced.rejected, false); assert.equal(fenced.uncertain, true);
  assert.match(fenced.message, /^Orca: consumer_fenced; otro proceso ya consume esta Run/);
  assert.equal(fenced.safeMessage, fenced.message);
  assert.equal(fenced.details.requestId, 'req_1'); assert.equal(fenced.details.exitCode, 1); assert.equal(fenced.details.hint, ORCA_NATIVE_CODE_HINTS.consumer_fenced);
  assert.equal(fenced.details.nativeMessage, 'Run consumer fenced [CLAVE OCULTA]'); assert.equal(fenced.details.stderr, 'stderr line [CLAVE OCULTA] second line');
  assert.equal(JSON.stringify(fenced.details).includes(key), false);
  const rejected = orcaCommandFailure({ ok: false, error: { code: 'invalid_arguments' } }, 2);
  assert.equal(rejected.code, 'orca_command_rejected'); assert.equal(rejected.rejected, true); assert.equal(rejected.uncertain, false);
  assert.equal(rejected.details.stderr, undefined); assert.equal(rejected.details.nativeMessage, undefined);
  const unknown = orcaCommandFailure({ ok: false, error: { code: 'something_new', message: 'x'.repeat(1000) } }, 1);
  assert.equal(unknown.message, 'Orca: something_new; consulta la evidencia del intento.'); assert.equal(unknown.details.hint, undefined);
  assert.equal(unknown.details.nativeMessage.length, 400); assert.ok(unknown.details.nativeMessage.endsWith('…'));
  const malformed = orcaCommandFailure({ ok: false, error: { code: 'bad code!' } }, 1);
  assert.equal(malformed.nativeCode, 'orca_command_failed'); assert.equal(malformed.details.nativeCode, 'orca_command_failed');
  assert.equal(orcaCommandFailure(null, null).details.exitCode, undefined);
});

test('the real git runner reports a typed destination_git_failed error with the command and a stderr excerpt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-destination-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'checkout'); await fs.mkdir(workspace, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git(['init', '-q', '-b', 'develop']); git(['config', 'user.email', 't@example.test']); git(['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(workspace, 'a.txt'), 'a\n'); git(['add', 'a.txt']); git(['commit', '-q', '-m', 'init']);
  git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  // ls-remote must fail fast and offline: route HTTP through a closed local port.
  git(['config', 'http.proxy', 'http://127.0.0.1:9']);
  const job = { id: 'typed', workspace, branch: 'develop', isolated: true, destination: { repository: 'owner/repo' } };
  const inspect = async () => ({ checkout: 'workspaces/checkout', workspace, branch: 'develop', valid: true });
  const error = await verifyGitHubDestination(root, job, { inspect }).then(() => assert.fail('must fail'), error => error);
  assert.ok(error instanceof DestinationError, String(error));
  assert.equal(error.code, 'destination_git_failed'); assert.equal(error.safeMessage, error.message); assert.equal(error.uncertain, false);
  assert.equal(error.details.command, 'git ls-remote'); assert.equal(error.details.exitCode, 128);
  assert.ok(typeof error.details.stderr === 'string' && error.details.stderr.length > 0 && error.details.stderr.length <= 400);
  assert.equal(error.details.stderr.includes('\n'), false);
});

test('destination checks keep their messages and now carry codes and details, including a dirty checkout', async () => {
  const root = '/tmp/never-used', workspace = path.join(root, 'workspaces', 'checkout');
  const inspect = async () => ({ checkout: 'workspaces/checkout', workspace, branch: 'develop', valid: true });
  const base = { id: 'typed', workspace, branch: 'develop', isolated: true, destination: { repository: 'owner/repo', baseBranch: 'main' }, autoIntent: { eligible: true, receiptId: 'r' } };
  const fakeGit = ({ dirty = '', origin = 'https://github.com/owner/repo.git', branch = 'develop', remote = 'a'.repeat(40) }) => async args => {
    if (args[0] === 'remote') return origin;
    if (args[0] === 'symbolic-ref') return branch;
    if (args[0] === 'rev-parse') return 'a'.repeat(40);
    if (args[0] === 'status') return dirty;
    if (args[0] === 'ls-remote') return args.at(-1).endsWith('/main') ? `${'b'.repeat(40)}\trefs/heads/main` : remote ? `${remote}\trefs/heads/develop` : '';
    assert.fail(args.join(' '));
  };
  const expect = async (git, code, pattern, details) => {
    const error = await verifyGitHubDestination(root, base, { inspect, git }).then(() => assert.fail('must fail'), error => error);
    assert.ok(error instanceof DestinationError); assert.equal(error.code, code); assert.match(error.message, pattern);
    if (details) assert.deepEqual(error.details, details);
  };
  await expect(fakeGit({ dirty: ` M index.html\n?? ${key}.txt` }), 'destination_dirty', /no estaba limpio/, { status: 'M index.html ?? [CLAVE OCULTA].txt' });
  await expect(fakeGit({ origin: 'https://github.com/other/repo.git' }), 'destination_origin_mismatch', /Origin no coincide/, { expected: 'owner/repo', observed: 'other/repo' });
  await expect(fakeGit({ branch: 'main' }), 'destination_branch_changed', /Rama cambiada/, { expected: 'develop', observed: 'main' });
  await expect(fakeGit({ remote: 'c'.repeat(40) }), 'destination_remote_mismatch', /SHA local\/remoto distinto/);
  await expect(fakeGit({ remote: '' }), 'destination_remote_mismatch', /Rama remota ausente/);
  const clean = fakeGit({});
  assert.equal((await verifyGitHubDestination(root, base, { inspect, git: clean })).verified, true);
  await assert.rejects(verifyGitHubDestination(root, { ...base, destination: { repository: 'owner/repo' } }, { inspect, git: clean }), { code: 'destination_base_unconfigured' });
  await assert.rejects(verifyGitHubDestination(root, { ...base, branch: '' }, { inspect, git: clean }), { code: 'destination_unconfigured' });
});

test('the queue persists bounded typed details with the job error and shows them to the operator', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-queue-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await addJob(root, { id: 'typed-job', business: 'agency', kind: 'analysis', provider: 'orca', title: 'Fallo tipado', prompt: 'Probar.' });
  const details = { nativeCode: 'consumer_fenced', hint: 'h', exitCode: 1, nested: { no: true }, list: [1], empty: '', long: 'y'.repeat(2000), 'bad key!': 'x', flag: false };
  await runQueue(root, { execute: true, worker: async () => { throw Object.assign(new ProviderError('orca_command_failed', 'Orca: consumer_fenced; otro proceso ya consume esta Run.', { uncertain: true }), { details }); } });
  const job = (await loadState(root)).jobs[0];
  assert.equal(job.state, 'needs_attention'); assert.equal(job.error.code, 'orca_command_failed');
  assert.equal(job.error.message, 'Orca: consumer_fenced; otro proceso ya consume esta Run.');
  assert.deepEqual(job.error.details, { nativeCode: 'consumer_fenced', hint: 'h', exitCode: 1, long: 'y'.repeat(600), flag: false });
  assert.deepEqual(boundedErrorDetails(undefined), {}); assert.deepEqual(boundedErrorDetails([1]), {}); assert.deepEqual(boundedErrorDetails({ a: {} }), {});
  assert.equal(Object.keys(boundedErrorDetails(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]))).details).length, 20);
  // Plain errors still fall back to the generic message: no raw text reaches the ledger.
  await addJob(root, { id: 'plain-job', business: 'games', kind: 'analysis', provider: 'orca', title: 'Fallo plano', prompt: 'Probar.' });
  await runQueue(root, { execute: true, business: 'games', worker: async () => { throw new Error(`raw ${key}`); } });
  const plain = (await loadState(root)).jobs.find(item => item.id === 'plain-job');
  assert.equal(plain.error.code, 'worker_error'); assert.equal(plain.error.details, undefined); assert.equal(plain.error.message.includes('raw'), false);
  const app = await fs.readFile(new URL('../panel/dashboard/app.js', import.meta.url), 'utf8');
  assert.ok(app.includes('job.error.details'), 'the panel renders the typed details');
});

test('redactSecrets hides configured keys and sk- tokens; excerpt is single-line and bounded', () => {
  const env = { OPENAI_API_KEY: 'super-secret-key-123' };
  assert.equal(redactSecrets(`a super-secret-key-123 b ${key} c`, env), 'a [CLAVE OCULTA] b [CLAVE OCULTA] c');
  assert.equal(redactSecrets('short', { OPENAI_API_KEY: 'abc' }), 'short');
  assert.equal(excerpt('  line one\n\tline   two  '), 'line one line two');
  assert.equal(excerpt('z'.repeat(50), 10).length, 10); assert.equal(excerpt(null), '');
});
