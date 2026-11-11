import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replaceLocalFile } from './atomic-file.mjs';
import { LAUNCH_AGENTS } from './launch-choice.mjs';

// Subscriptions and the personal reserve. data/quota.json is local to each PC (each person has their own accounts).
// The Centro cannot ask a subscription for its balance: what it knows is what was observed and written here (by
// the owner from the provider's own usage screen, or by the engine when a worker stops on a limit). So every
// answer carries how it is known, and "no recent observation" is a state of its own, never treated as "plenty left".
//
// Policy, all explicit:
//   reservaPersonalPorcentaje   share of each subscription the Centro never spends (10 at least)
//   avisoPorcentaje             usage from which the panel warns
//   caducidadObservacionHoras   after this, an observation no longer counts
//   sinDatos                    admitir (with a visible warning) | esperar
//   alAgotar                    esperar | sustituir (only to a provider that is available and on a subscription)
// The Centro never buys, tops up or switches a provider to paid API billing: those stay human decisions.
export const QUOTA_FILE = 'quota.json';
export const MIN_RESERVE = 10;
export const DEFAULT_QUOTA = Object.freeze({ reservaPersonalPorcentaje: MIN_RESERVE, avisoPorcentaje: 75, caducidadObservacionHoras: 6, sinDatos: 'admitir', alAgotar: 'esperar',
  sustituciones: Object.freeze({}), proveedores: Object.freeze({}) });
const AUTH = ['suscripcion', 'api', 'desconocida'];
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isDate = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

export class QuotaError extends Error {
  constructor(message) { super(`data/${QUOTA_FILE}: ${message}`); this.code = 'quota_config_invalid'; }
}
const fail = message => { throw new QuotaError(message); };

function normalizeProvider(value, agent) {
  if (!isObject(value)) fail(`proveedores.${agent} debe ser un objeto.`);
  const unknown = Object.keys(value).find(key => !['autenticacion', 'usadoPorcentaje', 'reiniciaEn', 'observadoEn', 'fuente', 'agotadaHasta', 'inferida'].includes(key));
  if (unknown) fail(`proveedores.${agent}: campo desconocido ${unknown}.`);
  if (value.autenticacion !== undefined && !AUTH.includes(value.autenticacion)) fail(`proveedores.${agent}.autenticacion debe ser ${AUTH.join(', ')}.`);
  if (value.usadoPorcentaje !== undefined && value.usadoPorcentaje !== null && !(Number.isFinite(value.usadoPorcentaje) && value.usadoPorcentaje >= 0 && value.usadoPorcentaje <= 100)) fail(`proveedores.${agent}.usadoPorcentaje debe estar entre 0 y 100.`);
  for (const key of ['reiniciaEn', 'observadoEn', 'agotadaHasta']) if (value[key] !== undefined && value[key] !== null && !isDate(value[key])) fail(`proveedores.${agent}.${key} debe ser una fecha ISO.`);
  if (value.usadoPorcentaje !== undefined && value.usadoPorcentaje !== null && !value.observadoEn) fail(`proveedores.${agent}: usadoPorcentaje necesita observadoEn (cuándo se miró).`);
  if (value.fuente !== undefined && (typeof value.fuente !== 'string' || value.fuente.length > 80)) fail(`proveedores.${agent}.fuente debe ser un texto breve.`);
  return { autenticacion: value.autenticacion ?? 'desconocida', ...Object.fromEntries(['usadoPorcentaje', 'reiniciaEn', 'observadoEn', 'fuente', 'agotadaHasta'].filter(key => value[key] !== undefined && value[key] !== null).map(key => [key, value[key]])),
    ...(value.inferida === true ? { inferida: true } : {}) };
}

