// Proyectos and Ajustes (autoejecución, coordinador, Obsidian, apariencia). Behaviour ported from
// panel/dashboard/app.js (renderProjects, renderAutomation, the coordinator inbox and the settings form):
// same endpoints, same bodies, same confirmation texts.
import { h, icon, pill, mono, initial, when, statusNames, BUSINESSES, relativeTime } from './lib.js';
import { api } from './domain.js';

const RECEIPT = { pending: 'Pendiente', claimed: 'Reservado', queued: 'En cola', retrying: 'Reintentando', blocked: 'Bloqueado', needs_attention: 'Revisar', completed: 'Completado', reviewed: 'Revisado', dispatched: 'Enviado' };
const STATUS = { active: 'Activo', paused: 'Pausado', completed: 'Completado' };
const label = (text, node, help) => h('label', {}, text, node, help || null);

// Generic sheet in #sheet. Refresh does not redraw while a dialog is open, so the form survives polling.
function openSheet({ title, sub, body, hint, actions }) {
  const dialog = document.getElementById('sheet');
  const close = h('button', { type: 'button', class: 'ibtn', 'aria-label': 'Cerrar', onclick: () => dialog.close(), text: '×' });
  dialog.replaceChildren(
    h('div', { class: 'sheeth' }, h('div', {}, h('h2', { id: 'sheet-title', text: title }), sub ? h('p', { text: sub }) : null), close),
    h('div', { class: 'sheet-body' }, body),
    h('div', { class: 'sheetf' }, h('span', { class: 'hint', text: hint || '' }), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn', text: 'Cancelar', onclick: () => dialog.close() }), actions));
  dialog.showModal();
  return dialog;
}

// ---------------------------------------------------------------- coordinator request actions (shared)
// Same rules as the classic coordinator inbox: notify when not confirmed sent, withdraw while no job exists.
export function requestActions(ctx, request) {
  if (!request || ['routed', 'withdrawn', 'answered'].includes(request.status)) return [];
  const buttons = [];
  const uncertain = ['unknown', 'needs_attention', 'sending'].includes(request.notification?.status) || (request.answerNotices || []).some(notice => ['unknown', 'needs_attention', 'sending'].includes(notice.notification?.status));
  if (request.notification?.status !== 'sent' || uncertain) {
    const check = h('button', { type: 'button', class: 'btn', text: uncertain ? 'Consultar entrega en Orca' : 'Enviar aviso al coordinador' });
    check.addEventListener('click', async () => { check.disabled = true; try { await api(`/api/coordinator/requests/${encodeURIComponent(request.id)}/notify`, { method: 'POST', body: '{}' }); await ctx.done('Aviso registrado.'); } catch (error) { await ctx.done(error.message, true); check.disabled = false; } });
    buttons.push(check);
  }
  if (request.status !== 'routing' && !['sending', 'unknown', 'needs_attention'].includes(request.notification?.status)) {
    const withdraw = h('button', { type: 'button', class: 'btn', text: 'Retirar para corregirla' });
    withdraw.addEventListener('click', async () => {
      if (!await ctx.confirm('Retirar solicitud', 'Solo se puede retirar si todavía no existe un trabajo. Se conserva el historial y podrás corregir el encargo antes de enviarlo de nuevo.', 'Retirar')) return;
      try { await api(`/api/coordinator/requests/${encodeURIComponent(request.id)}/withdraw`, { method: 'POST', body: '{}' }); await ctx.done('Solicitud retirada.'); } catch (error) { await ctx.done(error.message, true); }
    });
    buttons.push(withdraw);
  }
  return buttons;
}
export function requestMessage(request) {
  if (request.status === 'routing') return `Decisión registrada: ${request.route?.kind === 'code' ? 'pipeline de código' : 'Planificador'}. Reanudable desde el mismo checkpoint.${request.route?.lastError ? ` Último intento: ${request.route.lastError}` : ''}`;
  return request.notification?.reason || (request.notification?.status === 'sent' ? 'Avisada al coordinador; decisión pendiente. Todavía no hay trabajo ni dispatch.' : 'Guardada; aviso al coordinador pendiente.');
}

// ---------------------------------------------------------------- Proyectos
function checkoutState(data, project) {
  const observed = (data.checkouts || []).find(candidate => candidate.value === project.checkout);
  if (observed?.valid) return { ok: true, text: `${project.checkout} · ${observed.branch}`, branch: observed.branch };
  return { ok: false, text: project.checkout ? `${project.checkout}: no válido` : 'Sin checkout', branch: null };
}

function editProject(ctx, project) {
  const { data } = ctx;
  const stage = h('select', { name: 'stageIndex' }, (project.stages || []).map((name, index) => h('option', { value: String(index), selected: index === (project.stageIndex || 0), text: name })));
  const next = h('input', { name: 'nextAction', maxlength: 240, placeholder: 'Qué toca hacer ahora' }); next.value = project.nextAction || '';
  const status = h('select', { name: 'status' }, Object.entries(STATUS).map(([value, text]) => h('option', { value, selected: value === project.status, text })));
  const checkout = h('select', { name: 'checkout' }, h('option', { value: '', text: 'Sin configurar' }),
    (data.checkouts || []).map(candidate => h('option', { value: candidate.value, disabled: !candidate.valid, text: candidate.valid ? `${candidate.value} · ${candidate.branch}` : `${candidate.value}: ${candidate.reason}` })));
  if (project.checkout && ![...checkout.options].some(option => option.value === project.checkout)) checkout.append(h('option', { value: project.checkout, disabled: true, text: `${project.checkout}: ruta inválida o inexistente` }));
  checkout.value = project.checkout || '';
  const repository = h('input', { name: 'repository', placeholder: 'propietario/repositorio' }); repository.value = project.repository || '';
  const baseBranch = h('input', { name: 'baseBranch', placeholder: 'main', 'aria-describedby': 'base-help base-context' }); baseBranch.value = project.baseBranch || '';
  const help = h('span', { class: 'hint', id: 'base-help', text: 'Rama existente que recibe la PR o el merge. Si coincide con la rama fuente, se integra directamente.' });
  const observedBranch = () => (data.checkouts || []).find(candidate => candidate.value === checkout.value && candidate.valid)?.branch;
  const context = h('span', { class: 'hint mono', id: 'base-context' });
  const paint = () => { context.textContent = `Rama fuente observada: ${observedBranch() || 'sin confirmar'} → base: ${baseBranch.value.trim() || 'configuración pendiente'}`; };
  baseBranch.addEventListener('input', () => { paint(); if (baseBranch.value.trim()) baseBranch.removeAttribute('aria-invalid'); });
  checkout.addEventListener('change', paint); paint();
  if (!project.baseBranch) baseBranch.setAttribute('aria-invalid', 'true');
  const error = h('p', { class: 'form-error', role: 'alert' });
  const remote = project.remote ? (project.remote.verified ? `Remoto verificado al guardar: origin ${project.remote.origin} · ${project.remote.branch} en ${String(project.remote.remoteSha).slice(0, 7)}` : `Remoto sin verificar: ${project.remote.warning}`)
    : project.checkout && project.repository ? 'Remoto pendiente de verificar: vuelve a guardar para comprobar origin, rama y SHA.' : null;
  const form = h('form', { class: 'form' },
    h('div', { class: 'two' }, label('Etapa actual', stage), label('Estado', status)),
    label('Siguiente paso', next),
    h('div', { class: 'h3', text: 'Destino de desarrollo' }),
    label('Checkout', checkout, h('span', { class: 'hint', text: 'Solo checkouts independientes bajo workspaces/. Se rechazan rutas externas, enlaces fuera del ámbito y Git compartido.' })),
    label('Repositorio GitHub', repository),
    label('Rama base GitHub', baseBranch, help), context,
    remote ? h('p', { class: 'soft small', text: remote }) : null, error);
  const save = h('button', { type: 'button', class: 'btn primary', text: 'Guardar proyecto' });
  const dialog = openSheet({ title: project.name, sub: `${BUSINESSES[project.business] || project.business} · ${STATUS[project.status] || project.status}`, body: form, hint: 'Guardar vuelve a comprobar el remoto, la rama y el SHA.', actions: save });
  save.addEventListener('click', async () => {
    if (!baseBranch.value.trim()) { baseBranch.setAttribute('aria-invalid', 'true'); error.textContent = 'Configuración pendiente: indica una rama base GitHub existente antes de guardar.'; baseBranch.focus(); return; }
    save.disabled = true; error.textContent = '';
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}/update`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      dialog.close(); await ctx.done(`Proyecto «${project.name}» actualizado.`);
    } catch (failure) { error.textContent = failure.message; save.disabled = false; }
  });
}

function createProject(ctx) {
  const name = h('input', { name: 'name', maxlength: 100, required: true, placeholder: 'Ej.: nombre del juego o aplicación' });
  const form = h('form', { class: 'form' }, label('Nombre del proyecto', name), h('p', { class: 'hint', text: `Se crea en ${BUSINESSES[ctx.state.business]}. Después podrás configurar etapa, checkout y rama base.` }));
  const error = h('p', { class: 'form-error', role: 'alert' }); form.append(error);
  const create = h('button', { type: 'button', class: 'btn primary', text: 'Crear proyecto' });
  const dialog = openSheet({ title: 'Nuevo proyecto', body: form, actions: create });
  form.addEventListener('submit', event => { event.preventDefault(); create.click(); });
  create.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    create.disabled = true;
    try {
      const project = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: name.value.trim(), business: ctx.state.business }) });
      dialog.close(); await ctx.done(`Proyecto «${project.name || name.value.trim()}» creado.`);
    } catch (failure) { error.textContent = failure.message; create.disabled = false; }
  });
  name.focus();
}

export function projects(ctx) {
  const { data, state } = ctx;
  const query = (state.projectQuery || '').toLocaleLowerCase('es');
  const status = state.projectStatus || 'all';
  const all = data.projects || [];
  const shown = all.filter(project => (status === 'all' || project.status === status) && (!query || project.name.toLocaleLowerCase('es').includes(query)));
  const search = h('input', { type: 'search', id: 'project-search', class: 'searchin', placeholder: 'Buscar proyecto', 'aria-label': 'Buscar proyecto' }); search.value = state.projectQuery || '';
  search.addEventListener('input', () => { state.projectQuery = search.value; ctx.rerender(); });
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'Estado' }, [['all', 'Todos'], ['active', 'Activos'], ['paused', 'Pausados'], ['completed', 'Completados']].map(([value, text]) =>
    h('button', { type: 'button', class: `segbtn${status === value ? ' on' : ''}`, 'aria-pressed': String(status === value), text, onclick: () => { state.projectStatus = value; ctx.rerender(); } })));
  const rows = shown.map(project => {
    const checkout = checkoutState(data, project);
    const stage = (project.stages || [])[project.stageIndex || 0] || project.stage || '—';
    const runs = `${project.jobCount || 0} trabajos · ${project.openJobCount || 0} abiertos`;
    const destination = project.baseBranch ? h('span', {}, mono(project.repository || 'sin repositorio'), h('span', { class: 'm', text: ` → ${project.baseBranch}` })) : h('span', { class: 'now now-warn', text: 'Rama base pendiente' });
    return h('button', { type: 'button', class: 'prow', onclick: () => editProject(ctx, project), 'aria-label': `Editar ${project.name}` },
      h('span', { class: 'pid' }, initial(project.name), h('span', { class: 'grow' }, h('span', { class: 't', text: project.name }), h('span', { class: 'm' }, h('span', { class: `dot${checkout.ok ? '' : ' off'}` }), checkout.text))),
      h('span', {}, pill(project.status === 'active' ? 'muted' : 'unknown', stage)),
      h('span', { class: 'grow' }, h('span', { class: 'nx', text: project.nextAction || 'Sin siguiente paso' }), h('span', { class: 'm', text: project.status === 'active' ? runs : `${STATUS[project.status]} · ${runs}` })),
      h('span', { class: 'm' }, destination));
  });
  const body = h('div', { class: 'col wide' },
    h('div', { class: 'phead' }, h('span', { text: 'Proyecto' }), h('span', { text: 'Etapa' }), h('span', { text: 'Siguiente paso' }), h('span', { text: 'Destino' })),
    rows.length ? rows : h('div', { class: 'empty' }, h('b', { text: all.length ? 'No hay proyectos con esos filtros.' : 'Crea el primer proyecto.' }), all.length ? '' : ' Después podrás seguir su etapa y asociar cada idea y trabajo.'),
    h('p', { class: 'hint pad-top', text: 'Cada proyecto tiene su checkout aislado. Pulsa una fila para editar etapa, siguiente paso y destino. Las otras líneas de negocio se ven cambiando de espacio en la barra lateral.' }));
  return {
    toolbar: [h('h1', { text: 'Proyectos' }), filters, h('span', { class: 'spacer' }), search, h('button', { type: 'button', class: 'btn', onclick: () => createProject(ctx) }, icon('plus', 13), 'Nuevo proyecto')],
    body: h('div', { class: 'body' }, h('div', { class: 'scroll' }, body)),
  };
}

// ---------------------------------------------------------------- Ajustes
const TABS = [['autoejecucion', 'Autoejecución'], ['coordinador', 'Coordinador'], ['obsidian', 'Obsidian'], ['apariencia', 'Apariencia'], ['modelos', 'Modelos por rol'], ['v2', 'Workflow V2']];

function autoRun(ctx) {
  const automation = ctx.state.raw?.automation || { businesses: {}, receipts: [], history: [] };
  const toggles = Object.entries(BUSINESSES).map(([business, name]) => {
    const enabled = automation.businesses?.[business] === true;
    const button = h('button', { type: 'button', class: `switch${enabled ? ' on' : ''}`, role: 'switch', 'aria-checked': String(enabled), 'aria-label': `Autoejecución de ${name}`, id: `auto-toggle-${business}` }, h('i'));
    button.addEventListener('click', async () => {
      if (!await ctx.confirm(`${enabled ? 'Pausar' : 'Activar'} ${name}`, enabled ? 'Detiene nuevos inicios y conserva el dispatch activo. Los recibos pendientes esperarán.' : 'Solo serán automáticos los encargos nuevos confirmados mientras esta empresa esté activa. La cola anterior permanece manual. El PC y este panel deben seguir abiertos.', enabled ? 'Confirmar pausa' : 'Confirmar activación')) return;
      button.disabled = true;
      try { await api('/api/auto-run', { method: 'POST', body: JSON.stringify({ business, enabled: !enabled, confirm: true }) }); await ctx.done(`${name}: autoejecución ${enabled ? 'pausada' : 'activa'}.`); }
      catch (error) { await ctx.done(error.message, true); button.disabled = false; }
    });
    return h('div', { class: 'setrow' }, h('span', { class: 'grow' }, h('b', { text: name }), h('span', { class: 'm', text: enabled ? 'Activa · arranca los encargos que el coordinador ya ha enrutado' : 'Pausada · todo queda en cola manual' })), button);
  });
  const receipts = (automation.receipts || []).slice().reverse().map(receipt => {
    const actions = [];
    if (receipt.status === 'blocked' && (receipt.blockCode === 'checkout_locked' || /^Checkout ocupado o bloqueo pendiente;.*\. EEXIST$/.test(receipt.reason || ''))) {
      const retry = h('button', { type: 'button', class: 'btn', text: 'Verificar checkout y continuar' });
      retry.addEventListener('click', async () => {
        if (!await ctx.confirm('Verificar checkout', 'El panel comprobará la reserva y la salida de los trabajadores anteriores en Orca. Si puede liberar el checkout, continuará este mismo encargo.', 'Verificar y continuar')) return;
        retry.disabled = true;
        try { await api(`/api/auto-run/${receipt.id}/retry-checkout`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await ctx.done('Checkout verificado.'); } catch (error) { await ctx.done(error.message, true); retry.disabled = false; }
      });
      actions.push(retry);
    }
    if (['blocked', 'needs_attention'].includes(receipt.status)) {
      const review = h('button', { type: 'button', class: 'btn', text: 'Cerrar recibo tras revisión' });
      review.addEventListener('click', async () => {
        if (!await ctx.confirm('Confirmar revisión del recibo', 'Comprueba los dispatches, efectos y bloqueos de checkout. Resuelve primero cualquier job incierto. Cerrar no reintenta este envío.', 'Cerrar tras revisión')) return;
        try { await api(`/api/auto-run/${receipt.id}/review`, { method: 'POST', body: JSON.stringify({ confirm: true }) }); await ctx.done('Recibo cerrado.'); } catch (error) { await ctx.done(error.message, true); }
      });
      actions.push(review);
    }
    const tone = ['blocked', 'needs_attention'].includes(receipt.status) ? 'danger' : ['completed', 'reviewed'].includes(receipt.status) ? 'ok' : 'muted';
    return h('div', { class: 'setrow top' },
      h('span', { class: 'grow' },
        h('b', {}, h('a', { href: `#trabajo/${encodeURIComponent(receipt.jobId)}`, text: `#${receipt.jobId}` }), ' ', h('span', { class: 'm inline', text: `${BUSINESSES[receipt.business] || ''} · ${receipt.eligible ? 'Automático' : 'Manual'} · ${receipt.id}` })),
        h('span', { class: 'm', text: receipt.reason || 'Confirmación guardada; consulta la etapa y el dispatch del trabajo.' }),
        receipt.destination ? h('span', { class: 'm mono', text: `${receipt.destination.repository} · ${receipt.destination.branch} · ${String(receipt.destination.sha || '').slice(0, 7)}` }) : null,
        actions.length ? h('span', { class: 'actions' }, actions) : null),
      pill(tone, RECEIPT[receipt.status] || receipt.status));
  });
  const history = (automation.history || []).slice(-30).reverse();
  return [
    h('h2', { class: 'seth', text: 'Autoejecución por espacio' }),
    h('p', { class: 'setp', text: 'Solo arranca trabajos que el coordinador ya ha enrutado. Pausar conserva el trabajador activo. El PC y el panel deben seguir abiertos.' }),
    h('div', { class: 'setlist' }, toggles),
    h('div', { class: 'h3' }, 'Recibos', h('span', { class: 'n', text: String(receipts.length) })),
    receipts.length ? h('div', { class: 'setlist' }, receipts) : h('div', { class: 'empty' }, h('b', { text: 'Sin recibos.' }), ' Aparecen cuando un encargo confirmado entra en la cola automática.'),
    history.length ? h('details', { class: 'report', 'data-key': 'auto-history' }, h('summary', { text: `Historial (${history.length})` }),
      h('div', { class: 'feed' }, history.map(event => h('div', { class: 'it' }, `${event.type} · ${BUSINESSES[event.business] || event.jobId || ''}${event.enabled !== undefined ? ` · ${event.enabled ? 'activa' : 'pausada'}` : ''}`, when(event.at))))) : null,
  ];
}

