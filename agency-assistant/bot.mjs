#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveOperationsRoot } from '../operations-root.mjs';
import { loadState as loadQueue } from '../queue.mjs';
import {
  addDomain,
  archiveDomain,
  daysUntil,
  formatDomain,
  listDomains,
  normalizeDomain,
  nextRenewalMilestone,
  parseDomainAdd,
  updateAutoRenew,
  updateRenewal,
} from './domains.mjs';
import {
  addTask,
  completeTask,
  dueTasks,
  formatTask,
  parseReminder,
  parseTodo,
  pendingTasks,
  remainingDays,
} from './reminders.mjs';
import { acquireInstanceLock, changeState, loadState, ROOT } from './store.mjs';
import { answerQuestion, captureMessage, createIdea, loadDashboardState, markMessageHandled, markQuestionNotified } from './dashboard-state.mjs';

const HELP = `Asistente privado de la agencia

Pendientes:
/anotar preparar propuesta
/recordar mañana a las 09:30 enviar factura
/recordar 2026-11-12 16:00 revisar IONOS
/pendientes
/hecho ID
/ideas — preguntas de los agentes
/responder ID tu respuesta
/mensajes — bandeja del panel
/archivar ID
/idea agencia|videojuegos texto

Los mensajes normales que no sean órdenes también se guardan en la bandeja del panel.

Dominios IONOS:
/dominio agregar cliente | ejemplo.es | cuenta o alias | 2027-04-30 | sí/no/desconocido
/dominios
/renovaciones [días, por defecto 90]
/dominio renovar ejemplo.es AAAA-MM-DD
/dominio auto ejemplo.es sí/no/desconocido
/dominio cuenta ejemplo.es correo o alias
/dominio archivar ejemplo.es

Guarda solo un correo/alias de cuenta, nunca contraseñas, códigos ni datos de pago.`;

const QUEUE_ROOT = resolveOperationsRoot(ROOT);

function commandName(text) {
  return text.trim().split(/\s+/, 1)[0].replace(/@\w+$/, '').toLowerCase();
}

function safeValue(value, max = 240) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function dateOnly(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function domainHelp() {
  return HELP.slice(HELP.indexOf('Dominios IONOS:'));
}

function findActiveDomain(state, raw) {
  const query = normalizeDomain(raw);
  const domain = state.domains.find((item) => item.domain === query && item.status === 'active');
  if (!domain) throw new Error(`No encuentro ${safeValue(raw)} en el inventario activo.`);
  return domain;
}

function parseReminderOrTodo(text, state, now) {
  if (/^(?:\/recordar(?:@\w+)?\b|recu[eé]rdame\b|recordarme\b|recordar\b|(?:hoy|mañana)\s+(?:a\s+las\s+)?\d{1,2}:\d{2}\b|\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}\b)/i.test(text.trim())) {
    try {
      const reminder = parseReminder(text, now);
      const task = addTask(state, reminder.title, reminder, now);
      return `Recordatorio guardado: ${formatTask(task)}.`;
    } catch (error) {
      if (!error.message.startsWith('No entendí fecha, hora y tarea.')) throw error;
      const task = addTask(state, parseTodo(text), null, now);
      return `Anotado sin fecha: ${formatTask(task)}. Para recibir un aviso, añade el día y la hora.`;
    }
  }
  if (/^(?:\/(?:anotar|pendiente)(?:@\w+)?\b|apunta\b|anota\b|tengo que\b|no olvidar\b)/i.test(text.trim())) {
    const task = addTask(state, parseTodo(text), null, now);
    return `Anotado: ${formatTask(task)}. Añade una fecha con /recordar cuando quieras.`;
  }
  return null;
}

