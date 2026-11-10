// Ideas y preguntas. Behaviour ported from panel/dashboard/app.js (renderQuestions, renderIdeas, captureIdea,
// editIdea, renderTelegramMessages). Filtering and ordering reuse the classic IdeaView (/ideas-view.js) as is.
import { h, icon, pill, mono, when, statusNames, BUSINESSES } from './lib.js';
import { api } from './domain.js';
import { stableOperation } from './views-requests.js';

const IdeaView = globalThis.IdeaView;
const tagsFrom = value => String(value || '').split(',').map(tag => tag.trim()).filter(Boolean);
const STATUS = { active: 'Activa', archived: 'Archivada', trash: 'Papelera' };
const label = (text, node, help) => h('label', {}, text, node, help || null);
const prefsKey = business => `ideas-view-${business}`;
function preferences(business) { try { return { ...IdeaView.defaults(), ...JSON.parse(localStorage.getItem(prefsKey(business)) || '{}') }; } catch { return IdeaView.defaults(); } }
function savePreferences(business, prefs) { try { localStorage.setItem(prefsKey(business), JSON.stringify(prefs)); } catch {} }

const ideaLinks = (idea, jobs) => jobs.filter(job => job.ideaId === idea.id || Object.values(idea.requests || {}).some(request => request.jobId === job.id) || job.id === `idea-${idea.id}-${job.kind}` || job.prompt?.includes(`[IDEA_ID:${idea.id}]`));
const ideaBusy = (state, idea) => state.ideaSends?.has(idea.id) || Object.values(idea.requests || {}).some(request => ['pending', 'active', 'uncertain'].includes(request.status));
const latestRequest = (data, idea) => (data.coordinatorRequests || []).filter(request => request.kind === 'idea' && request.ideaId === idea.id && (request.ideaVersion || 1) === (idea.version || 1)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
function requestText(request) {
  if (request.status === 'routed') return `Enrutada por el coordinador · ${request.route?.kind === 'code' ? 'Desarrollo' : 'Planificador'}${request.jobId ? ` · ${request.jobId}` : ''}`;
  if (request.status === 'routing') return `Decisión registrada: ${request.route?.kind === 'code' ? 'pipeline de código' : 'Planificador'} · materializando el mismo trabajo de forma segura${request.route?.lastError ? ` · ${request.route.lastError}` : ''}`;
  if (request.notification?.status === 'sent') return 'Avisada al coordinador · decisión pendiente; todavía sin trabajo ni dispatch';
  return request.notification?.reason || 'Solicitud guardada · aviso al coordinador pendiente';
}

function focusField(value = '', name = 'focus') {
  return h('fieldset', {}, h('legend', { text: 'Foco' }), h('div', { class: 'seg fit radios' }, ['', 'ux', 'code', 'mixed'].map(key => [key, IdeaView.focusNames[key]]).map(([key, text]) =>
    h('label', { class: 'segbtn' }, h('input', { type: 'radio', name, value: key, checked: value === key }), text))));
}

// ---------------------------------------------------------------- questions
function questionBlock(ctx) {
  const { data, state } = ctx;
  state.questionDrafts ||= new Map();
  const pending = data.questions.filter(question => question.status === 'pending');
  const answered = data.questions.filter(question => question.status !== 'pending').slice(0, 8);
  const pendingRows = pending.map(question => {
    const input = h('textarea', { id: `qa-${question.id}`, rows: 2, minlength: 2, maxlength: 4000, required: true, placeholder: 'Tu criterio o respuesta…', 'aria-label': `Respuesta a: ${question.question}` });
    input.value = state.questionDrafts.get(question.id) ?? '';
    input.addEventListener('input', () => state.questionDrafts.set(question.id, input.value));
    const button = h('button', { type: 'submit', class: 'btn', text: question.coordinatorRequestId ? 'Guardar para el coordinador' : 'Responder' });
    const form = h('form', { class: 'qanswer' }, input, button);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      button.disabled = true;
      try {
        const updated = await api(`/api/questions/${encodeURIComponent(question.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: input.value }) });
        state.questionDrafts.delete(question.id);
        await ctx.done(updated.coordinatorRequestId ? (updated.answerDeliveryStatus === 'sent' ? 'Respuestas agrupadas enviadas al mismo coordinador.' : 'Respuesta guardada. Se reunirán las decisiones pendientes antes de continuar.') : updated.lateDecision ? 'Decisión guardada después de preparar la continuación; requiere revisión antes de aplicarla.' : updated.followUpJobId ? `Decisiones guardadas; continuación vinculada a ${updated.followUpJobId}.` : 'Respuesta guardada; las decisiones del mismo trabajo se reunirán antes de continuar.');
      } catch (error) { await ctx.done(error.message, true); button.disabled = false; }
    });
    return h('div', { class: 'qrow', id: `question-${question.id}` }, h('span', { class: 'kind kind-accent' }, icon('question', 14)),
      h('div', { class: 'grow' }, h('div', { class: 't', text: question.question }),
        h('div', { class: 'm', text: [question.title, question.projectName || question.jobTitle || BUSINESSES[question.business]].filter(Boolean).join(' · ') }),
        question.context ? h('p', { class: 'soft small', text: question.context }) : null, form), when(question.createdAt));
  });
  const answeredRows = answered.map(question => {
    const continuation = (data.continuations || []).find(item => item.id === question.continuationId);
    let extra = null;
    if (continuation?.status === 'needs_attention') {
      const retry = h('button', { type: 'button', class: 'btn', text: 'Reanudar con la respuesta guardada' });
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { const result = await api(`/api/continuations/${encodeURIComponent(continuation.id)}/retry`, { method: 'POST', body: '{}' }); await ctx.done(result.status === 'needs_attention' ? result.reason : 'Continuación reanudada.', result.status === 'needs_attention'); }
        catch (error) { await ctx.done(error.message, true); retry.disabled = false; }
      });
      extra = [h('p', { class: 'soft small', text: continuation.reason }), h('div', { class: 'actions' }, retry)];
    } else if (continuation?.status === 'pending' && continuation.reason?.startsWith('Respuesta guardada.')) extra = h('p', { class: 'soft small', text: continuation.reason });
    return h('div', { class: 'row tall' }, h('span', { class: 'pv pv-observed' }), h('span', { class: 'grow' },
      h('span', { class: 't wrap', text: question.question }),
      h('span', { class: 'm wrap', text: question.answer ? `Tu respuesta: ${question.answer}` : 'Cerrada sin respuesta' }),
      question.followUpJobId ? h('span', { class: 'm' }, 'Continuación: ', h('a', { href: `#trabajo/${encodeURIComponent(question.followUpJobId)}`, text: question.followUpJobId })) : null,
      question.lateDecision ? h('span', { class: 'm', text: 'Llegó después de preparar la continuación; revisión pendiente.' }) : null,
      question.inherited ? h('span', { class: 'm', text: 'Decisión ya disponible: se conserva la respuesta anterior.' }) : null, extra), when(question.answeredAt || question.createdAt));
  });
  return [
    h('div', { class: 'sech' }, 'El equipo necesita tu criterio', h('span', { class: 'n', text: String(pending.length) })),
    pendingRows.length ? pendingRows : h('div', { class: 'empty' }, h('b', { text: 'Nada pendiente.' }), ' Cuando un agente necesite tu criterio dejará aquí la pregunta y te avisará por Telegram.'),
    answeredRows.length ? h('details', { class: 'report', 'data-key': 'answered-questions' }, h('summary', { text: `Respondidas recientemente (${answeredRows.length})` }), answeredRows) : null,
  ];
}

// ---------------------------------------------------------------- idea actions
function editIdea(ctx, idea, links) {
  const { data } = ctx;
  let expected = idea.version || 1;
  const title = h('input', { name: 'title', maxlength: 100, required: true }); title.value = idea.title;
  const text = h('textarea', { name: 'text', rows: 7, minlength: 4, maxlength: 6000, required: true }); text.value = idea.text;
  const tags = h('input', { name: 'tags', list: 'idea-tags' }); tags.value = (idea.tags || []).join(', ');
  const project = h('select', { name: 'projectId' }, h('option', { value: '', text: 'Sin proyecto' }),
    data.projects.filter(item => item.business === idea.business && (item.status !== 'completed' || item.id === idea.projectId)).map(item => h('option', { value: item.id, selected: item.id === idea.projectId, text: `${item.name}${item.status === 'completed' ? ' (cerrado)' : ''}` })));
  const error = h('p', { class: 'form-error', role: 'alert' });
  const notice = h('p', { class: 'hint', text: links.length ? 'Los cambios se usarán en futuros encargos; los existentes conservan su brief y destino. Cambiar proyecto reasigna solo la idea.' : 'Guardar cambios no crea un trabajo.' });
  const reload = h('button', { type: 'button', class: 'btn', text: 'Recargar versión conservando borrador' });
  reload.addEventListener('click', async () => {
    try {
      const latest = (await api('/api/state')).ideas.find(item => item.id === idea.id);
      if (!latest) throw new Error('No encuentro esa idea.');
      expected = latest.version || 1;
      notice.replaceChildren(h('details', {}, h('summary', { text: `Versión guardada ${expected}: revísala antes de guardar tu borrador` }), h('pre', { text: `${latest.title}\n${latest.text}\n${latest.projectName || 'Sin proyecto'}\n${IdeaView.focusNames[latest.focus || '']}\n${(latest.tags || []).join(', ')}` })));
      error.textContent = 'Versión actual cargada; tu borrador se conserva y se aplicará sobre ella.';
    } catch (failure) { error.textContent = failure.message; }
  });
  const form = h('form', { class: 'form' }, label('Título', title), label('Idea íntegra', text), focusField(idea.focus || '', 'focus'), h('div', { class: 'two' }, label('Etiquetas (hasta cinco, separadas por comas)', tags), label('Proyecto', project)), notice, h('div', { class: 'actions' }, reload), error);
  const save = h('button', { type: 'button', class: 'btn primary', text: 'Guardar cambios' });
  const dialog = sheet('Editar idea', `${BUSINESSES[idea.business]} · versión ${expected}`, form, 'Se conserva la captura original en Obsidian.', save);
  save.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    if (links.length && values.projectId !== (idea.projectId || '')) {
      dialog.close();
      const ok = await ctx.confirm('Confirmar cambio de proyecto', 'Los trabajos anteriores conservarán sus destinos históricos.', 'Cambiar proyecto');
      dialog.showModal(); if (!ok) { error.textContent = 'Cambio de proyecto cancelado; se conserva el borrador.'; return; }
    }
    save.disabled = true;
    try {
      await api(`/api/ideas/${idea.id}/update`, { method: 'POST', body: JSON.stringify({ ...values, tags: tagsFrom(values.tags), version: expected }) });
      dialog.close(); await ctx.done('Idea actualizada localmente; captura original conservada.');
    } catch (failure) { error.textContent = failure.message; save.disabled = false; }
  });
}
function sheet(title, sub, body, hint, action) {
  const dialog = document.getElementById('sheet');
  dialog.replaceChildren(
    h('div', { class: 'sheeth' }, h('div', {}, h('h2', { id: 'sheet-title', text: title }), sub ? h('p', { text: sub }) : null), h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Cerrar', text: '×', onclick: () => dialog.close() })),
    h('div', { class: 'sheet-body' }, body),
    h('div', { class: 'sheetf' }, h('span', { class: 'hint', text: hint }), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: () => dialog.close() }), action));
  dialog.showModal();
  return dialog;
}

