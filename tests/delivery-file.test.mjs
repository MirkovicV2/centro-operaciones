import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryFileInstructions, deliveryFilePath, isDeliveryFileMarker, resolveDeliveryText } from '../delivery-file.mjs';
import { parseDelivery, criterionId } from '../workflow-contract.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = { jobId: 'idea-0f33595e-b7a0-46ee-8a42-d140074fc790-v1-code', jobAttempt: 1, stage: 'qa', runId: 'run_d6fadfc7e433', taskId: 'task_d81ff9cee2f5', dispatchId: 'ctx_773785a72173' };
const criterion = "`reverse('abc') === 'cba'`.";

test('a delivery written to its file reaches the engine byte for byte: apostrophes, accents and quotes survive', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'entrega-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = deliveryFilePath(root, identity);
  assert.equal(path.relative(root, file), path.join('entregas', identity.jobId, 'qa-1.json'));
  const body = { version: 1, ...identity, outcome: 'completed', scope: 'complete', approval: 'approved', summary: 'Revisión: añadida «reverse»; "comillas" y \'apóstrofos\'.',
    acceptance: [{ criterion, criterionId: criterionId(criterion), status: 'passed', evidence: "reverse('abc') devuelve 'cba'" }], evidence: ['npm test 22/22'], questions: [], decisions: [], findings: [] };
  const bytes = Buffer.from(JSON.stringify(body, null, 2), 'utf8');
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
  const marker = `centro-delivery-file sha256=${sha(bytes)}`;
  assert.equal(isDeliveryFileMarker(marker), true); assert.equal(isDeliveryFileMarker(marker + ' extra'), false);
  const text = await resolveDeliveryText(root, identity, marker);
  const delivery = parseDelivery(text, { ...identity, acceptance: [criterion] }, { required: true, strictReview: true });
  assert.equal(delivery.summary, body.summary); assert.equal(delivery.acceptance[0].criterion, criterion);
  // Inline deliveries keep working unchanged.
  const inline = '```centro-delivery\n' + JSON.stringify(body) + '\n```';
  assert.equal(await resolveDeliveryText(root, identity, inline), inline);
  // A file changed after sending, a missing file or another stage's file are refused, never read as the delivery.
  await fs.writeFile(file, Buffer.concat([bytes, Buffer.from(' ')]));
  await assert.rejects(resolveDeliveryText(root, identity, marker), { code: 'delivery_file_mismatch' });
  await assert.rejects(resolveDeliveryText(root, { ...identity, stage: 'reviewer' }, marker), { code: 'delivery_file_missing' });
  await fs.rm(file); await fs.symlink(path.join(root, 'otro.json'), file).catch(() => {});
  if ((await fs.lstat(file).catch(() => null))?.isSymbolicLink()) await assert.rejects(resolveDeliveryText(root, identity, marker), { code: 'delivery_file_invalid' });
  assert.throws(() => deliveryFilePath(root, { ...identity, jobId: '../fuera' }), { code: 'delivery_file_invalid' });
});

test('the brief names the exact file and the one line to send', () => {
  const lines = deliveryFileInstructions('/home/x/centro de operaciones', identity);
  assert.match(lines, /"\/home\/x\/centro de operaciones\/entregas\/idea-0f33595e-b7a0-46ee-8a42-d140074fc790-v1-code\/qa-1\.json"/);
  assert.match(lines, /centro-delivery-file sha256=<64 hex>/); assert.match(lines, /Solo si no puedes escribir ese archivo/);
});

test('QA and Revisión receive the context Desarrollo consulted, bounded, instead of having to fetch it', async t => {
  const { developerContextForReview } = await import('../orca-provider.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ctx-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = { id: identity.jobId };
  assert.equal(await developerContextForReview(root, job, 1), null, 'nothing consulted, nothing handed over');
  const dir = path.join(root, 'data', 'knowledge-consultations'); await fs.mkdir(dir, { recursive: true });
  const write = async (stage, attempt, excerpt, sources = 1) => {
    const receipt = { schemaVersion: 1, id: 'knowledge-' + sha(stage + attempt).slice(0, 32), jobId: job.id, actor: { kind: 'worker', stage, jobAttempt: attempt }, createdAt: new Date(Date.now() + attempt).toISOString(), connected: true, warnings: [],
      sources: Array.from({ length: sources }, (_, i) => ({ id: `source-${i}`, title: 'Decisiones', path: 'Contexto/sandbox.md', startLine: 1, endLine: 3, excerpt, state: 'vigente', current: true, sha256: 'x', obsidianUrl: 'obsidian://x' })) };
    receipt.evidenceSha256 = sha(JSON.stringify(receipt));
    await fs.writeFile(path.join(dir, receipt.id + '.json'), JSON.stringify(receipt));
  };
  await write('qa', 1, 'no es de Desarrollo');
  assert.equal(await developerContextForReview(root, job, 1), null);
  await write('developer', 1, 'Las funciones de text.mjs devuelven cadena vacía si la entrada no es texto.');
  const text = await developerContextForReview(root, job, 1);
  const value = JSON.parse(text);
  assert.equal(value.sources[0].excerpt, 'Las funciones de text.mjs devuelven cadena vacía si la entrada no es texto.');
  assert.equal('obsidianUrl' in value.sources[0], false);
  await write('developer', 2, 'x'.repeat(1500), 10);
  const big = JSON.parse(await developerContextForReview(root, job, 2));
  assert.equal(big.truncated, true); assert.ok(JSON.stringify(big).length <= 8000);
});
