import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fingerprintCommand, toolingLine } from '../provider-adapter.mjs';
import { STAGE_SECTIONS, STAGE_TERMS, renderStageContract } from '../stage-contract.mjs';
import { readStageContracts, contractsBrief } from '../project-contracts.mjs';

const windowsPath = 'C:\\Users\\Dani\\Centro de Operaciones\\data\\dispatch-specs\\job-1\\qa-attempt-1.txt';
const linuxPath = '/home/david/Centro de Operaciones/data/dispatch-specs/job-1/qa-attempt-1.txt';

test('each provider gets the fingerprint command of its own shell, with the path quoted for spaces', () => {
  assert.equal(fingerprintCommand({ agent: 'codex', platform: 'win32', file: windowsPath }), `(Get-FileHash -Algorithm SHA256 -LiteralPath '${windowsPath}').Hash`);
  assert.equal(fingerprintCommand({ agent: 'codex', platform: 'linux', file: linuxPath }), `sha256sum '${linuxPath}'`);
  // Claude always works through its Bash tool; the text matches the Bash(sha256sum:*) rule of its permission template.
  for (const platform of ['win32', 'linux']) assert.equal(fingerprintCommand({ agent: 'claude', platform, file: linuxPath }), 'sha256sum ' + JSON.stringify(linuxPath));
  assert.equal(fingerprintCommand({ agent: 'claude', platform: 'win32', file: windowsPath }), 'sha256sum "C:\\\\Users\\\\Dani\\\\Centro de Operaciones\\\\data\\\\dispatch-specs\\\\job-1\\\\qa-attempt-1.txt"');
  // A quote inside the path cannot end the argument early.
  assert.equal(fingerprintCommand({ agent: 'codex', platform: 'win32', file: "C:\\Juegos\\L'Ocell\\spec.txt" }), "(Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\\Juegos\\L''Ocell\\spec.txt').Hash");
  assert.equal(fingerprintCommand({ agent: 'codex', platform: 'linux', file: "/srv/l'ocell/spec.txt" }), `sha256sum '/srv/l'\\''ocell/spec.txt'`);
});

