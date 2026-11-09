# Coordinación y recuperación del pipeline

Arquitectura y procedimientos de recuperación del Centro de Operaciones.

## Activación y diagnóstico

- La entrada del panel es `panel/dashboard.mjs`. Los checkouts de producto bajo `workspaces/` tienen su propio código.
- `settings.runtime` en `/api/state` identifica el proceso, su fecha de inicio, la entrada y las huellas de los módulos observados al arrancar. Compararlas con disco permite detectar si hace falta una recarga.
- El lanzador reutiliza un panel abierto. Para aplicar cambios del backend, programa el reinicio cuando los ejecutores estén inactivos.

## Fuentes de verdad y contrato

`data/events.jsonl` es el registro durable; `data/state.json`, su instantánea. ORCA acredita la ejecución y sus identidades. Obsidian es documentación derivada. Un trabajador terminado y una entrega completa son hechos distintos.

Cada nuevo job incorpora `contract.version=1`: objetivo, entradas, responsable, restricciones, criterios, decisiones conocidas, evidencia, resultado esperado y condición de finalización. Se envía entero junto al brief y las decisiones vigentes. Cuando el registro antiguo no contiene criterios estructurados, se conserva el prompt: `criteriaSource=legacy_prompt` no inventa una aceptación.

La entrega v1 se guarda como JSON o bloque `centro-delivery`: trabajo, intento de entrada de Task, etapa, Run, Task, Dispatch, `outcome`, `scope`, resumen, aceptación con evidencia, preguntas obligatorias/opcionales, decisiones y aprobación. Los cuatro resultados son `completed`, `needs_input`, `blocked`, `failed`; el alcance es `complete` o `partial`. QA y Revisión necesitan aprobación expresa con evidencia y todos los criterios obligatorios del encargo. Una propuesta parcial no equivale a producto completo.

Los perfiles se mantienen: Planificador para análisis (GPT-6 Luna/high); UX → Desarrollo → QA → Revisión para código (GPT-6.1 Sol/medium), uno activo cada vez. El texto legible acompaña al contrato. La compatibilidad histórica conserva el marcador final exacto y correlacionado; no acepta una búsqueda libre de «APROBADO».

## Identidad, decisiones y transporte

| Identificador | Función |
| --- | --- |
| idea + versión | Revisión deliberada del objetivo; se refleja en el job nuevo |
| solicitud | Intención durable panel→coordinador, con snapshot de origen |
| recibo automático | Admisión idempotente bajo la configuración existente |
| job | Unidad local y límite de intentos |
| `attempt` / `queueAttempt` | Ejecución local; aumenta al reanudar/reintentar |
| `taskInputAttempt` / entrega `jobAttempt` | Intento fijado en el spec inmutable de la Task |
| etapa | Planificador, UX, Desarrollo, QA o Revisión |
| Run / Task / Dispatch | Agrupación, encargo inmutable y ejecución física en ORCA |
| mensaje | Evidencia de consulta o entrega, correlacionada con el Dispatch |

Un retry nativo mantiene la Task y `taskInputAttempt`, crea otro Dispatch con `retryOfDispatchId` y consume otro intento local. Una continuación con decisiones nuevas conserva el job cuando está en `needs_input`, crea una Task con el nuevo brief y enlaza el predecesor. Los límites del job siguen aplicándose.

Ideas y tareas transportan objetivo, criterios, versión, destino confirmado y decisiones. Repetir la misma intención recupera su resultado; enviar deliberadamente otra versión crea otra identidad. Una confirmación incompleta puede corregirse explícitamente antes de crear el recibo/job. El endpoint y el mensaje del coordinador usan el mismo formato.

El panel no es un terminal ORCA. El puente lee `data/coordinator-bindings.json`, elige por proyecto y después por empresa, y verifica propietario de Run y conexión de la terminal exacta. Conserva la configuración por entorno como compatibilidad cuando el archivo no existe. La instalación dispone de coordinadores separados de Agencia y Videojuegos; los trabajos nuevos conservan su vínculo y sus etapas comparten la Run correspondiente. El histórico sin propietario no se reasigna. Operación, escalado y recuperación: [COORDINATOR_OPERATIONS.md](docs/COORDINATOR_OPERATIONS.md).

