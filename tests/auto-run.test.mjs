import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { confirmSubmission, createAutoRunner, readAutoRun, setAutoRun, reviewAutoReceipt } from '../auto-run.mjs';
import { addJob, loadState, acquireLock, releaseLock, runQueue } from '../queue.mjs';
import { verifyGitHubDestination, githubRepository } from '../project-destination.mjs';
import { createProject, createIdea, loadDashboardState, mutateIdea } from '../workspaces/agency-assistant/agency-assistant/dashboard-state.mjs';
import { sendIdeaToQueue, reconcileIdeaRequests } from '../workspaces/agency-assistant/agency-assistant/idea-workflow.mjs';

const spec = (id, business = 'agency', extra = {}) => ({ id, business, kind: 'analysis', title: id, prompt: 'Objetivo: analizar. Criterio: plan verificable sin editar código.', provider: 'orca', ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-auto-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const enable = (root, business = 'agency', enabled = true) => setAutoRun(root, business, enabled, { confirm: true });
const worker = async () => ({ text: 'Entrega simulada' });
async function alterAuto(root, action) {
  const state = await readAutoRun(root); action(state);
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify(state));
}

test('false defaults and legacy migration; reads never persist or activate settings', async t => {
  const root = await fixture(t);
  assert.deepEqual((await readAutoRun(root)).businesses, { agency: false, games: false });
  await assert.rejects(fs.access(path.join(root, 'data', 'auto-run.json')));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data', 'operations-dashboard.json'), JSON.stringify({ autoRun: true }));
  assert.deepEqual((await readAutoRun(root)).businesses, { agency: false, games: false });
  await assert.rejects(setAutoRun(root, 'agency', true), /Confirma/);
  await enable(root);
  assert.deepEqual((await readAutoRun(root)).businesses, { agency: true, games: false });
  assert.equal((await readAutoRun(root)).history.at(-1).type, 'setting_changed');
});

test('activation never drains historical jobs or manual receipts; exact automatic ID and sequential phases', async t => {
  const root = await fixture(t);
  await addJob(root, spec('historical'));
  await confirmSubmission(root, 'receipt-manual', spec('manual'));
  await enable(root);
  await confirmSubmission(root, 'receipt-new-auto', spec('automatic'));
  const starts = [], phases = [];
  const runner = createAutoRunner(root, { worker: async (job, ctx) => {
    starts.push(job.id);
    for (const step of job.workflow.steps) {
      phases.push(step.profile); await ctx.reportStage({ key: step.key, status: 'running', dispatchId: 'ctx_simulated', dispatchStatus: 'confirmed' });
      await ctx.reportStage({ key: step.key, status: 'succeeded' });
    }
    return worker();
  } });
  await runner.tick(); await runner.tick();
  assert.deepEqual(starts, ['automatic']); assert.deepEqual(phases, ['planificador']);
  const jobs = (await loadState(root)).jobs;
  assert.deepEqual(jobs.map(job => job.attempts), [0, 0, 1]);
  assert.equal(jobs.at(-1).workflow.steps[0].dispatchId, 'ctx_simulated');
});

test('duplicate confirmation, concurrent double click and replay return one job and start', async t => {
  const root = await fixture(t); await enable(root);
  const results = await Promise.all([1, 2].map(() => confirmSubmission(root, 'receipt-double', spec('double'))));
  assert.equal(results[0].job.id, results[1].job.id);
  assert.equal((await loadState(root)).jobs.length, 1);
  await assert.rejects(confirmSubmission(root, 'receipt-double', spec('changed')), /otro encargo/);
  let calls = 0;
  const runner = createAutoRunner(root, { worker: async () => { calls++; return worker(); } });
  await Promise.all([runner.tick(), runner.tick()]);
  await confirmSubmission(root, 'receipt-double', spec('double'));
  await runner.tick(); assert.equal(calls, 1);
});

test('confirmed backend enqueue wakes the background executor and returns while worker remains active', async t => {
  const root = await fixture(t); await enable(root);
  let release, announce;
  const started = new Promise(resolve => { announce = resolve; });
  const runner = createAutoRunner(root, { intervalMs: 20, worker: async job => {
    announce(job.id); await new Promise(resolve => { release = resolve; }); return worker();
  } });
  runner.start(); t.after(() => runner.stop());
  const response = await confirmSubmission(root, 'receipt-background', spec('background'));
  assert.equal(response.receipt.jobId, 'background');
  let timeout;
  assert.equal(await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Background runner did not wake')), 3000); })]).finally(() => clearTimeout(timeout)), 'background');
  assert.equal((await loadState(root)).jobs[0].state, 'running');
  runner.stop(); release();
  // tick is still busy: observe completion without keeping the test fixture
  // alive past the active executor, using its durable receipt as the boundary.
  for (let i = 0; i < 100 && (await readAutoRun(root)).receipts[0].status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await readAutoRun(root)).receipts[0].status, 'completed');
});

test('restart recovers a running job with a confirmed dispatch as needs_attention without a second worker', async t => {
  const root = await fixture(t); await enable(root);
  await confirmSubmission(root, 'receipt-running-restart', spec('running-restart'));
  const state = await loadState(root);
  const job = { ...state.jobs[0], state: 'running', attempts: 1, workflow: { ...state.jobs[0].workflow, currentStage: 'planner', steps: [{ key: 'planner', profile: 'planificador', status: 'running', dispatchId: 'ctx_prior_confirmed' }] } };
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, at: new Date().toISOString(), type: 'simulated_interruption', patch: { jobs: [job] } }) + '\n');
  let starts = 0;
  await createAutoRunner(root, { worker: async () => { starts++; return worker(); } }).tick();
  const recovered = (await loadState(root)).jobs[0];
  assert.equal(recovered.state, 'needs_attention');
  assert.equal(recovered.workflow.steps[0].dispatchId, 'ctx_prior_confirmed');
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
  assert.equal(starts, 0);
});

