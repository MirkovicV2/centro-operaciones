# Integración GitHub automática

## Alcance y admisión

El paso compartido `Integración GitHub` ocurre después de UX, Desarrollo, QA y Revisión aprobados. Solo se intenta con un recibo de `data/auto-run.json` cuyo `eligible` se fijó a `true` al confirmar el envío y cuyo job conserva el mismo `receiptId`; envíos manuales, elegibilidad falsa, jobs antiguos y cancelados se omiten. Pausar una empresa bloquea nuevas admisiones y no cancela un job ya admitido. No se publican APK ni se inicia Actions.

Cada proyecto guarda el repositorio GitHub, checkout, rama fuente y rama base. La confirmación de un trabajo muestra la identidad de empresa y esos destinos. Los proyectos antiguos sin `baseBranch` quedan pendientes y la integración los bloquea. Solo se admiten mapeos explícitos; no se asignan repositorios por semejanza de nombre.

## Pasos y recuperación

El preflight exige recibo elegible, checkout absoluto canónico dentro de `workspaces`, lock del checkout, checkout limpio al admitir, `origin` GitHub coincidente, ramas existentes, cuenta `gh` del propietario, identidad Git, SHA local/remoto de origen coincidente, SHA base observado y diff igual al manifest capturado tras Desarrollo y conservado durante QA/Revisión. El commit y cada efecto remoto tienen una intención durable previa en `data/auto-run.json`, asociada al job/recibo; `jobs[].workflow.steps` muestra el estado y el panel conserva SHA, PR, merge y hora confirmados.

El manifest usa SHA-256 con campos delimitados por longitud. El estado y los diffs binarios del índice y del working tree se reciben y hashean como bytes; los archivos no rastreados se incorporan con sus nombres de ruta originales y contenido binario exacto, ordenados de forma determinista. Esto evita colisiones por decodificación UTF-8 y delimitadores dentro de rutas o contenido. Una discrepancia detectada antes de integrar detiene commit, push y merge.

Si fuente y base son iguales se crea un commit local y se hace push normal sin force. Si son distintas, se crea/reutiliza la PR de ese head/base, se espera a que GitHub permita el merge con checks correctos y se usa merge normal sin bypass. Las ramas, commits, PR y merges no se duplican de forma ciega: al reiniciar se consulta el estado remoto, y una fase ambigua o respuesta perdida no reconciliable acaba en `needs_attention`. Exact-once no está garantizado. La integración no crea ramas/checkouts, no fuerza pushes, no elimina ramas, no usa `--admin`, no guarda tokens y limita los errores persistidos a mensajes sin salida cruda de comandos.

## Estados de panel

El workflow representa `preflight`, `commit_intent`, `commit_confirmed`, `push_intent`, `push_confirmed`, `pr_intent`, `pr_confirmed`, `checks_pending`, `merge_intent`, `complete` y `needs_attention`. Los datos confirmados incluyen SHA, número/enlace PR, SHA de merge y timestamp. Conflicto, protección, checks fallidos, falta de permisos/autenticación, owner distinto, divergencia, diff inesperado o timeout requieren inspección manual; no reintentar desde la etapa de integración hasta comprobar checkout y remoto.

## Pruebas locales sin Git ni red

```powershell
node --check github-integration.mjs
node --test tests/github-integration.test.mjs
git diff --check
git -C workspaces/flecha-trampa-github diff --check
```

`tests/github-integration.test.mjs` usa adaptadores falsos para push directo, PR reusada, merge con checks aprobados, reconciliación de push ambiguo, elegibilidad, snapshot, owner/auth, branch y divergencia; las regresiones binarias crean repositorios locales temporales y verifican cambios posteriores a aprobación sin acceso a GitHub. Las pruebas no invocan `gh` ni usan red. La operación GitHub no se ha activado ni validado remotamente en esta implementación. Antes de depender de ella falta confirmar desde el panel los mapeos y ramas base existentes, y validar de forma supervisada con GitHub real cada permiso, branch protection, checks, conflictos y respuesta ambigua. Esas comprobaciones externas no forman parte del desarrollo.

## Actions de Flecha Trampa

En el checkout games verificado, `.github/workflows/ci.yml` y `.github/workflows/android.yml` conservan `workflow_dispatch` y todos sus jobs, pero eliminan los triggers `push` duplicados y limitan `pull_request` a `main`. Así, una PR `develop` → `main` es la ruta de validación remota; Pages y otros workflows quedan intactos. No se despacharon workflows. El checkout de Kebab no se modificó.

## Iteración UI · integración GitHub

El panel muestra el paso `Integración GitHub` solo para trabajos de código con recibo elegible persistido por backend. La fase, SHA, enlace PR, SHA de merge y causa de bloqueo proceden del registro `automation.integrations`; la aprobación local se deriva de las cuatro etapas UX/Desarrollo/QA/Revisión persistidas. El estado general `job.state=succeeded` no acredita push ni merge. Los trabajos manuales y recibos no elegibles no muestran el paso.

La ficha de proyecto explica que la rama base existente recibe la PR/merge y que una rama fuente igual a la base integra directamente. Incluye rama observada → base/configuración pendiente, usa `aria-describedby` para ambos textos y enfoca el campo con aviso asociado al intentar guardar mientras falta la base. Los bloqueos globales muestran ID, título, motivo guardado y un control que abre el trabajo en Trabajos para revisión.

Comprobación local, sin listener ni servicio:

```powershell
node workspaces/agency-assistant/tests/dashboard-github-integration.browser.mjs
node --check workspaces/agency-assistant/dashboard/app.js
node --check workspaces/agency-assistant/tests/dashboard-github-integration.browser.mjs
git diff --check
```

El harness intercepta todas las peticiones GET/API, aborta cualquier POST y solicitud externa, y cierra Chromium en `finally`. A 320, 390 y 1440 px pasaron las seis fixtures `approved`, `push`, `pending`, `failed`, `merged` y `base-absent` (18 combinaciones): aserciones de texto contra los registros API persistidos, ausencia de push/merge sin evidencia, ausencia de integración manual, motivo y navegación contextual de bloqueo, ayuda/`aria-describedby`/foco de la base ausente, foco teclado, axe `color-contrast`/`link-name`, sin overflow, red, escrituras ni errores JS. Evidencia detallada: `workspaces/agency-assistant/.artifacts/github-integration-ui/results.json` y `summary.md`.

La iteración solo cambia `dashboard/app.js`, `dashboard/style.css`, el harness browser y este informe. No ejecuta GitHub, Actions, push, merge ni cambia colas/datos reales, listeners persistentes, autoRun ni workflows Games.
