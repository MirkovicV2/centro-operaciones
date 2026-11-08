// Offline regression: intercepted browser routes, real API handler and temporary queue.
// No HTTP listener, network requests, service restart or worker dispatch.
// node tests/dashboard-confirmation.browser.mjs
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { addJob, loadState, summarize } from '../queue.mjs';
import { createProject, updateProject, loadDashboardState, recordJobConfirmation } from '../agency-assistant/dashboard-state.mjs';
import { inspectDestination } from '../../project-destination.mjs';
import { confirmSubmission } from '../../auto-run.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : '../../workspaces/portfolio-motion/node_modules/playwright/index.mjs');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'confirmed-job-'));
let browser;
const deadline = setTimeout(() => { void browser?.close(); }, 30_000);
try {
  const checkout = 'workspaces/app';
  await fs.mkdir(path.join(root, checkout), { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: path.join(root, checkout), windowsHide: true });
  const project = await createProject(root, 'Proyecto temporal', 'agency');
  await updateProject(root, project.id, { checkout, baseBranch: 'main' });
  const configured = (await loadDashboardState(root)).projects[0];
  const posts = [], errors = [];
  // Load the production handler without evaluating server.listen, timers or bot startup.
  const source = await fs.readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function handleApi(');
  const end = source.indexOf('\nconst server =', start);
  assert.ok(start >= 0 && end > start);
  const localCheck = source.slice(source.indexOf('function assertLocalRequest('), source.indexOf('\nasync function readJson('));
  const context = vm.createContext({ QUEUE_ROOT: root, PORT: 43892, URL, loadDashboardState, inspectDestination, addJob, confirmSubmission, recordJobConfirmation,
    readJson: async request => request.body,
    send: (response, status, value) => Object.assign(response, { status, value }),
  });
  const handleApi = vm.runInContext(`${localCheck}\n${source.slice(start, end)}\nhandleApi`, context);
  browser = await chromium.launch({ headless: true, timeout: 10_000 });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    try {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, 'http://127.0.0.1:43892', 'external request forbidden');
    if (request.method() === 'POST') {
      assert.equal(url.pathname, '/api/jobs', 'enqueue must never call run');
      const body = request.postDataJSON(); posts.push(body);
      const response = {};
      await handleApi({ method: 'POST', body, headers: { host: url.host, origin: url.origin } }, response, url);
      return route.fulfill({ status: response.status, json: response.value });
    }
    if (url.pathname === '/api/state') {
      const queue = await loadState(root);
      return route.fulfill({ json: { executor: { available: true }, checkouts: [{ value: checkout, valid: true, branch: 'main' }],
        queue: summarize(queue), jobs: queue.jobs, projects: [configured], ideas: [], questions: [], domains: [], tasks: [], messages: [],
        settings: { autoRun: false, vaultPath: '', telegram: false } } });
    }
    if (url.pathname === '/api/config') return route.fulfill({ json: { autoRun: false, vaultPath: '' } });
    if (url.pathname === '/api/graph') return route.fulfill({ json: { connected: false } });
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    assert.ok(['index.html', 'app.js', 'style.css', 'ideas-view.js'].includes(name));
    return route.fulfill({ body: await fs.readFile(new URL(`../dashboard/${name}`, import.meta.url)),
      contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    } catch (error) {
      errors.push(error.message);
      return route.fulfill({ status: 500, body: 'offline fixture failed' });
    }
  });
  page.setDefaultTimeout(5000);
  await page.goto('http://127.0.0.1:43892/#trabajos', { waitUntil: 'domcontentloaded', timeout: 5000 });
  await page.locator('#job-project option', { hasText: 'Proyecto temporal' }).waitFor({ state: 'attached' });
  await page.locator('#show-new-job').click();
  await page.locator('#job-project').selectOption(project.id);
  await page.locator('#job-kind').selectOption('code');
  await page.locator('#job-form [name=title]').fill('Trabajo temporal confirmado');
  await page.locator('#job-form [name=prompt]').fill('Objetivo original');
  await page.locator('#job-form [name=successCriteria]').fill('Criterio original');
  await page.locator('#job-form [type=submit]').click();
  await page.locator('#destination-dialog').waitFor({ state: 'visible' });
  assert.equal(posts.length, 0, 'opening confirmation must not enqueue');
  assert.equal(await page.locator('#destination-form [name=objective]').inputValue(), 'Objetivo original');
  assert.equal(await page.locator('#destination-form [name=successCriteria]').inputValue(), 'Criterio original');
  await page.locator('#destination-form [name=objective]').fill('Objetivo corregido confirmado');
  await page.locator('#destination-form [name=successCriteria]').fill('Criterio corregido confirmado');
  await page.locator('#destination-form [type=submit]').click();
  await page.locator('#job-form').waitFor({ state: 'hidden' });
  assert.equal(posts.length, 1);
  const [payload] = posts;
  assert.equal(payload.prompt, 'Objetivo corregido confirmado');
  assert.equal(payload.successCriteria, 'Criterio corregido confirmado');
  assert.equal(payload.prompt, payload.confirmation.objective);
  assert.equal(payload.successCriteria, payload.confirmation.successCriteria);
  const persisted = await loadState(root);
  assert.equal(persisted.jobs.length, 1);
  const [job] = persisted.jobs;
  assert.equal(job.prompt, 'Objetivo corregido confirmado\n\nCriterio de éxito:\nCriterio corregido confirmado');
  assert.equal(job.business, 'agency');
  assert.equal(job.projectId, project.id);
  assert.equal(job.workspace, path.join(root, checkout));
  assert.equal(job.branch, 'main');
  assert.equal(job.state, 'queued');
  assert.equal(job.attempts, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: edited objective and criteria match confirmation, submitted payload and persisted job; agency/destination retained; one queued job, zero attempts, no listener or dispatch');
} finally {
  clearTimeout(deadline);
  try { await Promise.race([browser?.close(), new Promise(resolve => setTimeout(resolve, 3000))]); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