test('busy worker preserves durable outbox; restart recovers only original eligible intent FIFO across businesses', async t => {
  const root = await fixture(t); await enable(root);
  const lock = await acquireLock(root);
  const manual = await confirmSubmission(root, 'receipt-games-off', spec('games-manual', 'games'));
  const automatic = await confirmSubmission(root, 'receipt-agency-on', spec('agency-auto'));
  assert.equal(manual.job, null); assert.equal(automatic.job, null);
  await enable(root, 'games');
  await confirmSubmission(root, 'receipt-games-on', spec('games-auto', 'games'));
  let calls = [];
  const runner = createAutoRunner(root, { worker: async job => { calls.push(job.id); return worker(); } });
  await runner.tick(); assert.deepEqual(calls, []);
  await releaseLock(lock);
  await runner.tick(); await runner.tick(); await runner.tick();
  assert.deepEqual(calls, ['agency-auto', 'games-auto']);
  assert.equal((await loadState(root)).jobs.find(job => job.id === 'games-manual').attempts, 0);
});

test('incomplete or unsafe queue lock keeps confirmation durable without displacing lock or dispatching', async t => {
  const root = await fixture(t); await enable(root);
  const lockPath = path.join(root, 'data', 'runner.lock');
  await fs.writeFile(lockPath, '');
  const result = await confirmSubmission(root, 'receipt-uncertain-lock', spec('lock-pending'));
  assert.equal(result.job, null); assert.equal(result.receipt.status, 'pending');
  let starts = 0;
  await createAutoRunner(root, { worker: async () => { starts++; return worker(); } }).tick();
  assert.equal(starts, 0); assert.equal(await fs.readFile(lockPath, 'utf8'), '');
  assert.equal((await loadState(root)).jobs.length, 0);
});

test('restart claimed without dispatch proof requires review and never retries or starts the next job', async t => {
  const root = await fixture(t); await enable(root);
  await confirmSubmission(root, 'receipt-uncertain', spec('uncertain'));
  await confirmSubmission(root, 'receipt-after-uncertain', spec('after'));
  await alterAuto(root, state => { state.receipts[0].status = 'claimed'; });
  let starts = 0;
  const runner = createAutoRunner(root, { worker: async () => { starts++; return worker(); } });
  await runner.tick(); await runner.tick();
  assert.equal(starts, 0);
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
  assert.match((await readAutoRun(root)).receipts[0].reason, /incierto/);
  await assert.rejects(reviewAutoReceipt(root, 'receipt-uncertain'), /Confirma/);
});

