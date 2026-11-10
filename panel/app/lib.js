// Shared helpers for the new panel. Data logic is ported unchanged from panel/dashboard/app.js
// (scopeData, stage tracks, relative times) so both panels read /api/state the same way.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const BUSINESSES = { agency: 'Agencia digital', games: 'Videojuegos' };
export const statusNames = { queued: 'En cola', running: 'En marcha', retry_wait: 'Reintento programado', needs_attention: 'Requiere revisión', succeeded: 'Entregado localmente', cancelled: 'Cancelado' };
export const stepNames = { queued: 'Pendiente', running: 'En curso', succeeded: 'Completado', blocked: 'Bloqueado', failed: 'Falló', skipped: 'Omitido' };
export const levelText = { observed: 'Comprobado por el Centro', reported: 'Declarado por el agente', unknown: 'Sin registro', na: 'No aplica' };

// Same scoping as the classic panel: one business at a time.
export function scopeData(raw, business) {
  const scoped = { ...raw, executor: raw.executor?.byBusiness?.[business] ?? raw.executor };
  for (const key of ['jobs', 'projects', 'ideas', 'questions']) scoped[key] = (raw[key] || []).filter(item => item.business === business && !(key === 'questions' && item.status === 'withdrawn'));
  scoped.coordinatorRequests = (raw.coordinatorRequests || []).filter(item => item.business === business);
  scoped.requestTraces = (raw.requestTraces || []).filter(item => item.business === business);
  for (const key of ['domains', 'tasks', 'messages']) scoped[key] = business === 'agency' ? (raw[key] || []).filter(item => !item.business || item.business === 'agency') : [];
  const counts = Object.fromEntries(['queued', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'cancelled'].map(status => [status, scoped.jobs.filter(job => job.state === status).length]));
  scoped.queue = { jobs: scoped.jobs, counts, active: scoped.jobs.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length };
  return scoped;
}

export function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}
export function relativeTime(value) {
  if (!value) return 'Sin fecha';
  const minutes = Math.round((Date.now() - new Date(value).valueOf()) / 60000);
  if (Number.isNaN(minutes)) return String(value);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 60 * 24) return `hace ${Math.round(minutes / 60)} h`;
  if (minutes < 60 * 48) return 'ayer';
  return formatDate(value);
}
export function when(value, cls = 'when') {
  const node = h('time', { class: cls, text: relativeTime(value) });
  if (value && !Number.isNaN(new Date(value).valueOf())) { node.dateTime = new Date(value).toISOString(); node.title = new Date(value).toLocaleString('es-ES'); }
  return node;
}
export function duration(job) {
  const start = Date.parse(job.startedAt || job.createdAt), end = Date.parse(job.finishedAt || '');
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const minutes = Math.round((end - start) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Stage track: one bar per workflow step, colour plus an accessible label (never colour alone).
export function stageTrack(steps = []) {
  const visible = steps.filter(step => step.status !== 'skipped');
  if (!visible.length) return null;
  const tone = { succeeded: 'ok', completed: 'ok', running: 'active', blocked: 'fail', failed: 'fail' };
  const current = visible.find(step => ['running', 'blocked', 'failed'].includes(step.status));
  return h('span', { class: 'track', role: 'img', 'aria-label': current ? `Etapa ${current.label}: ${stepNames[current.status] || current.status}` : `${visible.filter(step => ['succeeded', 'completed'].includes(step.status)).length} de ${visible.length} etapas completadas` },
    visible.map(step => h('span', { class: `tk tk-${tone[step.status] || 'wait'}`, title: `${step.label}: ${stepNames[step.status] || step.status}` })));
}

export function pv(level) {
  return h('span', { class: `pv pv-${level}`, title: levelText[level] || level, 'aria-label': levelText[level] || level, role: 'img' });
}
export function pill(tone, text) { return h('span', { class: `pill pill-${tone}`, text }); }
export function jobTone(state) { return { needs_attention: 'warn', running: 'accent', succeeded: 'ok', cancelled: 'muted', queued: 'muted', retry_wait: 'warn' }[state] || 'muted'; }
export function mono(text) { return h('span', { class: 'mono', text }); }
export function initial(name) { return h('span', { class: 'mono-sq', 'aria-hidden': 'true', text: String(name || '?').trim().charAt(0).toUpperCase() }); }

const svgNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  overview: 'M2.5 7.2 8 2.8l5.5 4.4V13a.7.7 0 0 1-.7.7H9.6V10H6.4v3.7H3.2a.7.7 0 0 1-.7-.7z',
  attention: 'M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1 1.3H3zM6.7 14h2.6',
  requests: 'M3 4.2a1.2 1.2 0 0 1 1.2-1.2h7.6A1.2 1.2 0 0 1 13 4.2v5.6A1.2 1.2 0 0 1 11.8 11H7l-3 2.4V11a1 1 0 0 1-1-1z',
  jobs: 'M5 3.4v9.2a.5.5 0 0 0 .76.43l7.3-4.6a.5.5 0 0 0 0-.86L5.76 2.97A.5.5 0 0 0 5 3.4z',
  history: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM8 5v3.2l2 1.3',
  projects: 'M2.5 4.5h4l1.3 1.6h5.7v6.4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
  ideas: 'M6.2 12.2h3.6M6.7 14h2.6M5 9.4a4 4 0 1 1 6 0c-.6.6-1 1.2-1 1.9H6c0-.7-.4-1.3-1-1.9z',
  knowledge: 'M8 4.2C6.7 3.2 4.8 3 2.5 3v9.6c2.3 0 4.2.2 5.5 1.2 1.3-1 3.2-1.2 5.5-1.2V3c-2.3 0-4.2.2-5.5 1.2zm0 0v9.6',
  domains: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM2.5 8h11M8 2.4c-2.2 2.4-2.2 8.8 0 11.2 2.2-2.4 2.2-8.8 0-11.2z',
  settings: 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M3.9 12.1 5 11M11 5l1.1-1.1',
  search: 'M7 2.7a4.3 4.3 0 1 0 0 8.6 4.3 4.3 0 0 0 0-8.6zm3.3 7.6 3 3',
  plus: 'M8 3.5v9M3.5 8h9',
  chevron: 'm6 3.5 4.5 4.5L6 12.5',
  question: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 0 0 8 2.4zM6.4 6.4a1.7 1.7 0 0 1 3.2.6c0 1.2-1.6 1.4-1.6 2.4M8 11.3v.1',
  stop: 'M4 4h8v8H4z',
  alert: 'M8 2.6 14 13H2zM8 6.6v2.8M8 11.3v.1',
  external: 'M9.5 3H13v3.5M13 3 7.5 8.5M11 9.5V13H3V5h3.5',
};
export function icon(name, size = 16) {
  const svg = document.createElementNS(svgNS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const path = document.createElementNS(svgNS, 'path'); path.setAttribute('d', ICONS[name] || ''); svg.append(path);
  return svg;
}
