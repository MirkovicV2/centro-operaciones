import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orcaUserDataDir } from '../local-tools.mjs';
import { evaluateOrcaAgentSettings, inspectOrcaAgentSettings, orcaProfileStatePath, readOrcaAgentSettings } from '../orca-settings.mjs';

// Improvement 25: the panel reads (never writes) how Orca opens Claude workers.
test('Orca data and profile paths resolve per platform; Windows keeps APPDATA (simulation only)', () => {
  assert.equal(orcaUserDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\o\\AppData\\Roaming' }, home: 'C:\\Users\\o' }), 'C:\\Users\\o\\AppData\\Roaming\\orca');
  assert.equal(orcaUserDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\o' }), 'C:\\Users\\o\\AppData\\Roaming\\orca');
  assert.equal(orcaUserDataDir({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.config/orca');
  assert.equal(orcaUserDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/cfg' }, home: '/home/u' }), '/cfg/orca');
  assert.equal(orcaUserDataDir({ platform: 'darwin', env: {}, home: '/Users/u' }), '/Users/u/Library/Application Support/orca');
  assert.deepEqual(orcaProfileStatePath({ platform: 'win32', env: { APPDATA: 'C:\\R' }, home: 'C:\\Users\\o', profileId: 'p1' }),
    { index: 'C:\\R\\orca\\orca-profile-index.json', database: 'C:\\R\\orca\\profiles\\p1\\profile-state.db' });
  assert.deepEqual(orcaProfileStatePath({ platform: 'linux', env: {}, home: '/home/u' }),
    { index: '/home/u/.config/orca/orca-profile-index.json', database: '/home/u/.config/orca/profiles/local-default/profile-state.db' });
});

test('evaluateOrcaAgentSettings warns about chat surface and ask/accept-edits/full-access permission modes', () => {
  const terminal = evaluateOrcaAgentSettings({ agentDefaultSurface: 'chat', nativeChatProviders: { claude: false, codex: false }, agentPermissionDefault: 'auto' });
  assert.equal(terminal.surface, 'terminal'); assert.deepEqual(terminal.warnings, []); assert.equal(terminal.permissionMode, 'auto');
  const chat = evaluateOrcaAgentSettings({ agentDefaultSurface: 'chat', nativeChatProviders: {}, agentPermissionDefault: 'ask' });
  assert.equal(chat.surface, 'chat'); assert.equal(chat.warnings.length, 2);
  assert.match(chat.warnings[0], /Open agents as/); assert.match(chat.warnings[1], /Ask for approval/);
  assert.equal(evaluateOrcaAgentSettings({ agentDefaultSurface: 'terminal', nativeChatProviders: { claude: true } }).surface, 'chat');
  assert.equal(evaluateOrcaAgentSettings({ agentDefaultSurface: 'terminal' }).surface, 'terminal');
  assert.equal(evaluateOrcaAgentSettings({ agentDefaultSurface: 'chat', nativeChatProviders: { codex: false } }, 'codex').surface, 'terminal');
  assert.equal(evaluateOrcaAgentSettings({}).surface, 'unknown');
  assert.match(evaluateOrcaAgentSettings({ agentDefaultSurface: 'terminal', agentPermissionDefault: 'full-access' }).warnings[0], /Full access/);
  assert.match(evaluateOrcaAgentSettings({ agentDefaultSurface: 'terminal', agentPermissionDefault: 'accept-edits' }).warnings[0], /Accept edits/);
  assert.deepEqual(evaluateOrcaAgentSettings(null), { agent: 'claude', surface: 'unknown', permissionMode: null, warnings: [] });
});

test('readOrcaAgentSettings reads the active profile database read-only and reports missing or unreadable state', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'orca-home-')); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: path.join(home, 'cfg') };
  assert.deepEqual(await readOrcaAgentSettings({ platform: 'linux', env, home }), { available: false, reason: 'orca_profile_index_missing' });
  const inspected = await inspectOrcaAgentSettings({ agent: 'claude', platform: 'linux', env, home });
  assert.equal(inspected.available, false); assert.equal(inspected.surface, 'unknown'); assert.match(inspected.warnings[0], /comprueba a mano/);
  assert.deepEqual((await inspectOrcaAgentSettings({ agent: 'codex', platform: 'linux', env, home })).warnings, []);
  const directory = path.join(env.XDG_CONFIG_HOME, 'orca'); await fs.mkdir(path.join(directory, 'profiles', 'p-test'), { recursive: true });
  await fs.writeFile(path.join(directory, 'orca-profile-index.json'), JSON.stringify({ schemaVersion: 1, activeProfileId: 'p-test' }));
  assert.deepEqual(await readOrcaAgentSettings({ platform: 'linux', env, home }), { available: false, reason: 'orca_profile_state_missing', profileId: 'p-test' });
  const database = path.join(directory, 'profiles', 'p-test', 'profile-state.db');
  let python = true;
  try { await promisify(execFile)('python3', ['-I', '-c', 'import sqlite3'], { timeout: 5000 }); } catch { python = false; }
  if (!python) { t.diagnostic('python3 con sqlite3 no disponible; se omite la lectura real'); return; }
  const settings = { agentDefaultSurface: 'chat', nativeChatProviders: { claude: true }, agentPermissionDefault: 'ask', nativeChatPermissionMode: 'ask', theme: 'dark' };
  await promisify(execFile)('python3', ['-I', '-c', `
import sqlite3, json, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT, domain_version INTEGER, revision INTEGER, updated_at INTEGER, content_hash TEXT)")
c.execute("INSERT INTO profile_state_documents VALUES ('settings', ?, 1, 1, 0, 'x')", (sys.argv[2],))
c.execute("INSERT INTO profile_state_documents VALUES ('ui', '{}', 1, 1, 0, 'y')")
c.commit(); c.close()`, database, JSON.stringify(settings)], { timeout: 10_000 });
  const before = await fs.stat(database);
  const read = await readOrcaAgentSettings({ platform: 'linux', env, home });
  assert.deepEqual(read, { available: true, profileId: 'p-test', settings: { agentDefaultSurface: 'chat', nativeChatProviders: { claude: true }, agentPermissionDefault: 'ask', nativeChatPermissionMode: 'ask' } });
  assert.equal((await fs.stat(database)).mtimeMs, before.mtimeMs, 'the database is never written');
  const result = await inspectOrcaAgentSettings({ agent: 'claude', platform: 'linux', env, home });
  assert.equal(result.available, true); assert.equal(result.surface, 'chat'); assert.equal(result.permissionMode, 'ask'); assert.equal(result.warnings.length, 2);
  await fs.writeFile(database, 'not a database');
  assert.equal((await readOrcaAgentSettings({ platform: 'linux', env, home })).reason, 'orca_settings_unreadable');
});
