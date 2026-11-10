// New panel shell: sidebar, router, refresh loop, theme, confirmation dialog, toast and Ctrl K search.
// Reads the same /api/state as the classic panel and calls the same action endpoints.
import { h, icon, BUSINESSES, scopeData, initial } from './lib.js';
import { api, attentionItems } from './domain.js';
import * as views from './views.js';
import { requests, openNewJob } from './views-requests.js';

const $ = selector => document.querySelector(selector);
const store = { get: (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }, set: (key, value) => { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} } };
const state = { raw: null, business: ['agency', 'games'].includes(store.get('operations-business', 'agency')) ? store.get('operations-business', 'agency') : 'agency', provenance: false, error: null };

const ROUTES = {
  overview: { title: 'Overview', icon: 'overview', view: views.overview },
  atencion: { title: 'Atención', icon: 'attention', view: views.attention },
  peticiones: { title: 'Peticiones', icon: 'requests', view: requests },
  trabajos: { title: 'Trabajos', icon: 'jobs', view: views.jobs },
  historial: { title: 'Historial', icon: 'history', view: views.history },
  proyectos: { title: 'Proyectos', icon: 'projects', group: 'Operaciones', view: views.classic('Proyectos', '#proyectos', 'La lista de proyectos con su edición llegará en la siguiente entrega del panel nuevo.') },
  ideas: { title: 'Ideas y preguntas', icon: 'ideas', view: views.classic('Ideas y preguntas', '#ideas', 'La captura de ideas y la bandeja de preguntas llegarán en la siguiente entrega. Las preguntas pendientes ya se pueden responder desde Atención.') },
  conocimiento: { title: 'Conocimiento', icon: 'knowledge', view: views.classic('Conocimiento', '#conocimiento', 'El mapa de notas de Obsidian llegará en la siguiente entrega del panel nuevo.') },
  dominios: { title: 'Dominios', icon: 'domains', view: views.classic('Dominios', '#dominios', 'El inventario de dominios llegará en la siguiente entrega del panel nuevo.') },
};
const ALIASES = { trabajo: 'trabajos', inicio: 'overview' };

function route() {
  const [name = 'overview', param = ''] = location.hash.slice(1).split('/');
  const key = ALIASES[name] || name;
  return { key: ROUTES[key] ? key : 'overview', param: decodeURIComponent(param) };
}

// ---- theme
function applyTheme(choice) {
  const value = ['light', 'dark'].includes(choice) ? choice : 'system';
  if (value === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = value;
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === value));
  return value;
}

// ---- toast and confirmation
let toastTimer;
function notify(message, isError = false) {
  const toast = $('#toast'); toast.textContent = message; toast.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3600);
}
function confirmAction(title, body, okLabel) {
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title; $('#confirm-body').textContent = body; $('#confirm-ok').textContent = okLabel;
  dialog.showModal();
  return new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    $('#confirm-ok').onclick = () => finish(true);
    $('#confirm-cancel').onclick = () => finish(false);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
  });
}
async function done(message, isError = false) { notify(message, isError); await refresh(true); }

// ---- search (Ctrl K): jump to a screen, a job or an attention item
function openSearch() {
  const dialog = $('#search'); const input = $('#search-input'); const list = $('#search-results');
  const data = state.raw ? scopeData(state.raw, state.business) : null;
  const entries = [
    ...Object.entries(ROUTES).map(([key, item]) => ({ label: item.title, hint: 'Pantalla', hash: `#${key}` })),
    ...(data?.jobs || []).map(job => ({ label: job.title, hint: `#${job.id}`, hash: `#trabajo/${encodeURIComponent(job.id)}` })),
    ...(data ? attentionItems(data) : []).map(item => ({ label: item.title, hint: item.label, hash: `#atencion/${encodeURIComponent(item.id)}` })),
  ];
  const draw = () => {
    const query = input.value.trim().toLocaleLowerCase('es');
    const matches = entries.filter(entry => !query || `${entry.label} ${entry.hint}`.toLocaleLowerCase('es').includes(query)).slice(0, 12);
    list.replaceChildren(...matches.map((entry, index) => h('li', {}, h('a', { href: entry.hash, class: index === 0 ? 'first' : undefined, onclick: () => dialog.close() }, h('span', { text: entry.label }), h('span', { class: 'hint', text: entry.hint })))));
  };
  input.value = ''; draw(); input.oninput = draw;
  input.onkeydown = event => { if (event.key === 'Enter') { const first = list.querySelector('a'); if (first) { location.hash = first.getAttribute('href'); dialog.close(); } } };
  dialog.showModal(); input.focus();
}

