import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, summarize, recoverDashboardQueue, elapsedAttemptMs, deliveryTransportError, settledOrcaObservation, addJob, actorContext } from '../queue.mjs';
import { readAutoRun, readIntegration } from '../auto-run.mjs';
import { effectFreeIntegrationRecord } from '../integration-recovery.mjs';
import { parseTailscaleAccess } from '../panel/access-control.mjs';
import { normalizeWorkerStatus } from '../orca-evidence.mjs';
import { validateDelivery } from '../workflow-contract.mjs';
import { loadDashboardState } from '../panel/agency-assistant/dashboard-state.mjs';

// Rule 2 of EOC-CLAUDE-01: the owner's real data predates every field added by this
// branch (actor, finishedAtSource, criterionId, error.details, tailscale users,
// launchLevel, surface, integrationEffects). A ledger, snapshot, auto-run journal and
// bindings in that format must load and drive the queue and the panel unchanged.
const T = '2026-11-09T22:';
const budget = { limitUsd: 0, reservedUsd: 0, estimatedSpentUsd: 0, model: '', inputPerMillion: 0, outputPerMillion: 0 };
function legacyJob(root) {
  const workspace = path.join(root, 'workspaces', 'sandbox');
  const step = (key, status, extra = {}) => ({ key, label: key, profile: `${key}_agency`, status, attempt: 1, taskInputAttempt: 1, runId: 'run_legacy0001', taskId: `task_legacy_${key}`, dispatchId: `ctx_legacy_${key}`,
    dispatchStatus: 'completed', orcaAgent: 'claude', updatedAt: `${T}14:57.000Z`, summary: `${key} listo`, ...extra });
  return {
    id: 'coord-legacy0001-code', business: 'agency', kind: 'code', provider: 'orca', title: 'Añadir slugify', prompt: 'Implementar slugify.\nCriterio de éxito: slugify(\'\') devuelve la cadena vacía \'\'.',
    projectId: 'proj-legacy', projectName: 'Proyecto de prueba', workspace, isolated: true, branch: 'e2e/slugify',
    destination: { checkout: 'workspaces/sandbox', workspace, branch: 'e2e/slugify', repository: 'dadavl/eoc-e2e-sandbox', baseBranch: 'main', sha: 'a'.repeat(40), remoteSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), verified: true },
    autoIntent: { receiptId: 'coordinator-send-coord-legacy0001-code', eligible: true },
    contract: { version: 1, objective: 'Añadir slugify', inputs: [], constraints: [], knownDecisions: [], evidence: [], acceptance: ["slugify('') devuelve la cadena vacía ''"], owner: 'coordinator', expectedResult: 'Cambios verificables y evidencia de validación.', completionCondition: 'Criterios de la etapa satisfechos y evidencia disponible.', criteriaSource: 'explicit' },
    coordination: { requestId: 'coord-legacy0001', runId: 'run_legacy0001', senderId: 'term_legacy0001', business: 'agency' },
    maxAttempts: 5, timeoutMs: null, maxUsd: 0.1, maxOutputTokens: 1024, attempts: 1, state: 'needs_attention', createdAt: `${T}00:00.000Z`, startedAt: `${T}02:47.000Z`, finishedAt: `${T}14:57.000Z`, nextAttemptAt: null, reservedUsd: 0, estimatedUsd: 0, costUncertain: false, orphanRisk: false,
    error: { code: 'delivery_acceptance_missing', message: "La entrega omite un criterio obligatorio del encargo: slugify('') devuelve la cadena vacía ''" },
    attemptHistory: [{ attempt: 1, startedAt: `${T}02:47.000Z`, finishedAt: `${T}14:57.000Z`, elapsedMs: 730_000, outcome: 'needs_attention', promptChars: 70, error: 'delivery_acceptance_missing', metrics: { orcaCliCalls: 40, dispatchStarts: 4, polls: 30, inputTokens: null, outputTokens: null } }],
    workflow: { version: 1, name: 'quality', runId: 'run_legacy0001', status: 'needs_attention', currentStage: 'reviewer', updatedAt: `${T}14:57.000Z`, steps: [
      step('ux', 'succeeded'), step('developer', 'succeeded', { artifact: { path: 'data/stage-reports/x/developer.json', sha256: 'c'.repeat(64) } }), step('qa', 'succeeded', { approvalOutcome: 'approved' }),
      step('reviewer', 'blocked', { error: 'delivery_acceptance_missing', dispatchSettled: true, artifact: { path: 'data/stage-reports/x/reviewer.json', sha256: 'd'.repeat(64) } }),
      { key: 'integration', label: 'Integración GitHub', status: 'queued' }] },
    result: { provider: 'orca', text: 'Informe sin contrato válido' },
  };
}
async function legacyRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-compat-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data')); await fs.mkdir(path.join(root, 'workspaces', 'sandbox', '.git'), { recursive: true });
  const job = legacyJob(root);
  const events = [
    { schema: 1, revision: 1, at: `${T}00:00.000Z`, type: 'job_added', details: { jobId: job.id }, patch: { jobs: [{ ...job, state: 'queued', attempts: 0, error: undefined, attemptHistory: undefined, startedAt: undefined, finishedAt: undefined, result: undefined, workflow: { ...job.workflow, status: 'queued', currentStage: null, steps: job.workflow.steps.map(step => ({ key: step.key, label: step.label, status: 'queued' })) } }], budget } },
    { schema: 1, revision: 2, at: `${T}02:47.000Z`, type: 'job_started', details: { jobId: job.id }, patch: { jobs: [{ ...job, state: 'running', error: null, attemptHistory: [], finishedAt: undefined, result: undefined }], budget } },
    { schema: 1, revision: 3, at: `${T}14:57.000Z`, type: 'operator_required', details: { jobId: job.id, code: 'delivery_acceptance_missing' }, patch: { jobs: [job], budget } },
  ];
  const ledger = events.map(event => JSON.stringify(event)).join('\n') + '\n';
  await fs.writeFile(path.join(root, 'data', 'events.jsonl'), ledger);
  await fs.writeFile(path.join(root, 'data', 'state.json'), JSON.stringify({ schema: 1, revision: 3, jobs: [job], budget }, null, 2) + '\n');
  const receipt = { id: job.autoIntent.receiptId, business: 'agency', jobId: job.id, eligible: true, status: 'needs_attention', reason: 'El encargo requiere revisión.', fingerprint: 'f'.repeat(64), confirmedAt: `${T}00:00.000Z`, claimedAt: `${T}02:47.000Z`, updatedAt: `${T}14:57.000Z`,
    destination: job.destination, spec: { id: job.id, business: 'agency', kind: 'code', provider: 'orca', title: job.title, prompt: job.prompt, workspace: job.workspace, isolated: true, branch: job.branch, destination: job.destination } };
  const integration = { jobId: job.id, receiptId: receipt.id, repository: 'dadavl/eoc-e2e-sandbox', sourceBranch: 'e2e/slugify', baseBranch: 'main', phase: 'validation_approved', status: 'needs_attention', needsAttention: true, error: 'gh falló o la respuesta fue ambigua; consulta el estado remoto antes de continuar.',
    validation: { version: 1, snapshot: 'e'.repeat(64), attempt: 1, cycleId: 'attempt-1', jobId: job.id, receiptId: receipt.id, runId: 'run_legacy0001', workspace: job.workspace, branch: job.branch, developerTaskId: 'task_legacy_developer', developerDispatchId: 'ctx_legacy_developer', developerArtifactSha256: 'c'.repeat(64), approvals: { qa: { taskId: 'task_legacy_qa', dispatchId: 'ctx_legacy_qa', artifactSha256: null }, reviewer: { taskId: 'task_legacy_reviewer', dispatchId: 'ctx_legacy_reviewer', artifactSha256: 'd'.repeat(64) } } } };
  await fs.writeFile(path.join(root, 'data', 'auto-run.json'), JSON.stringify({ schema: 1, businesses: { agency: false, games: false }, receipts: [receipt], integrations: { [receipt.id]: integration },
    history: [{ at: `${T}00:00.000Z`, type: 'submission_confirmed', business: 'agency', eligible: true, jobId: job.id, receiptId: receipt.id }, { at: `${T}14:30.000Z`, type: 'github_integration', receiptId: receipt.id, jobId: job.id, phase: 'validation_pending' }, { at: `${T}14:50.000Z`, type: 'github_integration', receiptId: receipt.id, jobId: job.id, phase: 'validation_approved' }, { at: `${T}14:57.000Z`, type: 'github_integration', receiptId: receipt.id, jobId: job.id }] }));
  await fs.writeFile(path.join(root, 'data', 'coordinator-bindings.json'), JSON.stringify({ schemaVersion: 1, coordinators: [{ id: 'agencia-local', name: 'Coordinador de Agencia', business: 'agency', runId: 'run_legacy0001', senderId: 'term_legacy0001' }], businesses: { agency: 'agencia-local' }, projects: {} }));
  await fs.writeFile(path.join(root, 'data', 'tailscale-access.json'), JSON.stringify({ hostname: 'equipo.tailnet.ts.net', login: 'owner@example.test' }));
  return { root, job, ledger };
}