function ideaRow(ctx, idea) {
  const { data, state } = ctx;
  const request = latestRequest(data, idea), links = ideaLinks(idea, data.jobs);
  const busy = ideaBusy(state, idea) || ['pending', 'routing', 'needs_attention'].includes(request?.status);
  const status = idea.status || 'active';
  const act = (text, run, disabled) => {
    const button = h('button', { type: 'button', class: 'btn', text, disabled: Boolean(disabled) });
    button.addEventListener('click', async () => { button.disabled = true; try { await run(); } catch (error) { await ctx.done(error.message, true); } finally { button.disabled = false; } });
    return button;
  };
  const actions = [];
  if (status !== 'trash') actions.push(act('Editar', async () => editIdea(ctx, idea, links), busy));
  if (!['trash', 'archived'].includes(status) && request?.status !== 'routed') actions.push(act(request ? 'Revisar aviso al coordinador' : 'Enviar al coordinador', async () => {
    const result = await api(`/api/ideas/${encodeURIComponent(idea.id)}/coordinator`, { method: 'POST', body: '{}' });
    await ctx.done(result.message, ['unknown', 'needs_attention'].includes(result.request?.notification?.status));
  }, ideaBusy(state, idea) || request?.status === 'routing'));
  const linked = links.length || Object.keys(idea.requests || {}).length || ['pending', 'routing', 'needs_attention', 'routed'].includes(request?.status);
  const action = ['trash', 'archived'].includes(status) ? 'restore' : linked ? 'archive' : 'trash';
  const title = { restore: 'Restaurar', archive: 'Archivar', trash: 'Eliminar' }[action];
  actions.push(act(title, async () => {
    const body = action === 'trash' ? 'Se moverá a Papelera; podrás restaurarla y se conserva la captura original.' : action === 'archive' ? `Tiene ${links.length} trabajos vinculados. Se ocultará de Activas; su historial seguirá disponible.` : 'Recuperará la misma identidad sin crear trabajos.';
    if (!await ctx.confirm(`${title} idea`, `${BUSINESSES[idea.business]} · ${idea.title}. ${body}`, title)) return;
    await api(`/api/ideas/${idea.id}/${action}`, { method: 'POST', body: JSON.stringify({ version: idea.version || 1 }) });
    await ctx.done('Idea actualizada localmente.');
  }, busy));
  return h('details', { class: 'idea', 'data-key': `idea-${idea.id}`, id: `idea-${idea.id}` },
    h('summary', { class: 'row' },
      h('span', { class: `pv ${idea.notePath ? 'pv-observed' : 'pv-reported'}`, title: idea.notePath ? 'Guardada en Obsidian' : 'Solo local' }),
      h('span', { class: 'grow' }, h('span', { class: 't', text: idea.title }),
        h('span', { class: 'm', text: [idea.projectName || 'Sin proyecto', IdeaView.focusNames[idea.focus || ''], ...(idea.tags || [])].join(' · ') })),
      request ? pill(request.status === 'routed' ? 'ok' : ['needs_attention'].includes(request.status) || ['unknown', 'needs_attention'].includes(request.notification?.status) ? 'warn' : 'accent', request.status === 'routed' ? 'Enrutada' : 'Con el coordinador') : null,
      when(idea.updatedAt || idea.createdAt)),
    h('div', { class: 'ideabody' },
      h('p', { class: 'prose', text: idea.text }),
      request ? h('p', { class: 'soft small', text: requestText(request) }) : null,
      links.length ? h('div', { class: 'actions' }, links.map(job => h('a', { class: 'btn', href: `#trabajo/${encodeURIComponent(job.id)}` }, job.title, ' · ', statusNames[job.state] || job.state))) : null,
      h('p', { class: 'hint', text: `${idea.notePath ? 'Captura original en Obsidian; versión actual local.' : `Guardada localmente · ${idea.noteError || 'Obsidian pendiente'}`}${idea.updatedAt ? ` · Editada` : ''}` }),
      busy ? h('p', { class: 'hint', text: 'Envío pendiente, activo o incierto: edición y retirada bloqueadas.' }) : null,
      h('div', { class: 'actions' }, actions)));
}

