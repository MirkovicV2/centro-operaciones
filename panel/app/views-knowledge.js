// Conocimiento (mapa de la bóveda de Obsidian) y Dominios. Data from the same endpoints as the classic panel:
// GET /api/graph?business=… for the map, /api/state for domains and personal tasks.
import { h, mono, pill, formatDate, BUSINESSES } from './lib.js';
import { api } from './domain.js';

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, ...children) => { const node = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); node.append(...children); return node; };
const GROUPS = { nota: 'Nota', idea: 'Idea', trabajo: 'Trabajo' };
const W = 900, H = 560;

// Deterministic layout: sunflower seed, then a short force pass (repulsion, link springs, centring).
function layout(nodes, edges) {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const n = nodes.length, r = Math.min(W, H) * 0.42;
  const x = new Float64Array(n), y = new Float64Array(n);
  nodes.forEach((_, i) => { const a = i * 2.399963 + 0.3, d = r * Math.sqrt((i + 1) / (n + 1)); x[i] = W / 2 + Math.cos(a) * d; y[i] = H / 2 + Math.sin(a) * d; });
  const links = edges.map(edge => [index.get(edge.source), index.get(edge.target)]).filter(([a, b]) => a !== undefined && b !== undefined && a !== b);
  const k = Math.sqrt((W * H) / Math.max(n, 1)) * 0.55;
  for (let step = 0, t = 40; step < 140; step++, t *= 0.97) {
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let ex = x[i] - x[j], ey = y[i] - y[j]; const d2 = ex * ex + ey * ey || 0.01, f = (k * k) / d2;
      dx[i] += ex * f; dy[i] += ey * f; dx[j] -= ex * f; dy[j] -= ey * f;
    }
    for (const [a, b] of links) {
      const ex = x[a] - x[b], ey = y[a] - y[b], d = Math.sqrt(ex * ex + ey * ey) || 0.01, f = d / k;
      dx[a] -= ex * f; dy[a] -= ey * f; dx[b] += ex * f; dy[b] += ey * f;
    }
    for (let i = 0; i < n; i++) {
      dx[i] += (W / 2 - x[i]) * 0.02; dy[i] += (H / 2 - y[i]) * 0.02;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1, m = Math.min(d, t);
      x[i] = Math.max(24, Math.min(W - 24, x[i] + (dx[i] / d) * m)); y[i] = Math.max(20, Math.min(H - 20, y[i] + (dy[i] / d) * m));
    }
  }
  return { x, y, links };
}

