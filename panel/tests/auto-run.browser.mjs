// All browser requests are intercepted. No listener, remote Git, real worker or service.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { loadState, summarize, addJob } from '../../queue.mjs';
import { confirmSubmission, readAutoRun, setAutoRun, createAutoRunner } from '../../auto-run.mjs';
import { createProject, loadDashboardState } from '../agency-assistant/dashboard-state.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-browser-'));
let browser;
try {
  const project = await createProject(root, 'Proyecto temporal', 'agency');
  await addJob(root, { id: 'old-manual', business: 'agency', kind: 'analysis', title: 'Trabajo anterior manual', prompt: 'Analizar sin editar.' });
  const source = await fs.readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleApi('), end = source.indexOf('\nconst server =', start);
  const localCheck = source.slice(source.indexOf('function assertLocalRequest('), source.indexOf('\nasync function readJson('));
  const context = vm.createContext({ QUEUE_ROOT: root, PORT: 43893, URL, loadDashboardState, confirmSubmission, setAutoRun,
    readJson: async request => request.body, send: (response, status, value) => Object.assign(response, { status, value }),
  });
  const handleApi = vm.runInContext(`${localCheck}\n${source.slice(start, end)}\nhandleApi`, context);
  const errors = [], posts = [];
  let finish, started;
  const running = new Promise(resolve => { started = resolve; });
  const runner = createAutoRunner(root, { worker: async (job, ctx) => {
    await ctx.reportStage({ key: 'planner', status: 'running', dispatchId: 'ctx_simulated_browser', dispatchStatus: 'confirmed' });
    started(job.id); await new Promise(resolve => { finish = resolve; });
    await ctx.reportStage({ key: 'planner', status: 'succeeded' }); return { text: 'Entrega local simulada' };
  } });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, 'http://127.0.0.1:43893');
    if (request.method() === 'POST') {
      assert.ok(['/api/auto-run', '/api/jobs'].includes(url.pathname));
      const body = request.postDataJSON(); posts.push({ route: url.pathname, body });
      const response = {};
      await handleApi({ method: 'POST', body, headers: { host: url.host, origin: url.origin } }, response, url);
      return route.fulfill({ status: response.status, json: response.value });
    }
    if (url.pathname === '/api/state') {
      const queue = await loadState(root);
      return route.fulfill({ json: { automation: await readAutoRun(root), executor: { available: true }, checkouts: [], queue: summarize(queue), jobs: queue.jobs,
        projects: [project], ideas: [], questions: [], domains: [], tasks: [], messages: [], settings: { autoRun: false, vaultPath: '', telegram: false } } });
    }
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js'].includes(name));
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://127.0.0.1:43893/#trabajos');
  await page.getByRole('button', { name: 'Activar Agencia', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Activar Videojuegos', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancelar', exact: true }).click(); assert.equal(posts.length, 0);
  await page.getByRole('button', { name: 'Activar Agencia', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Confirmar activación', exact: true }).click();
  await page.getByRole('button', { name: 'Pausar Agencia', exact: true }).waitFor();
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
  const submit = async title => {
    await page.locator('#show-new-job').click();
    await page.locator('#job-project').selectOption(project.id);
    await page.locator('#job-form [name=title]').fill(title);
    await page.locator('#job-form [name=prompt]').fill('Objetivo verificable del panel');
    await page.locator('#job-form [name=successCriteria]').fill('Entregar un plan priorizado');
    await page.locator('#job-form [type=submit]').click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Confirmar y encolar', exact: true }).click();
    await page.locator('#job-form').waitFor({ state: 'hidden' });
  };
  await submit('Nuevo automático');
  assert.equal(posts.filter(item => item.route === '/api/jobs').length, 1);
  const [receipt] = (await readAutoRun(root)).receipts;
  assert.equal(receipt.eligible, true);
  const activeTick = runner.tick(); assert.equal(await running, receipt.jobId);
  await page.reload();
  await page.getByRole('button', { name: 'Pausar Agencia', exact: true }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Confirmar pausa', exact: true }).click();
  await page.getByRole('button', { name: 'Activar Agencia', exact: true }).waitFor();
  assert.equal((await loadState(root)).jobs.find(job => job.id === receipt.jobId).state, 'running');
  await submit('Nuevo manual durante pausa');
  assert.equal((await readAutoRun(root)).receipts[1].eligible, false);
  finish(); await activeTick; await runner.tick();
  await page.reload(); await page.locator('#automation-controls').getByText('Agencia · Autoejecución pausada', { exact: true }).waitFor();
  assert.equal((await loadState(root)).jobs.find(job => job.id === 'old-manual').attempts, 0);
  assert.equal((await loadState(root)).jobs.at(-1).attempts, 0);
  await submit('Nuevo automático');
  const submissions = posts.filter(item => item.route === '/api/jobs');
  assert.equal(submissions[0].body.operationId, submissions.at(-1).body.operationId, 'reload/replay preserves the original operation');
  assert.equal((await loadState(root)).jobs.length, 3, 'replay cannot duplicate a job even after pause/reload');
  assert.deepEqual(errors, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px layout must not overflow');
  console.log('PASS: offline 320px controls, cancel, per-business confirmation, fast enqueue receipt, exact simulated start, pause with active dispatch, manual backlog and zero real workers/network/listeners');
} finally {
  await browser?.close(); await fs.rm(root, { recursive: true, force: true });
}
