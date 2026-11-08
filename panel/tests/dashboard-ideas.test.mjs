import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, loadState } from '../queue.mjs';

test('HTTP panel saves idea, configures checkout, keeps busy send durable and queues without autoRun', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'panel-ideas-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'workspaces', 'isolated', '.git'), { recursive: true });
  await fs.mkdir(path.join(root, 'workspaces', 'isolated', '.git', 'objects'));
  await fs.writeFile(path.join(root, 'workspaces', 'isolated', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(root, 'workspaces', 'isolated', '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: path.join(root, 'workspaces', 'isolated'), windowsHide: true });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.mjs');
  const child = spawn(process.execPath, [app], { windowsHide: true, env: { ...process.env, CENTRO_OPERACIONES_ROOT: root, CENTRO_OPERATIONS_PORT: String(port), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_CHAT_ID: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'close'); } });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Panel exited before listening'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Panel startup timed out')), 5000); timer.unref(); })]);
  const api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: response.status, value: await response.json() };
  };
  const project = (await api('/api/projects', { name: 'Proyecto HTTP', business: 'agency' })).value;
  const idea = (await api('/api/ideas', { business: 'agency', projectId: project.id, text: 'Idea HTTP para desarrollar', focus: 'mixed', operationId: 'capture-http-1234' })).value;
  const missing = await api(`/api/ideas/${idea.id}/send`, { kind: 'code' });
  assert.equal(missing.value.job, undefined); assert.match(missing.value.message, /checkout/);
  assert.equal((await api(`/api/projects/${project.id}/update`, { checkout: '../outside' })).status, 400);
  assert.equal((await api(`/api/projects/${project.id}/update`, { checkout: 'workspaces/isolated', baseBranch: 'main' })).status, 200);
  const confirmation = { projectId: project.id, checkout: 'workspaces/isolated', branch: 'main', baseBranch: 'main', objective: 'Implementar flujo HTTP', successCriteria: 'Verificar comportamiento HTTP sin ejecutar' };
  const lock = await acquireLock(root);
  try {
    const sends = await Promise.all([1, 2].map(() => api(`/api/ideas/${idea.id}/send`, { kind: 'code', confirmation })));
    sends.forEach(result => { assert.equal(result.value.started, undefined); assert.equal(result.value.job, undefined); });
    const busy = (await api('/api/state')).value;
    assert.equal(busy.executor.available, false); assert.equal(busy.ideas.length, 1);
  } finally { await releaseLock(lock); }
  const state = (await api('/api/state')).value;
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].state, 'queued'); assert.equal(state.jobs[0].attempts, 0);
  assert.equal(state.settings.autoRun, false);
  assert.equal((await api('/api/run', {})).status, 409);
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
  assert.equal(state.checkouts[0].value, 'workspaces/isolated');
  const again = await api(`/api/ideas/${idea.id}/send`, { kind: 'code' });
  assert.equal(again.value.existing, true); assert.equal(again.value.started, undefined);
  assert.equal((await loadState(root)).jobs.length, 1);
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  for (const id of ['idea-checkout', 'idea-send-status', 'save-idea-development', 'save-idea-only', 'run-next']) assert.match(html, new RegExp(`id="${id}"`));
});