function coordinator(ctx) {
  const { data, state } = ctx;
  const coordinators = (data.coordination?.coordinators || []).filter(item => item.business === state.business);
  const waiting = (data.coordinatorRequests || []).filter(request => !['routed', 'withdrawn', 'answered'].includes(request.status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return [
    h('h2', { class: 'seth', text: 'Coordinador' }),
    h('p', { class: 'setp', text: 'Cada solicitud llega primero al coordinador del proyecto, que decide la ruta. Las decisiones que necesitan tu criterio aparecen en Atención.' }),
    h('div', { class: 'setlist' }, coordinators.length ? coordinators.map(item => {
      const linked = (data.projects || []).filter(project => data.coordination?.projects?.[project.id] === item.id).map(project => project.name);
      return h('div', { class: 'setrow' }, h('span', { class: `dot${item.connected ? '' : ' off'}` }), h('span', { class: 'grow' }, h('b', { text: item.name }), h('span', { class: 'm', text: item.connected ? (linked.length ? linked.join(', ') : 'Sin proyectos vinculados') : item.reason || 'Conexión pendiente' })), pill(item.connected ? 'ok' : 'unknown', item.connected ? 'Conectado' : 'Pendiente'));
    }) : h('div', { class: 'setrow' }, h('span', { class: 'dot off' }), h('span', { class: 'grow' }, h('b', { text: 'Coordinador sin vincular' }), h('span', { class: 'm', text: data.coordination?.error || 'Las solicitudes se conservarán pendientes.' })))),
    h('div', { class: 'h3', id: 'coordinator-inbox' }, 'Solicitudes esperando decisión', h('span', { class: 'n', text: String(waiting.length) })),
    waiting.length ? h('div', { class: 'setlist' }, waiting.slice(0, 20).map(request => h('div', { class: 'setrow top' },
      h('span', { class: 'grow' },
        h('b', {}, h('a', { href: `#peticiones/${encodeURIComponent(request.id)}`, text: request.snapshot?.title || request.snapshot?.text?.slice(0, 100) || 'Solicitud del panel' })),
        h('span', { class: 'm', text: `${request.projectName || request.snapshot?.projectName || 'Sin proyecto'} · ${relativeTime(request.createdAt) || ''}` }),
        h('span', { class: 'm', text: requestMessage(request) }),
        request.notification?.coordinatorName ? h('span', { class: 'm', text: `Responsable: ${request.notification.coordinatorName}` }) : null,
        h('span', { class: 'actions' }, requestActions(ctx, request))),
      pill(request.status === 'routing' ? 'accent' : 'muted', request.status === 'routing' ? 'Enrutando' : 'Pendiente'))))
      : h('div', { class: 'empty' }, h('b', { text: 'Nada esperando.' }), ' Todas las solicitudes tienen ruta o respuesta.'),
  ];
}

function obsidian(ctx) {
  const settings = ctx.state.raw?.settings || {};
  const path = h('input', { name: 'vaultPath', id: 'vault-path', placeholder: '/ruta/a/la/boveda', required: true }); path.value = settings.vaultPath || '';
  const save = h('button', { type: 'submit', class: 'btn primary fit', text: 'Guardar conexión' });
  const form = h('form', { class: 'form narrow' }, label('Ruta de la bóveda', path, h('span', { class: 'hint', text: settings.vaultPath ? 'Conectada · lectura de contexto y escritura de notas del Centro.' : 'Elige la carpeta raíz de tu bóveda de Obsidian.' })), save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true;
    try { await api('/api/config', { method: 'POST', body: JSON.stringify({ vaultPath: path.value.trim(), autoRun: false }) }); await ctx.done('Bóveda conectada. Los próximos resultados se guardarán automáticamente.'); }
    catch (error) { await ctx.done(error.message, true); save.disabled = false; }
  });
  return [
    h('h2', { class: 'seth', text: 'Obsidian y Telegram' }),
    h('p', { class: 'setp', text: 'El Centro guarda resultados e ideas en la bóveda y entrega extractos relevantes a los agentes, solo de la empresa y el proyecto de cada trabajo.' }),
    form,
    h('div', { class: 'setlist spaced' },
      h('div', { class: 'setrow' }, h('span', { class: `dot${settings.vaultPath ? '' : ' off'}` }), h('span', { class: 'grow' }, h('b', { text: 'Obsidian' }), h('span', { class: 'm', text: settings.vaultPath ? `${ctx.state.raw?.exportedCount ?? 0} resultados exportados` : 'Sin conectar' }))),
      h('div', { class: 'setrow' }, h('span', { class: `dot${settings.telegram ? '' : ' off'}` }), h('span', { class: 'grow' }, h('b', { text: 'Telegram' }), h('span', { class: 'm', text: settings.telegram ? 'Bot activo en este PC' : 'Configura el bot con el instalador local' })))),
  ];
}

function appearance(ctx) {
  const current = ctx.theme();
  return [
    h('h2', { class: 'seth', text: 'Apariencia' }),
    h('p', { class: 'setp', text: 'Se guarda en este navegador. «Sistema» sigue el modo claro u oscuro del equipo.' }),
    h('div', { class: 'seg fit' }, [['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Sistema']].map(([value, text]) => h('button', { type: 'button', class: `segbtn${current === value ? ' on' : ''}`, 'aria-pressed': String(current === value), text, onclick: () => { ctx.setTheme(value); ctx.rerender(); } }))),
  ];
}

const pending = (title, text) => [h('h2', { class: 'seth', text: title }), h('p', { class: 'setp', text }), h('div', { class: 'empty' }, h('b', { text: 'Pendiente de integrar.' }), ' Mientras tanto se configura como hasta ahora.')];

export function settings(ctx) {
  const tab = TABS.some(([key]) => key === ctx.param) ? ctx.param : 'autoejecucion';
  const content = {
    autoejecucion: () => autoRun(ctx), coordinador: () => coordinator(ctx), obsidian: () => obsidian(ctx), apariencia: () => appearance(ctx),
    modelos: () => pending('Modelos por rol', 'Qué agente, modelo y esfuerzo usa cada etapa. Llega con la PR de modelos (david/modelos); hasta entonces se editan en data/orca-launch-levels.json.'),
    v2: () => pending('Workflow V2 por proyecto', 'Qué proyectos revisa Workflow V2 en lugar del Centro. Llega con la PR de Workflow V2; hasta entonces se configura en data/workflow-v2.json.'),
  }[tab]();
  return {
    toolbar: [h('h1', { text: 'Ajustes' })],
    body: h('div', { class: 'body' },
      h('nav', { class: 'setside', 'aria-label': 'Secciones de ajustes' }, TABS.map(([key, text]) => h('a', { class: `setnav${key === tab ? ' on' : ''}`, href: `#ajustes/${key}`, 'aria-current': key === tab ? 'page' : undefined, text }))),
      h('div', { class: 'scroll' }, h('div', { class: 'col' }, content))),
  };
}
