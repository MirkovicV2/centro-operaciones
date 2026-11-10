// Peticiones and the new-job sheet. Behaviour ported from panel/dashboard/requests-view.js and the job form
// in panel/dashboard/app.js: same endpoints, same payloads, same stable operation ids on retry.
import { h, icon, pill, pv, mono, initial, when, relativeTime, stageTrack, levelText, BUSINESSES } from './lib.js';
import { api } from './domain.js';
import { requestActions, requestMessage } from './views-ops.js';

const done = new Set(['answered', 'succeeded', 'completed', 'merged', 'integrated', 'delivered', 'published', 'withdrawn', 'cancelled']);
const attention = new Set(['needs_attention', 'blocked', 'failed', 'awaiting_answer', 'waiting_user', 'questions_pending', 'unavailable']);
const labels = { queued: 'Pendiente', pending: 'Pendiente', running: 'En curso', succeeded: 'Completado', completed: 'Completado', answered: 'Respondida', blocked: 'Bloqueado', failed: 'Revisar', needs_attention: 'Revisar', skipped: 'Omitido' };
const store = { get: key => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }, set: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} } };

// Same as the classic panel: a retry of the same content reuses its operation id, so nothing is sent twice.
export function stableOperation(namespace, signature) {
  const key = `operations-${namespace}`;
  const operations = store.get(key) || {};
  const id = operations[signature] || crypto.randomUUID();
  operations[signature] = id; store.set(key, operations);
  return id;
}