test('pause during a worker leaves active dispatch alone and prevents subsequent starts; global PAUSE too', async t => {
  const root = await fixture(t); await enable(root);
  await confirmSubmission(root, 'receipt-first-pause', spec('first'));
  await confirmSubmission(root, 'receipt-second-pause', spec('second'));
  const calls = [];
  const runner = createAutoRunner(root, { worker: async job => {
    calls.push(job.id); await enable(root, 'agency', false); return worker();
  } });
  await runner.tick(); await runner.tick();
  assert.deepEqual(calls, ['first']);
  assert.equal((await loadState(root)).jobs[0].state, 'succeeded');
  await enable(root); await fs.writeFile(path.join(root, 'data', 'PAUSE'), '');
  await runner.tick(); assert.deepEqual(calls, ['first']);
});

for (const mode of ['failure', 'timeout']) test(`${mode} stops the chain without automatic retry`, async t => {
  const root = await fixture(t); await enable(root);
  await confirmSubmission(root, 'receipt-failure-first', spec('failure', 'agency', { timeoutMs: 20 }));
  await confirmSubmission(root, 'receipt-failure-after', spec('after'));
  let calls = 0;
  const runner = createAutoRunner(root, { worker: async (_job, ctx) => {
    calls++; ctx.registerCleanup(async () => {});
    if (mode === 'timeout') return new Promise(() => {});
    const error = new Error('fallo simulado'); error.retryable = true; throw error;
  } });
  await runner.tick(); await runner.tick();
  assert.equal(calls, 1);
  assert.equal((await readAutoRun(root)).receipts[0].status, 'needs_attention');
  assert.equal((await loadState(root)).jobs[1].attempts, 0);
});

test('real queue lock admission checks pause immediately before start', async t => {
  const root = await fixture(t); await enable(root);
  await confirmSubmission(root, 'receipt-admission-pause', spec('pause'));
  const runner = createAutoRunner(root, { worker, run: async (root, options) => {
    await enable(root, 'agency', false); return runQueue(root, options);
  } });
  await runner.tick();
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
  assert.equal((await readAutoRun(root)).receipts[0].status, 'pending');
});

test('ideas backend captures auto intent and immutable brief; edit/archive/restore never creates another start', async t => {
  const root = await fixture(t);
  const project = await createProject(root, 'Agencia', 'agency');
  const idea = await createIdea(root, 'agency', 'Idea verificable conservada', project.id, 'capture-safe-auto', { focus: 'mixed' });
  await enable(root);
  const result = await sendIdeaToQueue(root, idea.id, 'analysis');
  assert.equal(result.receipt.eligible, true);
  assert.equal(result.job.ideaId, idea.id); assert.match(result.job.prompt, /Idea verificable/);
  const starts = [];
  const runner = createAutoRunner(root, { worker: async job => { starts.push(job.id); return worker(); } });
  await runner.tick();
  const archived = await mutateIdea(root, idea.id, 'archive', { version: 1 });
  await mutateIdea(root, idea.id, 'restore', { version: archived.version });
  await sendIdeaToQueue(root, idea.id, 'analysis'); await runner.tick();
  assert.deepEqual(starts, [result.job.id]);
  assert.equal((await loadDashboardState(root)).ideas[0].requests.analysis.snapshot, result.job.prompt);
});

test('legacy inbox pending intent is never promoted on activation', async t => {
  const root = await fixture(t);
  const project = await createProject(root, 'Histórico', 'agency');
  const idea = await createIdea(root, 'agency', 'Idea antigua pendiente', project.id, 'capture-legacy-auto', { focus: 'code' });
  const file = path.join(root, 'data', 'operations-inbox.json');
  const inbox = JSON.parse(await fs.readFile(file, 'utf8'));
  inbox.ideas[0].requests = { analysis: { jobId: `idea-${idea.id}-analysis`, status: 'pending', snapshot: 'Brief antiguo sin autoejecución.' } };
  await fs.writeFile(file, JSON.stringify(inbox));
  await enable(root); await reconcileIdeaRequests(root);
  let starts = 0;
  await createAutoRunner(root, { worker: async () => { starts++; return worker(); } }).tick();
  assert.equal(starts, 0); assert.equal((await loadState(root)).jobs[0].autoIntent, undefined);
});

