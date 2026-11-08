import test from 'node:test';
import assert from 'node:assert/strict';
import { approved } from '../orca-provider.mjs';

test('the approval gate accepts the exact final label on its own line', () => {
  assert.equal(approved('QA passed.\nRESULTADO: APROBADO'), true);
});

test('the approval gate accepts the exact final label after a summary line', () => {
  assert.equal(approved('No reproducible defects found.\nRESULTADO: APROBADO'), true);
});

test('the approval gate ignores approval text that is not the final label', () => {
  assert.equal(approved('RESULTADO: APROBADO\nOne blocker remains.'), false);
  assert.equal(approved('RESULTADO: BLOQUEADO'), false);
  assert.equal(approved('No puedo concluir. RESULTADO: APROBADO?'), false);
  assert.equal(approved('No debe interpretarse como RESULTADO: APROBADO'), false);
  assert.equal(approved('Falta validacion esencial; no puedo emitir RESULTADO: APROBADO'), false);
  assert.equal(approved('RESULTADO: BLOQUEADO\nNo emitir RESULTADO: APROBADO'), false);
});
