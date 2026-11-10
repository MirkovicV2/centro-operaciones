import test from 'node:test';
import assert from 'node:assert/strict';
import { GH_REQUIRED_PR_FIELDS, createIntegrationCommandAdapters, ghCapabilityPreflight, integrateGitHubDefault } from '../github-integration.mjs';

// Improvement 28 (F13): gh must know the PR fields the integration reads.
const listing = fields => Object.assign(new Error('exit 1'), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Specify one or more comma-separated fields for `--json`:\n' + fields.map(field => '  ' + field).join('\n') + '\n') });
const fakeGh = ({ version = '2.103.3', fields = [...GH_REQUIRED_PR_FIELDS, 'additions', 'author'], missing = false } = {}) => async (exe, args) => {
  assert.equal(exe, 'gh');
  if (args[0] === '--version') { if (missing) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }); return { stdout: Buffer.from(`gh version ${version} (2026-10-26)\nhttps://github.com/cli/cli/releases/tag/v${version}\n`), stderr: Buffer.alloc(0) }; }
  assert.deepEqual(args, ['pr', 'list', '--json']);
  throw listing(fields);
};

test('a gh that lists every required PR field passes the offline capability preflight', async () => {
  assert.deepEqual(await ghCapabilityPreflight({ executeCommand: fakeGh() }), { version: '2.103.3', fields: GH_REQUIRED_PR_FIELDS.length + 2 });
});

test('an old gh without baseRefOid, a missing gh and an empty listing block with typed, actionable errors', async () => {
  const old = await ghCapabilityPreflight({ executeCommand: fakeGh({ version: '2.46.0', fields: GH_REQUIRED_PR_FIELDS.filter(field => field !== 'baseRefOid') }) }).then(() => assert.fail('must fail'), error => error);
  assert.equal(old.code, 'github_integration_needs_attention'); assert.equal(old.details.cause, 'gh_version_unsupported');
  assert.equal(old.details.version, '2.46.0'); assert.equal(old.details.missing, 'baseRefOid');
  assert.match(old.message, /gh 2\.46\.0 no admite los campos baseRefOid/); assert.match(old.message, /repositorio oficial/); assert.equal(old.safeMessage, old.message);
  const missing = await ghCapabilityPreflight({ executeCommand: fakeGh({ missing: true }) }).then(() => assert.fail('must fail'), error => error);
  assert.equal(missing.details.cause, 'gh_missing'); assert.equal(missing.details.reason, 'ENOENT');
  const empty = await ghCapabilityPreflight({ executeCommand: fakeGh({ fields: [] }) }).then(() => assert.fail('must fail'), error => error);
  assert.equal(empty.details.cause, 'gh_capability_unknown');
});

test('a real gh call rejected for an unknown JSON field becomes the same typed error instead of a generic failure', async () => {
  const { gh, git } = createIntegrationCommandAdapters({ executeCommand: async (exe, args) => {
    if (exe === 'gh') throw Object.assign(new Error('exit 1'), { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Unknown JSON field: "baseRefOid"\nAvailable fields:\n  additions\n') });
    throw Object.assign(new Error('exit 128'), { code: 128, stderr: Buffer.from('fatal: not a git repository') });
  } });
  const error = await gh(['pr', 'list', '--json', 'baseRefOid'], '/tmp').then(() => assert.fail('must fail'), error => error);
  assert.equal(error.code, 'github_integration_needs_attention'); assert.equal(error.details.cause, 'gh_version_unsupported'); assert.equal(error.details.missing, 'baseRefOid');
  await assert.rejects(git(['status'], '/tmp'), /git falló o la respuesta fue ambigua/);
});

test('integrateGitHubDefault runs the preflight before touching the integration and skips it for non-eligible jobs', async () => {
  const calls = [];
  const executeCommand = async (exe, args) => { calls.push([exe, ...args]); return fakeGh()(exe, args); };
  const eligible = { id: 'j', autoIntent: { eligible: true, receiptId: 'r' }, workspace: '/tmp/ws', state: 'needs_attention' };
  await assert.rejects(integrateGitHubDefault(eligible, { root: '/tmp', signal: new AbortController().signal }, { executeCommand, preflight: async options => { assert.equal(options.cwd, '/tmp/ws'); throw Object.assign(new Error('old gh'), { code: 'github_integration_needs_attention' }); } }), /old gh/);
  assert.deepEqual(calls, []);
  const skipped = await integrateGitHubDefault({ id: 'j', autoIntent: { eligible: false } }, { root: '/tmp' }, { executeCommand, preflight: async () => assert.fail('no preflight for manual jobs') });
  assert.deepEqual(skipped, { status: 'skipped', reason: 'not_eligible' });
});
