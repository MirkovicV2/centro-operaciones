# Autoejecución local y destinos GitHub — Desarrollo

Empresa: panel central de `agency` y `games`, con settings e intenciones separados. Encargo de desarrollo `task_d1a512e37dc4`, dispatch `ctx_451a2b7c5e4f`; UX padre `task_dd31020102a3` / `ctx_07b14f73d871`, consultada en inbox y worker-read. Objetivo: admitir automáticamente solo envíos nuevos confirmados con la empresa activa, por ID exacto y con el pipeline existente. Criterio: un solo intento simulado, sin promover backlog, bloqueando incertidumbre y destinos inválidos.

## Resultado preparado para QA y Revisión

- Settings independientes y auditados en un archivo nuevo `data/auto-run.json`; ausencia o migración de configuración histórica equivale a `agency=false`, `games=false`. Lecturas no activan ni escriben settings. La comprobación final real devolvió `{businesses:{agency:false,games:false},realAutoRunFileExists:false}`.
- El recibo persistido y sincronizado a disco precede al enqueue; conserva brief, correlación de idea, fingerprint, job ID y elegibilidad original. Confirmaciones duplicadas se reconcilian; respuestas inciertas se consultan por recibo. Los IDs de operaciones de captura y envío sobreviven al refresco en localStorage. Un encargo idéntico reutiliza su operación; otro resultado necesita un encargo distinto.
- Ideas y Nuevo trabajo usan el mismo backend de confirmación, que despierta al ejecutor en segundo plano sin esperar al trabajador. Si el runner de cola está ocupado, el HTTP devuelve un recibo durable pendiente; la recuperación posterior conserva la elegibilidad original.
- Un único ejecutor usa `runQueue({execute:true,jobId,maxJobs:1})` y su lock existente. La admisión se verifica bajo ese lock y bajo el lock breve del registro de autoejecución. Pausa por empresa y `data/PAUSE` detienen nuevas admisiones; el job ya admitido termina su pipeline secuencial.
- Solo se recupera intención pendiente sin intento. Una admisión previa, job running, dispatch incierto, fallo o timeout requiere revisión; no hay retry automático ni selección de otro job para sustituirlo. La cadena compartida se detiene ante bloqueos de ambas empresas.
- El destino de código exige checkout relativo con `.git` propio, fuera del juego original protegido, repositorio GitHub configurado, origin coherente, HEAD adjunto en la rama confirmada y SHA local/remoto idéntico. Se comprueban locks de Git y se adquiere `.git/centro-executor.lock` antes de la admisión. El pipeline vuelve a verificar el destino antes de cada nueva etapa. Los nuevos jobs manuales con recibo también exigen el destino GitHub al ejecutarse; no se cambian las reglas de registros anteriores sin recibo.
- El panel muestra controles de ambas empresas, En curso, Cola automática, Cola manual, Requiere revisión e Historial, con job ID, etapa, dispatch confirmado, datos verificados de destino, errores y próxima acción. Permite cerrar un recibo después de revisar y resolver el job; no reejecuta ese recibo. La CLI de la raíz admite ahora `run --execute --id ID` para revisión manual exacta.

No se activó configuración real, procesó backlog, reinició servicio, modificó repositorio de juegos, llamó a GitHub o lanzó un trabajador real. No se hicieron commits, pushes, merges, publicaciones, despliegues, compras o Actions. Se preservó el diff previo; no se creó ni cambió ninguna rama.

## Archivos de esta etapa

Raíz:

- `auto-run.mjs`: registro durable, settings auditados, recibos, recuperación, revisión y ejecutor serial.
- `queue.mjs`: valida specs exportables, persiste `autoIntent` y añade admisión `beforeStart` bajo lock. Se conservan las modificaciones previas del motor.
- `project-destination.mjs`: verificación GitHub de solo consulta, SHA y locks; Git inyectable en pruebas.
- `orca-provider.mjs`: revalidación estricta del destino para jobs nuevos con recibo antes de cada etapa.
- `cli.mjs`: selección explícita por `--id` para `run`.
- `tests/auto-run.test.mjs`: 18 regresiones nuevas con proveedores, Git y dispatches simulados.
- `README.md` y este informe: funcionamiento, límites y activación pendiente.

Dentro de `workspaces/agency-assistant`:

- `agency-assistant/dashboard-state.mjs`: repositorio GitHub configurable por proyecto.
- `agency-assistant/idea-workflow.mjs`: recibo durable en envío y conservación de snapshot/relación; pendientes históricos permanecen manuales.
- `dashboard.mjs`: backend común, settings explícitos, consulta de recibos y arranque/parada del ejecutor del panel.
- `dashboard/app.js`, `dashboard/index.html`, `dashboard/style.css`: controles y confirmaciones, estados separados, destino, historial y operaciones estables tras refresco.
- `tests/auto-run.browser.mjs`: recorrido offline de controles y backend real extraído, con trabajador simulado retenido durante la pausa, replay tras refresco y 320 px.
- `tests/dashboard-confirmation.browser.mjs`: inyección del backend común en el harness existente; conserva el recorrido de confirmación de código.

## Comandos y evidencia

Ejecutados desde la raíz, con fixtures temporales:

