import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readStageContracts, contractsBrief, CONTRACT_MAX_BYTES } from '../project-contracts.mjs';
import { runOrca } from '../orca-provider.mjs';

// B: optional role contracts per scope (global, business, project), kept in the Centro's data.
async function root(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'contracts-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const write = async (dir, scope, stage, text) => { await fs.mkdir(path.join(dir, 'data', 'contracts', scope), { recursive: true }); await fs.writeFile(path.join(dir, 'data', 'contracts', scope, `${stage}.md`), text); };

test('layers apply global, then business, then project; missing or empty layers are skipped', async t => {
  const dir = await root(t);
  assert.deepEqual(await readStageContracts(dir, { business: 'agency', projectId: 'web', stage: 'reviewer' }), []);
  await write(dir, 'global', 'reviewer', 'Revisa accesibilidad.\n');
  await write(dir, 'empresa-agency', 'reviewer', '');
  await write(dir, 'proyecto-web', 'reviewer', 'Comprueba el formulario de contacto.');
  await write(dir, 'proyecto-otro', 'reviewer', 'No debe aparecer.');
  const found = await readStageContracts(dir, { business: 'agency', projectId: 'web', stage: 'reviewer' });
  assert.deepEqual(found.map(item => [item.scope, item.path, item.text]), [
    ['global', 'data/contracts/global/reviewer.md', 'Revisa accesibilidad.'],
    ['proyecto-web', 'data/contracts/proyecto-web/reviewer.md', 'Comprueba el formulario de contacto.']]);
  assert.match(found[0].sha256, /^[a-f0-9]{64}$/);
  const brief = contractsBrief(found);
  assert.match(brief, /No cambian permisos, publicación, el contrato de entrega/);
  assert.ok(brief.indexOf('global') < brief.indexOf('proyecto web'));
  assert.deepEqual(await readStageContracts(dir, { business: 'agency', projectId: '../web', stage: 'reviewer' }).then(items => items.map(item => item.scope)), ['global'], 'an unsafe project id is never a path');
  assert.deepEqual(await readStageContracts(dir, { business: 'agency', projectId: 'web', stage: 'integration' }), []);
});

test('oversized files and links fail closed with an actionable error', async t => {
  const dir = await root(t);
  await write(dir, 'global', 'qa', 'x'.repeat(CONTRACT_MAX_BYTES + 1));
  await assert.rejects(readStageContracts(dir, { stage: 'qa' }), error => error.code === 'project_contract_invalid' && /supera/.test(error.message));
  await fs.rm(path.join(dir, 'data', 'contracts', 'global', 'qa.md'));
  await fs.writeFile(path.join(dir, 'outside.md'), 'secreto');
  await fs.symlink(path.join(dir, 'outside.md'), path.join(dir, 'data', 'contracts', 'global', 'qa.md'));
  await assert.rejects(readStageContracts(dir, { stage: 'qa' }), error => error.code === 'project_contract_invalid' && /enlace/.test(error.message));
});

test('a worker brief carries its stage contracts with provenance; without files the brief is unchanged', async t => {
  const dir = await root(t);
  const workspace = path.join(dir, 'workspaces', 'game'); await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
  const run = async id => {
    const briefs = [], specs = [], updates = [];
    const ctx = { root: dir, signal: new AbortController().signal, async reportStage(update) { updates.push(update); }, registerCleanup() {} };
    const command = async args => {
      if (args[0] === 'repo') return { repos: [{ path: workspace }] };
      if (args[1] === 'run-create') return { runId: 'run_contract01' };
      if (args[1] === 'run-show') return { run: { id: 'run_contract01', coordinator_handle: 'term_contract' } };
      if (args[0] === 'terminal') return { terminal: { handle: 'term_contract', connected: true, writable: true } };
      if (args[1] === 'worker-start') { const brief = args[args.indexOf('--spec') + 1]; briefs.push(brief); specs.push(await fs.readFile(JSON.parse(brief.match(/^SPEC_FILE: (.+)$/m)[1]), 'utf8')); const dispatchId = `ctx_contract${briefs.length}`; return { dispatchId, taskId: `task_${dispatchId.slice(4)}` }; }
      if (args[1] === 'worker-show') return { state: 'succeeded', runId: 'run_contract01', taskId: `task_${args[3].slice(4)}` };
      if (args[1] === 'inbox') { const key = updates.at(-1).key; return { messages: [{ type: 'worker_done', body: ['qa', 'reviewer'].includes(key) ? 'OK.\nRESULTADO: APROBADO' : `${key} listo`, payload: JSON.stringify({ dispatchId: `ctx_contract${briefs.length}` }) }] }; }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    await runOrca({ id, business: 'agency', projectId: 'web', kind: 'code', provider: 'orca', title: 'Contratos', prompt: 'Probar contratos.', workspace, isolated: true, attempts: 1,
      coordination: { requestId: 'coord-contract', runId: 'run_contract01', senderId: 'term_contract', business: 'agency', projectId: 'web' } }, ctx, { command });
    return specs;
  };
  const before = await run('contract-001');
  assert.ok(before.every(spec => !spec.includes('CONTRATOS DE ROL DEL CENTRO')));
  await write(dir, 'proyecto-web', 'reviewer', 'Comprueba el formulario de contacto.');
  const after = await run('contract-002');
  assert.equal(after.length, 4);
  assert.ok(after.slice(0, 3).every(spec => !spec.includes('CONTRATOS DE ROL DEL CENTRO')), 'only the reviewer stage has a contract');
  assert.match(after[3], /CONTRATO proyecto web · data\/contracts\/proyecto-web\/reviewer\.md · sha256 [a-f0-9]{64}\nComprueba el formulario de contacto\./);
  assert.ok(after[3].indexOf('CONTRATOS DE ROL DEL CENTRO') < after[3].indexOf('CONTRATO DE ENTREGA v1'), 'the Centro rules come after the contract');
});
