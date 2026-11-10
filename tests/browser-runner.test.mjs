import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserSuites, resolvePlaywright } from './run-browser-tests.mjs';

// Improvement 9: browser suites run only when a Playwright module exists; otherwise they are skipped visibly.
test('the runner lists the browser suites and resolves Playwright only from existing paths', async () => {
  const suites = await browserSuites();
  assert.ok(suites.length >= 7, suites.join(','));
  assert.ok(suites.every(file => file.endsWith('.browser.mjs') && !file.endsWith('.test.mjs')));
  assert.equal(await resolvePlaywright(['/nonexistent/playwright/index.mjs']), null);
  assert.equal(await resolvePlaywright([fileURLToPath(import.meta.url)]), fileURLToPath(import.meta.url));
});

test('without a Playwright module the runner exits 0 and says the suites were skipped; npm test never runs it', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run-browser-tests.mjs', import.meta.url))], { encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_MODULE: '/nonexistent/playwright/index.mjs' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pruebas de navegador omitidas \(\d+\)/);
  assert.match(result.stdout, /PLAYWRIGHT_MODULE/);
});
