// Offline regression for the redesigned views. All requests are intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const assets = new URL('../dashboard/', import.meta.url);
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 1440]) {
    const snapshot = {
      jobs: [{
        id: 'approved', business: 'agency', title: 'Candidato aprobado', state: 'succeeded',
        kind: 'code', attempts: 1, maxAttempts: 5, createdAt: '2026-11-10',
        autoIntent: { eligible: true, receiptId: 'receipt-approved' },
        workflow: { steps: [
          { key: 'developer', label: 'Desarrollo', status: 'succeeded', dispatchId: 'ctx_dev' },
          { key: 'reviewer', label: 'Revisión', status: 'succeeded',
            workflowV2: { task: 'v2-approved', outcome: 'approved', status: 'aprobado' } },
        ] },
      }],
      queue: {}, projects: [], ideas: [], questions: [], domains: [], tasks: [], messages: [],
      settings: {}, executor: { available: true },
    };
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'http://127.0.0.1:43892');
      assert.equal(route.request().method(), 'GET');
      if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js', 'requests-view.js'].includes(name));
      return route.fulfill({ body: await fs.readFile(new URL(name, assets)),
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://127.0.0.1:43892/#trabajo/approved');
    await page.getByRole('heading', { name: 'Candidato aprobado', exact: true }).waitFor();
    assert.match(await page.locator('.lifebar').innerText(), /Aprobada \(Workflow V2\)/);
    assert.match(await page.locator('.lifebar').innerText(), /Aceptada por ti/);
    await page.locator('.nav-link[href="#historial"]').click();
    assert.match(await page.locator('.history-facts').innerText(), /Integración\s*Sin registro/);
    snapshot.jobs[0].title = 'Título actualizado';
    await page.evaluate(() => refresh());
    assert.equal(await page.locator('.history-report-title').innerText(), 'Título actualizado');
    await page.locator('#business-context').selectOption('games');
    await page.evaluate(() => refresh());
    await page.goto('http://127.0.0.1:43892/#trabajo/approved');
    await page.locator('#run-page').getByText('No hay ningún trabajo #approved en este negocio.', { exact: true }).waitFor();
    assert.equal(await page.locator('#run-page .run-title').count(), 0);
    for (const section of ['ideas', 'conocimiento']) {
      await page.locator('.nav-link[href="#' + section + '"]').click();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), section + ' overflows at ' + width);
    }
    assert.deepEqual(errors, []);
    console.log('PASS redesigned views at ' + width + 'px: V2 approval, truthful history, refresh, business isolation and layout');
    await page.close();
  }
} finally {
  await browser.close();
}
