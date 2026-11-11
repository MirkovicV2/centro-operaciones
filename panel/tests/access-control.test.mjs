import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTailscaleAccess, roleAllows, assertRoleAllows, ACCESS_ROLES } from '../access-control.mjs';

// Improvement 7: two people through Tailscale with roles.
test('parseTailscaleAccess accepts the legacy single login as admin and the new users list', () => {
  const legacy = parseTailscaleAccess(JSON.stringify({ hostname: 'pc.tailnet.ts.net', login: 'owner@example.test' }));
  assert.equal(legacy.login, 'owner@example.test'); assert.deepEqual([...legacy.users], [['owner@example.test', 'admin']]);
  const shared = parseTailscaleAccess({ hostname: 'pc.tailnet.ts.net', users: [{ login: 'owner@example.test', role: 'admin' }, { login: 'peer@example.test', role: 'ejecutar' }, { login: 'reviewer@example.test', role: 'revisar' }] });
  assert.equal(shared.login, 'owner@example.test'); assert.equal(shared.users.get('peer@example.test'), 'ejecutar'); assert.equal(shared.users.size, 3);
  const mixed = parseTailscaleAccess({ hostname: 'pc.tailnet.ts.net', login: 'owner@example.test', users: [{ login: 'peer@example.test', role: 'revisar' }] });
  assert.equal(mixed.users.get('owner@example.test'), 'admin'); assert.equal(mixed.users.get('peer@example.test'), 'revisar');
  assert.deepEqual(ACCESS_ROLES, ['admin', 'ejecutar', 'revisar']);
  for (const bad of [{ hostname: 'pc.ts.net', login: 'x@y' }, { hostname: 'pc.tailnet.ts.net' }, { hostname: 'pc.tailnet.ts.net', users: [] }, { hostname: 'pc.tailnet.ts.net', users: [{ login: 'a@b', role: 'owner' }] },
    { hostname: 'pc.tailnet.ts.net', users: [{ login: '', role: 'admin' }] }, { hostname: 'pc.tailnet.ts.net', users: [{ login: 'a@b', role: 'admin' }, { login: 'a@b', role: 'revisar' }] }, { hostname: 'evil.example.com', users: [{ login: 'a@b', role: 'admin' }] }]) {
    assert.throws(() => parseTailscaleAccess(bad), /Tailscale inválida/, JSON.stringify(bad));
  }
});

test('roles: revisar reads only, ejecutar cannot change configuration or projects, admin can do everything', () => {
  const posts = ['/api/jobs', '/api/jobs/j1/retry', '/api/jobs/j1/resolve', '/api/jobs/j1/resume', '/api/auto-run/r1/retry-checkout', '/api/auto-run/r1/review', '/api/coordinator/requests/c1/route', '/api/ideas/i1/coordinator', '/api/questions/q1/answer'];
  const adminOnly = ['/api/config', '/api/pipeline', '/api/auto-run', '/api/projects', '/api/projects/p1/update'];
  for (const pathname of [...posts, ...adminOnly, '/api/state']) {
    assert.equal(roleAllows('revisar', 'GET', pathname), true); assert.equal(roleAllows('admin', 'POST', pathname), true);
    assert.equal(roleAllows('revisar', 'POST', pathname), false);
  }
  for (const pathname of posts) assert.equal(roleAllows('ejecutar', 'POST', pathname), true, pathname);
  for (const pathname of adminOnly) assert.equal(roleAllows('ejecutar', 'POST', pathname), false, pathname);
  assert.equal(roleAllows('visitor', 'GET', '/api/state'), false); assert.equal(roleAllows(undefined, 'GET', '/api/state'), false);
  assert.throws(() => assertRoleAllows('revisar', 'POST', '/api/jobs'), error => error.status === 403 && error.code === 'role_forbidden' && /solo consulta/.test(error.message));
  assert.throws(() => assertRoleAllows('ejecutar', 'POST', '/api/config'), error => error.status === 403 && /rol admin/.test(error.message));
  assert.doesNotThrow(() => assertRoleAllows('ejecutar', 'POST', '/api/jobs'));
});
