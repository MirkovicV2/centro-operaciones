import test from 'node:test';
import assert from 'node:assert/strict';
import { productJobContract, normalizeJobContract, validateDelivery, deliveryInstructions } from '../workflow-contract.mjs';

const productAcceptance = ['Añadir una tarea con Enter.', 'Rechazar texto vacío.', 'Conservar las tareas al recargar.'];
const successCriteria = 'Producto funcional, QA y revisión aprobados, checks remotos verdes y PR fusionada en main.';
const input = { objective: 'Implementar la lista solicitada.', successCriteria, productAcceptance };

test('explicit product criteria stay separate from the unchanged end-to-end condition', () => {
  const contract = productJobContract(input);
  assert.equal(contract.version, 1); assert.equal(contract.acceptanceScope, 'product');
  assert.deepEqual(contract.acceptance, productAcceptance); assert.deepEqual(contract.productAcceptance, productAcceptance);
  assert.deepEqual(contract.endToEndCriteria, [successCriteria]);
  assert.match(contract.completionCondition, /solo acredita su etapa/);
  assert.deepEqual(normalizeJobContract({ kind: 'code', contract, prompt: 'Criterio de éxito: ' + successCriteria }), contract);
  contract.acceptance.push('Mutación local');
  assert.deepEqual(contract.productAcceptance, productAcceptance);
  assert.equal(productAcceptance.length, 3);
  const literal = 'Mostrar los textos merge, revisión y CI en la interfaz.';
  assert.deepEqual(productJobContract({ ...input, productAcceptance: [literal] }).acceptance, [literal], 'no keyword filtering changes explicit criteria');
});

test('product scope requires explicit bounded independent criteria and an unambiguous acceptance list', () => {
  for (const value of [undefined, '', [], [''], ['A', ' A '], ['A\nB'], ['A'.repeat(2001)], Array.from({ length: 51 }, (_, i) => `Criterio ${i}`)]) {
    assert.throws(() => productJobContract({ ...input, productAcceptance: value }), { code: 'product_acceptance_required', status: 400, uncertain: false });
  }
  const contract = productJobContract(input);
  assert.throws(() => normalizeJobContract({ contract: { ...contract, acceptance: [successCriteria] } }), { code: 'job_contract_invalid' });
  assert.throws(() => normalizeJobContract({ contract: { ...contract, endToEndCriteria: [] } }), { code: 'job_contract_invalid' });
  assert.throws(() => normalizeJobContract({ title: 'Fixture', contract: { productAcceptance } }), { code: 'job_contract_invalid' });
});

test('historical v1 contracts and prompt extraction keep their exact original shape and criteria', () => {
  const spec = { title: 'Original', kind: 'code', prompt: 'Criterio de éxito: ' + successCriteria };
  const legacy = normalizeJobContract(spec);
  assert.deepEqual(legacy.acceptance, [successCriteria]);
  assert.equal(Object.hasOwn(legacy, 'acceptanceScope'), false);
  assert.equal(Object.hasOwn(legacy, 'endToEndCriteria'), false);
  assert.deepEqual(normalizeJobContract({ ...spec, contract: legacy }), legacy);
  const explicit = normalizeJobContract({ ...spec, contract: { acceptance: ['Original agregado: revisión y merge.'], completionCondition: 'Cierre histórico.' } });
  assert.deepEqual(normalizeJobContract({ ...spec, contract: explicit }), explicit);
  assert.equal(explicit.completionCondition, 'Cierre histórico.');
});

test('QA and review can finish their local stage while future gates remain pending; local omissions and failures still block', () => {
  const contract = productJobContract(input);
  for (const stage of ['qa', 'reviewer']) {
    const identity = { jobId: 'product-fixture', jobAttempt: 1, stage, runId: 'run_product1', taskId: 'task_product1', dispatchId: 'ctx_product1' };
    const report = { version: 1, ...identity, outcome: 'completed', scope: 'complete', summary: 'Etapa verificada; integración posterior pendiente.', approval: 'approved',
      acceptance: productAcceptance.map(criterion => ({ criterion, status: 'passed', evidence: 'Comprobación local reproducible.' })), evidence: ['Informe local'], questions: [], decisions: [] };
    const expected = { ...identity, acceptance: contract.acceptance };
    assert.equal(validateDelivery(report, expected).outcome, 'completed');
    for (let i = 0; i < productAcceptance.length; i++) {
      assert.throws(() => validateDelivery({ ...report, acceptance: report.acceptance.filter((_, index) => index !== i) }, expected), { code: 'delivery_acceptance_missing' });
      for (const status of ['failed', 'unverified']) assert.throws(() => validateDelivery({ ...report, acceptance: report.acceptance.map((item, index) => index === i ? { ...item, status } : item) }, expected));
    }
    const prompt = deliveryInstructions({ id: identity.jobId, attempts: 1, contract }, stage, identity.runId);
    assert.match(prompt, /únicos criterios locales obligatorios/);
    assert.match(prompt, /no los marques passed anticipadamente/);
    assert.match(prompt, /sobre el texto global del brief y sobre handoffs históricos/);
    assert.match(prompt, /solo|TU etapa/);
  }
  const legacyPrompt = deliveryInstructions({ id: 'legacy-fixture', attempts: 1, contract: { acceptance: [successCriteria] } }, 'qa', 'run_product1');
  assert.match(legacyPrompt, /cubrir literalmente cada criterio del contrato/);
  assert.doesNotMatch(legacyPrompt, /ALCANCE EXPLÍCITO DE PRODUCTO/);
});
