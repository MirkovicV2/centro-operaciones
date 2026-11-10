import test from 'node:test';
import assert from 'node:assert/strict';
import { jobReport } from '../job-report.mjs';

// E: the per-job report separates what the Centro verified, what an agent reported and what nobody showed.
const step = (key, extra = {}) => ({ key, status: 'succeeded', runId: 'run_report01', taskId: `task_${key}01`, dispatchId: `ctx_${key}01`, ...extra });
const job = (extra = {}) => ({ id: 'job-e', title: 'Formulario de contacto', state: 'succeeded', attempts: 1, autoIntent: { eligible: true, receiptId: 'r-e' },
  contract: { objective: 'Añadir un formulario de contacto', acceptance: ['Valida el email', 'Muestra confirmación'] },
  workflow: { steps: [step('ux'), step('developer'),
    step('qa', { delivery: { summary: 'Pruebas en verde', acceptance: [{ criterion: 'Valida el email', status: 'passed', evidence: 'npm test' }] } }),
    step('reviewer', { delivery: { summary: 'Sin defectos', candidate: 'c'.repeat(64), acceptance: [{ criterion: 'Valida el email', status: 'passed', evidence: 'revisión manual' }],
      findings: [{ severity: 'non_blocking', summary: 'Texto del botón poco claro', evidence: 'captura' }] } })] }, ...extra });
const merged = { phase: 'complete', status: 'completed', commitSha: 'a'.repeat(40), prUrl: 'https://github.com/o/r/pull/3', checkState: 'passed', mergeSha: 'b'.repeat(40), sourceBranch: 'feature', baseBranch: 'main' };

test('criteria take the latest verdict (Revisión before QA) and an uncovered criterion is unknown', () => {
  const report = jobReport(job(), merged);
  assert.deepEqual(report.criteria.map(item => [item.criterion, item.status, item.stage, item.level]),
    [['Valida el email', 'passed', 'reviewer', 'reported'], ['Muestra confirmación', 'unverified', null, 'unknown']]);
  assert.equal(report.asked.objective, 'Añadir un formulario de contacto');
});

test('dispatches and Git effects are observed; agent summaries and findings are reported', () => {
  const report = jobReport(job(), merged);
  const reviewer = report.stages.find(stage => stage.key === 'reviewer');
  assert.equal(reviewer.facts.find(fact => fact.label === 'Dispatch').level, 'observed');
  assert.equal(reviewer.facts.find(fact => fact.label === 'Resumen del agente').level, 'reported');
  assert.deepEqual(reviewer.facts.find(fact => fact.label === 'Hallazgo menor'), { label: 'Hallazgo menor', value: 'Texto del botón poco claro', evidence: 'captura', level: 'reported' });
  assert.deepEqual(report.integration.facts.map(fact => [fact.label, fact.level]), [['Fase', 'observed'], ['Commit', 'observed'], ['PR', 'observed'], ['Checks', 'observed'], ['Merge', 'observed']]);
  assert.ok(report.totals.observed > 0 && report.totals.reported > 0 && report.totals.unknown === 1);
});

test('missing evidence never reads as verified', () => {
  const noDispatch = job({ workflow: { steps: [{ key: 'developer', status: 'succeeded', summary: 'Hecho' }] } });
  const report = jobReport(noDispatch, null);
  const developer = report.stages.find(stage => stage.key === 'developer');
  assert.equal(developer.level, 'unknown'); assert.equal(developer.facts[0].level, 'unknown');
  assert.equal(report.stages.find(stage => stage.key === 'qa').status, 'not_started');
  assert.deepEqual(report.integration.facts, [{ label: 'Integración', value: 'sin registro', level: 'unknown' }]);
  const open = jobReport(job(), { ...merged, phase: 'checks_pending', status: 'checks_pending', mergeSha: undefined, checkState: 'waiting' });
  assert.deepEqual(open.integration.facts.at(-1), { label: 'Merge', value: 'no confirmado', level: 'unknown' });
  assert.equal(jobReport({ ...job(), autoIntent: { eligible: false } }).integration.applies, false);
});
