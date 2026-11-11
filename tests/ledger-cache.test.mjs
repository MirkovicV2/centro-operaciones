import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { addJob, loadState, cancelQueuedJob } from '../queue.mjs';

// Each process remembers the ledger it already read and checked (queue.mjs, «Reading and checking the whole
// ledger…»). These tests hold it to the same answers as a complete read, and pin what it still detects.

const here = path.dirname(fileURLToPath(import.meta.url));
const queueModule = pathToFileURL(path.join(here, '..', 'queue.mjs')).href;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(here, 'tmp-'));
  t.after(async () => {
    assert.equal(path.dirname(root), here);
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const spec = (patch = {}) => ({
  id: 'review-001', business: 'games', kind: 'analysis', provider: 'auto', title: 'Revisar idea',
  prompt: 'Preparar tres observaciones sin modificar archivos: acción, señal y canción.', ...patch,
});
const ledgerFile = root => path.join(root, 'data', 'events.jsonl');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
// A new process has nothing remembered: it reads and checks the whole ledger.
function inNewProcess(root, body) {
  const code = `import * as q from ${JSON.stringify(queueModule)}; const root = ${JSON.stringify(root)};
    try { const value = await (async () => { ${body} })(); console.log(JSON.stringify({ value })); }
    catch (error) { console.log(JSON.stringify({ error: error.code || error.message })); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
const completeRead = root => inNewProcess(root, 'return q.loadState(root);');
const lines = async root => (await fs.readFile(ledgerFile(root), 'utf8')).split('\n').filter(Boolean);
const settle = () => wait(80); // past the window in which a just-written file is not yet trusted as unchanged

test('repeated loads, loads after writes and loads after another process writes all equal a complete read', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  assert.deepEqual(await loadState(root), completeRead(root).value);
  for (let i = 0; i < 4; i++) {
    await addJob(root, spec({ id: `mas-${i}`, title: `Título con eñe y emoji 🎯 ${i}` }));
    assert.deepEqual(await loadState(root), await loadState(root));
  }
  await cancelQueuedJob(root, 'mas-1', { confirm: true });
  await settle();
  const warm = await loadState(root);
  assert.deepEqual(warm, completeRead(root).value);
  assert.equal(warm.jobs.find(job => job.id === 'mas-1').state, 'cancelled');
  assert.equal(inNewProcess(root, `return (await q.addJob(root, ${JSON.stringify(spec({ id: 'desde-la-cli' }))})).id;`).value, 'desde-la-cli');
  const after = await loadState(root);
  assert.equal(after.jobs.some(job => job.id === 'desde-la-cli'), true, 'a line appended by another process is picked up');
  assert.deepEqual(after, completeRead(root).value);
  await addJob(root, spec({ id: 'encadena' }));
  assert.equal(completeRead(root).error, undefined, 'a write made from the remembered state chains with the ledger');
});

test('a loaded state is the caller\'s own copy', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await settle();
  const first = await loadState(root);
  first.jobs[0].title = 'cambiado en memoria'; first.jobs.push({ id: 'intruso' }); first.revision = 99;
  const second = await loadState(root);
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0].title, 'Revisar idea');
  assert.equal(second.revision, 1);
});

test('a line altered in place, removed or reordered is detected on the very next load', async t => {
  for (const [name, tamper] of [
    ['same size', all => [all[0].replace('Revisar idea', 'Revisar otra'), ...all.slice(1)]],
    ['longer', all => [all[0].replace('Revisar idea', 'Revisar una idea distinta'), ...all.slice(1)]],
    ['removed', all => [all[0], ...all.slice(2)]],
    ['reordered', all => [all[0], all[2], all[1], ...all.slice(3)]],
  ]) {
    const root = await fixture(t);
    await addJob(root, spec());
    for (let i = 0; i < 3; i++) await addJob(root, spec({ id: `otro-${i}` }));
    await settle();
    assert.equal((await loadState(root)).revision, 4);
    const all = await lines(root);
    assert.equal(sha(all[0]) === JSON.parse(all[1]).prev, true);
    await fs.writeFile(ledgerFile(root), tamper(all).join('\n') + '\n');
    await assert.rejects(loadState(root), error => ['ledger_chain_broken', 'ledger_corrupt'].includes(error.code), name);
    await assert.rejects(addJob(root, spec({ id: 'tras-alterar' })), error => ['ledger_chain_broken', 'ledger_corrupt'].includes(error.code), name);
  }
});

test('a same-size rewrite made in the same instant as the last write is not mistaken for «unchanged»', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await addJob(root, spec({ id: 'otro' }));
  await loadState(root);
  const all = await lines(root);
  const stat = await fs.stat(ledgerFile(root));
  await fs.writeFile(ledgerFile(root), [all[0].replace('Revisar idea', 'Revisar otra'), all[1]].join('\n') + '\n');
  await fs.utimes(ledgerFile(root), stat.atime, stat.mtime);
  await assert.rejects(loadState(root), error => error.code === 'ledger_chain_broken');
});

test('events cut from the end are still refused before any new write', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await addJob(root, spec({ id: 'otro' }));
  await settle();
  await loadState(root);
  const all = await lines(root);
  await fs.writeFile(ledgerFile(root), all[0] + '\n');
  assert.equal((await loadState(root)).revision, 1);
  await assert.rejects(addJob(root, spec({ id: 'tras-cortar' })), error => error.code === 'ledger_truncated');
});

test('a torn final write is ignored by readers and trimmed by the next writer', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await settle();
  const clean = await fs.readFile(ledgerFile(root), 'utf8');
  await loadState(root);
  await fs.appendFile(ledgerFile(root), '{"schema":1,"revision":2,"type":"a medias');
  assert.equal((await loadState(root)).revision, 1);
  await settle();
  assert.equal((await loadState(root)).revision, 1);
  assert.equal((await fs.readFile(ledgerFile(root), 'utf8')).startsWith(clean + '{"schema"'), true, 'readers never trim');
  await addJob(root, spec({ id: 'tras-corte' }));
  const repaired = await fs.readFile(ledgerFile(root), 'utf8');
  assert.equal(repaired.startsWith(clean) && !repaired.includes('a medias'), true);
  assert.deepEqual(await loadState(root), completeRead(root).value);
});

test('an older line rewritten while a valid line is appended is caught by the next complete check, and at once by a new process', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await addJob(root, spec({ id: 'otro' }));
  await settle();
  const state = await loadState(root);
  const all = await lines(root);
  const appended = JSON.stringify({ schema: 1, revision: state.revision + 1, at: new Date().toISOString(), type: 'manual', details: {}, patch: {}, prev: sha(all[1]) });
  await fs.writeFile(ledgerFile(root), [all[0].replace('Revisar idea', 'Revisar otra'), all[1], appended].join('\n') + '\n');
  assert.equal(completeRead(root).error, 'ledger_chain_broken', 'a complete read refuses it');
  assert.equal((await loadState(root)).revision, 3, 'the remembered prefix is trusted until the next complete check');
  // More than a minute later (the clock is moved by hand so the test runs on every supported Node).
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 61_000;
  await assert.rejects(loadState(root), error => error.code === 'ledger_chain_broken');
});

test('a ledger that is deleted or replaced by a shorter one is read again from the start', async t => {
  const root = await fixture(t);
  await addJob(root, spec());
  await addJob(root, spec({ id: 'otro' }));
  await settle();
  assert.equal((await loadState(root)).jobs.length, 2);
  await fs.rm(ledgerFile(root));
  await assert.rejects(loadState(root), error => error.code === 'ledger_missing');
  await fs.rm(path.join(root, 'data', 'state.json'));
  assert.deepEqual((await loadState(root)).jobs, []);
  await addJob(root, spec({ id: 'nuevo' }));
  assert.deepEqual((await loadState(root)).jobs.map(job => job.id), ['nuevo']);
  assert.deepEqual(await loadState(root), completeRead(root).value);
});
