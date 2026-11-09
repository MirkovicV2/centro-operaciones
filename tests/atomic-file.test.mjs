import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceLocalFile } from '../atomic-file.mjs';

test('Windows sharing errors retry only the same prepared file beyond the former 80ms window', async () => {
  let elapsed = 0, attempts = 0;
  await replaceLocalFile('prepared', 'receipt', { clock: () => elapsed, wait: async ms => { elapsed += ms; },
    rename: async (source, destination) => {
      assert.equal(source, 'prepared'); assert.equal(destination, 'receipt');
      if (++attempts <= 7) throw Object.assign(Error('sharing'), { code: 'EPERM' });
    } });
  assert.equal(attempts, 8); assert.ok(elapsed > 80 && elapsed < 1500);
});

test('permanent errors and exceeded sharing deadline remain failures', async () => {
  let elapsed = 0, attempts = 0;
  await assert.rejects(replaceLocalFile('prepared', 'receipt', { clock: () => elapsed, wait: async ms => { elapsed += ms; }, retryMs: 70,
    rename: async () => { attempts++; throw Object.assign(Error('sharing'), { code: 'EBUSY' }); } }), /sharing/);
  assert.ok(elapsed >= 70 && attempts < 10);
  attempts = 0;
  await assert.rejects(replaceLocalFile('prepared', 'receipt', { rename: async () => { attempts++; throw Object.assign(Error('missing'), { code: 'ENOENT' }); } }), /missing/);
  assert.equal(attempts, 1);
});