test('a pre-branch ledger, snapshot and auto-run journal load and drive the queue without any rewrite', async t => {
  const { root, job, ledger } = await legacyRoot(t);
  const state = await loadState(root);
  assert.equal(state.revision, 3); assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].actor, undefined);
  assert.deepEqual(summarize(state).states ?? summarize(state), summarize(state));
  assert.equal(JSON.stringify(summarize(state)).includes('needs_attention'), true);
  for (const business of ['agency', 'games']) assert.equal((await recoverDashboardQueue(root, { business })).available, true);
  assert.equal(await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8'), ledger, 'recovery of a non-running job never touches the ledger');
  const loaded = state.jobs[0];
  assert.equal(elapsedAttemptMs(loaded), 730_000);
  assert.equal(deliveryTransportError(loaded), 'delivery_acceptance_missing', 'the legacy blocked review is still a transport recovery checkpoint');
  assert.equal(settledOrcaObservation(loaded), null);
  const auto = await readAutoRun(root);
  assert.equal(auto.receipts[0].status, 'needs_attention'); assert.equal(auto.history[0].actor, undefined);
  const record = await readIntegration(root, job.autoIntent.receiptId);
  assert.equal(effectFreeIntegrationRecord(record, auto.history, job.id), true, 'the real job-7 shape is recognised as effect-free');
  const inbox = await loadDashboardState(root);
  assert.ok(Array.isArray(inbox.coordinatorRequests) && Array.isArray(inbox.projects));
  // New writes append after the old lines and leave them byte-identical.
  const added = await actorContext.run({ actor: 'local', role: 'admin' }, () => addJob(root, { id: 'nuevo', business: 'games', kind: 'analysis', provider: 'orca', title: 'Nuevo', prompt: 'Plan.' }));
  assert.equal(added.actor, 'local');
  const after = await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8');
  assert.ok(after.startsWith(ledger)); assert.equal(after.trim().split('\n').length, 4);
});

