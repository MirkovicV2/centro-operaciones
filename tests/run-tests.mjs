import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
for (const dir of ['.', 'tests', 'panel/tests']) {
  for (const name of await readdir(new URL('../' + dir + '/', import.meta.url))) {
    if (name.endsWith('.test.mjs')) files.push(dir + '/' + name);
  }
}
const result = spawnSync(process.execPath, ['--test', ...files.sort()], { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
