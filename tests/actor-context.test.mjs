import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { actorContext, addJob, currentActor, loadState, resolveJob, runQueue } from '../queue.mjs';
import { readAutoRun, setAutoRun } from '../auto-run.mjs';

// Improvement 7: events, new jobs and auto-run history record who acted; old records simply lack the field.
const spec = (id, actor) => ({ id, business: 'agency', kind: 'analysis', provider: 'orca', title: 'Trabajo', prompt: `Analizar ${actor ?? 'sin actor'}.` });

test('jobs, ledger events and auto-run history created inside actorContext carry the actor; outside they do not', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(currentActor(), undefined);
  const byPeer = await actorContext.run({ actor: 'peer@example.test', role: 'ejecutar' }, () => addJob(root, spec('peer-job')));
  assert.equal(byPeer.actor, 'peer@example.test');
  const anonymous = await addJob(root, spec('anon-job'));
  assert.equal(anonymous.actor, undefined);
  await actorContext.run({ actor: 'peer@example.test', role: 'ejecutar' }, () => runQueue(root, { execute: true, worker: async () => { throw new Error('boom'); }, jobId: 'peer-job' }));
  await actorContext.run({ actor: 'owner@example.test', role: 'admin' }, () => resolveJob(root, 'peer-job', { confirm: true }));
  const events = (await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => [event.type, event.actor]), [['job_added', 'peer@example.test'], ['job_added', undefined], ['job_started', 'peer@example.test'], ['operator_required', 'peer@example.test'], ['operator_closed', 'owner@example.test']]);
  const state = await loadState(root);
  assert.equal(state.jobs.find(job => job.id === 'peer-job').actor, 'peer@example.test');
  assert.equal(state.jobs.find(job => job.id === 'anon-job').actor, undefined);
  await actorContext.run({ actor: 'owner@example.test', role: 'admin' }, () => setAutoRun(root, 'agency', true, { confirm: true }));
  const history = (await readAutoRun(root)).history;
  assert.equal(history.at(-1).actor, 'owner@example.test');
  assert.equal(currentActor(), undefined);
  // Whitespace-only or non-string actors are ignored rather than recorded.
  assert.equal(await actorContext.run({ actor: '   ' }, async () => currentActor()), undefined);
  assert.equal(await actorContext.run({ actor: 42 }, async () => currentActor()), undefined);
});

test('a ledger written before actors existed loads unchanged and its jobs have no actor', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'actor-legacy-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  const job = { id: 'legacy', business: 'games', kind: 'analysis', title: 'Antiguo', prompt: 'x', provider: 'orca', attempts: 0, state: 'queued', createdAt: '2026-01-01T00:00:00.000Z', reservedUsd: 0, maxAttempts: 5 };
  const budget = { limitUsd: 0, reservedUsd: 0, estimatedSpentUsd: 0, model: '', inputPerMillion: 0, outputPerMillion: 0 };
  await fs.writeFile(path.join(root, 'data', 'events.jsonl'), JSON.stringify({ schema: 1, revision: 1, at: '2026-01-01T00:00:00.000Z', type: 'job_added', details: { jobId: 'legacy' }, patch: { jobs: [job], budget } }) + '\n');
  const state = await loadState(root);
  assert.equal(state.jobs[0].actor, undefined); assert.equal(state.revision, 1);
  const added = await actorContext.run({ actor: 'local', role: 'admin' }, () => addJob(root, spec('new-job')));
  assert.equal(added.actor, 'local');
  const events = (await fs.readFile(path.join(root, 'data', 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].actor, undefined); assert.equal(events[1].actor, 'local');
});
