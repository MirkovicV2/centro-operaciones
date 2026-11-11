# Workflow V2 como Revisión de un proyecto

Opcional y apagado por defecto. Sin `data/workflow-v2.json`, o para un proyecto que no aparezca en él, nada cambia. Ejemplo: `ejemplos/workflow-v2.example.json`.

En un proyecto gobernado, después de QA el Centro no lanza su Revisión. Entrega el checkout a `wfv2 submit` (Engineering System), que congela el candidato, ejecuta las comprobaciones en el sandbox y lanza el revisor aislado. El resultado es una recomendación: solo decide el owner, en V2.

## Entorno Python para las comprobaciones (`"pythonEnv"`)

Las comprobaciones de V2 se ejecutan en un sandbox que solo ve `/usr` y los archivos del candidato, así que, por sí solo, no puede ejecutar los tests de un proyecto con dependencias en un virtualenv (Django, por ejemplo). Si el proyecto indica `"pythonEnv": "/ruta/absoluta/.venv"`, el Centro lo pasa a `wfv2 submit --python-env`, que lo monta en solo lectura, sin red, para las comprobaciones de la política que declaren `"python_env": true`. Necesita Engineering System con esa opción.

## Comprobación previa

Antes de lanzar el primer agente de un trabajo gobernado, el Centro comprueba que existen `engineeringSystem`, `stateRoot`, `reviewerConfig` y `pythonEnv` (si están configurados, y que `pythonEnv` tiene un intérprete) y que `python -m wfv2.cli --help` arranca. Si algo falla, el trabajo se para con `workflow_v2_preflight_failed` sin haber lanzado ningún agente. No puede saber qué comprobaciones de la política necesitan el entorno Python.

## Fase A (por defecto)

El trabajo se detiene con el estado de V2 y el siguiente paso del owner. El Centro nunca integra un trabajo gobernado.

## Fase B: integrar el candidato aprobado (`"integrateAfterApproval": true`)

1. Igual que la fase A: tras QA se envía a V2 y el trabajo se detiene con `workflow_v2_owner_pending`.
2. El owner decide en V2. La ficha del trabajo muestra la sección **«Tu decisión en Workflow V2»**: estado en vivo, recomendación del revisor, los archivos del candidato (con los binarios nuevos marcados) y el comando exacto para ese estado, con un botón para copiarlo: `approve <tarea>` en `pendiente_owner`, `verdict <tarea> <rol> accepted` en `revision`, `unblock <tarea>` en `bloqueado`. El veredicto se sigue registrando en la terminal, con la confirmación que pide V2: el Centro nunca lo escribe.
3. Cuando V2 muestra `aprobado`, la sección ofrece **Integrar este candidato** (equivale a **Reintentar**). El Centro no vuelve a lanzar ninguna etapa de Orca: recupera QA, no reenvía a V2, lee `wfv2 status <tarea>` y solo sigue si se cumplen las dos condiciones:
   - V2 muestra `aprobado` con la misma identidad y evidencia que devolvió el envío. La identidad de V2 incluye la huella del candidato congelado.
   - El checkout conserva la huella que validó QA, que es la que se envió a V2.
4. Antes de cualquier efecto en Git o GitHub, el registro de integración queda atado a esa aprobación (`workflowV2Approval`). Después se integra exactamente esa huella con la integración GitHub de siempre.

Garantías:

- **Solo el candidato aprobado.** Cada candidato tiene su propia tarea V2, con el ID del trabajo más el prefijo de su huella. Si el checkout cambia, la huella ya no coincide: el trabajo se detiene, QA tiene que volver a validar y el nuevo candidato va a otra tarea V2, que necesita su propia aprobación. Una aprobación de otra identidad o evidencia, o un registro atado a otra aprobación, detiene el trabajo sin integrar.
- **Reinicios.** La aprobación vive en el ledger de V2 y se vuelve a comprobar en cada reanudación. La atadura del registro no se reescribe. Si el proceso se detiene a mitad de la integración, **Reintentar** retoma el mismo registro: la integración GitHub reconcilia los intentos guardados (commit, push, PR, merge) sin repetir un efecto que no pueda confirmar. Si ya está completa, no hace nada más.

Para los trabajos con recibo de autoejecución, **Reintentar** usa una reanudación específica (`resumeWorkflowV2Receipt`). Solo se acepta cuando el trabajo espera la decisión del owner, o cuando su integración aprobada se detuvo. Reanudar consume un intento del trabajo, como cualquier reintento. Por eso, antes de reanudar, el panel consulta V2: si falta tu decisión, o la tarea sigue bloqueada, rechaza el reintento con el comando que falta y **no gasta ningún intento**.

Si V2 se bloqueó antes de producir evidencia (por ejemplo, una comprobación sin su entorno Python), corrige la causa, ejecuta `wfv2 unblock <tarea>` y pulsa **Reintentar**: se reenvía el mismo candidato, sin volver a lanzar agentes, aunque siga sin commitear en el checkout.

Necesita una versión de Engineering System en la que `wfv2 status` muestre `identity` y `evidence_id`.

## Límites conocidos

- Mientras un trabajo espera al owner, su recibo queda en `needs_attention`, y eso detiene la autoejecución de esa empresa, igual que en la fase A.
- La reconciliación automática de integraciones del Centro (`same_attempt_integration_reconcile`) exige la aprobación de la Revisión del Centro y no se aplica a trabajos gobernados por V2. Para ellos, la reanudación es **Reintentar**.
