const $ = selector => document.querySelector(selector);
let savedBusiness = 'agency';
try { savedBusiness = localStorage.getItem('operations-business') || 'agency'; } catch {}
const state = { business: ['agency', 'games'].includes(savedBusiness) ? savedBusiness : 'agency', raw: null, ideaBusy: false, ideaOperation: null, ideaSends: new Set(), highlightJob: null, projectDrafts: new Map(), data: null, filter: 'all', graph: null, questionDrafts: new Map() };
const workflowStatusNames = { queued: 'Pendiente', running: 'En curso', succeeded: 'Completado', blocked: 'Bloqueado', failed: 'Falló', skipped: 'Omitido' };
const statusNames = { queued: 'En cola', running: 'En marcha', retry_wait: 'Reintento programado', needs_attention: 'Requiere revisión', succeeded: 'Entregado localmente', cancelled: 'Cancelado' };
const businessNames = { agency: 'Agencia', games: 'Videojuegos' };
// Pipeline split (Ajustes and Nuevo trabajo). Declared here because showSection runs before the end of this file.
const roleLabels = { planificador: 'Planificación', ux: 'Diseño', desarrollador: 'Desarrollo', qa: 'QA', revisor: 'Revisión' };
const sourceLabels = { 'por defecto': 'por defecto', general: 'perfil general', empresa: 'perfil de la empresa', proyecto: 'proyecto', encargo: 'este encargo', escalada: 'escalada' };
const launchLabel = launch => [launch.agent, launch.model || 'modelo por defecto', launch.effort ? `esfuerzo ${launch.effort}` : 'esfuerzo por defecto'].join(' · ');
const pipelineState = { server: null, draft: null, dirty: false, loading: null };
const emptyDraft = () => ({ general: { roles: {} }, empresas: {}, proyectos: {}, escaladas: {} });
const cloneDraft = value => JSON.parse(JSON.stringify(value || emptyDraft()));
const jobLaunchState = { preview: null, request: 0 };
const quotaState = { server: null, dirty: false, loading: null };
// Appearance: Claro | Oscuro | Sistema. "Sistema" follows the OS; a manual choice is kept in this browser.
const THEME_KEY = 'operations-theme';
function applyTheme(choice) {
  const value = ['light', 'dark'].includes(choice) ? choice : 'system';
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  for (const button of document.querySelectorAll('[data-theme-choice]')) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === value));
  return value;
}
let savedTheme = 'system';
try { savedTheme = localStorage.getItem(THEME_KEY) || 'system'; } catch {}
applyTheme(savedTheme);
for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const value = applyTheme(button.dataset.themeChoice);
    try { if (value === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, value); } catch {}
  });
}

const toast = $('#toast');
let toastTimer;

function notify(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'No se pudo completar la operación.');
  return value;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function capturePanelDetails(...roots) {
  const disclosures = () => roots.flatMap(root => [...root.querySelectorAll('details[data-panel-detail]')]);
  const reports = detail => [...detail.querySelectorAll('pre, .job-output')]
    .filter(report => report.closest('details') === detail);
  const active = document.activeElement;
  const saved = new Map();
  let anchor;
  for (const detail of disclosures()) {
    const key = detail.dataset.panelDetail;
    const summary = detail.firstElementChild;
    const panels = reports(detail);
    saved.set(key, { open: detail.open, focus: active === summary ? 'summary' : panels.indexOf(active),
      scroll: panels.map(report => [report.scrollLeft, report.scrollTop]) });
    if (!detail.open || !summary?.getClientRects().length) continue;
    const box = summary.getBoundingClientRect();
    const visible = detail.getBoundingClientRect().bottom > 0 && box.top < window.innerHeight;
    if (visible && (!anchor || active === summary)) anchor = { key, top: box.top };
  }
  return () => {
    let replacementAnchor;
    for (const detail of disclosures()) {
      const key = detail.dataset.panelDetail;
      const previous = saved.get(key);
      if (!previous) continue;
      detail.open = previous.open;
      const summary = detail.firstElementChild;
      const panels = reports(detail);
      for (const [index, report] of panels.entries()) {
        const [left, top] = previous.scroll[index] || [];
        if (left || top) report.scrollTo({ left, top, behavior: 'instant' });
      }
      const focus = previous.focus === 'summary' ? summary : panels[previous.focus];
      if (focus?.getClientRects().length) focus.focus({ preventScroll: true });
      if (key === anchor?.key) replacementAnchor = summary;
    }
    if (replacementAnchor?.getClientRects().length) {
      const offset = replacementAnchor.getBoundingClientRect().top - anchor.top;
      if (Math.abs(offset) > 1) window.scrollBy({ top: offset, behavior: 'instant' });
    }
  };
}

// Relative time for lists ("hace 12 min"); the full date stays in the title attribute and in detail views.
function relativeTime(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value), minutes = Math.round((Date.now() - date.valueOf()) / 60000);
  if (Number.isNaN(minutes)) return String(value);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  if (minutes < 60 * 24) return `hace ${Math.round(minutes / 60)} h`;
  if (minutes < 60 * 24 * 2) return 'ayer';
  return formatDate(value);
}
function timeNode(value, className = 'overview-row-when') {
  const node = el('time', className, relativeTime(value));
  if (value) { node.dateTime = new Date(value).toISOString?.() || String(value); node.title = new Date(value).toLocaleString('es-ES'); }
  return node;
}
function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

function stableOperation(namespace, signature, retiredId) {
  const key = `operations-${namespace}`;
  const operations = JSON.parse(localStorage.getItem(key) || '{}');
  const previous = operations[signature];
  const id = previous && previous !== retiredId ? previous : crypto.randomUUID();
  operations[signature] = id;
  localStorage.setItem(key, JSON.stringify(operations));
  return id;
}

