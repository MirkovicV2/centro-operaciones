import test from 'node:test';
import assert from 'node:assert/strict';
import { compactHandoff, verifierView } from '../handoff-view.mjs';
import { handoffText } from '../workflow-contract.mjs';

const artifact = { path: 'data/stage-reports/x.txt', sha256: 'a'.repeat(64) };
const output = { artifact, delivery: { summary: 'Hecho', outcome: 'completed', scope: 'complete', candidate: 'b'.repeat(64),
  acceptance: [{ criterion: 'El foco es visible bajo la cabecera fija', criterionId: 'crit_1', status: 'passed', evidence: 'captura 3' }],
  decisions: [], evidence: ['npm test'], questions: [], findings: [] } };

test('compactHandoff drops criterion text and empty fields but keeps ids, statuses and the report pointer', () => {
  const text = compactHandoff(output);
  assert.ok(!text.includes('El foco es visible'));
  assert.ok(text.includes('crit_1') && text.includes('captura 3') && text.includes(artifact.sha256));
  assert.ok(!text.includes('"questions"') && !text.includes('"decisions"'));
  assert.ok(text.length < handoffText(output).length);
});
test('compactHandoff keeps criterion text when there is no id', () => {
  const text = compactHandoff({ delivery: { ...output.delivery, acceptance: [{ criterion: 'Sin id', status: 'failed', evidence: 'x' }] } });
  assert.ok(text.includes('Sin id'));
});
test('verifierView hides the author summary and self-reported acceptance', () => {
  const text = verifierView(output);
  assert.ok(!text.includes('Hecho') && !text.includes('crit_1') && !text.includes('passed'));
  assert.ok(text.includes('npm test') && text.includes(output.delivery.candidate) && text.includes(artifact.sha256));
});
test('legacy outputs without delivery fall back to the full text', () => {
  const legacy = { text: 'RESULTADO: APROBADO' };
  assert.equal(compactHandoff(legacy), handoffText(legacy));
  assert.equal(verifierView(legacy), handoffText(legacy));
});

import { renderStageContract, STAGE_SECTIONS } from '../stage-contract.mjs';
test('staticFirst keeps every numbered section and puts the evidence first and the deliverables last', () => {
  const sections = Object.fromEntries(STAGE_SECTIONS.map(([key]) => [key, [key]]));
  const normal = renderStageContract(sections), reordered = renderStageContract(sections, { staticFirst: true });
  assert.equal(reordered.length, normal.length);
  assert.deepEqual([...reordered].sort(), [...normal].sort());
  assert.ok(reordered[0].startsWith('== 6. EVIDENCIAS') && reordered.at(-1).startsWith('== 8. ENTREGABLES'));
  assert.ok(normal[0].startsWith('== 1. OBJETIVO'));
});
