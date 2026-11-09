# Contratos del pipeline de Orca

El panel usa los mismos contratos con Codex y Claude Code. El lanzador elige el agente. La cola conserva quién autorizó el trabajo, el destino, la secuencia de etapas y la evidencia.

| Documento o código | Qué define |
| --- | --- |
| [workflow-contract.mjs](../workflow-contract.mjs) | Validación de encargo y entrega v1, campos, identidades y reglas de aprobación. |
| [Coordinación](COORDINATOR_OPERATIONS.md) | Avisos al coordinador, preguntas agrupadas, traspasos, enrutamiento y consultas de contexto. |
| [Preparación](COORDINATOR_PREPARATION.md) | Autorización, trabajador preparador, registro y verificación del nuevo destino. |
| [Recuperación](../PIPELINE_COORDINATION.md) | Reanudación, informes íntegros y reconciliación de Run, Task y Dispatch. |
| [Integración](../GITHUB_INTEGRATION.md) | Puertas de publicación y verificación de commit, PR, checks y merge. |

## Encargo y entrega

El encargo se congela con su objetivo, criterios, restricciones, decisiones y evidencias esperadas. Para código, `productAcceptance` contiene criterios locales comprobables. `endToEndCriteria` conserva el objetivo global que puede incluir PR, CI y merge. El coordinador autoriza la ruta. El motor encadena las etapas.

Cada entrega v1 incluye `jobId`, `jobAttempt`, `stage`, `runId`, `taskId` y `dispatchId` del trabajador exacto, además de `outcome`, `scope`, resumen y aceptación. En QA y Revisión cada criterio necesita evidencia y una aprobación explícita. El motor conserva los informes parciales o bloqueados y exige que la salida del trabajador quede acreditada antes de sustituirlo.

Para consultar Obsidian, el trabajador envía los mismos identificadores al panel y cita el `source.id` de la nota utilizada. La consulta usa el intento fijado en la Task. Reanudar un Dispatch o recuperar una entrega conserva la identidad original. [Guía de Obsidian](OBSIDIAN.md)