function renderAutomation(raw) {
  const root = $('#automation-controls');
  if (!root) return;
  const automation = raw.automation || { businesses: {}, receipts: [], history: [] };
  const signature = JSON.stringify(automation);
  if (root.dataset.signature === signature) return;
  const focused = root.contains(document.activeElement) ? document.activeElement.id : '';
  const restoreDetails = capturePanelDetails(root);
  root.dataset.signature = signature;
  root.replaceChildren();
  for (const business of ['agency', 'games']) {
    const enabled = automation.businesses[business] === true;
    const row = el('div', 'automation-row');
    const status = el('span', '', `${businessNames[business]} · ${enabled ? 'Autoejecución activa' : 'Autoejecución pausada'}`);
    const button = el('button', 'button secondary', `${enabled ? 'Pausar' : 'Activar'} ${businessNames[business]}`);
    button.id = `auto-toggle-${business}`;
    button.type = 'button'; button.setAttribute('aria-pressed', String(enabled));
    button.onclick = async () => {
      if (!await confirmIdeaAction(`${enabled ? 'Pausar' : 'Activar'} ${businessNames[business]}`, enabled ? 'Detiene nuevos inicios y conserva el dispatch activo. Los recibos pendientes esperarán.' : 'Solo serán automáticos los encargos nuevos confirmados mientras esta empresa esté activa. La cola anterior permanece manual. El PC y este panel deben seguir abiertos.', enabled ? 'Confirmar pausa' : 'Confirmar activación')) return;
      button.disabled = true;
      try { await api('/api/auto-run', { method: 'POST', body: JSON.stringify({ business, enabled: !enabled, confirm: true }) }); await refresh(); }
      catch (error) { notify(error.message, true); button.disabled = false; }
    };
    row.append(status, button); root.append(row);
  }
  const receipts = el('details'); receipts.dataset.panelDetail = 'automation-receipts';
  receipts.append(el('summary', '', 'Recibos, bloqueos e historial de autoejecución'));
  for (const receipt of automation.receipts.slice().reverse()) {
    const row = el('article', 'automation-receipt');
    row.append(el('p', '', `${businessNames[receipt.business]} · ${receipt.id} · Job ${receipt.jobId} · ${receipt.status} · ${receipt.eligible ? 'Automático' : 'Manual'}`));
    row.append(el('p', '', receipt.reason || 'Confirmación guardada; consulta la etapa y el dispatch del trabajo.'));
    if (receipt.destination) row.append(el('p', '', `${receipt.destination.repository} · ${receipt.destination.branch} · SHA ${receipt.destination.sha}`));
    if (receipt.status === 'blocked' && (receipt.blockCode === 'checkout_locked' || /^Checkout ocupado o bloqueo pendiente;.*\. EEXIST$/.test(receipt.reason || ''))) {
      const retry = el('button', 'button secondary', 'Verificar checkout y continuar'); retry.type = 'button';
      retry.onclick = async () => {
        if (!await confirmIdeaAction('Verificar checkout', 'El panel comprobará la reserva y la salida de los trabajadores anteriores en Orca. Si puede liberar el checkout, continuará este mismo encargo.', 'Verificar y continuar')) return;
        retry.disabled = true;
        try { await api(`/api/auto-run/${receipt.id}/retry-checkout`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await refresh(); }
        catch (error) { notify(error.message, true); retry.disabled = false; }
      };
      row.append(retry);
    }
    if (['blocked', 'needs_attention'].includes(receipt.status)) {
      const review = el('button', 'button secondary', 'Cerrar recibo tras revisión'); review.type = 'button';
      review.onclick = async () => {
        if (!await confirmIdeaAction('Confirmar revisión del recibo', 'Comprueba los dispatches, efectos y bloqueos de checkout. Resuelve primero cualquier job incierto. Cerrar no reintenta este envío.', 'Cerrar tras revisión')) return;
        try { await api(`/api/auto-run/${receipt.id}/review`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await refresh(); } catch (error) { notify(error.message, true); }
      };
      row.append(review);
    }
    receipts.append(row);
  }
  for (const event of automation.history.slice(-30).reverse()) receipts.append(el('p', 'microcopy', `${formatDate(event.at)} · ${event.type} · ${event.business || event.jobId || ''}${event.enabled !== undefined ? ` · ${event.enabled ? 'activa' : 'pausada'}` : ''}`));
  root.append(receipts);
  restoreDetails();
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
}

// Stage track: one short bar per workflow step, in order. Colour and a text label, never colour alone.
function stageTrack(job) {
  const steps = (job.workflow?.steps || []).filter(step => step.status !== 'skipped');
  if (!steps.length) return null;
  const track = el('span', 'stage-track');
  const tone = { succeeded: 'ok', running: 'active', blocked: 'fail', failed: 'fail', queued: 'wait' };
  for (const step of steps) {
    const bar = el('span', `stage-bar is-${tone[step.status] || 'wait'}`);
    bar.title = `${step.label}: ${workflowStatusNames[step.status] || step.status}`;
    track.append(bar);
  }
  const current = steps.find(step => ['running', 'blocked', 'failed'].includes(step.status));
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', current ? `Etapa ${current.label}: ${workflowStatusNames[current.status] || current.status}` : `${steps.filter(step => step.status === 'succeeded').length} de ${steps.length} etapas completadas`);
  return track;
}


// Atención: one inbox for what waits on the owner. It explains and links to where each thing is
// decided; the actions themselves stay where they already live (Trabajos, Ideas), so there is one path.
function attentionItems(data) {
  const items = [];
  for (const job of data.jobs.filter(item => item.state === 'needs_attention')) {
    const step = job.workflow?.steps?.find(item => item.key === job.workflow?.currentStage);
    const evidence = [];
    if (step?.summary) evidence.push({ label: `Informe de ${step.label}`, level: 'Declarado por el agente' });
    if (job.error?.code) evidence.push({ label: `Código ${job.error.code}`, level: 'Registrado por el Centro' });
    if (step?.dispatchId) evidence.push({ label: `Dispatch ${step.dispatchId}`, level: 'Registrado por el Centro' });
    items.push({
      id: `job-${job.id}`, kind: 'job', group: 'Trabajos que necesitan revisión', label: 'Revisión', tone: 'attention',
      title: job.title, context: `${job.projectName || businessNames[job.business]} · #${job.id}`, at: job.finishedAt || job.createdAt,
      what: job.error?.message || 'El trabajo se detuvo y necesita revisión.',
      why: `Etapa ${step?.label || job.workflow?.currentStage || 'sin confirmar'} · intento ${job.attempts}/${job.maxAttempts}. Hasta que decidas, el trabajo no sigue.`,
      where: 'Las opciones (reintentar, retomar o cerrar) están en la ficha del trabajo y piden confirmación.',
      action: ['Abrir el trabajo', () => openRun(job.id)], evidence, job,
    });
  }
  for (const question of data.questions.filter(item => item.status === 'pending')) {
    items.push({
      id: `question-${question.id}`, kind: 'question', group: 'Preguntas para ti', label: 'Pregunta', tone: 'question',
      title: question.question, context: question.projectName || question.jobTitle || businessNames[question.business] || '', at: question.createdAt,
      what: question.context || 'Un agente o el coordinador necesita tu criterio para continuar.',
      why: 'La respuesta se une a las decisiones del encargo; el agente sigue con lo que no depende de ella.',
      where: 'Se responde en Ideas y preguntas, o por Telegram.',
      action: ['Responder en Ideas y preguntas', () => { location.hash = '#ideas'; }], evidence: [],
    });
  }
  for (const request of (data.coordinatorRequests || []).filter(item => ['unknown', 'needs_attention'].includes(item.notification?.status))) {
    items.push({
      id: `request-${request.id}`, kind: 'request', group: 'Avisos al coordinador', label: 'Aviso', tone: 'attention',
      title: request.snapshot?.title || 'Solicitud del panel', context: request.projectName || request.snapshot?.projectName || 'Sin proyecto', at: request.createdAt,
      what: request.notification?.reason || 'No consta que el aviso llegara al coordinador.',
      why: 'Mientras no se confirme la entrega, el coordinador puede no haber visto la solicitud.',
      where: 'Se consulta la entrega en Orca desde la solicitud, en Trabajos.',
      action: ['Ver la solicitud', () => { location.hash = '#trabajos'; document.getElementById('coordinator-inbox')?.scrollIntoView({ block: 'start' }); }], evidence: [],
    });
  }
  return items;
}

function renderAttention(data) {
  const items = attentionItems(data);
  $('#attention-count').textContent = String(items.length);
  const list = $('#attention-list'), detail = $('#attention-detail');
  const signature = JSON.stringify([state.business, state.attentionSelected, items.map(item => [item.id, item.what, item.at])]);
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  list.replaceChildren(); detail.replaceChildren();
  if (!items.length) {
    list.append(el('p', 'attention-empty', 'Nada te espera ahora mismo.'));
    detail.append(el('p', 'attention-empty', 'Cuando un trabajo se detenga, un agente pregunte o un aviso no llegue, aparecerá aquí.'));
    return;
  }
  const selected = items.find(item => item.id === state.attentionSelected) || items[0];
  for (const group of [...new Set(items.map(item => item.group))]) {
    list.append(el('h3', 'attention-group', group));
    for (const item of items.filter(entry => entry.group === group)) {
      const row = el('button', `attention-row is-${item.tone}${item === selected ? ' selected' : ''}`);
      row.type = 'button';
      row.setAttribute('aria-pressed', String(item === selected));
      const mark = el('span', 'overview-row-mark'); mark.setAttribute('aria-hidden', 'true');
      const text = el('span', 'overview-row-text');
      text.append(el('span', 'overview-row-title', item.title), el('span', 'overview-row-reason', [item.label, item.context, item.at && relativeTime(item.at)].filter(Boolean).join(' · ')));
      row.append(mark, text);
      row.onclick = () => { state.attentionSelected = item.id; renderAttention(data); };
      list.append(row);
    }
  }
  detail.append(el('p', 'attention-kicker', `${selected.label} · ${selected.context}`), el('h3', 'attention-title', selected.title));
  if (selected.job) { const track = stageTrack(selected.job); if (track) detail.append(track); }
  for (const [heading, text] of [['Qué ocurrió', selected.what], ['Por qué te necesita', selected.why], ['Dónde se decide', selected.where]]) {
    detail.append(el('h4', 'attention-label', heading), el('p', 'attention-text', text));
  }
  if (selected.evidence.length) {
    detail.append(el('h4', 'attention-label', 'Evidencia'));
    const evidence = el('ul', 'attention-evidence');
    for (const entry of selected.evidence) { const li = el('li', '', entry.label); li.append(el('span', 'attention-level', entry.level)); evidence.append(li); }
    detail.append(evidence);
  }
  const button = el('button', 'button primary', selected.action[0]); button.type = 'button'; button.onclick = selected.action[1];
  detail.append(button);
}

// Run Detail: one page per job. Ejecución → Revisión → Aceptación → Integración, the real stages, the
// report facts with who stated each one, and the same actions as the job card (jobActionButtons).
const levelText = { observed: 'Comprobado por el Centro', reported: 'Declarado por el agente', unknown: 'Sin registro', na: 'No aplica' };
function openRun(id) { location.hash = `#trabajo/${encodeURIComponent(id)}`; }
function provenance(level) {
  const mark = el('span', `pv pv-${level}`);
  mark.title = levelText[level] || level;
  mark.setAttribute('aria-label', levelText[level] || level);
  return mark;
}
function lifecycle(job, report, integrationRecord) {
  const step = key => job.workflow?.steps?.find(item => item.key === key);
  const dev = step('developer') || step('planner');
  const review = step('reviewer');
  const v2 = review?.workflowV2;
  const phase = (s, map) => map[s?.status] || ['wait', s ? (workflowStatusNames[s.status] || s.status) : 'Sin iniciar'];
  const exec = phase(dev, { succeeded: ['done', 'Terminada'], running: ['active', 'En curso'], blocked: ['fail', 'Detenida'], failed: ['fail', 'Falló'] });
  let rev;
  if (v2) rev = v2.outcome === 'approved' ? ['ok', 'Aprobada (Workflow V2)'] : v2.outcome === 'rejected' ? ['fail', 'Rechazada (Workflow V2)'] : v2.outcome === 'owner_pending' ? ['ok', 'Recomienda aceptar (Workflow V2)'] : ['unk', 'Workflow V2 · ' + (v2.status || 'sin estado')];
  else rev = phase(review, { succeeded: ['ok', 'Aprobada'], running: ['active', 'En curso'], blocked: ['fail', 'Rechazada'], failed: ['fail', 'Falló'] });
  const acceptance = v2
    ? (v2.outcome === 'approved' && v2.status === 'aprobado' ? ['ok', 'Aceptada por ti'] : ['wait', 'Pendiente de tu decisión en V2'])
    : ['na', 'No aplica'];
  const integ = report?.integration;
  let integration;
  if (!job.autoIntent?.eligible) integration = ['na', 'Manual'];
  else if (!integrationRecord && !integ?.phase) integration = ['unk', 'Sin registro'];
  else if ((integrationRecord?.phase || integ?.phase) === 'complete') integration = ['ok', 'Integrada'];
  else if (['blocked', 'failed'].includes(step('integration')?.status)) integration = ['fail', workflowStatusNames[step('integration').status]];
  else integration = ['active', integrationRecord?.phase || integ?.phase];
  const note = { exec: dev ? (dev.dispatchId ? `Dispatch ${dev.dispatchId}` : dev.label) : 'Sin etapa de ejecución',
    rev: review?.delivery?.findings?.length ? `${review.delivery.findings.length} hallazgos` : review ? review.label : 'Sin revisión todavía',
    acc: v2 ? `Tarea ${v2.task || ''}` : 'El Centro integra tras su Revisión',
    int: integrationRecord?.mergeSha ? `Merge ${integrationRecord.mergeSha.slice(0, 7)}` : integrationRecord?.prUrl ? 'PR abierta' : !job.autoIntent?.eligible ? 'Fuera del Centro' : '' };
  const level = (tone, exact) => tone === 'na' ? 'na' : tone === 'unk' || tone === 'wait' ? 'unknown' : exact ? 'observed' : 'reported';
  return [
    ['Ejecución', exec, note.exec, level(exec[0], dev?.dispatchId)],
    ['Revisión', rev, note.rev, level(rev[0], review?.dispatchId || v2)],
    ['Aceptación', acceptance, note.acc, level(acceptance[0], v2)],
    ['Integración', integration, note.int, level(integration[0], true)],
  ];
}

function renderRun(data) {
  const root = $('#run-page');
  const job = (data.jobs || []).find(item => item.id === state.runId);
  const report = (data.requestTraces || []).flatMap(trace => trace.reports || []).find(item => item.jobId === state.runId);
  const receipt = data.automation?.receipts?.find(item => item.jobId === state.runId);
  const integrationRecord = job?.autoIntent?.eligible ? data.automation?.integrations?.[job.autoIntent.receiptId] : null;
  const signature = JSON.stringify([state.runId, job, report, receipt, integrationRecord, data.executor?.available, state.runProvenance]);
  if (root.dataset.signature === signature) return;
  const restore = capturePanelDetails(root);
  root.dataset.signature = signature;
  root.replaceChildren();
  if (!job) {
    root.append(el('p', 'attention-empty', state.runId ? `No hay ningún trabajo #${state.runId} en este negocio.` : 'Elige un trabajo en Trabajos o en el Overview.'));
    const back = el('a', 'button secondary', 'Volver a Trabajos'); back.href = '#trabajos'; root.append(back);
    return;
  }
  root.classList.toggle('show-provenance', Boolean(state.runProvenance));
  const main = el('div', 'run-main'), side = el('aside', 'run-side');
  side.setAttribute('aria-label', 'Propiedades del trabajo');

  const toolbar = el('div', 'run-toolbar');
  const back = el('a', 'run-crumb', 'Trabajos'); back.href = '#trabajos';
  const toggle = el('button', `run-toggle${state.runProvenance ? ' on' : ''}`, 'Procedencia'); toggle.type = 'button';
  toggle.setAttribute('aria-pressed', String(Boolean(state.runProvenance)));
  toggle.prepend(provenance('observed'));
  toggle.onclick = () => { state.runProvenance = !state.runProvenance; renderRun(data); };
  toolbar.append(back, el('span', 'run-crumb-sep', '›'), el('span', 'run-crumb-id', `#${job.id}`), el('span', 'spacer'), toggle);
  main.append(toolbar);

  const head = el('header', 'run-head');
  head.append(el('p', 'run-kicker', `${job.projectName || businessNames[job.business]} · ${statusNames[job.state] || job.state}`));
  const title = el('h2', 'run-title', job.title); title.id = 'run-title';
  head.append(title);
  const meta = el('p', 'run-meta');
  for (const part of [`#${job.id}`, job.branch && `Rama ${job.branch}`, job.destination?.baseBranch && `Base ${job.destination.baseBranch}`, `Creado ${formatDate(job.createdAt)}`, `Intento ${job.attempts}/${job.maxAttempts}`]) if (part) meta.append(el('span', '', part));
  head.append(meta);
  const objective = report?.asked?.objective || job.contract?.objective || job.prompt;
  if (objective) { const block = el('div', 'run-objective'); block.append(el('span', 'run-label', 'Objetivo'), el('p', '', objective)); head.append(block); }
  main.append(head);

  const bar = el('div', 'lifebar'); bar.setAttribute('role', 'list'); bar.setAttribute('aria-label', 'Ejecución, revisión, aceptación e integración');
  for (const [name, [tone, text], note, level] of lifecycle(job, report, integrationRecord)) {
    const cell = el('div', `life life-${tone}`); cell.setAttribute('role', 'listitem');
    const k = el('span', 'life-k', name); k.append(provenance(level));
    cell.append(k, el('span', 'life-s', text));
    if (note) cell.append(el('span', 'life-note', note));
    cell.append(el('span', 'prov-text', levelText[level]));
    bar.append(cell);
  }
  main.append(bar);

  // Why the job is not moving, by kind: product, configuration, quota, provider, a decision or a test by a person.
  if (job.diagnosis) {
    const diagnosis = el('section', `run-diagnosis is-${job.diagnosis.category}`);
    diagnosis.append(el('h3', '', job.diagnosis.waiting ? `En espera · ${job.diagnosis.label}` : job.diagnosis.label));
    if (job.diagnosis.message) diagnosis.append(el('p', '', job.diagnosis.message));
    if (job.diagnosis.until) diagnosis.append(el('p', 'microcopy', `Se volverá a intentar a partir de ${formatDate(job.diagnosis.until)}.`));
    diagnosis.append(el('p', 'run-diagnosis-action', `Qué hacer: ${job.diagnosis.action}`));
    main.append(diagnosis);
  }
  if (job.state === 'needs_attention') {
    const callout = el('section', 'run-callout');
    callout.append(el('h3', '', 'Este trabajo espera tu decisión'), el('p', '', job.error?.message || 'Revisa la etapa y sus informes antes de continuar.'));
    if (data.executor?.reason) callout.append(el('p', 'microcopy', data.executor.reason));
    const actions = el('div', 'run-actions'); actions.append(...jobActionButtons(job, data, receipt));
    callout.append(actions);
    main.append(callout);
  }

  main.append(el('h3', 'run-h3', 'Etapas'));
  // The route and every stage it leaves out or added later, with the reason someone gave.
  if (job.route) {
    const route = el('div', 'run-route');
    route.append(el('p', 'run-route-title', `Ruta: ${job.route.label}${job.route.reason ? ` · ${job.route.reason}` : ''}`));
    const notes = el('ul', 'run-route-notes');
    for (const item of job.route.omitted || []) notes.append(el('li', '', `${(job.workflow?.steps || []).find(step => step.key === item.stage)?.label || item.stage}: omitida. ${item.reason}`));
    for (const item of job.route.added || []) notes.append(el('li', '', `${(job.workflow?.steps || []).find(step => step.key === item.stage)?.label || item.stage}: añadida por cambio de alcance. ${item.reason}`));
    if (notes.children.length) route.append(notes);
    main.append(route);
  }
  const stages = el('ol', 'run-stages');
  for (const [index, step] of (job.workflow?.steps || []).filter(item => item.status !== 'skipped').entries()) {
    const li = el('li', `run-stage is-${step.status}`);
    li.append(el('span', 'run-stage-n', String(index + 1)));
    const body = el('div', 'run-stage-body');
    body.append(el('div', 'run-stage-name', step.label));
    const kv = el('dl', 'run-kv');
    const add = (k, v, level) => { const dd = el('dd'); if (level) dd.append(provenance(level)); dd.append(el('span', '', v)); if (level) dd.append(el('span', 'prov-text', levelText[level])); kv.append(el('dt', '', k), dd); };
    if (step.profile) add('Perfil', step.profile);
    if (step.launch) add('Modelo', [step.launch.agent, step.launch.model, step.launch.effort && `esfuerzo ${step.launch.effort}`].filter(Boolean).join(' · '), 'observed');
    else if (job.plannedLaunch?.[step.key]) add('Modelo previsto', `${launchLabel(job.plannedLaunch[step.key])} · se fija al lanzar la etapa`);
    else add('Modelo', 'No registrado', 'unknown');
    if (step.authorization) add('Autorizado por', step.authorization.coordinatorName || 'coordinador', 'observed');
    if (step.dispatchId) add('Dispatch', step.dispatchId, 'observed');
    if (step.contracts?.length) add('Contratos de rol', step.contracts.map(item => item.path).join(', '), 'observed');
    // Supplied is the Centro's own record; consulted is what the worker stated in its delivery.
    if (step.skills?.length) add('Skills suministradas', step.skills.map(skill => skill.id).join(', '), 'observed');
    if (step.skills?.length && step.skillsConsulted) add('Skills consultadas', step.skillsConsulted.length ? step.skillsConsulted.join(', ') : 'Ninguna declarada', 'reported');
    for (const item of step.skillsOmitted || []) add('Skill no entregada', `${item.id}: ${item.reason}`, 'observed');
    if (step.team) add('Equipo', step.team.nombre || step.team.id, 'observed');
    if (step.launch?.substitutedFrom) add('Proveedor sustituido', `En lugar de ${step.launch.substitutedFrom.agent} · ${step.launch.substitutedFrom.reason}`, 'observed');
    if (step.quota) add('Cuota al lanzar', step.quota.state === 'incierta' ? `${step.quota.provider}: uso no conocido` : `${step.quota.provider}: ${step.quota.usadoPorcentaje} % usado (reserva ${step.quota.reserva} %)`, step.quota.state === 'incierta' ? 'unknown' : 'observed');
    body.append(kv);
    const summary = step.delivery?.summary || step.summary;
    if (summary) { const details = el('details', 'run-report'); details.dataset.panelDetail = `run-${job.id}-${step.key}`; details.append(el('summary', '', 'Informe de la etapa'), el('pre', 'workflow-stage-report', summary)); body.append(details); }
    li.append(body, el('span', `job-state ${step.status === 'succeeded' ? 'succeeded' : step.status === 'running' ? 'running' : ['blocked', 'failed'].includes(step.status) ? 'needs_attention' : 'queued'}`, workflowStatusNames[step.status] || step.status));
    stages.append(li);
  }
  if (!stages.children.length) stages.append(el('li', 'attention-empty', 'Sin etapas registradas todavía.'));
  main.append(stages);

  const findings = (job.workflow?.steps || []).flatMap(step => (step.delivery?.findings || []).map(finding => ({ ...finding, stage: step.label })));
  main.append(el('h3', 'run-h3', 'Revisión'));
  if (findings.length) {
    const list = el('ul', 'run-findings');
    for (const finding of findings) {
      const li = el('li', '');
      li.append(el('span', `request-state ${finding.severity === 'blocking' ? 'is-attention' : 'is-active'}`, finding.severity === 'blocking' ? 'Bloqueante' : 'Menor'));
      const text = el('div', ''); text.append(el('p', '', finding.summary || ''), el('small', '', [finding.stage, finding.evidence].filter(Boolean).join(' · ')));
      li.append(text, provenance('reported'));
      list.append(li);
    }
    main.append(list);
  } else main.append(el('p', 'attention-empty', 'Sin hallazgos registrados.'));

  if (report?.criteria?.length) {
    main.append(el('h3', 'run-h3', 'Criterios del encargo'));
    const list = el('ul', 'run-criteria');
    for (const item of report.criteria) {
      const li = el('li', '');
      li.append(provenance(item.level), el('span', '', item.criterion), el('span', `request-state ${item.status === 'passed' ? 'is-done' : item.status === 'failed' ? 'is-attention' : 'is-active'}`, item.status === 'passed' ? 'Cumple' : item.status === 'failed' ? 'No cumple' : 'Sin verificar'));
      list.append(li);
    }
    main.append(list);
  }
  if (job.result?.text) { const details = el('details', 'run-report'); details.dataset.panelDetail = `run-${job.id}-result`; details.append(el('summary', '', 'Resultado completo'), el('pre', 'job-output', job.result.text)); main.append(details); }

  side.append(el('h3', 'run-side-title', 'Propiedades'));
  const props = el('dl', 'run-props');
  const prop = (k, v, level) => { if (!v) return; const dd = el('dd'); if (level) dd.append(provenance(level)); dd.append(el('span', '', v)); props.append(el('dt', '', k), dd); };
  prop('Proyecto', job.projectName); prop('Negocio', businessNames[job.business]); prop('Tipo', job.kind === 'code' ? 'Código' : 'Análisis');
  prop('Estado', statusNames[job.state] || job.state, 'observed'); prop('Proveedor', job.provider); prop('Creado por', job.actor);
  prop('Checkout', job.workspace); prop('Destino', job.destination?.repository); prop('Recibo', job.autoIntent?.receiptId);
  prop('Tokens y coste', 'Sin registro fiable', 'unknown');
  side.append(props);
  if (report) side.append(el('p', 'run-totals', `${report.totals.observed} comprobados · ${report.totals.reported} declarados · ${report.totals.unknown} sin registro`));
  const legend = el('div', 'run-legend');
  for (const level of ['observed', 'reported', 'unknown', 'na']) { const item = el('span', ''); item.append(provenance(level), ' ', levelText[level]); legend.append(item); }
  legend.append(el('p', '', 'La marca dice de dónde sale un dato, no si es bueno.'));
  side.append(legend);
  const open = el('a', 'button secondary', 'Ver en la lista de Trabajos'); open.href = '#trabajos'; open.onclick = () => setTimeout(() => focusJob(job.id), 0);
  side.append(open);

  // Left pane, as in the mockup: every job of this business with its stage track; the open one is selected.
  const list = el('nav', 'run-list'); list.setAttribute('aria-label', 'Trabajos');
  const order = { needs_attention: 0, running: 1, queued: 2, retry_wait: 2, succeeded: 3, cancelled: 4 };
  for (const item of [...(data.jobs || [])].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5) || String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const link = el('a', `run-list-item${item.id === job.id ? ' selected' : ''}`); link.href = `#trabajo/${encodeURIComponent(item.id)}`;
    if (item.id === job.id) link.setAttribute('aria-current', 'page');
    link.append(el('span', 'run-list-title', item.title));
    const meta = el('span', 'run-list-meta'); meta.append(el('span', '', `#${item.id}`));
    const track = stageTrack(item); if (track) meta.append(track);
    link.append(meta, el('span', `run-list-state is-${item.state}`, statusNames[item.state] || item.state));
    list.append(link);
  }
  root.append(list, main, side);
  restore();
}

// Historial e informes: closed jobs as a table, and the selected job's report (informe E) with provenance.
function durationText(job) {
  const start = Date.parse(job.startedAt || job.createdAt), end = Date.parse(job.finishedAt || '');
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—';
  const minutes = Math.round((end - start) / 60000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function renderHistory(data) {
  const root = $('#history-page');
  const closed = (data.jobs || []).filter(job => ['succeeded', 'cancelled'].includes(job.state)).sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)));
  const reports = (data.requestTraces || []).flatMap(trace => trace.reports || []);
  const selected = closed.find(job => job.id === state.historySelected) || closed[0];
  const signature = JSON.stringify([closed, selected?.id, reports]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.replaceChildren();
  const table = el('div', 'history-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Trabajos cerrados');
  const head = el('div', 'history-row history-head'); head.setAttribute('role', 'row');
  for (const label of ['Trabajo', 'Resultado', 'Duración', 'Modelos', 'Cerrado']) { const cell = el('span', '', label); cell.setAttribute('role', 'columnheader'); head.append(cell); }
  table.append(head);
  if (!closed.length) table.append(el('p', 'attention-empty', 'Los trabajos terminados o cancelados aparecerán aquí.'));
  for (const job of closed) {
    const row = el('button', `history-row${job === selected ? ' selected' : ''}`); row.type = 'button'; row.setAttribute('role', 'row');
    row.setAttribute('aria-pressed', String(job === selected));
    const title = el('span', 'history-title'); title.append(el('b', '', job.title), el('small', '', `${job.projectName || businessNames[job.business]} · #${job.id}`));
    const models = [...new Set((job.workflow?.steps || []).map(step => step.launch?.model).filter(Boolean))].join(' · ') || 'No registrados';
    row.append(title, el('span', '', ''), el('span', 'history-num', durationText(job)), el('span', 'history-models', models), timeNode(job.finishedAt, 'history-when'));
    row.children[1].append(el('span', `request-state ${job.state === 'succeeded' ? 'is-done' : 'is-active'}`, statusNames[job.state] || job.state));
    row.onclick = () => { state.historySelected = job.id; renderHistory(data); };
    table.append(row);
  }
  const panel = el('aside', 'history-report'); panel.setAttribute('aria-label', 'Informe del trabajo');
  if (selected) {
    const report = reports.find(item => item.jobId === selected.id);
    panel.append(el('p', 'run-kicker', `Informe · #${selected.id}`), el('h3', 'history-report-title', selected.title));
    const facts = el('dl', 'history-facts');
    const fact = (label, value, level) => { const dd = el('dd'); dd.append(el('span', '', value)); facts.append(el('dt', '', label), dd, provenance(level)); };
    fact('Estado', statusNames[selected.state] || selected.state, 'observed');
    for (const step of selected.workflow?.steps || []) fact(step.label, `${workflowStatusNames[step.status] || step.status}${step.launch?.model ? ` · ${step.launch.model}` : ''}`, step.dispatchId ? 'observed' : 'unknown');
    for (const item of report?.criteria || []) fact('Criterio', `${item.criterion} · ${item.status === 'passed' ? 'cumple' : item.status === 'failed' ? 'no cumple' : 'sin verificar'}`, item.level);
    if (report?.integration?.applies) for (const item of report.integration.facts) fact(item.label, item.value, item.level);
    else if (selected.autoIntent?.eligible) fact('Integración', 'Sin registro', 'unknown');
    else fact('Integración', 'Manual · fuera del Centro', 'na');
    fact('Tokens y coste', 'Sin registro fiable', 'unknown');
    panel.append(facts);
    if (report) panel.append(el('p', 'run-totals', `${report.totals.observed} comprobados · ${report.totals.reported} declarados · ${report.totals.unknown} sin registro`));
    const open = el('a', 'button secondary', 'Abrir la ficha'); open.href = `#trabajo/${encodeURIComponent(selected.id)}`; panel.append(open);
  } else panel.append(el('p', 'attention-empty', 'Elige un trabajo para ver su informe.'));
  root.append(table, panel);
}

function renderJobs(data) {
  const list = $('#jobs-list'), historyList = $('#history-list');
  const historyFilters = [...$('#history .history-filters').querySelectorAll('input, select')].map(input => input.value);
  const signature = JSON.stringify([state.business, state.filter, state.highlightJob, historyFilters,
    data.jobs, data.queue.counts, data.coordinatorRequests, data.coordination, data.questions,
    data.projects, data.ideas, data.automation?.receipts, data.automation?.integrations, data.executor?.available, data.executor?.reason]);
  if (list.dataset.signature === signature) return;
  const restoreDetails = capturePanelDetails(list, historyList);
  const openActive = new Set([...list.querySelectorAll('.job-card[open]')].map(card => card.id));
  list.dataset.signature = signature;
  const connections = $('#coordinator-connections');
  if (connections) {
    connections.replaceChildren();
    const coordinators = (data.coordination?.coordinators || []).filter(item => item.business === state.business);
    if (!coordinators.length) connections.append(el('p', '', data.coordination?.error || 'Coordinador sin vincular. Las solicitudes se conservarán pendientes.'));
    for (const coordinator of coordinators) {
      const projects = (data.projects || []).filter(project => data.coordination.projects?.[project.id] === coordinator.id);
      connections.append(el('p', '', `${coordinator.name} · ${coordinator.connected ? 'Conectado' : 'Conexión pendiente'}${projects.length ? ` · ${projects.map(project => project.name).join(', ')}` : ''}`));
      if (!coordinator.connected) connections.append(el('p', 'microcopy', coordinator.reason));
    }
    connections.append(el('p', 'microcopy', 'El trabajador consulta al coordinador del proyecto. Las decisiones que necesiten tu criterio aparecerán en Ideas y preguntas.'));
  }
  const coordinatorRoot = $('#coordinator-inbox'), coordinatorList = $('#coordinator-requests-list');
  const waitingRequests = (data.coordinatorRequests || []).filter(request => !['routed', 'withdrawn', 'answered'].includes(request.status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  coordinatorRoot.hidden = waitingRequests.length === 0;
  coordinatorList.replaceChildren();
  for (const request of waitingRequests.slice(0, 12)) {
    const card = el('article', 'coordinator-request-card');
    const title = request.snapshot?.title || request.snapshot?.text?.slice(0, 100) || 'Solicitud del panel';
    card.append(el('strong', '', title), el('span', 'company-pill', `${businessNames[request.business]} · ${request.projectName || request.snapshot?.projectName || 'Sin proyecto'}`));
    const message = request.status === 'routing' ? `Decisión registrada: ${request.route?.kind === 'code' ? 'pipeline de código' : 'Planificador'}. Reanudable desde el mismo checkpoint.${request.route?.lastError ? ` Último intento: ${request.route.lastError}` : ''}`
      : request.notification?.reason || (request.notification?.status === 'sent' ? 'Avisada al coordinador; decisión pendiente. Todavía no hay job ni dispatch.' : 'Guardada; aviso al coordinador pendiente.');
    card.append(el('p', '', message));
    if (request.notification?.coordinatorName) card.append(el('p', 'microcopy', `Responsable: ${request.notification.coordinatorName}`));
    if ((data.questions || []).some(question => question.coordinatorRequestId === request.id && question.status === 'pending')) {
      const questions = el('a', 'button secondary', 'Responder preguntas'); questions.href = '#ideas'; card.append(questions);
    }
    const uncertainNotice = ['unknown', 'needs_attention', 'sending'].includes(request.notification?.status) || (request.answerNotices || []).some(notice => ['unknown', 'needs_attention', 'sending'].includes(notice.notification?.status));
    if (request.notification?.status !== 'sent' || uncertainNotice) {
      const check = el('button', 'button secondary', uncertainNotice ? 'Consultar entrega en Orca' : 'Enviar aviso al coordinador');
      check.type = 'button';
      check.onclick = async () => { check.disabled = true; try { await api(`/api/coordinator/requests/${encodeURIComponent(request.id)}/notify`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { notify(error.message, true); check.disabled = false; } };
      card.append(check);
    }
    if (request.status !== 'routing' && !['sending', 'unknown', 'needs_attention'].includes(request.notification?.status)) {
      const withdraw = el('button', 'button secondary', 'Retirar solicitud para corregirla'); withdraw.type = 'button';
      withdraw.onclick = async () => {
        if (!await confirmIdeaAction('Retirar solicitud', 'Solo se puede retirar si todavía no existe un trabajo. Se conserva el historial y podrás corregir el encargo antes de enviarlo de nuevo.', 'Retirar')) return;
        try { await api(`/api/coordinator/requests/${encodeURIComponent(request.id)}/withdraw`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { notify(error.message, true); }
      };
      card.append(withdraw);
    }
    coordinatorList.append(card);
  }
  list.replaceChildren();
  const groups = {};
  for (const [key, label] of [['running', 'En curso'], ['automatic', 'Cola automática'], ['manual', 'Cola manual'], ['attention', 'Requiere revisión']]) {
    const section = el('section', 'queue-group'); section.append(el('h3', '', label));
    groups[key] = section; list.append(section);
  }
  historyList.replaceChildren();
  $('#history-count').textContent = data.jobs.filter(job => ['succeeded', 'cancelled'].includes(job.state)).length;
  const historyQuery = $('#history-search').value.trim().toLowerCase();
  const counts = data.queue.counts;
  $('#filter-all').textContent = String(data.queue.jobs.length);
  $('#filter-active').textContent = String(data.queue.active);
  $('#filter-attention').textContent = String(counts.needs_attention || 0);
  $('#filter-done').textContent = String(counts.succeeded || 0);
  const jobs = data.jobs.filter(job => ['succeeded', 'cancelled'].includes(job.state) || state.filter === 'all'
    || (state.filter === 'active' && ['queued', 'running', 'retry_wait'].includes(job.state))
    || job.state === state.filter);
  if (!jobs.length) {
    list.append(el('div', 'empty-state', state.filter === 'all' ? 'Todavía no hay trabajos en la cola. Añade el primer encargo desde aquí.' : 'No hay trabajos con este estado.'));
    return;
  }
  for (const job of jobs) {
    const receipt = data.automation?.receipts?.find(item => item.jobId === job.id);
    const integration = job.autoIntent?.eligible === true && receipt?.eligible === true
      ? data.automation?.integrations?.[job.autoIntent.receiptId] || {}
      : null;
    const receiptBlocked = ['blocked', 'needs_attention'].includes(receipt?.status);
    const automaticPending = job.autoIntent?.eligible && receipt?.status === 'pending';
    const closed = ['succeeded', 'cancelled'].includes(job.state);
    if (closed && ((historyQuery && !`${job.title} ${job.id}`.toLowerCase().includes(historyQuery)) || ($('#history-state').value && job.state !== $('#history-state').value) || ($('#history-project').value && job.projectId !== $('#history-project').value) || ($('#history-stage').value && !job.workflow?.steps?.some(step => step.key === $('#history-stage').value && step.status !== 'queued')) || ($('#history-date').value && String(job.finishedAt || job.createdAt).slice(0, 10) < $('#history-date').value))) continue;
    const card = el('details', 'job-card');
    card.id = `job-${job.id}`;
    card.dataset.panelDetail = card.id;
    if (state.highlightJob === job.id) card.classList.add('highlight-job');
    const summary = el('summary', 'job-summary');
    summary.append(el('span', 'job-id', `#${job.id}`));
    summary.append(el('span', `company-pill ${job.business}`, businessNames[job.business] || job.business));
    summary.append(el('span', 'job-title', job.title));
    if (job.projectName) summary.append(el('span', 'company-pill project-pill', job.projectName));
    const track = stageTrack(job);
    if (track) summary.append(track);
    summary.append(el('span', `job-state ${job.state}`, statusNames[job.state] || job.state));
    summary.append(el('span', 'job-chevron', '⌄'));
    card.append(summary);
    const detail = el('div', 'job-detail');
    const pageLink = el('a', 'run-open-link', 'Abrir la ficha completa'); pageLink.href = `#trabajo/${encodeURIComponent(job.id)}`; detail.append(pageLink);
    detail.append(el('div', '', `Tipo: ${job.kind === 'code' ? 'código' : 'análisis'}  ·  Intentos: ${job.attempts}/${job.maxAttempts}  ·  Creado: ${formatDate(job.createdAt)}`));
    if (job.workflow?.steps?.length) {
      const workflow = el('section', 'job-workflow');
      workflow.append(el('b', '', job.kind === 'code' ? 'Flujo de calidad' : 'Flujo de análisis'));
      const stages = el('div', 'workflow-stages');
      for (const step of job.workflow.steps) {
        const stage = el('div', `workflow-stage ${step.status}`);
        const header = el('div', 'workflow-stage-header');
        const gameDesign = job.business === 'games' && step.key === 'ux' && step.profile === 'ux_games';
        const label = gameDesign ? 'Diseño de videojuegos' : job.business === 'games' && step.key === 'developer' ? 'Desarrollo de videojuegos (Godot)' : step.label;
        const profileName = gameDesign ? 'Diseñador de videojuegos' : step.profile === 'desarrollador_games' ? 'Desarrollador de videojuegos (Godot)' : step.profile;
        header.append(el('span', 'workflow-stage-label', label), el('span', `workflow-stage-status ${step.status}`, workflowStatusNames[step.status] || step.status));
        stage.append(header);
        if (profileName) stage.append(el('span', 'workflow-stage-profile', `Perfil: ${profileName}`));
        if (step.launch?.agent) stage.append(el('span', 'workflow-stage-profile', `Modelo: ${step.launch.agent} · ${step.launch.model || 'por defecto del agente'}${step.launch.effort ? ` · ${step.launch.effort}` : ''}${step.launch.source === 'encargo' ? ' (elegido en el encargo)' : step.launch.source === 'proyecto' ? ' (del proyecto)' : ''}`));
        if (profileName !== step.profile) { const technical = el('details'); technical.dataset.panelDetail = `${card.id}-${step.key}-profile`; technical.append(el('summary', '', 'Identificador del perfil'), el('span', '', step.profile)); stage.append(technical); }
        if (step.authorization) stage.append(el('span', 'workflow-stage-profile', `Autorizado por ${step.authorization.coordinatorName}`));
        if (step.dispatchId) { const technical = el('details'); technical.dataset.panelDetail = `${card.id}-${step.key}-dispatch`; technical.append(el('summary', '', 'Detalle técnico'), el('span', 'workflow-stage-dispatch', `Dispatch: ${step.dispatchId} · ${step.dispatchStatus || 'sin estado confirmado'}`)); stage.append(technical); }
        if (step.routeOmitted) stage.append(el('span', 'workflow-stage-profile', step.summary));
        else if (step.summary) {
          const details = document.createElement('details');
          details.dataset.panelDetail = `${card.id}-${step.key}-report`;
          details.append(el('summary', '', 'Ver informe de etapa'), el('pre', 'workflow-stage-report', step.summary));
          stage.append(details);
        }
        stages.append(stage);
      }
      workflow.append(stages);
      detail.append(workflow);
    }
    if (integration && job.kind === 'code') detail.append(renderIntegration(integration, job, receipt));
    detail.append(el('p', 'microcopy', `Creado por: ${job.actor || 'desconocido'}`));
    if (job.error?.message) {
      const error = el('p', '', job.error.message);
      error.style.color = '#ffc98a';
      detail.append(error);
      const entries = Object.entries(job.error.details || {});
      if (entries.length) {
        const more = document.createElement('details');
        more.dataset.panelDetail = `${card.id}-error-details`;
        more.append(el('summary', '', `Detalle del error (${job.error.code || 'sin código'})`), el('pre', 'job-output', entries.map(([key, value]) => `${key}: ${value}`).join('\n')));
        detail.append(more);
      }
    }
    if (job.result?.text) detail.append(el('pre', 'job-output', job.result.text));
    const sourceIdea = data.ideas?.find(idea => ideaLinks(idea, [job]).length);
    if (sourceIdea) {
      const link = el('button', 'button secondary', 'Ver idea de origen');
      link.onclick = () => { saveIdeaPreferences({ ...IdeaView.defaults(), status: sourceIdea.status || 'active' }); location.hash = '#ideas'; $('#ideas-count').focus(); renderIdeas(data); document.getElementById(`idea-${sourceIdea.id}`)?.scrollIntoView({ block: 'center' }); };
      detail.append(link);
    }
    if (job.prompt) {
      const prompt = document.createElement('details');
      prompt.dataset.panelDetail = `${card.id}-prompt`;
      prompt.style.marginTop = '9px';
      const promptSummary = el('summary', '', 'Ver encargo');
      prompt.append(promptSummary, el('div', 'job-output', job.prompt));
      detail.append(prompt);
    }
    if (job.workspace) detail.append(el('div', '', `Checkout: ${job.workspace} · Rama confirmada: ${job.branch || 'sin verificar (registro anterior)'}`));
    if (job.workflowHistory?.length) {
      const history = el('details');
      history.dataset.panelDetail = `${card.id}-attempts`;
      history.append(el('summary', '', 'Informes y dispatches de intentos anteriores'), el('pre', 'job-output', JSON.stringify(job.workflowHistory, null, 2)));
      detail.append(history);
    }
    detail.append(el('div', '', `Proveedor: ${job.provider || 'sin configurar'}`));
    if (job.state === 'needs_attention') {
      detail.append(el('p', '', `Etapa: ${job.workflow?.currentStage || 'sin confirmar'} · Intento ${job.attempts}/${job.maxAttempts}. ${data.executor?.reason || 'Revisa los dispatches y confirma que no queda un agente activo antes de decidir.'}`));
      detail.append(...jobActionButtons(job, data, receipt));
    }
    card.append(detail);
    if (job.autoIntent) detail.append(el('p', '', `Recibo: ${job.autoIntent.receiptId} · ${job.autoIntent.eligible ? 'Elegible al confirmar' : 'Manual al confirmar'}`));
    if (receipt?.reason) detail.append(el('p', '', `Estado del recibo: ${receipt.status} · ${receipt.reason}`));
    if (job.destination) detail.append(el('p', '', `Destino: ${job.destination.repository || 'GitHub pendiente'} · ${job.branch || 'rama fuente pendiente'} → ${job.destination.baseBranch || 'base pendiente'} · SHA ${job.destination.sha || 'sin verificar'} · ${job.destination.verified ? `Verificado ${formatDate(job.destination.checkedAt)}` : 'Verificación previa al inicio pendiente'}`));
    detail.append(el('p', '', `Próxima acción: ${job.state === 'needs_attention' ? 'Consultar dispatch y revisar efectos.' : job.state === 'running' ? 'Esperar la etapa activa; pausar solo detiene nuevos trabajos.' : job.state === 'queued' && job.autoIntent?.eligible ? 'Esperar al ejecutor con la empresa activa y sin bloqueos.' : closed ? 'Revisar entrega local e historial.' : 'Despacho manual por ID tras revisión.'}`));
    if (closed && openActive.has(card.id)) $('#history').open = true;
    (closed ? historyList : groups[job.state === 'running' ? 'running' : job.state === 'needs_attention' || job.state === 'retry_wait' || receiptBlocked ? 'attention' : automaticPending ? 'automatic' : 'manual']).append(card);
  }
  if (!list.children.length) list.append(el('div', 'empty-state', 'No hay trabajos abiertos en esta vista. Los cerrados est?n en Historial.'));
  restoreDetails();
}

// Retry / resolve for a job that needs review. Shared by the job card and the job page, so each action has one implementation.
function jobActionButtons(job, data, receipt) {
  const buttons = [];
  const interruptedDevelopment = job.provider === 'orca' && job.autoIntent?.eligible && receipt?.status === 'needs_attention'
    && job.error?.code === 'timeout' && job.workflow?.currentStage === 'developer';
  const qa = job.workflow?.steps?.find(step => step.key === 'qa');
  const qaRevalidations = job.livenessRecoveryHistory?.filter(item => item.mode === 'same_attempt_integration_validation' && item.stage === 'qa').length ?? 0;
  const revalidate = job.autoIntent?.eligible && receipt?.status === 'needs_attention' && qaRevalidations < job.maxAttempts - 1
    && job.error?.code === 'delivery_incomplete' && job.workflow?.currentStage === 'qa' && qa?.dispatchSettled
    && ['blocked', 'failed'].includes(qa.delivery?.outcome) && qa.delivery.scope === 'complete' && qa.resultMessageId;
  const retryLabel = revalidate ? 'Revalidar QA' : interruptedDevelopment ? 'Retomar Desarrollo' : 'Reintentar después de revisar';
  for (const [action, label] of [['retry', retryLabel], ['resolve', 'Cerrar trabajo']]) {
    const button = el('button', 'button secondary', label);
    button.disabled = !data.executor?.available || (action === 'retry' && !revalidate && job.attempts >= job.maxAttempts);
    button.title = !data.executor?.available ? data.executor?.reason : action === 'retry' && !revalidate && job.attempts >= job.maxAttempts ? 'Máximo de intentos alcanzado' : '';
    button.addEventListener('click', async () => {
      const autoRetry = action === 'retry' && job.autoIntent?.eligible && receipt?.status === 'needs_attention';
      const reviewText = action === 'retry' && revalidate
        ? 'El panel comprobará el candidato y volverá a ejecutar QA conservando Desarrollo y el informe anterior.'
        : action === 'retry' && interruptedDevelopment
        ? 'El panel verificará en Orca que el trabajador anterior salió y retomará la misma tarea con los cambios guardados.'
        : autoRetry
        ? 'Consulta Orca y confirma que no hay Run ni dispatch para este intento y que no hay agentes activos. El mismo trabajo se reintentará una vez con su recibo confirmado.'
        : 'Confirma que revisaste los efectos y que no queda ningún agente activo.';
      if (!confirm(`${label}: ${job.title} (${job.id}).\nMotivo: ${job.error?.message || 'Requiere revisión'}.\n${reviewText} ${action === 'retry' ? 'Se volverá a encolar este trabajo.' : 'Se cerrará sin cancelar dispatches de Orca.'}`)) return;
      button.disabled = true;
      try {
        await api(`/api/jobs/${encodeURIComponent(job.id)}/${action}`, { method: 'POST', body: JSON.stringify({ confirmReviewed: true, noDispatchConfirmed: autoRetry && !interruptedDevelopment && !revalidate }) });
        state.highlightJob = job.id;
        await refresh();
      } catch (error) { notify(error.message, true); button.disabled = false; }
    });
    buttons.push(button);
  }
  return buttons;
}

function renderIntegration(integration, job, receipt) {
  const section = el('section', 'job-integration');
  section.setAttribute('aria-label', 'Paso Integración GitHub');
  section.append(el('h4', '', 'Integración GitHub'));
  const source = integration.sourceBranch || job.branch || 'rama fuente pendiente';
  const base = integration.baseBranch || job.destination?.baseBranch || 'rama base pendiente';
  section.append(el('p', 'integration-route', `Origen ${source} → destino ${base}`));
  const stage = job.workflow?.steps?.find(step => step.key === 'integration');
  const phase = integration.phase || (integration.status === 'needs_attention' || stage?.status === 'blocked' ? 'needs_attention' : 'pending');
  const labels = {
    preflight_complete: 'Aprobación local confirmada',
    commit_intent: 'Commit local solicitado · pendiente de confirmar',
    commit_confirmed: 'Commit preparado y confirmado localmente',
    push_intent: 'Push solicitado · confirmación pendiente',
    push_confirmed: 'Push remoto confirmado',
    pr_intent: 'Creación de PR solicitada · confirmación pendiente',
    pr_confirmed: 'PR confirmada · checks pendientes',
    checks_pending: 'PR/checks pendientes o fallidos',
    merge_intent: 'Merge solicitado · confirmación pendiente',
    complete: integration.mergeSha && source !== base ? 'Merge confirmado' : 'Push confirmado',
    needs_attention: 'Necesita revisión',
  };
  const approved = ['ux', 'developer', 'qa', 'reviewer'].every(key => job.workflow?.steps?.find(step => step.key === key)?.status === 'succeeded');
  if (approved) section.append(el('p', 'integration-approval', 'Aprobación local de UX, Desarrollo, QA y Revisión confirmada.'));
  const reviewRequired = integration.status === 'needs_attention' || stage?.status === 'blocked';
  const phaseLabel = reviewRequired
    ? phase === 'checks_pending' ? 'Necesita revisión · PR/checks pendientes o fallidos' : 'Necesita revisión'
    : labels[phase] || (stage?.summary ? 'Integración en curso' : 'Integración pendiente');
  section.append(el('p', `integration-phase ${reviewRequired ? 'blocked' : ''}`, phaseLabel));
  if (integration.commitSha) section.append(el('p', 'integration-evidence', `Commit SHA: ${integration.commitSha}`));
  if (integration.prUrl) {
    const pr = el('a', 'integration-link', `PR #${integration.prNumber || ''} · ${integration.prUrl}`);
    pr.href = integration.prUrl; pr.target = '_blank'; pr.rel = 'noopener noreferrer';
    section.append(pr);
  }
  if (integration.mergeSha) section.append(el('p', 'integration-evidence', `Merge SHA: ${integration.mergeSha}`));
  if (['checks_pending', 'needs_attention'].includes(phase) || reviewRequired) {
    const reason = integration.error || job.error?.message || receipt?.reason || stage?.summary || 'La integración requiere revisión; consulta el estado persistido del job y el remoto.';
    section.append(el('p', 'integration-reason', `Motivo: ${reason}`));
  }
  return section;
}

function refreshProjectSelectors(projects) {
  for (const [selectorId, businessId] of [['job-project', 'job-business'], ['idea-project', 'idea-business']]) {
    const select = $(`#${selectorId}`);
    if (!select || document.activeElement === select || (selectorId === 'idea-project' && state.ideaBusy)) continue;
    const selected = select.value;
    const business = $(`#${businessId}`).value;
    select.replaceChildren(new Option('Elige un proyecto', ''));
    for (const project of projects.filter(item => item.business === business && item.status !== 'completed')) {
      select.add(new Option(project.name, project.id));
    }
    if (projects.some(item => item.id === selected && item.business === business && item.status !== 'completed')) select.value = selected;
  }
}

function renderProjects(data) {
  const grid = $('#projects-grid');
  grid.replaceChildren();
  const allProjects = data.projects || [];
  $('#project-count').textContent = String(allProjects.length);
  if (!allProjects.length) {
    grid.append(el('div', 'empty-state', 'Crea el primer proyecto. Después podrás seguir su etapa y asociar cada idea y trabajo a su aplicación.'));
    return;
  }
  const query = $('#project-search').value.trim().toLocaleLowerCase('es');
  const businessFilter = $('#project-business-filter').value;
  const statusFilter = $('#project-status-filter').value;
  const projects = allProjects.filter(project =>
    (businessFilter === 'all' || project.business === businessFilter) &&
    (statusFilter === 'all' || project.status === statusFilter) &&
    (!query || project.name.toLocaleLowerCase('es').includes(query))
  );
  if (!projects.length) {
    grid.append(el('div', 'empty-state', 'No hay proyectos que coincidan con esos filtros.'));
    return;
  }
  for (const project of projects) {
    const card = el('article', 'project-card');
    const header = el('div', 'project-card-header');
    const identity = el('div', 'project-identity');
    identity.append(el('span', 'eyebrow', businessNames[project.business] || project.business), el('h3', '', project.name));
    const statusLabel = { active: 'Activo', paused: 'Pausado', completed: 'Completado' }[project.status] || project.status;
    header.append(identity, el('span', `badge ${project.status === 'active' ? 'ok' : 'neutral'}`, statusLabel));
    card.append(header);

    const stages = el('div', 'project-stages');
    (project.stages || []).forEach((stage, index) => {
      const item = el('span', `project-stage ${index < project.stageIndex ? 'past' : index === project.stageIndex ? 'current' : ''}`, stage);
      stages.append(item);
    });
    card.append(stages);

    if (project.nextAction) card.append(el('p', 'project-next', project.nextAction));
    card.append(el('div', 'project-activity', `${project.jobCount || 0} trabajos · ${project.openJobCount || 0} abiertos`));
    // Shared memory of the team for this project: what is in force, what is being evaluated and what is only history.
    if (project.sharedMemory) card.append(el('div', 'project-activity project-memory', project.sharedMemory.error ? `Memoria compartida no aplicada: ${project.sharedMemory.error}`
      : `Memoria compartida: ${project.sharedMemory.vigentes} vigentes · ${project.sharedMemory.enEvaluacion} en evaluación · ${project.sharedMemory.historial} en historial${project.sharedMemory.decisiones.length ? ` · Decisión vigente: ${project.sharedMemory.decisiones.join('; ')}` : ''}`));
    const latest = project.recentJobs || [];
    if (latest.length) {
      const jobList = el('div', 'project-recent-jobs');
      for (const job of latest) jobList.append(el('div', '', `${job.title} · ${statusNames[job.state] || job.state}`));
      card.append(jobList);
    }

    const form = el('form', 'project-update-form');
    const stageLabel = el('label', '', 'Etapa actual');
    const stageSelect = el('select');
    stageSelect.name = 'stageIndex';
    (project.stages || []).forEach((stage, index) => stageSelect.add(new Option(stage, String(index))));
    stageSelect.value = String(project.stageIndex || 0);
    stageLabel.append(stageSelect);
    const nextLabel = el('label', '', 'Siguiente paso');
    const nextInput = el('input');
    nextInput.name = 'nextAction'; nextInput.maxLength = 240; nextInput.value = project.nextAction || '';
    nextInput.placeholder = 'Qué toca hacer ahora';
    nextLabel.append(nextInput);
    const statusLabelEl = el('label', '', 'Estado');
    const statusSelect = el('select'); statusSelect.name = 'status';
    for (const [value, label] of [['active', 'Activo'], ['paused', 'Pausado'], ['completed', 'Completado']]) statusSelect.add(new Option(label, value));
    statusSelect.value = project.status;
    statusLabelEl.append(statusSelect);
    const save = el('button', 'button secondary', 'Actualizar proyecto'); save.type = 'submit';
    const checkoutLabel = el('label', '', 'Checkout de desarrollo');
    const checkout = el('select'); checkout.name = 'checkout';
    checkout.add(new Option('Sin configurar', ''));
    for (const candidate of data.checkouts || []) {
      const option = new Option(candidate.valid ? `${candidate.value} · ${candidate.branch}` : `${candidate.value}: ${candidate.reason}`, candidate.value);
      option.disabled = !candidate.valid;
      checkout.add(option);
    }
    if (project.checkout && ![...checkout.options].some(option => option.value === project.checkout)) {
      const option = new Option(`${project.checkout}: ruta inválida o inexistente`, project.checkout); option.disabled = true; checkout.add(option);
    }
    checkout.value = project.checkout || '';
    checkoutLabel.append(checkout);
    const repositoryLabel = el('label', '', 'Repositorio GitHub (propietario/repositorio)');
    const repository = el('input'); repository.name = 'repository'; repository.value = project.repository || ''; repository.placeholder = 'propietario/repositorio'; repositoryLabel.append(repository);
    const baseBranchLabel = el('label', '', 'Rama base GitHub');
    const baseBranch = el('input'); baseBranch.name = 'baseBranch'; baseBranch.value = project.baseBranch || ''; baseBranch.placeholder = 'main';
    const baseBranchHelp = el('span', 'base-branch-help', 'Rama existente que recibe la PR o el merge. Si coincide con la rama fuente, se integra directamente.');
    baseBranchHelp.id = `base-branch-help-${project.id}`;
    const validity = (data.checkouts || []).find(candidate => candidate.value === project.checkout);
    const branchContext = el('span', 'base-branch-context', `Rama fuente observada: ${validity?.valid ? validity.branch : 'sin confirmar'} → base: ${project.baseBranch || 'configuración pendiente'}`);
    branchContext.id = `base-branch-context-${project.id}`;
    baseBranch.setAttribute('aria-describedby', `${baseBranchHelp.id} ${branchContext.id}`);
    if (!project.baseBranch) baseBranch.setAttribute('aria-invalid', 'true');
    baseBranchLabel.append(baseBranch, baseBranchHelp, branchContext);
    baseBranch.addEventListener('input', () => {
      branchContext.textContent = `Rama fuente observada: ${validity?.valid ? validity.branch : 'sin confirmar'} → base: ${baseBranch.value.trim() || 'configuración pendiente'}`;
      if (baseBranch.value.trim()) {
        baseBranch.removeAttribute('aria-invalid');
        baseBranchHelp.textContent = 'Rama existente que recibe la PR o el merge. Si coincide con la rama fuente, se integra directamente.';
      }
    });
    form.append(stageLabel, nextLabel, statusLabelEl, checkoutLabel, repositoryLabel, baseBranchLabel, save);
    card.append(el('p', 'microcopy', validity?.valid ? `Checkout válido: ${project.checkout} · Rama fuente observada: ${validity.branch} · Base: ${project.baseBranch || 'configuración pendiente'}` : 'Sin checkout válido. Solo checkouts independientes bajo workspaces/; se rechazan rutas externas, inexistentes, enlaces fuera del ámbito y Git compartido.'));
    if (project.remote) card.append(el('p', 'microcopy', project.remote.verified ? `Remoto verificado al guardar: origin ${project.remote.origin} · ${project.remote.branch} en ${String(project.remote.remoteSha).slice(0, 7)}` : `Remoto sin verificar: ${project.remote.warning}`));
    else if (project.checkout && project.repository) card.append(el('p', 'microcopy', 'Remoto pendiente de verificar: vuelve a guardar el proyecto para comprobar origin, rama y SHA.'));
    const draft = state.projectDrafts.get(project.id);
    if (draft) for (const [key, value] of Object.entries(draft)) if (form.elements[key]) form.elements[key].value = value;
    form.addEventListener('input', () => state.projectDrafts.set(project.id, Object.fromEntries(new FormData(form))));
    form.addEventListener('change', () => state.projectDrafts.set(project.id, Object.fromEntries(new FormData(form))));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!baseBranch.value.trim()) {
        baseBranch.setAttribute('aria-invalid', 'true');
        baseBranchHelp.textContent = 'Configuración pendiente: indica una rama base GitHub existente antes de guardar.';
        baseBranch.focus();
        return;
      }
      save.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        await api(`/api/projects/${encodeURIComponent(project.id)}/update`, { method: 'POST', body: JSON.stringify(values) });
        state.projectDrafts.delete(project.id);
        notify(`Proyecto «${project.name}» actualizado.`);
        await refresh();
      } catch (error) { notify(error.message, true); save.disabled = false; }
    });
    // As in the mockup the card reads as a row; editing lives in a disclosure that survives refreshes.
    const edit = el('details', 'project-edit');
    edit.open = state.openProjects?.has(project.id) || state.projectDrafts.has(project.id);
    edit.addEventListener('toggle', () => { state.openProjects ||= new Set(); edit.open ? state.openProjects.add(project.id) : state.openProjects.delete(project.id); });
    edit.append(el('summary', '', 'Editar etapa, siguiente paso y destino'), form);
    card.append(edit);
    grid.append(card);
  }
}

function renderQuestions(data) {
  const list = $('#questions-list');
  const active = document.activeElement;
  const focusedQuestionId = active?.matches('textarea[name="answer"]') ? active.dataset.questionId : null;
  const selection = focusedQuestionId ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection } : null;
  const scrollTop = list.scrollTop;
  list.replaceChildren();
  const pending = data.questions.filter(question => question.status === 'pending');
  $('#question-count').textContent = String(pending.length);
  $('#metric-questions').textContent = String(pending.length);
  $('#pending-pill').textContent = String(pending.length);
  if (!data.questions.length) {
    list.append(el('div', 'empty-state', 'Cuando un agente necesite tu criterio, dejará aquí la pregunta y te avisará por Telegram.'));
    return;
  }
  for (const question of [...pending, ...data.questions.filter(item => item.status !== 'pending').slice(0, 20)]) {
    const card = el('article', 'question-card');
    card.id = `question-${question.id}`;
    const meta = el('div', 'question-meta');
    meta.append(el('span', '', `${businessNames[question.business] || question.business} · ${question.id}`));
    meta.append(el('span', question.status, question.status === 'pending' ? 'pendiente' : 'respondida'));
    card.append(meta, el('h4', '', question.title), el('p', '', question.question));
    if (question.status === 'pending') {
      const form = el('form', 'question-answer');
      const input = el('textarea');
      input.name = 'answer';
      input.dataset.questionId = question.id;
      input.required = true;
      input.minLength = 2;
      input.maxLength = 4000;
      input.value = state.questionDrafts.get(question.id) ?? '';
      input.placeholder = 'Tu criterio o respuesta…';
      input.addEventListener('input', () => state.questionDrafts.set(question.id, input.value));
      const button = el('button', 'button secondary', question.coordinatorRequestId ? 'Guardar respuesta para el coordinador' : 'Responder y guardar en Obsidian');
      button.type = 'submit';
      form.append(input, button);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        button.disabled = true;
        try {
          const updated = await api(`/api/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: input.value }) });
          state.questionDrafts.delete(question.id);
          notify(updated.coordinatorRequestId ? (updated.answerDeliveryStatus === 'sent' ? 'Respuestas agrupadas enviadas al mismo coordinador.' : 'Respuesta guardada. Se reunirán las decisiones pendientes antes de continuar.') : updated.lateDecision ? 'Decisión guardada después de preparar la continuación; requiere revisión antes de aplicarla.' : updated.followUpJobId ? `Decisiones guardadas; continuación vinculada a ${updated.followUpJobId}.` : 'Respuesta guardada; las decisiones del mismo trabajo se reunirán antes de continuar.');
          await refresh();
        } catch (error) { notify(error.message, true); button.disabled = false; }
      });
      card.append(form);
    } else if (question.answer) {
      card.append(el('p', '', `Tu respuesta: ${question.answer}`));
      if (question.followUpJobId) card.append(el('div', 'question-meta', `Continuación vinculada: ${question.followUpJobId}`));
      const continuation = (data.continuations || []).find(item => item.id === question.continuationId);
      if (continuation?.status === 'needs_attention') {
        card.append(el('p', 'question-meta', continuation.reason));
        const retry = el('button', 'button secondary', 'Reanudar con respuesta guardada');
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            const result = await api(`/api/continuations/${encodeURIComponent(continuation.id)}/retry`, { method: 'POST', body: '{}' });
            if (result.status === 'needs_attention') notify(result.reason, true);
            await refresh();
          } catch (error) { notify(error.message, true); retry.disabled = false; }
        });
        card.append(retry);
      } else if (continuation?.status === 'pending' && continuation.reason?.startsWith('Respuesta guardada.')) {
        card.append(el('p', 'question-meta', continuation.reason));
      }
      if (question.lateDecision) card.append(el('p', 'question-meta', 'Esta decisión llegó después de preparar la continuación; revisión pendiente.'));
      if (question.inherited) card.append(el('p', 'question-meta', 'Decisión ya disponible: se conserva la respuesta anterior sin iniciar otra conversación.'));
    }
    list.append(card);
  }
  list.scrollTop = scrollTop;
  if (focusedQuestionId) {
    const replacement = [...list.querySelectorAll('textarea[name="answer"]')].find(input => input.dataset.questionId === focusedQuestionId);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      if (selection) replacement.setSelectionRange(selection.start, selection.end, selection.direction);
    }
  }
}

function focusJob(id) {
  state.highlightJob = id;
  state.filter = 'all';
  location.hash = '#trabajos'; showSection();
  if (state.data?.jobs.find(job => job.id === id && ['succeeded', 'cancelled'].includes(job.state))) $('#history').open = true;
  if (state.data) renderJobs(state.data);
  const card = document.getElementById(`job-${id}`);
  if (card) {
    card.open = true;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function tagsFrom(value) { return String(value || '').split(',').map(tag => tag.trim()).filter(Boolean); }
function trapDialog(dialog) {
  const trap = event => {
    if (event.key !== 'Tab') return;
    const fields = [...dialog.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex="0"]')].filter(field => !field.disabled && field.getClientRects().length);
    const first = fields[0], last = fields.at(-1);
    if (!first) { event.preventDefault(); return; }
    if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !dialog.contains(document.activeElement)) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  };
  dialog.addEventListener('keydown', trap);
  dialog.addEventListener('close', () => dialog.removeEventListener('keydown', trap), { once: true });
}
function ideaLinks(idea, jobs = state.data?.jobs || []) {
  return jobs.filter(job => job.ideaId === idea.id || Object.values(idea.requests || {}).some(request => request.jobId === job.id) || job.id === `idea-${idea.id}-${job.kind}` || job.prompt?.includes(`[IDEA_ID:${idea.id}]`));
}
function ideaIsBusy(idea) { return state.ideaSends.has(idea.id) || Object.values(idea.requests || {}).some(request => ['pending', 'active', 'uncertain'].includes(request.status)); }
function labelField(label, node) { const wrapper = el('label', '', label); wrapper.append(node); return wrapper; }
function focusField(value = '') {
  const field = el('fieldset', 'idea-focus'); field.append(el('legend', '', 'Foco del trabajo'));
  for (const [key, title] of Object.entries(IdeaView.focusNames)) {
    const radio = el('input'); radio.type = 'radio'; radio.name = 'focus'; radio.value = key; radio.checked = value === key;
    field.append(labelField(title, radio));
  }
  return field;
}
async function discardDialog() {
  const dialog = el('dialog'); dialog.setAttribute('aria-label', 'Descartar cambios');
  trapDialog(dialog);
  const keep = el('button', 'button secondary', 'Cancelar'); const discard = el('button', 'button primary', 'Descartar cambios');
  dialog.append(el('p', '', 'Hay cambios sin guardar. ¿Quieres descartarlos?'), keep, discard); document.body.append(dialog);
  return new Promise(resolve => {
    let result = false; keep.onclick = () => dialog.close(); discard.onclick = () => { result = true; dialog.close(); };
    dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true }); dialog.showModal(); keep.focus();
  });
}
function ideaFocusTarget(trigger) {
  const cardId = trigger?.closest('#ideas-list article')?.id;
  const label = trigger?.textContent;
  return () => {
    if (trigger?.isConnected && !trigger.disabled) return trigger.focus();
    const card = cardId && document.getElementById(cardId);
    const replacement = card && [...card.querySelectorAll('button')].find(button => button.textContent === label && !button.disabled);
    (replacement || card?.querySelector('summary') || $('#ideas-status')).focus();
  };
}
function ideaDialog(title, nodes, submitText, onSubmit, editable = false) {
  const dialog = $('#idea-dialog'), form = $('#idea-dialog-form'), content = $('#idea-dialog-content');
  trapDialog(dialog);
  const restoreFocus = ideaFocusTarget(document.activeElement); let dirty = false, pending = false;
  $('#idea-dialog-title').textContent = title; content.replaceChildren(...nodes); $('#idea-dialog-error').textContent = '';
  let progress = $('#idea-dialog-status');
  if (!progress) { progress = el('p'); progress.id = 'idea-dialog-status'; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite'); $('#idea-dialog-error').before(progress); }
  progress.textContent = '';
  $('#idea-dialog-submit').textContent = submitText;
  for (const field of content.querySelectorAll('input, textarea, select')) field.setAttribute('aria-describedby', 'idea-dialog-error');
  return new Promise(resolve => {
    let result = null;
    const change = () => { dirty = true; };
    const cancel = async event => { event?.preventDefault(); if (!pending && (!editable || !dirty || await discardDialog())) dialog.close(); };
    const submit = async event => {
      event.preventDefault(); if (pending) return; pending = true;
      $('#idea-dialog-submit').disabled = true; $('#idea-dialog-cancel').disabled = true;
      $('#idea-dialog-error').textContent = ''; progress.textContent = 'Guardando…'; form.setAttribute('aria-busy', 'true');
      try { result = await onSubmit(Object.fromEntries(new FormData(form))); dialog.close(); }
      catch (error) { $('#idea-dialog-error').textContent = error.message; }
      finally { pending = false; progress.textContent = ''; form.setAttribute('aria-busy', 'false'); $('#idea-dialog-submit').disabled = false; $('#idea-dialog-cancel').disabled = false; }
    };
    const finish = () => {
      form.removeEventListener('input', change); form.removeEventListener('submit', submit); dialog.removeEventListener('cancel', cancel);
      restoreFocus(); resolve(result);
    };
    form.addEventListener('input', change); form.addEventListener('submit', submit); dialog.addEventListener('cancel', cancel);
    dialog.addEventListener('close', finish, { once: true }); $('#idea-dialog-cancel').onclick = cancel;
    dialog.showModal(); $('#idea-dialog-cancel').focus();
  });
}
async function editIdea(idea) {
  let expectedVersion = idea.version || 1;
  const title = el('input'); title.name = 'title'; title.value = idea.title; title.maxLength = 100; title.required = true;
  const text = el('textarea'); text.name = 'text'; text.value = idea.text; text.rows = 6; text.minLength = 4; text.maxLength = 6000; text.required = true;
  const tags = el('input'); tags.name = 'tags'; tags.setAttribute('list', 'idea-tag-suggestions'); tags.value = (idea.tags || []).join(', ');
  const project = el('select'); project.name = 'projectId'; project.add(new Option('Sin proyecto', ''));
  for (const item of state.data.projects.filter(item => item.business === idea.business && (item.status !== 'completed' || item.id === idea.projectId))) project.add(new Option(`${item.name}${item.status === 'completed' ? ' (cerrado)' : ''}`, item.id));
  project.value = idea.projectId || '';
  const links = ideaLinks(idea);
  const notice = el('p', '', links.length ? 'Los cambios se usarán en futuros encargos; los existentes conservan su brief y destino. Cambiar proyecto reasigna solo la idea.' : 'Guardar cambios no crea un trabajo.');
  for (const job of links) notice.append(el('span', 'historical-destination', `${job.title} · ${job.projectName || 'Sin proyecto'} · ${job.workspace || 'Planificador'} · ${job.branch || ''}`));
  const reload = el('button', 'button secondary', 'Recargar versi\u00f3n conservando borrador'); reload.type = 'button';
  reload.onclick = async () => {
    try {
      const raw = await api('/api/state'), latest = raw.ideas.find(item => item.id === idea.id);
      if (!latest) throw new Error('No encuentro esa idea.');
      expectedVersion = latest.version || 1;
      const saved = el('details'); saved.append(el('summary', '', `Versi\u00f3n guardada ${expectedVersion}: revisar antes de guardar el borrador`), el('p', 'idea-text', `${latest.title}\n${latest.text}\n${latest.projectName || 'Sin proyecto'}\n${IdeaView.focusNames[latest.focus || '']}\n${(latest.tags || []).join(', ')}`)); notice.replaceChildren(saved);
      $('#idea-dialog-error').textContent = 'Versi\u00f3n actual cargada; tu borrador se conserva. Guardar cambios aplicar\u00e1 ese borrador sobre esta versi\u00f3n.';
    } catch (error) { $('#idea-dialog-error').textContent = error.message; }
  };
  return ideaDialog('Editar idea', [labelField('Título', title), labelField('Idea íntegra', text), focusField(idea.focus), labelField('Etiquetas (hasta cinco de 24 caracteres, separadas por comas)', tags), labelField('Proyecto', project), notice, reload], 'Guardar cambios', async values => {
    if (links.length && values.projectId !== (idea.projectId || '') && !await confirmIdeaAction('Confirmar cambio de proyecto', 'Los trabajos anteriores conservarán sus destinos históricos.', 'Cambiar proyecto')) throw new Error('Cambio de proyecto cancelado; se conserva el borrador.');
    const updated = await api(`/api/ideas/${idea.id}/update`, { method: 'POST', body: JSON.stringify({ ...values, tags: tagsFrom(values.tags), version: expectedVersion }) });
    notify('Idea actualizada localmente; captura original conservada.'); return updated;
  }, true);
}
function confirmIdeaAction(title, message, label) {
  const dialog = el('dialog'); dialog.setAttribute('aria-label', title);
  trapDialog(dialog);
  const cancel = el('button', 'button secondary', 'Cancelar'), yes = el('button', 'button primary', label);
  dialog.append(el('h2', '', title), el('p', '', message), cancel, yes); document.body.append(dialog);
  return new Promise(resolve => { let ok = false; cancel.onclick = () => dialog.close(); yes.onclick = () => { ok = true; dialog.close(); }; dialog.addEventListener('close', () => { dialog.remove(); resolve(ok); }, { once: true }); dialog.showModal(); cancel.focus(); });
}
const ideaPreferenceCache = new Map();
function saveIdeaPreferences(prefs) { ideaPreferenceCache.set(state.business, prefs); try { localStorage.setItem(`ideas-view-${state.business}`, JSON.stringify(prefs)); } catch {} }
function ideaPreferences() {
  if (ideaPreferenceCache.has(state.business)) return { ...ideaPreferenceCache.get(state.business) };
  try { return { ...IdeaView.defaults(), ...JSON.parse(localStorage.getItem(`ideas-view-${state.business}`) || '{}') }; } catch { return IdeaView.defaults(); }
}
function renderIdeas(data) {
  if ($('#idea-dialog').open || document.activeElement?.closest('#ideas-list, #idea-filters')) return;
  const prefs = ideaPreferences(), list = $('#ideas-list'); list.setAttribute('aria-busy', 'false');
  const restoreDetails = capturePanelDetails(list);
  const projectSelect = $('#ideas-project'); projectSelect.replaceChildren(new Option('Todos los proyectos', ''), new Option('Sin proyecto', 'none'));
  for (const project of data.projects) projectSelect.add(new Option(project.name, project.id));
  let suggestions = $('#idea-tag-suggestions');
  if (!suggestions) { suggestions = el('datalist'); suggestions.id = 'idea-tag-suggestions'; $('#idea-form').append(suggestions); $('#idea-form [name=tags]').setAttribute('list', suggestions.id); }
  suggestions.replaceChildren(...[...new Set(data.ideas.flatMap(idea => idea.tags || []))].map(tag => new Option(tag, tag)));
  const tagSelect = $('#ideas-tag'); tagSelect.replaceChildren(new Option('Todas', ''));
  const tags = new Map(); for (const idea of data.ideas) for (const tag of idea.tags || []) if (!tags.has(tag.toLocaleLowerCase('es'))) tags.set(tag.toLocaleLowerCase('es'), tag);
  for (const tag of [...tags.values()].sort((a,b) => a.localeCompare(b, 'es'))) tagSelect.add(new Option(tag, tag));
  for (const key of ['project', 'tag']) if (![...$(`#ideas-${key}`).options].some(option => option.value === prefs[key])) { prefs[key] = ''; notify('Se ha restablecido un filtro que ya no existe.'); }
  for (const [key, value] of Object.entries(prefs)) if ($(`#ideas-${key}`)) $(`#ideas-${key}`).value = value;
  for (const key of ['focus', 'status', 'order']) if (!$(`#ideas-${key}`).value) { prefs[key] = IdeaView.defaults()[key]; $(`#ideas-${key}`).value = prefs[key]; }
  saveIdeaPreferences(prefs);
  const ideas = IdeaView.select(data.ideas, state.business, prefs); list.replaceChildren();
  const coordinatorRequests = data.coordinatorRequests || [];
  $('#ideas-count').textContent = `${ideas.length} ideas · ${businessNames[state.business]} · ${[...$('#idea-filters').querySelectorAll('select')].map(select => select.selectedOptions[0]?.textContent).join(' · ')}`;
  if (!ideas.length) list.append(el('p', 'empty-state', data.ideas.length ? 'No hay ideas con estos filtros. Usa Restablecer filtros.' : `Todavía no hay ideas en ${businessNames[state.business]}.`));
  for (const idea of ideas) {
    const card = el('article', 'recent-idea'); card.id = `idea-${idea.id}`;
    const coordinatorRequest = coordinatorRequests.filter(request => request.kind === 'idea' && request.ideaId === idea.id && (request.ideaVersion || 1) === (idea.version || 1)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const jobs = ideaLinks(idea, data.jobs), busy = ideaIsBusy(idea) || ['pending', 'routing', 'needs_attention'].includes(coordinatorRequest?.status);
    card.append(el('h4', '', idea.title), el('span', '', `${businessNames[idea.business]} · ${idea.projectName || 'Sin proyecto'} · ${IdeaView.focusNames[idea.focus || '']} · ${{ active: 'Activa', archived: 'Archivada', trash: 'Papelera' }[idea.status || 'active']}`));
    card.append(el('span', '', (idea.tags || []).join(' · ')), el('small', '', `Captura: ${formatDate(idea.createdAt)}${idea.updatedAt ? ` · Edición: ${formatDate(idea.updatedAt)}` : ''}`));
    const full = el('details'); full.dataset.panelDetail = `${card.id}-text`;
    full.append(el('summary', '', 'Ver completa'), el('p', 'idea-text', idea.text));
    card.append(el('p', 'idea-preview', idea.text), full, el('small', '', idea.notePath ? 'Captura original en Obsidian; versión actual local.' : `Guardada localmente · ${idea.noteError || 'Obsidian pendiente'}`));
    if (busy) card.append(el('p', '', 'Envío pendiente, activo o incierto: edición y retirada bloqueadas.'));
    if (coordinatorRequest) {
      const status = coordinatorRequest.status === 'routed' ? `Enrutada por el coordinador · ${coordinatorRequest.route?.kind === 'code' ? 'Desarrollo' : 'Planificador'}${coordinatorRequest.jobId ? ` · ${coordinatorRequest.jobId}` : ''}`
        : coordinatorRequest.status === 'routing' ? `Decisión registrada: ${coordinatorRequest.route?.kind === 'code' ? 'pipeline de código' : 'Planificador'} · materializando el mismo job de forma segura${coordinatorRequest.route?.lastError ? ` · ${coordinatorRequest.route.lastError}` : ''}`
        : coordinatorRequest.notification?.status === 'sent' ? 'Avisada al coordinador · decisión pendiente; todavía sin job ni dispatch'
          : coordinatorRequest.notification?.reason || 'Solicitud guardada · aviso al coordinador pendiente';
      card.append(el('p', `coordinator-request ${coordinatorRequest.status}`, status));
    }
    for (const job of jobs) { const button = el('button', 'button secondary', `Ver trabajo: ${job.title} · ${statusNames[job.state] || job.state} · ${job.projectName || ''} · ${job.workspace || 'Planificador'} · ${job.branch || ''}`); button.onclick = () => focusJob(job.id); card.append(button); }
    const addAction = (label, action, disabled = false) => {
      const button = el('button', 'button secondary', label); button.type = 'button'; button.disabled = disabled;
      button.onclick = async () => {
        const restoreFocus = ideaFocusTarget(button);
        try {
          const result = await action();
          if (result === null) return; // A cancelled dialog has already restored its opener.
          const returnToCard = document.activeElement?.closest('#ideas-list');
          if (returnToCard) document.activeElement.blur();
          await refresh();
          if (returnToCard) restoreFocus();
        } catch (error) { notify(error.message, true); }
      };
      card.append(button);
    };
    if (idea.status !== 'trash') addAction('Editar', () => editIdea(idea), busy);
    if (!['trash', 'archived'].includes(idea.status) && coordinatorRequest?.status !== 'routed') addAction(coordinatorRequest ? 'Revisar aviso al coordinador' : 'Enviar al coordinador', async () => {
      const result = await api(`/api/ideas/${encodeURIComponent(idea.id)}/coordinator`, { method: 'POST', body: '{}' });
      notify(result.message, ['unknown', 'needs_attention'].includes(result.request?.notification?.status));
      return result;
    }, ideaIsBusy(idea) || coordinatorRequest?.status === 'routing');
    const linked = jobs.length || Object.keys(idea.requests || {}).length || ['pending', 'routing', 'needs_attention', 'routed'].includes(coordinatorRequest?.status);
    const action = ['trash', 'archived'].includes(idea.status) ? 'restore' : linked ? 'archive' : 'trash';
    const title = { restore: 'Restaurar idea', archive: 'Archivar idea', trash: 'Eliminar idea' }[action];
    addAction(title, () => ideaDialog(title, [el('p', '', `${businessNames[idea.business]} · ${idea.title}`), el('p', '', action === 'trash' ? 'Se moverá a Papelera; podrás restaurarla y se conserva la captura original.' : action === 'archive' ? `Tiene ${jobs.length} trabajos vinculados. Se ocultará de Activas; su historial seguirá disponible.` : 'Recuperará la misma identidad sin crear trabajos.')], title, async () => {
      const updated = await api(`/api/ideas/${idea.id}/${action}`, { method: 'POST', body: JSON.stringify({ version: idea.version || 1 }) }); notify('Idea actualizada localmente.'); return updated;
    }), busy);
    list.append(card);
  }
  restoreDetails();
}

function renderTelegramMessages(data) {
  const list = $('#telegram-messages');
  list.replaceChildren();
  const messages = data.messages || [];
  const pending = messages.filter(message => message.status === 'pending');
  $('#telegram-message-count').textContent = String(pending.length);
  if (!messages.length) {
    list.append(el('div', 'muted-empty', 'Cuando escribas al bot algo que no sea una orden, aparecerá aquí.'));
    return;
  }
  for (const message of messages.slice(0, 20)) {
    const card = el('article', `telegram-message ${message.status === 'handled' ? 'handled' : ''}`);
    const meta = el('div', 'question-meta');
    meta.append(el('span', '', `${message.source || 'Telegram'} · ${message.id} · ${new Date(message.createdAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })}`));
    meta.append(el('span', message.status, message.status === 'pending' ? 'pendiente' : 'tratado'));
    card.append(meta, el('p', 'telegram-message-text', message.text));
    if (message.notePath) card.append(el('small', 'telegram-note-path', `Obsidian · ${message.notePath}`));
    if (message.status === 'pending') {
      const button = el('button', 'button secondary', 'Marcar tratado');
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api(`/api/messages/${encodeURIComponent(message.id)}/handled`, { method: 'POST', body: JSON.stringify({}) });
          notify('Mensaje marcado como tratado.');
          await refresh();
        } catch (error) { notify(error.message, true); button.disabled = false; }
      });
      card.append(button);
    }
    list.append(card);
  }
}

function renderDomains(data) {
  const domains = $('#domains-list');
  domains.replaceChildren();
  if (!data.domains.length) domains.append(el('div', 'empty-state', 'El inventario está vacío. Añade dominios desde Telegram con /dominio agregar…'));
  const today = new Date();
  for (const domain of data.domains.slice(0, 30)) {
    const card = el('article', 'domain-card');
    const orb = el('div', 'domain-orb', '◉');
    const main = el('div', 'domain-main');
    main.append(el('b', '', domain.domain), el('span', '', `${domain.client} · ${domain.accountRef || 'cuenta sin referencia'}`));
    const date = el('div', 'domain-date');
    date.append(document.createTextNode(formatDate(domain.renewalDate)));
    const remaining = Math.ceil((new Date(`${domain.renewalDate}T12:00:00`) - new Date(`${today.toISOString().slice(0, 10)}T12:00:00`)) / 86400000);
    date.append(el('small', '', remaining < 0 ? `${Math.abs(remaining)} d vencido` : remaining === 0 ? 'vence hoy' : `faltan ${remaining} d`));
    card.append(orb, main, date);
    domains.append(card);
  }
}

function renderAssistantTasks(data) {
  const list = $('#assistant-tasks');
  list.replaceChildren();
  if (!data.tasks.length) return list.append(el('div', 'muted-empty', 'No hay tareas personales pendientes.'));
  for (const task of data.tasks.slice(0, 8)) {
    const node = el('article', 'assistant-task', task.title);
    node.append(el('span', '', task.dueAt ? `Recordatorio · ${formatDate(task.dueAt)}` : 'Pendiente personal'));
    list.append(node);
  }
}

function renderSummary(data) {
  const counts = data.queue.counts;
  $('#metric-active').textContent = String(data.queue.active);
  $('#metric-needs').textContent = String(counts.needs_attention || 0);
  $('#queue-badge').textContent = `${counts.queued || 0} en cola`;
  $('#metric-notes').textContent = String(data.exportedCount || 0);
  $('#metric-domains').textContent = String(data.domains.length);
  $('#telegram-badge').textContent = data.settings.telegram ? 'Activo' : 'Sin conectar';
  $('#telegram-badge').className = `badge ${data.settings.telegram ? 'ok' : 'neutral'}`;
  $('#telegram-foot').textContent = data.settings.telegram ? 'Bot activo en este PC' : 'Configura el bot con el instalador local';
  $('#obsidian-badge').textContent = data.settings.vaultPath ? 'Conectado' : 'Sin conectar';
  $('#obsidian-badge').className = `badge ${data.settings.vaultPath ? 'ok' : 'warn'}`;
  $('#obsidian-foot').textContent = data.settings.vaultPath ? data.settings.vaultPath : 'Guarda ruta de la bóveda abajo';
  const status = $('#panel-state');
  const activeAutoRun = state.raw?.automation?.businesses?.[state.business] === true;
  status.textContent = activeAutoRun ? 'Autoejecución activa' : 'Autoejecución pausada';
  $('#panel-dot').style.background = activeAutoRun ? '#ffc98a' : '#8de0bd';
  const settingsForm = $('#settings-form');
  if (document.activeElement !== settingsForm.elements.vaultPath) settingsForm.elements.vaultPath.value = data.settings.vaultPath || '';
  const vaultName = (data.settings.vaultPath || '').split(/[\\/]/).filter(Boolean).pop();
  $('#open-obsidian').href = vaultName ? `obsidian://open?vault=${encodeURIComponent(vaultName)}` : 'obsidian://open';
  $('#vault-path-hint').textContent = data.settings.vaultPath ? 'Conectada · solo lectura de contexto y escritura de notas del Centro de Operaciones' : 'Elige la carpeta raíz de tu bóveda de Obsidian.';
  $('#updated-at').textContent = `Actualizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

function renderGraph(graph, config) {
  const root = $('#graph');
  root.replaceChildren();
  if (!graph.connected) {
    root.append(el('div', 'empty-graph', 'Conecta la bóveda de Obsidian en el panel lateral para dibujar su mapa.'));
    $('#graph-title').textContent = 'Bóveda sin conectar';
    $('#graph-subtitle').textContent = 'Los enlaces entre notas aparecerán aquí';
    return;
  }
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  $('#graph-title').textContent = `${nodes.length} notas · ${edges.length} enlaces`;
  $('#graph-subtitle').textContent = config.vaultPath || 'Bóveda de Obsidian';
  if (!nodes.length) return root.append(el('div', 'empty-graph', 'Aún no hay notas Markdown en la bóveda.'));
  const width = Math.max(root.clientWidth, 420);
  const height = 360;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const positions = new Map();
  const sorted = nodes.slice().sort((a, b) => a.title.localeCompare(b.title)).slice(0, 240);
  const radius = Math.min(width, height) * .38;
  sorted.forEach((node, index) => {
    const angle = index * 2.399963 + .3;
    const distance = radius * Math.sqrt((index + 1) / (sorted.length + 1));
    positions.set(node.id, { x: width / 2 + Math.cos(angle) * distance, y: height / 2 + Math.sin(angle) * distance, node });
  });
  for (const edge of edges) {
    const from = positions.get(edge.source), to = positions.get(edge.target);
    if (!from || !to) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', from.x); line.setAttribute('y1', from.y); line.setAttribute('x2', to.x); line.setAttribute('y2', to.y); line.setAttribute('class', 'graph-edge');
    svg.append(line);
  }
  for (const { x, y, node } of positions.values()) {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('class', `graph-node ${node.group}`);
    group.setAttribute('transform', `translate(${x} ${y})`);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', node.group === 'trabajo' ? '6' : node.group === 'idea' ? '5.5' : '4.5');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${node.title}\n${node.path}`;
    circle.append(title);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', '8'); label.setAttribute('y', '3'); label.textContent = node.title.length > 26 ? `${node.title.slice(0, 24)}…` : node.title;
    group.append(circle, label);
    group.addEventListener('click', () => {
      const vault = config.vaultPath.split(/[\\/]/).filter(Boolean).pop() || '';
      window.location.href = `obsidian://open?vault=${encodeURIComponent(vault)}&file=${encodeURIComponent(node.path.replace(/\.md$/i, ''))}`;
    });
    svg.append(group);
  }
  root.append(svg);
}

async function refreshGraph() {
  const business = state.business;
  try {
    const [graph, config] = await Promise.all([api(`/api/graph?business=${business}`), api('/api/config')]);
    if (state.business !== business) return;
    state.graph = graph;
    renderGraph(graph, config);
  } catch (error) { notify(error.message, true); }
}

async function refresh() {
  try {
    const raw = await api('/api/state');
    state.raw = raw;
    const data = scopeData(raw);
    state.data = data;
    renderAutomation(raw);
    renderActionSummary(raw, data);
    applyBusinessContext();
    updateHistoryProjects(data.projects);
    renderSummary(data);
    if (!document.activeElement?.closest('.project-update-form')) renderProjects(data);
    refreshProjectSelectors(data.projects || []);
    ideaCheckoutHint();
    renderJobs(data);
    renderAttention(data);
    renderHistory(data);
    if (state.visibleSection === 'trabajo' || location.hash.startsWith('#trabajo/')) renderRun(data);
    renderQuestions(data);
    window.RequestsView?.render(data, state.business);
    renderIdeas(data);
    $('#ideas-load-error').hidden = true;
    $('#ideas-load-message').textContent = '';
    $('#ideas-list').setAttribute('aria-busy', 'false');
    renderTelegramMessages(data);
    renderDomains(data);
    renderAssistantTasks(data);
    if (pipelineState.server) renderPipelineScopes(); // only the list of projects; the rows being edited are never rebuilt here
  } catch (error) {
    $('#ideas-list').setAttribute('aria-busy', 'false');
    $('#ideas-load-error').hidden = false;
    $('#ideas-load-message').textContent = state.data
      ? 'No se pudieron actualizar las ideas. Se conserva la última lista cargada.'
      : 'No se pudieron cargar las ideas. Reintenta para ver la lista.';
    $('#panel-dot').style.background = '#ff9ca5';
    $('#panel-state').textContent = 'Sin conexión';
    notify(error.message, true);
  }
}

$('#refresh').addEventListener('click', async () => { await refresh(); await refreshGraph(); });
$('#ideas-retry').addEventListener('click', async () => {
  const button = $('#ideas-retry'); button.disabled = true;
  $('#ideas-list').setAttribute('aria-busy', 'true');
  try { await refresh(); } finally { button.disabled = false; }
  if ($('#ideas-load-error').hidden) $('#ideas-status').focus();
});
$('#refresh-graph').addEventListener('click', refreshGraph);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
  state.filter = button.dataset.filter;
  if (state.filter === 'succeeded') $('#history').open = true;
  if (state.data) renderJobs(state.data);
}));
document.querySelectorAll('[data-scroll]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.scroll).scrollIntoView({ behavior: 'smooth' })));
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('active', item === link));
  $('#page-name').textContent = link.textContent.trim().replace(/\d+$/, '').trim();
}));