export function normalizeQuota(value) {
  if (value === null || value === undefined) return DEFAULT_QUOTA;
  if (!isObject(value) || value.version !== 1) fail('debe tener version 1.');
  const unknown = Object.keys(value).find(key => !['version', ...Object.keys(DEFAULT_QUOTA)].includes(key) && !key.startsWith('_'));
  if (unknown) fail(`campo desconocido ${unknown}.`);
  const number = (key, min, max) => { const item = value[key] ?? DEFAULT_QUOTA[key]; if (!Number.isFinite(item) || item < min || item > max) fail(`${key} debe estar entre ${min} y ${max}.`); return item; };
  const reserve = number('reservaPersonalPorcentaje', MIN_RESERVE, 90);
  const warn = number('avisoPorcentaje', 1, 100);
  const stale = number('caducidadObservacionHoras', 1, 168);
  if (!['admitir', 'esperar'].includes(value.sinDatos ?? DEFAULT_QUOTA.sinDatos)) fail('sinDatos debe ser admitir o esperar.');
  if (!['esperar', 'sustituir'].includes(value.alAgotar ?? DEFAULT_QUOTA.alAgotar)) fail('alAgotar debe ser esperar o sustituir.');
  const substitutes = {};
  for (const [from, to] of Object.entries(value.sustituciones ?? {})) {
    if (!LAUNCH_AGENTS.includes(from) || !LAUNCH_AGENTS.includes(to) || from === to) fail(`sustituciones: ${from} → ${to} no es un par de proveedores distintos (${LAUNCH_AGENTS.join(', ')}).`);
    substitutes[from] = to;
  }
  const providers = {};
  for (const [agent, item] of Object.entries(value.proveedores ?? {})) {
    if (!LAUNCH_AGENTS.includes(agent)) fail(`proveedor desconocido ${agent}; usa ${LAUNCH_AGENTS.join(', ')}.`);
    providers[agent] = normalizeProvider(item, agent);
  }
  return { reservaPersonalPorcentaje: reserve, avisoPorcentaje: warn, caducidadObservacionHoras: stale, sinDatos: value.sinDatos ?? DEFAULT_QUOTA.sinDatos,
    alAgotar: value.alAgotar ?? DEFAULT_QUOTA.alAgotar, sustituciones: substitutes, proveedores: providers };
}

