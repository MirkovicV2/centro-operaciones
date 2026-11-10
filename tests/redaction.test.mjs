import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containsSecret, redactSecrets, excerpt } from '../redaction.mjs';
import { addJob } from '../queue.mjs';

// Improvement 8: synthetic tokens only. Shapes follow the public prefixes of each provider.
const synthetic = {
  openai: 'sk-' + 'A1'.repeat(24),
  anthropic: 'sk-ant-api03-' + 'b2'.repeat(30),
  ghp: 'ghp_' + 'C3'.repeat(18),
  gho: 'gho_' + 'd4'.repeat(18),
  ghs: 'ghs_' + 'E5'.repeat(18),
  pat: 'github_pat_' + '11AAAAAAA0' + 'f6'.repeat(30),
  telegram: '123456789:' + 'AAHfG7'.repeat(5) + 'abcde',
};
assert.equal(synthetic.telegram.split(':')[1].length, 35);

test('redactSecrets hides GitHub, Anthropic, OpenAI and Telegram tokens and configured environment keys', () => {
  const text = Object.entries(synthetic).map(([name, token]) => `${name}=${token}`).join(' ') + ' fin';
  const redacted = redactSecrets(text, {});
  for (const token of Object.values(synthetic)) assert.equal(redacted.includes(token), false, token);
  assert.equal(redacted, Object.keys(synthetic).map(name => `${name}=[CLAVE OCULTA]`).join(' ') + ' fin');
  const env = { GH_TOKEN: 'custom-token-value-1234', ANTHROPIC_API_KEY: 'another-secret-value', TELEGRAM_BOT_TOKEN: 'tg-secret-value-xyz' };
  assert.equal(redactSecrets('a custom-token-value-1234 b another-secret-value c tg-secret-value-xyz', env), 'a [CLAVE OCULTA] b [CLAVE OCULTA] c [CLAVE OCULTA]');
  // Ordinary text and look-alikes stay intact.
  for (const plain of ['ghp_short', 'git push origin main', 'sk-12', 'versión 2.103.3', '12345:abc', 'github_pat_x', 'ghx_' + 'A'.repeat(40)]) assert.equal(redactSecrets(plain, {}), plain, plain);
  assert.equal(excerpt(`token ${synthetic.ghp} en stderr`), 'token [CLAVE OCULTA] en stderr');
});

test('containsSecret detects the same tokens so prompts and titles with keys are refused', async t => {
  for (const token of Object.values(synthetic)) assert.equal(containsSecret(`usa ${token} para entrar`, {}), true, token);
  assert.equal(containsSecret('texto normal sin claves', {}), false);
  assert.equal(containsSecret('clave: custom-token-value-1234', { GH_TOKEN: 'custom-token-value-1234' }), true);
  assert.equal(containsSecret('clave corta', { GH_TOKEN: 'abc' }), false);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redaction-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(addJob(root, { id: 'leak', business: 'agency', kind: 'analysis', provider: 'orca', title: 'Token', prompt: `Usa ${synthetic.ghp}.` }), /No guardes claves/);
  await assert.rejects(addJob(root, { id: 'leak2', business: 'agency', kind: 'analysis', provider: 'orca', title: `Bot ${synthetic.telegram}`, prompt: 'x' }), /No guardes claves/);
  assert.equal((await addJob(root, { id: 'clean', business: 'agency', kind: 'analysis', provider: 'orca', title: 'Sin claves', prompt: 'Analizar el plan.' })).state, 'queued');
});
