import { existsSync } from 'node:fs';
import path from 'node:path';

export function resolveOperationsRoot(appRoot) {
  const configured = process.env.CENTRO_OPERACIONES_ROOT?.trim();
  if (configured) return path.resolve(configured);
  const nearby = path.resolve(appRoot, '..');
  return existsSync(path.join(nearby, 'queue.mjs')) ? nearby : path.resolve(appRoot);
}