test('legacy deliveries, worker statuses and the single-login Tailscale file keep their meaning', async t => {
  const { job } = await legacyRoot(t);
  const delivery = { version: 1, jobId: job.id, jobAttempt: 1, stage: 'reviewer', runId: 'run_legacy0001', taskId: 'task_legacy_reviewer', dispatchId: 'ctx_legacy_reviewer', outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Revisión aprobada.',
    acceptance: [{ criterion: "slugify('') devuelve la cadena vacía ''", status: 'passed', evidence: 'npm test 6/6' }], evidence: ['npm test'], questions: [], decisions: [] };
  assert.equal(validateDelivery(delivery, { jobId: job.id, jobAttempt: 1, stage: 'reviewer', runId: 'run_legacy0001', taskId: 'task_legacy_reviewer', dispatchId: 'ctx_legacy_reviewer', acceptance: job.contract.acceptance }).approval, 'approved');
  const shown = { dispatch: { id: 'ctx_legacy_qa', runId: 'run_legacy0001', taskId: 'task_legacy_qa', assigneeHandle: 'term_old', status: 'completed' }, worker: { dispatchId: 'ctx_legacy_qa', state: 'succeeded', agentTerminalHandle: 'term_old', worktreeId: 'w1' },
    projection: { id: 'ctx_legacy_qa', dispatchId: 'ctx_legacy_qa', runId: 'run_legacy0001', taskId: 'task_legacy_qa', stage: { worker: 'succeeded', dispatch: 'completed' }, outcome: 'succeeded', liveness: { verdict: 'unverifiable' }, workspace: { id: 'w1' } },
    terminal: { handle: 'term_old', worktreeId: 'w1', worktreePath: 'C:/isolated/old', connected: false, writable: false }, observation: { status: 'exited', exactWorker: true }, terminalResource: null };
  const worker = normalizeWorkerStatus(shown);
  assert.equal(worker.liveness, 'exited'); assert.equal(worker.workspace, 'C:/isolated/old'); assert.equal(worker.surface, undefined);
  const access = parseTailscaleAccess(JSON.stringify({ hostname: 'equipo.tailnet.ts.net', login: 'owner@example.test' }));
  assert.equal(access.users.get('owner@example.test'), 'admin'); assert.equal(access.login, 'owner@example.test');
});
