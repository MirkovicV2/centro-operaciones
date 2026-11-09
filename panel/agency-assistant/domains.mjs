import { domainToASCII } from 'node:url';

const AUTO_RENEW = new Map([
  ['si', 'sí'],
  ['sí', 'sí'],
  ['yes', 'sí'],
  ['no', 'no'],
  ['desconocido', 'desconocido'],
  ['?', 'desconocido'],
]);

export function normalizeDomain(value) {
  const input = value.trim().replace(/\.$/, '');
  if (!input || /[/:\s@]/.test(input)) throw new Error('Escribe solo el dominio, sin protocolo ni ruta.');
  const domain = domainToASCII(input.toLowerCase());
  if (
    !domain ||
    domain.length > 253 ||
    !domain.includes('.') ||
    domain.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('El nombre de dominio no parece válido.');
  }
  return domain;
}

export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseDomainAdd(text) {
  const fields = text.split('|').map((field) => field.trim());
  if (fields.length !== 5) {
    throw new Error(
      'Formato: /dominio agregar cliente | dominio | cuenta IONOS o alias | renovación AAAA-MM-DD | auto sí/no/desconocido. No incluyas contraseñas.',
    );
  }
  const [client, rawDomain, accountRef, renewalDate, autoRenewText] = fields;
  const domain = normalizeDomain(rawDomain);
  const autoRenew = AUTO_RENEW.get(autoRenewText.toLowerCase());
  if (!client || client.length > 120) throw new Error('El cliente debe tener entre 1 y 120 caracteres.');
  if (!accountRef || accountRef.length > 160) throw new Error('Indica un correo de acceso o alias reconocible de la cuenta IONOS. No incluyas su contraseña.');
  if (!validDate(renewalDate)) throw new Error('La renovación debe tener formato AAAA-MM-DD y ser una fecha real.');
  if (!autoRenew) throw new Error('La renovación automática debe ser sí, no o desconocido.');
  return { client, domain, accountRef, renewalDate, autoRenew };
}

export function addDomain(state, input, now = new Date()) {
  if (state.domains.some((item) => item.domain === input.domain && item.status === 'active')) {
    throw new Error(`Ya existe ${input.domain} en el inventario.`);
  }
  const item = {
    id: String(state.nextDomainId++),
    ...input,
    status: 'active',
    sentMilestones: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  state.domains.push(item);
  return item;
}

function findDomain(state, rawDomain) {
  const domain = normalizeDomain(rawDomain);
  const item = state.domains.find((entry) => entry.domain === domain && entry.status === 'active');
  if (!item) throw new Error(`No encuentro ${domain} en el inventario activo.`);
  return item;
}

export function updateRenewal(state, rawDomain, renewalDate, now = new Date()) {
  if (!validDate(renewalDate)) throw new Error('La renovación debe tener formato AAAA-MM-DD y ser una fecha real.');
  const item = findDomain(state, rawDomain);
  item.renewalDate = renewalDate;
  item.sentMilestones = [];
  item.updatedAt = now.toISOString();
  return item;
}

export function updateAutoRenew(state, rawDomain, value, now = new Date()) {
  const autoRenew = AUTO_RENEW.get(value.trim().toLowerCase());
  if (!autoRenew) throw new Error('Usa sí, no o desconocido.');
  const item = findDomain(state, rawDomain);
  item.autoRenew = autoRenew;
  item.updatedAt = now.toISOString();
  return item;
}

export function archiveDomain(state, rawDomain, now = new Date()) {
  const item = findDomain(state, rawDomain);
  item.status = 'archived';
  item.updatedAt = now.toISOString();
  return item;
}

export function listDomains(state) {
  return state.domains
    .filter((item) => item.status === 'active')
    .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate) || a.domain.localeCompare(b.domain));
}

export function calendarDay(now, timezone = 'Europe/Madrid') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function daysUntil(date, today) {
  const dayNumber = (value) => {
    const [year, month, day] = value.split('-').map(Number);
    return Date.UTC(year, month - 1, day) / 86_400_000;
  };
  return dayNumber(date) - dayNumber(today);
}

export function nextRenewalMilestone(daysRemaining, sentMilestones) {
  if (daysRemaining < 0) return sentMilestones.includes(-1) ? null : -1;
  for (const milestone of [0, 1, 7, 30]) {
    if (daysRemaining <= milestone && !sentMilestones.includes(milestone)) return milestone;
  }
  return null;
}

export function formatDomain(item, daysRemaining = null) {
  const auto = { sí: 'auto-renovación sí', no: 'auto-renovación no', desconocido: 'auto-renovación sin confirmar' }[item.autoRenew];
  const timing = daysRemaining === null
    ? ''
    : daysRemaining < 0
      ? ` · venció hace ${Math.abs(daysRemaining)} días`
      : daysRemaining === 0
        ? ' · renueva hoy'
        : ` · faltan ${daysRemaining} días`;
  return `${item.domain} · ${item.client} · ${item.renewalDate}${timing} · ${auto} · cuenta: ${item.accountRef}`;
}
