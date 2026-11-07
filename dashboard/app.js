const $ = selector => document.querySelector(selector);
const state = { data: null, filter: 'all', graph: null, questionDrafts: new Map() };
const workflowStatusNames = { queued: 'Pendiente', running: 'En curso', succeeded: 'Completado', blocked: 'Bloqueado', failed: 'Falló', skipped: 'Omitido' };
const statusNames = { queued: 'En cola', running: 'En marcha', retry_wait: 'Reintento programado', needs_attention: 'Necesita revisión', succeeded: 'Completado', cancelled: 'Cerrado' };
const businessNames = { agency: 'Agencia', games: 'Videojuegos' };
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

function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
}

function renderJobs(data) {
  const list = $('#jobs-list');
  list.replaceChildren();
  const counts = data.queue.counts;
  $('#filter-all').textContent = String(data.queue.jobs.length);
  $('#filter-active').textContent = String(data.queue.active);
  $('#filter-attention').textContent = String(counts.needs_attention || 0);
  $('#filter-done').textContent = String(counts.succeeded || 0);
  const jobs = data.jobs.filter(job => state.filter === 'all'
    || (state.filter === 'active' && ['queued', 'running', 'retry_wait'].includes(job.state))
    || job.state === state.filter);
  if (!jobs.length) {
    list.append(el('div', 'empty-state', state.filter === 'all' ? 'Todavía no hay trabajos en la cola. Añade el primer encargo desde aquí.' : 'No hay trabajos con este estado.'));
    return;
  }
  for (const job of jobs) {
    const card = el('details', 'job-card');
    const summary = el('summary', 'job-summary');
    summary.append(el('span', 'job-id', `#${job.id}`));
    summary.append(el('span', `company-pill ${job.business}`, businessNames[job.business] || job.business));
    summary.append(el('span', 'job-title', job.title));
    if (job.projectName) summary.append(el('span', 'company-pill project-pill', job.projectName));
    summary.append(el('span', `job-state ${job.state}`, statusNames[job.state] || job.state));
    summary.append(el('span', 'job-chevron', '⌄'));
    card.append(summary);
    const detail = el('div', 'job-detail');
    detail.append(el('div', '', `Tipo: ${job.kind === 'code' ? 'código' : 'análisis'}  ·  Intentos: ${job.attempts}/${job.maxAttempts}  ·  Creado: ${formatDate(job.createdAt)}`));
    if (job.workflow?.steps?.length) {
      const workflow = el('section', 'job-workflow');
      workflow.append(el('b', '', job.kind === 'code' ? 'Flujo de calidad' : 'Flujo de análisis'));
      const stages = el('div', 'workflow-stages');
      for (const step of job.workflow.steps) {
        const stage = el('div', `workflow-stage ${step.status}`);
        const header = el('div', 'workflow-stage-header');
        header.append(el('span', 'workflow-stage-label', step.label), el('span', `workflow-stage-status ${step.status}`, workflowStatusNames[step.status] || step.status));
        stage.append(header, el('span', 'workflow-stage-profile', `Perfil: ${step.profile}`));
        if (step.dispatchId) stage.append(el('span', 'workflow-stage-dispatch', `Orca: ${step.dispatchId}`));
        if (step.summary) {
          const details = document.createElement('details');
          details.append(el('summary', '', 'Ver informe de etapa'), el('pre', 'workflow-stage-report', step.summary));
          stage.append(details);
        }
        stages.append(stage);
      }
      workflow.append(stages);
      detail.append(workflow);
    }
    if (job.error?.message) {
      const error = el('p', '', job.error.message);
      error.style.color = '#ffc98a';
      detail.append(error);
    }
    if (job.result?.text) detail.append(el('pre', 'job-output', job.result.text));
    if (job.prompt) {
      const prompt = document.createElement('details');
      prompt.style.marginTop = '9px';
      const promptSummary = el('summary', '', 'Ver encargo');
      prompt.append(promptSummary, el('div', 'job-output', job.prompt));
      detail.append(prompt);
    }
    if (job.workspace) detail.append(el('div', '', `Checkout: ${job.workspace}`));
    card.append(detail);
    list.append(card);
  }
}

