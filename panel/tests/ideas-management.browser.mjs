// Offline development verification. Every request is intercepted; only temporary fixtures mutate.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createIdea, createProject, mutateIdea, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { sendIdeaToQueue } from '../agency-assistant/idea-workflow.mjs';
import { loadState, summarize } from '../queue.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ideas-browser-'));
let browser;
try {
  const project = await createProject(root, 'Proyecto temporal', 'agency');
  const idea = await createIdea(root, 'agency', 'Idea original para teclado y móvil', project.id, 'browser-capture', { focus: 'ux', tags: ['mobile'] });
  await createIdea(root, 'games', 'Idea de otro negocio', '', 'games-capture');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 760 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()); assert.equal(url.origin, 'http://127.0.0.1:43893');
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      try {
        const match = url.pathname.match(/^\/api\/ideas\/([^/]+)\/(update|trash|archive|restore|send)$/);
        assert.ok(match, `Unexpected mutation: ${url.pathname}`);
        const result = match[2] === 'send' ? await sendIdeaToQueue(root, match[1], body.kind, '', body.confirmation) : await mutateIdea(root, match[1], match[2], body);
        return route.fulfill({ json: result });
      } catch (error) { return route.fulfill({ status: 400, json: { error: error.message } }); }
    }
    if (url.pathname === '/api/state') {
      const queue = await loadState(root), inbox = await loadDashboardState(root);
      return route.fulfill({ json: { ...inbox, executor: { available: true }, checkouts: [], queue: summarize(queue), jobs: queue.jobs, domains: [], tasks: [], settings: { autoRun: false, vaultPath: '', telegram: false } } });
    }
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'ideas-view.js', 'style.css'].includes(name));
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://127.0.0.1:43893/#ideas');
  const card = page.locator(`#idea-${idea.id}`);
  await card.waitFor(); assert.equal(await page.locator('#ideas-list article').count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  if (process.env.IDEAS_ARTIFACTS) {
    await fs.mkdir(process.env.IDEAS_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(process.env.IDEAS_ARTIFACTS, 'ideas-320.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 640, height: 900 });
  await page.evaluate(() => { document.body.style.zoom = '2'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 640), '200% layout must reflow without horizontal scrolling');
  await page.evaluate(() => { document.body.style.zoom = ''; });
  await page.setViewportSize({ width: 320, height: 760 });
  await card.getByRole('button', { name: 'Editar', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'idea-dialog-cancel');
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    assert.ok(await page.evaluate(() => !!document.activeElement.closest('#idea-dialog')), 'native dialog traps keyboard focus');
  }
  if (process.env.IDEAS_ARTIFACTS) await page.screenshot({ path: path.join(process.env.IDEAS_ARTIFACTS, 'editor-320.png') });
  await page.locator('#idea-dialog [name=text]').fill('Texto editado que debe conservarse al fallar');
  await page.locator('#idea-dialog [name=tags]').fill('a'.repeat(25));
  await page.locator('#idea-dialog-submit').click();
  await page.getByText('Cada etiqueta debe tener entre 1 y 24 caracteres.', { exact: true }).waitFor();
  assert.equal(await page.locator('#idea-dialog [name=text]').inputValue(), 'Texto editado que debe conservarse al fallar');
  await page.locator('#idea-dialog [name=tags]').fill('mobile, MOBILE, accesibilidad');
  await page.locator('#idea-dialog-submit').click();
  await page.locator('#idea-dialog').waitFor({ state: 'hidden' });
  await card.getByText('accesibilidad', { exact: false }).first().waitFor();
  const updated = (await loadDashboardState(root)).ideas.find(item => item.id === idea.id);
  assert.equal(updated.version, 2); assert.deepEqual(updated.capture, idea.capture);
  await card.getByRole('button', { name: 'Eliminar idea', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'idea-dialog-cancel');
  await page.keyboard.press('Escape'); assert.equal((await loadDashboardState(root)).ideas.find(item => item.id === idea.id).status, 'active');
  await card.getByRole('button', { name: 'Eliminar idea', exact: true }).click(); await page.locator('#idea-dialog-submit').click();
  await card.waitFor({ state: 'detached' });
  await page.locator('#ideas-status').selectOption('trash'); await card.waitFor();
  await page.reload(); await card.waitFor();
  await card.getByRole('button', { name: 'Restaurar idea', exact: true }).click(); await page.locator('#idea-dialog-submit').click(); await card.waitFor({ state: 'detached' });
  await page.locator('#ideas-status').selectOption('active'); await card.waitFor();
  await card.getByRole('button', { name: 'Enviar al planificador', exact: true }).click();
  await page.locator('#idea-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('.idea-brief').textContent(), /Foco: Diseño UX/);
  await page.locator('#idea-dialog-submit').click(); await page.locator('#idea-dialog').waitFor({ state: 'hidden' });
  const jobs = (await loadState(root)).jobs; assert.equal(jobs.length, 1); assert.equal(jobs[0].attempts, 0);
  assert.ok(jobs[0].prompt.includes('Etiquetas: mobile, accesibilidad'));
  await page.locator('#business-context').selectOption('games');
  await page.goto('http://127.0.0.1:43893/#ideas'); await page.getByText('Idea de otro negocio', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#ideas-status').inputValue(), 'active'); assert.deepEqual(errors, []);
  console.log('PASS: offline 320px, cancel focus/Escape, server errors preserve draft, edit/version, trash/reload/restore, business preferences, full brief and one queued job with zero attempts');
} finally { await browser?.close(); await fs.rm(root, { recursive: true, force: true }); }
