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
  || localExecutable('orca', 'orca', 'resources', 'bin', 'orca.exe');
export const CODEX_EXE = localExecutable('codex', 'OpenAI', 'Codex', 'bin', 'codex.exe');