// ---------------------------------------------------------------- capture
function capture(ctx) {
  const { data, state } = ctx;
  const draft = state.ideaDraft || {};
  const project = h('select', { name: 'projectId', id: 'idea-project' }, h('option', { value: '', text: 'Sin proyecto' }), data.projects.filter(item => item.status !== 'completed').map(item => h('option', { value: item.id, selected: draft.projectId === item.id, text: item.name })));
  const text = h('textarea', { name: 'text', id: 'idea-text', rows: 6, maxlength: 6000, required: true, placeholder: 'Una idea, preferencia o dirección para el siguiente trabajo…' }); text.value = draft.text || '';
  const tags = h('input', { name: 'tags', id: 'idea-tags-input', maxlength: 124, list: 'idea-tags', placeholder: 'Hasta cinco, separadas por comas' }); tags.value = draft.tags || '';
  const checkout = h('p', { class: 'hint' });
  const paint = () => {
    const chosen = data.projects.find(item => item.id === project.value);
    const valid = data.checkouts?.some(item => item.value === chosen?.checkout && item.valid);
    checkout.textContent = valid ? `${chosen.checkout} · rama ${chosen.branch || 'pendiente de confirmar'}` : 'Sin destino de desarrollo comprobado; puedes guardar la idea igualmente.';
  };
  project.addEventListener('change', paint); paint();
  const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite', text: state.ideaStatus || 'El coordinador decide la ruta. Hasta entonces no se crea ningún trabajo ni se lanza ningún agente.' });
  const form = h('form', { class: 'form', id: 'idea-form' }, label('Proyecto', project, checkout), focusField(draft.focus || '', 'focus'), label('Idea o indicación', text), label('Etiquetas', tags));
  const keep = () => { state.ideaDraft = { ...Object.fromEntries(new FormData(form)) }; };
  form.addEventListener('input', keep); form.addEventListener('change', keep);
  const send = h('button', { type: 'button', class: 'btn primary center', text: 'Guardar y enviar al coordinador' });
  const only = h('button', { type: 'button', class: 'btn center', text: 'Solo guardar' });
  async function save(toCoordinator) {
    if (state.ideaBusy || !form.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form)); values.tags = tagsFrom(values.tags);
    const business = state.business, signature = JSON.stringify({ business, values });
    if (state.ideaOperation?.signature !== signature) state.ideaOperation = { signature, id: stableOperation('idea-captures', signature) };
    const operation = state.ideaOperation;
    state.ideaBusy = true; send.disabled = only.disabled = true; status.textContent = 'Guardando idea…';
    try {
      const post = () => api('/api/ideas', { method: 'POST', body: JSON.stringify({ ...values, business, operationId: operation.id }) });
      let idea = await post();
      if (['trash', 'archived'].includes(idea.status)) { operation.id = stableOperation('idea-captures', signature, operation.id); idea = await post(); }
      let message = idea.notePath ? 'Guardada en Obsidian y localmente.' : 'Guardada localmente; Obsidian pendiente.';
      if (toCoordinator) { status.textContent = 'Avisando al coordinador…'; message = (await api(`/api/ideas/${encodeURIComponent(idea.id)}/coordinator`, { method: 'POST', body: '{}' })).message || message; }
      state.ideaDraft = null; state.ideaOperation = null; state.ideaStatus = null;
      await ctx.done(message);
    } catch (error) {
      state.ideaStatus = 'No se confirmó el envío. Se conservan texto y operación para reintentar sin duplicar.';
      status.textContent = state.ideaStatus; await ctx.done(error.message, true);
    } finally { state.ideaBusy = false; send.disabled = only.disabled = false; }
  }
  send.addEventListener('click', () => save(true)); only.addEventListener('click', () => save(false));
  return h('aside', { class: 'panel wide', 'aria-label': 'Captura rápida' }, h('h2', { class: 'ph', text: 'Captura rápida' }), form, h('div', { class: 'stackbtn' }, send, only), status);
}