```powershell
node --test tests/queue.test.mjs tests/watch.test.mjs tests/orca-provider.test.mjs tests/orca-approval.test.mjs tests/auto-run.test.mjs workspaces/agency-assistant/tests/idea-workflow.test.mjs workspaces/agency-assistant/tests/ideas-management.test.mjs workspaces/agency-assistant/tests/destination-safety.test.mjs
node workspaces/agency-assistant/tests/auto-run.browser.mjs
node workspaces/agency-assistant/tests/dashboard-confirmation.browser.mjs
node workspaces/agency-assistant/tests/ideas-management.browser.mjs
node workspaces/agency-assistant/tests/ideas-qa-regressions.browser.mjs
git diff --check
git -C workspaces/agency-assistant diff --check
```

Resultado: **82/82 tests** y los cuatro recorridos browser **PASS**, sin listeners HTTP, workers reales ni red. Logs: `.artifacts/auto-run-development/unit-integration.log` y `auto-run-final.log` en la misma carpeta. Sintaxis `node --check` aprobada en los ocho módulos de producción modificados y en `cli.mjs`; las suites importan y ejecutan los cambios posteriores. Diff-check aprobado en ambos repositorios; solo avisos de normalización CRLF existentes.

Cobertura nueva: defaults/migración, settings auditados, doble envío concurrente/replay, backlog histórico/manual, backend que despierta al ejecutor, respuesta mientras worker sigue activo, outbox con lock y recuperación, dos empresas y FIFO elegible, claim incierto sin dispatch, running con dispatch previo, pausa en admisión y durante worker, pausa global, fallo/timeout, análisis confirmado, snapshots y archivo/restauración de Ideas, pending histórico, GitHub válido, origin local/externo/mismatch, detached/rama ausente, SHA distinto, error Git y locks. Los comandos de origin/branch/remote se mockean: no se consultó GitHub durante Desarrollo.

Un primer recorrido browser apuntaba por error al diálogo estático de Ideas en vez del diálogo de confirmación dinámico; se corrigió el harness. La nueva regresión de ejecución en fondo encontró un rechazo transitorio EPERM de reemplazo de archivo en Windows: se añadió retry acotado exclusivamente del rename atómico local, sin repetir admisión, Git ni dispatch. Una comprobación posterior encontró la ventana de creación del runner.lock aún vacío: la confirmación conserva outbox pendiente ante `locked` o `lock_uncertain`, sin retirar ni reclamar el lock; solo el motor existente puede comprobar más tarde su disponibilidad, y un lock corrupto persistente sigue bloqueando. La regresión específica acredita que no se desplaza el lock ni se despacha un trabajador; las pruebas finales pasan.

## Límites y recuperación

- Es una entrega de fuentes probada localmente; el proceso operativo no se reinició y no se acredita que haya cargado estos módulos. La UI servida desde disco y un backend antiguo pueden diferir hasta que el coordinador lo reinicie.
- No se verificaron autenticación/permisos reales de GitHub, disponibilidad real de ramas remotas, checkout real de ambos negocios, worker-start real, suspensión/reinicio físico del PC, lector de pantalla o dispositivo físico. El browser usa Chromium headless y dependencias locales ya existentes, sin instalaciones.
- La comprobación remota de producción usa `git ls-remote --heads origin refs/heads/RAMA` con timeout y sin prompts; necesita red al ejecutar un job nuevo, sin API GitHub ni escritura remota. GET/refresh y configuración de proyectos solo hacen observaciones locales.
- Un lock incierto del registro `data/auto-run.json.lock` no se roba; requiere inspección humana. Un lock de checkout se conserva al fallar o quedar incierto un intento: comprueba procesos y dispatches antes de retirarlo manualmente. Cerrar el recibo no borra locks ni prueba por sí mismo que el trabajador haya parado.
- La garantía es no repetir admisiones inciertas, no una garantía de exactamente una ejecución frente a fallos arbitrarios del equipo o de sistemas externos. La intención y el ledger de la cola son durables por separado; los fallos entre ambos se reconcilian conservadoramente.
- localStorage pertenece al navegador/perfil de origen. Borrarlo o cambiar de perfil elimina la deduplicación de captura de UI; los recibos ya guardados siguen consultables y los envíos de una idea existente se deduplican en backend. No borres recibos ni eventos para desbloquear.

## Activación pendiente del coordinador

1. Ejecutar QA y después Revisión independientes; registrar sus dispatches y resúmenes en el workflow del encargo padre. Desarrollo no inicia estas etapas.
2. Con ambas empresas pausadas, revisar los proyectos y preparar fuera de este encargo sus checkouts independientes, origin GitHub y ramas remotas existentes, ya concordantes en SHA; no crear o cambiar ramas desde el panel.
3. Revisar que no haya dispatches activos, locks inciertos ni jobs que requieran atención; conservar backup de datos. Reiniciar el panel de forma controlada para cargar los módulos aprobados, sin añadir servicios permanentes ni inicio automático.
4. Comprobar que ambos toggles siguen pausados, que el backlog mantiene cero nuevas admisiones y que los settings históricos no se promovieron. Si existe intención durable pendiente, revisarla antes del arranque; un claim incierto debe bloquearse.
5. El coordinador confirmará la activación real de cada empresa según la autorización del usuario. Solo un encargo real nuevo confirmado después será elegible; no lanzar trabajos pagados de demostración ni drenar la cola previa.
6. En el primer encargo autorizado comprobar recibo, ID exacto, destino verificado y dispatch confirmado de cada etapa. Ante discrepancia, pausar nuevos inicios, conservar evidencia y revisar; no repetir un envío ni retirar un lock por falta de respuesta.

**Estado de entrega:** Desarrollo listo para QA → Revisión; activación real pendiente, `agency=false`, `games=false`.