for (const selector of ['#project-search', '#project-business-filter', '#project-status-filter']) {
  $(selector).addEventListener('input', () => { if (state.data) renderProjects(state.data); });
  $(selector).addEventListener('change', () => { if (state.data) renderProjects(state.data); });
}

$('#show-new-job').addEventListener('click', () => { $('#job-form').hidden = false; $('#job-form').querySelector('select, input, textarea')?.focus(); });
$('#hide-new-job').addEventListener('click', () => { $('#job-form').hidden = true; $('#show-new-job').focus(); });
// The new-job form is shown as a sheet: Escape closes it and focus returns to the button that opened it.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || $('#job-form').hidden || document.querySelector('dialog[open]')) return;
  $('#job-form').hidden = true; $('#show-new-job').focus();
});
$('#job-business').addEventListener('change', () => refreshProjectSelectors(state.data?.projects || []));
$('#idea-business').addEventListener('change', () => refreshProjectSelectors(state.data?.projects || []));
$('#job-kind').addEventListener('change', event => document.querySelectorAll('.workspace-field').forEach(field => { field.hidden = event.target.value !== 'code'; }));
$('#job-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.submitting === 'true') return;
  form.dataset.submitting = 'true';
  const button = form.querySelector('button[type="submit"]'); button.disabled = true;
  try {
  const values = Object.fromEntries(new FormData(form));
  const isolated = true;
  const project = state.data?.projects.find(item => item.id === values.projectId);
  let confirmation;
  if (values.kind === 'code') { confirmation = await confirmDestination(project, values.prompt, values.successCriteria); if (!confirmation) return; }
  const signature = JSON.stringify({ business: state.business, values, confirmation, launch: jobLaunchChoice() });
  const operationId = stableOperation('submissions', signature);
  const payload = { operationId, confirmation, business: state.business, projectId: values.projectId, projectName: project?.name, kind: values.kind, title: values.title, prompt: confirmation ? confirmation.objective : values.prompt, successCriteria: confirmation ? confirmation.successCriteria : values.successCriteria, provider: 'orca', workspace: values.workspace, isolated, ...(jobLaunchChoice() ? { launch: jobLaunchChoice() } : {}) };
  const accepted = confirmation || await confirmIdeaAction('Enviar solicitud al coordinador', `${businessNames[state.business]} · ${values.title}. Se guarda una solicitud para que el coordinador decida entre análisis o desarrollo. Todavía no se crea un trabajo ni se inicia un agente.`, 'Enviar al coordinador');
  if (!accepted) return;
  try {
    const request = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    form.reset(); form.hidden = true;
    delete form.dataset.operationId;
    void refreshJobLaunch();
    notify(request.message || 'Solicitud enviada al coordinador; todavía no hay job ni dispatch.');
    await refresh();
  } catch (error) { notify(`${error.message} Consulta la solicitud del coordinador antes de repetir; se conserva el identificador.`, true); }
  } finally { form.dataset.submitting = 'false'; button.disabled = false; }
});

