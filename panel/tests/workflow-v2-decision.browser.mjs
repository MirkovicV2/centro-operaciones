// The owner's Workflow V2 decision on the job page: live state, exact command, candidate files and
// the integrate button only once V2 shows the task approved (Encargo 2 of home-finance).
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const dashboard = new URL('../dashboard/', import.meta.url);
const browser = await chromium.launch({ headless: true });
const TASK = 'coord-v2-code-73e486a80094';
const COMMAND = `cd /home/u/dev/engineering-system && python3 -m wfv2.cli --repo /home/u/dev/wfv2-state/home-finance approve ${TASK}`;
const steps = [
  ...['ux', 'developer', 'qa'].map(key => ({ key, label: key, profile: key, status: 'succeeded' })),
  { key: 'reviewer', label: 'Revisión de código', profile: 'revisor_agency', status: 'blocked', error: 'workflow_v2_owner_pending', summary: 'Decide en V2.', workflowV2: { task: TASK, status: 'pendiente_owner' } },
  { key: 'integration', label: 'Integración GitHub', status: 'queued' },
];
const job = { id: 'coord-v2-code', business: 'agency', title: 'Encargo V2', state: 'needs_attention', kind: 'code', attempts: 2, maxAttempts: 5, createdAt: '2026-11-11T00:00:00.000Z',
  projectId: 'home-finance', projectName: 'home-finance', branch: 'centro/home-finance', autoIntent: { eligible: true, receiptId: 'r-v2' },
  workflow: { currentStage: 'reviewer', steps }, error: { code: 'workflow_v2_owner_pending', message: 'Workflow V2 aún no tiene tu aprobación para este candidato.' } };
const state = { executor: { available: true }, checkouts: [], queue: {}, jobs: [job], projects: [], ideas: [], questions: [], domains: [], tasks: [], messages: [],
  settings: { autoRun: false, vaultPath: '', telegram: false },
  automation: { businesses: { agency: true, games: false }, receipts: [{ id: 'r-v2', jobId: job.id, business: 'agency', eligible: true, status: 'needs_attention' }], history: [], integrations: {} } };
const decision = status => ({
  live: { task: TASK, available: true, status, tier: 'STANDARD', required: ['unit'], accepted: ['unit'], reviews: [{ role: 'unit', recommendation: 'ACCEPT', isolation: 'DEMONSTRATED' }],
    blockedReason: null, next: status === 'aprobado' ? { action: 'integrate', text: 'Aprobada por ti: pulsa Integrar y el Centro integrará solo este candidato.' }
      : { action: 'approve', text: 'Las revisiones obligatorias están aceptadas: falta tu aprobación final de la tarea.', command: COMMAND } },
  candidate: { total: 3, files: [{ path: 'templates/base.html', change: 'modificado', binary: false }, { path: 'tests_e2e/screenshots/inicio.png', change: 'modificado', binary: true },
    { path: 'tests_e2e/screenshots/mobile-casa.png', change: 'nuevo', binary: true }] },
});
try {
  for (const [status, width] of [['pendiente_owner', 1280], ['aprobado', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(6000);
    const posts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== 'http://127.0.0.1:43911') return route.abort();
      if (request.method() !== 'GET') { posts.push(`${request.method()} ${url.pathname}`); return route.fulfill({ json: { ok: true } }); }
      if (url.pathname === '/api/state') return route.fulfill({ json: state });
      if (url.pathname === `/api/jobs/${job.id}/workflow-v2`) return route.fulfill({ json: decision(status) });
      if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
      if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false, nodes: [], edges: [] } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ body: await fs.readFile(new URL(name, dashboard)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto(`http://127.0.0.1:43911/#trabajo/${job.id}`, { waitUntil: 'domcontentloaded' });
    const section = page.locator('.run-v2');
    await section.locator('.run-v2-next').waitFor();
    const text = await section.innerText();
    assert.match(text, new RegExp(`Estado en V2: ${status}`));
    assert.match(text, /recomienda aceptar/);
    assert.match(text, /3 · 1 binarios nuevos|Archivos del candidato: 3 · 1 binarios nuevos/);
    if (status === 'pendiente_owner') {
      assert.equal(await section.locator('.run-v2-command code').innerText(), COMMAND, 'the exact approve command, not verdict');
      assert.equal(await section.getByRole('button', { name: 'Integrar este candidato' }).count(), 0, 'no integrate button before the approval');
    } else {
      assert.equal(await section.locator('.run-v2-command').count(), 0);
      await section.getByRole('button', { name: 'Integrar este candidato' }).click();
      await page.waitForTimeout(100);
      assert.deepEqual(posts, [`POST /api/jobs/${job.id}/retry`]);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `no horizontal overflow at ${width}px (${overflow})`);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('ok - workflow V2 decision section');
} finally {
  await browser.close();
}
