import { createHash } from 'node:crypto';

export const IDENTIFIERS = {
  jobId: /^[a-zA-Z0-9_-]{1,80}$/,
  runId: /^run_[a-zA-Z0-9_-]{6,80}$/,
  taskId: /^task_[a-zA-Z0-9_-]{6,80}$/,
  dispatchId: /^ctx_[a-zA-Z0-9_-]{6,80}$/,
};
export class ContractError extends Error {
  constructor(message, code = 'delivery_invalid') { super(message); this.code = code; this.safeMessage = message; this.uncertain = true; }
}
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// 30: criteria compare by meaning, not by bytes. A reviewer writing without
// accents, in another case or with different spacing still names the same
// criterion. Combining marks are stripped after NFD; the result is NFC.
export function canonicalCriterion(text) {
  return String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}
// Stable id derived from the canonical text, so contracts stored without ids keep working.
export const criterionId = text => 'crit_' + createHash('sha256').update(canonicalCriterion(text)).digest('hex').slice(0, 16);
export const acceptanceCriteriaIds = acceptance => (acceptance ?? []).map(criterion => ({ id: criterionId(criterion), criterion }));
// A worker told to send non-ASCII as \uXXXX sometimes escapes twice, and escapes plain ASCII too: after JSON.parse its
// text still carries a literal \u0027 where the criterion has an apostrophe (second real pilot: an approved review was
// stopped for "omitting" a criterion it had quoted with its exact id). Undone on the worker's side only, for comparing.
const unescapedUnicode = text => String(text ?? '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
export function matchesCriterion(item, criterion) {
  if (!object(item) || typeof criterion !== 'string') return false;
  const wanted = canonicalCriterion(criterion);
  return (canonicalCriterion(item.criterion) === wanted || canonicalCriterion(unescapedUnicode(item.criterion)) === wanted)
    && (item.criterionId === undefined || item.criterionId === criterionId(criterion));
}
const nonempty = (value, max = 12000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value, limit = 50) => Array.isArray(value) && value.length <= limit && value.every(item => nonempty(item, 4000));

// New submissions opt in explicitly. Historical prompt extraction below stays unchanged.
export function acceptanceFromSuccessCriteria(text) {
  if (typeof text !== 'string') throw new ContractError('Los criterios deben ser texto.', 'job_contract_invalid');
  const source = text.replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const lines = source.split('\n');
  const listItem = /^\s*(?:\d+[.)]|[-*+•])\s+\S/;
  const heading = /^(?:Criterios? de (?:éxito|aceptación)|Criterios?):\s*$/i;
  const start = heading.test(lines[0]) ? 1 : 0;
  const nonemptyLines = lines.slice(start).filter(line => line.trim());
  let acceptance = [source];
  if (nonemptyLines.length && listItem.test(nonemptyLines[0])) {
    const items = [];
    let unambiguous = true;
    for (const line of nonemptyLines) {
      if (listItem.test(line)) items.push(line.trim());
      else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ' ' + line.trim();
      else { unambiguous = false; break; }
    }
    if (unambiguous) acceptance = items;
  } else if (nonemptyLines.length > 1 && nonemptyLines.every(line => /^\S/.test(line) && /[.!?;]$/.test(line.trim()))) {
    // Explicit sentence-per-line criteria; ambiguous wrapped prose remains one criterion.
    acceptance = nonemptyLines.map(line => line.trim());
  }
  if (!strings(acceptance)) throw new ContractError('Los criterios exceden los límites del contrato.', 'job_contract_invalid');
  return acceptance;
}

