import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOrca } from '../orca-provider.mjs';

// Improvements 22, 5 and 31: a versioned permissions template for Claude workers and a
// brief that asks for simple, unchained commands (chained ones do not match allow rules).
test('the permissions template allows what a worker needs and denies effects, other hosts and orchestration', async () => {
  const example = JSON.parse(await fs.readFile(new URL('../ejemplos/claude-settings.local.example.json', import.meta.url), 'utf8'));
  const { allow, deny, defaultMode } = example.permissions;
  assert.equal(defaultMode, 'acceptEdits');
  for (const rule of ['Read(//<RAIZ>/data/dispatch-specs/**)', 'Read(//<RAIZ>/data/stage-reports/**)', 'Bash(sha256sum:*)', 'Bash(npm test:*)', 'Bash(git status:*)', 'Bash(git diff:*)',
    'Bash(curl -sS -X POST http://127.0.0.1:<PUERTO>/api/jobs/*/context *)', 'Bash(<ORCA_CLI> orchestration send *--type worker_done*)', 'Bash(<ORCA_CLI> orchestration ask *)', 'Bash(<ORCA_CLI> orchestration dispatch-show *)']) {
    assert.ok(allow.includes(rule), rule);
  }
  for (const rule of ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(gh:*)', 'Bash(sudo:*)', 'Bash(rm:*)', 'Bash(curl https://*)', 'Bash(curl http://localhost*)', 'Bash(<ORCA_CLI> orchestration worker-start:*)', 'Edit(//<RAIZ>/data/**)']) {
    assert.ok(deny.includes(rule), rule);
  }
  // Nothing in allow grants a denied capability.
  for (const rule of allow) assert.equal(deny.includes(rule), false, rule);
  assert.ok(allow.every(rule => !/git (push|commit)|\bgh\b|sudo|\brm\b/.test(rule)));
  assert.ok(!allow.some(rule => rule.includes('https://') || rule.includes('localhost')));
  const text = JSON.stringify(example);
  assert.ok(!text.includes('/home/') && !text.includes('C:\\\\'), 'the template carries placeholders, not personal paths');
});

test('the dispatch brief and the spec ask for one simple command per call and a single curl for the context query', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-brief-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspaces', 'game'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const briefs = [], specs = [], updates = [];
  const ctx = { root, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
  const command = async args => {
    if (args[0] === 'repo') return { repos: [{ path: workspace }] };
    if (args[1] === 'run-create') return { runId: 'run_brief0001' };
    if (args[1] === 'run-show') return { run: { id: 'run_brief0001', coordinator_handle: 'term_brief' } };
    if (args[0] === 'terminal') return { terminal: { handle: 'term_brief', connected: true, writable: true } };
    if (args[1] === 'worker-start') { const brief = args[args.indexOf('--spec') + 1]; briefs.push(brief); specs.push(await fs.readFile(JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]), 'utf8')); const dispatchId = `ctx_brief${briefs.length}`; return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
    if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_brief0001', taskId: `task_${args[3].slice(4)}` };
    if (args[1] === 'inbox') { const key = updates.at(-1).key; return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'OK.\nRESULTADO: APROBADO' : `${key} listo`, payload: JSON.stringify({ dispatchId: `ctx_brief${briefs.length}` }) }] }; }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  await runOrca({ id: 'brief-001', business: 'agency', kind: 'code', provider: 'orca', title: 'Brief', prompt: 'Probar el brief.', workspace, isolated: true, attempts: 1,
    coordination: { requestId: 'coord-brief', runId: 'run_brief0001', senderId: 'term_brief', business: 'agency' } }, ctx, { command });
  assert.equal(briefs.length, 4);
  for (const brief of briefs) {
    assert.match(brief, /COMANDOS: ejecuta un comando simple por llamada, sin ;, &&, \|, variables ni cd\./);
    const file = JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]);
    assert.ok(brief.includes('sha256sum ' + JSON.stringify(file)) && brief.includes('cat ' + JSON.stringify(file)));
  }
  for (const spec of specs) assert.match(spec, /Ejecuta la consulta como un único comando curl, sin encadenarlo con otros comandos ni variables\./);
});
