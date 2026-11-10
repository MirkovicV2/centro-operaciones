import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcceptanceFile, validateBranchOption } from '../cli.mjs';
import { normalizeJobContract } from '../workflow-contract.mjs';

// Improvement 6 (F5): cli.mjs add --branch and --acceptance-file match the coordinated path.
test('parseAcceptanceFile accepts a JSON list or one criterion per line and rejects invalid lists', () => {
  assert.deepEqual(parseAcceptanceFile('["slugify(\'\') devuelve \'\'", "capitalize sin cambios"]'), ["slugify('') devuelve ''", 'capitalize sin cambios']);
  assert.deepEqual(parseAcceptanceFile('﻿- Criterio uno.\n\n2. Criterio dos.\n  * Criterio tres\n'), ['Criterio uno.', 'Criterio dos.', 'Criterio tres']);
  for (const bad of ['', '   ', '[', '{"a":1}', '[1, 2]', '["a", "a"]', '["a", " A  "]', JSON.stringify(Array.from({ length: 51 }, (_, i) => `c${i}`)), JSON.stringify(['x'.repeat(2001)])]) {
    assert.throws(() => parseAcceptanceFile(bad), { code: 'queue_error' }, JSON.stringify(bad).slice(0, 40));
  }
  // The result is exactly what the coordinated path stores in the contract.
  const contract = normalizeJobContract({ kind: 'code', title: 'T', contract: { version: 1, acceptance: parseAcceptanceFile('["uno", "dos"]') } });
  assert.deepEqual(contract.acceptance, ['uno', 'dos']); assert.equal(contract.criteriaSource, 'explicit');
});

test('validateBranchOption keeps valid Git branch names and rejects dangerous ones', () => {
  for (const branch of ['main', 'e2e/slugify', 'feature-1', 'release.2', 'david/soporte-claude']) assert.equal(validateBranchOption(branch), branch);
  assert.equal(validateBranchOption(undefined), undefined);
  for (const bad of ['', ' ', '-flag', '/abs', 'a..b', 'a b', 'a\\b', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[0]', 'trailing/', 'x.lock', 'a\nb']) {
    assert.throws(() => validateBranchOption(bad), { code: 'queue_error' }, JSON.stringify(bad));
  }
});