const obsidianUrl = (vaultPath, notePath) => {
  const vault = String(vaultPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
  return `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(String(notePath).replace(/\.md$/i, ''))}`;
};

async function loadGraph(ctx, force) {
  const { state } = ctx, business = state.business;
  if (!force && (state.graph?.business === business || state.graphLoading === business)) return;
  state.graphLoading = business; state.graphError = null;
  try {
    const graph = await api(`/api/graph?business=${business}`);
    const nodes = (graph.nodes || []).slice().sort((a, b) => a.title.localeCompare(b.title)).slice(0, 240);
    const kept = new Set(nodes.map(node => node.id));
    const edges = (graph.edges || []).filter(edge => kept.has(edge.source) && kept.has(edge.target));
    state.graph = { business, connected: graph.connected, nodes, edges, total: (graph.nodes || []).length, totalEdges: (graph.edges || []).length, ...layout(nodes, edges) };
  } catch (error) { state.graphError = error.message; }
  finally { state.graphLoading = null; if (state.business === business) ctx.rerender(); }
}

export function knowledge(ctx) {
  const { state } = ctx;
  const vaultPath = state.raw?.settings?.vaultPath || '';
  const graph = state.graph?.business === state.business ? state.graph : null;
  if (!graph && !state.graphError) queueMicrotask(() => loadGraph(ctx));
  const query = (state.noteQuery || '').trim().toLocaleLowerCase('es');
  const search = h('input', { type: 'search', id: 'note-search', class: 'searchin', placeholder: 'Buscar nota', 'aria-label': 'Buscar nota' }); search.value = state.noteQuery || '';
  search.addEventListener('input', () => { state.noteQuery = search.value; ctx.rerender(); });
  const reload = h('button', { type: 'button', class: 'btn', text: state.graphLoading ? 'Actualizando…' : 'Actualizar mapa', disabled: Boolean(state.graphLoading), onclick: () => loadGraph(ctx, true) });

  let canvas, side;
  const degree = new Map();
  if (graph) for (const edge of graph.edges) { degree.set(edge.source, (degree.get(edge.source) || 0) + 1); degree.set(edge.target, (degree.get(edge.target) || 0) + 1); }
  if (state.graphError) canvas = h('div', { class: 'empty' }, h('b', { text: 'No se pudo leer el mapa.' }), ` ${state.graphError}`);
  else if (!graph) canvas = h('div', { class: 'empty' }, h('b', { text: 'Leyendo la bóveda…' }));
  else if (!graph.connected) canvas = h('div', { class: 'empty' }, h('b', { text: 'Bóveda sin conectar.' }), ' ', h('a', { href: '#ajustes/obsidian', text: 'Conéctala en Ajustes' }), ' para dibujar su mapa.');
  else if (!graph.nodes.length) canvas = h('div', { class: 'empty' }, h('b', { text: 'Aún no hay notas Markdown en la bóveda.' }));
  else {
    const labelled = new Set([...graph.nodes].sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0)).slice(0, 18).map(node => node.id));
    const match = node => query && `${node.title} ${node.path}`.toLocaleLowerCase('es').includes(query);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    graph.nodes.forEach((node, i) => { const label = labelled.has(node.id) || match(node) ? Math.min(node.title.length, 27) * 6.2 + 16 : 12; minX = Math.min(minX, graph.x[i] - 14); maxX = Math.max(maxX, graph.x[i] + label); minY = Math.min(minY, graph.y[i] - 14); maxY = Math.max(maxY, graph.y[i] + 14); });
    const svg = s('svg', { viewBox: `${(minX - 10).toFixed(0)} ${(minY - 10).toFixed(0)} ${(maxX - minX + 20).toFixed(0)} ${(maxY - minY + 20).toFixed(0)}`, role: 'img', 'aria-label': `Mapa de ${graph.nodes.length} notas y ${graph.edges.length} enlaces` });
    for (const [a, b] of graph.links) svg.append(s('line', { x1: graph.x[a].toFixed(1), y1: graph.y[a].toFixed(1), x2: graph.x[b].toFixed(1), y2: graph.y[b].toFixed(1), class: 'ge' }));
    graph.nodes.forEach((node, i) => {
      const deg = degree.get(node.id) || 0, hit = match(node);
      const r = Math.min(4 + Math.sqrt(deg) * 1.6, 11);
      const link = s('a', { href: obsidianUrl(vaultPath, node.path), class: `gnode g-${node.group}${hit ? ' hit' : ''}${query && !hit ? ' faded' : ''}` },
        s('title', {}, `${node.title}\n${node.path}\n${deg} enlaces`), s('circle', { cx: graph.x[i].toFixed(1), cy: graph.y[i].toFixed(1), r: r.toFixed(1) }));
      if (labelled.has(node.id) || hit) link.append(s('text', { x: (graph.x[i] + r + 4).toFixed(1), y: (graph.y[i] + 4).toFixed(1), class: 'gt' }, node.title.length > 28 ? `${node.title.slice(0, 26)}…` : node.title));
      svg.append(link);
    });
    canvas = h('div', { class: 'graph' }, svg);
  }
  const counts = graph?.nodes ? Object.keys(GROUPS).map(group => [group, graph.nodes.filter(node => node.group === group).length]) : [];
  const top = graph?.nodes ? [...graph.nodes].filter(node => degree.get(node.id)).sort((a, b) => degree.get(b.id) - degree.get(a.id)).slice(0, 8) : [];
  const found = query && graph?.nodes ? graph.nodes.filter(node => `${node.title} ${node.path}`.toLocaleLowerCase('es').includes(query)).slice(0, 12) : [];
  side = h('aside', { class: 'panel', 'aria-label': 'Obsidian' },
    h('h2', { class: 'ph', text: 'Obsidian' }),
    h('div', { class: 'srcline mb' }, h('span', { class: `dot${vaultPath ? '' : ' off'}` }), vaultPath ? 'Conectada · extractos para los agentes' : 'Sin conectar'),
    h('dl', { class: 'props' },
      h('div', { class: 'prop' }, h('dt', { text: 'Bóveda' }), h('dd', {}, vaultPath ? mono(vaultPath) : h('a', { href: '#ajustes/obsidian', text: 'Configurar' }))),
      h('div', { class: 'prop' }, h('dt', { text: 'Espacio' }), h('dd', { text: BUSINESSES[state.business] })),
      graph?.connected ? h('div', { class: 'prop' }, h('dt', { text: 'Mapa' }), h('dd', { text: `${graph.total} notas · ${graph.totalEdges} enlaces${graph.total > graph.nodes.length ? ` · se dibujan ${graph.nodes.length}` : ''}` })) : null,
      h('div', { class: 'prop' }, h('dt', { text: 'Comparte' }), h('dd', { text: 'Solo notas de la empresa y el proyecto del trabajo' }))),
    counts.length ? h('div', { class: 'legend' }, counts.map(([group, count]) => h('span', { class: 'pvl' }, h('span', { class: `gleg g-${group}` }), `${GROUPS[group]} · ${count}`))) : null,
    found.length ? [h('h2', { class: 'ph top', text: `Coinciden (${found.length})` }), h('div', { class: 'notes' }, found.map(node => h('a', { href: obsidianUrl(vaultPath, node.path), text: node.title, title: node.path })))]
      : top.length ? [h('h2', { class: 'ph top', text: 'Más enlazadas' }), h('div', { class: 'notes' }, top.map(node => h('a', { href: obsidianUrl(vaultPath, node.path), title: node.path }, node.title, h('span', { text: String(degree.get(node.id)) }))))] : null,
    h('p', { class: 'hint top', text: 'Pulsa una nota para abrirla en Obsidian.' }));
  return {
    toolbar: [h('h1', { text: 'Conocimiento' }), h('span', { class: 'spacer' }), search, reload],
    body: h('div', { class: 'body' }, h('div', { class: 'scroll graphwrap' }, canvas), side),
  };
}