function refreshProjectSelectors(projects) {
  for (const [selectorId, businessId] of [['job-project', 'job-business'], ['idea-project', 'idea-business']]) {
    const select = $(`#${selectorId}`);
    if (!select) continue;
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

    card.append(el('div', 'project-activity', `${project.jobCount || 0} trabajos · ${project.openJobCount || 0} abiertos`));
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
    form.append(stageLabel, nextLabel, statusLabelEl, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        await api(`/api/projects/${encodeURIComponent(project.id)}/update`, { method: 'POST', body: JSON.stringify(values) });
        notify(`Proyecto «${project.name}» actualizado.`);
        await refresh();
      } catch (error) { notify(error.message, true); save.disabled = false; }
    });
    card.append(form);
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
  for (const question of data.questions.slice(0, 20)) {
    const card = el('article', 'question-card');
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
      const button = el('button', 'button secondary', 'Responder y guardar en Obsidian');
      button.type = 'submit';
      form.append(input, button);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        button.disabled = true;
        try {
          const updated = await api(`/api/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: input.value }) });
          state.questionDrafts.delete(question.id);
          notify(updated.followUpJobId ? `Respuesta guardada; continuación ${updated.followUpJobId} añadida a la cola.` : 'Respuesta guardada como contexto para futuras tareas.');
          await refresh();
        } catch (error) { notify(error.message, true); button.disabled = false; }
      });
      card.append(form);
    } else if (question.answer) {
      card.append(el('p', '', `Tu respuesta: ${question.answer}`));
      if (question.followUpJobId) card.append(el('div', 'question-meta', `Continuación en cola: ${question.followUpJobId}`));
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

function renderIdeas(data) {
  const list = $('#ideas-list');
  list.replaceChildren();
  if (!data.ideas.length) return list.append(el('div', 'muted-empty', 'Tus ideas capturadas aparecerán aquí.'));
  for (const idea of data.ideas.slice(0, 6)) {
    const card = el('article', 'recent-idea');
    const linkedProject = (data.projects || []).find(item => item.id === idea.projectId);
    card.append(el('b', '', idea.title), el('span', '', `${businessNames[idea.business] || idea.business}${linkedProject ? ` · ${linkedProject.name}` : ''} · ${formatDate(idea.createdAt)}`));
    const plannedJob = (data.jobs || []).find(job => job.prompt?.includes(`[IDEA_ID:${idea.id}]`));
    if (plannedJob) {
      card.append(el('span', 'idea-plan-state', `Enviada al planificador · ${plannedJob.id}`));
    } else {
      let projectSelect = null;
      if (!linkedProject) {
        projectSelect = el('select', 'idea-project-pick');
        projectSelect.add(new Option('Asociar a un proyecto', ''));
        for (const project of (data.projects || []).filter(item => item.business === idea.business && item.status !== 'completed')) projectSelect.add(new Option(project.name, project.id));
        card.append(projectSelect);
      }
      const button = el('button', 'button secondary idea-plan-button', 'Enviar al planificador');
      button.type = 'button';
      button.addEventListener('click', async () => {
        const project = linkedProject || (data.projects || []).find(item => item.id === projectSelect?.value);
        if (!project) return notify('Asocia esta idea a un proyecto antes de enviarla.', true);
        button.disabled = true;
        try {
          const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({
            business: idea.business,
            projectId: project.id,
            projectName: project.name,
            kind: 'analysis',
            title: `Planificar: ${idea.title}`.slice(0, 160),
            prompt: `Idea de Daniel [IDEA_ID:${idea.id}]:\n${idea.text}\n\nPrepara un plan claro para convertirla en un resultado verificable. Incluye objetivo, pasos priorizados, entregables, supuestos y preguntas imprescindibles. No inventes datos del negocio, no ejecutes acciones externas y no modifiques código ni archivos.`,
            successCriteria: 'Entregar un plan priorizado con entregables, criterios de aceptación verificables y las preguntas imprescindibles, sin modificar archivos.',
            provider: 'orca',
            maxUsd: 0.1,
          }) });
          notify(`Idea enviada a la cola del planificador (${job.id}).`);
          await refresh();
        } catch (error) { notify(error.message, true); button.disabled = false; }
      });
      card.append(button);
    }
    list.append(card);
  }
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
  status.textContent = data.settings.autoRun ? 'Autoejecución activa' : 'Panel local';
  $('#panel-dot').style.background = data.settings.autoRun ? '#ffc98a' : '#8de0bd';
  const agency = data.jobs.filter(job => job.business === 'agency');
  const games = data.jobs.filter(job => job.business === 'games');
  $('#agency-active').textContent = agency.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length;
  $('#agency-done').textContent = agency.filter(job => job.state === 'succeeded').length;
  $('#agency-domains').textContent = String(data.domains.length);
  $('#games-active').textContent = games.filter(job => ['queued', 'running', 'retry_wait', 'needs_attention'].includes(job.state)).length;
  $('#games-done').textContent = games.filter(job => job.state === 'succeeded').length;
  $('#games-domains').textContent = '—';
  const settingsForm = $('#settings-form');
  if (document.activeElement !== settingsForm.elements.vaultPath) settingsForm.elements.vaultPath.value = data.settings.vaultPath || '';
  settingsForm.elements.autoRun.checked = data.settings.autoRun;
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
  try {
    const [graph, config] = await Promise.all([api('/api/graph'), api('/api/config')]);
    state.graph = graph;
    renderGraph(graph, config);
  } catch (error) { notify(error.message, true); }
}

async function refresh() {
  try {
    const data = await api('/api/state');
    state.data = data;
    renderSummary(data);
    renderProjects(data);
    refreshProjectSelectors(data.projects || []);
    renderJobs(data);
    renderQuestions(data);
    renderIdeas(data);
    renderTelegramMessages(data);
    renderDomains(data);
    renderAssistantTasks(data);
  } catch (error) {
    $('#panel-dot').style.background = '#ff9ca5';
    $('#panel-state').textContent = 'Sin conexión';
    notify(error.message, true);
  }
}

$('#refresh').addEventListener('click', async () => { await refresh(); await refreshGraph(); });
$('#refresh-graph').addEventListener('click', refreshGraph);
document.querySelectorAll('.filter').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button));
  state.filter = button.dataset.filter;
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

$('#show-new-job').addEventListener('click', () => { $('#job-form').hidden = false; $('#job-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('#hide-new-job').addEventListener('click', () => { $('#job-form').hidden = true; });
$('#job-business').addEventListener('change', () => refreshProjectSelectors(state.data?.projects || []));
$('#idea-business').addEventListener('change', () => refreshProjectSelectors(state.data?.projects || []));
$('#job-kind').addEventListener('change', event => document.querySelectorAll('.workspace-field').forEach(field => { field.hidden = event.target.value !== 'code'; }));
$('#job-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const isolated = form.elements.isolated.checked;
  const project = state.data?.projects.find(item => item.id === values.projectId);
  const payload = { business: values.business, projectId: values.projectId, projectName: project?.name, kind: values.kind, title: values.title, prompt: values.prompt, successCriteria: values.successCriteria, provider: 'orca', workspace: values.workspace, isolated };
  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    form.reset(); form.hidden = true;
    notify(`Trabajo ${job.id} añadido a la cola.`);
    await refresh();
  } catch (error) { notify(error.message, true); }
});

$('#run-next').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (!confirm('¿Procesar el siguiente trabajo con el proveedor configurado en la cola? Se aplicarán los límites locales existentes.')) return;
  button.disabled = true;
  $('#run-status').hidden = false;
  $('#run-status').textContent = 'El trabajo está en marcha. La página se actualizará al terminar.';
  try {
    await api('/api/run', { method: 'POST', body: '{}' });
    const timer = setInterval(async () => {
      const data = await api('/api/state');
      state.data = data; renderSummary(data); renderJobs(data); renderQuestions(data); renderIdeas(data); renderTelegramMessages(data);
      const running = data.jobs.some(job => job.state === 'running');
      if (!running) { clearInterval(timer); button.disabled = false; $('#run-status').textContent = 'Ejecución finalizada; revisa el resultado antes de entregar o publicar.'; await refreshGraph(); }
    }, 2500);
  } catch (error) { button.disabled = false; $('#run-status').hidden = true; notify(error.message, true); }
});

$('#idea-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const project = state.data?.projects.find(item => item.id === values.projectId);
  if (!project) return notify('Selecciona primero un proyecto para asociar esta idea.', true);
  try {
    const idea = await api('/api/ideas', { method: 'POST', body: JSON.stringify({ business: values.business, projectId: project.id, text: values.text }) });
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify({
      business: idea.business,
      projectId: project.id,
      projectName: project.name,
      kind: 'analysis',
      title: `Planificar: ${idea.title}`.slice(0, 160),
      prompt: `Idea de Daniel [IDEA_ID:${idea.id}]:\n${idea.text}\n\nPrepara un plan claro para convertirla en un resultado verificable. Incluye objetivo, pasos priorizados, entregables, supuestos y preguntas imprescindibles. No inventes datos del negocio, no ejecutes acciones externas y no modifiques código ni archivos.`,
      successCriteria: 'Entregar un plan priorizado con entregables, criterios de aceptación verificables y las preguntas imprescindibles, sin modificar archivos.',
      provider: 'orca',
      maxUsd: 0.1,
    }) });
    form.reset();
    notify(`Idea guardada y enviada al planificador (${job.id}).`);
    await refresh(); await refreshGraph();
  } catch (error) { notify(error.message, true); }
});

$('#save-idea-only').addEventListener('click', async () => {
  const form = $('#idea-form');
  if (!form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form));
  const project = state.data?.projects.find(item => item.id === values.projectId);
  if (!project) return notify('Selecciona primero un proyecto para asociar esta idea.', true);
  try {
    await api('/api/ideas', { method: 'POST', body: JSON.stringify({ business: values.business, projectId: project.id, text: values.text }) });
    form.reset();
    notify('Idea guardada en Obsidian sin enviarla a la cola.');
    await refresh(); await refreshGraph();
  } catch (error) { notify(error.message, true); }
});

$('#project-create-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  try {
    const project = await api('/api/projects', { method: 'POST', body: JSON.stringify(values) });
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
    await api('/api/config', { method: 'POST', body: JSON.stringify({ vaultPath: values.vaultPath, autoRun: form.elements.autoRun.checked }) });
    notify('Bóveda conectada. Los próximos resultados se guardarán automáticamente.');
    await refresh(); await refreshGraph();
  } catch (error) { notify(error.message, true); }
});

document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  const section = document.querySelector(link.getAttribute('href'));
  if (section?.id === 'conocimiento' && !state.graph) void refreshGraph();
}));

void refresh().then(refreshGraph);
setInterval(refresh, 8000);