Antes de enviar se persiste `sending`, Run y remitente. Se usa `send --from … --to run:… --thread-id …`; al recuperar se consulta la misma Run y marcador. Si el aviso pudo salir y no aparece en la página consultada, queda incierto y no se reenvía. Errores conservan código y metadatos seguros de etapa/petición, sin cuerpos privados ni stderr. El ejecutable admite `ORCA_CLI_COMMAND`, `ORCA_CLI` o la ruta instalada.

Las respuestas se agrupan por objetivo y ronda. Todas las imprescindibles deben estar resueltas antes de una continuación; se incluyen las decisiones hermanas y las delegadas. El brief no acumula recursivamente prompts completos. El contexto largo tiene un artefacto íntegro con referencia, no un prefijo presentado como resumen.

Preguntas de entregas bloqueadas o en ejecución se muestran solo si coinciden trabajo, intento, etapa y asignación. El adaptador consulta `ask` v1 correlacionado cada diez segundos mientras el trabajador está activo. Mensajes nativos sin contrato/identidad suficiente necesitan revisión en ORCA. Responder en el panel a un trabajador aún vivo conserva la intención pendiente y todas las decisiones. Si ese mismo Dispatch termina con `needs_input` verificado, la siguiente reconciliación reanuda el mismo job sin reiniciar sus intentos. Responder al trabajador mientras permanece vivo requiere al coordinador en ORCA: el panel no lo sustituye ni envía un `ask-answer` no verificado.

## Estados y recuperación

- Un `needs_attention` bloquea el resto del lote, también si aparece tras el primer job.
- Etapas dependientes no empiezan antes de las anteriores. Un callback tardío o con otro Run/Task/Dispatch/intento se rechaza.
- Un inicio sin Dispatch confirmado no se repite. Un Dispatch existente se consulta antes de un nuevo efecto. Los fallos confirmados pueden usar retry nativo; los inciertos requieren revisión.
- Se exige salida física confirmada en entregas v1. Pausa impide nuevos inicios; no equivale a cancelación ni confirma una parada. Si la limpieza no acredita el cierre, se conserva el bloqueo inseguro.
- Informes completos se guardan bajo `data/stage-reports/` con SHA256. Su recuperación verifica directorio, contenido e identidad. Sustituir Dispatch invalida referencias anteriores, sin borrar el ledger histórico.
- Transcripciones requieren origen exacto, identidad estable, paginación sin ciclos y completitud explícita. Los recibos y resultados de Task deben coincidir. Una página limitada nunca se interpreta como entrega final.
- Se reprodujo un fallo intermitente de Windows al reemplazar `auto-run.json` mientras era leído: un job ya terminado recibía `needs_attention`. La corrección reintenta solo el reemplazo del archivo preparado, durante un máximo de 1,5 s, sin repetir admisión ni Dispatch; diez repeticiones del escenario y pruebas de errores permanentes pasaron.
- Bandeja y solicitudes usan un bloqueo entre procesos además del reemplazo atómico. Un bloqueo huérfano requiere revisión expresa; `recoverInboxLock` no roba el bloqueo de un proceso vivo.

La reconciliación usa manifiesto `schema:2` con `decisionId`, `jobId`, `scope`, `dispatches`, `destination` y evidencia. Verifica el checkout, rama y SHA reales antes y después de consultar ORCA. Acepta cero o varios retries y perfiles de ambos negocios. `schema:1` sigue legible y se trata como WIP. Entrega parcial o integración pendiente conserva `needs_attention/delivery_wip`; no se hace integración al reconciliar. No quedan rama, commit ni cinco Dispatches específicos en el mecanismo.

Las pruebas de reconciliación reproducen un fallo, un retry y la aprobación posterior con identificadores sintéticos. El caso conserva el estado de entrega parcial hasta que se verifica la integración.

## Contexto, documentación y métricas

Los specs contienen instrucciones, contrato y referencias completos; se registran caracteres/bytes totales. Las entregas incluyen criterios, decisiones, preguntas y evidencia. Un informe legado mayor de 24.000 caracteres requiere lectura del artefacto completo. No se aplica el recorte ciego de 3.500 caracteres.