export function normalizeJobContract(spec) {
  const given = spec.contract ?? {};
  if (!object(given) || (given.version !== undefined && given.version !== 1)) throw new ContractError('Contrato de encargo inválido.', 'job_contract_invalid');
  const productScoped = given.acceptanceScope === 'product';
  if (given.acceptanceScope !== undefined && !productScoped || !productScoped && (given.productAcceptance !== undefined || given.endToEndCriteria !== undefined)) {
    throw new ContractError('El alcance del contrato de producto debe ser explícito.', 'job_contract_invalid');
  }
  if (productScoped) {
    validateProductAcceptance(given.productAcceptance);
    if (!strings(given.endToEndCriteria) || !given.endToEndCriteria.length
      || given.acceptance !== undefined && JSON.stringify(given.acceptance) !== JSON.stringify(given.productAcceptance)) {
      throw new ContractError('La aceptación local y las condiciones globales del contrato no coinciden.', 'job_contract_invalid');
    }
  }
  const criterion = spec.successCriteria || spec.prompt?.match(/(?:Criterio de éxito|Criterios de aceptación|Criterio):\s*([^\n]+)/i)?.[1];
  const contract = {
    version: 1, objective: given.objective ?? spec.objective ?? spec.title,
    inputs: given.inputs ?? [], constraints: given.constraints ?? [],
    knownDecisions: given.knownDecisions ?? [], evidence: given.evidence ?? [],
    acceptance: productScoped ? [...given.productAcceptance] : given.acceptance ?? (criterion ? [criterion.trim()] : []),
    owner: given.owner ?? 'coordinator',
    expectedResult: given.expectedResult ?? (spec.kind === 'code' ? 'Cambios verificables y evidencia de validación.' : 'Análisis y decisiones verificables.'),
    completionCondition: given.completionCondition ?? 'Criterios de la etapa satisfechos y evidencia disponible.',
  };
  if (productScoped) Object.assign(contract, {
    acceptanceScope: 'product', productAcceptance: [...given.productAcceptance], endToEndCriteria: [...given.endToEndCriteria],
  });
  if (!nonempty(contract.objective, 4000) || !strings(contract.inputs) || !strings(contract.constraints)
    || !strings(contract.acceptance) || !strings(contract.knownDecisions) || !strings(contract.evidence) || !nonempty(contract.owner, 100) || !nonempty(contract.expectedResult, 2000)
    || !nonempty(contract.completionCondition, 2000)) throw new ContractError('Faltan campos verificables del encargo.', 'job_contract_invalid');
  return { ...contract, criteriaSource: contract.acceptance.length ? 'explicit' : 'legacy_prompt' };
}

function validateProductAcceptance(value) {
  if (!strings(value) || !value.length || value.some(item => item.length > 2000 || /[\r\n]/.test(item))
    || new Set(value.map(item => item.trim().replace(/\s+/g, ' '))).size !== value.length) {
    const error = new ContractError('Incluye confirmation.productAcceptance: una lista de 1–50 criterios locales del producto, independientes, sin duplicados y de una sola línea (máximo 2000 caracteres cada uno). Conserva revisión, CI y merge en successCriteria global; no los conviertas en comprobaciones de QA.', 'product_acceptance_required');
    error.uncertain = false; error.status = 400;
    throw error;
  }
}

// Explicit new submissions only. Never infer product scope from historical prose.
export function productJobContract({ objective, successCriteria, productAcceptance }) {
  validateProductAcceptance(productAcceptance);
  if (!nonempty(successCriteria, 4000)) throw new ContractError('Conserva el criterio global de éxito íntegro.', 'job_contract_invalid');
  return normalizeJobContract({ kind: 'code', contract: {
    version: 1, objective, acceptanceScope: 'product', productAcceptance,
    endToEndCriteria: [successCriteria],
    completionCondition: 'Cierre global posterior a todas las etapas y condiciones endToEndCriteria; completed de un trabajador solo acredita su etapa.',
  } });
}

export function validateContinuation(value) {
  if (!object(value) || value.version !== 1 || !IDENTIFIERS.jobId.test(value.rootJobId ?? '')
    || !IDENTIFIERS.jobId.test(value.parentJobId ?? '') || !(Number.isInteger(value.decisionRevision) && value.decisionRevision > 0 || /^[a-f0-9]{16,64}$/.test(value.decisionRevision ?? ''))
    || !Array.isArray(value.questionIds) || value.questionIds.length > 100 || !value.questionIds.every(id => nonempty(id, 200))
    || !Array.isArray(value.decisions) || value.decisions.length > 100
    || !value.decisions.every(item => object(item) && nonempty(item.questionId, 200) && nonempty(item.question, 4000) && nonempty(item.answer, 6000))
    || Buffer.byteLength(JSON.stringify(value)) > 80000) throw new ContractError('Decisiones de continuación inválidas.', 'continuation_invalid');
  return structuredClone(value);
}

