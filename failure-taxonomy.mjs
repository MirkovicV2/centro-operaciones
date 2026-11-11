// Why a job is not moving, in the terms the owner needs to act: the same code is never shown as "failed" when it
// means "your configuration is wrong", "the provider is out of quota" or "a person has to test this".
// Built only from codes the engine itself sets. `action` is the concrete next step.
const CATEGORY = Object.freeze({
  producto: 'Fallo del producto', operativo: 'Bloqueo operativo', indisponible: 'Proveedor u Orca no disponible', cuota: 'Cuota del proveedor',
  configuracion: 'Configuración inválida', decision: 'Decisión pendiente', consulta: 'Consulta interna', permiso: 'Permiso pendiente', prueba_humana: 'Prueba humana pendiente', incierto: 'Resultado incierto',
});
const BY_CODE = Object.freeze({
  // Product: a stage judged the candidate and rejected it.
  quality_gate_blocked: ['producto', 'Lee los hallazgos del informe. Un fallo reproducible vuelve a Desarrollo; si discrepas, decide en la ficha del trabajo.'],
  // Configuration: nothing was launched; fix the file and retry.
  pipeline_config_invalid: ['configuracion', 'Corrige data/pipeline.json (Ajustes → Agentes y modelos) y reintenta.'],
  launch_levels_invalid: ['configuracion', 'Corrige data/orca-launch-levels.json y reintenta.'],
  launch_choice_invalid: ['configuracion', 'Corrige el reparto elegido para este encargo.'],
  skill_missing: ['configuracion', 'Restaura los archivos de la skill y reintenta (node cli.mjs skills).'],
  skill_changed: ['configuracion', 'Revisa el cambio de la skill y acéptalo (node cli.mjs skills-accept --id …), o restaura el original; después reintenta.'],
  skill_choice_invalid: ['configuracion', 'Corrige data/skills.json o las skills del encargo y reintenta.'],
  skill_registry_invalid: ['configuracion', 'Corrige skills/registry.json y reintenta.'],
  skill_copy_changed: ['configuracion', 'La copia de una skill entregada a este encargo fue modificada. Revisa data/dispatch-specs del encargo antes de reintentar.'],
  project_contract_invalid: ['configuracion', 'Corrige el contrato de rol indicado en el mensaje y reintenta.'],
  job_route_invalid: ['configuracion', 'Corrige la ruta del encargo.'],
  quota_config_invalid: ['configuracion', 'Corrige data/quota.json (Ajustes → Cuota) y reintenta.'],
  orca_profile_missing: ['configuracion', 'Falta un perfil de .codex/agents. Restaura el repositorio y reintenta.'],
  orca_command_rejected: ['configuracion', 'Orca rechazó el lanzamiento (modelo, esfuerzo u opción no admitidos). No se creó trabajador: corrige la configuración y reintenta.'],
  workflow_v2_config_missing: ['configuracion', 'Restablece data/workflow-v2.json para este proyecto.'],
  workflow_v2_config_invalid: ['configuracion', 'Corrige data/workflow-v2.json.'],
  // Quota.
  provider_quota_wait: ['cuota', 'El encargo espera a que haya cuota fuera de la reserva personal. Actualiza la observación en Ajustes → Cuota si ya se reinició.'],
  claim_lost: ['operativo', 'Otro equipo tomó la reserva de la rama. Coordina con él antes de reintentar: no debe haber dos trabajadores sobre la misma rama.'],
  provider_quota_exhausted: ['cuota', 'El proveedor dejó de aceptar trabajo. Indica en Ajustes → Cuota cuándo se reinicia, o reintenta la etapa con el otro proveedor. Comprar o recargar es decisión tuya: el Centro no lo hace.'],
  // Temporary unavailability: retry later, nothing to fix in the product.
  provider_unavailable: ['indisponible', 'El proveedor no respondió. Reintenta la etapa más tarde desde la ficha: repite la misma Task y el candidato no ha cambiado.'],
  orca_start_failed: ['indisponible', 'Orca no está instalado o abierto en este equipo. Ábrelo y reintenta.'],
  orca_invalid_response: ['indisponible', 'Orca devolvió una respuesta ilegible. Comprueba que Orca responde antes de reintentar.'],
  orca_command_failed: ['indisponible', 'Un comando de Orca falló. Consulta la evidencia del intento antes de repetir.'],
  timeout: ['indisponible', 'Se agotó el tiempo del intento. Comprueba el trabajador en Orca antes de reintentar.'],
  // Uncertain: a worker may exist; never launch a copy.
  orca_dispatch_unknown: ['incierto', 'No consta si Orca inició el trabajador. Comprueba el dispatch en Orca; la cola no lanzará una copia.'],
  orca_dispatch_status_unknown: ['incierto', 'No se pudo leer el estado del trabajador. Reanuda para consultar el mismo dispatch.'],
  orca_task_unknown: ['incierto', 'Orca no confirmó la Task exacta. Revísala en Orca antes de repetir.'],
  orca_run_unknown: ['incierto', 'Orca no confirmó la Run. Revísala antes de reintentar.'],
  orca_start_unknown_timeout: ['incierto', 'El arranque del trabajador no se confirmó a tiempo. Comprueba Orca.'],
  orca_liveness_unconfirmed: ['incierto', 'No consta que el trabajador haya terminado. Reanuda para consultarlo.'],
  orca_stop_unknown: ['incierto', 'Orca no confirmó la parada del trabajador.'],
  github_integration_needs_attention: ['incierto', 'La integración no confirmó su estado. Usa la recuperación de integración de la ficha; no repite efectos ya hechos.'],
  // Operational: the stage could not do its own job.
  quality_gate_operational: ['operativo', 'La etapa no pudo completar su comprobación. Reintenta la etapa sobre el mismo candidato.'],
  orca_worker_failed: ['operativo', 'El trabajador terminó sin entrega. Su informe queda conservado; revisa el motivo y reintenta.'],
  orca_empty_result: ['operativo', 'El trabajador no dejó resultado. Revisa el dispatch en Orca.'],
  delivery_missing: ['operativo', 'Falta la entrega verificable de la etapa.'],
  // Waiting on people.
  needs_input: ['decision', 'Hay preguntas imprescindibles sin responder. Respóndelas en Ideas y preguntas; el encargo continúa con ellas.'],
  delivery_incomplete: ['decision', 'La etapa dejó una entrega parcial que necesita una decisión de alcance.'],
  workflow_v2_unavailable: ['decision', 'Espera tu aprobación en Workflow V2.'],
});