function ideaCheckoutHint() {
  const project = state.data?.projects.find(item => item.id === $('#idea-project').value);
  const valid = state.data?.checkouts?.some(item => item.value === project?.checkout && item.valid);
  $('#idea-checkout').textContent = valid ? `${project.checkout} · Rama: ${project.branch || 'pendiente de confirmar'}` : 'Sin destino de desarrollo comprobado; puedes guardar la idea';
}
$('#idea-project').addEventListener('change', ideaCheckoutHint);

async function captureIdea(sendToCoordinator) {
  const form = $('#idea-form');
  if (state.ideaBusy || !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  values.tags = tagsFrom(values.tags);
  const business = state.business;
  const signature = JSON.stringify({ business, values });
  if (state.ideaOperation?.signature !== signature) state.ideaOperation = { signature, id: stableOperation('idea-captures', signature) };
  const operation = state.ideaOperation;
  state.ideaBusy = true;
  const fields = [...form.querySelectorAll('input, select, textarea')];
  fields.forEach(field => { field.disabled = true; });
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  $('#idea-send-status').textContent = 'Guardando idea…';
  try {
    const save = () => api('/api/ideas', { method: 'POST', body: JSON.stringify({ ...values, business, operationId: operation.id }) });
    let idea = await save();
    if (['trash', 'archived'].includes(idea.status)) {
      operation.id = stableOperation('idea-captures', signature, operation.id);
      idea = await save();
    }
    $('#idea-send-status').textContent = idea.notePath ? 'Guardada en Obsidian y localmente' : 'Guardada localmente';
    if (sendToCoordinator) {
      $('#idea-send-status').textContent += ' · Avisando al coordinador…';
      const result = await api(`/api/ideas/${encodeURIComponent(idea.id)}/coordinator`, { method: 'POST', body: '{}' });
      $('#idea-send-status').textContent = result.message;
    } else notify(idea.notePath ? 'Idea guardada en Obsidian y localmente.' : 'Idea guardada localmente; Obsidian pendiente.');
    form.reset(); applyBusinessContext(); state.ideaOperation = null;
    await refresh(); await refreshGraph();
  } catch (error) { notify(error.message, true); $('#idea-send-status').textContent = 'No se confirmó el envío. Se conservan texto y operación para reintentar sin duplicar.'; }
  finally { state.ideaBusy = false; buttons.forEach(button => { button.disabled = false; }); fields.forEach(field => { field.disabled = false; }); applyBusinessContext(); }
}
$('#idea-form').addEventListener('submit', event => { event.preventDefault(); void captureIdea(true); });
$('#save-idea-only').addEventListener('click', () => { void captureIdea(null); });

$('#project-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ ...values, business: state.business }) });
    form.reset();
    notify(`Proyecto «${project.name}» creado.`);
    await refresh();
  } catch (error) { notify(error.message, true); }
});