function handleDomainCommand(state, text, now) {
  const [, action = '', ...rest] = text.trim().split(/\s+/);
  const argument = text.trim().replace(/^\/dominio(?:@\w+)?\s*/i, '');
  const body = argument.replace(/^(?:agregar|añadir)\s+/i, '');

  if (/^(?:agregar|añadir)\b/i.test(argument)) {
    const item = addDomain(state, parseDomainAdd(body), now);
    return `Dominio añadido: ${formatDomain(item)}. No se guardó ninguna contraseña.`;
  }
  if (action.toLowerCase() === 'renovar') {
    const [domain, date, extra] = rest;
    if (!domain || !date || extra) throw new Error('Formato: /dominio renovar ejemplo.es AAAA-MM-DD.');
    const item = updateRenewal(state, domain, date, now);
    return `Actualizada la renovación: ${formatDomain(item)}.`;
  }
  if (action.toLowerCase() === 'auto') {
    const [domain, status, extra] = rest;
    if (!domain || !status || extra) throw new Error('Formato: /dominio auto ejemplo.es sí/no/desconocido.');
    const item = updateAutoRenew(state, domain, status, now);
    return `Actualizada la auto-renovación: ${formatDomain(item)}.`;
  }
  if (action.toLowerCase() === 'cuenta') {
    const match = argument.match(/^cuenta\s+(\S+)\s+(.+)$/i);
    if (!match) throw new Error('Formato: /dominio cuenta ejemplo.es correo o alias. No incluyas contraseña.');
    const item = findActiveDomain(state, match[1]);
    const accountRef = safeValue(match[2], 160);
    if (!accountRef) throw new Error('Indica el correo o alias de la cuenta.');
    item.accountRef = accountRef;
    item.updatedAt = now.toISOString();
    return `Actualizada la cuenta de ${item.domain}: ${item.accountRef}.`;
  }
  if (action.toLowerCase() === 'archivar') {
    const [domain, extra] = rest;
    if (!domain || extra) throw new Error('Formato: /dominio archivar ejemplo.es.');
    const item = archiveDomain(state, domain, now);
    return `${item.domain} archivado; ya no aparecerá entre los dominios activos.`;
  }
  return domainHelp();
}

function handleCommand(state, text, now = new Date()) {
  const command = commandName(text);
  if (command === '/start' || command === '/ayuda' || command === '/help') return HELP;

  const captured = parseReminderOrTodo(text, state, now);
  if (captured) return captured;

  if (command === '/pendientes' || command === '/tareas') {
    const tasks = pendingTasks(state);
    return tasks.length
      ? `Pendientes (${tasks.length}):\n${tasks.map(formatTask).join('\n')}`
      : 'No tienes tareas pendientes.';
  }
  if (command === '/agenda' || command === '/calendario') {
    const tasks = pendingTasks(state).filter(task => task.dueAt);
    return tasks.length
      ? `Avisos programados (${tasks.length}):\n${tasks.map(formatTask).join('\n')}`
      : 'No tienes avisos con fecha. Usa /recordar mañana a las 09:30 llamar a Ana.';
  }
  if (command === '/hecho') {
    const id = text.trim().split(/\s+/)[1];
    if (!/^\d{1,8}$/.test(id ?? '')) throw new Error('Formato: /hecho ID.');
    const task = completeTask(state, id, now);
    return `Hecho: ${formatTask(task)}.`;
  }
  if (command === '/dominios') {
    const domains = listDomains(state);
    return domains.length
      ? `Dominios IONOS (${domains.length}):\n${domains.map((item) => formatDomain(item, daysUntil(item.renewalDate, dateOnly(now, 'Europe/Madrid')))).join('\n')}`
      : 'El inventario está vacío. Añade uno con /dominio agregar.';
  }
  if (command === '/renovaciones') {
    const daysText = text.trim().split(/\s+/)[1] ?? '90';
    const horizon = Number(daysText);
    if (!Number.isInteger(horizon) || horizon < 1 || horizon > 3650) {
      throw new Error('Indica un horizonte entre 1 y 3650 días.');
    }
    const today = dateOnly(now, 'Europe/Madrid');
    const upcoming = listDomains(state)
      .map((item) => ({ item, remaining: daysUntil(item.renewalDate, today) }))
      .filter(({ remaining }) => remaining <= horizon)
      .sort((a, b) => a.remaining - b.remaining);
    return upcoming.length
      ? `Renovaciones (vencidos y próximos ${horizon} días):\n${upcoming.map(({ item, remaining }) => formatDomain(item, remaining)).join('\n')}`
      : `No hay renovaciones vencidas ni dentro de ${horizon} días.`;
  }
  if (command === '/dominio') return handleDomainCommand(state, text, now);
  return 'No he reconocido eso. Usa /ayuda. Para apuntar algo, empieza con «/anotar» o «recuérdame». ';
}

export function createTelegramClient({ token, fetchImpl = globalThis.fetch }) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body) {
    let response;
    try {
      response = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error('telegram_api_error');
      return result.result;
    } catch {
      throw new Error('No se pudo completar una operación con Telegram.');
    }
  }
  return {
    getMe: () => call('getMe', {}),
    getUpdates: (offset) => call('getUpdates', {
      offset,
      timeout: 20,
      allowed_updates: ['message'],
    }),
    sendMessage: (chatId, text) => call('sendMessage', {
      chat_id: chatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    }),
  };
}