// Refines the code with what the blocked stage asked for: whom the question is for and whether it is a test or a permission.
function fromQuestions(job) {
  const step = job.workflow?.steps?.find(item => item.key === job.workflow?.currentStage) ?? job.workflow?.steps?.find(item => ['blocked', 'failed'].includes(item.status));
  const required = (step?.delivery?.questions ?? []).filter(question => question.required);
  if (!required.length) return null;
  const keys = required.map(question => String(question.decisionKey || question.id || ''));
  if (keys.some(key => /^UX-I\d-return$/i.test(key))) return ['consulta', 'Desarrollo pide un dictamen de Diseño. Lo resuelve el coordinador con el traspaso; no necesita tu respuesta salvo que te lo escale.'];
  if (keys.some(key => /^(?:permiso|permission|acceso|access)[-_:]/i.test(key))) return ['permiso', 'Un trabajador necesita un permiso o acceso que no tiene. Concédelo o deniégalo en la pregunta del encargo.'];
  if (keys.some(key => /^(?:prueba-humana|human-test|dispositivo|device)[-_:]/i.test(key))) return ['prueba_humana', 'Falta una comprobación que solo puede hacer una persona (dispositivo físico, valoración). Hazla y responde con lo observado.'];
  return null;
}

export function diagnoseJob(job) {
  if (job?.waiting?.code === 'quota') return { category: 'cuota', label: CATEGORY.cuota, waiting: true, message: job.waiting.message, action: BY_CODE.provider_quota_wait[1], ...(job.waiting.until ? { until: job.waiting.until } : {}) };
  const held = { claim: ['Reservado por otro equipo', 'Lo ejecuta el otro equipo. Si su reserva quedó abandonada, caduca sola y este PC la tomará en el siguiente ciclo.'],
    team: ['Asignado a otro equipo', 'Ejecútalo en el equipo al que pertenece, o corrige data/equipo.json si este PC está mal identificado.'],
    resource: ['Falta un recurso en este PC', 'Ejecútalo en el equipo que dispone del recurso, o corrige equipos/equipos.json si este PC ya lo tiene.'],
    concurrency: ['En cola de este PC', 'Empezará cuando termine el trabajo en marcha. Para ejecutar más a la vez, sube concurrencia en data/equipo.json.'] }[job?.waiting?.code];
  if (held) return { category: 'operativo', label: held[0], waiting: true, message: job.waiting.message, action: held[1], ...(job.waiting.until ? { until: job.waiting.until } : {}) };
  if (!['needs_attention', 'retry_wait'].includes(job?.state) || !job.error?.code) return null;
  const [category, action] = fromQuestions(job) ?? BY_CODE[job.error.code] ?? ['operativo', 'Revisa el informe de la etapa y decide en la ficha del trabajo.'];
  return { category, label: CATEGORY[category], code: job.error.code, action, ...(job.state === 'retry_wait' && job.nextAttemptAt ? { until: job.nextAttemptAt, waiting: true } : {}) };
}
export const FAILURE_CATEGORIES = CATEGORY;