$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ vaultPath: values.vaultPath, autoRun: false }) });
    notify('Bóveda conectada. Los próximos resultados se guardarán automáticamente.');
    await refresh(); await refreshGraph();
  } catch (error) { notify(error.message, true); }
});

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  const section = document.querySelector(link.getAttribute('href'));
  if (section?.id === 'conocimiento' && !state.graph) void refreshGraph();
}));

void refresh();
showSection();
setInterval(refresh, 8000);

function scopeData(raw) {
  const scoped = { ...raw, executor: raw.executor?.byBusiness?.[state.business] ?? raw.executor };
  for (const key of ['jobs', 'projects', 'ideas', 'questions']) scoped[key] = (raw[key] || []).filter(item => item.business === state.business && !(key === 'questions' && item.status === 'withdrawn'));
  scoped.coordinatorRequests = (raw.coordinatorRequests || []).filter(item => item.business === state.business);
  scoped.requestTraces = (raw.requestTraces || []).filter(item => item.business === state.business);
  for (const key of ['domains', 'tasks', 'messages']) scoped[key] = state.business === 'agency' ? (raw[key] || []).filter(item => !item.business || item.business === 'agency') : [];
  const counts = Object.fromEntries(['queued', 'running', 'retry_wait', 'needs_attention', 'succeeded', 'cancelled'].map(status => [status, scoped.jobs.filter(job => job.state === status).length]));
  scoped.queue = { jobs: scoped.jobs, counts, active: scoped.jobs.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length };
  scoped.exportedCount = scoped.jobs.filter(job => job.state === 'succeeded').length;
  return scoped;
}
function applyBusinessContext() {
  const title = state.business === 'agency' ? 'Agencia digital' : 'Videojuegos';
  $('#business-context').value = state.business;
  $('#business-name').textContent = title; $('#context-title').textContent = title;
  for (const selector of ['#job-business', '#idea-business', '#project-create-form select[name="business"]']) { $(selector).value = state.business; $(selector).disabled = true; }
  $('#project-business-filter').value = state.business; $('#project-business-filter').hidden = true;
  document.querySelector('.telegram-inbox').hidden = true; // Unclassified messages remain outside either business context.
  document.querySelector('.status-grid').hidden = true; // Action cards carry scoped counts without repeating integration notices.
}
function showSection() {
  const [id = 'inicio', runId] = (location.hash.slice(1) || 'inicio').split('/');
  if (id === 'trabajo') { state.runId = decodeURIComponent(runId || ''); if (state.data) renderRun(state.data); }
  const selected = ['inicio', 'trabajo', 'atencion', 'historial', 'peticiones', 'proyectos', 'trabajos', 'ideas', 'conocimiento', 'dominios', 'ajustes'].includes(id) ? id : 'inicio';
  if (state.visibleSection === selected) return;
  state.visibleSection = selected;
  const navSection = selected === 'trabajo' ? 'trabajos' : selected;
  document.querySelectorAll('.page-section').forEach(section => { section.hidden = section.id !== selected; });
  document.querySelectorAll('.nav-link').forEach(link => { const active = link.hash === `#${navSection}`; link.classList.toggle('active', active); if (active) { link.setAttribute('aria-current', 'page'); $('#page-name').textContent = link.textContent.trim().replace(/\d+$/, '').trim(); } else link.removeAttribute('aria-current'); });
  const nav = $('.nav'), current = nav.querySelector('[aria-current="page"]');
  if (current && nav.scrollWidth > nav.clientWidth) {
    const strip = nav.getBoundingClientRect(), link = current.getBoundingClientRect();
    if (link.left < strip.left) nav.scrollLeft += link.left - strip.left;
    if (link.right > strip.right) nav.scrollLeft += link.right - strip.right;
  }
  if (selected === 'conocimiento') void refreshGraph();
  if (selected === 'ajustes') { void loadPipeline(); void loadQuota(); void loadTeam(); }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function updateHistoryProjects(projects) {
  const select = $('#history-project'), value = select.value;
  const signature = JSON.stringify(projects.map(project => [project.id, project.name]));
  if (select.dataset.signature === signature || document.activeElement === select) return;
  select.dataset.signature = signature;
  select.replaceChildren(new Option('Todos', ''));
  for (const project of projects) select.add(new Option(project.name, project.id));
  if ([...select.options].some(option => option.value === value)) select.value = value;
}
const overviewStatusLabels = { done: 'Completadas', active: 'En curso', attention: 'Revisión', pending: 'Pendientes' };

function overviewTone(status) {
  if (['published', 'delivered', 'answered', 'succeeded', 'completed', 'merged', 'cancelled'].includes(status)) return 'done';
  if (['blocked', 'failed', 'needs_attention', 'waiting_user', 'unavailable'].includes(status)) return 'attention';
  return ['running', 'preparing'].includes(status) ? 'active' : 'pending';
}

function overviewLegend(counts, labels = overviewStatusLabels) {
  const list = el('ul', 'overview-legend');
  for (const [tone, label] of Object.entries(labels)) {
    const item = el('li', '', label);
    item.dataset.tone = tone;
    if (counts) item.append(el('strong', '', String(counts[tone])));
    list.append(item);
  }
  return list;
}

function renderOverviewCharts(traces) {
  const activity = $('#overview-activity');
  const stages = new Map();
  const requestCounts = { done: 0, active: 0, attention: 0, pending: 0 };
  for (const trace of traces) {
    requestCounts[overviewTone(trace.status)]++;
    for (const step of trace.steps || []) {
      if (step.status === 'skipped' || !step.label) continue;
      if (!stages.has(step.label)) stages.set(step.label, { done: 0, active: 0, attention: 0, pending: 0 });
      stages.get(step.label)[overviewTone(step.status)]++;
    }
  }
  activity.replaceChildren();
  if (!stages.size) {
    activity.append(el('p', 'overview-empty', 'Las etapas aparecerán aquí cuando se registren peticiones.'));
  } else {
    const total = counts => Object.values(counts).reduce((sum, count) => sum + count, 0);
    const scale = Math.max(...Array.from(stages.values(), total));
    const chart = el('ul', 'overview-bars');
    for (const [label, counts] of stages) {
      const row = el('li', 'overview-bar-row');
      const bar = el('div', 'overview-bar-track');
      bar.setAttribute('aria-hidden', 'true');
      for (const [tone, count] of Object.entries(counts)) {
        if (!count) continue;
        const segment = el('span', 'overview-bar-segment');
        segment.dataset.tone = tone;
        segment.style.width = `${100 * count / scale}%`;
        bar.append(segment);
      }
      const description = Object.entries(counts).filter(([, count]) => count).map(([tone, count]) => `${overviewStatusLabels[tone]}: ${count}`).join(', ');
      row.title = description;
      row.append(el('span', 'overview-stage-label', label), bar, el('b', 'overview-stage-total', String(total(counts))), el('span', 'overview-visually-hidden', description));
      chart.append(row);
    }
    activity.append(overviewLegend(), chart);
  }

  const totals = el('p', 'overview-total', `${traces.length} ${traces.length === 1 ? 'petición' : 'peticiones'} en este negocio`);
  $('#overview-status').replaceChildren(totals, overviewLegend(requestCounts, { ...overviewStatusLabels, done: 'Cerradas' }));
}

// Overview side rail, as in the mockup: each project with its stage, next action and active job, then the
// latest events across requests. Only what /api/state already carries.
function renderOverviewRail(data, traces) {
  const projects = $('#overview-projects'); projects.replaceChildren();
  const list = (data.projects || []).filter(project => project.status !== 'completed').slice(0, 6);
  if (!list.length) projects.append(el('p', 'rail-empty', 'Sin proyectos en este negocio todavía.'));
  for (const project of list) {
    const card = el('a', 'rail-project'); card.href = '#proyectos';
    const head = el('span', 'rail-project-head');
    head.append(el('span', 'rail-mono', (project.name || '?').trim().charAt(0).toUpperCase()), el('b', '', project.name));
    if (project.stage) head.append(el('span', 'rail-stage', project.stage));
    card.append(head);
    const active = data.jobs.find(job => job.projectId === project.id && ['running', 'needs_attention'].includes(job.state));
    card.append(el('span', 'rail-line', active ? `#${active.id} · ${statusNames[active.state]}` : 'Sin trabajos activos'));
    if (project.nextAction) card.append(el('span', 'rail-next', `Siguiente: ${project.nextAction}`));
    const checkout = (data.checkouts || []).find(item => item.projectId === project.id);
    const source = el('span', 'rail-source');
    const mark = el('span', `pv pv-${project.checkout || checkout ? 'observed' : 'unknown'}`); mark.setAttribute('aria-hidden', 'true');
    source.append(mark, project.checkout || checkout ? 'Checkout configurado' : 'Sin checkout');
    card.append(source);
    projects.append(card);
  }
  const feed = $('#overview-feed'); feed.replaceChildren();
  const events = traces.flatMap(trace => (trace.events || []).map(event => ({ ...event, title: trace.title }))).filter(event => event.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
  if (!events.length) feed.append(el('li', 'rail-empty', 'La actividad aparecerá aquí.'));
  for (const event of events) {
    const li = el('li', '');
    li.append(el('span', 'feed-text', `${event.label || event.kind || 'Evento'} · ${event.title || ''}`), timeNode(event.at, 'feed-time'));
    feed.append(li);
  }
}

function renderActionSummary(raw, data) {
  const traces = data.requestTraces.filter(trace => trace.status !== 'withdrawn');
  renderOverviewCharts(traces);
  renderOverviewRail(data, traces);
  const metrics = $('#overview-metrics'); metrics.replaceChildren();
  const groups = [
    ['Requiere tu acción', [...data.jobs.filter(job => job.state === 'needs_attention').map(job => ({ title: job.title, reason: job.error?.message || 'Revisa la etapa y sus informes antes de continuar.', job, kind: 'attention' })), ...data.questions.filter(q => q.status === 'pending').map(q => ({ title: q.question, reason: 'Decisión pendiente', href: '#ideas', kind: 'question' }))]],
    ['En curso', data.jobs.filter(job => job.state === 'running').map(job => ({ title: job.title, reason: `Etapa: ${job.workflow?.steps?.find(step => step.key === job.workflow?.currentStage)?.label || job.workflow?.currentStage || 'sin confirmar'}`, job, kind: 'running' }))],
    ['Siguiente paso', [...data.jobs.filter(job => ['queued', 'retry_wait'].includes(job.state)).map(job => ({ title: job.title, reason: data.automation?.receipts?.find(item => item.jobId === job.id)?.reason || (job.autoIntent?.eligible ? `Cola automática · ${raw.automation?.businesses?.[job.business] ? 'esperando al ejecutor' : 'empresa pausada'}` : 'Cola manual · despacho por ID pendiente'), job, kind: 'next' })), ...data.projects.filter(project => project.nextAction).map(project => ({ title: project.name, reason: project.nextAction, href: '#proyectos', kind: 'project' }))]],
  ];
  const locations = ['attention', 'running', 'next'];
  // The summary is one sentence of real counts, not a row of tiles.
  const metricValues = [
    ['running', 'en curso', groups[1][1].length],
    ['pending', 'en cola', data.queue.counts.queued + data.queue.counts.retry_wait],
    ['attention', 'requieren tu acción', groups[0][1].length],
    ['total', traces.length === 1 ? 'petición registrada' : 'peticiones registradas', traces.length],
  ];
  for (const [tone, label, value] of metricValues) {
    const metric = el('span', 'overview-metric');
    metric.dataset.tone = tone;
    metric.append(el('strong', 'overview-metric-value', String(value)), ' ', el('span', 'overview-metric-label', label));
    metrics.append(metric);
  }
  const emptyText = { attention: 'Nada te espera ahora mismo.', running: 'Sin trabajos en marcha.', next: 'Captura una idea o define el siguiente paso de un proyecto.' };
  for (const [index, [title, items]] of groups.entries()) {
    const tone = locations[index];
    const section = el('section', 'action-group overview-list');
    section.dataset.tone = tone;
    const heading = el('h2', 'action-heading', title);
    heading.append(' ', el('span', 'action-count', String(items.length)));
    section.append(heading);
    if (!items.length) section.append(el('p', 'section-copy overview-empty-line', emptyText[tone]));
    for (const item of items) {
      const row = el('button', `overview-row is-${item.kind}`);
      row.type = 'button';
      const text = el('span', 'overview-row-text');
      text.append(el('span', 'overview-row-title', item.title), el('span', 'overview-row-reason', item.reason));
      const mark = el('span', 'overview-row-mark');
      mark.setAttribute('aria-hidden', 'true');
      row.append(mark, text);
      if (item.job) {
        const track = stageTrack(item.job);
        if (track) row.append(track);
        const when = item.job.finishedAt || item.job.startedAt || item.job.createdAt;
        if (when) row.append(timeNode(when));
      }
      row.onclick = () => item.job ? openRun(item.job.id) : (location.hash = item.href);
      section.append(row);
    }
    $('#overview-' + tone).replaceChildren(section);
  }
  const recent = $('#overview-recent');
  recent.replaceChildren();
  if (!traces.length) recent.append(el('p', 'section-copy overview-empty-line', 'Las peticiones de este negocio aparecerán aquí.'));
  else {
    const list = el('ul', 'overview-requests');
    for (const trace of traces.slice(0, 5)) {
      const item = el('li', 'overview-request');
      const title = trace.title || 'Petición';
      const context = trace.projectName || (trace.intent === 'consultation' ? 'Consulta general' : 'Sin proyecto');
      const text = el('span', 'overview-row-text');
      text.append(el('strong', 'overview-row-title', title), el('span', 'overview-row-reason', context !== title ? context : ''));
      const status = overviewTone(trace.status);
      item.append(text, el('span', `request-state is-${status === 'pending' ? 'active' : status}`, trace.statusLabel || 'Pendiente'), timeNode(trace.events?.at(-1)?.at));
      list.append(item);
    }
    recent.append(list);
  }
  const blockers = $('#global-blockers'); blockers.replaceChildren();
  for (const business of ['agency', 'games']) {
    const jobs = raw.jobs.filter(job => job.business === business && job.state === 'needs_attention');
    if (!jobs.length) continue;
    const banner = el('div', 'blocker-banner');
    banner.append(el('b', '', `${jobs.length} bloqueo${jobs.length === 1 ? '' : 's'} de cola · ${businessNames[business]}`));
    for (const job of jobs) {
      const item = el('div', 'blocker-item');
      item.append(el('p', '', `#${job.id} · ${job.title}`), el('p', '', job.error?.message || 'Motivo pendiente de revisar en el informe de etapa.'));
      const button = el('button', 'button secondary', 'Abrir en Trabajos y revisar'); button.type = 'button';
      button.onclick = async () => { state.business = business; saveBusiness(); await refresh(); state.filter = 'needs_attention'; focusJob(job.id); };
      item.append(button); banner.append(item);
    }
    blockers.append(banner);
  }
  if (raw.executor?.byBusiness) {
    for (const [business, executor] of Object.entries(raw.executor.byBusiness)) {
      if (!executor.available && executor.reason && !raw.jobs.some(job => job.business === business && job.state === 'running')) {
        blockers.append(el('p', 'blocker-banner', `${businessNames[business]} · ${executor.reason}`));
      }
    }
  } else if (!raw.executor?.available && raw.executor?.reason) {
    blockers.append(el('p', 'blocker-banner', raw.executor.reason));
  }
}
function saveBusiness() { try { localStorage.setItem('operations-business', state.business); } catch {} }
$('#business-context').addEventListener('change', async event => {
  state.business = event.target.value; state.highlightJob = null; state.filter = 'all'; state.graph = null; saveBusiness();
  window.RequestsView?.render(state.raw ? scopeData(state.raw) : { requestTraces: [], projects: [], questions: [] }, state.business);
  $('#graph').replaceChildren(el('div', 'empty-graph', 'Cargando conocimiento de este negocio…'));
  for (const form of ['#job-form', '#idea-form', '#project-create-form']) $(form).reset();
  state.ideaOperation = null; await refresh(); if (location.hash === '#conocimiento') await refreshGraph();
});
window.addEventListener('hashchange', showSection);
for (const id of ['history-search', 'history-project', 'history-state', 'history-stage', 'history-date']) $(`#${id}`).addEventListener('input', () => { if (state.data) renderJobs(state.data); });
function confirmDestination(project, objective = '', successCriteria = '') {
  const observed = state.data?.checkouts.find(item => item.value === project?.checkout);
  if (!project?.baseBranch) { notify('Configura y guarda una rama base GitHub existente en el proyecto antes de enviar a desarrollo.', true); return Promise.resolve(null); }
  if (!project || !observed?.valid || !project.branch || observed.branch !== project.branch) { notify('Configura y comprueba checkout y rama del proyecto antes de enviar a desarrollo.', true); return Promise.resolve(null); }
  const dialog = $('#destination-dialog'), form = $('#destination-form');
  trapDialog(dialog);
  $('#destination-context').textContent = `${businessNames[project.business]} · ${project.name}\nCheckout: ${project.checkout}\nRepositorio GitHub: ${project.repository || 'pendiente de configurar; inicio automático bloqueado'}\nRama fuente comprobada: ${observed.branch}\nRama base: ${project.baseBranch || 'pendiente de configurar; integración bloqueada'}\n${state.raw?.automation?.businesses?.[project.business] ? 'La solicitud va primero al coordinador; aun no se crea un trabajo.' : 'El coordinador decide la ruta antes de crear un trabajo.'}`;
  form.elements.objective.value = objective; form.elements.successCriteria.value = successCriteria;
  return new Promise(resolve => {
    let value = null;
    const finish = () => { form.removeEventListener('submit', submit); resolve(value); };
    const submit = event => { event.preventDefault(); value = { projectId: project.id, checkout: project.checkout, branch: project.branch, baseBranch: project.baseBranch || '', objective: form.elements.objective.value.trim(), successCriteria: form.elements.successCriteria.value.trim() }; dialog.close(); };
    form.addEventListener('submit', submit); dialog.addEventListener('close', finish, { once: true });
    $('#cancel-destination').onclick = () => dialog.close(); dialog.showModal(); $('#cancel-destination').focus();
  });
}

for (const key of ['project', 'focus', 'tag', 'status', 'order']) $(`#ideas-${key}`).addEventListener('change', event => {
  const prefs = ideaPreferences(); prefs[key] = event.target.value;
  saveIdeaPreferences(prefs);
  event.target.blur(); if (state.data) renderIdeas(state.data); event.target.focus();
});
$('#ideas-reset').addEventListener('click', () => { saveIdeaPreferences(IdeaView.defaults()); $('#ideas-count').focus(); if (state.data) renderIdeas(state.data); });


// ---- Reparto del pipeline: agente, modelo y esfuerzo por etapa (docs/PIPELINE_CONFIG.md) ----
// Neither form is rebuilt by the periodic refresh: typed values, focus and open selects survive it.
function scopeRoles(draft, scope, create = false) {
  if (scope === 'general') return draft.general.roles;
  const [kind, id] = scope.split(':'), holder = kind === 'empresa' ? draft.empresas : draft.proyectos;
  if (!holder[id] && create) holder[id] = { roles: {} };
  return holder[id]?.roles || {};
}
function pruneDraft(draft) {
  for (const holder of [draft.empresas, draft.proyectos]) for (const id of Object.keys(holder)) if (!Object.keys(holder[id].roles).length) delete holder[id];
  return draft;
}
// One row per role: agent, level or model/effort. An empty control means "inherit from the less specific scope".
function launchRow(role, entry, { idPrefix, inheritText, onChange, levels }) {
  const row = el('fieldset', 'pipeline-row'); row.dataset.role = role;
  row.append(el('legend', '', roleLabels[role]));
  const field = (label, node) => { const wrapper = el('label', '', label); node.id = `${idPrefix}-${role}-${node.dataset.field}`; wrapper.htmlFor = node.id; wrapper.append(node); return wrapper; };
  const agent = el('select'); agent.dataset.field = 'agent';
  for (const [value, text] of [['', inheritText], ['codex', 'Codex'], ['claude', 'Claude']]) agent.add(new Option(text, value));
  agent.value = entry?.agent || '';
  const model = el('input'); model.dataset.field = 'model'; model.maxLength = 100; model.placeholder = 'Heredado'; model.autocomplete = 'off'; model.spellcheck = false; model.value = entry?.model || '';
  const effort = el('input'); effort.dataset.field = 'effort'; effort.maxLength = 100; effort.placeholder = 'Heredado'; effort.autocomplete = 'off'; effort.spellcheck = false; effort.setAttribute('list', 'pipeline-efforts'); effort.value = entry?.effort || '';
  row.append(field('Agente', agent));
  let level;
  if (levels) {
    level = el('select'); level.dataset.field = 'level';
    for (const [value, text] of [['', 'Sin nivel'], ...levels.map(name => [name, name])]) level.add(new Option(text, value));
    level.value = entry?.level || '';
    row.append(field('Nivel', level));
  }
  row.append(field('Modelo', model), field('Esfuerzo', effort));
  const note = el('p', 'pipeline-row-note'); note.dataset.note = role; row.append(note);
  const sync = () => { if (level) { model.disabled = effort.disabled = Boolean(level.value); if (level.value) { model.value = ''; effort.value = ''; } } };
  sync();
  for (const control of [agent, level, model, effort].filter(Boolean)) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => { sync(); onChange(); });
  return row;
}
function readRow(row) {
  const value = field => row.querySelector(`[data-field="${field}"]`)?.value.trim() || '';
  const entry = {};
  for (const field of ['agent', 'level', 'model', 'effort']) if (value(field)) entry[field] = value(field);
  return entry;
}
function renderPipelineScope() {
  const scope = $('#pipeline-scope').value || 'general';
  const roles = scopeRoles(pipelineState.draft, scope);
  $('#pipeline-rows').replaceChildren(...pipelineState.server.roles.map(role => launchRow(role, roles[role], { idPrefix: 'pipeline', inheritText: 'Heredar', levels: pipelineState.server.levelNames, onChange: collectPipelineScope })));
  $('#pipeline-scope-hint').textContent = scope === 'general' ? 'General: base para las dos empresas. Sin elegir agente, la etapa usa el agente por defecto de esta instalación (' + pipelineState.server.defaultAgent + ').'
    : scope.startsWith('empresa:') ? 'Empresa: concreta el reparto general solo en los campos que rellenes.' : 'Proyecto: concreta el reparto de su empresa solo en los campos que rellenes.';
}
function collectPipelineScope() {
  const scope = $('#pipeline-scope').dataset.current || 'general';
  const roles = scopeRoles(pipelineState.draft, scope, true);
  for (const row of $('#pipeline-rows').querySelectorAll('.pipeline-row')) {
    const entry = readRow(row);
    if (Object.keys(entry).length) roles[row.dataset.role] = entry; else delete roles[row.dataset.role];
  }
  pruneDraft(pipelineState.draft);
  setPipelineDirty(JSON.stringify(pipelineState.draft) !== JSON.stringify(cloneDraft(pipelineState.server.pipeline)));
}
function setPipelineDirty(dirty) {
  pipelineState.dirty = dirty;
  $('#pipeline-dirty').textContent = dirty ? 'Cambios sin guardar' : 'Sin cambios';
  $('#pipeline-save').disabled = !dirty;
}
function renderPipelineScopes() {
  const select = $('#pipeline-scope'), current = select.dataset.current || 'general';
  const projects = (state.raw?.projects || []).filter(project => project.status !== 'completed');
  const known = new Set(projects.map(project => project.id));
  const options = [['general', 'General'], ['empresa:agency', 'Empresa · Agencia'], ['empresa:games', 'Empresa · Videojuegos'],
    ...projects.map(project => [`proyecto:${project.id}`, `Proyecto · ${project.name} (${businessNames[project.business] || project.business})`]),
    ...Object.keys(pipelineState.draft.proyectos).filter(id => !known.has(id)).map(id => [`proyecto:${id}`, `Proyecto · ${id}`])];
  const signature = JSON.stringify(options);
  if (select.dataset.options === signature) return; // unchanged: leave an open dropdown alone
  select.dataset.options = signature;
  select.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
  select.value = options.some(([value]) => value === current) ? current : 'general';
  select.dataset.current = select.value;
}
async function renderPipelineEffective() {
  const grid = $('#pipeline-effective'), scope = $('#pipeline-scope').dataset.current || 'general';
  const projectId = scope.startsWith('proyecto:') ? scope.slice(9) : '';
  const project = (state.raw?.projects || []).find(item => item.id === projectId);
  const targets = project ? [[project.business, projectId, `${project.name}`]] : [['agency', '', 'Agencia'], ['games', '', 'Videojuegos']];
  const blocks = [];
  for (const [business, id, title] of targets) {
    const block = el('div', 'pipeline-effective-block'); block.append(el('h4', '', title));
    const list = el('dl', 'pipeline-effective-list');
    for (const kind of ['analysis', 'code']) {
      try {
        const preview = await api(`/api/launch-preview?business=${business}&kind=${kind}${id ? `&projectId=${encodeURIComponent(id)}` : ''}`);
        for (const stage of preview.stages) list.append(el('dt', '', stage.label), el('dd', '', `${launchLabel(stage)} (${sourceLabels[stage.source] || stage.source})`));
      } catch (error) { list.append(el('dt', '', kind === 'code' ? 'Código' : 'Análisis'), el('dd', 'pipeline-error', error.message)); }
    }
    list.append(el('dt', '', 'Integración'), el('dd', '', 'Motor del Centro (GitHub), sin modelo'));
    block.append(list); blocks.push(block);
  }
  grid.replaceChildren(...blocks);
}
function renderPipelineEscalations() {
  const escalations = Object.entries(pipelineState.draft.escaladas);
  $('#pipeline-escalations').replaceChildren(...(escalations.length ? escalations.map(([id, item]) => el('li', '', `${id}: ${launchLabel(item)} · roles ${item.roles.map(role => roleLabels[role]).join(', ')}${item.uso ? ` · ${item.uso}` : ''}`)) : [el('li', '', 'Ninguna definida.')]));
}
function renderPipeline(server) {
  pipelineState.server = server;
  pipelineState.draft = cloneDraft(server.pipeline);
  const status = $('#pipeline-status');
  status.classList.toggle('pipeline-error', Boolean(server.error));
  status.textContent = server.error ? `El archivo guardado no es válido y no se aplica: ${server.error} Corrígelo aquí y guarda, o edita data/pipeline.json.`
    : server.configured ? 'Perfil por etapas activo en esta instalación.' : `Sin perfil por etapas: todas las etapas se lanzan con ${server.defaultAgent} y los niveles por rol, como hasta ahora. Carga el ejemplo o rellena un ámbito y guarda para activarlo.`;
  $('#pipeline-disable').hidden = !server.configured;
  renderPipelineScopes(); renderPipelineScope(); setPipelineDirty(false);
  renderPipelineEscalations();
  void renderPipelineEffective();
}
function loadPipeline(force = false) {
  if (pipelineState.dirty && !force) return pipelineState.loading || Promise.resolve();
  if (pipelineState.server && !force) { renderPipelineScopes(); return Promise.resolve(); }
  pipelineState.loading ||= api('/api/pipeline').then(renderPipeline)
    .catch(error => { $('#pipeline-status').textContent = `No se pudo cargar el reparto: ${error.message}`; $('#pipeline-status').classList.add('pipeline-error'); })
    .finally(() => { pipelineState.loading = null; });
  return pipelineState.loading;
}
$('#pipeline-scope').addEventListener('change', event => { event.target.dataset.current = event.target.value; renderPipelineScope(); void renderPipelineEffective(); });
$('#pipeline-reload').addEventListener('click', async () => {
  if (pipelineState.dirty && !await confirmIdeaAction('Descartar cambios sin guardar', 'Se recargará el reparto guardado y se perderán los cambios de este formulario.', 'Descartar y recargar')) return;
  await loadPipeline(true);
});
$('#pipeline-load-example').addEventListener('click', () => {
  if (!pipelineState.server) return;
  const example = pipelineState.server.example;
  pipelineState.draft = cloneDraft({ general: example.general, empresas: example.empresas || {}, proyectos: { ...pipelineState.draft.proyectos }, escaladas: example.escaladas || {} });
  renderPipelineScope(); renderPipelineEscalations(); setPipelineDirty(true);
  notify('Perfil mixto cargado en el formulario. No se aplica hasta que pulses Guardar reparto.');
});
$('#pipeline-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pipelineState.dirty) return;
  const button = $('#pipeline-save'); button.disabled = true;
  try {
    const scope = $('#pipeline-scope').dataset.current;
    renderPipeline(await api('/api/pipeline', { method: 'POST', body: JSON.stringify({ pipeline: pipelineState.draft }) }));
    $('#pipeline-scope').dataset.current = scope; renderPipelineScopes(); renderPipelineScope();
    notify('Reparto guardado. Se aplica a las etapas que aún no se han lanzado.');
    void refreshJobLaunch();
  } catch (error) {
    $('#pipeline-status').textContent = `No se guardó: ${error.message}`; $('#pipeline-status').classList.add('pipeline-error');
    notify(error.message, true); button.disabled = false;
  }
});
$('#pipeline-disable').addEventListener('click', async () => {
  if (!await confirmIdeaAction('Volver al agente único', 'Se aparta data/pipeline.json (queda una copia) y todas las etapas nuevas vuelven a lanzarse con el agente por defecto. Las etapas ya lanzadas no cambian.', 'Volver al agente único')) return;
  try { renderPipeline(await api('/api/pipeline', { method: 'POST', body: JSON.stringify({ disable: true, confirm: true }) })); notify('Perfil por etapas desactivado.'); void refreshJobLaunch(); }
  catch (error) { notify(error.message, true); }
});
window.addEventListener('beforeunload', event => { if (pipelineState.dirty) event.preventDefault(); });

