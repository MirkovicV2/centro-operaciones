// Screens of the new panel, built as in the approved mockups. Each view returns { toolbar, body }.
import { h, icon, pill, pv, mono, initial, when, duration, stageTrack, statusNames, stepNames, levelText, jobTone, relativeTime } from './lib.js';
import { attentionItems, lifecycle, jobActions, api } from './domain.js';

const reportFor = (data, jobId) => (data.requestTraces || []).flatMap(trace => trace.reports || []).find(item => item.jobId === jobId);
const integrationFor = (data, job) => job?.autoIntent?.eligible ? data.automation?.integrations?.[job.autoIntent.receiptId] : null;
const receiptFor = (data, job) => data.automation?.receipts?.find(item => item.jobId === job.id);
const stepLabel = job => job.workflow?.steps?.find(step => step.key === job.workflow?.currentStage)?.label || job.workflow?.currentStage || 'sin confirmar';
const go = hash => () => { location.hash = hash; };

function section(title, count, link, rows, empty) {
  return h('section', { class: 'sec' },
    h('div', { class: 'sech' }, title, count !== undefined ? h('span', { class: 'n', text: String(count) }) : null, link ? h('a', { href: link[1], text: link[0] }) : null),
    rows.length ? rows : h('div', { class: 'empty' }, h('b', { text: empty[0] }), empty[1]));
}
function jobRow(job, extra) {
  return h('a', { class: 'row', href: `#trabajo/${encodeURIComponent(job.id)}` },
    initial(job.projectName || job.title),
    h('span', { class: 'grow' }, h('span', { class: 't', text: job.title }), h('span', { class: 'm' }, mono(`#${job.id}`), ` · ${extra || job.projectName || ''}`)),
    h('span', { class: 'right' }, h('span', { class: `now now-${jobTone(job.state)}`, text: job.state === 'running' ? `Etapa: ${stepLabel(job)}` : statusNames[job.state] }), stageTrack(job.workflow?.steps)),
    when(job.finishedAt || job.startedAt || job.createdAt));
}