UX se conserva en trabajos de interfaz, interacción, accesibilidad o requisitos ambiguos. En cambios puramente mecánicos, sin comportamiento visible y con una comprobación determinista suficiente, cabría proponer omitirla; esta fase **no activa ese salto** porque faltan medidas que lo justifiquen. QA y revisión siguen siendo obligatorias.

Obsidian conserva notas históricas y una nota de estado vigente, con revisión, cancelación o retirada de éxito. El lector prioriza decisiones y resultados, filtra por proyecto, deduplica versiones y cuenta cabeceras/rutas dentro del presupuesto. **El lector sigue sin conectarse al ejecutor raíz**; corregirlo no equivale a alimentarlo automáticamente a cada agente. La bóveda real no se reescribe en las pruebas.

`npm run metrics` o `node metrics.mjs --root CARPETA` solo leen. Informan de trabajos, intentos, eventos, consultas, decisiones, reintentos, correcciones, tiempos observables y cobertura. Los contadores CLI no son llamadas a modelos. Codex suma el consumo recibido en todos sus turnos; ORCA conserva tokens `null` si no los facilita. Presupuesto estimado API y facturación real siguen siendo distintos.

Evaluación y requisitos de Agent Skills, MCP Inspector y Langfuse: [INTEGRATIONS_EVALUATION.md](docs/INTEGRATIONS_EVALUATION.md). No se instala ni conecta ninguno.

## Evidencia de validación

`npm test` ahora incluye las suites de raíz y panel: **184 pruebas aprobadas** en la revisión final previa a la incorporación. Incluyen aprobación/incompletitud, cobertura de aceptación, IDs ajenos, callbacks tardíos, retry nativo, reconciliación, interrupciones, tres respuestas→una continuación, decisión delegada, corrección de confirmación, nueva versión, concurrencia entre procesos, transcripciones, Obsidian y métricas. Se ejecutaron también las **7 suites de navegador** existentes con solicitudes interceptadas y directorios temporales. Accesibilidad se comprobó a 320, 390, 800 y 1440 px; diseño y CSS se conservan.

Comparación ejecutada contra la instantánea inicial `f2b2d0c`, con las mismas entradas y cero llamadas a proveedores:

| Caso simulado | Antes | Después |
| --- | ---: | ---: |
| Jobs intentados cuando falla el primero de dos | 2 | 1 |
| Continuaciones tras responder tres preguntas | 3 | 1 |
| Continuaciones con las tres decisiones | 0 | 1 |
| Caracteres totales en briefs de continuación | 1.286 | 887 |
| Informe UX artificial de 8.035 caracteres entregado | 3.500 | 8.035 |
| Criterio tras el carácter 6.606 conservado | No | Sí |
| Tiempo local del conjunto de fixtures, una muestra | 80,60 ms | 103,25 ms |
| Tokens / tiempo de modelo | No disponible | No disponible |

El tiempo local incluye validaciones y disco, no mide rendimiento de modelos y no permite porcentajes de ahorro. La ampliación de contexto UX es intencionada para conservar calidad. Logs, comparación y métricas de lectura quedan en la copia aislada `.artifacts/` y se copian al respaldo de instalación como evidencia.

## Compatibilidad y reversión

No hay migración de datos ni reescritura del histórico. Los jobs existentes siguen legibles; los nuevos adoptan contrato v1. Las nuevas validaciones pueden detener una entrega antes aceptada sin suficiente evidencia: el informe queda conservado para revisión.

La incorporación crea un respaldo fuera del repositorio con los archivos originales, manifiesto de huellas y `Restore-Pipeline.ps1`. Su modo predeterminado solo comprueba; `-Apply` restaura únicamente archivos que todavía coincidan con la versión instalada. Si cambiaron después, se detiene para no perder trabajo. No toca `data`, la bóveda ni checkouts. La reversión también requiere una ventana sin escritores/ejecutores: no reinicia servicios ni modifica autoejecución.

La conexión a Orca, el destino remoto y la integración se comprueban por instalación y por encargo.
