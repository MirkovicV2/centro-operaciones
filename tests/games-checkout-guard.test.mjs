import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkGamesCheckoutGuard, evaluateGamesCheckoutGuard } from '../games-checkout-guard.mjs';

test('guard allows an absolute canonical path and exact branch ref match', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'games-guard-'));
  try {
    const confirmedPath = await import('node:fs/promises').then(fs => fs.realpath(fixture));
    const result = await checkGamesCheckoutGuard(confirmedPath, 'develop', {
      realpath: async input => input,
      readBranchRef: async input => {
        assert.equal(input, confirmedPath);
        return 'develop';
      },
    });
    assert.deepEqual(result, { allowed: true, code: 'match', message: 'Ruta canónica y branch ref coinciden exactamente.' });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('guard rejects empty and relative confirmed paths before observations', async () => {
  let observed = false;
  const dependencies = {
    realpath: async () => { observed = true; return path.resolve('checkout'); },
    readBranchRef: async () => { observed = true; return 'develop'; },
  };
  assert.equal((await checkGamesCheckoutGuard('', 'develop', dependencies)).code, 'confirmed-path-empty');
  assert.equal((await checkGamesCheckoutGuard('workspaces/game', 'develop', dependencies)).code, 'confirmed-path-invalid');
  assert.equal(observed, false);
});

test('guard stops when local realpath cannot be verified', async () => {
  const confirmedPath = path.resolve('workspaces', 'game');
  let branchRead = false;
  const result = await checkGamesCheckoutGuard(confirmedPath, 'develop', {
    realpath: async () => { throw new Error('missing'); },
    readBranchRef: async () => { branchRead = true; return 'develop'; },
  });
  assert.equal(result.code, 'current-path-unknown');
  assert.equal(branchRead, false);
});

test('guard blocks a realpath mismatch before reading the branch', async () => {
  const confirmedPath = path.resolve('workspaces', 'assigned');
  let branchRead = false;
  const result = await checkGamesCheckoutGuard(confirmedPath, 'develop', {
    realpath: async () => path.resolve('workspaces', 'other'),
    readBranchRef: async () => { branchRead = true; return 'develop'; },
  });
  assert.equal(result.code, 'path-mismatch');
  assert.equal(branchRead, false);
});

test('guard blocks a different branch ref', async () => {
  const confirmedPath = path.resolve('workspaces', 'assigned');
  const result = await checkGamesCheckoutGuard(confirmedPath, 'develop', {
    realpath: async () => confirmedPath,
    readBranchRef: async () => 'release',
  });
  assert.equal(result.code, 'branch-mismatch');
});

test('pure guard stops on unknown confirmed or observed branch refs', () => {
  const confirmedPath = path.resolve('workspaces', 'assigned');
  assert.equal(evaluateGamesCheckoutGuard(confirmedPath, '', { realPath: confirmedPath, branchRef: 'develop' }).code, 'confirmed-branch-unknown');
  assert.equal(evaluateGamesCheckoutGuard(confirmedPath, 'develop', { realPath: confirmedPath, branchRef: 'unknown' }).code, 'current-branch-unknown');
});
