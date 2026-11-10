(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const make = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const done = new Set(['answered', 'succeeded', 'completed', 'merged', 'integrated', 'delivered', 'published', 'withdrawn', 'cancelled']);
  const attention = new Set(['needs_attention', 'blocked', 'failed', 'awaiting_answer', 'waiting_user', 'questions_pending', 'unavailable']);
  const labels = { queued: 'Pendiente', pending: 'Pendiente', running: 'En curso', succeeded: 'Completado', completed: 'Completado', answered: 'Respondida', blocked: 'Bloqueado', failed: 'Revisar', needs_attention: 'Revisar', skipped: 'Omitido', waiting: 'En espera', merged: 'Integrado', withdrawn: 'Retirada', cancelled: 'Cancelada' };
  const roles = { ux: 'Diseño UX', developer: 'Desarrollo', qa: 'QA', reviewer: 'Revisión', planner: 'Análisis' };
  let current = { requestTraces: [], projects: [], questions: [] }, business = '', signature = '';
  const expanded = new Set();
  const format = value => value ? new Date(value).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';
  const storageRead = key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };
  const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  function responseProse(text) {
    const paragraph = make('p', 'request-prose');
    const pattern = /`([^`\n]+)`|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      paragraph.append(text.slice(offset, match.index));
      if (match[1]) paragraph.append(make('code', '', match[1]));
      else {
        let target;
        try { target = new URL(match[3]); } catch {}
        if (target && ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) {
          const link = make('a', '', match[2]); link.href = target.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; paragraph.append(link);
        } else paragraph.append(match[0]);
      }
      offset = match.index + match[0].length;
    }
    paragraph.append(text.slice(offset));
    return paragraph;
  }
  const questionsFor = trace => trace.questions || (current.questions || []).filter(q => q.coordinatorRequestId === trace.requestId || (trace.ids?.jobIds || []).includes(q.jobId));
  function saveDraft() { if (business) store(`consultation-${business}`, { text: $('consultation-text').value, project: $('consultation-project').value }); }
  function projectOptions(select, first, second) {
    const selected = select.value;
    select.replaceChildren(new Option(first[0], first[1]));
    if (second) select.add(new Option(second[0], second[1]));
    for (const p of current.projects || []) select.add(new Option(p.name, p.id));
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
  }
  function sourceDetails(receipt, requestId) {
    const section = make('section', 'request-context');
    section.append(make('h4', '', `Contexto consultado · ${roles[receipt.actor?.stage] || (receipt.actor?.kind === 'worker' ? 'Trabajador' : 'Coordinador')}`));
    section.append(make('p', 'microcopy', `${format(receipt.createdAt)} · ${receipt.query || ''}`));
    const memory = receipt.projectState;
    if (receipt.legacyProjectContext) section.append(make('p', 'microcopy', 'Consulta histórica anterior a la memoria vigente del proyecto.'));
    if (memory?.published) section.append(make('p', 'microcopy', `Última integración verificada en esta consulta · ${memory.published.title} · ${memory.published.mergeSha.slice(0, 12)}`));
    if (memory?.working) section.append(make('p', 'microcopy', `Candidato de esta consulta · ${memory.working.title} · ${memory.working.stage || memory.working.state} · ${memory.working.locallyApproved ? 'QA y Revisión aprobadas' : 'Validación en curso'}`));
    if (!(receipt.sources || []).length) section.append(make('p', 'microcopy', receipt.connected === false ? 'La bóveda de Obsidian no estaba disponible para esta consulta.' : 'No se encontraron notas relevantes en el ámbito de esta petición.'));
    for (const warning of receipt.warnings || []) section.append(make('p', 'microcopy', warning));
    for (const source of receipt.sources || []) {
      const detail = make('details', 'request-source');
      detail.dataset.panelDetail = `request-${requestId}-${receipt.id}-${source.id}`;
      detail.append(make('summary', '', `${source.title || 'Nota'} · ${source.historical ? 'Histórica · ' : ''}${(receipt.citedSourceIds || []).includes(source.id) ? 'Citada' : 'Entregada al agente'}`));
      detail.append(make('p', 'request-prose', source.excerpt || ''));
      if (source.projectId) detail.append(make('p', 'microcopy', `Proyecto: ${(current.projects || []).find(p => p.id === source.projectId)?.name || source.projectId}`));
      detail.append(make('p', 'microcopy', `${source.path || ''}${source.startLine ? ` · líneas ${source.startLine}–${source.endLine}` : ''}`));
      if (typeof source.obsidianUrl === 'string' && source.obsidianUrl.startsWith('obsidian://')) { const a = make('a', 'text-button', 'Abrir nota en Obsidian'); a.href = source.obsidianUrl; detail.append(a); }
      section.append(detail);
    }
    return section;
  }
  // E: per-job report. Every fact says whether the Centro verified it, an agent reported it, or nobody showed it.
  const levelLabels = { observed: 'Comprobado', reported: 'Según el agente', unknown: 'Sin evidencia' };
  function jobReportSection(report) {
    const section = make('section', 'job-report'); section.setAttribute('aria-label', `Informe del encargo ${report.title}`);
    section.append(make('h4', '', `Informe del encargo · ${report.title}`),
      make('p', 'microcopy', `${report.totals.observed} comprobados · ${report.totals.reported} según el agente · ${report.totals.unknown} sin evidencia`));
    if (report.asked.objective) section.append(make('p', 'request-prose', `Se pidió: ${report.asked.objective}`));
    const fact = item => { const row = make('li', `report-fact level-${item.level}`); row.append(make('span', 'report-level', levelLabels[item.level] || item.level), make('strong', '', item.label || item.criterion), make('span', '', item.value ?? item.status ?? ''));
      if (item.evidence) row.append(make('small', '', item.evidence)); return row; };
    if (report.criteria.length) { const list = make('ul', 'report-facts'); list.setAttribute('aria-label', 'Criterios del encargo'); for (const item of report.criteria) list.append(fact({ ...item, value: `${item.status}${item.stage ? ` · ${item.stage}` : ''}` })); section.append(make('h5', '', 'Criterios'), list); }
    for (const stage of report.stages) { if (!stage.facts.length) continue; const list = make('ul', 'report-facts'); for (const item of stage.facts) list.append(fact(item)); section.append(make('h5', '', stage.label), list); }
    if (report.integration.applies) { const list = make('ul', 'report-facts'); for (const item of report.integration.facts) list.append(fact(item)); section.append(make('h5', '', 'Integración'), list); }
    return section;
  }
  function card(trace) {
    const item = make('article', 'request-card'); item.id = `request-${trace.requestId}`;
    const header = make('div', 'request-card-header');
    const identity = make('div'); identity.append(make('p', 'eyebrow', trace.projectName || 'Consulta general · sin proyecto'), make('h3', '', trace.title));
    header.append(identity, make('span', `request-state ${done.has(trace.status) ? 'is-done' : attention.has(trace.status) ? 'is-attention' : 'is-active'}`, trace.statusLabel || labels[trace.status] || trace.status));
    item.append(header, make('p', 'request-owner', `Responsable: ${trace.responsible?.name || 'Pendiente de asignación'}`));
    const flow = make('ol', 'request-flow'); flow.setAttribute('aria-label', 'Etapas de la petición');
    for (const step of trace.steps || []) {
      const li = make('li', `request-step step-${step.status}`);
      li.append(make('strong', '', step.label), make('span', '', labels[step.status] || step.status));
      if (step.agent?.name) li.append(make('small', '', step.agent.name));
      if (step.summary) li.title = step.summary;
      if (step.status === 'running') li.setAttribute('aria-current', 'step');
      flow.append(li);
    }
    item.append(flow, make('p', 'request-next', trace.nextAction || 'Consulta el historial de esta petición.'));
    const relatedQuestions = questionsFor(trace);
    const pending = relatedQuestions.filter(q => q.status === 'pending');
    if (pending.length) {
      const button = make('button', 'button primary', `Responder ${pending.length === 1 ? 'pregunta' : `${pending.length} preguntas`}`); button.type = 'button';
      button.onclick = () => { location.hash = '#ideas'; setTimeout(() => { const question = $(`question-${pending[0].id}`); question?.scrollIntoView({ block: 'center' }); question?.querySelector('textarea')?.focus({ preventScroll: true }); }, 80); };
      item.append(button);
    }
    const request = (current.coordinatorRequests || []).find(value => value.id === trace.requestId);
    if (request?.status !== 'answered' && (request?.answerNotices || []).some(notice => ['unknown', 'needs_attention', 'sending'].includes(notice.notification?.status))) {
      const check = make('button', 'button secondary', 'Consultar entrega de respuestas'); check.type = 'button';
      check.onclick = async () => { check.disabled = true; try { const r = await fetch(`/api/coordinator/requests/${encodeURIComponent(trace.requestId)}/notify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const result = await r.json(); if (!r.ok) throw new Error(result.error); $('refresh').click(); } catch (error) { check.textContent = error.message || 'No se pudo consultar la entrega'; check.disabled = false; } };
      item.append(check);
    }
    if (trace.response?.text) {
      const response = make('section', 'request-answer'); response.append(make('h4', '', 'Respuesta del coordinador'), responseProse(trace.response.text));
      for (const source of trace.response.sources || []) {
        const delivered = (trace.knowledge || []).flatMap(receipt => receipt.sources || []).find(note => note.id === source.id);
        const reference = make('p', 'microcopy', `${source.label || 'Referencia declarada'}: ${source.title || delivered?.title || source.path || source.url || 'Ver detalle de contexto'}`);
        if (/^(https?:\/\/|obsidian:\/\/)/.test(source.url || '')) { const link = make('a', 'text-button', 'Abrir referencia'); link.href = source.url; link.rel = 'noreferrer'; reference.append(' · ', link); }
        response.append(reference);
      }
      item.append(response);
    }
    const details = make('details', 'request-details'); details.dataset.request = trace.requestId; details.open = expanded.has(trace.requestId);
    details.dataset.panelDetail = `request-${trace.requestId}-timeline`;
    details.append(make('summary', '', 'Ver recorrido, decisiones y contexto'));
    details.addEventListener('toggle', () => details.open ? expanded.add(trace.requestId) : expanded.delete(trace.requestId));
    const timeline = make('ol', 'request-timeline');
    for (const event of trace.events || []) { const row = make('li'); row.append(make('time', '', format(event.at)), make('strong', '', event.label || event.kind), make('p', 'request-prose', event.summary || '')); timeline.append(row); }
    details.append(timeline);
    for (const q of relatedQuestions) {
      const decision = make('div', 'request-decision'); decision.append(make('strong', '', q.question), make('p', 'request-prose', q.answer ? `Tu respuesta: ${q.answer}` : q.closedByResponseId ? 'Pregunta opcional cerrada al responder la consulta.' : 'Esperando tu respuesta.')); details.append(decision);
    }
    for (const report of trace.reports || []) details.append(jobReportSection(report));
    for (const receipt of trace.knowledge || []) details.append(sourceDetails(receipt, trace.requestId));
    if (!(trace.knowledge || []).length) details.append(make('p', 'microcopy', 'Todavía no hay una consulta de Obsidian registrada para esta petición.'));
    const ids = make('details', 'request-technical'); ids.dataset.panelDetail = `request-${trace.requestId}-identifiers`;
    ids.append(make('summary', '', 'Identificadores de seguimiento'), make('pre', '', JSON.stringify({ requestId: trace.requestId, ...trace.ids }, null, 2))); details.append(ids);
    item.append(details); return item;
  }
  function renderList(force = false) {
    const query = $('request-search').value.trim().toLocaleLowerCase('es'), filter = $('request-filter').value, project = $('request-project-filter').value;
    const traces = (current.requestTraces || []).filter(t => (!query || `${t.title} ${t.responsible?.name || ''} ${t.projectName || ''}`.toLocaleLowerCase('es').includes(query))
      && (project === 'all' || (project === 'none' ? !t.projectId : t.projectId === project))
      && (filter === 'all' || filter === 'done' && done.has(t.status) || filter === 'attention' && (attention.has(t.status) || questionsFor(t).some(q => q.status === 'pending')) || filter === 'active' && !done.has(t.status) && !attention.has(t.status)));
    const next = JSON.stringify([traces, current.questions, query, filter, project]);
    $('request-count').textContent = String((current.requestTraces || []).filter(t => !done.has(t.status)).length);
    $('request-results').textContent = `${traces.length} ${traces.length === 1 ? 'petición' : 'peticiones'} · el historial se conserva al terminar`;
    if (!force && signature === next) return; signature = next;
    const list = $('request-list');
    const restoreDetails = window.capturePanelDetails?.(list);
    list.replaceChildren(...traces.map(card));
    if (!traces.length) list.append(make('div', 'empty-state', (current.requestTraces || []).length ? 'No hay peticiones con estos filtros.' : 'Escribe una consulta arriba. Aquí verás quién la recibe y su respuesta.'));
    restoreDetails?.();
  }
  window.RequestsView = { render(data, selectedBusiness) {
    current = data;
    const changed = business !== selectedBusiness;
    if (changed) { saveDraft(); business = selectedBusiness; }
    const projectsKey = JSON.stringify([business, current.projects?.map(p => [p.id, p.name])]);
    if ($('consultation-project').dataset.projects !== projectsKey) {
      projectOptions($('consultation-project'), ['Consulta general · sin proyecto', '']);
      projectOptions($('request-project-filter'), ['Todos', 'all'], ['Sin proyecto', 'none']);
      $('consultation-project').dataset.projects = projectsKey;
    }
    if (changed) { const draft = storageRead(`consultation-${business}`); $('consultation-text').value = draft?.text || ''; $('consultation-project').value = draft?.project || ''; if (!$('consultation-project').value) $('consultation-project').value = ''; $('consultation-status').textContent = ''; }
    renderList();
  } };
  for (const id of ['request-search', 'request-filter', 'request-project-filter']) $(id).addEventListener('input', () => renderList());
  $('consultation-text').addEventListener('input', saveDraft); $('consultation-project').addEventListener('change', saveDraft);
  $('consultation-form').addEventListener('submit', async event => {
    event.preventDefault(); const prompt = $('consultation-text').value.trim(); if (!prompt || !business) return;
    const sentBusiness = business, projectId = $('consultation-project').value || null;
    const key = `consultation-send-${business}`, textSignature = JSON.stringify([prompt, projectId]);
    const old = storageRead(key), operationId = old?.signature === textSignature ? old.id : crypto.randomUUID();
    store(key, { signature: textSignature, id: operationId });
    const button = event.target.querySelector('button'); button.disabled = true; $('consultation-status').textContent = 'Guardando y avisando al coordinador…';
    try {
      const response = await fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ intent: 'consultation', business: sentBusiness, projectId, prompt, operationId }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || 'No se pudo enviar la consulta.');
      store(key, null);
      const currentDraft = business === sentBusiness ? { text: $('consultation-text').value, project: $('consultation-project').value || null } : storageRead(`consultation-${sentBusiness}`);
      const unchanged = currentDraft?.text?.trim() === prompt && (currentDraft.project || null) === projectId;
      if (unchanged) store(`consultation-${sentBusiness}`, null);
      if (business === sentBusiness) { if (unchanged) $('consultation-text').value = ''; $('consultation-status').textContent = 'Consulta guardada. Su recorrido y respuesta aparecerán debajo.'; }
      $('refresh').click();
    } catch (error) { if (business === sentBusiness) $('consultation-status').textContent = `${error.message} Puedes reintentar: se conserva el mismo envío.`; }
    finally { button.disabled = false; }
  });
})();
