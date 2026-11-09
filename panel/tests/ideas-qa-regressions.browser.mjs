// Offline regressions: all requests fulfilled locally; no listener or real data.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const data = {
  executor: { available: true }, checkouts: [], queue: {}, jobs: [], projects: [],
  ideas: [{ id: 'offline-focus', business: 'agency', title: 'Idea simulada', text: 'Texto simulado para QA', focus: 'ux', tags: [], status: 'active', version: 1 }],
  questions: [], domains: [], tasks: [], messages: [], settings: { autoRun: false, vaultPath: '', telegram: false },
};
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Keep automatic refresh from racing the explicit, reproducible scenarios.
  await page.addInitScript(() => { window.setInterval = () => 0; });
  let failState = true, stateGets = 0, unexpected = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:43894' || request.method() !== 'GET') {
      unexpected.push(request.url()); return route.abort();
    }
    if (url.pathname === '/api/state') {
      stateGets++;
      return route.fulfill(failState ? { status: 503, json: { error: 'Fallo simulado' } } : { json: data });
    }
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    if (url.pathname === '/api/config') return route.fulfill({ json: data.settings });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'ideas-view.js', 'requests-view.js', 'style.css'].includes(name)) {
      unexpected.push(request.url()); return route.abort();
    }
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://127.0.0.1:43894/#ideas');
  const error = page.locator('#ideas-load-error'), list = page.locator('#ideas-list');
  await error.waitFor({ state: 'visible' });
  assert.match(await page.getByRole('alert').textContent(), /No se pudieron cargar/);
  assert.equal(await list.getAttribute('aria-busy'), 'false');
  assert.equal(await list.textContent(), '', 'initial failure must not claim an empty collection');
  assert.equal(stateGets, 1);
  failState = false;
  await page.getByRole('button', { name: 'Reintentar', exact: true }).focus();
  await page.keyboard.press('Enter');
  const card = page.locator('#idea-offline-focus'); await card.waitFor();
  assert.equal(await error.isHidden(), true);
  assert.equal(await list.getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#ideas-load-message').isVisible(), false);
  assert.equal(stateGets, 2);

  for (const close of ['Escape', 'Cancelar']) {
    const before = stateGets;
    const edit = card.getByRole('button', { name: 'Editar', exact: true });
    await edit.click();
    await page.locator('#idea-dialog').waitFor({ state: 'visible' });
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('#idea-dialog-cancel').click();
    await page.locator('#idea-dialog').waitFor({ state: 'hidden' });
    // Wait beyond the action's promise continuation: this caught the QA defect.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await edit.evaluate(button => document.activeElement === button), `${close} restores original Edit control`);
    assert.equal(stateGets, before, 'cancelling must not refresh and replace the opener');
  }
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  await card.getByRole('button', { name: 'Editar', exact: true }).evaluate(button => button.remove());
  await page.keyboard.press('Escape');
  await page.locator('#idea-dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.ok(await card.locator('summary').evaluate(node => document.activeElement === node), 'missing opener returns to useful card control');

  // A refresh failure must leave the actual card DOM and contents intact.
  const snapshot = await list.innerHTML();
  await card.evaluate(node => { window.offlineCard = node; });
  failState = true;
  await page.locator('#refresh').click(); await error.waitFor({ state: 'visible' });
  assert.match(await page.getByRole('alert').textContent(), /última lista cargada/);
  assert.equal(await list.innerHTML(), snapshot);
  assert.ok(await card.evaluate(node => node === window.offlineCard));
  assert.equal(await list.getAttribute('aria-busy'), 'false');
  failState = false;
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await error.waitFor({ state: 'hidden' });
  await card.getByRole('button', { name: 'Editar', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  await card.evaluate(node => node.remove());
  await page.keyboard.press('Escape');
  await page.locator('#idea-dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'ideas-status', 'missing card returns to stable list filter');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS: Escape/Cancel restore opener, missing opener/card fallback, initial GET failure, keyboard retry recovery, later failure preserves list; zero network/listeners/mutations');
} finally { await browser.close(); }
