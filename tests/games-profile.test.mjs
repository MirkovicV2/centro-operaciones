import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const profileUrl = new URL('../.codex/agents/desarrollador_games.toml', import.meta.url);
const profile = await readFile(profileUrl, 'utf8');

test('games profile requires a confirmed panel job and explicit migration language', () => {
  assert.match(profile, /name\s*=\s*"desarrollador_games"/);
  assert.match(profile, /job nuevo confirmado desde el panel/);
  assert.match(profile, /valores confirmados para ese job en el panel\/job/);
  assert.match(profile, /"migrar Flecha Trampa a Godot"/);
  assert.match(profile, /menci.n gen.rica a Godot.*no autorizan scaffold/s);
  assert.match(profile, /No edites archivos antes/);
  assert.match(profile, /especificaci.n UX/);
});

test('games profile verifies the actual checkout and active branch ref before reading content', () => {
  assert.match(profile, /Antes de inspeccionar o modificar cualquier contenido del checkout/);
  assert.match(profile, /ejecuta el helper local `games-checkout-guard\.mjs`/);
  assert.match(profile, /node games-checkout-guard\.mjs/);
  assert.match(profile, /observa únicamente `realpath` y la branch ref activa con `git symbolic-ref`/);
  assert.match(profile, /solo si devuelve `allowed: true`/);
  assert.match(profile, /ruta confirmada absoluta y normalizada/);
  assert.match(profile, /Si devuelve bloqueo, falla, no está accesible desde el entorno disponible o no puede ejecutarse, detente y pide validación por el panel sin inspeccionar contenido del juego/);
  assert.match(profile, /no sustituyas la guarda por una inspección manual del checkout/);
  assert.match(profile, /ruta real del checkout asignado y la referencia de rama activa \(branch ref\) coinciden exactamente con los valores confirmados para ese job en el panel\/job/);
  assert.match(profile, /"Destino" incluye tanto el checkout como la branch ref, no es solo una confirmaci.n textual/);
  assert.match(profile, /No basta con leer la confirmaci.n: compara la ruta real y la rama activa con ambos valores confirmados/);
  assert.match(profile, /Si no puedes leer\/verificar cualquiera de ellos, o si cualquiera no coincide exactamente, detente sin inspeccionar ni editar contenido del checkout y reporta el dato no verificable o el desajuste al usuario\/panel/);
});

test('games profile confines checkout and allows only a scoped initial scaffold', () => {
  assert.match(profile, /workspaces\/flecha-trampa-github en branch develop solo si/);
  assert.match(profile, /el panel confirma expl.citamente que ese checkout y esa rama\/destino est.n asignados/);
  assert.match(profile, /checkout confirmado en el job/);
  assert.match(profile, /C:\\\\Users\\\\brank\\\\Documents\\\\Proyectos\\\\FlechaTrampa/);
  assert.match(profile, /pide por el panel las decisiones faltantes/);
  assert.match(profile, /job confirmado pide expl.citamente migrar Flecha Trampa a Godot y el job o la especificaci.n UX define un criterio verificable/);
  assert.match(profile, /aunque a.n no exista project\.godot/);
  assert.match(profile, /criterio verificable suficiente para iniciar la vertical slice/);
  assert.match(profile, /dentro de ese checkout confirmado/);
  assert.match(profile, /no presupongas que el job autoriza migrar el juego entero/);
  assert.match(profile, /ni crees o cambies ramas o remotes/);
});

test('games profile retains Godot version, mobile, save, and local validation guards', () => {
  assert.match(profile, /no uses config_version como versi.n de Godot/);
  assert.match(profile, /no lo descargues ni uses la red/);
  assert.match(profile, /no compilaste ni exportaste/);
  assert.match(profile, /pendiente cualquier gate que requiera Godot/);
  for (const term of ['guardados', 't.ctiles', 'resoluciones', 'zonas seguras', 'procesamiento por frame']) {
    assert.ok(term.includes('.') ? new RegExp(term).test(profile) : profile.includes(term), `missing profile guard: ${term}`);
  }
  assert.match(profile, /solo validaciones locales proporcionadas/);
  assert.match(profile, /No instales motor.*no uses GitHub Actions y no delegues/);
  assert.match(profile, /No hagas commits, push, merges, branches, compras, publicaciones ni cambios a Actions/);
});
