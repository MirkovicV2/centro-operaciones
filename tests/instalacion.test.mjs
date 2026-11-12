import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLocalConfig } from '../instalacion.mjs';
import { readPipeline } from '../pipeline-config.mjs';
import { readTeam } from '../team.mjs';
import { LAUNCH_LEVELS } from '../orca-provider.mjs';
import { listReferences } from '../references.mjs';

const codeRoot = fileURLToPath(new URL('../', import.meta.url));
const tmp = async t => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'instalar-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };

test('installing creates the shared pipeline profile and this PC identity, per operating system', async t => {
  for (const [platform, id] of [['win32', 'dani-windows'], ['linux', 'david-ubuntu']]) {
    const root = await tmp(t);
    const report = await installLocalConfig(root, { platform, referencias: false });
    assert.deepEqual(report.created.sort(), ['data/equipo.json', 'data/pipeline.json']);
    const pipeline = await readPipeline(root, { levelNames: LAUNCH_LEVELS });
    assert.equal(pipeline.general.roles.desarrollador.agent, 'claude');
    assert.equal(pipeline.general.roles.qa.agent, 'codex');
    assert.deepEqual(pipeline.proyectos, {}, 'project ids are local and never shared');
    const team = await readTeam(root, { codeRoot });
    assert.equal(team.configured, true); assert.equal(team.id, id);
  }
});

test('installing never overwrites local files and can skip the pipeline', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data', 'pipeline.json'), '{"version":1,"propio":true}');
  const first = await installLocalConfig(root, { platform: 'linux', referencias: false });
  assert.deepEqual(first.kept, ['data/pipeline.json']); assert.deepEqual(first.created, ['data/equipo.json']);
  assert.match(await fs.readFile(path.join(root, 'data', 'pipeline.json'), 'utf8'), /propio/);
  const again = await installLocalConfig(root, { platform: 'linux', referencias: false });
  assert.deepEqual(again.created, []);
  const other = await tmp(t);
  assert.deepEqual((await installLocalConfig(other, { platform: 'linux', pipeline: false, referencias: false })).created, ['data/equipo.json']);
  await assert.rejects(fs.access(path.join(other, 'data', 'pipeline.json')));
});

test('an unknown system gets a note instead of a guessed identity, and no personal data is versioned', async t => {
  const root = await tmp(t);
  const report = await installLocalConfig(root, { platform: 'freebsd', pipeline: false, referencias: false });
  assert.deepEqual(report.created, []); assert.match(report.notes[0], /no tiene equipo/);
  const shared = await fs.readFile(path.join(codeRoot, 'perfil-equipo', 'pipeline.json'), 'utf8');
  assert.doesNotMatch(shared, /project-[a-z0-9]{8}/); assert.doesNotMatch(shared, /Users|home\//);
});

test('installing imports the shared reference sets once, verified, and never replaces a set the PC already has', async t => {
  const root = await tmp(t);
  const first = await installLocalConfig(root, { platform: 'linux', pipeline: false });
  const sets = (await listReferences(root)).map(item => `${item.scope}/${item.name}:${item.status}`).sort();
  assert.deepEqual(sets, ['empresa-agency/webs-inspiracion:ok', 'global/paneles-agentes:ok']);
  assert.ok(first.created.includes('data/references/global/paneles-agentes') && first.created.includes('data/references/empresa-agency/webs-inspiracion'));
  // The PC owns its sets: a local edit survives a second install.
  const manifest = path.join(root, 'data', 'references', 'global', 'paneles-agentes', 'manifest.json');
  await fs.writeFile(path.join(root, 'data', 'references', 'global', 'paneles-agentes', 'files', 'notas.md'), 'nota propia');
  const again = await installLocalConfig(root, { platform: 'linux', pipeline: false });
  assert.ok(again.kept.includes('data/references/global/paneles-agentes'));
  assert.equal(again.created.includes('data/references/global/paneles-agentes'), false);
  assert.equal(await fs.readFile(path.join(root, 'data', 'references', 'global', 'paneles-agentes', 'files', 'notas.md'), 'utf8'), 'nota propia');
  assert.ok((await fs.stat(manifest)).size > 0);
  const skipped = await tmp(t);
  await installLocalConfig(skipped, { platform: 'linux', pipeline: false, referencias: false });
  assert.deepEqual(await listReferences(skipped), []);
});

test('the shared reference sets only hold supported, small files and no personal paths', async () => {
  const base = path.join(codeRoot, 'perfil-equipo', 'referencias');
  let count = 0;
  for (const scope of await fs.readdir(base)) for (const set of await fs.readdir(path.join(base, scope))) for (const file of await fs.readdir(path.join(base, scope, set))) {
    assert.match(file, /\.(jpe?g|png|webp|gif|md)$/i, `${scope}/${set}/${file}`);
    const stat = await fs.stat(path.join(base, scope, set, file));
    assert.ok(stat.size <= 5_000_000, `${file} supera 5 MB`); count++;
  }
  assert.ok(count > 0);
});
