// Offline rendering regression: no queue writes, listeners or real workers.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const jobs = [
  { id: 'games-new', business: 'games', profile: 'desarrollador_games' },
  { id: 'games-historical', business: 'games', profile: 'desarrollador' },
  { id: 'agency-new', business: 'agency', profile: 'desarrollador_agency' },
].map(({ profile, ...job }) => ({ ...job, title: job.id, kind: 'code', state: 'queued', attempts: 0, maxAttempts: 2,
  workflow: { steps: [{ key: 'developer', label: 'Implementación', profile, status: 'queued', dispatchId: `ctx_${job.id}` }] },
}));
const before = JSON.stringify(jobs);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.method(), 'GET');
    assert.equal(url.origin, 'http://127.0.0.1:43893');
    if (url.pathname === '/api/state') return route.fulfill({ json: { jobs, projects: [], ideas: [], questions: [], domains: [], tasks: [], messages: [], checkouts: [], executor: { available: true }, settings: { autoRun: true }, queue: {} } });
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: true, vaultPath: '' } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js'].includes(name));
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://127.0.0.1:43893/#trabajos');
  await page.locator('#job-agency-new').waitFor();
  assert.equal(await page.locator('#job-agency-new .workflow-stage-label').textContent(), 'Implementación');
  await page.locator('#business-context').selectOption('games');
  const card = page.locator('#job-games-new');
  await card.waitFor(); await card.locator(':scope > summary').click();
  assert.equal(await card.locator('.workflow-stage-label').textContent(), 'Desarrollo de videojuegos (Godot)');
  assert.equal(await card.locator('.workflow-stage-profile').textContent(), 'Perfil: Desarrollador de videojuegos (Godot)');
  await card.getByText('Identificador del perfil', { exact: true }).click();
  assert.equal(await card.getByText('desarrollador_games', { exact: true }).isVisible(), true);
  assert.match(await card.textContent(), /ctx_games-new/);
  assert.equal(await page.locator('#job-games-historical .workflow-stage-profile').textContent(), 'Perfil: desarrollador');
  assert.equal(JSON.stringify(jobs), before, 'historical IDs and profiles stay unchanged');
  assert.deepEqual(errors, []);
  console.log('PASS: games human stage/profile, technical routing ID, historical profile, agency Implementación; offline 320px, zero writes');
} finally { await browser.close(); }