// Answer text: plain text, `code` and http(s) links only; anything else stays literal (as in requests-view.js).
function prose(text) {
  const paragraph = h('p', { class: 'prose' });
  const pattern = /`([^`\n]+)`|\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    paragraph.append(text.slice(offset, match.index));
    if (match[1]) paragraph.append(h('code', { text: match[1] }));
    else {
      let target; try { target = new URL(match[3]); } catch {}
      if (target && ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) paragraph.append(h('a', { href: target.href, target: '_blank', rel: 'noopener noreferrer', text: match[2] }));
      else paragraph.append(match[0]);
    }
    offset = match.index + match[0].length;
  }
  paragraph.append(text.slice(offset));
  return paragraph;
}
const tone = trace => done.has(trace.status) ? 'ok' : attention.has(trace.status) ? 'warn' : 'accent';
const questionsFor = (data, trace) => trace.questions || (data.questions || []).filter(q => q.coordinatorRequestId === trace.requestId || (trace.ids?.jobIds || []).includes(q.jobId));

export function requests(ctx) {
  const { data, param, state } = ctx;
  const filter = state.requestFilter || 'all';
  const all = (data.requestTraces || []).filter(trace => trace.status !== 'withdrawn' || filter === 'all');
  const traces = all.filter(trace => filter === 'all' || (filter === 'done' && done.has(trace.status)) || (filter === 'attention' && (attention.has(trace.status) || questionsFor(data, trace).some(q => q.status === 'pending'))) || (filter === 'active' && !done.has(trace.status) && !attention.has(trace.status)))
    .sort((a, b) => String(b.events?.at(-1)?.at || '').localeCompare(String(a.events?.at(-1)?.at || '')));
  const selected = traces.find(trace => trace.requestId === param) || traces.find(trace => attention.has(trace.status)) || traces[0];
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Estado' }, [['all', 'Todas'], ['attention', 'Atención'], ['active', 'En curso'], ['done', 'Terminadas']].map(([value, label]) =>
    h('button', { type: 'button', class: `segbtn${filter === value ? ' on' : ''}`, 'aria-pressed': String(filter === value), onclick: () => { state.requestFilter = value; ctx.rerender(); }, text: label })));
  const list = h('div', { class: 'alist', 'aria-label': 'Peticiones' },
    h('div', { class: 'agl', text: 'Del mensaje al resultado' }),
    traces.length ? traces.map(trace => h('a', { class: `arow${trace === selected ? ' sel' : ''}`, href: '#peticiones/' + encodeURIComponent(trace.requestId), 'aria-current': trace === selected ? 'true' : undefined },
      initial(trace.projectName || trace.title),
      h('span', { class: 'grow' }, h('span', { class: 't', text: trace.title || 'Petición' }), h('span', { class: 'm', text: [trace.intent === 'consultation' ? 'Consulta' : 'Encargo', trace.events?.at(-1)?.at && relativeTime(trace.events.at(-1).at)].filter(Boolean).join(' · ') }),
        h('span', { class: 'rowfoot' }, pill(tone(trace), trace.statusLabel || labels[trace.status] || trace.status), stageTrack(trace.steps))))) : h('div', { class: 'empty pad' }, h('b', { text: 'Sin peticiones.' }), ' Escribe abajo al coordinador para empezar.'));

  let detail = h('div', { class: 'col' });
  if (selected) {
    const related = questionsFor(data, selected);
    const request = (data.coordinatorRequests || []).find(value => value.id === selected.requestId);
    const uncertain = ['routed', 'withdrawn'].includes(request?.status) && (request?.answerNotices || []).some(notice => ['unknown', 'needs_attention', 'sending'].includes(notice.notification?.status));
    const check = uncertain ? h('button', { type: 'button', class: 'btn', text: 'Consultar entrega de respuestas' }) : null;
    check?.addEventListener('click', async () => { check.disabled = true; try { await api(`/api/coordinator/requests/${encodeURIComponent(selected.requestId)}/notify`, { method: 'POST', body: '{}' }); await ctx.done('Consulta de entrega registrada.'); } catch (error) { await ctx.done(error.message, true); check.disabled = false; } });
    const jobIds = selected.ids?.jobIds || [];
    detail = h('div', { class: 'col req' },
      h('div', { class: 'kicker' }, selected.intent === 'consultation' ? 'Consulta' : 'Encargo', ' · ', selected.projectName || 'Sin proyecto', ' · ', mono(selected.requestId || ''), h('span', { class: 'spacer' }), pill(tone(selected), selected.statusLabel || labels[selected.status] || selected.status)),
      h('h2', { class: 'title', text: selected.title || 'Petición' }),
      selected.responsible?.name ? h('p', { class: 'soft small', text: `Responsable: ${selected.responsible.name}` }) : null,
      (selected.steps || []).length ? h('ol', { class: 'flow', 'aria-label': 'Etapas de la petición' }, selected.steps.map((step, index) => h('li', { class: `fstep fstep-${step.status}`, 'aria-current': step.status === 'running' ? 'step' : undefined, title: step.summary || undefined },
        h('span', { class: 'n', text: String(index + 1).padStart(2, '0') }), h('b', { text: step.label }), h('span', { text: labels[step.status] || step.status }), step.agent?.name ? h('small', { text: step.agent.name }) : null))) : null,
      selected.nextAction ? h('p', { class: 'next', text: selected.nextAction }) : null,
      related.filter(q => q.status === 'pending').length ? h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: `#atencion/${encodeURIComponent('question-' + related.find(q => q.status === 'pending').id)}`, text: 'Responder en Atención' })) : null,
      check ? h('div', { class: 'actions' }, check) : null,
      request && !['routed', 'withdrawn', 'answered'].includes(request.status) ? h('div', { class: 'decision' }, h('b', { text: 'Con el coordinador' }), h('p', { class: 'soft', text: requestMessage(request) }), h('div', { class: 'actions' }, requestActions(ctx, request))) : null,
      jobIds.length ? h('div', { class: 'actions' }, jobIds.map(id => h('a', { class: 'btn', href: `#trabajo/${encodeURIComponent(id)}` }, 'Abrir el trabajo ', mono(`#${id}`)))) : null,
      selected.response?.text ? h('section', { class: 'answer' }, h('h4', { text: 'Respuesta del coordinador' }), prose(selected.response.text),
        (selected.response.sources || []).map(source => h('p', { class: 'soft small' }, `${source.label || 'Referencia declarada'}: ${source.title || source.path || source.url || ''}`,
          /^(https?:\/\/|obsidian:\/\/)/.test(source.url || '') ? [' · ', h('a', { href: source.url, rel: 'noreferrer', text: 'Abrir referencia' })] : null))) : null,
      h('div', { class: 'h3', text: 'Recorrido' }),
      (selected.events || []).length ? h('ol', { class: 'trace' }, selected.events.map((event, index) => h('li', { class: `tr${index === selected.events.length - 1 ? ' ans' : ''}` },
        h('div', { class: 'trh' }, h('b', { text: event.label || event.kind || 'Evento' }), when(event.at, 'trw')), event.summary ? h('p', { text: event.summary }) : null))) : h('p', { class: 'soft', text: 'Sin eventos todavía.' }),
      related.length ? [h('div', { class: 'h3', text: 'Decisiones' }), related.map(q => h('div', { class: 'decision' }, h('b', { text: q.question }), h('p', { class: 'soft', text: q.answer ? `Tu respuesta: ${q.answer}` : q.status === 'pending' ? 'Pendiente de tu respuesta.' : 'Cerrada sin respuesta.' })))] : null,
      (selected.knowledge || []).length ? [h('div', { class: 'h3' }, 'Fuentes de Obsidian', h('span', { class: 'n', text: 'qué recibió y qué citó' })),
        h('div', { class: 'evlist' }, selected.knowledge.flatMap(receipt => (receipt.sources || []).map(source => {
          const cited = (receipt.citedSourceIds || []).includes(source.id);
          return h('div', { class: 'ev' }, h('span', { text: source.title || 'Nota' }), h('span', { class: 'spacer' }), pill(cited ? 'accent' : 'muted', cited ? 'Citada' : 'Recibida, no citada'),
            typeof source.obsidianUrl === 'string' && source.obsidianUrl.startsWith('obsidian://') ? h('a', { href: source.obsidianUrl, text: 'Abrir' }) : null);
        })))] : null,
      (selected.reports || []).map(report => h('section', { class: 'answer soft-box' }, h('h4', { text: `Informe · ${report.title || ''}` }),
        h('p', { class: 'soft small', text: `${report.totals.observed} comprobados · ${report.totals.reported} declarados · ${report.totals.unknown} sin registro` }),
        h('div', { class: 'evlist' }, (report.criteria || []).map(item => h('div', { class: 'ev' }, pv(item.level), h('span', { text: item.criterion }), h('span', { class: 'spacer' }), pill(item.status === 'passed' ? 'ok' : item.status === 'failed' ? 'danger' : 'unknown', item.status === 'passed' ? 'Cumple' : item.status === 'failed' ? 'No cumple' : 'Sin verificar')))))));
  }

  // Composer: a consultation (no job, no agents). Same payload and operation-id reuse as requests-view.js.
  const draftKey = `consultation-${state.business}`;
  const draft = store.get(draftKey);
  const text = h('textarea', { id: 'ask', rows: 2, placeholder: 'Pregunta al coordinador…', 'aria-label': 'Nueva consulta' });
  text.value = draft?.text || '';
  const project = h('select', { 'aria-label': 'Contexto', id: 'ask-project' }, h('option', { value: '', text: 'Consulta general · sin proyecto' }), (data.projects || []).map(p => h('option', { value: p.id, selected: draft?.project === p.id, text: p.name })));
  const save = () => store.set(draftKey, { text: text.value, project: project.value });
  text.addEventListener('input', save); project.addEventListener('change', save);
  const status = h('span', { class: 'ro', role: 'status', text: 'Una consulta no crea trabajos. Para encargar cambios usa «Nuevo trabajo».' });
  const send = h('button', { type: 'button', class: 'btn primary', text: 'Enviar' });
  send.addEventListener('click', async () => {
    const prompt = text.value.trim(); if (!prompt) return text.focus();
    const projectId = project.value || null, key = `consultation-send-${state.business}`, signature = JSON.stringify([prompt, projectId]);
    const old = store.get(key), operationId = old?.signature === signature ? old.id : crypto.randomUUID();
    store.set(key, { signature, id: operationId });
    send.disabled = true; status.textContent = 'Guardando y avisando al coordinador…';
    try {
      await api('/api/jobs', { method: 'POST', body: JSON.stringify({ intent: 'consultation', business: state.business, projectId, prompt, operationId }) });
      store.set(key, null); store.set(draftKey, null); text.value = '';
      await ctx.done('Consulta guardada. Su recorrido y respuesta aparecerán aquí.');
    } catch (error) { status.textContent = `${error.message} Puedes reintentar: se conserva el mismo envío.`; send.disabled = false; }
  });
  const composer = h('div', { class: 'composer' }, text, h('div', { class: 'cbar' }, project, status, h('span', { class: 'spacer' }), send));
  return {
    toolbar: [h('h1', { text: 'Peticiones' }), filters, h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn primary', onclick: () => ctx.openNewJob() }, icon('plus', 13), 'Nuevo trabajo')],
    body: h('div', { class: 'body' }, list, h('div', { class: 'scroll stack' }, detail, composer)),
  };
}

