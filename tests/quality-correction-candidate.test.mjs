import test from 'node:test';
import assert from 'node:assert/strict';
import { qualityCorrection } from '../queue.mjs';

const CRITERION = 'Toda la página se recorre con teclado, con foco visible.';
const OTHER = 'El teléfono es un enlace tel: que funciona.';
const hash = char => char.repeat(64);

function blockedStep(key, candidate, criteria = [CRITERION]) {
  return { key, status: 'blocked', dispatchSettled: true, dispatchStatus: 'completed', resultMessageId: `msg-${key}`,
    delivery: { outcome: 'blocked', scope: 'complete', ...(candidate ? { candidate } : {}),
      acceptance: criteria.map(criterion => ({ criterion, status: 'failed', evidence: 'Reproducido ejecutando el recorrido.' })) } };
}

function job({ candidate, history = [], rounds = [], criteria } = {}) {
  return { state: 'needs_attention', kind: 'code', provider: 'orca', error: { code: 'delivery_incomplete' },
    contract: { acceptance: [CRITERION, OTHER] },
    workflow: { currentStage: 'reviewer', steps: [{ key: 'qa', status: 'succeeded' }, blockedStep('reviewer', candidate, criteria),
      { key: 'integration', status: 'queued' }] },
    workflowHistory: history,
    livenessRecoveryHistory: rounds.map(findings => ({ qualityAction: { type: 'correction', findings: findings.map(criterion => ({ criterion })) } })) };
}

const firstRound = [{ steps: [blockedStep('qa', hash('a'))] }];

test('the first correction round is allowed', () => {
  assert.equal(qualityCorrection(job({ candidate: hash('a') }))?.round, 1);
});

test('the same criterion on a different candidate is new work and gets another round', () => {
  const next = qualityCorrection(job({ candidate: hash('b'), history: firstRound, rounds: [[CRITERION]] }));
  assert.equal(next?.round, 2);
  assert.equal(next.findings[0].criterion, CRITERION);
});

test('the same criterion on a candidate that was already corrected is a loop without progress', () => {
  assert.equal(qualityCorrection(job({ candidate: hash('a'), history: firstRound, rounds: [[CRITERION]] })), null);
});

test('without a verifiable candidate the old per-criterion guard still applies', () => {
  assert.equal(qualityCorrection(job({ candidate: undefined, history: firstRound, rounds: [[CRITERION]] })), null);
  assert.equal(qualityCorrection(job({ candidate: 'no-es-un-hash', history: firstRound, rounds: [[CRITERION]] })), null);
});

test('a different failed criterion is allowed as before', () => {
  assert.equal(qualityCorrection(job({ candidate: hash('a'), history: firstRound, rounds: [[OTHER]] }))?.round, 2);
});

test('the limit of five correction rounds still holds for new candidates', () => {
  const rounds = Array.from({ length: 5 }, () => [CRITERION]);
  assert.equal(qualityCorrection(job({ candidate: hash('f'), history: firstRound, rounds })), null);
});