// ---------------------------------------------------------------- Overview
export function overview(ctx) {
  const { data } = ctx;
  const items = attentionItems(data);
  const running = data.jobs.filter(job => job.state === 'running');
  const queued = data.jobs.filter(job => ['queued', 'retry_wait'].includes(job.state));
  const delivered = data.jobs.filter(job => job.state === 'succeeded').sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt))).slice(0, 5);
  const traces = (data.requestTraces || []).filter(trace => trace.status !== 'withdrawn');
  const summary = h('div', { class: 'summary' },
    h('span', {}, h('b', { text: String(running.length) }), 'en curso'),
    h('span', { class: 'warnn' }, h('b', { text: String(items.length) }), 'esperan tu decisión'),
    h('span', {}, h('b', { text: String(queued.length) }), 'en cola'),
    h('span', {}, h('b', { text: String(delivered.length) }), 'entregados'));
  const attentionRows = items.slice(0, 6).map(item => h('a', { class: 'row', href: '#atencion/' + encodeURIComponent(item.id) },
    h('span', { class: `kind kind-${item.tone}` }, icon(item.kind === 'question' ? 'question' : item.kind === 'notice' ? 'alert' : 'stop', 14)),
    h('span', { class: 'grow' }, h('span', { class: 't', text: item.title }), h('span', { class: 'm', text: [item.label, item.context, item.run && `#${item.run}`].filter(Boolean).join(' · ') })),
    item.at ? when(item.at) : null));
  const body = h('div', { class: 'body' },
    h('div', { class: 'scroll' }, h('div', { class: 'col' },
      summary,
      section('Necesita tu atención', items.length, ['Abrir Atención', '#atencion'], attentionRows, ['Nada te espera.', ' No hay trabajos detenidos, preguntas ni avisos pendientes.']),
      section('En curso', running.length, ['Ver trabajos', '#trabajos'], running.map(job => jobRow(job)), ['Sin trabajos en marcha.', ' La cola está quieta en este negocio.']),
      section('Siguiente paso', queued.length, null, queued.map(job => jobRow(job, data.automation?.receipts?.find(item => item.jobId === job.id)?.reason || (job.autoIntent?.eligible ? 'Cola automática' : 'Cola manual'))), ['Nada en cola.', ' Escribe al coordinador o captura una idea para empezar.']),
      section('Entregados', delivered.length, ['Historial', '#historial'], delivered.map(job => jobRow(job, 'Entregado localmente')), ['Aún no hay entregas.', ' Aparecerán aquí al terminar los trabajos.']))),
    h('aside', { class: 'panel', 'aria-label': 'Proyectos y actividad' },
      h('h2', { class: 'ph', text: 'Proyectos' }),
      (data.projects || []).filter(project => project.status !== 'completed').map(project => {
        const active = data.jobs.find(job => job.projectId === project.id && ['running', 'needs_attention'].includes(job.state));
        return h('a', { class: 'proj', href: '#proyectos' },
          h('span', { class: 'top' }, initial(project.name), project.name, h('span', { class: 'br', text: project.stage || '' })),
          h('span', { class: 'act', text: active ? `#${active.id} · ${statusNames[active.state]}` : 'Sin trabajos activos' }),
          project.nextAction ? h('span', { class: 'act soft', text: `Siguiente: ${project.nextAction}` }) : null,
          h('span', { class: 'pvl' }, pv(project.checkout ? 'observed' : 'unknown'), project.checkout ? 'Checkout configurado' : 'Sin checkout'));
      }),
      (data.projects || []).length ? null : h('p', { class: 'soft small', text: 'Sin proyectos en este negocio.' }),
      h('div', { class: 'feed' }, h('h2', { class: 'ph', text: 'Actividad' }),
        traces.flatMap(trace => (trace.events || []).map(event => ({ ...event, title: trace.title }))).filter(event => event.at)
          .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6)
          .map(event => h('div', { class: 'it' }, h('span', { class: 'grow', text: `${event.label || event.kind || 'Evento'} · ${event.title || ''}` }), when(event.at, 'it-when'))))));
  return {
    toolbar: [h('h1', { text: 'Overview' }), h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'search', onclick: () => ctx.openSearch() }, icon('search', 14), h('span', { text: 'Buscar o saltar a…' }), h('kbd', { text: 'Ctrl K' })),
      h('a', { class: 'btn primary', href: '/#trabajos' }, icon('plus', 13), 'Nuevo trabajo')],
    body,
  };
}

