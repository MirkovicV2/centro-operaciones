import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkGamesCheckoutGuard, evaluateGamesCheckoutGuard } from './games-checkout-guard.mjs';

const checkout = path.resolve('guard-fixture');
const evaluate = (confirmed, observed) => evaluateGamesCheckoutGuard(checkout, confirmed, { realPath: checkout, branchRef: observed });

test('short and full local references identify the same branch in either direction', () => {
  for (const a of ['develop', 'refs/heads/develop', 'feature/demo', 'refs/heads/feature/demo']) {
    const short = a.replace(/^refs\/heads\//, '');
    for (const b of [short, `refs/heads/${short}`]) assert.equal(evaluate(a, b).allowed, true);
  }
});

test('other branches, namespaces and unknown observations remain blocked', () => {
  assert.equal(evaluate('develop', 'main').code, 'branch-mismatch');
  for (const value of ['', 'unknown', 'refs/heads/unknown', 'refs/tags/develop', 'refs/remotes/origin/develop', ' develop', 'develop ', 'a..b', 'a//b', 'a.lock', 'a@{b', '.hidden', 'a\\b']) {
    assert.equal(evaluate(value, 'develop').allowed, false, value);
    assert.equal(evaluate('develop', value).allowed, false, value);
  }
  assert.equal(evaluateGamesCheckoutGuard(checkout, 'develop', { realPath: path.resolve('other'), branchRef: 'develop' }).code, 'path-mismatch');
});

test('real symbolic-ref and detached HEAD regression in a disposable repository', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'games-guard-'));
  try {
    const root = await realpath(temp);
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git('init', '--initial-branch=develop');
    for (const branch of ['develop', 'refs/heads/develop']) assert.equal((await checkGamesCheckoutGuard(root, branch)).allowed, true);
    assert.equal((await checkGamesCheckoutGuard(root, 'main')).code, 'branch-mismatch');
    git('-c', 'user.name=Guard Test', '-c', 'user.email=guard@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    git('checkout', '--detach');
    assert.equal((await checkGamesCheckoutGuard(root, 'develop')).code, 'current-branch-unknown');
  } finally {
    // Only remove the exact unique temporary directory created by this test.
    assert.equal(path.dirname(temp), tmpdir());
    assert.ok(path.basename(temp).startsWith('games-guard-'));
    await rm(temp, { recursive: true, force: true });
  }
});