test('the POSIX command really prints the fingerprint of a file under a folder with spaces and a quote', { skip: process.platform === 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "centro d'operaciones ")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'encargo $HOME `x`.txt'); await fs.writeFile(file, 'Encargo con tilde: revisión.\n');
  const expected = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  for (const agent of ['codex', 'claude']) {
    if (agent === 'claude' && /[$`]/.test(file)) continue; // JSON quoting is for the Centro's own paths, which never contain shell metacharacters
    assert.equal(execFileSync('sh', ['-c', fingerprintCommand({ agent, platform: 'linux', file })], { encoding: 'utf8' }).split(' ')[0], expected);
  }
  const plain = path.join(dir, 'encargo.txt'); await fs.writeFile(plain, 'x');
  assert.equal(execFileSync('sh', ['-c', fingerprintCommand({ agent: 'claude', platform: 'linux', file: plain })], { encoding: 'utf8' }).split(' ')[0], createHash('sha256').update('x').digest('hex'));
});

test('both providers are told the same things in their own terms: verify, compare, reuse for other artefacts', () => {
  const codexWindows = toolingLine({ agent: 'codex', platform: 'win32', file: windowsPath });
  assert.match(codexWindows, /^VERIFICACIÓN: /); assert.match(codexWindows, /PowerShell la muestra en mayúsculas/); assert.match(codexWindows, /UTF-8 explícito/);
  const codexLinux = toolingLine({ agent: 'codex', platform: 'linux', file: linuxPath });
  assert.match(codexLinux, /^VERIFICACIÓN: /); assert.doesNotMatch(codexLinux, /PowerShell/);
  const claude = toolingLine({ agent: 'claude', platform: 'linux', file: linuxPath });
  assert.match(claude, /^COMANDOS: ejecuta un comando simple por llamada/); assert.match(claude, /\(Read\), no con cat/);
  for (const line of [codexWindows, codexLinux, claude]) {
    assert.match(line, /cualquier otro artefacto del encargo que indique su sha256/);
    assert.equal(line.includes('\n'), false, 'one line of the brief');
  }
  for (const line of [codexWindows, codexLinux]) assert.doesNotMatch(line, /COMANDOS:|\(Read\)|no con cat/, 'Claude-only rules never reach Codex');
});

test('every stage defines what it delivers, what backs it and where rejections and doubts go; a brief cannot lose a section', () => {
  assert.deepEqual(STAGE_SECTIONS.map(([key]) => key), ['objetivo', 'alcance', 'entradas', 'decisiones', 'criterios', 'evidencias', 'devolucion', 'entregables']);
  assert.deepEqual(Object.keys(STAGE_TERMS), ['planner', 'ux', 'developer', 'qa', 'reviewer']);
  for (const [stage, terms] of Object.entries(STAGE_TERMS)) {
    assert.ok(terms.entregables.length > 20 && terms.evidencias.length > 20, stage);
    if (stage !== 'qa') assert.ok(terms.devolucion.length > 20, stage);
  }
  const full = Object.fromEntries(STAGE_SECTIONS.map(([key]) => [key, [`texto de ${key}`]]));
  const rendered = renderStageContract(full);
  assert.deepEqual(rendered.map(block => block.split('\n')[0]), STAGE_SECTIONS.map(([, heading]) => `== ${heading} ==`));
  assert.throws(() => renderStageContract({ ...full, evidencias: ['', null] }), { code: 'stage_contract_invalid', message: /6\. EVIDENCIAS EXIGIDAS/ });
  assert.throws(() => renderStageContract({ ...full, extras: ['x'] }), { code: 'stage_contract_invalid' });
});

test('a shared contract from the repository applies before the local one of the same scope, and both are identified', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contracts-local-')), sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contracts-shared-'));
  t.after(() => Promise.all([root, sharedRoot].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  const write = async (base, parts, text) => { const file = path.join(base, ...parts); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  await write(sharedRoot, ['contratos', 'global', 'reviewer.md'], 'Compartido global.');
  await write(sharedRoot, ['contratos', 'empresa-games', 'reviewer.md'], 'Compartido de Videojuegos.');
  await write(root, ['data', 'contracts', 'global', 'reviewer.md'], 'Local global.');
  await write(root, ['data', 'contracts', 'proyecto-flecha', 'reviewer.md'], 'Local del proyecto.');
  const found = await readStageContracts(root, { business: 'games', projectId: 'flecha', stage: 'reviewer', sharedRoot });
  assert.deepEqual(found.map(item => `${item.scope}:${item.shared ? 'compartido' : 'local'}:${item.path}`), [
    'global:compartido:contratos/global/reviewer.md', 'global:local:data/contracts/global/reviewer.md',
    'empresa-games:compartido:contratos/empresa-games/reviewer.md', 'proyecto-flecha:local:data/contracts/proyecto-flecha/reviewer.md']);
  const brief = contractsBrief(found);
  assert.ok(brief.indexOf('Compartido global.') < brief.indexOf('Local global.') && brief.indexOf('Local global.') < brief.indexOf('Compartido de Videojuegos.') && brief.indexOf('Compartido de Videojuegos.') < brief.indexOf('Local del proyecto.'));
  assert.match(brief, /CONTRATO global \(compartido\) · contratos\/global\/reviewer\.md · sha256 [a-f0-9]{64}/);
  assert.deepEqual(await readStageContracts(root, { business: 'agency', stage: 'qa', sharedRoot }), []);
  // The repository ships the folder and its rules, and no contract that would change today's briefs.
  assert.deepEqual(await readStageContracts(root, { business: 'agency', stage: 'qa' }), []);
});
