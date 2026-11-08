import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const axeSource = await fs.readFile(process.env.AXE_SOURCE || new URL('../../workspaces/portfolio-motion/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const dashboard = new URL('../dashboard/', import.meta.url);
const browser = await chromium.launch({ headless: true });
const evidence = [];
const sha = 'a'.repeat(40), mergeSha = 'b'.repeat(40);
function fixture(kind) {
  const missingBase = kind === 'base-absent';
  const phase = ({ approved: 'preflight_complete', push: 'complete', pending: 'pr_confirmed', failed: 'checks_pending', merged: 'complete' })[kind];
  const source = kind === 'push' ? 'main' : 'feature/ui';
  const base = missingBase ? '' : (kind === 'push' ? 'main' : 'develop');
  const attention = kind === 'failed';
  const steps = ['ux', 'developer', 'qa', 'reviewer'].map(key => ({ key, label: key, profile: key, status: 'succeeded' }));
  steps.push({ key: 'integration', label: 'Integración GitHub', status: attention ? 'blocked' : 'running', summary: attention ? 'Checks fallidos: lint' : 'Persistido por backend' });
  const job = { id: `fixture-${kind}`, business: 'agency', title: `Trabajo fixture ${kind}`, state: attention ? 'needs_attention' : 'succeeded', kind: 'code', attempts: 1, maxAttempts: 2, createdAt: '2026-11-08T00:00:00.000Z', projectId: 'project-fixture', projectName: 'Proyecto fixture', branch: source, destination: { repository: 'owner/repo', baseBranch: base, checkout: 'workspaces/fixture', verified: true, sha }, autoIntent: { eligible: true, receiptId: `receipt-${kind}` }, workflow: { currentStage: attention ? 'integration' : null, steps }, error: attention ? { message: 'Checks requeridos fallaron: lint' } : null };
  const integration = missingBase ? null : {
    jobId: job.id, receiptId: `receipt-${kind}`, repository: 'owner/repo', sourceBranch: source, baseBranch: base,
    phase, status: kind === 'pending' ? 'running' : kind === 'failed' ? 'checks_pending' : kind === 'merged' || kind === 'push' ? 'completed' : 'running',
    ...(kind !== 'approved' ? { commitSha: sha } : {}),
    ...(kind === 'pending' || kind === 'failed' || kind === 'merged' ? { prNumber: 7, prUrl: 'https://github.com/owner/repo/pull/7' } : {}),
    ...(kind === 'merged' ? { mergeSha } : {}),
  };
  const manual = { id: 'fixture-manual', business: 'agency', title: 'Trabajo manual completado', state: 'succeeded', kind: 'code', attempts: 1, maxAttempts: 2, createdAt: '2026-11-08T00:00:00.000Z', workflow: { steps } };
  return {
    executor: { available: true }, checkouts: [{ value: 'workspaces/fixture', valid: true, branch: source }], queue: {},
    jobs: [job, manual], projects: [{ id: 'project-fixture', name: 'Proyecto fixture', business: 'agency', status: 'active', stages: ['UX', 'Desarrollo', 'QA', 'Revisión'], stageIndex: 3, checkout: 'workspaces/fixture', branch: source, repository: 'owner/repo', baseBranch: base, nextAction: '' }],
    ideas: [], questions: [], domains: [], tasks: [], messages: [], settings: { autoRun: false, vaultPath: '', telegram: false },
    automation: { businesses: { agency: false, games: false }, receipts: [{ id: `receipt-${kind}`, jobId: job.id, business: 'agency', eligible: true, status: attention ? 'needs_attention' : 'completed', reason: attention ? 'Checks requeridos fallaron: lint' : '' }], history: [], integrations: integration ? { [`receipt-${kind}`]: integration } : {} },
  };
}
try {
  for (const width of [320, 390, 1440]) {
    for (const kind of ['approved', 'push', 'pending', 'failed', 'merged', 'base-absent']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(6000);
      const posts = [], external = [], pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== 'http://127.0.0.1:43901') { external.push(url.href); return route.abort(); }
        if (request.method() !== 'GET') { posts.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        if (url.pathname === '/api/state') return route.fulfill({ json: fixture(kind) });
        if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
        if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false, nodes: [], edges: [] } });
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js'].includes(name), name);
        return route.fulfill({ body: await fs.readFile(new URL(name, dashboard)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
      });
      await page.goto('http://127.0.0.1:43901/#trabajos', { waitUntil: 'domcontentloaded' });
      await page.locator('#jobs-list').waitFor();
      const card = page.locator(`#job-fixture-${kind}`);
      await card.waitFor({ state: 'attached' });
      if (kind === 'base-absent') {
        await page.locator('.nav-link[href="#proyectos"]').click();
        const field = page.locator('#proyectos input[name="baseBranch"]');
        await field.waitFor({ state: 'visible' });
        const described = await field.getAttribute('aria-describedby');
        assert.ok(described, 'base branch must describe itself');
        const helpIds = described.split(/\s+/);
        const helpText = await Promise.all(helpIds.map(id => page.locator(`#${id}`).textContent()));
        assert.match(helpText.join(' '), /Rama existente que recibe la PR o el merge/);
        assert.match(helpText.join(' '), /Rama fuente observada: feature\/ui.*configuración pendiente/);
        assert.equal(await field.getAttribute('aria-invalid'), 'true');
        await page.locator('#proyectos .project-update-form button[type=submit]').click();
        assert.equal(await field.evaluate(el => el === document.activeElement), true, 'missing base save must focus the field');
        assert.match(await page.locator(`#${helpIds[0]}`).textContent(), /Configuración pendiente/);
        const projectBox = await page.locator('#proyectos .project-card').boundingBox();
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(projectBox.width <= width && layout.scrollWidth <= width, JSON.stringify({ projectBox, layout }));
      } else {
        await page.locator('.nav-link[href="#trabajos"]').click();
        if (kind !== 'failed') await page.locator('#history > summary').click();
        await card.locator(':scope > summary').click();
        const integrationBox = card.locator('.job-integration');
        await integrationBox.waitFor({ state: 'visible' });
        const text = await integrationBox.innerText();
        assert.match(text, /Origen .* → destino/);
        assert.match(text, /Aprobación local de UX, Desarrollo, QA y Revisión confirmada/);
        const sourceRecord = fixture(kind).automation.integrations[`receipt-${kind}`];
        assert.ok(sourceRecord, 'integration UI must be backed by persisted API fixture');
        if (kind === 'approved') {
          assert.match(text, /Aprobación local confirmada/);
          assert.doesNotMatch(text, /Push remoto confirmado|Merge confirmado/);
        }
        if (kind === 'push') { assert.match(text, /Push confirmado/); assert.match(text, new RegExp(`Commit SHA: ${sha}`)); assert.doesNotMatch(text, /Merge confirmado/); }
        if (kind === 'pending') { assert.match(text, /PR confirmada · checks pendientes/); assert.match(text, /PR #7/); assert.doesNotMatch(text, /Merge confirmado/); }
        if (kind === 'failed') {
          assert.match(text, /Necesita revisión · PR\/checks pendientes o fallidos/);
          assert.match(text, /PR\/checks pendientes/); assert.match(text, /Motivo: Checks requeridos fallaron: lint/);
          const banner = page.locator('#global-blockers');
          assert.match(await banner.innerText(), /#fixture-failed · Trabajo fixture failed/);
          assert.match(await banner.innerText(), /Checks requeridos fallaron: lint/);
          await banner.getByRole('button', { name: 'Abrir en Trabajos y revisar' }).click();
          assert.equal(await page.evaluate(() => location.hash), '#trabajos');
          assert.equal(await page.locator('#job-fixture-failed').getAttribute('open') !== null, true);
        }
        if (kind === 'merged') { assert.match(text, /Merge confirmado/); assert.match(text, new RegExp(`Merge SHA: ${mergeSha}`)); assert.match(text, /PR #7/); }
        const manual = page.locator('#job-fixture-manual .job-integration');
        assert.equal(await manual.count(), 0, 'manual jobs must never show a fabricated integration');
        const cardBox = await card.boundingBox() || await page.locator('#global-blockers').boundingBox();
        const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
        assert.ok(cardBox.width <= width && layout.scrollWidth <= width, JSON.stringify({ cardBox, layout }));
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, outlineStyle: getComputedStyle(document.activeElement).outlineStyle, outlineWidth: getComputedStyle(document.activeElement).outlineWidth }));
        assert.notEqual(focus.tag, 'BODY');
        assert.notEqual(focus.outlineStyle, 'none');
        await page.addScriptTag({ content: axeSource });
        const audit = await integrationBox.evaluate(async root => {
          const result = await axe.run(root, { runOnly: { type: 'rule', values: ['color-contrast', 'link-name'] } });
          return result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }));
        });
        assert.deepEqual(audit, [], JSON.stringify(audit));
      }
      assert.deepEqual(posts, [], 'browser must not mutate real/API data');
      assert.deepEqual(external, [], 'browser must not access network');
      assert.deepEqual(pageErrors, []);
      evidence.push({ viewport: width, fixture: kind, persistedIntegrationPhase: fixture(kind).automation.integrations?.[`receipt-${kind}`]?.phase || null, posts, external, pageErrors });
      await page.close();
      console.log(`PASS ${width}px ${kind}: backend evidence and text assertions, no overflow/network/writes`);
    }
  }
  const report = new URL('../.artifacts/github-integration-ui/', import.meta.url);
  await fs.mkdir(report, { recursive: true });
  await fs.writeFile(new URL('results.json', report), JSON.stringify(evidence, null, 2));
  await fs.writeFile(new URL('summary.md', report), '# Integración GitHub UI · browser offline\n\nFixtures `approved`, `push`, `pending`, `failed`, `merged` y `base-absent` pasaron a 320, 390 y 1440 px. El harness intercepta todas las peticiones, rechaza red externa y escrituras, compara el texto visible con los registros persistidos de API, verifica ayuda/aria-describedby/foco para base ausente, navegación contextual de bloqueo, foco de teclado y axe (`color-contrast`, `link-name`). Evidencia por viewport en `results.json`. El cierre del browser está protegido por `finally`.\n');
} finally { await browser.close(); }
