import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildV2Task, interpretV2, normalizeWorkflowV2, readWorkflowV2, runWorkflowV2Gate, v2TaskId, workflowV2For } from '../workflow-v2-gate.mjs';

// U7 part 3 (phase A): a project can be governed by Workflow V2; off by default.
const ENTRY = { stateRoot: '/srv/wfv2/state', reviewerConfig: '/srv/wfv2/reviewer.json', allowedPaths: ['src/'], checks: ['unit-tests'] };
const config = (projects = { obi: ENTRY }) => ({ version: 1, engineeringSystem: '/srv/engineering-system', projects });
const job = (extra = {}) => ({ id: 'job-001', kind: 'code', projectId: 'obi', title: 'Añadir sub()', contract: { acceptance: ['sub(a, b) devuelve a - b'] }, ...extra });

async function rootWith(t, value) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wfv2-gate-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (value !== undefined) { await fs.mkdir(path.join(root, 'data')); await fs.writeFile(path.join(root, 'data', 'workflow-v2.json'), typeof value === 'string' ? value : JSON.stringify(value)); }
  return root;
}

test('without the file, or for a project not listed, nothing is governed', async t => {
  assert.equal(await readWorkflowV2(await rootWith(t)), null);
  assert.equal(await workflowV2For(await rootWith(t), job()), null);
  const root = await rootWith(t, config());
  assert.equal(await workflowV2For(root, job({ projectId: 'forge' })), null);
  assert.equal(await workflowV2For(root, job({ kind: 'analysis' })), null);
  assert.equal(await workflowV2For(root, job({ projectId: undefined })), null);
  const entry = await workflowV2For(root, job());
  assert.equal(entry.engineeringSystem, '/srv/engineering-system');
  assert.equal(entry.python, 'python3');
  assert.equal(entry.timeoutMs, 3_600_000);
});

test('invalid configurations are refused with a typed error instead of guessing', async t => {
  for (const bad of [{}, { ...config(), version: 2 }, { ...config(), engineeringSystem: 'relative' }, { ...config(), python: 'python3; rm -rf /' },
    config({ obi: { ...ENTRY, stateRoot: 'state' } }), config({ obi: { ...ENTRY, allowedPaths: [] } }), config({ obi: { ...ENTRY, checks: ['Bad Name'] } }),
    config({ obi: { ...ENTRY, declaredTier: 'LOW' } }), config({ obi: { ...ENTRY, timeoutMs: 5 } }), config({ 'a b': ENTRY })]) {
    assert.throws(() => normalizeWorkflowV2(bad), { code: 'workflow_v2_config_invalid' }, JSON.stringify(bad));
  }
  await assert.rejects(readWorkflowV2(await rootWith(t, '{ no json')), { code: 'workflow_v2_config_invalid' });
});

test('the V2 TASK comes from the job contract: checks by evidence, criteria judged by the V2 reviewer', () => {
  const task = buildV2Task(job(), normalizeWorkflowV2(config()).projects.obi);
  assert.deepEqual(task, {
    schema: 'wfv2-task', version: 1, id: 'job-001', title: 'Añadir sub()', declared_tier: null, risks: [], allowed_paths: ['src/'], checks: ['unit-tests'],
    criteria: [
      { id: 'k1', text: 'La comprobación unit-tests pasa en el sandbox.', evidence: { check: 'unit-tests' } },
      { id: 'c1', text: 'sub(a, b) devuelve a - b', evidence: { manual: 'revisor Workflow V2' } },
    ],
  });
  assert.equal(v2TaskId({ id: '..job:é/2' }), 'job---2');
});

test('the V2 summary is read conservatively: only the owner approves', () => {
  assert.equal(interpretV2({ status: 'revision', reviews: [{ recommendation: 'ACCEPT' }] }).outcome, 'owner_pending');
  assert.equal(interpretV2({ status: 'pendiente_owner', reviews: [] }).outcome, 'owner_pending');
  assert.equal(interpretV2({ status: 'revision', reviews: [{ recommendation: 'REJECT' }] }).outcome, 'rejected');
  assert.equal(interpretV2({ status: 'revision', reviews: [] }).outcome, 'reviewer_missing');
  assert.equal(interpretV2({ status: 'preparacion' }).outcome, 'checks_failed');
  assert.equal(interpretV2({ status: 'bloqueado' }).outcome, 'blocked');
  assert.equal(interpretV2({ status: 'aprobado' }).outcome, 'unexpected', 'submit never approves; an approval here is not trusted');
});

