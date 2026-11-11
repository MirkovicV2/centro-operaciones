// One shape for every stage's brief, whatever the provider: the same eight sections, always present, in this order.
// The delivery format comes last because it is what the worker must produce when it finishes.
// Product criteria and closing criteria are kept apart: a worker answers for the product criteria of its own
// stage; review, remote checks and merge are accredited later by the engine with their own requirements.
export const STAGE_SECTIONS = Object.freeze([
  ['objetivo', '1. OBJETIVO'], ['alcance', '2. ALCANCE'], ['entradas', '3. ENTRADAS'], ['decisiones', '4. DECISIONES VIGENTES'],
  ['criterios', '5. CRITERIOS DE ACEPTACIÓN'], ['evidencias', '6. EVIDENCIAS EXIGIDAS'], ['devolucion', '7. DEVOLUCIÓN Y ESCALADO'], ['entregables', '8. ENTREGABLES'],
]);

// What each stage hands over, what must back it and where its doubts and rejections go.
export const STAGE_TERMS = Object.freeze({
  planner: Object.freeze({
    entregables: 'Un plan breve con pasos, criterios de aceptación y preguntas imprescindibles. Ningún archivo modificado.',
    evidencias: 'La fuente de cada afirmación del plan: archivo, comando o source.id consultado.',
    devolucion: 'Si falta una decisión de producto, pregúntala al coordinador (needs_input); no la supongas.',
  }),
  ux: Object.freeze({
    entregables: 'Una especificación de diseño que Desarrollo pueda aplicar y QA comprobar. Ningún archivo modificado.',
    evidencias: 'La pantalla, el archivo o la versión del producto en que se apoya cada decisión de diseño.',
    devolucion: 'Dudas de alcance o de producto: al coordinador. Cómo implementarlo lo decide Desarrollo.',
  }),
  developer: Object.freeze({
    entregables: 'Los cambios en el checkout aislado, sin commit, y un informe de qué cambió, cómo se comprobó y qué queda pendiente.',
    evidencias: 'Comandos ejecutados con su resultado, archivos tocados y, por criterio, cómo lo comprobaste. Separa lo ejecutado de lo no comprobado.',
    devolucion: 'Una duda o decisión de diseño se consulta al coordinador, que puede trasladarla a Diseño. Un defecto devuelto por QA o Revisión se corrige sobre el mismo candidato.',
  }),
  qa: Object.freeze({
    entregables: 'Un veredicto por criterio sobre el candidato exacto. Ningún archivo del producto modificado.',
    evidencias: 'Por criterio: comando o pasos, entorno (dispositivo o anchura de pantalla cuando aplique) y resultado observado.',
    devolucion: '', // the brief already carries the QA rule that separates a product failure from a pending check
  }),
  reviewer: Object.freeze({
    entregables: 'Una revisión independiente del diff, con veredicto y hallazgos clasificados. Ningún archivo modificado.',
    evidencias: 'Archivo y línea de cada hallazgo, y si lo verificaste ejecutando o es una hipótesis.',
    devolucion: 'Un defecto reproducible de un criterio vuelve a Desarrollo a través del motor (acceptance failed, con pasos). Lo no bloqueante se registra y no detiene la entrega.',
  }),
});

export const CLOSING_CRITERIA_NOTE = 'Son los criterios del producto para tu etapa. La revisión posterior, los checks remotos y el merge son criterios de cierre: los acredita el motor después, con sus propios requisitos.';

// Renders the sections. Every one must have content: a brief with a missing section is a defect of the engine.
export function renderStageContract(sections) {
  const unknown = Object.keys(sections).find(key => !STAGE_SECTIONS.some(([name]) => name === key));
  if (unknown) throw Object.assign(new Error(`Sección de contrato desconocida: ${unknown}.`), { code: 'stage_contract_invalid' });
  return STAGE_SECTIONS.map(([key, heading]) => {
    const body = (sections[key] ?? []).filter(Boolean);
    if (!body.length) throw Object.assign(new Error(`El contrato de la etapa no define ${heading}.`), { code: 'stage_contract_invalid' });
    return `== ${heading} ==\n${body.join('\n\n')}`;
  });
}
