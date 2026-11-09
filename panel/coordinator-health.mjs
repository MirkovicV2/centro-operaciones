import { readCoordinatorBindings } from './coordinator-routing.mjs';
import { verifyCoordinatorBinding } from './coordinator-bridge.mjs';

export function createCoordinatorHealth(root, { read = readCoordinatorBindings, verify = verifyCoordinatorBinding, ttlMs = 15_000 } = {}) {
  let pending, last, checkedAt = 0;
  return async () => {
    if (last && Date.now() - checkedAt < ttlMs) return last;
    if (pending) return pending;
    pending = (async () => {
      try {
        const config = await read(root);
        const coordinators = await Promise.all((config?.coordinators || []).map(async item => {
          const health = await verify(item, { cwd: root });
          return { id: item.id, name: item.name, business: item.business, runId: item.runId,
            connected: health.ok && health.liveness === 'connected', ...health };
        }));
        last = { configured: !!config, checkedAt: new Date().toISOString(), projects: config?.projects || {}, businesses: config?.businesses || {}, coordinators };
      } catch {
        last = { configured: false, checkedAt: new Date().toISOString(), coordinators: [], error: 'No se puede leer la configuración de coordinadores. Los envíos quedan pendientes.' };
      }
      checkedAt = Date.now(); return last;
    })().finally(() => { pending = null; });
    return pending;
  };
}
