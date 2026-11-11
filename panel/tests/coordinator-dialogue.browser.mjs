// Every HTTP request is intercepted. Only temporary fixtures mutate; no listener or Orca process starts.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadState, summarize } from '../queue.mjs';
import { readAutoRun } from '../../auto-run.mjs';
import { createProject, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { submitTaskToCoordinator, routeTaskFromCoordinator, checkCoordinatorRequestNotice } from '../agency-assistant/coordinator-inbox.mjs';
import { reportCoordinatorQuestions, answerCoordinatorQuestion, readCoordinatorRequest, withdrawCoordinatorRequest } from '../agency-assistant/coordinator-dialogue.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coordinator-dialogue-browser-'));
const origin = 'http://127.0.0.1:43893';
const artifact = new URL('../../.artifacts/coordinator-dialogue.png', import.meta.url);
let browser;
try {
  const agencyProject = await createProject(root, 'Carta y web de prueba', 'agency');
  const gamesProject = await createProject(root, 'Demo del juego de prueba', 'games');
  const coordinators = [
    { id: 'agency-fixture', name: 'Coordinador de Agencia', business: 'agency', connected: true, runId: 'run_agency_fixture', senderId: 'term_agency_fixture' },
    { id: 'games-fixture', name: 'Coordinador de Videojuegos', business: 'games', connected: true, runId: 'run_games_fixture', senderId: 'term_games_fixture' },
  ];
  const coordination = { coordinators, projects: { [agencyProject.id]: 'agency-fixture', [gamesProject.id]: 'games-fixture' } };
  const notices = [], posts = [], errors = [];
  const notify = async (request, { beforeSend } = {}) => {
    const coordinator = coordinators.find(item => item.business === request.business);
    assert.ok(coordinator, 'every simulated notice must have an explicit business coordinator');
    const identity = { runId: coordinator.runId, senderId: coordinator.senderId, coordinatorId: coordinator.id,
      coordinatorName: coordinator.name, business: coordinator.business, routeScope: 'project', routeKey: request.snapshot.projectId };
    if (request.kind === 'answers') {
      assert.equal(request.notification.runId, identity.runId);
      assert.equal(request.notification.senderId, identity.senderId);
      assert.equal(request.snapshot.decisions.length, 2, 'send both answers together');
    }
    await beforeSend?.(identity);
    notices.push({ id: request.id, kind: request.kind, snapshot: structuredClone(request.snapshot), ...identity });
    return { ...identity, status: 'sent', messageId: `msg_fixture_${notices.length}` };
  };

  // Run the real API dispatcher without importing dashboard.mjs and starting its server/runner.
  const source = await fs.readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleApi('), end = source.indexOf('\nconst server =', start);
  assert.ok(start >= 0 && end > start);
  const localCheck = source.slice(source.indexOf('function assertLocalRequest('), source.indexOf('\nasync function readJson('));
  const context = vm.createContext({ QUEUE_ROOT: root, PORT: 43893, URL,
    loadDashboardState, readCoordinatorRequest, reportCoordinatorQuestions, routeTaskFromCoordinator, withdrawCoordinatorRequest,
    submitTaskToCoordinator: (queueRoot, input) => submitTaskToCoordinator(queueRoot, input, { notify }),
    answerCoordinatorQuestion: (queueRoot, id, answer) => answerCoordinatorQuestion(queueRoot, id, answer, { notify }),
    checkCoordinatorRequestNotice: (queueRoot, id) => checkCoordinatorRequestNotice(queueRoot, id, { notify }),
    verifyWorkerQuestion: async () => assert.fail('this fixture must never query a real worker'),
    answerQuestion: async () => assert.fail('coordinator questions must not use job continuation logic'),
    readJson: async request => request.body,
    send: (response, status, value) => Object.assign(response, { status, value }),
  });
  const handleApi = vm.runInContext(`${localCheck}\n${source.slice(start, end)}\nhandleApi`, context);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, origin, 'all browser traffic stays in the intercepted fixture origin');
    if (request.method() === 'POST' || /^\/api\/coordinator\/requests\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
      assert.ok(request.method() === 'GET' || url.pathname === '/api/jobs'
        || /^\/api\/questions\/[a-zA-Z0-9_-]+\/answer$/.test(url.pathname)
        || /^\/api\/coordinator\/requests\/[a-zA-Z0-9_-]+\/(questions|route|notify|withdraw|discard)$/.test(url.pathname), `Unexpected mutation: ${url.pathname}`);
      const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
      if (request.method() === 'POST') posts.push({ route: url.pathname, body });
      const response = {};
      try { await handleApi({ method: request.method(), body, headers: { host: url.host, origin } }, response, url); }
      catch (error) { response.status = 400; response.value = { error: error.message }; }
      return route.fulfill({ status: response.status, json: response.value });
    }
    if (url.pathname === '/api/state') {
      const queue = await loadState(root), inbox = await loadDashboardState(root);
      return route.fulfill({ json: { ...inbox, coordination, automation: await readAutoRun(root), executor: { available: true },
        checkouts: [], queue: summarize(queue), jobs: queue.jobs, domains: [], tasks: [],
        settings: { autoRun: false, vaultPath: '', telegram: false } } });
    }
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js', 'requests-view.js'].includes(name), `Unexpected request: ${url.pathname}`);
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)),
      contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const post = (url, body) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { url, body });
  const refresh = async () => {
    await Promise.all([page.waitForResponse(response => response.url() === `${origin}/api/state`), page.locator('#refresh').click()]);
    await page.locator('#updated-at').getByText(/^Actualizado/).waitFor({ state: 'attached' });
  };
  const input = { title: 'Definir una entrega pequeña', prompt: 'Preparar una propuesta verificable para la carta y la web.', successCriteria: 'Entregar alcance, plataforma y criterios de aceptación.' };
  const submit = async values => {
    await page.locator('#show-new-job').click();
    await page.locator('#job-project').selectOption(agencyProject.id);
    await page.locator('#job-form [name=title]').fill(values.title);
    await page.locator('#job-form [name=prompt]').fill(values.prompt);
    await page.locator('#job-form [name=successCriteria]').fill(values.successCriteria);
    await page.locator('#job-form [type=submit]').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Enviar al coordinador', exact: true }).click();
    await page.locator('#job-form').waitFor({ state: 'hidden' });
    const request = (await loadDashboardState(root)).coordinatorRequests.find(item => item.snapshot.title === values.title);
    assert.ok(request);
    return request;
  };

  await page.goto(`${origin}/#trabajos`);
  await page.locator('#coordinator-connections').getByText(/Coordinador de Agencia · Conectado.*Carta y web/).waitFor();
  assert.equal(await page.locator('#coordinator-connections').getByText(/Videojuegos/).count(), 0);
  await page.locator('#business-context').selectOption('games');
  await page.locator('#coordinator-connections').getByText(/Coordinador de Videojuegos · Conectado.*Demo del juego/).waitFor();
  assert.equal(await page.locator('#coordinator-connections').getByText(/Agencia/).count(), 0);
  await page.locator('#business-context').selectOption('agency');
  await page.locator('#coordinator-connections').getByText(/Coordinador de Agencia · Conectado/).waitFor();
  coordinators[0].name = 'Coordinador de Agencia · Diseño y desarrollo de servicios digitales para clientes con proyectos y nombres extensos';
  await page.setViewportSize({ width: 320, height: 800 });
  await refresh();
  await page.locator('#coordinator-connections').getByText(/Coordinador de Agencia.*nombres extensos.*Conectado/).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'long coordinator health names and project labels must fit 320px');
  coordinators[0].name = 'Coordinador de Agencia';
  await page.setViewportSize({ width: 1360, height: 1000 });
  await refresh();

  const request = await submit(input);
  assert.equal(notices.length, 1); assert.equal((await loadState(root)).jobs.length, 0);
  const questionResponse = await post(`/api/coordinator/requests/${request.id}/questions`, {
    roundId: 'brief-1', questions: [{ id: 'platform', text: '¿Qué plataforma priorizamos?', required: true }, { id: 'scope', text: '¿Qué alcance necesitas primero?', required: true }],
  });
  assert.equal(questionResponse.status, 200);
  const [platform, scope] = questionResponse.value.questions;
  const tooSoon = await post(`/api/coordinator/requests/${request.id}/route`, { kind: 'analysis' });
  assert.equal(tooSoon.status, 400); assert.match(tooSoon.value.error, /imprescindibles/);
  await refresh();
  const requestCard = page.locator('#coordinator-requests-list article').filter({ hasText: input.title });
  await requestCard.getByRole('link', { name: 'Responder preguntas', exact: true }).click();
  const platformInput = page.locator(`textarea[data-question-id="${platform.id}"]`);
  const scopeInput = page.locator(`textarea[data-question-id="${scope.id}"]`);
  await platformInput.fill('Web móvil con Android');
  const oldElement = await platformInput.elementHandle();
  await refresh();
  await page.waitForFunction(element => !element.isConnected, oldElement);
  assert.equal(await oldElement.evaluate(element => element.isConnected), false, 'refresh replaces the question DOM');
  assert.equal(await platformInput.inputValue(), 'Web móvil con Android', 'typed answer survives replacing the DOM');
  await platformInput.fill(''); await refresh();
  assert.equal(await platformInput.inputValue(), '', 'clearing the draft must not restore an old value');
  await platformInput.fill('Web móvil con Android');
  await scopeInput.fill('Una propuesta pequeña, sin editar código.');
  await platformInput.locator('..').getByRole('button', { name: 'Guardar respuesta para el coordinador', exact: true }).click();
  await page.getByText('Tu respuesta: Web móvil con Android', { exact: true }).waitFor();
  assert.equal(notices.filter(item => item.kind === 'answers').length, 0, 'first answer cannot notify before the required sibling');
  assert.equal(await scopeInput.inputValue(), 'Una propuesta pequeña, sin editar código.', 'saving a sibling preserves this unsent draft');
  await scopeInput.locator('..').getByRole('button', { name: 'Guardar respuesta para el coordinador', exact: true }).click();
  await page.getByText('Tu respuesta: Una propuesta pequeña, sin editar código.', { exact: true }).waitFor();
  assert.equal(notices.filter(item => item.kind === 'answers').length, 1);
  assert.equal((await loadState(root)).jobs.length, 0, 'answers alone never enqueue a job');
  assert.equal((await readCoordinatorRequest(root, request.id)).answerNotices.length, 1);
  const repeatAnswer = await post(`/api/questions/${scope.id}/answer`, { answer: 'Una propuesta pequeña, sin editar código.' });
  assert.equal(repeatAnswer.status, 200); assert.equal(notices.filter(item => item.kind === 'answers').length, 1);

  await fs.mkdir(path.dirname(fileURLToPath(artifact)), { recursive: true });
  await page.screenshot({ path: fileURLToPath(artifact), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1 && element.getBoundingClientRect().width > 0)
      .map(element => ({ tag: element.tagName, id: element.id, className: element.className, right: Math.round(element.getBoundingClientRect().right), text: element.innerText?.slice(0, 90) })).slice(0, 20) }));
  await page.setViewportSize({ width: 1360, height: 1000 });

  const routed = await post(`/api/coordinator/requests/${request.id}/route`, { kind: 'analysis', reason: 'Decisión explícita simulada con todas las respuestas.' });
  assert.equal(routed.status, 200);
  const replayRoute = await post(`/api/coordinator/requests/${request.id}/route`, { kind: 'analysis' });
  assert.equal(replayRoute.status, 200); assert.equal(replayRoute.value.job.id, routed.value.job.id);
  assert.equal(routed.value.job.coordination.requestId, request.id);
  assert.equal(routed.value.job.coordination.runId, request.notification.runId);
  assert.equal(routed.value.job.coordination.senderId, request.notification.senderId);
  assert.match(routed.value.job.prompt, /Web móvil con Android/); assert.match(routed.value.job.prompt, /Una propuesta pequeña/);
  await page.goto(`${origin}/#trabajos`);
  await page.locator('#coordinator-connections').getByText(/Coordinador de Agencia · Conectado/).waitFor();
  const repeatedRequest = await submit(input);
  assert.equal(repeatedRequest.id, request.id);
  assert.equal((await loadDashboardState(root)).coordinatorRequests.length, 1);
  assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await readAutoRun(root)).receipts.length, 1);
  assert.equal(notices.length, 2, 'one original notice and one grouped answer notice, even after reload/replay');
  const submissions = posts.filter(item => item.route === '/api/jobs');
  assert.equal(submissions[0].body.operationId, submissions[1].body.operationId);

  const withdrawal = await submit({ ...input, title: 'Corregir alcance antes de empezar' });
  const withdrawalQuestions = await post(`/api/coordinator/requests/${withdrawal.id}/questions`, {
    roundId: 'correct-1', questions: [{ id: 'correction', text: '¿Qué encargo deseas corregir?', required: true }],
  });
  assert.equal(withdrawalQuestions.status, 200);
  await refresh();
  const withdrawalCard = page.locator('#coordinator-requests-list article').filter({ hasText: 'Corregir alcance antes de empezar' });
  await withdrawalCard.getByRole('button', { name: 'Retirar solicitud para corregirla', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Retirar', exact: true }).click();
  await withdrawalCard.waitFor({ state: 'detached' });
  await page.goto(`${origin}/#ideas`);
  await page.getByText('Tu respuesta: Web móvil con Android', { exact: true }).waitFor();
  assert.equal(await page.locator('#questions-list').getByText('¿Qué encargo deseas corregir?', { exact: true }).count(), 0);
  const withdrawn = await readCoordinatorRequest(root, withdrawal.id);
  assert.equal(withdrawn.status, 'withdrawn'); assert.equal(withdrawn.questions[0].status, 'withdrawn');
  assert.equal((await loadState(root)).jobs.length, 1); assert.equal((await loadState(root)).jobs[0].attempts, 0);
  assert.deepEqual(errors, []);
  assert.ok(layout.scroll <= layout.width, `dialogue must fit a 320px viewport: ${JSON.stringify(layout)}`);
  console.log(`PASS: intercepted UI/API, business coordinator health, grouped questions, DOM draft retention/clear, one answer notice, exact request/job identity after replay, withdrawal hides questions; zero workers/listeners/network. Screenshot: ${fileURLToPath(artifact)}`);
} finally {
  await browser?.close();
  await fs.rm(root, { recursive: true, force: true });
}
