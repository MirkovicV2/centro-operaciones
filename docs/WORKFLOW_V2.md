# Workflow V2 como Revisión de un proyecto

Opcional y apagado por defecto. Sin `data/workflow-v2.json`, o para un proyecto que no aparezca en él, nada cambia. Ejemplo: `ejemplos/workflow-v2.example.json`.

En un proyecto gobernado, después de QA el Centro no lanza su Revisión. Entrega el checkout a `wfv2 submit` (Engineering System), que congela el candidato, ejecuta las comprobaciones en el sandbox y lanza el revisor aislado. El resultado es una recomendación: solo decide el owner, en V2.

## Fase A (por defecto)

El trabajo se detiene con el estado de V2 y el siguiente paso del owner. El Centro nunca integra un trabajo gobernado.

## Fase B: integrar el candidato aprobado (`"integrateAfterApproval": true`)

1. Igual que la fase A: tras QA se envía a V2 y el trabajo se detiene con `workflow_v2_owner_pending`.
2. El owner decide en V2: `wfv2 approve <tarea>`, o `wfv2 reject <tarea>`.
3. En el panel, **Reintentar** el trabajo. El Centro no vuelve a lanzar ninguna etapa de Orca: recupera QA, no reenvía a V2, lee `wfv2 status <tarea>` y solo sigue si se cumplen las dos condiciones:
   - V2 muestra `aprobado` con la misma identidad y evidencia que devolvió el envío. La identidad de V2 incluye la huella del candidato congelado.
   - El checkout conserva la huella que validó QA, que es la que se envió a V2.
4. Antes de cualquier efecto en Git o GitHub, el registro de integración queda atado a esa aprobación (`workflowV2Approval`). Después se integra exactamente esa huella con la integración GitHub de siempre.

Garantías:

- **Solo el candidato aprobado.** Cada candidato tiene su propia tarea V2, con el ID del trabajo más el prefijo de su huella. Si el checkout cambia, la huella ya no coincide: el trabajo se detiene, QA tiene que volver a validar y el nuevo candidato va a otra tarea V2, que necesita su propia aprobación. Una aprobación de otra identidad o evidencia, o un registro atado a otra aprobación, detiene el trabajo sin integrar.
- **Reinicios.** La aprobación vive en el ledger de V2 y se vuelve a comprobar en cada reanudación. La atadura del registro no se reescribe. Si el proceso se detiene a mitad de la integración, **Reintentar** retoma el mismo registro: la integración GitHub reconcilia los intentos guardados (commit, push, PR, merge) sin repetir un efecto que no pueda confirmar. Si ya está completa, no hace nada más.

Para los trabajos con recibo de autoejecución, **Reintentar** usa una reanudación específica (`resumeWorkflowV2Receipt`). Solo se acepta cuando el trabajo espera la decisión del owner, o cuando su integración aprobada se detuvo. Reanudar consume un intento del trabajo, como cualquier reintento.

Necesita una versión de Engineering System en la que `wfv2 status` muestre `identity` y `evidence_id`.

## Límites conocidos

- Mientras un trabajo espera al owner, su recibo queda en `needs_attention`, y eso detiene la autoejecución de esa empresa, igual que en la fase A.
- La reconciliación automática de integraciones del Centro (`same_attempt_integration_reconcile`) exige la aprobación de la Revisión del Centro y no se aplica a trabajos gobernados por V2. Para ellos, la reanudación es **Reintentar**.
