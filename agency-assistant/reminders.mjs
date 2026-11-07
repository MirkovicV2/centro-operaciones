import { calendarDay } from './domains.mjs';

const DAY_MS = 86_400_000;
export const DEFAULT_TIMEZONE = 'Europe/Madrid';

function shiftDay(date, delta) {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  return shifted.toISOString().slice(0, 10);
}

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
}

function localToUtc(date, time, timezone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 ||
    hour < 0 || hour > 23 || minute < 0 || minute > 59
  ) throw new Error('La fecha u hora no es válida.');

  const target = Date.UTC(year, month - 1, day, hour, minute);
  const calendar = new Date(target);
  if (
    calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) throw new Error('La fecha u hora no es válida.');

  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt++) {
    const shown = localParts(new Date(candidate), timezone);
    const shownAsUtc = Date.UTC(
      shown.year, shown.month - 1, shown.day, shown.hour, shown.minute, shown.second,
    );
    const adjustment = target - shownAsUtc;
    if (adjustment === 0) return new Date(candidate);
    candidate += adjustment;
  }
  throw new Error('Esa hora local no existe por el cambio horario. Elige otra hora.');
}

export function parseReminder(text, now = new Date(), timezone = DEFAULT_TIMEZONE) {
  let input = text.trim().replace(/^\/recordar(?:@\w+)?\s*/i, '');
  input = input.replace(/^(?:recu[eé]rdame|recordarme|recordar)\s+/i, '');
  const match = input.match(
    /^(?:(hoy|mañana)\s+|((?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2}\/\d{4}))\s+)?(?:a\s+las\s+)?(\d{1,2}:\d{2})\s+(.+)$/i,
  );
  if (!match) {
    throw new Error(
      'No entendí fecha, hora y tarea. Prueba: «recuérdame mañana a las 09:30 llamar a Ana» o «/recordar 2026-11-12 16:00 revisar IONOS».',
    );
  }
  const [, relative, explicitDate, time, title] = match;
  const today = calendarDay(now, timezone);
  let date = today;
  if (relative?.toLowerCase() === 'mañana') date = shiftDay(today, 1);
  if (explicitDate) {
    if (explicitDate.includes('/')) {
      const [day, month, year] = explicitDate.split('/');
      date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    } else date = explicitDate;
  }
  const due = localToUtc(date, time, timezone);
  if (due <= now) throw new Error('Esa fecha y hora ya pasó. Indica otra hora o «mañana».');
  const cleanTitle = title.trim();
  if (cleanTitle.length < 3 || cleanTitle.length > 400) {
    throw new Error('La tarea debe tener entre 3 y 400 caracteres.');
  }
  return { title: cleanTitle, dueAt: due.toISOString(), timezone };
}

export function parseTodo(text) {
  const title = text
    .trim()
    .replace(/^\/(?:anotar|pendiente|recordar)(?:@\w+)?\s*/i, '')
    .replace(/^(?:recu[eé]rdame|recordarme|recordar|apunta|anota|tengo que|no olvidar)\s+/i, '')
    .trim();
  if (title.length < 3 || title.length > 400) {
    throw new Error('Escribe la tarea después de /anotar o /pendiente.');
  }
  return title;
}

export function addTask(state, title, due = null, now = new Date()) {
  const task = {
    id: String(state.nextTaskId++),
    title,
    dueAt: due?.dueAt ?? null,
    timezone: due?.timezone ?? null,
    status: 'pending',
    createdAt: now.toISOString(),
    reminderSentAt: null,
    completedAt: null,
  };
  state.tasks.push(task);
  return task;
}

export function pendingTasks(state) {
  return state.tasks
    .filter((task) => task.status === 'pending')
    .sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
}

export function dueTasks(state, now = new Date()) {
  return pendingTasks(state).filter(
    (task) => task.dueAt && !task.reminderSentAt && Date.parse(task.dueAt) <= now.getTime(),
  );
}

export function completeTask(state, id, now = new Date()) {
  const task = state.tasks.find((item) => item.id === id && item.status === 'pending');
  if (!task) throw new Error(`No encuentro una tarea pendiente con ID ${id}.`);
  task.status = 'done';
  task.completedAt = now.toISOString();
  return task;
}

export function formatTask(task) {
  const due = task.dueAt
    ? ` · ${new Intl.DateTimeFormat('es-ES', {
        timeZone: task.timezone || DEFAULT_TIMEZONE,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(task.dueAt))}`
    : ' · sin fecha';
  return `#${task.id} ${task.title}${due}`;
}

export function remainingDays(date, today) {
  const atMidnight = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((atMidnight(date) - atMidnight(today)) / DAY_MS);
}
