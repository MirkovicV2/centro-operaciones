import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addJob, loadState } from '../queue.mjs';

// D: chained ledger. Each event the Centro writes carries the hash of the exact previous line.
const spec = id => ({ id, business: 'agency', kind: 'analysis', provider: 'orca', title: 'Trabajo', prompt: `Analizar ${id}.` });
const hash = line => createHash('sha256').update(line, 'utf8').digest('hex');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-chain-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'data', 'events.jsonl');
  const lines = async () => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  return { root, file, lines };
}

test('new events chain to the exact previous line, from the genesis on', async t => {
  const f = await fixture(t);
  for (const id of ['uno', 'dos', 'tres']) await addJob(f.root, spec(id));
  const lines = await f.lines();
  assert.equal(JSON.parse(lines[0]).prev, '0'.repeat(64));
  assert.equal(JSON.parse(lines[1]).prev, hash(lines[0]));
  assert.equal(JSON.parse(lines[2]).prev, hash(lines[1]));
  assert.equal((await loadState(f.root)).jobs.length, 3);
});

test('an altered, removed or reordered line before a chained event is detected', async t => {
  for (const tamper of [
    lines => [lines[0].replace('Analizar uno', 'Analizar otro'), lines[1], lines[2]],
    lines => [lines[0], lines[2]],
    lines => [lines[1], lines[0], lines[2]],
  ]) {
    const f = await fixture(t);
    for (const id of ['uno', 'dos', 'tres']) await addJob(f.root, spec(id));
    await fs.writeFile(f.file, tamper(await f.lines()).join('\n') + '\n');
    await assert.rejects(loadState(f.root), error => ['ledger_chain_broken', 'ledger_corrupt'].includes(error.code));
  }
  // The content change keeps revisions intact, so only the chain can catch it.
  const f = await fixture(t);
  for (const id of ['uno', 'dos']) await addJob(f.root, spec(id));
  const [first, second] = await f.lines();
  await fs.writeFile(f.file, [first.replace('Analizar uno', 'Analizar otro'), second].join('\n') + '\n');
  await assert.rejects(loadState(f.root), { code: 'ledger_chain_broken' });
});

test('history before D and a manual append at the end stay valid; the next write chains over them', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  const legacy = JSON.stringify({ schema: 1, revision: 1, at: '2026-01-01T00:00:00.000Z', type: 'job_added', details: {}, patch: { jobs: [] } });
  await fs.writeFile(f.file, legacy + '\n');
  await addJob(f.root, spec('nuevo'));
  const lines = await f.lines();
  assert.equal(JSON.parse(lines[1]).prev, hash(legacy));
  const state = await loadState(f.root);
  await fs.appendFile(f.file, JSON.stringify({ schema: 1, revision: state.revision + 1, patch: { jobs: [] } }) + '\n');
  await addJob(f.root, spec('despues'));
  const after = await f.lines();
  assert.equal(JSON.parse(after.at(-1)).prev, hash(after.at(-2)));
  assert.equal((await loadState(f.root)).jobs.length, 2);
});

test('committed events cut from the end are detected against the snapshot before any new write', async t => {
  const f = await fixture(t);
  for (const id of ['uno', 'dos', 'tres']) await addJob(f.root, spec(id));
  const lines = await f.lines();
  await fs.writeFile(f.file, lines.slice(0, 2).join('\n') + '\n');
  await assert.rejects(addJob(f.root, spec('cuatro')), error => error.code === 'ledger_truncated' && /revisión 3, registro en la 2/.test(error.message));
});
