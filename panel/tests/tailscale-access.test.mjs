import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../dashboard.mjs', import.meta.url), 'utf8');
const start = source.indexOf('function assertLocalRequest(');
const end = source.indexOf('\nasync function readJson(', start);
assert.ok(start >= 0 && end > start);
const authorize = vm.runInNewContext(`${source.slice(start, end)}\nassertLocalRequest`, { URL, PORT: 4187 });
const hostname = 'workstation.tailnet.ts.net';
const login = 'owner@example.test';
const access = { hostname, login };
const proxy = {
  host: hostname,
  'x-forwarded-host': hostname,
  'x-forwarded-proto': 'https',
  'tailscale-user-login': login,
};
const request = (method, headers, remoteAddress = '127.0.0.1') => ({ method, headers, socket: { remoteAddress } });

test('Tailscale permits same-account reads and same-origin writes on the configured HTTPS name', () => {
  assert.doesNotThrow(() => authorize(request('GET', proxy), access));
  assert.doesNotThrow(() => authorize(request('POST', { ...proxy, origin: `https://${hostname}` }), access));
});

test('Tailscale rejects other accounts, untrusted forwarding and public Funnel traffic', () => {
  for (const headers of [
    { ...proxy, 'tailscale-user-login': 'other@example.test' },
    { ...proxy, 'tailscale-user-login': undefined },
    { ...proxy, 'tailscale-funnel-request': '?1' },
    { ...proxy, 'x-forwarded-proto': 'http' },
    { ...proxy, 'x-forwarded-host': 'other.tailnet.ts.net' },
    { ...proxy, host: '127.0.0.1:4187' },
  ]) assert.throws(() => authorize(request('GET', headers), access), { status: 403 });
  assert.throws(() => authorize(request('GET', proxy, '192.0.2.1'), access), { status: 403 });
  assert.throws(() => authorize(request('GET', proxy)), { status: 403 });
});

test('Tailscale blocks cross-origin writes and preserves localhost CLI access', () => {
  for (const origin of [undefined, 'null', 'https://outside.example', `http://${hostname}`]) {
    assert.throws(() => authorize(request('POST', { ...proxy, origin }), access), { status: 403 });
  }
  assert.doesNotThrow(() => authorize(request('POST', { host: '127.0.0.1:4187' }), access));
  assert.throws(() => authorize(request('POST', { host: '127.0.0.1:4187', origin: 'https://outside.example' }), access), /Origen/);
});

test('Tailscale with several accounts: listed users receive their role, unlisted accounts get 403, legacy stays admin', () => {
  // The vm realm has its own Object prototype; compare plain values.
  const plain = value => JSON.parse(JSON.stringify(value));
  const shared = { hostname, login, users: new Map([[login, 'admin'], ['peer@example.test', 'ejecutar'], ['reviewer@example.test', 'revisar']]) };
  assert.deepEqual(plain(authorize(request('GET', proxy), shared)), { actor: login, role: 'admin' });
  assert.deepEqual(plain(authorize(request('GET', { ...proxy, 'tailscale-user-login': 'reviewer@example.test' }), shared)), { actor: 'reviewer@example.test', role: 'revisar' });
  assert.deepEqual(plain(authorize(request('POST', { ...proxy, 'tailscale-user-login': 'peer@example.test', origin: `https://${hostname}` }), shared)), { actor: 'peer@example.test', role: 'ejecutar' });
  assert.throws(() => authorize(request('GET', { ...proxy, 'tailscale-user-login': 'stranger@example.test' }), shared), { status: 403 });
  assert.deepEqual(plain(authorize(request('GET', proxy), access)), { actor: login, role: 'admin' });
  assert.deepEqual(plain(authorize(request('POST', { host: '127.0.0.1:4187' }), access)), { actor: 'local', role: 'admin' });
});