test('GitHub verification uses only mocked read-only Git commands and rejects bad destinations', async t => {
  const root = await fixture(t);
  const workspace = path.join(root, 'workspaces', 'checkout');
  await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const sha = 'a'.repeat(40);
  const job = spec('git', 'agency', { kind: 'code', workspace, isolated: true, branch: 'main', destination: { repository: 'owner/repo' } });
  const observed = { checkout: 'workspaces/checkout', workspace, branch: 'main', valid: true };
  const commands = [];
  const values = ['https://github.com/owner/repo.git', 'main', sha, `${sha}\trefs/heads/main`];
  const verify = overrides => verifyGitHubDestination(root, job, { inspect: async () => observed, git: async args => {
    commands.push(args); const index = ['remote', 'symbolic-ref', 'rev-parse', 'ls-remote'].indexOf(args[0]);
    if (overrides?.throwAt === index) throw new Error('Git error');
    return overrides && index in overrides ? overrides[index] : values[index];
  } });
  const result = await verify(); assert.equal(result.sha, sha); assert.equal(result.repository, 'owner/repo');
  assert.deepEqual(commands.map(args => args[0]), ['remote', 'symbolic-ref', 'rev-parse', 'ls-remote']);
  for (const bad of ['C:/repo', '../repo', 'https://gitlab.com/owner/repo', 'https://github.com.evil/owner/repo', 'https://token@github.com/owner/repo']) await assert.rejects(verify({ 0: bad }));
  for (const overrides of [{ 0: 'git@github.com:other/repo.git' }, { 1: 'other' }, { 1: '' }, { 3: '' }, { 3: `${'b'.repeat(40)}\trefs/heads/main` }, { throwAt: 3 }]) await assert.rejects(verify(overrides));
  await fs.writeFile(path.join(workspace, '.git', 'index.lock'), ''); await assert.rejects(verify(), /bloqueo/);
  assert.equal(githubRepository('git@github.com:Owner/Repo.git'), 'owner/repo');
});

test('code admission persists verified repository/branch/SHA and executes business workflow serially', async t => {
  const root = await fixture(t); await enable(root, 'games');
  const workspace = path.join(root, 'workspaces', 'code'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  await confirmSubmission(root, 'receipt-code-valid', spec('code', 'games', { kind: 'code', workspace, isolated: true, branch: 'main', destination: { repository: 'owner/repo' } }));
  const phases = [];
  const runner = createAutoRunner(root, { verify: async () => ({ workspace, repository: 'owner/repo', branch: 'main', sha: 'a'.repeat(40), verified: true }), worker: async (job, ctx) => {
    for (const step of job.workflow.steps) { phases.push(step.profile); await ctx.reportStage({ key: step.key, status: 'succeeded', dispatchId: `ctx_${step.key}` }); }
    return worker();
  } });
  await runner.tick();
  assert.deepEqual(phases, ['ux_games', 'desarrollador_games', 'qa_games', 'revisor_games', null]);
  assert.equal((await loadState(root)).jobs[0].workflow.steps.at(-1).executor, 'deterministic');
  assert.equal((await loadState(root)).jobs[0].destination.verified, true);
  await assert.rejects(fs.access(path.join(workspace, '.git', 'centro-executor.lock')));
});

for (const kind of ['invalid', 'checkout-lock']) test(`destination ${kind} blocks before worker/start and preserves queue`, async t => {
  const root = await fixture(t); await enable(root);
  const workspace = path.join(root, 'workspaces', 'code'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  if (kind === 'checkout-lock') await fs.writeFile(path.join(workspace, '.git', 'centro-executor.lock'), 'other owner');
  await confirmSubmission(root, 'receipt-code-blocked', spec('code', 'agency', { kind: 'code', workspace, isolated: true, branch: 'main', destination: { repository: 'owner/repo' } }));
  let starts = 0;
  const runner = createAutoRunner(root, { verify: async () => { if (kind === 'invalid') throw new Error('SHA distinto'); return { workspace }; }, worker: async () => { starts++; return worker(); } });
  await runner.tick(); await runner.tick(); assert.equal(starts, 0);
  assert.equal((await loadState(root)).jobs[0].attempts, 0);
  assert.equal((await readAutoRun(root)).receipts[0].status, 'blocked');
});
