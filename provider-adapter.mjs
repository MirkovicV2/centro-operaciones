// Equivalent working instructions for Codex and Claude on Windows and Ubuntu. The brief is the same contract for
// both; only the concrete commands differ, because their tools and shells do:
//   Claude Code   Bash tool on every platform (Git Bash on Windows), bounded by the checkout's permission template:
//                 one simple command per call, files read with the Read tool.
//   Codex         PowerShell on Windows, a POSIX shell elsewhere.
// Paths are always quoted: the Centro may live under a folder with spaces ("Centro de Operaciones").
const posixQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
const powershellQuote = value => `'${String(value).replace(/'/g, "''")}'`;

// The literal command that prints the SHA-256 of a file for this provider and platform.
export function fingerprintCommand({ agent = 'codex', platform = process.platform, file }) {
  // JSON quoting keeps the exact text Claude's `Bash(sha256sum:*)` rule and the existing briefs use; inside
  // double quotes Git Bash reads the doubled backslashes of a Windows path as single ones.
  if (agent === 'claude') return 'sha256sum ' + JSON.stringify(file);
  if (platform === 'win32') return `(Get-FileHash -Algorithm SHA256 -LiteralPath ${powershellQuote(file)}).Hash`;
  return 'sha256sum ' + posixQuote(file);
}

const OTHER_ARTIFACTS = 'Usa el mismo comando, con su ruta entre comillas, para cualquier otro artefacto del encargo que indique su sha256 (informes de etapas anteriores, skills).';

// The line of the dispatch brief that tells a worker how to verify and read its immutable brief.
export function toolingLine({ agent = 'codex', platform = process.platform, file }) {
  const command = fingerprintCommand({ agent, platform, file });
  if (agent === 'claude') {
    return 'COMANDOS: ejecuta un comando simple por llamada, sin ;, &&, |, variables ni cd. Verifica la huella con literalmente: ' + command
      + ' y lee el archivo con tu herramienta de lectura de archivos (Read), no con cat. Las reglas de permisos del checkout solo reconocen comandos simples; un comando encadenado se bloquea o pide aprobación. ' + OTHER_ARTIFACTS;
  }
  return 'VERIFICACIÓN: calcula la huella con literalmente: ' + command + ' y compárala con SPEC_SHA256 sin distinguir mayúsculas de minúsculas'
    + (platform === 'win32' ? ' (PowerShell la muestra en mayúsculas). Lee el archivo como UTF-8 explícito. ' : '. ') + OTHER_ARTIFACTS;
}