function normalizeUxAcceptanceDecision(value, expected) {
  if (value?.stage !== 'ux' || expected.stage !== 'ux' || !strings(expected.acceptance) || !expected.acceptance.length
    || !Array.isArray(value.decisions) || value.decisions.length > 100) return value;
  const matches = value.decisions.filter(item => item?.key === 'productAcceptance');
  if (matches.length !== 1 || !Array.isArray(matches[0].value)
    || matches[0].value.length !== expected.acceptance.length
    || !matches[0].value.every((criterion, index) => criterion === expected.acceptance[index])) return value;
  const serialized = JSON.stringify(matches[0].value);
  if (!nonempty(serialized, 4000)) return value;
  return { ...value, decisions: value.decisions.map(item => item === matches[0] ? { ...item, value: serialized } : item) };
}

export function validateDelivery(value, expected = {}, { requireUxAcceptanceArray = false, strictReview = false } = {}) {
  if (!object(value) || value.version !== 1) throw new ContractError('La entrega debe usar el contrato version 1.');
  for (const key of ['jobId', 'runId', 'taskId', 'dispatchId']) {
    if (!IDENTIFIERS[key].test(value[key] ?? '') || (expected[key] && value[key] !== expected[key])) {
      throw new ContractError('La entrega no corresponde al ' + key + ' esperado.', 'delivery_identity_mismatch');
    }
  }
  if (!Number.isInteger(value.jobAttempt) || value.jobAttempt < 1 || (expected.jobAttempt && value.jobAttempt !== expected.jobAttempt)
    || !['planner', 'ux', 'developer', 'qa', 'reviewer'].includes(value.stage) || (expected.stage && expected.stage !== value.stage)) {
    throw new ContractError('Etapa o intento ajeno a la entrega.', 'delivery_identity_mismatch');
  }
  const normalized = normalizeUxAcceptanceDecision(value, expected);
  if (requireUxAcceptanceArray && normalized === value) throw new ContractError('El informe no acredita la lista exacta de criterios de UX.');
  value = normalized;
  if (!['completed', 'needs_input', 'blocked', 'failed'].includes(value.outcome) || !['complete', 'partial'].includes(value.scope)
    || !nonempty(value.summary) || !strings(value.evidence) || !Array.isArray(value.acceptance) || value.acceptance.length > 100
    || !value.acceptance.every(item => object(item) && nonempty(item.criterion, 2000)
      && (item.criterionId === undefined || /^crit_[a-f0-9]{16}$/.test(item.criterionId))
      && ['passed', 'failed', 'unverified'].includes(item.status) && typeof item.evidence === 'string' && item.evidence.length <= 4000)
    || !Array.isArray(value.questions) || value.questions.length > 30
    || !value.questions.every(item => object(item) && /^[a-zA-Z0-9_-]{1,100}$/.test(item.id ?? '') && nonempty(item.text, 4000)
      && typeof item.required === 'boolean' && (item.decisionKey === undefined || nonempty(item.decisionKey, 200)))
    || !Array.isArray(value.decisions) || value.decisions.length > 100
    || !value.decisions.every(item => object(item) && nonempty(item.key, 200) && nonempty(item.value, 4000))
    || !['approved', 'blocked', 'not_applicable'].includes(value.approval)) {
    throw new ContractError('La entrega tiene campos ausentes o inválidos.');
  }
  if (new Set(value.questions.map(q => q.id)).size !== value.questions.length) throw new ContractError('Preguntas duplicadas en la entrega.');
  // C (structured review): QA and Revisión may report findings with a severity and the candidate they judged.
  // Both fields are optional, so a v1 delivery without them stays valid.
  if (value.findings !== undefined && (!['qa', 'reviewer'].includes(value.stage) || !Array.isArray(value.findings) || value.findings.length > 50
    || !value.findings.every(item => object(item) && FINDING_SEVERITIES.includes(item.severity) && nonempty(item.summary, 2000)
      && typeof item.evidence === 'string' && item.evidence.length <= 4000
      && (item.criterionId === undefined || /^crit_[a-f0-9]{16}$/.test(item.criterionId))))) {
    throw new ContractError('Los hallazgos de la entrega son inválidos.');
  }
  if (value.candidate !== undefined && (!['qa', 'reviewer'].includes(value.stage) || !/^[a-f0-9]{64}$/.test(value.candidate))) {
    throw new ContractError('La huella del candidato revisado es inválida.');
  }
  if (value.candidate !== undefined && expected.candidate && value.candidate !== expected.candidate) {
    throw new ContractError('El veredicto corresponde a otro candidato; repite la etapa sobre el actual.', 'delivery_candidate_mismatch');
  }
  const blocking = (value.findings ?? []).filter(item => item.severity === 'blocking');
  if (['qa', 'reviewer'].includes(value.stage) && value.approval === 'approved' && blocking.length) {
    throw new ContractError('Una aprobación no puede tener hallazgos bloqueantes.');
  }
  // Stop only for something relevant: a product rejection needs a blocking finding or a failed criterion,
  // each with evidence. Non-blocking findings are recorded and shown, never a reason to stop.
  // Only for a fresh report (strictReview): stored deliveries keep validating as they did when accepted.
  if (strictReview && ['qa', 'reviewer'].includes(value.stage) && value.outcome === 'blocked' && value.approval === 'blocked'
    && !value.questions.some(q => q.required)
    && !blocking.some(item => item.evidence.trim())
    && !value.acceptance.some(item => item.status === 'failed' && item.evidence.trim())) {
    throw new ContractError('Un rechazo necesita un hallazgo bloqueante o un criterio fallido, con evidencia. Un fallo propio de la etapa es outcome:failed.', 'delivery_block_unjustified');
  }
  if (value.outcome === 'needs_input' && !value.questions.some(q => q.required)) throw new ContractError('needs_input requiere una pregunta imprescindible.');
  if (value.outcome === 'completed' && value.questions.some(q => q.required)) throw new ContractError('Una entrega completada no puede tener preguntas imprescindibles.');
  if (value.approval === 'approved' && (value.outcome !== 'completed' || value.scope !== 'complete'
    || !value.acceptance.length || !value.evidence.length || value.acceptance.some(a => a.status !== 'passed' || !a.evidence.trim()))) {
    throw new ContractError('Una aprobación necesita alcance completo y evidencia de todos sus criterios.');
  }
  if (['qa', 'reviewer'].includes(value.stage) && value.outcome === 'completed' && value.approval !== 'approved') {
    throw new ContractError('QA/Revisión completadas necesitan una aprobación explícita con evidencia.');
  }
  if (value.outcome === 'completed' && value.scope === 'complete' && ['planner', 'qa', 'reviewer'].includes(value.stage)) {
    for (const criterion of expected.acceptance ?? []) {
      if (!value.acceptance.some(item => matchesCriterion(item, criterion) && item.status === 'passed' && item.evidence.trim())) {
        throw new ContractError('La entrega omite un criterio obligatorio del encargo: ' + criterion, 'delivery_acceptance_missing');
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 128000) throw new ContractError('La entrega supera el límite estructurado.');
  return structuredClone(value);
}

export function parseDelivery(text, expected, { required = false, requireUxAcceptanceArray = false, preserveExplicitBlock = false, strictReview = false } = {}) {
  const source = String(text ?? '').trim();
  let value;
  if (source.startsWith('{')) {
    try { value = JSON.parse(source); } catch { /* The explicit block below may still be present. */ }
  }
  const pattern = new RegExp('```centro-delivery\\s*([\\s\\S]*?)```', 'g');
  const blocks = [...source.matchAll(pattern)];
  if (blocks.length > 1) throw new ContractError('La entrega contiene varios resultados estructurados.');
  if (blocks.length) {
    try { value = JSON.parse(blocks[0][1]); } catch { throw new ContractError('El bloque centro-delivery no es JSON válido.'); }
  }
  // A completed report can still explicitly reject the candidate. This repair can only close the gate.
  if (preserveExplicitBlock && ['qa', 'reviewer'].includes(expected?.stage) && value?.outcome === 'completed'
    && value.scope === 'complete' && value.approval === 'blocked' && Array.isArray(value.acceptance)
    && value.acceptance.some(item => item?.status === 'failed' && typeof item.evidence === 'string' && item.evidence.trim()
      && expected.acceptance?.some(criterion => matchesCriterion(item, criterion)))) value = { ...value, outcome: 'blocked' };
  const contractual = blocks.length || required || (object(value) && ('jobId' in value || 'dispatchId' in value || 'approval' in value));
  if (value !== undefined && contractual) return validateDelivery(value, expected, { requireUxAcceptanceArray, strictReview });
  if (required) throw new ContractError('Falta la entrega estructurada; conserva la evidencia y solicita revisión.', 'delivery_missing');
  return null;
}

export function deliveryInstructions(job, stage, runId) {
  return [
    'CONTRATO DE ENTREGA v1: comunica el resultado mediante un único bloque JSON centro-delivery y cópialo íntegro al body de worker_done.',
    'TRANSPORTE WINDOWS: el body JSON de worker_done debe usar escapes Unicode \\uXXXX para todo carácter no ASCII, manteniendo el contenido exacto. Lee archivos con UTF-8 explícito. Evita pasar código con tildes por una tubería de PowerShell a Python/Node. Genera la serialización desde el objeto original leído de un archivo UTF-8 y verifica JSON.parse antes de enviar. Pasa --body como un único argumento; no construyas una orden de shell concatenada. El mensaje final conserva el mismo contrato completo. Nunca sustituyas tildes por signos de interrogación.',
    'Campos obligatorios: version:1, jobId:' + JSON.stringify(job.id) + ', jobAttempt:' + job.attempts + ', stage:' + JSON.stringify(stage) + ', runId:' + JSON.stringify(runId) + '.',
    'taskId y dispatchId deben ser los de TU asignación Orca, nunca inventados ni tomados de otra etapa.',
    'outcome: completed|needs_input|blocked|failed; scope: complete|partial; summary: resumen; approval: approved|blocked|not_applicable. Si QA o Revisión rechazan el producto, usa outcome:blocked y approval:blocked aunque el informe esté completo.',
    'acceptance:[{criterion,criterionId,status:passed|failed|unverified,evidence}], evidence:[referencias o comprobaciones], questions:[{id,text,required,decisionKey}], decisions:[{key,value}]. Usa arrays vacíos cuando no correspondan.',
    ...(['qa', 'reviewer'].includes(stage) ? ['QA/REVISIÓN: findings:[{severity:blocking|non_blocking,criterionId?,summary,evidence}] para lo que encuentres. Para solo por algo relevante: un rechazo (outcome:blocked, approval:blocked) necesita al menos un hallazgo blocking o un criterio failed, cada uno con evidencia reproducible. Lo non_blocking se registra y no impide aprobar. Si tú no pudiste completar la comprobación (entorno, herramienta, tiempo), usa outcome:failed: no es un rechazo del producto. Si el brief te da la huella del candidato, cópiala en candidate.'] : []),
    ...(job.contract?.acceptance?.length ? ['CRITERIOS DEL CONTRATO CON ID ESTABLE: ' + JSON.stringify(acceptanceCriteriaIds(job.contract.acceptance)) + '. En acceptance copia el texto de cada criterio. Si incluyes criterionId, debe corresponder a ese mismo texto. El motor compara el texto sin distinguir tildes, mayúsculas ni espacios.'] : []),
    'Cada decisions[].value debe ser una cadena de texto. Los criterios de producto ya están en el contrato vigente. Referéncialos en texto sin volver a copiar el array dentro de decisions.',
    'La aceptación corresponde a TU etapa: outcome:completed y scope:complete acreditan que TU etapa terminó, no el cierre global del job. No atribuyas una implementación o prueba futura a UX. QA/Revisión solo aprueban con criterios comprobados y evidencia.',
    ...(job.contract?.acceptanceScope === 'product' ? [
      'ALCANCE EXPLÍCITO DE PRODUCTO: contract.acceptance y contract.productAcceptance son los únicos criterios locales obligatorios de QA/Revisión. Cubre literalmente cada uno con status:passed y evidencia; un criterio local fallido o no verificable bloquea la aprobación.',
      'successCriteria del brief, endToEndCriteria y completionCondition conservan el cierre global. Revisión posterior a QA, checks remotos, PR y merge siguen pendientes del motor en su orden; no los marques passed anticipadamente ni bloquees tu etapa porque una compuerta posterior aún no se haya ejecutado. No autorizas ni omites esas compuertas.',
      'Este alcance explícito vigente prevalece para evaluar acceptance sobre el texto global del brief y sobre handoffs históricos, que siguen siendo evidencia y contexto. No conviertas un agregado global antiguo en criterio local ni lo copies como passed. Conserva todos los criterios de producto sin reinterpretarlos.',
    ] : ['Planificador, QA y Revisión deben cubrir literalmente cada criterio del contrato de encargo en acceptance; cada uno necesita status:passed y evidencia para completar el alcance. Si no puedes comprobarlo, bloquea o declara alcance parcial.']),
    'AUTONOMÍA: usa el contexto, los artefactos y los recursos ya autorizados del encargo. Comprueba su disponibilidad actual antes de dar un entorno por ausente. Usa el PC, la GPU, el dispositivo de pruebas y las sesiones de servicio configuradas para las comprobaciones permitidas por tu perfil. Resuelve decisiones técnicas delegadas y prueba alternativas locales reversibles que mantengan los criterios.',
    'Consulta al coordinador si queda una duda interna imprescindible. Indica qué comprobaste, qué alternativas intentaste y qué parte depende de la respuesta. Continúa las partes independientes que puedas ejecutar con seguridad. Usa needs_input cuando una dependencia esencial siga sin resolver. Una propuesta WIP usa scope:partial y no autoriza integración.',
    'Si consultas mediante ask mientras sigues activo, serializa el contrato needs_input en JSON UTF-8 con las identidades de tu asignación. Codifica esos bytes en Base64URL sin relleno (Node Buffer.from(json, "utf8").toString("base64url")) y envía como único argumento --question el prefijo centro-ask-v1. seguido de lo codificado. Así el comando conserva las comillas y los acentos. El coordinador responde al mismo mensaje de Orca y al mismo trabajador.',
  ].join('\n');
}

export const FINDING_SEVERITIES = ['blocking', 'non_blocking'];
export const deliveryApproved = delivery => delivery?.outcome === 'completed' && delivery.scope === 'complete' && delivery.approval === 'approved';
export const fingerprint = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');

export function handoffText(output) {
  const report = output.artifact ? '\nInforme completo verificado: ' + output.artifact.path + '\nSHA256: ' + output.artifact.sha256 : '';
  if (output.delivery) {
    const { summary, acceptance, decisions, evidence, questions, scope, outcome, findings, candidate } = output.delivery;
    return JSON.stringify({ summary, acceptance, decisions, evidence, questions, scope, outcome, findings, candidate }, null, 2) + report;
  }
  // Legacy reports must retain their acceptance section; a prefix is not a summary.
  if (output.text.length <= 24000) return output.text + report;
  if (!output.artifact) throw new ContractError('El informe largo requiere una referencia completa verificable.', 'handoff_missing_artifact');
  return 'Lee el informe completo antes de actuar; supera el tamaño de contexto incrustado.' + report;
}

export function measuredUsage(value) {
  const number = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null;
  return { inputTokens: number('input_tokens'), cachedInputTokens: number('cached_input_tokens'), outputTokens: number('output_tokens') };
}
