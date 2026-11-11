import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// attentionItems() lives in a classic browser script; it is evaluated alone, with no DOM, to check which requests
// the Atención inbox lists.
function loadAttentionItems() {
  const source = fs.readFileSync(new URL('../dashboard/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function attentionItems(data)');
  assert.ok(start > 0, 'attentionItems exists');
  let depth = 0, end = source.indexOf('{', start);
  for (; end < source.length; end++) {
    if (source[end] === '{') depth++;
    else if (source[end] === '}' && --depth === 0) break;
  }
  const context = { businessNames: { agency: 'Agencia' }, location: {}, document: {}, result: null };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end + 1)};result = attentionItems;`, context);
  return context.result;
}

test('a withdrawn or discarded request no longer appears in the Atención inbox, even with an unconfirmed notice', () => {
  const attentionItems = loadAttentionItems();
  const request = status => ({ id: 'coord-1', business: 'agency', createdAt: '2026-11-11T10:00:00Z', status, snapshot: { title: 'Web' }, notification: { status: 'needs_attention', reason: 'La solicitud conserva otro destinatario.' } });
  const listed = status => attentionItems({ jobs: [], questions: [], coordinatorRequests: [request(status)], queue: { counts: {} } }).filter(item => item.kind === 'request').length;
  assert.equal(listed('needs_attention'), 1);
  assert.equal(listed('pending'), 1);
  assert.equal(listed('withdrawn'), 0);
  assert.equal(listed('answered'), 0);
});