export async function quotaConfigured(root) { try { await fs.access(path.join(root, 'data', QUOTA_FILE)); return true; } catch { return false; } }
export async function readQuota(root) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'data', QUOTA_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return DEFAULT_QUOTA; throw error; }
  let value;
  try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { fail('JSON ilegible.'); }
  return normalizeQuota(value);
}
export async function writeQuota(root, value) {
  const quota = normalizeQuota({ ...value, version: 1 });
  const directory = path.join(root, 'data'), temporary = path.join(directory, `${QUOTA_FILE}.${randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(temporary, JSON.stringify({ version: 1, ...quota }, null, 2) + '\n', { flag: 'wx' }); await replaceLocalFile(temporary, path.join(directory, QUOTA_FILE)); }
  finally { await fs.rm(temporary, { force: true }); }
  return quota;
}

// What is known about one provider right now, and how.
//   disponible  observed recently, below the reserve line
//   reserva     observed recently at or above the reserve line: the rest belongs to the owner's personal work
//   agotada     the provider refused work, or the owner marked it, until a known or unknown moment
//   incierta    no observation, or too old to count
export function quotaStatus(quota, agent, now = Date.now()) {
  const provider = quota.proveedores[agent] ?? { autenticacion: 'desconocida' };
  const limit = 100 - quota.reservaPersonalPorcentaje;
  const base = { provider: agent, autenticacion: provider.autenticacion, reserva: quota.reservaPersonalPorcentaje, limite: limit };
  const exhaustedUntil = provider.agotadaHasta ? Date.parse(provider.agotadaHasta) : null;
  if (exhaustedUntil !== null && exhaustedUntil > now) return { ...base, state: 'agotada', until: provider.agotadaHasta, ...(provider.inferida ? { inferida: true } : {}),
    reason: `${agent}: cuota agotada${provider.inferida ? ' (deducido del cierre de un trabajador, sin confirmar)' : ''} hasta ${provider.agotadaHasta}.` };
  const observedAt = provider.observadoEn ? Date.parse(provider.observadoEn) : null;
  const resetAt = provider.reiniciaEn ? Date.parse(provider.reiniciaEn) : null;
  const fresh = observedAt !== null && now - observedAt <= quota.caducidadObservacionHoras * 3_600_000 && !(resetAt !== null && resetAt <= now && resetAt > observedAt);
  if (!fresh || provider.usadoPorcentaje === undefined) return { ...base, state: 'incierta',
    reason: provider.usadoPorcentaje === undefined || observedAt === null ? `${agent}: no hay ninguna observación de uso. El proveedor no permite consultar el saldo desde el Centro.`
      : resetAt !== null && resetAt <= now && resetAt > observedAt ? `${agent}: la cuota se reinició después de la última observación; el uso actual no se conoce.`
      : `${agent}: la última observación (${provider.observadoEn}) tiene más de ${quota.caducidadObservacionHoras} h.` };
  const known = { ...base, usadoPorcentaje: provider.usadoPorcentaje, observadoEn: provider.observadoEn, ...(provider.reiniciaEn ? { until: provider.reiniciaEn } : {}), ...(provider.fuente ? { fuente: provider.fuente } : {}) };
  if (provider.usadoPorcentaje >= limit) return { ...known, state: 'reserva', reason: `${agent}: uso observado ${provider.usadoPorcentaje} %. El ${quota.reservaPersonalPorcentaje} % restante es la reserva de trabajo personal.` };
  return { ...known, state: 'disponible', ...(provider.usadoPorcentaje >= quota.avisoPorcentaje ? { aviso: `${agent}: uso observado ${provider.usadoPorcentaje} %, cerca de la reserva (${limit} %).` } : {}) };
}

// The decision for one stage about to be launched with `agent`.
//   launch      go ahead (status says whether it is known or uncertain)
//   substitute  go ahead with another provider (policy alAgotar: sustituir)
//   wait        do not launch; `until` is when it is worth looking again, if known
export function quotaDecision(quota, agent, now = Date.now()) {
  const status = quotaStatus(quota, agent, now);
  const blocked = ['reserva', 'agotada'].includes(status.state) || (status.state === 'incierta' && quota.sinDatos === 'esperar');
  if (!blocked) return { action: 'launch', status };
  const substitute = quota.alAgotar === 'sustituir' ? quota.sustituciones[agent] : null;
  if (substitute) {
    const other = quotaStatus(quota, substitute, now);
    // Never moves work onto paid API billing on its own, and never onto a provider that is not known to be available.
    if (other.state === 'disponible' && other.autenticacion === 'suscripcion') return { action: 'substitute', to: substitute, status, substituteStatus: other };
  }
  return { action: 'wait', status, ...(status.until && Date.parse(status.until) > now ? { until: status.until } : {}) };
}

// Environment signs that work could be billed outside the subscription. The Centro only reads variable names.
export function billingWarnings(quota, env = process.env) {
  const warnings = [];
  for (const [agent, variable] of [['claude', 'ANTHROPIC_API_KEY'], ['codex', 'OPENAI_API_KEY']]) {
    const declared = quota.proveedores[agent]?.autenticacion ?? 'desconocida';
    if (env[variable]) warnings.push(`${variable} está definida en el entorno del Centro. Si Orca o sus trabajadores la heredan, ${agent} puede facturar por API en lugar de usar la suscripción.`);
    if (declared === 'api') warnings.push(`${agent} está declarado con autenticación por API: cada etapa tiene coste adicional a la suscripción.`);
    if (declared === 'desconocida') warnings.push(`${agent}: no se ha declarado cómo se autentica en Orca (suscripción o API). Compruébalo en Orca y anótalo aquí.`);
  }
  return warnings;
}

// The owner (or the engine, when a worker stops on a limit) records what was seen.
export async function recordQuotaObservation(root, agent, observation, { now = new Date() } = {}) {
  if (!LAUNCH_AGENTS.includes(agent)) throw new QuotaError(`proveedor desconocido ${agent}.`);
  const quota = await readQuota(root);
  const previous = quota.proveedores[agent] ?? { autenticacion: 'desconocida' };
  const next = { ...previous };
  if (observation.autenticacion !== undefined) next.autenticacion = observation.autenticacion;
  if (observation.usadoPorcentaje !== undefined) { next.usadoPorcentaje = observation.usadoPorcentaje; next.observadoEn = now.toISOString(); next.fuente = observation.fuente ?? 'manual'; delete next.agotadaHasta; delete next.inferida; }
  if (observation.reiniciaEn !== undefined) { if (observation.reiniciaEn) next.reiniciaEn = observation.reiniciaEn; else delete next.reiniciaEn; }
  if (observation.agotadaHasta !== undefined) {
    if (observation.agotadaHasta) { next.agotadaHasta = observation.agotadaHasta; if (observation.inferida) next.inferida = true; else delete next.inferida; }
    else { delete next.agotadaHasta; delete next.inferida; }
  }
  return writeQuota(root, { ...quota, proveedores: { ...quota.proveedores, [agent]: next } });
}

// A worker that ended without a delivery may have been stopped by its provider. These phrases are the Centro's
// working assumption about provider messages, NOT verified against real accounts: a match is recorded as inferred
// and shown as such. Only text of a failed worker with no delivery is ever looked at, never a product report.
const QUOTA_SIGNALS = [/usage limit/i, /limit (?:has been )?reached/i, /quota (?:exceeded|exhausted)/i, /out of (?:credits|quota)/i, /límite de uso/i];
const UNAVAILABLE_SIGNALS = [/rate limit/i, /overloaded/i, /temporarily unavailable/i, /service unavailable/i, /try again later/i, /\b(?:429|503|529)\b/];
export function providerFailureSignal(text) {
  const tail = String(text ?? '').slice(-4000);
  if (QUOTA_SIGNALS.some(pattern => pattern.test(tail))) return 'cuota';
  if (UNAVAILABLE_SIGNALS.some(pattern => pattern.test(tail))) return 'indisponible';
  return null;
}
