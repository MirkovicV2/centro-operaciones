import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_QUOTA, billingWarnings, launchWithQuota, normalizeQuota, providerFailureSignal, quotaDecision, quotaStatus, readQuota, recordQuotaObservation } from '../quota.mjs';
import { previewPipeline, normalizePipeline } from '../pipeline-config.mjs';
import { normalizeLaunchLevels, DEFAULT_LAUNCH_LEVELS, LAUNCH_LEVELS } from '../orca-provider.mjs';
import { diagnoseJob } from '../failure-taxonomy.mjs';

const now = Date.parse('2026-11-11T12:00:00Z');
const at = hoursAgo => new Date(now - hoursAgo * 3_600_000).toISOString();
const quota = (providers, policy = {}) => normalizeQuota({ version: 1, ...policy, proveedores: providers });

test('the personal reserve is at least 10 % and a status always says how it is known', () => {
  assert.throws(() => normalizeQuota({ version: 1, reservaPersonalPorcentaje: 5 }), { code: 'quota_config_invalid', message: /entre 10 y 90/ });
  assert.equal(normalizeQuota({ version: 1 }).reservaPersonalPorcentaje, 10);
  const q = quota({ claude: { autenticacion: 'suscripcion', usadoPorcentaje: 40, observadoEn: at(1) }, codex: { autenticacion: 'suscripcion', usadoPorcentaje: 90, observadoEn: at(1), reiniciaEn: at(-5) } });
  assert.equal(quotaStatus(q, 'claude', now).state, 'disponible');
  const reserved = quotaStatus(q, 'codex', now);
  assert.equal(reserved.state, 'reserva'); assert.match(reserved.reason, /90 %.*reserva de trabajo personal/); assert.equal(reserved.until, at(-5));
  assert.equal(quotaStatus(quota({ claude: { usadoPorcentaje: 89, observadoEn: at(1) } }), 'claude', now).state, 'disponible', '89 % is still below the 90 % line');
  assert.match(quotaStatus(quota({ claude: { usadoPorcentaje: 80, observadoEn: at(1) } }), 'claude', now).aviso, /cerca de la reserva/);
  // Unknown is its own state: no observation, an old one, or a reset since the last look.
  assert.match(quotaStatus(DEFAULT_QUOTA, 'claude', now).reason, /no permite consultar el saldo/);
  assert.match(quotaStatus(quota({ claude: { usadoPorcentaje: 10, observadoEn: at(7) } }), 'claude', now).reason, /más de 6 h/);
  const afterReset = quotaStatus(quota({ claude: { usadoPorcentaje: 95, observadoEn: at(3), reiniciaEn: at(1) } }), 'claude', now);
  assert.equal(afterReset.state, 'incierta'); assert.match(afterReset.reason, /se reinició después/);
  // In the reserve with a known reset: the note keeps holding after it ages (usage only grows until then), and stops at the reset.
  const heldQuota = quota({ codex: { autenticacion: 'suscripcion', usadoPorcentaje: 93, observadoEn: at(0), reiniciaEn: at(-48) } });
  assert.equal(quotaStatus(heldQuota, 'codex', now + 10 * 3_600_000).state, 'reserva', 'an aged reserve observation must not reopen the provider');
  assert.equal(quotaStatus(heldQuota, 'codex', now + 49 * 3_600_000).state, 'incierta');
  assert.equal(quotaStatus(quota({ codex: { usadoPorcentaje: 93, observadoEn: at(7) } }), 'codex', now).state, 'incierta', 'without a reset it ages like any other note');
  assert.equal(quotaStatus(quota({ codex: { usadoPorcentaje: 50, observadoEn: at(7), reiniciaEn: at(-48) } }), 'codex', now).state, 'incierta', 'below the line an old note is still unknown');
  // Exhausted until a moment; once it passes the usage is unknown again, not "available".
  const exhausted = quota({ claude: { agotadaHasta: at(-2), inferida: true } });
  assert.equal(quotaStatus(exhausted, 'claude', now).state, 'agotada'); assert.match(quotaStatus(exhausted, 'claude', now).reason, /sin confirmar/);
  assert.equal(quotaStatus(exhausted, 'claude', now + 3 * 3_600_000).state, 'incierta');
});

