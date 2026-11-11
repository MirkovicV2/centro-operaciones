import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildDossier, saveDossier, dossierBrief, contractForBrief } from '../job-dossier.mjs';

const job = { id: 'job_1', title: 'Web', contract: { objective: 'Hacer la web', acceptance: ['A uno', 'B dos'], productAcceptance: ['A uno', 'B dos'] },
  qualityAnswers: [{ question: '¿Logo?', answer: 'Usa el azul' }], continuation: [{ key: 'k', value: 'v' }],
  workflow: { steps: [{ key: 'developer', status: 'succeeded', orcaAgent: 'claude', delivery: { summary: 'Hice X', candidate: 'c'.repeat(64) }, artifact: { path: 'p.txt', sha256: 'd'.repeat(64) } }, { key: 'qa', status: 'queued' }] },
  livenessRecoveryHistory: [{ stage: 'reviewer', qualityAction: { type: 'correction', round: 1, findings: [{ criterion: 'A uno', evidence: 'foco oculto' }] } }] };

test('developer view keeps summaries and correction history; verifier view hides them', () => {
  const dev = buildDossier(job, 'developer'), qa = buildDossier(job, 'qa');
  assert.equal(dev.corrections.length, 1); assert.equal(dev.stages[0].summary, 'Hice X');
  assert.equal(qa.corrections, undefined); assert.equal(qa.correctionRounds, 1); assert.equal(qa.stages[0].summary, undefined);
  assert.equal(qa.stages.length, 1); assert.equal(qa.answers, undefined); assert.equal(dev.answers[0].answer, 'Usa el azul'); assert.equal(dev.decisions, undefined);
});
test('saveDossier is immutable, hashed and idempotent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dossier-'));
  const first = await saveDossier(root, job, 'qa'), again = await saveDossier(root, job, 'qa');
  assert.equal(first.sha256, again.sha256); assert.ok(first.path.includes(first.sha256.slice(0, 16)));
  assert.ok(dossierBrief(first).includes(first.sha256));
  await fs.rm(root, { recursive: true });
});
test('contractForBrief drops the repeated productAcceptance and the objective already in the prompt', () => {
  const out = contractForBrief(job.contract, 'Hacer la web con todo');
  assert.equal(out.productAcceptance, undefined); assert.equal(out.objective, undefined); assert.deepEqual(out.acceptance, ['A uno', 'B dos']);
  assert.equal(contractForBrief({ ...job.contract, productAcceptance: ['otro'] }, '').productAcceptance[0], 'otro');
});