export async function handleUpdate(update, { allowedChatId, now = new Date() } = {}) {
  if (!Number.isInteger(update?.update_id)) return null;
  return changeState(async (state) => {
    if (update.update_id <= state.lastUpdateId) return null;
    const message = update.message;
    let reply = null;
    if (
      message?.chat?.type === 'private' &&
      String(message.chat.id) === String(allowedChatId) &&
      typeof message.text === 'string'
    ) {
      const text = safeValue(message.text, 1000);
      const command = commandName(text);
      if (command === '/ideas') {
        const inbox = await loadDashboardState(QUEUE_ROOT);
        const pending = inbox.questions.filter(item => item.status === 'pending');
        reply = pending.length
          ? `Preguntas pendientes de los agentes:\n${pending.map(item => `${item.id} · ${item.title}: ${item.question}`).join('\n\n')}\n\nResponde con /responder ID tu respuesta.`
          : 'No tienes preguntas de agentes pendientes.';
      } else if (command === '/mensajes') {
        const inbox = await loadDashboardState(QUEUE_ROOT);
        const pending = inbox.messages.filter(item => item.status === 'pending').slice(0, 10);
        reply = pending.length
          ? `Mensajes pendientes (${pending.length}):\n${pending.map(item => `${item.id} · ${item.text.slice(0, 240)}`).join('\n\n')}\n\nMarca uno tratado en el panel.`
          : 'No tienes mensajes pendientes en la bandeja.';
      } else if (command === '/archivar') {
        const id = text.trim().split(/\s+/)[1];
        if (!id) reply = 'Formato: /archivar ID. También puedes marcarlo tratado en el panel.';
        else {
          try { await markMessageHandled(QUEUE_ROOT, id); reply = 'Mensaje marcado como tratado.'; }
          catch (error) { reply = error.message; }
        }
      } else if (command === '/idea') {
        const match = text.match(/^\/idea(?:@\w+)?\s+(agencia|agency|videojuegos|games)\s+([\s\S]+)$/i);
        if (!match) reply = 'Formato: /idea agencia texto, o /idea videojuegos texto.';
        else {
          try {
            const business = /^(?:videojuegos|games)$/i.test(match[1]) ? 'games' : 'agency';
            const idea = await createIdea(QUEUE_ROOT, business, match[2]);
            reply = `Idea guardada en el panel y Obsidian (#${idea.id}).`;
          } catch (error) { reply = error.message; }
        }
      } else if (command === '/responder') {
        const match = text.match(/^\/responder(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
        if (!match) reply = 'Formato: /responder ID tu respuesta.';
        else {
          try {
            const question = await answerQuestion(QUEUE_ROOT, match[1], match[2]);
            reply = question.followUpJobId
              ? `Respuesta guardada para «${safeValue(question.title, 120)}». Continuación en cola: ${safeValue(question.followUpJobId, 80)}. Se ejecutará automáticamente si el modo automático está activado en el panel.`
              : `Respuesta guardada para «${safeValue(question.title, 120)}». Los agentes del mismo negocio podrán consultarla en sus próximas tareas.`;
          } catch (error) { reply = error.message; }
        }
      } else {
        try {
          reply = handleCommand(state, text, now);
          if (reply.startsWith('No he reconocido eso.')) {
            const captured = await captureMessage(QUEUE_ROOT, text, 'Telegram');
            reply = `Guardado en la bandeja del panel${captured.notePath ? ' y en Obsidian' : ''} (#${captured.id}). Puedes revisarlo en Ideas o usar /mensajes.`;
          }
        }
        catch (error) { reply = error.message; }
      }
    }
    state.lastUpdateId = update.update_id;
    return reply;
  });
}

async function notifyScheduled(client, chatId, now = new Date()) {
  const state = await loadState();
  for (const task of dueTasks(state, now)) {
    await client.sendMessage(chatId, `Recordatorio: ${formatTask(task)}`);
    await changeState((current) => {
      const item = current.tasks.find((entry) => entry.id === task.id);
      if (item && item.status === 'pending' && !item.reminderSentAt) item.reminderSentAt = now.toISOString();
    });
  }

  const today = dateOnly(now, 'Europe/Madrid');
  for (const domain of listDomains(state)) {
    const remaining = daysUntil(domain.renewalDate, today);
    const milestone = nextRenewalMilestone(remaining, domain.sentMilestones ?? []);
    if (milestone === null) continue;
    const label = remaining < 0
      ? `${Math.abs(remaining)} días vencido`
      : remaining === 0
        ? 'vence hoy'
        : `faltan ${remaining} días`;
    await client.sendMessage(chatId, `Renovación IONOS: ${domain.domain} (${domain.client}); ${label}. Cuenta: ${domain.accountRef}.`);
    await changeState((current) => {
      const item = current.domains.find((entry) => entry.id === domain.id && entry.status === 'active');
      if (item && item.renewalDate === domain.renewalDate) {
        item.sentMilestones ??= [];
        if (!item.sentMilestones.includes(milestone)) item.sentMilestones.push(milestone);
      }
    });
  }

  const inbox = await loadDashboardState(QUEUE_ROOT);
  for (const question of inbox.questions.filter(item => item.status === 'pending' && !item.notifiedAt).slice(0, 5)) {
    await client.sendMessage(
      chatId,
      `El agente necesita tu idea (${question.id})\n${safeValue(question.title, 180)}\n\n${safeValue(question.question, 1800)}\n\nResponde con /responder ${safeValue(question.id, 80)} tu respuesta.`,
    );
    await markQuestionNotified(QUEUE_ROOT, question.id);
  }

  if (process.env.TELEGRAM_NOTIFY_QUEUE !== 'false') {
    const queue = await loadQueue(QUEUE_ROOT);
    for (const job of queue.jobs.filter((item) => item.state === 'needs_attention')) {
      const key = `${job.id}:${job.attempts}`;
      if (state.notifiedQueueEvents.includes(key)) continue;
      await client.sendMessage(
        chatId,
        `Un trabajo necesita tu revisión: «${safeValue(job.title, 200)}» (ID ${safeValue(job.id, 80)}). Revisa el estado en el centro de operaciones antes de reintentar.`,
      );
      await changeState((current) => {
        if (!current.notifiedQueueEvents.includes(key)) current.notifiedQueueEvents.push(key);
        current.notifiedQueueEvents = current.notifiedQueueEvents.slice(-500);
      });
      state.notifiedQueueEvents.push(key);
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendReply(client, chatId, text) {
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if (chunk && chunk.length + line.length + 1 > 3800) {
      await client.sendMessage(chatId, chunk);
      chunk = '';
    }
    const piece = line.length > 3800 ? `${line.slice(0, 3790)}…` : line;
    chunk = chunk ? `${chunk}\n${piece}` : piece;
  }
  if (chunk) await client.sendMessage(chatId, chunk);
}

export async function runBot({ env = process.env, clientFactory = createTelegramClient, log = console } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedChatId = env.TELEGRAM_ALLOWED_CHAT_ID?.trim();
  if (!token || !allowedChatId) {
    throw new Error('Configura TELEGRAM_BOT_TOKEN y TELEGRAM_ALLOWED_CHAT_ID en el entorno; no los guardes en Git.');
  }

  const releaseLock = await acquireInstanceLock();
  const client = clientFactory({ token });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const me = await client.getMe();
    log.log(`Asistente conectado como @${safeValue(me.username, 80)}. Solo atenderá el chat privado configurado.`);
    let lastNotificationCheck = 0;
    while (!stopping) {
      const state = await loadState();
      try {
        const updates = await client.getUpdates(state.lastUpdateId + 1);
        for (const update of updates) {
          const reply = await handleUpdate(update, { allowedChatId });
          if (reply) await sendReply(client, allowedChatId, reply);
        }
        if (Date.now() - lastNotificationCheck >= 20_000) {
          await notifyScheduled(client, allowedChatId);
          lastNotificationCheck = Date.now();
        }
      } catch (error) {
        log.warn(error.message === 'El registro local no es válido; no se sobrescribirá.'
          ? error.message
          : 'No se pudo consultar Telegram o entregar un aviso; se reintentará en cinco segundos.');
        await delay(5000);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await releaseLock();
  }
}

export async function discoverChat({ env = process.env, clientFactory = createTelegramClient, log = console } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error('Configura TELEGRAM_BOT_TOKEN en el entorno; no lo guardes en Git.');
  const releaseLock = await acquireInstanceLock();
  try {
    const client = clientFactory({ token });
    const updates = await client.getUpdates(0);
    const chatIds = [...new Set(updates
      .filter((update) => update.message?.chat?.type === 'private')
      .map((update) => String(update.message.chat.id)))];
    if (!chatIds.length) {
      log.log('No veo mensajes privados pendientes. Escribe /start al bot y vuelve a ejecutar --discover-chat.');
      return [];
    }
    log.log(`Chat privado detectado. Guárdalo localmente en TELEGRAM_ALLOWED_CHAT_ID: ${chatIds.join(', ')}`);
    return chatIds;
  } finally {
    await releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const action = process.argv.includes('--discover-chat') ? discoverChat : runBot;
  action().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