// ---------------------------------------------------------------- Dominios
function daysTo(date) {
  const today = new Date().toISOString().slice(0, 10);
  return Math.ceil((new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
}
export function domains(ctx) {
  const { data } = ctx;
  const list = (data.domains || []).slice().sort((a, b) => String(a.renewalDate).localeCompare(String(b.renewalDate)));
  const rows = list.map(domain => {
    const left = daysTo(domain.renewalDate);
    const tone = Number.isNaN(left) ? 'unknown' : left < 0 ? 'danger' : left <= 30 ? 'warn' : 'muted';
    const text = Number.isNaN(left) ? 'Sin fecha' : left < 0 ? `Vencido hace ${-left} d` : left === 0 ? 'Vence hoy' : `Faltan ${left} d`;
    return h('div', { class: 'prow dom' }, h('span', { class: 'mono strong', text: domain.domain }),
      h('span', { class: 'grow' }, h('span', { text: domain.client || '—' }), h('span', { class: 'm', text: domain.accountRef || 'Cuenta sin referencia' })),
      h('span', { text: formatDate(domain.renewalDate) }), h('span', {}, pill(tone, text)));
  });
  const tasks = (data.tasks || []).slice(0, 12);
  const soon = list.filter(domain => { const d = daysTo(domain.renewalDate); return d <= 30; }).length;
  return {
    toolbar: [h('h1', { text: 'Dominios' }), pill('muted', BUSINESSES.agency), h('span', { class: 'spacer' }), h('span', { class: 'srcline', text: soon ? `${soon} por renovar en 30 días` : `${list.length} dominios` })],
    body: h('div', { class: 'body' },
      h('div', { class: 'scroll' }, h('div', { class: 'col' },
        ctx.state.business !== 'agency' ? h('div', { class: 'empty' }, h('b', { text: 'Los dominios son de la Agencia digital.' }), ' Cambia de espacio en la barra lateral para verlos.')
          : [h('div', { class: 'phead dom' }, h('span', { text: 'Dominio' }), h('span', { text: 'Cliente' }), h('span', { text: 'Renovación' }), h('span')),
            rows.length ? rows : h('div', { class: 'empty' }, h('b', { text: 'El inventario está vacío.' }), ' Añade dominios desde Telegram con ', mono('/dominio agregar'), '.'),
            h('p', { class: 'hint pad-top' }, 'Inventario manual: se añaden y editan desde Telegram con ', mono('/dominio'), '. Los avisos de renovación salen por Telegram mientras el bot esté activo.')])),
      h('aside', { class: 'panel', 'aria-label': 'Pendientes' }, h('h2', { class: 'ph', text: 'Pendientes y recordatorios' }),
        tasks.length ? h('div', { class: 'feed flush' }, tasks.map(task => h('div', { class: 'it' }, task.title, h('span', { text: task.dueAt ? formatDate(task.dueAt) : 'Pendiente' }))))
          : h('p', { class: 'hint', text: 'No hay tareas personales pendientes.' }))),
  };
}
