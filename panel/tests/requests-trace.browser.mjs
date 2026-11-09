// Real API handlers and persistence; browser traffic stays in a temporary fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadState, summarize } from '../queue.mjs';
import { readAutoRun } from '../../auto-run.mjs';
import { createProject, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator, checkCoordinatorRequestNotice } from '../agency-assistant/coordinator-inbox.mjs';
import { respondToCoordinatorRequest, readCoordinatorRequest, reportCoordinatorQuestions, answerCoordinatorQuestion } from '../agency-assistant/coordinator-dialogue.mjs';
import { buildRequestTraces, readRequestTrace } from '../request-trace.mjs';
import { queryRequestContext, readContextConsultations } from '../knowledge-access.mjs';
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'requests-browser-'));
const origin = 'http://127.0.0.1:43894';
const owner = { runId: 'run_trace_fixture', senderId: 'term_trace_fixture', coordinatorId: 'coordinator-fixture', coordinatorName: 'Coordinador de Agencia' };
let browser;
try {
  const project = await createProject(root, 'Tienda de muestra', 'agency');
  const vault = path.join(root, 'vault'), notes = path.join(vault, 'Centro de Operaciones', 'Contexto', 'Agencia');
  await fs.mkdir(notes, { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'operations-dashboard.json'), JSON.stringify({ vaultPath: vault }));
  await fs.writeFile(path.join(notes, 'prioridades.md'), '---\nempresa: "agency"\n---\n# Prioridades de la agencia\n\nValidar primero la tienda y registrar las decisiones del cliente.\n');
  const notify = async (request, { beforeSend } = {}) => { const identity = { ...owner, business: request.business, routeScope: 'business', routeKey: request.business }; await beforeSend?.(identity); return { ...identity, status: 'sent', messageId: 'msg_' + request.id }; };
  const source = await fs.readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleApi('), end = source.indexOf('\nconst server =', start);
  const localCheck = source.slice(source.indexOf('function assertLocalRequest('), source.indexOf('\nasync function readJson('));
  const ctx = vm.createContext({ QUEUE_ROOT: root, PORT: 43894, URL, loadDashboardState, readCoordinatorRequest, readRequestTrace,
    queryRequestContext, respondToCoordinatorRequest, reportCoordinatorQuestions, routeTaskFromCoordinator,
    submitTaskToCoordinator: (r, body) => submitTaskToCoordinator(r, body, { notify }),
    answerCoordinatorQuestion: (r, id, answer) => answerCoordinatorQuestion(r, id, answer, { notify }),
    checkCoordinatorRequestNotice: (r, id) => checkCoordinatorRequestNotice(r, id, { notify }),
    readJson: async req => req.body, send: (response, status, value) => Object.assign(response, { status, value }),
  });
  const handleApi = vm.runInContext(`${localCheck}\n${source.slice(start, end)}\nhandleApi`, ctx);
  const errors = [], submissions = []; let loseFirstResponse = true, stateDelay = 0;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, serviceWorkers: 'block' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    if (url.pathname === '/api/state') {
      if (stateDelay) await new Promise(resolve => setTimeout(resolve, stateDelay));
      const queue = await loadState(root), inbox = await loadDashboardState(root), automation = await readAutoRun(root);
      const knowledge = await readContextConsultations(root);
      const requestTraces = await buildRequestTraces(root, { requests: inbox.coordinatorRequests, jobs: queue.jobs, questions: inbox.questions, automation, knowledge });
      return route.fulfill({ json: { ...inbox, requestTraces, jobs: queue.jobs, queue: summarize(queue), automation, executor: { available: true }, checkouts: [], domains: [], tasks: [], coordination: { coordinators: [{ ...owner, business: 'agency', connected: true }], projects: {} }, settings: { vaultPath: vault, telegram: false } } });
    }
    if (url.pathname === '/api/config') return route.fulfill({ json: { vaultPath: vault, autoRun: false } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    if (url.pathname.startsWith('/api/')) {
      const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
      if (url.pathname === '/api/jobs') submissions.push(body);
      const response = {};
      try { await handleApi({ method: request.method(), body, headers: { host: url.host, origin } }, response, url); }
      catch (error) { response.status = 400; response.value = { error: error.message }; }
      if (url.pathname === '/api/jobs' && loseFirstResponse) { loseFirstResponse = false; return route.abort('failed'); }
      if (url.pathname === '/api/jobs' && body.prompt === 'Consulta durante la escritura') await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ status: response.status, json: response.value });
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js', 'requests-view.js'].includes(name));
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const refresh = async () => { await page.locator('#refresh').click(); await page.waitForTimeout(150); };
  const post = (url, body) => page.evaluate(async ({ url, body }) => { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, value: await r.json() }; }, { url, body });
  await page.goto(origin + '/#peticiones');
  await page.locator('#consultation-project option').filter({ hasText: project.name }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('#consultation-project').inputValue(), '');
  await page.locator('#consultation-text').fill('¿Qué prioridades tenemos en la agencia?');
  await page.locator('#consultation-form button').click();
  await page.locator('#consultation-status').filter({ hasText: 'Puedes reintentar' }).waitFor();
  await page.locator('#consultation-form button').click();
  await page.locator('#consultation-status').filter({ hasText: 'Consulta guardada' }).waitFor();
  assert.equal(submissions.length, 2); assert.equal(submissions[0].operationId, submissions[1].operationId);
  let inbox = await loadDashboardState(root); assert.equal(inbox.coordinatorRequests.length, 1);
  const id = inbox.coordinatorRequests[0].id;
  assert.equal(inbox.coordinatorRequests[0].projectId, null); assert.equal((await loadState(root)).jobs.length, 0);
  const context = await post(`/api/coordinator/requests/${id}/context`, { ...owner, consultationId: 'initial-context', query: 'prioridades agencia' });
  assert.equal(context.status, 200); assert.equal(context.value.sources.length, 1);
  const answer = await post(`/api/coordinator/requests/${id}/response`, { ...owner, responseId: 'answer-one', text: 'Primero validamos la tienda y guardamos las decisiones. Esta consulta no necesita asignarse a un proyecto. Consulta [PR #1](https://github.com/example/project/pull/1), estado `completado`. Texto literal: <img src=x onerror=alert(1)> y [sin enlace](javascript:alert).', sources: [context.value.sources[0].id] });
  assert.equal(answer.status, 200); await refresh();
  await page.locator('.request-answer').filter({ hasText: 'Primero validamos' }).waitFor();
  assert.equal(await page.locator('.request-answer a').getAttribute('href'), 'https://github.com/example/project/pull/1');
  assert.equal(await page.locator('.request-answer code').innerText(), 'completado');
  assert.equal(await page.locator('.request-answer img').count(), 0);
  assert.equal(await page.locator('.request-answer a[href^="javascript:"]').count(), 0);
  await page.locator('.request-details > summary').click();
  await page.locator('.request-source > summary').click();
  assert.match(await page.locator('.request-source').innerText(), /Validar primero la tienda/);
  assert.match(await page.locator('.request-source a').getAttribute('href'), /^obsidian:\/\//);
  const originalSource = await page.locator('.request-source').getAttribute('data-panel-detail');
  const extraContext = await post(`/api/coordinator/requests/${id}/context`, { ...owner, consultationId: 'more-context', query: 'prioridades agencia' });
  assert.equal(extraContext.status, 200);
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('.request-source').count(), 2);
  const keptSource = page.locator(`[data-panel-detail="${originalSource}"]`);
  assert.equal(await keptSource.evaluate(element => element.open && element.firstElementChild === document.activeElement), true);
  await page.locator('#consultation-text').fill('Borrador que debe conservarse'); await refresh();
  assert.equal(await page.locator('#consultation-text').inputValue(), 'Borrador que debe conservarse');
  assert.equal(await page.locator('.request-details').evaluate(el => el.open), true);
  await page.locator('#request-filter').selectOption('done'); assert.equal(await page.locator('.request-card').count(), 1);
  await page.locator('#request-filter').selectOption('active'); assert.equal(await page.locator('.request-card').count(), 0);
  await page.locator('#request-filter').selectOption('all');
  await page.locator('#request-search').fill('no coincide'); assert.equal(await page.locator('.request-card').count(), 0);
  await page.locator('#request-search').fill('');
  await page.locator('#request-project-filter').selectOption('none'); assert.equal(await page.locator('.request-card').count(), 1);
  await fs.mkdir(new URL('../../.artifacts/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../.artifacts/requests-desktop.png', import.meta.url)), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at 320px');
  if (process.env.AXE_SOURCE) {
    await page.addScriptTag({ content: await fs.readFile(process.env.AXE_SOURCE, 'utf8') });
    const violations = await page.locator('#peticiones').evaluate(async node => (await axe.run(node, { runOnly: { type: 'rule', values: ['color-contrast', 'label', 'select-name', 'button-name', 'link-name'] } })).violations);
    assert.deepEqual(violations, []);
  }
  await page.locator('#consultation-text').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'consultation-project');
  await page.screenshot({ path: fileURLToPath(new URL('../../.artifacts/requests-mobile.png', import.meta.url)), fullPage: true });
  await page.locator('#consultation-text').fill('Consulta durante la escritura');
  await page.locator('#consultation-form button').click();
  await page.locator('#consultation-text').fill('Este es el siguiente borrador');
  await page.locator('#consultation-status').filter({ hasText: 'Consulta guardada' }).waitFor();
  assert.equal(await page.locator('#consultation-text').inputValue(), 'Este es el siguiente borrador');
  stateDelay = 1500;
  await page.locator('#business-context').selectOption('games');
  await page.locator('#consultation-text').fill('Consulta sin proyecto en Videojuegos');
  await page.locator('#consultation-form button').click();
  await page.locator('#consultation-status').filter({ hasText: 'Consulta guardada' }).waitFor();
  assert.equal(submissions.at(-1).business, 'games', 'business switches immediately even while refresh is delayed');
  assert.equal(submissions.at(-1).projectId, null);
  assert.deepEqual(errors, []);
  console.log('Verified: general query, lost-response replay, durable answer, actual scoped context, filters, draft preservation, keyboard and 320px layout.');
} finally { await browser?.close(); await fs.rm(root, { recursive: true, force: true }); }
