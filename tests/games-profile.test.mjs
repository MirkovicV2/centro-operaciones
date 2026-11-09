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
  assert.match(profile, /ruta absoluta del script y los argumentos de la línea GUARDA DE VIDEOJUEGOS/);
  assert.match(profile, /solo si devuelve allowed: true/);
  assert.match(profile, /la guarda no está disponible o bloquea el destino, informa al panel antes de leer o editar el juego/);
  assert.match(profile, /ruta real del checkout asignado y la referencia de rama activa \(branch ref\) coinciden exactamente con los valores confirmados para ese job en el panel\/job/);
  assert.match(profile, /"Destino" incluye tanto el checkout como la branch ref, no es solo una confirmaci.n textual/);
  assert.match(profile, /No basta con leer la confirmaci.n: compara la ruta real y la rama activa con ambos valores confirmados/);
  assert.match(profile, /Si no puedes leer\/verificar cualquiera de ellos, o si cualquiera no coincide exactamente, detente sin inspeccionar ni editar contenido del checkout y reporta el dato no verificable o el desajuste al usuario\/panel/);
});

test('games profile confines checkout and allows only a scoped initial scaffold', () => {
  assert.match(profile, /exclusivamente el checkout y la rama confirmados para el job actual/);
  assert.match(profile, /Nunca leas ni escribas el juego original fuera del checkout confirmado/);
  assert.match(profile, /pide por el panel las decisiones faltantes/);
  assert.match(profile, /job confirmado pide expl.citamente migrar Flecha Trampa a Godot y el job o la especificaci.n UX define un criterio verificable/);
  assert.match(profile, /aunque a.n no exista project\.godot/);
  assert.match(profile, /criterio verificable suficiente para iniciar la vertical slice/);
  assert.match(profile, /dentro de ese checkout confirmado/);
  assert.match(profile, /no presupongas que el job autoriza migrar el juego entero/);
  assert.match(profile, /autoriza un juego nuevo en Godot dentro de un repositorio aislado recién preparado/);
  assert.match(profile, /Esa autorización no se extiende a migrar proyectos existentes/);
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
  assert.match(profile, /No instales motor.*no dispares Actions remotamente y no delegues/);
  assert.match(profile, /Si el encargo pide explícitamente CI, añade o modifica únicamente el archivo del workflow necesario/);
  assert.match(profile, /No hagas commits, push, merges, branches, compras ni publicaciones/);
});
