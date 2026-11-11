// Descarga skills de terceros a una revisión concreta y las deja en skills/<id>/ SIN registrarlas.
// Escribe data/skills-descarga.json con la revisión y la huella de cada archivo para revisarlas antes de aceptarlas.
// El registro (skills/registry.json) solo se toca después de leer el contenido: lo que se entrega a los agentes es prompt.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX = 200_000;
const SKILLS = [
  { id: 'taste-skill', repo: 'https://github.com/Leonxlnx/taste-skill.git', path: 'skills/taste-skill' },
  { id: 'impeccable', repo: 'https://github.com/pbakaus/impeccable.git', path: 'plugin/skills/impeccable' },
  { id: 'ponytail', repo: 'https://github.com/DietrichGebert/ponytail.git', path: 'skills/ponytail' },
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...await walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const report = [];
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
try {
  for (const skill of SKILLS) {
    const entry = { id: skill.id, repo: skill.repo, path: skill.path };
    try {
      const dest = path.join(ROOT, 'skills', skill.id);
      try { await fs.access(dest); throw new Error('skills/' + skill.id + ' ya existe; no se sobrescribe.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const clone = path.join(tmp, skill.id);
      execFileSync('git', ['clone', '--depth', '1', skill.repo, clone], { stdio: 'pipe' });
      entry.revision = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const source = path.join(clone, ...skill.path.split('/'));
      const files = await walk(source);
      entry.skipped = []; entry.files = {};
      await fs.mkdir(dest, { recursive: true });
      for (const file of files) {
        const bytes = await fs.readFile(path.join(source, ...file.split('/')));
        if (bytes.length > MAX || /\.(exe|dll|so|dylib|bin|zip|png|jpe?g|gif|woff2?|mp4)$/i.test(file)) { entry.skipped.push({ file, bytes: bytes.length }); continue; }
        await fs.mkdir(path.dirname(path.join(dest, ...file.split('/'))), { recursive: true });
        await fs.writeFile(path.join(dest, ...file.split('/')), bytes);
        entry.files[file] = { sha256: sha(bytes), bytes: bytes.length };
      }
      const licenseName = (await fs.readdir(clone)).find(name => /^licen[sc]e(\.(txt|md))?$/i.test(name));
      if (licenseName) {
        const bytes = await fs.readFile(path.join(clone, licenseName));
        await fs.writeFile(path.join(dest, 'LICENSE.txt'), bytes);
        entry.files['LICENSE.txt'] = { sha256: sha(bytes), bytes: bytes.length, from: licenseName };
      } else entry.licenseMissing = true;
      entry.ok = Boolean(entry.files['SKILL.md']);
      if (!entry.ok) entry.error = 'No hay SKILL.md en la ruta esperada.';
    } catch (error) { entry.ok = false; entry.error = String(error.message ?? error).slice(0, 500); }
    report.push(entry);
  }
} finally { await fs.rm(tmp, { recursive: true, force: true }); }
await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'data', 'skills-descarga.json'), JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
for (const item of report) console.log((item.ok ? 'OK    ' : 'ERROR ') + item.id + ' ' + (item.revision ?? '') + ' ' + (item.error ?? Object.keys(item.files).length + ' archivos'));