// Nuevo trabajo: preview of the split and optional per-job choices.
function jobLaunchChoice() {
  const roles = {};
  for (const row of $('#job-launch-rows').querySelectorAll('.pipeline-row')) {
    const entry = readRow(row);
    // A model belongs to one provider: without an explicit agent it is bound to the one the stage would use.
    if (entry.model && !entry.agent) entry.agent = jobLaunchState.preview?.[row.dataset.role]?.agent;
    if (Object.keys(entry).length) roles[row.dataset.role] = entry;
  }
  return Object.keys(roles).length ? { roles } : null;
}
async function refreshJobLaunch() {
  if ($('#job-form').hidden || !$('#job-launch').open) return; // the preview is only requested when someone opens it
  const rows = $('#job-launch-rows');
  if (!rows.children.length) rows.replaceChildren(...Object.keys(roleLabels).map(role => launchRow(role, null, { idPrefix: 'job-launch', inheritText: 'Según el perfil', onChange: () => void refreshJobLaunch() })));
  const launch = jobLaunchChoice(), projectId = $('#job-project').value, request = ++jobLaunchState.request;
  $('#job-launch-summary').textContent = launch ? `${Object.keys(launch.roles).length} etapa(s) fijadas para este encargo` : 'según el perfil';
  const stages = {};
  let failure = '';
  for (const kind of ['analysis', 'code']) {
    try {
      const preview = await api(`/api/launch-preview?business=${state.business}&kind=${kind}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}${launch ? `&launch=${encodeURIComponent(JSON.stringify(launch))}` : ''}`);
      for (const stage of preview.stages) stages[stage.role] = stage;
    } catch (error) { failure = error.message; }
  }
  if (request !== jobLaunchState.request) return;
  jobLaunchState.preview = stages;
  for (const row of rows.querySelectorAll('.pipeline-row')) {
    const stage = stages[row.dataset.role], note = row.querySelector('.pipeline-row-note');
    note.classList.toggle('pipeline-error', !stage);
    note.textContent = stage ? `Se lanzaría con ${launchLabel(stage)} (${sourceLabels[stage.source] || stage.source})${row.dataset.role === 'planificador' ? ' · solo si la ruta es análisis' : ''}` : failure || 'Sin vista previa.';
  }
}
$('#job-project').addEventListener('change', () => void refreshJobLaunch());
$('#job-launch').addEventListener('toggle', () => void refreshJobLaunch());
$('#job-form').addEventListener('reset', () => setTimeout(() => void refreshJobLaunch(), 0));