async function gate(t, { result, jobExtra = {} } = {}) {
  const updates = [], calls = [];
  const ctx = { signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, captureSnapshot: async () => 'a'.repeat(64) };
  const entry = { ...normalizeWorkflowV2(config()).projects.obi, engineeringSystem: '/srv/engineering-system', python: 'python3' };
  const run = async (argv, options) => {
    calls.push({ argv, options, task: JSON.parse(await fs.readFile(argv[argv.indexOf('--task-file') + 1], 'utf8')) });
    return result;
  };
  const error = await runWorkflowV2Gate(job(jobExtra), ctx, entry, '/work/checkout', { run }).then(() => null, e => e);
  return { error, updates, calls };
}

const summary = (status, reviews, extra = {}) => ({ code: 0, stderr: '', timedOut: false, stdout: JSON.stringify({
  task: 'job-001', status, tier: 'STANDARD', identity: 'i'.repeat(64), evidence_id: 'e'.repeat(64), reviews, blocked_reason: null,
  steps: [{ unit: 'U1', candidate: 'c'.repeat(64) }], next: 'owner: `wfv2 verdict job-001 unit accepted`', ...extra }) });

test('an ACCEPT recommendation stops the job for the owner and never reaches integration', async t => {
  const { error, updates, calls } = await gate(t, { result: summary('revision', [{ role: 'unit', recommendation: 'ACCEPT', isolation: 'DEMONSTRATED' }]),
    jobExtra: { workflowV2Snapshot: 'a'.repeat(64), workflow: { steps: [{ key: 'reviewer' }, { key: 'integration' }] } } });
  assert.equal(error.code, 'workflow_v2_owner_pending');
  assert.match(error.message, /Decide tú en V2/);
  assert.equal(error.details.v2Candidate, 'c'.repeat(64));
  assert.deepEqual(calls[0].argv, ['python3', '-m', 'wfv2.cli', '--repo', '/srv/wfv2/state', 'submit', 'job-001', '--worktree', '/work/checkout',
    '--task-file', calls[0].argv[10], '--reviewer-config', '/srv/wfv2/reviewer.json']);
  assert.equal(calls[0].options.cwd, '/srv/engineering-system');
  assert.equal(calls[0].task.id, 'job-001');
  await assert.rejects(fs.access(calls[0].argv[10]), 'the task file is removed afterwards');
  assert.deepEqual(updates.map(u => [u.key, u.status]), [['reviewer', 'running'], ['reviewer', 'blocked'], ['integration', 'skipped']]);
  assert.equal(updates[1].workflowV2.outcome, 'owner_pending');
  assert.equal(updates[1].workflowV2.candidate, 'c'.repeat(64));
  assert.equal(updates[1].workflowV2.qaSnapshot, 'a'.repeat(64));
  assert.match(updates[1].summary, /Siguiente: owner: `wfv2 verdict/);
});

test('a V2 rejection, failed checks and operational blocks stop with their own codes', async t => {
  assert.equal((await gate(t, { result: summary('revision', [{ recommendation: 'REJECT' }]) })).error.code, 'workflow_v2_rejected');
  assert.equal((await gate(t, { result: summary('preparacion', []) })).error.code, 'workflow_v2_checks_failed');
  const blocked = (await gate(t, { result: summary('bloqueado', [], { blocked_reason: 'unit review launch blocked' }) })).error;
  assert.equal(blocked.code, 'workflow_v2_blocked');
  assert.match(blocked.message, /Motivo: unit review launch blocked/);
});

test('a refused submit or unreadable output is reported, not treated as a review', async t => {
  const refused = await gate(t, { result: { code: 1, stdout: '', stderr: 'PREFLIGHT REFUSED (nothing recorded): changed paths outside allowed_paths: x\n', timedOut: false } });
  assert.equal(refused.error.code, 'workflow_v2_refused');
  assert.match(refused.error.message, /outside allowed_paths/);
  assert.equal(refused.updates.at(-1).status, 'blocked');
  assert.equal((await gate(t, { result: { code: 0, stdout: 'nope', stderr: '', timedOut: false } })).error.code, 'workflow_v2_unexpected');
  const timedOut = await gate(t, { result: { code: null, stdout: '', stderr: '', timedOut: true } });
  assert.equal(timedOut.error.code, 'workflow_v2_refused');
  assert.equal(timedOut.error.uncertain, true);
});

test('V2 rejects a foreign task or a missing candidate and checks the local QA snapshot again', async t => {
  const valid = summary('revision', [{ recommendation: 'ACCEPT' }]);
  for (const result of [
    summary('revision', [{ recommendation: 'ACCEPT' }], { task: 'other-job' }),
    summary('pendiente_owner', [], { steps: [{ unit: 'U1', candidate: null }] }),
  ]) {
    assert.equal((await gate(t, { result })).error.code, 'workflow_v2_identity_mismatch');
  }
  const stale = await gate(t, { result: valid, jobExtra: { workflowV2Snapshot: 'b'.repeat(64) } });
  assert.equal(stale.error.code, 'workflow_v2_candidate_changed');
});

test('runOrca: a governed project runs V2 instead of the Centro Revisión; others are unchanged', async t => {
  const { runOrca } = await import('../orca-provider.mjs');
  const root = await rootWith(t, config());
  const workspace = path.join(root, 'workspaces', 'obi'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const run = async (projectId, { changeDuringQa = false, priorQa, gateReturns = false, preflightFails = false } = {}) => {
    const starts = [], updates = [], gates = [], preflights = [];
    let snapshotReads = 0;
    const ctx = { root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
    const command = async args => {
      if (args[0] === 'repo') return { repos: [{ path: workspace }] };
      if (args[1] === 'run-create') return { runId: 'run_wfv2gate1' };
      if (args[1] === 'worker-start') { const dispatchId = `ctx_v2gate${starts.length + 1}`; starts.push(updates.at(-1).key); return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
      if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_wfv2gate1', taskId: `task_${args[3].slice(4)}` };
      if (args[1] === 'inbox') { const key = starts.at(-1); return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'Validación correcta.\nRESULTADO: APROBADO' : `${key} completado`, payload: JSON.stringify({ dispatchId: `ctx_v2gate${starts.length}` }) }] }; }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    const runWorkflowV2 = async (job, _ctx, entry, ws) => { gates.push({ job: job.id, entry, ws, snapshot: job.workflowV2Snapshot }); if (gateReturns) return; throw Object.assign(new Error('owner'), { code: 'workflow_v2_owner_pending' }); };
    const outcome = await runOrca({ id: `v2-${projectId}`, business: 'agency', kind: 'code', provider: 'orca', projectId, title: 'V2', prompt: 'Probar V2.', workspace, isolated: true, attempts: 1, ...(priorQa ? { workflow: { steps: [priorQa] } } : {}) },
      ctx, { command, runWorkflowV2, captureSnapshot: async () => changeDuringQa && ++snapshotReads > 1 ? 'b'.repeat(64) : 'a'.repeat(64),
        preflightV2: async entry => { preflights.push(entry.stateRoot); if (preflightFails) throw Object.assign(new Error('V2 no listo'), { code: 'workflow_v2_preflight_failed' }); } })
      .then(() => 'succeeded', error => error.code);
    return { starts, gates, outcome, updates, preflights };
  };
  const governed = await run('obi');
  assert.deepEqual(governed.starts, ['ux', 'developer', 'qa'], 'the Centro Revisión stage is not launched');
  assert.equal(governed.gates.length, 1);
  assert.equal(governed.preflights.length, 1, 'V2 is checked once, before the first agent');
  assert.equal(governed.gates[0].ws, workspace);
  const notReady = await run('obi', { preflightFails: true });
  assert.equal(notReady.outcome, 'workflow_v2_preflight_failed');
  assert.deepEqual(notReady.starts, [], 'no agent is launched when V2 is not ready');
  assert.equal(governed.outcome, 'workflow_v2_owner_pending');
  assert.equal(governed.gates[0].snapshot, 'a'.repeat(64));
  assert.equal(governed.updates.find(item => item.key === 'qa' && item.dispatchStatus === 'starting').workflowV2Snapshot, 'a'.repeat(64));
  const changed = await run('obi', { changeDuringQa: true });
  assert.equal(changed.outcome, 'workflow_v2_qa_candidate_changed');
  assert.equal(changed.gates.length, 0);
  const noConfig = await run('forge', { priorQa: { key: 'qa', workflowV2Snapshot: 'a'.repeat(64) } });
  assert.equal(noConfig.outcome, 'workflow_v2_config_missing');
  assert.equal(noConfig.starts.length, 0);
  const unexpected = await run('obi', { gateReturns: true });
  assert.equal(unexpected.outcome, 'workflow_v2_unexpected');
  assert.deepEqual(unexpected.starts, ['ux', 'developer', 'qa']);
  const other = await run('forge');
  assert.deepEqual(other.starts, ['ux', 'developer', 'qa', 'reviewer']);
  assert.equal(other.gates.length, 0);
  assert.equal(other.preflights.length, 0, 'a project without V2 is not checked');
  assert.equal(other.outcome, 'succeeded');
});

test('the shipped example is a valid configuration', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../ejemplos/workflow-v2.example.json', import.meta.url), 'utf8'));
  assert.ok(normalizeWorkflowV2(example).projects['id-del-proyecto']);
});
