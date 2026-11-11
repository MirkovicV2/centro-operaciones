import fs from 'node:fs/promises';
import path from 'node:path';
import { LAUNCH_AGENTS, LAUNCH_ROLES, flagValue, validateJobLaunch } from './launch-choice.mjs';

// One effective resolution of what each stage is launched with: agent, model and effort.
// Every entry point (CLI, Ideas, Nuevo trabajo, retries, automatic execution) goes through
// resolveStageLaunch, so they cannot disagree. Layers, the most specific wins FIELD BY FIELD:
//   por defecto  CENTRO_ORCA_AGENT + data/orca-launch-levels.json roles      (today's behaviour)
//   general      data/pipeline.json general.roles
//   empresa      data/pipeline.json empresas.<business>.roles
//   proyecto     data/orca-launch-levels.json projects.<id>.roles (legacy), then data/pipeline.json proyectos.<id>.roles
//   encargo      job.launch
// A model name belongs to one provider, so an entry that names a model must name its agent.
// When a layer changes the agent, the model and effort inherited from the other provider are
// dropped and the stage falls back to its level (ligero/estandar/profundo) in the new agent's table.
// Without data/pipeline.json the result is exactly what the Centro launched before this file existed.
export const PIPELINE_FILE = 'pipeline.json';
export const PIPELINE_BUSINESSES = ['agency', 'games'];
export const EMPTY_PIPELINE = Object.freeze({ general: Object.freeze({ roles: Object.freeze({}) }), empresas: Object.freeze({}), proyectos: Object.freeze({}), escaladas: Object.freeze({}) });
const SCOPE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const ENTRY_KEYS = ['agent', 'level', 'model', 'effort'];

