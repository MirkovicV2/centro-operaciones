import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function localExecutable(command, ...windowsPath) {
  if (process.platform !== 'win32') return command;
  const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const installed = path.join(localAppData, 'Programs', ...windowsPath);
  return existsSync(installed) ? installed : command + '.exe';
}

export const ORCA_EXE = process.env.ORCA_CLI_COMMAND || process.env.ORCA_CLI
  || (process.platform === 'linux' ? 'orca-ide' : localExecutable('orca', 'orca', 'resources', 'bin', 'orca.exe'));
export function configuredOrcaAgent(env = process.env) {
  const agent = env.CENTRO_ORCA_AGENT?.trim() || 'codex';
  if (!['codex', 'claude'].includes(agent)) {
    throw Object.assign(new Error('CENTRO_ORCA_AGENT debe ser codex o claude.'), { code: 'orca_agent_invalid' });
  }
  return agent;
}

export const CODEX_EXE = localExecutable('codex', 'OpenAI', 'Codex', 'bin', 'codex.exe');

// Orca's per-user data directory. Windows keeps APPDATA; Linux follows XDG (observed on
// Ubuntu 26.10: ~/.config/orca); macOS uses Application Support (hypothesis, not verified).
export function orcaUserDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'orca');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'orca');
  return path.posix.join(env.XDG_CONFIG_HOME?.trim() || path.posix.join(home, '.config'), 'orca');
}
