import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceFromSuccessCriteria, normalizeJobContract, validateDelivery } from '../workflow-contract.mjs';

const criteria = [
  '1. Añadir tareas mediante botón y tecla Enter.',
  '2. Rechazar tareas vacías.',
  '3. Marcar tareas como completadas y eliminarlas.',
  '4. Conservarlas al recargar la página.',
  '5. Funcionar a 320 px de ancho y permitir uso con teclado.',
];

test('new explicit criteria preserve each numbered LF/CRLF item and its literal text', () => {
  for (const ending of ['\n', '\r\n']) {
    assert.deepEqual(acceptanceFromSuccessCriteria(criteria.join(ending)), criteria);
    assert.deepEqual(acceptanceFromSuccessCriteria('Criterios de aceptación:' + ending + criteria.join(ending)), criteria);
  }
  assert.deepEqual(acceptanceFromSuccessCriteria('  Un criterio único.  '), ['Un criterio único.']);
  assert.deepEqual(acceptanceFromSuccessCriteria('- Añadir.\n- Borrar.'), ['- Añadir.', '- Borrar.']);
  assert.deepEqual(acceptanceFromSuccessCriteria('• Añadir.\n\n• Borrar.'), ['• Añadir.', '• Borrar.']);
});

test('indented list continuations join their item, and ambiguous wrapped prose remains intact', () => {
  assert.deepEqual(acceptanceFromSuccessCriteria('1. Guardar tareas\n   al recargar la página.\n2. Permitir teclado.'),
    ['1. Guardar tareas al recargar la página.', '2. Permitir teclado.']);
  assert.deepEqual(acceptanceFromSuccessCriteria('Añadir tareas.\nRechazar tareas vacías.\nConservar el estado.'),
    ['Añadir tareas.', 'Rechazar tareas vacías.', 'Conservar el estado.']);
  for (const text of ['Conservar el estado al\nrecargar la página.', 'Lista solicitada:\n1. Añadir.\n2. Borrar.',
    '1. Añadir.\n2. Borrar.\nUna explicación posterior.']) assert.deepEqual(acceptanceFromSuccessCriteria(text), [text]);
  assert.deepEqual(acceptanceFromSuccessCriteria(''), []);
  assert.throws(() => acceptanceFromSuccessCriteria(['No es texto']), { code: 'job_contract_invalid' });
  assert.throws(() => acceptanceFromSuccessCriteria(Array.from({ length: 51 }, (_, i) => `${i + 1}. Criterio.`).join('\n')), { code: 'job_contract_invalid' });
});

test('legacy prompt and legacy successCriteria normalization remain unchanged', () => {
  const spec = { title: 'Fixture', kind: 'code', prompt: 'Criterios de aceptación:\n' + criteria.join('\n') };
  assert.deepEqual(normalizeJobContract(spec).acceptance, criteria.slice(0, 1));
  assert.deepEqual(normalizeJobContract({ ...spec, successCriteria: criteria.join('\n') }).acceptance, [criteria.join('\n')]);
  const explicit = { ...spec, contract: { objective: 'Objetivo confirmado.', acceptance: acceptanceFromSuccessCriteria(criteria.join('\n')) } };
  assert.deepEqual(normalizeJobContract(explicit).acceptance, criteria);
  assert.deepEqual(normalizeJobContract({ ...explicit, contract: { acceptance: [] } }).acceptance, []);
});

test('QA and review must prove all five newly structured criteria; omitting any one fails', () => {
  for (const stage of ['qa', 'reviewer']) {
    const identity = { jobId: 'criteria-fixture', jobAttempt: 1, stage, runId: 'run_criteria1', taskId: 'task_criteria1', dispatchId: 'ctx_criteria1' };
    const report = { version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: 'Verificados los cinco criterios.', approval: 'approved',
      acceptance: criteria.map(criterion => ({ criterion, status: 'passed', evidence: 'Comprobación reproducible.' })), evidence: ['Cinco comprobaciones realizadas.'], questions: [], decisions: [] };
    const expected = { ...identity, acceptance: acceptanceFromSuccessCriteria(criteria.join('\n')) };
    assert.equal(validateDelivery(report, expected).approval, 'approved');
    for (let index = 0; index < criteria.length; index++) {
      assert.throws(() => validateDelivery({ ...report, acceptance: report.acceptance.filter((_, i) => i !== index) }, expected), { code: 'delivery_acceptance_missing' });
    }
  }
});
