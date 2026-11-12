// «Actualizar el Centro»: the banner lists main's new commits and starts the update, also on a phone.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const dashboard = new URL('../dashboard/', import.meta.url);
const browser = await chromium.launch({ headless: true });

const state = { executor: { available: true }, checkouts: [], queue: {}, jobs: [], projects: [], ideas: [], questions: [], domains: [], tasks: [], messages: [],
  settings: { autoRun: false, vaultPath: '', telegram: false, runtime: { startupAt: '2026-11-12T00:00:00.000Z' } },
  automation: { businesses: { agency: true, games: false }, receipts: [], history: [], integrations: {} } };
const REMOTE = 'b'.repeat(40);
const available = phase => ({ branch: 'main', head: 'a'.repeat(40), remote: REMOTE, available: true, canUpdate: true, behind: 2, ahead: 0, dirty: false, reason: null, fetchError: null,
  commits: [{ sha: 'bbbbbbb', author: 'Dani', date: '2026-11-12T00:00:00+01:00', subject: 'Añade el botón Descartar petición para solicitudes atascadas (#29)' }, { sha: 'ccccccc', author: 'David', date: '2026-11-12T00:01:00+01:00', subject: 'Comando vincular' }],
  operation: phase ? { phase, message: 'Pasando las pruebas de bbbbbbb en una copia aparte…' } : { phase: 'idle' } });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(6000);
  const posts = [], errors = [];
  let phase = null;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:43912') return route.abort();
    if (request.method() !== 'GET') { posts.push({ path: url.pathname, body: request.postDataJSON() }); phase = 'probando'; return route.fulfill({ status: 202, json: { phase } }); }
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
    if (url.pathname === '/api/update') return route.fulfill({ json: available(phase) });
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false, nodes: [], edges: [] } });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    return route.fulfill({ body: await fs.readFile(new URL(name, dashboard)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html' });
  });
  await page.goto('http://127.0.0.1:43912/#inicio', { waitUntil: 'domcontentloaded' });
  const banner = page.locator('#update-banner');
  await banner.getByText('Versión nueva del Centro: 2 cambios en main.').waitFor();
  await banner.getByRole('button', { name: 'Ver cambios' }).click();
  assert.match(await banner.innerText(), /Descartar petición.*Dani/s);
  await banner.getByRole('button', { name: 'Actualizar ahora' }).click();
  await banner.getByText('Pasando las pruebas de bbbbbbb en una copia aparte…').waitFor();
  assert.deepEqual(posts, [{ path: '/api/update', body: { confirm: true, target: REMOTE } }]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `no horizontal overflow on a phone (${overflow})`);
  assert.deepEqual(errors, []);
  console.log('ok - update banner');
} finally {
  await browser.close();
}