// ---- Cuota y suscripciones (docs/CUOTA.md). Like the split form, it is never rebuilt by the periodic refresh. ----
const quotaStateNames = { disponible: 'Disponible', reserva: 'En la reserva personal', agotada: 'Agotada', incierta: 'Uso no conocido' };
const localDateTime = value => { if (!value) return ''; const date = new Date(value); if (Number.isNaN(date.getTime())) return ''; const pad = number => String(number).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; };
function quotaProviderRow(agent, provider, status) {
  const row = el('fieldset', 'pipeline-row quota-provider'); row.dataset.provider = agent;
  row.append(el('legend', '', agent === 'claude' ? 'Claude' : 'Codex'));
  const field = (label, node, name) => { const wrapper = el('label', '', label); node.id = `quota-${agent}-${name}`; node.dataset.field = name; wrapper.htmlFor = node.id; wrapper.append(node); return wrapper; };
  const auth = el('select'); for (const [value, text] of [['desconocida', 'Sin comprobar'], ['suscripcion', 'Suscripción'], ['api', 'API (coste adicional)']]) auth.add(new Option(text, value));
  auth.value = provider.autenticacion || 'desconocida';
  const used = el('input'); used.type = 'number'; used.min = '0'; used.max = '100'; used.step = '1'; used.inputMode = 'numeric'; used.placeholder = 'Sin anotar';
  const reset = el('input'); reset.type = 'datetime-local'; reset.value = localDateTime(provider.reiniciaEn);
  const exhausted = el('input'); exhausted.type = 'checkbox'; exhausted.checked = status.state === 'agotada';
  const exhaustedLabel = el('label', 'quota-check'); exhausted.id = `quota-${agent}-exhausted`; exhausted.dataset.field = 'exhausted'; exhaustedLabel.htmlFor = exhausted.id; exhaustedLabel.append(exhausted, document.createTextNode(' Ya no acepta trabajo hasta el reinicio'));
  row.append(field('Autenticación en Orca', auth, 'autenticacion'), field('Uso observado ahora (%)', used, 'usadoPorcentaje'), field('Se reinicia', reset, 'reiniciaEn'), exhaustedLabel);
  const note = el('p', 'pipeline-row-note', `${quotaStateNames[status.state] || status.state}. ${status.reason || status.aviso || (status.usadoPorcentaje !== undefined ? `Uso observado ${status.usadoPorcentaje} % el ${formatDate(status.observadoEn)}.` : '')}`);
  note.classList.toggle('pipeline-error', ['reserva', 'agotada'].includes(status.state));
  row.append(note);
  for (const control of [auth, used, reset, exhausted]) control.addEventListener(control.tagName === 'INPUT' && control.type !== 'checkbox' ? 'input' : 'change', () => setQuotaDirty(true));
  return row;
}
function setQuotaDirty(dirty) { quotaState.dirty = dirty; $('#quota-dirty').textContent = dirty ? 'Cambios sin guardar' : 'Sin cambios'; $('#quota-save').disabled = !dirty; }
function renderQuota(server) {
  quotaState.server = server;
  const status = $('#quota-status'), blocked = server.agents.filter(agent => ['reserva', 'agotada'].includes(server.status[agent].state));
  status.classList.toggle('pipeline-error', Boolean(server.error) || blocked.length > 0);
  status.textContent = server.error ? `El archivo guardado no es válido: ${server.error} Mientras tanto no se lanza trabajo.`
    : !server.configured ? 'Sin política de cuota en esta instalación: las etapas se lanzan sin comprobar el uso. Anota la autenticación y el uso de cada proveedor y guarda para activarla.'
    : blocked.length ? `No se lanzan etapas con ${blocked.join(' ni ')}: ${blocked.map(agent => server.status[agent].reason).join(' ')}`
    : `Reserva personal del ${server.quota.reservaPersonalPorcentaje} % activa.`;
  $('#quota-warnings').replaceChildren(...server.warnings.map(text => el('li', '', text)));
  $('#quota-providers').replaceChildren(...server.agents.map(agent => quotaProviderRow(agent, server.quota.proveedores[agent] || {}, server.status[agent])));
  for (const name of ['reservaPersonalPorcentaje', 'avisoPorcentaje', 'caducidadObservacionHoras', 'sinDatos', 'alAgotar']) $('#quota-form').elements[name].value = server.quota[name];
  setQuotaDirty(false);
}
function loadQuota(force = false) {
  if ((quotaState.dirty || quotaState.server) && !force) return Promise.resolve();
  quotaState.loading ||= api('/api/quota').then(renderQuota)
    .catch(error => { $('#quota-status').textContent = `No se pudo cargar la cuota: ${error.message}`; $('#quota-status').classList.add('pipeline-error'); })
    .finally(() => { quotaState.loading = null; });
  return quotaState.loading;
}
for (const control of $('#quota-form').querySelectorAll('.quota-policy input, .quota-policy select')) control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => setQuotaDirty(true));
$('#quota-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!quotaState.dirty || !quotaState.server) return;
  const form = event.currentTarget, button = $('#quota-save'); button.disabled = true;
  try {
    const number = name => Number(form.elements[name].value);
    const substitute = form.elements.alAgotar.value === 'sustituir';
    let server = await api('/api/quota', { method: 'POST', body: JSON.stringify({ policy: { reservaPersonalPorcentaje: number('reservaPersonalPorcentaje'), avisoPorcentaje: number('avisoPorcentaje'),
      caducidadObservacionHoras: number('caducidadObservacionHoras'), sinDatos: form.elements.sinDatos.value, alAgotar: form.elements.alAgotar.value, sustituciones: substitute ? { claude: 'codex', codex: 'claude' } : {} } }) });
    for (const row of $('#quota-providers').querySelectorAll('.quota-provider')) {
      const value = name => row.querySelector(`[data-field="${name}"]`).value, agent = row.dataset.provider, before = quotaState.server.quota.proveedores[agent] || {};
      const reset = value('reiniciaEn') ? new Date(value('reiniciaEn')).toISOString() : '';
      const exhausted = row.querySelector('[data-field="exhausted"]').checked;
      if (exhausted && !reset) throw new Error(`Para marcar ${agent} como agotado, indica cuándo se reinicia.`);
      const observation = { provider: agent, autenticacion: value('autenticacion'), reiniciaEn: reset,
        ...(value('usadoPorcentaje') !== '' ? { usadoPorcentaje: Number(value('usadoPorcentaje')) } : {}),
        ...(exhausted ? { agotadaHasta: reset } : quotaState.server.status[agent].state === 'agotada' ? { agotadaHasta: '' } : {}) };
      const changed = observation.autenticacion !== (before.autenticacion || 'desconocida') || reset !== (before.reiniciaEn ? new Date(before.reiniciaEn).toISOString() : '') || 'usadoPorcentaje' in observation || 'agotadaHasta' in observation;
      if (changed) server = await api('/api/quota', { method: 'POST', body: JSON.stringify({ observation }) });
    }
    renderQuota(server);
    notify('Cuota guardada. Se aplica a las etapas que aún no se han lanzado.');
  } catch (error) { $('#quota-status').textContent = `No se guardó: ${error.message}`; $('#quota-status').classList.add('pipeline-error'); notify(error.message, true); button.disabled = false; }
});
window.addEventListener('beforeunload', event => { if (quotaState.dirty) event.preventDefault(); });