// ---- shell
function sidebar(data, current) {
  const items = data ? attentionItems(data).length : 0;
  const nav = (key) => { const item = ROUTES[key]; return h('a', { class: `nav${current === key ? ' on' : ''}`, href: `#${key}`, 'aria-current': current === key ? 'page' : undefined }, icon(item.icon), h('span', { class: 'lbl', text: item.title }), key === 'atencion' && items ? h('span', { class: 'badge', text: String(items) }) : null); };
  const select = h('select', { id: 'business', 'aria-label': 'Negocio' }, Object.entries(BUSINESSES).map(([value, label]) => h('option', { value, selected: value === state.business, text: label })));
  select.addEventListener('change', () => { state.business = select.value; store.set('operations-business', select.value); render(); });
  const automation = state.raw?.automation?.businesses?.[state.business] === true;
  return h('nav', { class: 'side', 'aria-label': 'Navegación' },
    h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), h('div', {}, h('b', { text: 'Centro de Operaciones' }), select)),
    ['overview', 'atencion', 'peticiones', 'trabajos', 'historial'].map(nav),
    h('div', { class: 'sidelabel', text: 'Operaciones' }),
    ['proyectos', 'ideas', 'conocimiento', 'dominios'].map(nav),
    h('div', { class: 'sidefoot' },
      h('div', { class: 'srcline' }, h('span', { class: `dot${state.error ? ' bad' : ''}` }), state.error ? 'Sin conexión con el panel' : automation ? 'Autoejecución activa' : 'Autoejecución pausada'),
      h('a', { class: 'srcline link', href: '/' }, 'Panel clásico'),
      h('div', { class: 'themes', role: 'group', 'aria-label': 'Apariencia' }, [['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Sistema']].map(([value, label]) => {
        const button = h('button', { type: 'button', class: 'tbtn', 'data-theme-choice': value, text: label });
        button.addEventListener('click', () => { const chosen = applyTheme(value); store.set('operations-theme', chosen === 'system' ? null : chosen); });
        return button;
      }))));
}

let lastSignature = '';
function render(force = true) {
  const { key, param } = route();
  const data = state.raw ? scopeData(state.raw, state.business) : null;
  const signature = JSON.stringify([key, param, state.business, state.provenance, state.raw]);
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  const openDetails = new Set([...document.querySelectorAll('details[data-key][open]')].map(node => node.dataset.key));
  const scroll = [...document.querySelectorAll('.scroll')].map(node => node.scrollTop);
  const focusedId = document.activeElement?.id;
  const draft = $('#answer')?.value; const askDraft = $('#ask')?.value;
  const app = $('#app');
  let screen;
  if (!data) screen = { toolbar: [h('h1', { text: ROUTES[key].title })], body: h('div', { class: 'body' }, h('div', { class: 'scroll' }, h('div', { class: 'col' }, h('div', { class: 'empty' }, h('b', { text: state.error ? 'No se pudo leer el estado del panel.' : 'Leyendo el estado…' }), state.error ? ` ${state.error}` : '')))) };
  else { const ctx = { data, param, state, confirm: confirmAction, done, openSearch, rerender: () => render(true) }; ctx.openNewJob = () => openNewJob(ctx); screen = ROUTES[key].view(ctx); }
  app.replaceChildren(h('div', { class: 'window' }, sidebar(data, key), h('main', { class: 'main' }, h('header', { class: 'toolbar' }, screen.toolbar), screen.body)));
  applyTheme(store.get('operations-theme', 'system'));
  for (const node of document.querySelectorAll('details[data-key]')) if (openDetails.has(node.dataset.key)) node.open = true;
  document.querySelectorAll('.scroll').forEach((node, index) => { if (scroll[index]) node.scrollTop = scroll[index]; });
  if (draft && $('#answer')) $('#answer').value = draft;
  if (askDraft && $('#ask')) $('#ask').value = askDraft;
  if (focusedId && document.getElementById(focusedId)) document.getElementById(focusedId).focus({ preventScroll: true });
  document.title = `${ROUTES[key].title} · Centro de Operaciones`;
}

async function refresh(force = false) {
  try { state.raw = await api('/api/state'); state.error = null; }
  catch (error) { state.error = error.message; }
  // Do not redraw under the user's hands: skip while typing, or while a dialog is open.
  if (!force && (document.activeElement?.matches('textarea, input, select') || document.querySelector('dialog[open]'))) return;
  render(force);
}

window.addEventListener('hashchange', () => render(true));
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openSearch(); } });
applyTheme(store.get('operations-theme', 'system'));
render(true);
refresh(true);
setInterval(() => refresh(false), 8000);