// ---------------------------------------------------------------- Atención
export function attention(ctx) {
  const { data, param } = ctx;
  const items = attentionItems(data);
  const selected = items.find(item => item.id === param) || items[0];
  const groups = [...new Set(items.map(item => item.group))];
  const list = h('div', { class: 'alist', 'aria-label': 'Asuntos' },
    items.length ? groups.map(group => [h('div', { class: 'agl', text: group }),
      items.filter(item => item.group === group).map(item => h('a', { class: `arow${item === selected ? ' sel' : ''}`, href: '#atencion/' + encodeURIComponent(item.id), 'aria-current': item === selected ? 'true' : undefined },
        h('span', { class: `kind kind-${item.tone}` }, icon(item.kind === 'question' ? 'question' : item.kind === 'notice' ? 'alert' : 'stop', 14)),
        h('span', { class: 'grow' }, h('span', { class: 't', text: item.title }), h('span', { class: 'm', text: [item.context, item.at && relativeTime(item.at)].filter(Boolean).join(' · ') }))))])
      : h('div', { class: 'empty pad' }, h('b', { text: 'Bandeja vacía.' }), ' Nada requiere tu atención ahora mismo.'));
  let detail = h('div', { class: 'col' });
  if (selected) {
    const actions = [];
    if (selected.job) actions.push(...jobActions(selected.job, data, receiptFor(data, selected.job), ctx.confirm, ctx.done), h('a', { class: 'btn', href: `#trabajo/${encodeURIComponent(selected.job.id)}`, text: 'Abrir la ficha' }));
    let reply = null;
    if (selected.question) {
      const area = h('textarea', { id: 'answer', rows: 3, placeholder: 'Tu criterio o respuesta…' });
      const send = h('button', { type: 'button', class: 'btn primary', text: 'Responder' });
      send.addEventListener('click', async () => {
        if (!area.value.trim()) return area.focus();
        send.disabled = true;
        try { await api(`/api/questions/${encodeURIComponent(selected.question.id)}/answer`, { method: 'POST', body: JSON.stringify({ answer: area.value }) }); await ctx.done('Respuesta guardada.'); }
        catch (error) { await ctx.done(error.message, true); send.disabled = false; }
      });
      reply = h('div', { class: 'reply' }, h('label', { class: 'lab', for: 'answer', text: 'Tu respuesta' }), area, h('div', { class: 'actions' }, send, h('span', { class: 'ro', text: 'Queda con las decisiones del encargo' })));
    }
    detail = h('div', { class: 'col adetail' },
      h('div', { class: 'kicker' }, h('span', { class: `kind kind-${selected.tone}` }, icon('stop', 12)), [selected.label, selected.context, selected.run && `#${selected.run}`].filter(Boolean).join(' · '), h('span', { class: 'spacer' }), selected.at ? when(selected.at) : null),
      h('h2', { class: 'title', text: selected.title }),
      selected.job ? stageTrack(selected.job.workflow?.steps) : null,
      h('div', { class: 'lab', text: 'Qué ocurrió' }), h('p', { text: selected.what }),
      h('div', { class: 'lab', text: 'Por qué te necesita' }), h('p', { text: selected.why }),
      h('div', { class: 'lab', text: 'Dónde se decide' }), h('p', { text: selected.where }),
      selected.evidence.length ? [h('div', { class: 'lab', text: 'Evidencia' }), h('div', { class: 'evlist' }, selected.evidence.map(entry => h('div', { class: 'ev' }, entry.label, h('span', { class: 'pvl' }, pv(entry.level), levelText[entry.level]))))] : null,
      reply,
      actions.length ? h('div', { class: 'actions top' }, actions) : null,
      h('div', { class: 'ro-note', text: 'Cada acción pide confirmación y queda en el registro del Centro.' }));
  }
  return { toolbar: [h('h1', { text: 'Atención' }), h('span', { class: 'spacer' }), h('span', { class: 'srcline', text: `${items.length} ${items.length === 1 ? 'asunto' : 'asuntos'}` })], body: h('div', { class: 'body' }, list, h('div', { class: 'scroll' }, detail)) };
}

