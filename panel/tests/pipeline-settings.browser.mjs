// Offline regression for Ajustes (pipeline split) and the per-job split in Nuevo trabajo. All requests are intercepted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const assets = new URL('../dashboard/', import.meta.url);
const example = JSON.parse(await fs.readFile(new URL('../../ejemplos/pipeline.mixto.example.json', import.meta.url), 'utf8'));
const empty = { general: { roles: {} }, empresas: {}, proyectos: {}, escaladas: {} };
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [320, 1440]) {
    let saved = null;
    const writes = [], previews = [];
    const settings = () => ({ configured: Boolean(saved), defaultAgent: 'codex', roles: ['planificador', 'ux', 'desarrollador', 'qa', 'revisor'], agents: ['codex', 'claude'], businesses: ['agency', 'games'],
      levelNames: ['ligero', 'estandar', 'profundo'], levels: { roles: {}, agents: {} }, example, pipeline: saved || empty });
    const snapshot = {
      jobs: [{ id: 'pendiente', business: 'agency', title: 'Encargo en cola', state: 'queued', kind: 'code', provider: 'orca', attempts: 0, maxAttempts: 5, createdAt: '2026-11-10',
        plannedLaunch: { developer: { agent: 'claude', model: 'sonnet', effort: 'medium', source: 'general' } },
        workflow: { steps: [{ key: 'ux', label: 'Diseño UX', status: 'succeeded', launch: { agent: 'claude', model: 'sonnet', effort: 'medium', source: 'general' } }, { key: 'developer', label: 'Implementación', status: 'queued' }] } },
        { id: 'sin-diseno', business: 'agency', title: 'Cálculo de IVA', state: 'queued', kind: 'code', provider: 'orca', attempts: 0, maxAttempts: 5, createdAt: '2026-11-09',
          route: { id: 'funcional', label: 'Cambio funcional sin interfaz', reason: 'Solo cambia un cálculo del servidor.', omitted: [{ stage: 'ux', reason: 'Solo cambia un cálculo del servidor.' }] },
          workflow: { steps: [{ key: 'ux', label: 'Diseño UX', status: 'skipped', routeOmitted: true, summary: 'Omitida por la ruta «Cambio funcional sin interfaz»: Solo cambia un cálculo del servidor.' }, { key: 'developer', label: 'Implementación', status: 'queued' }] } }],
      queue: {}, projects: [{ id: 'web', name: 'Web corporativa', business: 'agency', status: 'active', checkout: '', branch: '' }], ideas: [], questions: [], domains: [], tasks: [], messages: [],
      settings: {}, executor: { available: true },
    };
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, 'http://127.0.0.1:43894');
      if (url.pathname === '/api/pipeline' && request.method() === 'POST') {
        const body = JSON.parse(request.postData()); writes.push(body);
        if (body.disable) saved = null; else saved = body.pipeline;
        return route.fulfill({ json: settings() });
      }
      if (url.pathname === '/api/jobs' && request.method() === 'POST') { writes.push(JSON.parse(request.postData())); return route.fulfill({ status: 202, json: { message: 'Solicitud enviada.' } }); }
      assert.equal(request.method(), 'GET', url.pathname);
      if (url.pathname === '/api/state') return route.fulfill({ json: snapshot });
      if (url.pathname === '/api/pipeline') return route.fulfill({ json: settings() });
      if (url.pathname === '/api/launch-preview') {
        previews.push(url.search);
        const launch = url.searchParams.get('launch') ? JSON.parse(url.searchParams.get('launch')) : null;
        const roles = url.searchParams.get('kind') === 'analysis' ? ['planificador'] : ['ux', 'desarrollador', 'qa', 'revisor'];
        const labels = { planificador: 'Planificación', ux: 'Diseño', desarrollador: 'Desarrollo', qa: 'QA', revisor: 'Revisión' };
        return route.fulfill({ json: { stages: roles.map(role => { const chosen = launch?.roles?.[role]; const base = saved?.general.roles[role];
          return { role, label: labels[role], agent: chosen?.agent || base?.agent || 'codex', model: chosen?.model || base?.model || 'gpt-6.1-sol', effort: chosen?.effort || base?.effort || 'medium', source: chosen ? 'encargo' : base ? 'general' : 'por defecto' }; }), warnings: [] } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js', 'requests-view.js'].includes(name), name);
      return route.fulfill({ body: await fs.readFile(new URL(name, assets)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    const noOverflow = async label => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no horizontal overflow at ${width}px`);

    // Ajustes opened directly by URL: the section renders before the rest of the script has run its declarations.
    await page.goto('http://127.0.0.1:43894/#ajustes');
    await page.getByRole('heading', { name: 'Agentes y modelos por etapa' }).waitFor();
    await page.locator('#pipeline-rows .pipeline-row').nth(4).waitFor();
    assert.match(await page.locator('#pipeline-status').innerText(), /Sin perfil por etapas/);
    assert.equal(await page.locator('#pipeline-save').isDisabled(), true, 'nothing to save yet');
    assert.equal(await page.locator('#pipeline-disable').isHidden(), true);
    await page.locator('#pipeline-scope option', { hasText: 'Proyecto · Web corporativa' }).waitFor({ state: 'attached' });
    await noOverflow('settings');

    // Loading the example fills the form but writes nothing until the explicit save.
    await page.getByRole('button', { name: 'Cargar perfil mixto de ejemplo' }).click();
    assert.equal(await page.locator('#pipeline-ux-agent').inputValue(), 'claude');
    assert.equal(await page.locator('#pipeline-qa-model').inputValue(), 'gpt-6.1-sol');
    assert.match(await page.locator('#pipeline-escalations').innerText(), /claude-opus/);
    assert.equal(writes.length, 0, 'the example is not applied by loading it');
    assert.equal(await page.locator('#pipeline-dirty').innerText(), 'Cambios sin guardar');

    // Typed values, focus and the chosen scope survive a panel refresh.
    await page.locator('#pipeline-scope').selectOption('empresa:games');
    await page.locator('#pipeline-desarrollador-effort').fill('high');
    await page.locator('#pipeline-desarrollador-model').focus();
    await page.locator('#refresh').dispatchEvent('click');
    await page.waitForFunction(() => /Actualizado/.test(document.querySelector('#updated-at').textContent));
    assert.equal(await page.locator('#pipeline-scope').inputValue(), 'empresa:games');
    assert.equal(await page.locator('#pipeline-desarrollador-effort').inputValue(), 'high');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'pipeline-desarrollador-model', 'focus kept across refresh');
    // A level replaces model and effort for that role.
    await page.locator('#pipeline-qa-level').selectOption('profundo');
    assert.equal(await page.locator('#pipeline-qa-model').isDisabled(), true);

    await page.getByRole('button', { name: 'Guardar reparto' }).click();
    await page.waitForFunction(() => /activo/.test(document.querySelector('#pipeline-status').textContent));
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].pipeline.general.roles.ux, { agent: 'claude', model: 'sonnet', effort: 'medium' });
    assert.deepEqual(writes[0].pipeline.empresas.games.roles, { ux: { effort: 'high' }, desarrollador: { effort: 'high' }, qa: { level: 'profundo' } });
    assert.equal(await page.locator('#pipeline-scope').inputValue(), 'empresa:games', 'the scope being edited stays selected after saving');
    assert.equal(await page.locator('#pipeline-disable').isVisible(), true);
    await page.waitForFunction(() => /claude · sonnet/.test(document.querySelector('#pipeline-effective').textContent));
    await noOverflow('settings after save');

    // Job page: a launched stage shows what it used; a pending one shows what is planned.
    await page.goto('http://127.0.0.1:43894/#trabajo/pendiente');
    await page.getByRole('heading', { name: 'Encargo en cola', exact: true }).waitFor();
    const stages = await page.locator('.run-stage').allInnerTexts();
    assert.match(stages[0], /Modelo\s+claude · sonnet · esfuerzo medium/);
    assert.match(stages[1], /Modelo previsto\s+claude · sonnet · esfuerzo medium · se fija al lanzar la etapa/);

    const previewsBefore = previews.filter(search => !search.includes('projectId')).length;
    // A stage left out by the route is shown with its reason, on the job page and on the job card.
    await page.goto('http://127.0.0.1:43894/#trabajo/sin-diseno');
    await page.getByRole('heading', { name: 'Cálculo de IVA', exact: true }).waitFor();
    assert.match(await page.locator('.run-route').innerText(), /Ruta: Cambio funcional sin interfaz[\s\S]*Diseño UX: omitida\. Solo cambia un cálculo del servidor\./);
    assert.equal(await page.locator('.run-stage').count(), 1, 'only the stages that run are numbered');
    await noOverflow('route');

    // Nuevo trabajo: preview of the split, one stage pinned for this job, sent with the request.
    await page.goto('http://127.0.0.1:43894/#trabajos');
    await page.locator('#show-new-job').click();
    assert.equal(previews.filter(search => !search.includes('projectId')).length, previewsBefore, 'opening the sheet asks for no preview until the split is opened');
    await page.locator('#job-launch summary').click();
    await page.waitForFunction(() => /Se lanzaría con claude · sonnet/.test(document.querySelector('#job-launch-rows [data-role="desarrollador"] .pipeline-row-note')?.textContent || ''));
    await page.locator('#job-launch-revisor-model').fill('gpt-6-astra');
    await page.waitForFunction(() => /gpt-6-astra.*este encargo/.test(document.querySelector('#job-launch-rows [data-role="revisor"] .pipeline-row-note').textContent));
    assert.match(await page.locator('#job-launch-summary').innerText(), /1 etapa\(s\) fijadas/);
    await noOverflow('new job');
    await page.locator('#refresh').dispatchEvent('click');
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#job-launch-revisor-model').inputValue(), 'gpt-6-astra', 'the per-job choice survives a refresh');
    assert.equal(await page.locator('#job-launch').getAttribute('open'), '', 'the disclosure stays open across a refresh');
    await page.locator('#job-project').selectOption('web');
    await page.locator('#job-form [name="title"]').fill('Revisión exigente');
    await page.locator('#job-form [name="prompt"]').fill('Revisar el módulo de pagos.');
    await page.locator('#job-form [name="successCriteria"]').fill('Informe con hallazgos reproducibles.');
    await page.locator('#job-form button[type="submit"]').click();
    await page.locator('dialog[aria-label="Enviar solicitud al coordinador"]').getByRole('button', { name: 'Enviar al coordinador' }).click();
    await page.waitForFunction(() => document.querySelector('#job-form').hidden);
    const sent = writes.at(-1);
    assert.deepEqual(sent.launch, { roles: { revisor: { model: 'gpt-6-astra', agent: 'codex' } } }, 'a model typed without an agent is bound to the agent the stage would use');
    assert.equal(sent.projectId, 'web');
    assert.ok(previews.some(search => search.includes('projectId=web')), 'the preview follows the selected project');
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS pipeline split at ${width}px: example not applied until saved, state kept across refresh, planned vs used model, per-job choice sent`);
  }
} finally { await browser.close(); }
