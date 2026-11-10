import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { orcaUserDataDir } from './local-tools.mjs';

// 25: read-only look at the Orca settings that decide how a Claude worker is
// opened (Chat vs Terminal) and which permission mode it gets. Nothing is written.
const SETTING_KEYS = ['agentDefaultSurface', 'nativeChatProviders', 'agentPermissionDefault', 'nativeChatPermissionMode'];
const SQLITE_READ = String.raw`
import sys,json,sqlite3,pathlib
c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
c.execute('PRAGMA query_only=ON')
try:
 row=c.execute("SELECT payload FROM profile_state_documents WHERE domain='settings'").fetchone()
 print(json.dumps(json.loads(row[0]) if row else None,ensure_ascii=True))
finally:
 c.close()
`;

export function orcaProfileStatePath({ platform = process.platform, env = process.env, home = os.homedir(), profileId = 'local-default' } = {}) {
  const directory = orcaUserDataDir({ platform, env, home });
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return { index: join(directory, 'orca-profile-index.json'), database: join(directory, 'profiles', profileId, 'profile-state.db') };
}

export async function readOrcaAgentSettings({ platform = process.platform, env = process.env, home = os.homedir(), readFile = fs.readFile, execute = promisify(execFile) } = {}) {
  let profileId = 'local-default';
  try {
    const index = JSON.parse(await readFile(orcaProfileStatePath({ platform, env, home }).index, 'utf8'));
    if (typeof index?.activeProfileId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(index.activeProfileId)) profileId = index.activeProfileId;
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, reason: 'orca_profile_index_missing' };
    return { available: false, reason: 'orca_profile_index_unreadable' };
  }
  const { database } = orcaProfileStatePath({ platform, env, home, profileId });
  try { await fs.access(database); } catch { return { available: false, reason: 'orca_profile_state_missing', profileId }; }
  try {
    const { stdout } = await execute(platform === 'win32' ? 'python' : 'python3', ['-I', '-c', SQLITE_READ, database], { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const payload = JSON.parse(stdout);
    if (!payload || typeof payload !== 'object') return { available: false, reason: 'orca_settings_missing', profileId };
    return { available: true, profileId, settings: Object.fromEntries(SETTING_KEYS.map(key => [key, payload[key]])) };
  } catch { return { available: false, reason: 'orca_settings_unreadable', profileId }; }
}

// Pure. `surface` is how Orca will open a worker of this agent; warnings are operator-facing.
export function evaluateOrcaAgentSettings(settings, agent = 'claude') {
  if (!settings || typeof settings !== 'object') return { agent, surface: 'unknown', permissionMode: null, warnings: [] };
  const perProvider = settings.nativeChatProviders?.[agent];
  const surface = perProvider === false ? 'terminal' : perProvider === true ? 'chat'
    : settings.agentDefaultSurface === 'terminal' ? 'terminal' : settings.agentDefaultSurface === 'chat' ? 'chat' : 'unknown';
  const permissionMode = typeof settings.agentPermissionDefault === 'string' ? settings.agentPermissionDefault : null;
  const warnings = [];
  if (surface === 'chat') warnings.push(`Orca abrirá los trabajadores ${agent} como sesión de chat (structured): sin terminal, la cola no puede observar la salida en vivo y la prueba E2E solo cerró etapas con trabajadores de Terminal. Cambia Settings → Agents → «Open agents as» a Terminal para ${agent}.`);
  if (surface === 'unknown') warnings.push(`No se pudo determinar si Orca abre ${agent} como Terminal; comprueba Settings → Agents → «Open agents as».`);
  if (permissionMode === 'ask') warnings.push('Settings → Agents → «Agent Permissions» está en «Ask for approval»: cada comando del trabajador pedirá aprobación y la etapa no terminará sola. Recomendado «Approve for me» (auto) junto con la plantilla de permisos del checkout.');
  if (permissionMode === 'accept-edits') warnings.push('«Accept edits» aprueba ediciones pero sigue pidiendo aprobación para los comandos Bash de verificación; recomendado «Approve for me» (auto) con la plantilla de permisos.');
  if (permissionMode === 'full-access') warnings.push('«Full access» ejecuta cualquier comando sin diálogo: la plantilla deny de .claude/settings.local.json del checkout es la única barrera. Úsalo solo con checkouts de prueba.');
  return { agent, surface, permissionMode, warnings };
}

export async function inspectOrcaAgentSettings({ agent = 'claude', ...options } = {}) {
  const read = await readOrcaAgentSettings(options);
  if (!read.available) return { agent, available: false, reason: read.reason, surface: 'unknown', permissionMode: null, warnings: agent === 'claude' ? [`No se pudo leer la configuración de Orca (${read.reason}); comprueba a mano que ${agent} se abre como Terminal.`] : [] };
  return { available: true, profileId: read.profileId, ...evaluateOrcaAgentSettings(read.settings, agent) };
}