// ---------------------------------------------------------------- telegram
function telegram(ctx) {
  const messages = (ctx.data.messages || []).slice(0, 20);
  const pending = messages.filter(message => message.status === 'pending').length;
  return [
    h('div', { class: 'sech gap' }, 'Mensajes de Telegram', h('span', { class: 'n', text: pending ? `${pending} sin tratar` : 'secretaria' })),
    messages.length ? messages.map(message => {
      const handled = message.status !== 'pending';
      const mark = handled ? null : h('button', { type: 'button', class: 'btn', text: 'Marcar tratado' });
      mark?.addEventListener('click', async () => { mark.disabled = true; try { await api(`/api/messages/${encodeURIComponent(message.id)}/handled`, { method: 'POST', body: '{}' }); await ctx.done('Mensaje marcado como tratado.'); } catch (error) { await ctx.done(error.message, true); mark.disabled = false; } });
      return h('div', { class: `row tall${handled ? ' dimmed' : ''}` }, icon('external', 14), h('span', { class: 'grow' }, h('span', { class: 't wrap', text: message.text }), message.notePath ? h('span', { class: 'm' }, 'Obsidian · ', mono(message.notePath)) : null), mark || h('span', { class: 'm', text: 'Tratado' }), when(message.createdAt));
    }) : h('div', { class: 'empty' }, h('b', { text: 'Sin mensajes.' }), ' Cuando escribas al bot algo que no sea una orden, aparecerá aquí.'),
  ];
}

