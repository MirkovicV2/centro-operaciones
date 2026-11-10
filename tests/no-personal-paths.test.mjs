import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Improvement 11: personal paths live in local, unversioned configuration.
const root = fileURLToPath(new URL('../', import.meta.url));
const PERSONAL = [/C:\\Users\\brank/i, /\/home\/genius\b/, /Proyectos Dani/];

test('tracked files carry no personal paths; centro.cmd resolves Node from the user profile or centro.local.cmd', async () => {
  let tracked;
  try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean); }
  catch { return; } // Not a git checkout (exported copy): nothing to enforce.
  const offenders = [];
  const self = path.relative(root, fileURLToPath(import.meta.url)).replaceAll('\\', '/');
  for (const file of tracked.filter(name => name !== self && /\.(md|mjs|js|json|cmd|ps1|yml|toml|txt)$/.test(name))) {
    const text = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const pattern of PERSONAL) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(offenders, []);
  const launcher = await readFile(path.join(root, 'centro.cmd'), 'utf8');
  assert.match(launcher, /centro\.local\.cmd/); assert.match(launcher, /%USERPROFILE%\\Documents\\Proyectos\\FlechaTrampa/);
  assert.match(await readFile(path.join(root, '.gitignore'), 'utf8'), /^centro\.local\.cmd$/m);
});