// ---------------------------------------------------------------- Trabajos (ficha con lista)
export function jobs(ctx) {
  const { data, param, state } = ctx;
  const order = { needs_attention: 0, running: 1, queued: 2, retry_wait: 2, succeeded: 3, cancelled: 4 };
  const sorted = [...data.jobs].sort((a, b) => (order[a.state] ?? 5) - (order[b.state] ?? 5) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const job = sorted.find(item => item.id === param) || sorted[0];
  const list = h('nav', { class: 'runlist', 'aria-label': 'Trabajos' }, sorted.length ? sorted.map(item => h('a', { class: `rlrow${item === job ? ' sel' : ''}`, href: `#trabajo/${encodeURIComponent(item.id)}`, 'aria-current': item === job ? 'page' : undefined },
    h('span', { class: 't', text: item.title }),
    h('span', { class: 'm' }, initial(item.projectName || item.title), mono(`#${item.id}`), h('span', { class: 'spacer' }), stageTrack(item.workflow?.steps)),
    h('span', { class: `rls rls-${jobTone(item.state)}`, text: statusNames[item.state] || item.state })))
    : h('div', { class: 'empty pad' }, h('b', { text: 'Sin trabajos todavía.' }), ' Crea uno desde «Nuevo trabajo».'));
  if (!job) return { toolbar: [h('h1', { text: 'Trabajos' })], body: h('div', { class: 'body' }, list, h('div', { class: 'scroll' }, h('div', { class: 'col' }))) };
  const report = reportFor(data, job.id), integration = integrationFor(data, job), receipt = receiptFor(data, job);
  const showWords = state.provenance;
  const withPv = (level, ...content) => [pv(level), ...content, showWords ? h('span', { class: 'provtext', text: levelText[level] }) : null];
  const objective = report?.asked?.objective || job.contract?.objective || job.prompt;
  const findings = (job.workflow?.steps || []).flatMap(step => (step.delivery?.findings || []).map(finding => ({ ...finding, stage: step.label })));
  const main = h('div', { class: 'col run' },
    h('div', { class: 'proj-line' }, initial(job.projectName || job.title), job.projectName || '', h('span', { class: 'dim', text: '·' }), h('span', { class: `now now-${jobTone(job.state)}`, text: statusNames[job.state] || job.state })),
    h('h2', { class: 'title', id: 'run-title', text: job.title }),
    h('div', { class: 'meta' }, mono(`#${job.id}`), job.branch ? h('span', {}, 'Rama ', mono(job.branch)) : null, job.destination?.baseBranch ? h('span', {}, 'Base ', mono(job.destination.baseBranch)) : null, h('span', { text: `Creado ${relativeTime(job.createdAt)}` }), h('span', { text: `Intento ${job.attempts}/${job.maxAttempts}` })),
    objective ? h('div', { class: 'objective' }, h('span', { class: 'lab2', text: 'Objetivo' }), h('p', { text: objective })) : null,
    h('div', { class: 'lifebar', role: 'list', 'aria-label': 'Ejecución, revisión, aceptación e integración' },
      lifecycle(job, report, integration).map(cell => h('div', { class: `life life-${cell.tone}`, role: 'listitem' },
        h('span', { class: 'k' }, cell.k, pv(cell.level)), h('span', { class: 's', text: cell.state }), cell.note ? h('span', { class: 'note', text: cell.note }) : null,
        showWords ? h('span', { class: 'provtext', text: levelText[cell.level] }) : null))),
    job.state === 'needs_attention' ? h('div', { class: 'callout' }, h('span', { class: 'ic' }, icon('question', 15)), h('div', {},
      h('h4', { text: 'Este trabajo espera tu decisión' }), h('p', { text: job.error?.message || 'Revisa la etapa y sus informes antes de continuar.' }),
      data.executor?.reason ? h('p', { class: 'soft small', text: data.executor.reason }) : null,
      h('div', { class: 'actions' }, jobActions(job, data, receipt, ctx.confirm, ctx.done)))) : null,
    h('div', { class: 'h3' }, 'Etapas', h('span', { class: 'n', text: 'derivadas del trabajo real' })),
    (job.workflow?.steps || []).filter(step => step.status !== 'skipped').map((step, index) => h('div', { class: `stage stage-${step.status}` },
      h('span', { class: 'num', text: String(index + 1) }),
      h('div', {}, h('div', {}, h('span', { class: 'who', text: step.label }), step.profile ? h('span', { class: 'what', text: ` · ${step.profile}` }) : null),
        h('dl', { class: 'kv' },
          h('dt', { text: 'Modelo' }), h('dd', {}, step.launch ? withPv('observed', mono([step.launch.agent, step.launch.model].filter(Boolean).join(' · ')), step.launch.effort ? ` · esfuerzo ${step.launch.effort}` : '') : withPv('unknown', 'No registrado')),
          step.authorization ? [h('dt', { text: 'Autorizado por' }), h('dd', {}, withPv('observed', step.authorization.coordinatorName || 'coordinador'))] : null,
          step.dispatchId ? [h('dt', { text: 'Dispatch' }), h('dd', {}, withPv('observed', mono(step.dispatchId)))] : null),
        (step.delivery?.summary || step.summary) ? h('details', { class: 'report', 'data-key': `${job.id}-${step.key}` }, h('summary', { text: 'Informe de la etapa' }), h('pre', { text: step.delivery?.summary || step.summary })) : null),
      h('div', { class: 'tm' }, pill({ succeeded: 'ok', running: 'accent', blocked: 'danger', failed: 'danger' }[step.status] || 'muted', stepNames[step.status] || step.status)))),
    h('div', { class: 'h3' }, 'Revisión', h('span', { class: 'n', text: findings.length ? `${findings.filter(f => f.severity === 'blocking').length} bloqueantes · ${findings.filter(f => f.severity !== 'blocking').length} menores` : 'sin hallazgos' })),
    findings.length ? findings.map((finding, index) => h('div', { class: 'find' }, mono(`F${index + 1}`), h('div', {}, h('div', { class: 'tx', text: finding.summary || '' }), h('div', { class: 'mono loc', text: [finding.stage, finding.evidence].filter(Boolean).join(' · ') })), h('span', { class: 'fr' }, pill(finding.severity === 'blocking' ? 'danger' : 'muted', finding.severity === 'blocking' ? 'Bloqueante' : 'Menor'), pv('reported'))))
      : h('div', { class: 'empty' }, h('b', { text: 'Sin hallazgos registrados.' }), ' Aparecerán cuando la Revisión entregue su informe.'),
    report?.criteria?.length ? [h('div', { class: 'h3' }, 'Criterios del encargo'), report.criteria.map(item => h('div', { class: 'crit' }, pv(item.level), h('span', { class: 'grow', text: item.criterion }), pill(item.status === 'passed' ? 'ok' : item.status === 'failed' ? 'danger' : 'unknown', item.status === 'passed' ? 'Cumple' : item.status === 'failed' ? 'No cumple' : 'Sin verificar')))] : null,
    job.result?.text ? h('details', { class: 'report', 'data-key': `${job.id}-result` }, h('summary', { text: 'Resultado completo' }), h('pre', { text: job.result.text })) : null);
  const prop = (k, v, level) => v ? h('div', { class: 'prop' }, h('dt', { text: k }), h('dd', {}, level ? pv(level) : null, v)) : null;
  const side = h('aside', { class: 'panel', 'aria-label': 'Propiedades' },
    h('h2', { class: 'ph', text: 'Propiedades' }),
    h('dl', { class: 'props' }, prop('Proyecto', job.projectName), prop('Tipo', job.kind === 'code' ? 'Código' : 'Análisis'), prop('Estado', statusNames[job.state], 'observed'), prop('Duración', duration(job)),
      prop('Proveedor', job.provider), prop('Creado por', job.actor), prop('Checkout', job.workspace), prop('Destino', job.destination?.repository), prop('Recibo', job.autoIntent?.receiptId), prop('Tokens y coste', 'Sin registro fiable', 'unknown')),
    report ? h('p', { class: 'soft small', text: `${report.totals.observed} comprobados · ${report.totals.reported} declarados · ${report.totals.unknown} sin registro` }) : null,
    h('div', { class: 'legend' }, ['observed', 'reported', 'unknown', 'na'].map(level => h('span', { class: 'pvl' }, pv(level), levelText[level])), h('p', { text: 'La marca dice de dónde sale un dato, no si es bueno.' })));
  const toggle = h('button', { type: 'button', class: `tog${showWords ? ' on' : ''}`, 'aria-pressed': String(Boolean(showWords)), onclick: () => { state.provenance = !state.provenance; ctx.rerender(); } }, pv('observed'), 'Procedencia');
  return {
    toolbar: [h('div', { class: 'crumb' }, h('a', { href: '#trabajos', text: 'Trabajos' }), icon('chevron', 12), h('b', { class: 'mono', text: `#${job.id}` })), h('span', { class: 'spacer' }), toggle, h('a', { class: 'btn', href: `/#trabajos`, text: 'Ver en el panel clásico' })],
    body: h('div', { class: 'body' }, list, h('div', { class: 'scroll' }, main), side),
  };
}

// ---------------------------------------------------------------- Historial e informes
export function history(ctx) {
  const { data, param } = ctx;
  const closed = data.jobs.filter(job => ['succeeded', 'cancelled'].includes(job.state)).sort((a, b) => String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)));
  const selected = closed.find(job => job.id === param) || closed[0];
  const groups = new Map();
  for (const job of closed) { const day = relativeTime(job.finishedAt).startsWith('hace') || relativeTime(job.finishedAt) === 'ahora' ? 'Hoy' : relativeTime(job.finishedAt) === 'ayer' ? 'Ayer' : relativeTime(job.finishedAt); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(job); }
  const table = h('div', { class: 'col wide' },
    h('div', { class: 'hhead' }, h('span', { text: 'Trabajo' }), h('span', { text: 'Resultado' }), h('span', { text: 'Duración' }), h('span', { class: 'models', text: 'Modelos' }), h('span', {})),
    closed.length ? [...groups].map(([day, jobs]) => [h('div', { class: 'hday', text: day }), jobs.map(job => h('a', { class: `hrow${job === selected ? ' sel' : ''}`, href: '#historial/' + encodeURIComponent(job.id), 'aria-current': job === selected ? 'true' : undefined },
      h('span', { class: 'grow' }, h('span', { class: 't', text: job.title }), h('span', { class: 'm' }, initial(job.projectName || job.title), `${job.projectName || ''} · `, mono(`#${job.id}`))),
      h('span', {}, pill(job.state === 'succeeded' ? 'ok' : 'muted', statusNames[job.state])),
      h('span', { class: 'num', text: duration(job) }),
      h('span', { class: 'mono models', text: [...new Set((job.workflow?.steps || []).map(step => step.launch?.model).filter(Boolean))].join(' · ') || 'No registrados' }),
      pv('unknown')))])
      : h('div', { class: 'empty' }, h('b', { text: 'Sin trabajos cerrados.' }), ' Aparecerán aquí al terminar o cancelarse.'),
    h('p', { class: 'soft small pvl', style: { marginTop: '14px' } }, pv('unknown'), 'Tokens y coste por trabajo: sin registro fiable todavía. No se estiman.'));
  let panel = h('aside', { class: 'panel', 'aria-label': 'Informe' }, h('p', { class: 'soft', text: 'Elige un trabajo para ver su informe.' }));
  if (selected) {
    const report = reportFor(data, selected.id);
    const rows = [['Estado', statusNames[selected.state], 'observed'],
      ...(selected.workflow?.steps || []).map(step => [step.label, `${stepNames[step.status] || step.status}${step.launch?.model ? ` · ${step.launch.model}` : ''}`, step.dispatchId ? 'observed' : 'unknown']),
      ...(report?.criteria || []).map(item => ['Criterio', `${item.criterion} · ${item.status === 'passed' ? 'cumple' : item.status === 'failed' ? 'no cumple' : 'sin verificar'}`, item.level]),
      ...(report?.integration?.applies ? report.integration.facts.map(item => [item.label, item.value, item.level]) : [['Integración', 'Manual · fuera del Centro', 'na']]),
      ['Tokens y coste', 'Sin registro fiable', 'unknown']];
    panel = h('aside', { class: 'panel', 'aria-label': 'Informe' },
      h('h2', { class: 'ph flex' }, 'Informe', h('span', { class: 'mono soft', text: `#${selected.id}` })),
      h('div', { class: 'rtitle', text: selected.title }),
      h('dl', { class: 'rep' }, rows.map(([k, v, level]) => h('div', { class: 'r' }, h('dt', { text: k }), h('dd', { text: v }), pv(level)))),
      report ? h('p', { class: 'soft small', text: `${report.totals.observed} comprobados · ${report.totals.reported} declarados · ${report.totals.unknown} sin registro` }) : null,
      h('a', { class: 'btn block', href: `#trabajo/${encodeURIComponent(selected.id)}`, text: 'Abrir la ficha' }));
  }
  return { toolbar: [h('h1', { text: 'Historial e informes' }), h('span', { class: 'spacer' }), h('span', { class: 'srcline', text: `${closed.length} cerrados` })], body: h('div', { class: 'body' }, h('div', { class: 'scroll' }, table), panel) };
}

// ---------------------------------------------------------------- Pantallas aún en el panel clásico
export function classic(title, hash, text) {
  return () => ({
    toolbar: [h('h1', { text: title })],
    body: h('div', { class: 'body' }, h('div', { class: 'scroll' }, h('div', { class: 'col' },
      h('div', { class: 'hfempty' }, h('div', {}, h('h3', { text: `${title} todavía está en el panel clásico` }),
        h('p', { text: text }), h('a', { class: 'btn primary', href: `/${hash}` }, `Abrir ${title} en el panel clásico`, icon('external', 12))))))),
  });
}
