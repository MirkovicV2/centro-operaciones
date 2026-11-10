import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertPanelNotRunning, panelPort, probePanel } from '../cli.mjs';

// Improvements 16 and 19 (H2): a CLI dispatch while the panel consumes the Run is fenced by Orca.
test('panelPort follows CENTRO_OPERATIONS_PORT and falls back to 4187', () => {
  assert.equal(panelPort({}), 4187);
  assert.equal(panelPort({ CENTRO_OPERATIONS_PORT: '4188' }), 4188);
  assert.equal(panelPort({ CENTRO_OPERATIONS_PORT: 'abc' }), 4187);
  assert.equal(panelPort({ CENTRO_OPERATIONS_PORT: '70000' }), 4187);
});

test('a live panel blocks run --execute with panel_active; a closed port lets it continue', async () => {
  const error = await assertPanelNotRunning({ port: 4187, probe: async () => ({ alive: true, status: 200 }) }).then(() => assert.fail('must refuse'), error => error);
  assert.equal(error.code, 'panel_active'); assert.match(error.message, /consumer_fenced/); assert.match(error.message, /4187/);
  assert.deepEqual(await assertPanelNotRunning({ port: 4187, probe: async () => ({ alive: false, reason: 'ECONNREFUSED' }) }), { port: 4187, alive: false });
});

test('probePanel detects a real local listener and reports a refused connection otherwise', async t => {
  const server = http.createServer((_request, response) => { response.writeHead(400, { 'content-type': 'application/json' }); response.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  assert.deepEqual(await probePanel(port), { alive: true, status: 400 });
  await assert.rejects(assertPanelNotRunning({ port }), { code: 'panel_active' });
  await new Promise(resolve => server.close(resolve));
  const closed = await probePanel(port);
  assert.equal(closed.alive, false); assert.equal(closed.reason, 'ECONNREFUSED');
  assert.equal((await assertPanelNotRunning({ port })).alive, false);
});