export class PipelineConfigError extends Error {
  constructor(message) { super(`data/${PIPELINE_FILE}: ${message}`); this.code = 'pipeline_config_invalid'; }
}
const fail = message => { throw new PipelineConfigError(message); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function normalizeEntry(entry, where, levelNames) {
  if (!isObject(entry) || !Object.keys(entry).length) fail(`${where} necesita agent, level, model y/o effort.`);
  const unknown = Object.keys(entry).find(key => !ENTRY_KEYS.includes(key));
  if (unknown) fail(`${where}: campo desconocido ${unknown}; usa ${ENTRY_KEYS.join(', ')}.`);
  if (entry.agent !== undefined && !LAUNCH_AGENTS.includes(entry.agent)) fail(`${where}: agent debe ser ${LAUNCH_AGENTS.join(' o ')}.`);
  if (entry.level !== undefined && !levelNames.includes(entry.level)) fail(`${where}: nivel desconocido ${entry.level}; usa ${levelNames.join(', ')}.`);
  if (entry.level !== undefined && (entry.model !== undefined || entry.effort !== undefined)) fail(`${where}: usa level o model/effort, no ambos.`);
  for (const key of ['model', 'effort']) if (entry[key] !== undefined && !flagValue(entry[key])) fail(`${where}: ${key} solo admite caracteres [A-Za-z0-9._:-].`);
  if (entry.model !== undefined && entry.agent === undefined) fail(`${where}: un model pertenece a un proveedor; indica también agent.`);
  return Object.fromEntries(ENTRY_KEYS.filter(key => entry[key] !== undefined).map(key => [key, entry[key]]));
}

function normalizeRoles(value, where, levelNames) {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${where} debe ser un objeto por rol.`);
  const roles = {};
  for (const [role, entry] of Object.entries(value)) {
    if (!LAUNCH_ROLES.includes(role)) fail(`${where}: rol desconocido ${role}; usa ${LAUNCH_ROLES.join(', ')}.`);
    roles[role] = normalizeEntry(entry, `${where}.${role}`, levelNames);
  }
  return roles;
}

function normalizeScopes(value, where, levelNames, allowed) {
  if (value === undefined) return {};
  if (!isObject(value)) fail(`${where} debe ser un objeto.`);
  const scopes = {};
  for (const [id, scope] of Object.entries(value)) {
    if (allowed ? !allowed.includes(id) : !SCOPE_ID.test(id)) fail(`${where}: identificador inválido ${id}${allowed ? `; usa ${allowed.join(', ')}` : ''}.`);
    if (!isObject(scope)) fail(`${where}.${id} necesita roles.`);
    scopes[id] = { roles: normalizeRoles(scope.roles, `${where}.${id}.roles`, levelNames) };
  }
  return scopes;
}

// An escalation is a named, stronger launch that a job may request for some roles. The job
// states why, for what scope and which verifiable result it expects (see validateJobLaunch).
function normalizeEscalations(value) {
  if (value === undefined) return {};
  if (!isObject(value)) fail('escaladas debe ser un objeto por identificador.');
  const escalations = {};
  for (const [id, item] of Object.entries(value)) {
    const where = `escaladas.${id}`;
    if (!SCOPE_ID.test(id)) fail(`identificador de escalada inválido ${id}.`);
    if (!isObject(item) || !LAUNCH_AGENTS.includes(item.agent) || !flagValue(item.model)) fail(`${where} necesita agent y model.`);
    if (item.effort !== undefined && !flagValue(item.effort)) fail(`${where}: effort solo admite caracteres [A-Za-z0-9._:-].`);
    if (!Array.isArray(item.roles) || !item.roles.length || item.roles.some(role => !LAUNCH_ROLES.includes(role))) fail(`${where}.roles debe listar roles de ${LAUNCH_ROLES.join(', ')}.`);
    if (item.uso !== undefined && (typeof item.uso !== 'string' || item.uso.length > 300)) fail(`${where}.uso debe ser un texto de hasta 300 caracteres.`);
    escalations[id] = { agent: item.agent, model: item.model, ...(item.effort ? { effort: item.effort } : {}), roles: [...new Set(item.roles)], ...(item.uso ? { uso: item.uso } : {}) };
  }
  return escalations;
}

export function normalizePipeline(value, { levelNames }) {
  if (value === null || value === undefined) return EMPTY_PIPELINE;
  if (!isObject(value)) fail('debe ser un objeto.');
  if (value.version !== 1) fail('version debe ser 1.');
  const unknown = Object.keys(value).find(key => !['version', 'general', 'empresas', 'proyectos', 'escaladas'].includes(key) && !key.startsWith('_'));
  if (unknown) fail(`campo desconocido ${unknown}.`);
  if (value.general !== undefined && !isObject(value.general)) fail('general necesita roles.');
  return {
    general: { roles: normalizeRoles(value.general?.roles, 'general.roles', levelNames) },
    empresas: normalizeScopes(value.empresas, 'empresas', levelNames, PIPELINE_BUSINESSES),
    proyectos: normalizeScopes(value.proyectos, 'proyectos', levelNames),
    escaladas: normalizeEscalations(value.escaladas),
  };
}

export async function readPipeline(root, { levelNames }) {
  let raw;
  try { raw = await fs.readFile(path.join(root, 'data', PIPELINE_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return EMPTY_PIPELINE; throw error; }
  let value;
  try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { fail('JSON ilegible.'); }
  return normalizePipeline(value, { levelNames });
}

// Every agent a stage could be launched with under this configuration (preflight warnings).
export function pipelineAgents(pipeline, defaultAgent) {
  const agents = new Set([defaultAgent]);
  for (const scope of [pipeline.general, ...Object.values(pipeline.empresas), ...Object.values(pipeline.proyectos)]) {
    for (const entry of Object.values(scope.roles)) if (entry.agent) agents.add(entry.agent);
  }
  for (const item of Object.values(pipeline.escaladas)) agents.add(item.agent);
  return [...agents];
}

function jobEntry(jobLaunch, roleName, pipeline) {
  const chosen = jobLaunch?.roles?.[roleName];
  if (!chosen) return null;
  if (chosen.escalada) {
    const escalation = pipeline.escaladas[chosen.escalada];
    if (!escalation) throw new PipelineConfigError(`el encargo pide la escalada ${chosen.escalada}, que no está definida en escaladas.`);
    if (!escalation.roles.includes(roleName)) throw new PipelineConfigError(`la escalada ${chosen.escalada} no cubre el rol ${roleName}.`);
    return { entry: { agent: escalation.agent, model: escalation.model, effort: escalation.effort ?? null }, source: 'escalada',
      escalation: { id: chosen.escalada, motivo: chosen.motivo, alcance: chosen.alcance, resultado: chosen.resultado } };
  }
  // Legacy form { agent, roles: { role: { model?, effort? } } }: the choice is bound to that agent,
  // never selects it, and replaces model and effort together (an absent field = the agent's default).
  if (chosen.agent === undefined && jobLaunch.agent) return { entry: { model: chosen.model ?? null, effort: chosen.effort ?? null }, onlyFor: jobLaunch.agent, source: 'encargo' };
  return { entry: chosen, source: 'encargo' };
}

// Returns what a stage is launched with and where each field came from.
// model/effort null = the agent's own default. `level` is set only when both come from the level table.
export function resolveStageLaunch({ roleName, business = null, projectId = null, jobLaunch = null, levels, pipeline = EMPTY_PIPELINE, defaultAgent = 'codex', fallbackRoles = {} }) {
  const state = { agent: defaultAgent, level: levels.roles?.[roleName] ?? fallbackRoles[roleName] ?? null, model: undefined, effort: undefined };
  const origin = { agent: 'por defecto', model: 'por defecto', effort: 'por defecto' };
  let source = 'por defecto';
  const apply = (entry, name) => {
    if (!entry) return;
    source = name;
    if (entry.agent !== undefined && entry.agent !== state.agent) {
      Object.assign(state, { agent: entry.agent, model: undefined, effort: undefined });
      Object.assign(origin, { agent: name, model: name, effort: name });
    }
    if (entry.level !== undefined) {
      Object.assign(state, { level: entry.level, model: undefined, effort: undefined });
      Object.assign(origin, { model: name, effort: name });
    }
    for (const key of ['model', 'effort']) if (entry[key] !== undefined) { state[key] = entry[key]; origin[key] = name; }
  };
  apply(pipeline.general.roles[roleName], 'general');
  apply(business ? pipeline.empresas[business]?.roles[roleName] : null, 'empresa');
  const legacyProjectLevel = projectId ? levels.projects?.[projectId]?.roles?.[roleName] : undefined;
  apply(legacyProjectLevel ? { level: legacyProjectLevel } : null, 'proyecto');
  apply(projectId ? pipeline.proyectos[projectId]?.roles[roleName] : null, 'proyecto');
  const job = jobEntry(jobLaunch, roleName, pipeline);
  if (job && (!job.onlyFor || job.onlyFor === state.agent)) apply(job.entry, job.source);
  const table = levels.agents?.[state.agent]?.[state.level] ?? {};
  const fromLevel = state.model === undefined && state.effort === undefined;
  return {
    agent: state.agent,
    level: fromLevel ? state.level ?? null : null,
    model: (state.model === undefined ? table.model : state.model) ?? null,
    effort: (state.effort === undefined ? table.effort : state.effort) ?? null,
    source, origin,
    ...(job?.escalation && source === 'escalada' ? { escalation: job.escalation } : {}),
  };
}

const STAGE_LABELS = { planificador: 'Planificación', ux: 'Diseño', desarrollador: 'Desarrollo', qa: 'QA', revisor: 'Revisión' };
// The route the engine runs today: analysis = Planificación; code = Diseño → Desarrollo → QA → Revisión → integración.
export const routeRoles = kind => kind === 'analysis' ? ['planificador'] : ['ux', 'desarrollador', 'qa', 'revisor'];

// What a job WOULD be launched with, before it is admitted. Pure: no job, no dispatch, no model call.
export function previewPipeline({ business, kind, projectId = null, launch = null, levels, pipeline = EMPTY_PIPELINE, defaultAgent = 'codex', fallbackRoles = {} }) {
  const invalid = message => Object.assign(new Error(message), { code: 'launch_choice_invalid' });
  if (!PIPELINE_BUSINESSES.includes(business)) throw invalid('La vista previa necesita business (agency o games).');
  if (!['analysis', 'code'].includes(kind)) throw invalid('La vista previa necesita kind (analysis o code).');
  const jobLaunch = validateJobLaunch(launch) ?? null;
  const stages = routeRoles(kind).map(roleName => ({ role: roleName, label: STAGE_LABELS[roleName],
    ...resolveStageLaunch({ roleName, business, projectId, jobLaunch, levels, pipeline, defaultAgent, fallbackRoles }) }));
  const ignored = jobLaunch?.agent ? stages.filter(stage => jobLaunch.roles[stage.role] && jobLaunch.roles[stage.role].agent === undefined
    && !jobLaunch.roles[stage.role].escalada && stage.agent !== jobLaunch.agent).map(stage => stage.role) : [];
  return {
    business, kind, projectId, stages,
    ...(kind === 'code' ? { integration: 'Motor del Centro (GitHub), sin modelo' } : {}),
    warnings: ignored.map(role => `La elección del encargo para ${role} es de ${jobLaunch.agent} y la etapa se lanza con otro agente: se ignora. Indica agent en ese rol para cambiarlo.`),
  };
}

export function previewText(preview) {
  const line = stage => `${stage.label.padEnd(13)} ${stage.agent.padEnd(6)} ${(stage.model ?? 'modelo por defecto').padEnd(22)} ${(stage.effort ? `esfuerzo ${stage.effort}` : 'esfuerzo por defecto').padEnd(22)} (${stage.source}${stage.level ? `, nivel ${stage.level}` : ''}${stage.escalation ? `: ${stage.escalation.motivo}` : ''})`;
  return [...preview.stages.map(line), ...(preview.integration ? [`${'Integración'.padEnd(13)} ${preview.integration}`] : []), ...preview.warnings.map(item => `AVISO: ${item}`)].join('\n');
}