test('the decision is explicit: launch, wait until a known time, or substitute only onto an available subscription', () => {
  const providers = { claude: { autenticacion: 'suscripcion', usadoPorcentaje: 93, observadoEn: at(1), reiniciaEn: at(-4) }, codex: { autenticacion: 'suscripcion', usadoPorcentaje: 20, observadoEn: at(1) } };
  assert.deepEqual([quotaDecision(quota(providers), 'claude', now).action, quotaDecision(quota(providers), 'claude', now).until], ['wait', at(-4)]);
  assert.equal(quotaDecision(quota(providers), 'codex', now).action, 'launch');
  const substituting = { alAgotar: 'sustituir', sustituciones: { claude: 'codex' } };
  assert.deepEqual([quotaDecision(quota(providers, substituting), 'claude', now).action, quotaDecision(quota(providers, substituting), 'claude', now).to], ['substitute', 'codex']);
  // Never onto API billing, an unknown balance or another reserved provider.
  for (const codex of [{ autenticacion: 'api', usadoPorcentaje: 20, observadoEn: at(1) }, { autenticacion: 'suscripcion' }, { autenticacion: 'suscripcion', usadoPorcentaje: 95, observadoEn: at(1) }, { autenticacion: 'desconocida', usadoPorcentaje: 5, observadoEn: at(1) }]) {
    assert.equal(quotaDecision(quota({ ...providers, codex }, substituting), 'claude', now).action, 'wait', JSON.stringify(codex));
  }
  // No data: launch with a visible uncertainty by default, or wait when the owner prefers.
  assert.deepEqual([quotaDecision(quota({ claude: {} }), 'claude', now).action, quotaDecision(quota({ claude: {} }), 'claude', now).status.state], ['launch', 'incierta']);
  assert.equal(quotaDecision(quota({ claude: {} }, { sinDatos: 'esperar' }), 'claude', now).action, 'wait');
  assert.throws(() => quota({}, { sustituciones: { claude: 'claude' } }), /proveedores distintos/);
  assert.throws(() => quota({ gemini: {} }), /proveedor desconocido gemini/);
  assert.throws(() => quota({ claude: { usadoPorcentaje: 40 } }), /necesita observadoEn/);
  assert.throws(() => quota({ claude: { usadoPorcentaje: 140, observadoEn: at(1) } }), /entre 0 y 100/);
});

test('the panel is told when work could be billed outside the subscription; only variable names are read', () => {
  const q = quota({ claude: { autenticacion: 'suscripcion' }, codex: { autenticacion: 'api' } });
  assert.deepEqual(billingWarnings(q, {}), ['codex está declarado con autenticación por API: cada etapa tiene coste adicional a la suscripción.']);
  const withKey = billingWarnings(q, { ANTHROPIC_API_KEY: 'sk-secreto-que-no-debe-aparecer' });
  assert.match(withKey[0], /ANTHROPIC_API_KEY está definida.*facturar por API/); assert.equal(withKey.join(' ').includes('sk-secreto'), false);
  assert.equal(billingWarnings(DEFAULT_QUOTA, {}).length, 2, 'undeclared authentication is itself a warning');
});

test('observations are written by the owner or inferred by the engine, and a fresh look clears an inferred exhaustion', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(await readQuota(root), DEFAULT_QUOTA);
  const example = JSON.parse(await fs.readFile(new URL('../ejemplos/quota.example.json', import.meta.url), 'utf8'));
  assert.equal(normalizeQuota(example).alAgotar, 'esperar');
  const observedAt = new Date(now);
  await recordQuotaObservation(root, 'claude', { autenticacion: 'suscripcion', agotadaHasta: at(-1), inferida: true }, { now: observedAt });
  assert.equal(quotaStatus(await readQuota(root), 'claude', now).inferida, true);
  await recordQuotaObservation(root, 'claude', { usadoPorcentaje: 35 }, { now: observedAt });
  const status = quotaStatus(await readQuota(root), 'claude', now);
  assert.deepEqual([status.state, status.usadoPorcentaje, status.autenticacion, status.fuente], ['disponible', 35, 'suscripcion', 'manual']);
  await assert.rejects(recordQuotaObservation(root, 'claude', { usadoPorcentaje: 400 }), { code: 'quota_config_invalid' });
  assert.equal(quotaStatus(await readQuota(root), 'claude', now).usadoPorcentaje, 35, 'a refused observation changes nothing');
  await fs.writeFile(path.join(root, 'data', 'quota.json'), '{ roto');
  await assert.rejects(readQuota(root), { code: 'quota_config_invalid' });
});

test('a provider message is only a hint: quota and temporary unavailability are told apart, ordinary output is neither', () => {
  assert.equal(providerFailureSignal('Claude usage limit reached. Your limit will reset at 6pm.'), 'cuota');
  assert.equal(providerFailureSignal("You've hit your usage limit. Upgrade or try again later."), 'cuota');
  assert.equal(providerFailureSignal('Error 529: the service is overloaded'), 'indisponible');
  assert.equal(providerFailureSignal('stream error: rate limit exceeded, retrying'), 'indisponible');
  assert.equal(providerFailureSignal('npm test: 12 passed, 0 failed'), null);
  assert.equal(providerFailureSignal(''), null);
});

