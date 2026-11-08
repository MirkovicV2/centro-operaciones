import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveDashboardConfig, writeJobNote } from '../agency-assistant/knowledge.mjs';

test('workflow notes in Obsidian retain stage dispatches and update after recovery', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-vault-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await saveDashboardConfig(root, { vaultPath: vault, autoRun: false });

  const job = {
    id: 'job-review-recovery', business: 'games', kind: 'code', title: 'Revisar flujo',
    state: 'needs_attention', finishedAt: '2026-11-08T00:00:00.000Z',
    workflow: {
      status: 'needs_attention', runId: 'run_abcdef', steps: [
        { key: 'ux', label: 'Diseño UX', profile: 'ux', status: 'succeeded', dispatchId: 'ctx_ux0001', attempt: 1, summary: 'Ruta definida.' },
        { key: 'developer', label: 'Implementación', profile: 'desarrollador', status: 'succeeded', dispatchId: 'ctx_dev001', attempt: 1, summary: 'Cambio implementado.' },
        { key: 'qa', label: 'Control de calidad', profile: 'qa', status: 'succeeded', dispatchId: 'ctx_qa0001', attempt: 1, summary: 'RESULTADO: APROBADO' },
        { key: 'reviewer', label: 'Revisión de código', profile: 'revisor', status: 'blocked', dispatchId: 'ctx_rev001', attempt: 1, error: 'interrupted', summary: 'Resultado pendiente.' },
      ],
    },
  };

  const first = await writeJobNote(root, job);
  assert.equal(first.created, true);
  const notePath = path.join(vault, first.path);
  let note = await fs.readFile(notePath, 'utf8');
  assert.match(note, /ctx_ux0001/);
  assert.match(note, /ctx_dev001/);
  assert.match(note, /ctx_qa0001/);
  assert.match(note, /ctx_rev001/);
  assert.match(note, /Resultado pendiente/);

  job.state = 'succeeded';
  job.workflow.status = 'succeeded';
  job.workflow.steps[3] = { ...job.workflow.steps[3], status: 'succeeded', error: undefined, summary: 'Revisión aprobada.\nRESULTADO: APROBADO' };
  job.result = { provider: 'orca-quality-workflow', text: 'RESULTADO: APROBADO' };
  const updated = await writeJobNote(root, job);
  assert.equal(updated.created, true);
  assert.notEqual(updated.path, first.path);
  const finalNotePath = path.join(vault, updated.path);
  note = await fs.readFile(finalNotePath, 'utf8');
  assert.match(note, /flujo_estado: "succeeded"/);
  assert.match(note, /Revisión aprobada/);
  assert.match(note, /RESULTADO: APROBADO/);
  assert.match(await fs.readFile(notePath, 'utf8'), /Resultado pendiente/);
});