// ---------------------------------------------------------------- screen
export function ideas(ctx) {
  const { data, state } = ctx;
  const all = data.ideas || [];
  const prefs = preferences(state.business);
  const tagList = [...new Map(all.flatMap(idea => idea.tags || []).map(tag => [tag.toLocaleLowerCase('es'), tag])).values()].sort((a, b) => a.localeCompare(b, 'es'));
  if (prefs.project && prefs.project !== 'none' && !data.projects.some(project => project.id === prefs.project)) prefs.project = '';
  if (prefs.tag && !tagList.includes(prefs.tag)) prefs.tag = '';
  const shown = IdeaView.select(all, state.business, prefs);
  const select = (key, aria, options) => {
    const node = h('select', { class: 'chipsel', 'aria-label': aria }, options.map(([value, text]) => h('option', { value, selected: prefs[key] === value, text })));
    node.addEventListener('change', () => { prefs[key] = node.value; savePreferences(state.business, prefs); ctx.rerender(); });
    return node;
  };
  const filters = h('div', { class: 'chips' },
    select('project', 'Proyecto', [['', 'Proyecto: todos'], ['none', 'Sin proyecto'], ...data.projects.map(project => [project.id, project.name])]),
    select('focus', 'Foco', [['', 'Foco: todos'], ['none', 'Sin clasificar'], ['ux', 'Diseño UX'], ['code', 'Código'], ['mixed', 'Mixto']]),
    tagList.length ? select('tag', 'Etiqueta', [['', 'Etiqueta: todas'], ...tagList.map(tag => [tag, tag])]) : null,
    select('status', 'Estado', Object.entries(STATUS)),
    select('order', 'Orden', [['recent', 'Más recientes'], ['old', 'Más antiguas'], ['title', 'Título'], ['project', 'Proyecto'], ['focus', 'Foco']]));
  const main = h('div', { class: 'col' },
    questionBlock(ctx),
    h('div', { class: 'sech gap' }, 'Ideas guardadas', h('span', { class: 'n', text: String(shown.length) }), h('span', { class: 'spacer' }), filters),
    shown.length ? shown.map(idea => ideaRow(ctx, idea)) : h('div', { class: 'empty' }, h('b', { text: all.length ? 'No hay ideas con estos filtros.' : `Todavía no hay ideas en ${BUSINESSES[state.business]}.` }), all.length ? ' Cambia los filtros de arriba.' : ' Captura la primera desde el panel de la derecha.'),
    telegram(ctx),
    h('datalist', { id: 'idea-tags' }, tagList.map(tag => h('option', { value: tag }))));
  return {
    toolbar: [h('h1', { text: 'Ideas y preguntas' }), h('span', { class: 'spacer' }), h('span', { class: 'srcline', text: state.raw?.settings?.vaultPath ? 'Se guardan en Obsidian' : 'Se guardan localmente · Obsidian sin conectar' })],
    body: h('div', { class: 'body' }, h('div', { class: 'scroll' }, main), capture(ctx)),
  };
}
