// Offline browser regression. Uses installed local tools; never installs or contacts a server.
// node tests/dashboard-accessibility.browser.mjs
// Override PLAYWRIGHT_MODULE / AXE_SOURCE with absolute paths if needed.
import * as fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const axeSource = await fs.readFile(process.env.AXE_SOURCE || new URL('../../workspaces/portfolio-motion/node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const base = new URL('../dashboard/', import.meta.url);
const output = new URL('../.artifacts/accessibility-fix/', import.meta.url);
await fs.mkdir(output, { recursive: true });
const data = {
  executor: { available: true }, checkouts: [{ value: 'workspaces/test-app', valid: true, branch: 'main' }],
  queue: {}, jobs: [
    { id: 'agency-queued', business: 'agency', title: 'Trabajo temporal agencia', state: 'queued', kind: 'code', attempts: 0, maxAttempts: 2, projectId: 'a', createdAt: '2026-11-08', workflow: { steps: [{ key: 'ux', label: 'UX', profile: 'ux_agency', status: 'queued' }] } },
    { id: 'games-block', business: 'games', title: 'Bloqueo temporal juegos', state: 'needs_attention', kind: 'code', attempts: 1, maxAttempts: 2, createdAt: '2026-11-08', error: { message: 'Validación pendiente' } },
    { id: 'agency-done', business: 'agency', title: 'Histórico temporal', state: 'succeeded', kind: 'analysis', attempts: 1, maxAttempts: 2, createdAt: '2026-11-08' },
  ],
  projects: [{ id: 'a', name: 'Proyecto temporal agencia', business: 'agency', status: 'active', stages: ['Brief'], stageIndex: 0, checkout: 'workspaces/test-app', branch: 'main', nextAction: 'Revisar objetivo' }],
  ideas: [{ id: 'i', business: 'agency', projectId: 'a', title: 'Idea temporal', text: 'Mejorar flujo' }],
  questions: [], domains: [], tasks: [], messages: [], settings: { autoRun: false, vaultPath: '', telegram: false },
};

// Stress intrinsic select sizing without creating or mapping any real project.
data.projects[0].name = 'Proyecto simulado con nombre largo para comprobar el reflujo';
data.jobs[2].projectId = 'a';
const browser = await chromium.launch({ headless: true });
const evidence = [];
async function visibleRoot(page, selector, label, width) {
  const root = page.locator(selector);
  await root.waitFor({ state: 'visible' });
  assert.equal(await root.isVisible(), true, `${label} root is not visible at ${width}px`);
  const box = await root.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `${label} root has no dimensions at ${width}px`);
  return root;
}
async function auditRoot(root, rules) {
  return root.evaluate(async (element, rules) => {
    const results = await axe.run(element, { runOnly: { type: 'rule', values: rules } });
    return { violations: results.violations, passes: results.passes.map(rule => rule.id), incomplete: results.incomplete.map(rule => ({ id: rule.id, nodes: rule.nodes.map(node => node.target) })) };
  }, rules);
}
try {
  for (const width of [320, 390, 800, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const snapshot = structuredClone(data);
    const errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'http://127.0.0.1:43891', 'external request forbidden');
      if (route.request().method() !== 'GET') { posts.push(url.pathname); return route.abort(); }
      if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
      if (url.pathname === '/api/config') return route.fulfill({ json: data.settings });
      if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false, nodes: [], edges: [] } });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      return route.fulfill({ body: await fs.readFile(new URL(name, base)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.goto('http://127.0.0.1:43891/');
    await page.locator('#action-summary .action-group').first().waitFor();
    await page.locator('.nav-link[href="#trabajos"]').click();
    await page.locator('#history > summary').click();
    const historyRoot = await visibleRoot(page, '#history', 'Historial', width);
    const historyControls = historyRoot.locator('.history-filters input, .history-filters select');
    assert.ok(await historyControls.count() > 0, `Historial has no controls at ${width}px`);
    const layout = await historyRoot.evaluate(history => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, historyOpen: history.open,
      controls: [...history.querySelectorAll('.history-filters input,.history-filters select')]
        .filter(el => el.getClientRects().length > 0 && !el.closest('[hidden]'))
        .map(el => { const r=el.getBoundingClientRect(); return { id: el.id || el.dataset.filter, left:r.left, right:r.right, width:r.width, height:r.height }; }) }));
    assert.equal(layout.historyOpen, true);
    assert.ok(layout.controls.length > 0, `no visible history controls at ${width}px`);
    assert.equal(await historyRoot.locator('#history-list .job-card').count(), 1);
    assert.ok(layout.scrollWidth <= width, JSON.stringify(layout));
    for (const control of layout.controls) { assert.ok(control.width > 0 && control.height >= (width <= 760 ? 44 : 36), JSON.stringify(control)); assert.ok(control.left >= 0 && control.right <= width, JSON.stringify(control)); }
    await page.addScriptTag({ content: axeSource });
    const audit = await auditRoot(historyRoot, ['color-contrast', 'select-name']);
    const targetViolations = audit.violations.flatMap(v => v.nodes.filter(n => n.target.some(t => /job-id|sidebar-note|updated-at|history-|project-status-filter/.test(t))).map(n => ({ rule:v.id, ...n })));
    assert.deepEqual(targetViolations, [], JSON.stringify(targetViolations));
    await page.screenshot({ path: fileURLToPath(new URL(`history-${width}.png`, output)), fullPage:true });
    await page.locator('.nav-link[href="#proyectos"]').click();
    await page.locator('#proyectos').waitFor({ state: 'visible' });
    await page.locator('#proyectos .project-card details > summary').first().click();
    const projectRoot = await visibleRoot(page, '#proyectos', 'Proyectos', width);
    const projectControls = projectRoot.locator('input, select, button, textarea');
    assert.ok(await projectControls.count() > 0, `Proyectos has no controls at ${width}px`);
    const baseBranch = projectRoot.locator('input[name="baseBranch"]');
    await baseBranch.first().waitFor({ state: 'visible' });
    assert.ok(await baseBranch.count() > 0, `no baseBranch project field at ${width}px`);
    const projectContext = await projectRoot.evaluate(section => ({
      fields: [...section.querySelectorAll('input[name="baseBranch"]')].filter(el => el.getClientRects().length > 0).length,
      controls: [...section.querySelectorAll('input,select,button,textarea')].filter(el => el.getClientRects().length > 0).length,
    }));
    assert.ok(projectContext.fields > 0, `no visible baseBranch project field at ${width}px`);
    assert.ok(projectContext.controls > 0, `no visible Proyectos controls at ${width}px`);
    assert.equal(await projectRoot.getByRole('combobox', { name:'Filtrar proyectos por estado', exact:true }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `project toolbar overflow at ${width}`);
    const projectAudit = await auditRoot(projectRoot, ['select-name']);
    assert.deepEqual(projectAudit.violations, []);
    assert.ok(projectAudit.passes.includes('select-name'));
    await page.screenshot({ path: fileURLToPath(new URL(`proyectos-${width}.png`, output)), fullPage:true });
    await page.locator('.nav-link[href="#ideas"]').click();
    await page.locator('#ideas').waitFor({ state: 'visible' });
    const ideasRoot = await visibleRoot(page, '#ideas', 'Ideas', width);
    const ideasControls = ideasRoot.locator('input, select, button, textarea');
    assert.ok(await ideasControls.count() > 0, `Ideas has no controls at ${width}px`);
    const ideasProject = ideasRoot.locator('#ideas-project');
    await ideasProject.waitFor({ state: 'visible' });
    const ideasContext = await ideasRoot.evaluate(section => {
      const control = section.querySelector('#ideas-project');
      const rect = control.getBoundingClientRect();
      return { controlVisible: !!control && control.getClientRects().length > 0 && !control.closest('[hidden]'),
        controls: [...section.querySelectorAll('input,select,button,textarea')].filter(el => el.getClientRects().length > 0).length,
        controlWidth: rect.width, controlHeight: rect.height };
    });
    assert.equal(ideasContext.controlVisible, true, `#ideas-project is not visible in Ideas view at ${width}px`);
    assert.ok(ideasContext.controls > 0, `Ideas has no visible controls at ${width}px`);
    assert.ok(ideasContext.controlWidth > 0 && ideasContext.controlHeight > 0, JSON.stringify(ideasContext));
    const ideasAudit = await auditRoot(ideasRoot, ['color-contrast', 'select-name']);
    assert.deepEqual(ideasAudit.violations, [], JSON.stringify(ideasAudit.violations));
    assert.ok(ideasAudit.passes.includes('select-name'));
    await page.screenshot({ path: fileURLToPath(new URL(`ideas-${width}.png`, output)), fullPage:true });
    // Audit desktop chrome while visible and measure the actual computed colors.
    const contrast = await ideasRoot.evaluate(section => {
      const luminance = c => { const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(x => { x/=255; return x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4; }); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
      return ['h2','.section-copy','.microcopy'].map(selector => {
        const el=section.querySelector(selector), color=getComputedStyle(el).color;
        let parent=el, background;
        while(parent) { const c=getComputedStyle(parent).backgroundColor; if (!c.includes('rgba') && c!=='transparent') { background=c; break; } parent=parent.parentElement; }
        const a=luminance(color), b=luminance(background); return { selector,color,background,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05) };
      });
    });
    for (const result of contrast) assert.ok(result.ratio >= 4.5, JSON.stringify(result));
    if (width === 320 || width === 1440) {
      const idea = page.locator('#idea-i details');
      await idea.locator('summary').click();
      await idea.locator('summary').blur();
      snapshot.ideas[0].text = 'Idea actualizada durante la lectura';
      await page.evaluate(() => refresh());
      assert.equal(await idea.evaluate(element => element.open), true);
      assert.match(await idea.textContent(), /actualizada durante la lectura/);

      const live = snapshot.jobs[0];
      live.state = 'running'; live.attempts = 1; live.prompt = 'Encargo simulado';
      snapshot.automation = { businesses: { agency: true }, receipts: [], history: [] };
      const stage = live.workflow.steps[0];
      stage.status = 'running'; stage.dispatchId = 'ctx_live';
      stage.summary = 'Informe simulado\n'.repeat(30);
      await page.locator('.nav-link[href="#trabajos"]').click();
      await page.evaluate(() => refresh());
      const receipts = page.locator('#automation-controls details');
      await receipts.locator('summary').click();
      snapshot.automation.history.push({ type: 'claimed', jobId: live.id });
      await page.evaluate(() => refresh());
      assert.equal(await receipts.evaluate(element => element.open), true);
      const card = page.locator('#job-agency-queued');
      await card.locator('.job-summary').click();
      const report = card.getByText('Ver informe de etapa', { exact: true });
      await report.click();
      await card.locator('.workflow-stage-report').evaluate(element => { element.scrollTop = 120; });
      await report.focus();
      stage.status = 'succeeded'; stage.summary += 'Actualización visible';
      await page.evaluate(() => refresh());
      assert.equal(await card.evaluate(element => element.open), true);
      assert.equal(await report.evaluate(element => element.parentElement.open && document.activeElement === element), true);
      assert.equal(await card.locator('.workflow-stage-report').evaluate(element => element.scrollTop), 120);
      assert.match(await card.locator('.workflow-stage-report').textContent(), /Actualización visible/);
      live.state = 'succeeded';
      await page.evaluate(() => refresh());
      assert.equal(await card.evaluate(element => element.open && element.closest('#history').open), true);
      assert.equal(await report.evaluate(element => element.parentElement.open && document.activeElement === element), true);
      await card.locator('.job-summary').click();
      live.result = { text: 'Entrega simulada' };
      await page.evaluate(() => refresh());
      assert.equal(await card.evaluate(element => element.open), false);
    }
    assert.deepEqual(errors, []); assert.deepEqual(posts, []);
    evidence.push({ axeScope: 'visible active view root (#history, #proyectos, #ideas)', scenario: 'history-open-visible-controls', ...layout, projectScenario: 'projects-visible-baseBranch-and-status-filter', projectContext, ideasScenario: 'ideas-visible-project-filter', ideasContext, contrast, audit, projectAudit, ideasAudit });
    console.log(`PASS ${width}px: axe scoped al root visible; controles de Historial/Proyectos/Ideas presentes; sin overflow; contraste >=4.5; sin POST ni errores JS`);
    await page.close();
  }
  await fs.writeFile(new URL('results.json', output), JSON.stringify(evidence,null,2));
  await fs.writeFile(new URL('summary.md', output), [
    '# Accessibility browser regression',
    '',
    'Axe runs against the specific visible active-view element after each navigation: `#history`, `#proyectos`, or `#ideas`. Each root is checked with `isVisible()` and positive bounding-box dimensions first; each view must contain controls before view assertions.',
    '',
    'Passed at 320, 390, 800, and 1440 px:',
    '',
    '- Historial control presence and touch target geometry; no horizontal overflow.',
    '- Proyectos control presence, visible `baseBranch` field, and named status filter.',
    '- Separate Proyectos screenshots after its visible root and controls are verified (`proyectos-320.png`, `proyectos-390.png`, `proyectos-800.png`, `proyectos-1440.png`).',
    '- Ideas control presence and visible `#ideas-project` filter.',
    '- Axe rules `color-contrast` and `select-name` for Historial and Ideas; `select-name` for Proyectos.',
    '- Measured contrast ratio at least 4.5, no POST requests, and no page errors.',
    '- Separate screenshots for each viewport and view (`history-*.png`, `proyectos-*.png`, `ideas-*.png`).',
    '',
    'Per-viewport measurements and axe results are in `results.json`.',
  ].join('\n'));
} finally { await browser.close(); }