// ---- Equipos (docs/EQUIPOS.md): read-only view of who this PC is and what each PC can do. ----
async function loadTeam() {
  const status = $('#team-status'), list = $('#team-list');
  try {
    const team = await api('/api/team');
    status.classList.toggle('pipeline-error', Boolean(team.error));
    status.textContent = team.error ? `La configuración de equipos no es válida: ${team.error} Mientras tanto no se despacha.`
      : !team.configured ? `Este PC no está identificado (falta data/equipo.json): sus encargos se anotan como «${team.nombre}», sin comprobar recursos ni reservar ramas.`
      : `Este PC es ${team.nombre}. Trabajos a la vez: ${team.concurrencia}. Reserva de ramas: ${team.reservas.activas ? `activa (caduca a los ${team.reservas.caducidadMinutos} min sin renovar)` : 'desactivada'}.`;
    list.replaceChildren(...Object.entries(team.equipos || {}).flatMap(([id, item]) => [el('dt', '', `${item.nombre}${id === team.id && team.configured ? ' (este PC)' : ''}`),
      el('dd', '', `${item.sistema} · ${item.recursos.length ? item.recursos.map(resource => team.resourceNames[resource] || resource).join(', ') : 'sin recursos declarados'}`)]));
  } catch (error) { status.textContent = `No se pudieron cargar los equipos: ${error.message}`; status.classList.add('pipeline-error'); }
}
