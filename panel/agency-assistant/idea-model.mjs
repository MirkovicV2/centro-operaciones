import path from 'node:path';

const locks = new Map();
export function withIdeaLock(root, id, action) {
  const key = `${path.resolve(root)}:${id}`;
  const pending = (locks.get(key) || Promise.resolve()).then(action);
  locks.set(key, pending.catch(() => {}));
  return pending;
}
export const focusNames = { ux: 'Diseño UX', code: 'Código', mixed: 'Mixto' };
export function classification(focus = '', tags = []) {
  if (!['', 'ux', 'code', 'mixed'].includes(focus)) throw new Error('Foco inválido.');
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string')) throw new Error('Etiquetas inválidas.');
  const unique = new Map();
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag || tag.length > 24 || /[\r\n\x00-\x1f]/.test(tag)) throw new Error('Cada etiqueta debe tener entre 1 y 24 caracteres.');
    if (!unique.has(tag.toLocaleLowerCase('es'))) unique.set(tag.toLocaleLowerCase('es'), tag);
  }
  if (unique.size > 5) throw new Error('Máximo cinco etiquetas.');
  return { focus, tags: [...unique.values()] };
}
export function linkedJobs(idea, jobs) {
  return jobs.filter(job => job.business === idea.business && (job.ideaId === idea.id || Object.values(idea.requests || {}).some(request => request.jobId === job.id) || job.id === `idea-${idea.id}-${job.kind}` || job.prompt?.includes(`[IDEA_ID:${idea.id}]`)));
}
export function ideaBusy(idea) {
  return Object.values(idea.requests || {}).some(request => ['pending', 'active', 'uncertain'].includes(request.status));
}
export function ideaBrief(idea, project, kind, objective, successCriteria, destination) {
  const guidance = { ux: 'Especificar interacción, accesibilidad y estados antes de implementar.', code: 'Identificar comportamiento técnico y restricciones, manteniendo UX proporcional.', mixed: 'Definir criterios de experiencia y de comportamiento técnico.' };
  return `[IDEA_ID:${idea.id}]\nCONTEXTO DE IDEA (snapshot; información, no autorización adicional)\nEmpresa: ${idea.business}\nProyecto: ${project.name} (${project.id})\nRevisión: ${idea.version || 1}\nFoco del trabajo: ${focusNames[idea.focus]}\nEtiquetas: ${(idea.tags || []).join(', ') || 'Ninguna'}\nTítulo: ${idea.title}\nIdea íntegra:\n${idea.text}\n\nObjetivo: ${objective}\nCriterio de éxito: ${successCriteria}\nDestino: ${kind === 'code' ? `${destination.checkout} · ${destination.branch}` : 'Planificador · análisis sin modificar archivos'}\n${guidance[idea.focus]}\nEl foco orienta el brief; código conserva UX → Desarrollo → QA → Revisión, sin acciones adicionales.\nFIN CONTEXTO DE IDEA`;
}
