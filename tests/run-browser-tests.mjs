#!/usr/bin/env node
// 9: runs the *.browser.mjs suites when a Playwright module is available and skips
// them, with exit code 0 and a visible notice, when it is not. No new dependency:
// the module path comes from PLAYWRIGHT_MODULE or from the historical checkout.
import { readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = [process.env.PLAYWRIGHT_MODULE, path.join(root, 'workspaces', 'portfolio-motion', 'node_modules', 'playwright', 'index.mjs')].filter(Boolean);

export async function resolvePlaywright(paths = candidates) {
  for (const candidate of paths) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return null;
}
export async function browserSuites(base = root) {
  const files = [];
  for (const dir of ['panel/tests', 'workspaces/agency-assistant/tests']) {
    let names = [];
    try { names = await readdir(path.join(base, dir)); } catch { continue; }
    for (const name of names) if (name.endsWith('.browser.mjs')) files.push(path.join(dir, name));
  }
  return files.sort();
}

async function main() {
  const module = await resolvePlaywright();
  const suites = await browserSuites();
  if (!module) {
    console.log(`Pruebas de navegador omitidas (${suites.length}): no hay módulo Playwright. Exporta PLAYWRIGHT_MODULE con la ruta a playwright/index.mjs de un checkout que ya lo tenga instalado; este repositorio no añade dependencias.`);
    return 0;
  }
  let failures = 0;
  for (const file of suites) {
    const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit', windowsHide: true, shell: false, env: { ...process.env, PLAYWRIGHT_MODULE: module } });
    console.log(`${result.status === 0 ? '✔' : '✖'} ${file}`);
    if (result.status !== 0) failures++;
  }
  console.log(`Pruebas de navegador: ${suites.length - failures}/${suites.length} correctas (Playwright: ${module}).`);
  return failures ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