// ---- New job sheet. Code jobs confirm the destination first, as in the classic panel.
export function openNewJob(ctx) {
  const { data, state } = ctx;
  const dialog = document.getElementById('newjob');
  const projects = data.projects || [];
  const form = h('form', { class: 'form', method: 'dialog' });
  const project = h('select', { name: 'projectId', required: true }, projects.length ? projects.map(p => h('option', { value: p.id, text: p.name })) : h('option', { value: '', text: 'Crea antes un proyecto' }));
  const kind = h('select', { name: 'kind' }, h('option', { value: 'analysis', text: 'Sin preferencia' }), h('option', { value: 'code', text: 'Podría requerir código' }));
  const title = h('input', { name: 'title', maxlength: 160, required: true, placeholder: 'Resultado concreto que quieres obtener' });
  const prompt = h('textarea', { name: 'prompt', maxlength: 10000, rows: 4, required: true, placeholder: 'Qué resultado necesitas y el contexto relevante' });
  const criteria = h('textarea', { name: 'successCriteria', maxlength: 1800, rows: 2, required: true, placeholder: 'Qué podremos comprobar para darlo por terminado' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const label = (text, node) => h('label', {}, text, node);
  const submit = h('button', { type: 'submit', class: 'btn primary', text: 'Enviar al coordinador' });
  const cancel = h('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: () => dialog.close() });
  form.append(h('div', { class: 'two' }, label('Proyecto', project), label('Orientación (no fija la ruta)', kind)), label('Título', title), label('Objetivo e instrucciones', prompt), label('Criterio de éxito', criteria), error);
  const step = h('div', { class: 'sheet-body' }, form);
  const foot = h('div', { class: 'sheetf' }, h('span', { class: 'hint', text: `${BUSINESSES[state.business]} · La orientación no elige agente; el coordinador confirma la ruta.` }), h('span', { class: 'spacer' }), cancel, submit);
  dialog.replaceChildren(h('div', { class: 'sheeth' }, h('div', {}, h('h2', { id: 'newjob-title', text: 'Nuevo trabajo' }), h('p', { text: 'Llega primero al coordinador. Hasta que decida la ruta no hay trabajo ni agentes.' })), h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Cerrar', onclick: () => dialog.close(), text: '×' })), step, foot);
  let primary = () => send();
  submit.addEventListener('click', event => { event.preventDefault(); primary(); });
  let busy = false;
  async function send(confirmation) {
    if (busy) return;
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    const chosen = projects.find(p => p.id === values.projectId);
    if (values.kind === 'code' && !confirmation) return destination(chosen, values);
    if (!confirmation && !await ctx.confirm('Enviar solicitud al coordinador', `${BUSINESSES[state.business]} · ${values.title}. Se guarda una solicitud para que el coordinador decida entre análisis o desarrollo. Todavía no se crea un trabajo ni se inicia un agente.`, 'Enviar al coordinador')) { dialog.showModal(); return; }
    const signature = JSON.stringify({ business: state.business, values, confirmation });
    const payload = { operationId: stableOperation('submissions', signature), confirmation, business: state.business, projectId: values.projectId, projectName: chosen?.name, kind: values.kind, title: values.title,
      prompt: confirmation ? confirmation.objective : values.prompt, successCriteria: confirmation ? confirmation.successCriteria : values.successCriteria, provider: 'orca', isolated: true };
    busy = true; submit.disabled = true;
    try {
      const result = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
      dialog.close(); await ctx.done(result.message || 'Solicitud enviada al coordinador; todavía no hay trabajo ni dispatch.');
    } catch (failure) {
      if (!dialog.open) dialog.showModal();
      error.textContent = `${failure.message} Consulta la solicitud del coordinador antes de repetir; se conserva el identificador.`;
    } finally { busy = false; submit.disabled = false; }
  }
  // Code: the destination must be configured and checked, then the owner confirms objective and criterion.
  function destination(chosen, values) {
    const observed = (data.checkouts || []).find(item => item.value === chosen?.checkout);
    if (!chosen?.baseBranch) { error.textContent = 'Configura y guarda una rama base GitHub existente en el proyecto antes de enviar a desarrollo.'; return; }
    if (!observed?.valid || !chosen.branch || observed.branch !== chosen.branch) { error.textContent = 'Configura y comprueba checkout y rama del proyecto antes de enviar a desarrollo.'; return; }
    const objective = h('textarea', { rows: 3, minlength: 4, maxlength: 1800, required: true }); objective.value = values.prompt;
    const success = h('textarea', { rows: 3, minlength: 4, maxlength: 1800, required: true }); success.value = values.successCriteria;
    const check = h('form', { class: 'form' },
      h('dl', { class: 'props' }, [['Proyecto', chosen.name], ['Checkout', chosen.checkout], ['Repositorio', chosen.repository || 'Pendiente de configurar; inicio automático bloqueado'], ['Rama fuente', observed.branch], ['Rama base', chosen.baseBranch]].map(([k, v]) => h('div', { class: 'prop' }, h('dt', { text: k }), h('dd', { text: v })))),
      h('label', {}, 'Objetivo', objective), h('label', {}, 'Criterio de éxito', success),
      h('p', { class: 'hint', text: 'Esto confirma el destino para el coordinador. Todavía no crea un trabajo; GitHub, rama y SHA se vuelven a comprobar si elige código.' }));
    step.replaceChildren(check);
    submit.textContent = 'Confirmar destino y enviar';
    primary = () => { if (!check.reportValidity()) return; send({ projectId: chosen.id, checkout: chosen.checkout, branch: chosen.branch, baseBranch: chosen.baseBranch || '', objective: objective.value.trim(), successCriteria: success.value.trim() }); };
  }
  dialog.showModal(); title.focus();
}
