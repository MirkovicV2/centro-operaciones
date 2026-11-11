// Deja en skills/ solo lo registrado: quita Taste Skill (no se registra) y los archivos de Impeccable que no se entregan.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
await fs.rm(path.join(ROOT, 'skills', 'taste-skill'), { recursive: true, force: true });
const keep = new Set(['LICENSE.txt', 'reference/craft-floor.md', 'reference/audit.md']);
const base = path.join(ROOT, 'skills', 'impeccable');
async function prune(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name), rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) { await prune(full); if (!(await fs.readdir(full)).length) await fs.rmdir(full); }
    else if (!keep.has(rel)) await fs.rm(full);
  }
}
await prune(base);
await fs.rm(path.join(ROOT, 'data', 'skills-descarga.json'), { force: true });
console.log('Listo: skills/taste-skill eliminada; impeccable reducida a', [...keep].join(', '));