test('a stopped job is named by its cause, with the next step', () => {
  const stopped = (code, extra = {}) => diagnoseJob({ state: 'needs_attention', error: { code }, ...extra });
  assert.equal(stopped('quality_gate_blocked').category, 'producto');
  for (const code of ['pipeline_config_invalid', 'skill_changed', 'orca_command_rejected', 'quota_config_invalid']) assert.equal(stopped(code).category, 'configuracion', code);
  assert.equal(stopped('provider_quota_exhausted').category, 'cuota'); assert.match(stopped('provider_quota_exhausted').action, /el Centro no lo hace/);
  assert.equal(stopped('provider_unavailable').category, 'indisponible');
  assert.equal(stopped('orca_dispatch_unknown').category, 'incierto'); assert.match(stopped('orca_dispatch_unknown').action, /no lanzará una copia/);
  assert.equal(stopped('quality_gate_operational').category, 'operativo');
  assert.equal(stopped('needs_input').category, 'decision');
  assert.equal(stopped('un_codigo_nuevo').category, 'operativo', 'an unmapped code is never shown as a product failure');
  const asking = keys => stopped('needs_input', { workflow: { currentStage: 'developer', steps: [{ key: 'developer', status: 'blocked', delivery: { questions: keys.map(decisionKey => ({ required: true, decisionKey })) } }] } });
  assert.equal(asking(['UX-I1-return']).category, 'consulta');
  assert.equal(asking(['permiso-adb']).category, 'permiso');
  assert.equal(asking(['prueba-humana-latencia']).category, 'prueba_humana');
  assert.equal(asking(['paleta']).category, 'decision');
  // Waiting is not a failure.
  const waiting = diagnoseJob({ state: 'queued', waiting: { code: 'quota', message: 'claude: uso observado 93 %.', until: at(-4) } });
  assert.deepEqual([waiting.category, waiting.waiting, waiting.until], ['cuota', true, at(-4)]);
  assert.equal(diagnoseJob({ state: 'queued' }), null); assert.equal(diagnoseJob({ state: 'succeeded' }), null);
  assert.equal(diagnoseJob({ state: 'retry_wait', error: { code: 'provider_unavailable' }, nextAttemptAt: at(-1) }).waiting, true);
});

test('the preview shows what the quota policy would really launch (seen in the first pilot: it announced Codex while Codex was in the reserve)', () => {
  const fresh = new Date().toISOString(), later = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const providers = { codex: { autenticacion: 'suscripcion', usadoPorcentaje: 93, observadoEn: fresh, reiniciaEn: later }, claude: { autenticacion: 'suscripcion', usadoPorcentaje: 62, observadoEn: fresh } };
  const pipeline = normalizePipeline({ version: 1, general: { roles: { desarrollador: { agent: 'claude', model: 'sonnet', effort: 'medium' }, qa: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' } } } }, { levelNames: LAUNCH_LEVELS });
  const base = { business: 'agency', kind: 'code', levels: normalizeLaunchLevels({}), pipeline, defaultAgent: 'codex', fallbackRoles: DEFAULT_LAUNCH_LEVELS.roles };
  const stage = (preview, role) => preview.stages.find(item => item.role === role);
  const plain = previewPipeline(base);
  assert.equal(stage(plain, 'qa').agent, 'codex'); assert.equal(stage(plain, 'qa').substitutedFrom, undefined);
  const substituted = previewPipeline({ ...base, quota: quota(providers, { alAgotar: 'sustituir', sustituciones: { codex: 'claude', claude: 'codex' } }) });
  const qa = stage(substituted, 'qa');
  assert.deepEqual([qa.agent, qa.model, qa.substitutedFrom.agent, qa.substitutedFrom.reason], ['claude', null, 'codex', 'cuota'], 'the Codex model never travels to Claude');
  assert.equal(stage(substituted, 'desarrollador').substitutedFrom, undefined);
  assert.ok(substituted.warnings.some(item => /QA: codex está en la reserva o agotado; se lanzaría con claude/.test(item)));
  const waiting = previewPipeline({ ...base, quota: quota(providers) });
  assert.equal(stage(waiting, 'qa').agent, 'codex'); assert.match(stage(waiting, 'qa').quotaWait, /93 %/);
  assert.ok(waiting.warnings.some(item => /QA no se lanzaría ahora/.test(item)));
  // No quota file, or one with nothing noted: exactly the configured launch.
  assert.deepEqual(launchWithQuota(() => ({ agent: 'codex' }), DEFAULT_QUOTA), { agent: 'codex' });
  assert.deepEqual(launchWithQuota(() => ({ agent: 'codex' }), null), { agent: 'codex' });
});
