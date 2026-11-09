import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addJob, loadState } from '../../queue.mjs';
import { changeDashboardState } from '../agency-assistant/dashboard-state.mjs';
import { reportCoordinatorQuestions, answerCoordinatorQuestion, readCoordinatorRequest } from '../agency-assistant/coordinator-dialogue.mjs';
import { checkQualityHandoff, recordQualityPlan, verifyQualityQuestion } from '../quality-handoff.mjs';

test('settled QA handoff is durable, deduplicated, and keeps decisions in the routed request', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requestId = 'coord-quality01', senderId = 'term_quality01', runId = 'run_quality01';
  const jobId = 'quality-fixture';
  await addJob(root, { id: jobId, business: 'games', kind: 'analysis', title: 'Validar juego', prompt: 'Validación del juego.',
    coordination: { requestId, senderId, runId, business: 'games' } });
  const state = await loadState(root), job = state.jobs[0];
  const ids = { taskId: 'task_quality01', dispatchId: 'ctx_quality01', resultMessageId: 'msg_quality01', runId };
  Object.assign(job, { state: 'needs_attention', attempts: 2, workflow: { runId, currentStage: 'qa', steps: [{
    ...ids, key: 'qa', status: 'blocked', dispatchSettled: true, delivery: { outcome: 'blocked',
      summary: 'Falta comprobar Android.', acceptance: [{ criterion: 'Android', status: 'unverified', evidence: 'Equipo no disponible' }] },
  }] } });
  await fs.appendFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [job] } }) + '\n');
  await changeDashboardState(root, value => value.coordinatorRequests.push({ id: requestId, jobId, business: 'games', status: 'routed',
    snapshot: { title: job.title, business: 'games' }, notification: { status: 'sent', runId, senderId } }));
  let sent = 0;
  const notify = async (notice, { beforeSend }) => {
    sent++;
    assert.equal(notice.origin.dispatchId, ids.dispatchId);
    assert.equal(notice.snapshot.outstanding.length, 1);
    await beforeSend({ runId, senderId });
    assert.equal((await readCoordinatorRequest(root, requestId)).qualityNotices[0].notification.status, 'sending');
    return { status: 'sent', messageId: 'msg_notice01' };
  };
  const [notice] = await Promise.all([checkQualityHandoff(root, jobId, { notify }), checkQualityHandoff(root, jobId, { notify })]);
  assert.equal(sent, 1);
  const request = await readCoordinatorRequest(root, requestId);
  const origin = { ...notice.origin, senderId };
  const verify = async () => ({ ok: true });
  await assert.rejects(verifyQualityQuestion(root, request, { ...origin, messageId: 'msg_foreign01' }, { verify }), /vigente/);
  const verified = await verifyQualityQuestion(root, request, origin, { verify });
  await recordQualityPlan(root, request, { origin, nextAction: 'Comprobar si hay un dispositivo Android disponible.' }, { verify });
  const asked = await reportCoordinatorQuestions(root, requestId, { origin: verified, roundId: 'quality-ctx_quality01',
    questions: [{ id: 'android', text: '¿Tienes un móvil Android disponible?' }] });
  assert.equal(asked.status, 'routed');
  assert.equal(asked.questions[0].coordinatorRequestId, requestId);
  const response = await answerCoordinatorQuestion(root, asked.questions[0].id, 'Sí, un móvil de pruebas.', { notify: async notice => {
    assert.equal(notice.snapshot.origin.kind, 'quality-block');
    return { status: 'sent', messageId: 'msg_answer01' };
  } });
  assert.equal(response.answerDeliveryStatus, 'sent');
  assert.equal((await loadState(root)).jobs.length, 1);
});
