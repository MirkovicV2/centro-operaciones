# Centro de operaciones local

Cola local para videojuegos (`games`) y agencia digital (`agency`). Este repositorio contiene la cola y el conector Orca. El progreso de cada etapa se guarda en `data/state.json`; `data/operations-dashboard.json` declara las etapas y la ubicación de ese estado para que el panel central pueda representarlos.

## Empezar

### Arranque rápido tras descargar `main`

El código es el mismo en Windows y Ubuntu; no se versiona nada personal (cola, bóveda de Obsidian, proyectos, credenciales y vínculos con Orca se crean en `data/` la primera vez y son de cada equipo).

| | Windows 10/11 | Ubuntu 26.10 |
|---|---|---|
| Requisitos | Node.js 20+ (recomendado 24), Git, Orca | Node.js 20+, Git, curl, python3, Orca (su CLI se llama `orca-ide`) |
| Descargar | `git clone https://github.com/MirkovicV2/centro-operaciones.git` | igual |
| Abrir el panel | doble clic en `ABRIR_PANEL.cmd` | `CENTRO_ORCA_AGENT=claude npm start` |
| Agente de los trabajadores | Codex por defecto; para Claude, define la variable de entorno de usuario `CENTRO_ORCA_AGENT=claude` (`setx CENTRO_ORCA_AGENT claude`) y reabre el panel | `CENTRO_ORCA_AGENT=claude` o `codex` al arrancar |
| Configuración común del equipo | `centro.cmd instalar` | `node cli.mjs instalar` |
| Pruebas | `PROBAR.cmd` | `npm test` |
| Reiniciar el panel con seguridad | `REINICIAR_PANEL.cmd` | `panel/reiniciar-panel.sh` |
| Skills y referencias | `DESCARGAR_SKILLS.cmd`, `IMPORTAR_REFERENCIAS.cmd` | `node skills-descargar.mjs`, `node references.mjs importar <zip> --para <ámbito>` |

`instalar` crea en `data/` el reparto de modelos por etapa del equipo y la identidad de este PC (sin sobrescribir nada); qué es común y qué es local está en [`docs/COMUN_Y_LOCAL.md`](docs/COMUN_Y_LOCAL.md).

Después abre <http://127.0.0.1:4187>, conecta tu bóveda en **Conocimiento** y registra tus proyectos. Para que los trabajos corran en Orca, vincula los coordinadores como explica la [guía de coordinación](docs/COORDINATOR_OPERATIONS.md) (en Ubuntu, [docs/UBUNTU_CLAUDE.md](docs/UBUNTU_CLAUDE.md)). Sin Orca puedes usar el panel, guardar ideas y conectar Obsidian.

En Ubuntu 26.10, usa la [guía de instalación para Linux y Claude Code](docs/UBUNTU_CLAUDE.md). Comparte el mismo código y los mismos contratos que Windows.

Cada instalación usa su propia cola y configuración. Instala Node.js 20 o posterior y Git. Para ejecutar agentes, configura Orca en ese equipo y vincula sus coordinadores según la [guía de coordinación](docs/COORDINATOR_OPERATIONS.md). Si Orca está instalado en otra ruta, configura `ORCA_CLI_COMMAND` con la ruta a su ejecutable. La integración remota requiere una cuenta de GitHub con acceso al repositorio de cada proyecto.

En **Conocimiento** puedes conectar tu propia bóveda de Obsidian. La cola, los checkouts de proyectos, la bóveda y las credenciales se guardan fuera del código versionado.

Para abrir el panel web local, ejecuta `ABRIR_PANEL.cmd` desde el Explorador o desde PowerShell. El servidor escucha solo en `127.0.0.1:4187`; la interfaz y el backend del panel están versionados en `panel/` y usan la cola de este repositorio. El inicio no crea tareas; el ejecutor respeta la autoejecución y los recibos elegibles ya configurados. Reabrir un panel existente no recarga sus módulos.

Contratos, decisiones agrupadas, correlación ORCA, métricas, pruebas y límites de activación: [PIPELINE_COORDINATION.md](PIPELINE_COORDINATION.md).

En una terminal de esta carpeta:

```powershell
.\centro.cmd status
.\centro.cmd add --business agency --kind analysis --title "Oferta inicial" --prompt-file ".\ejemplos\agencia.txt" --id oferta-agencia
.\centro.cmd run
```

`run` solo muestra una simulación. Para ejecutar expresamente la cola, usa `run --execute`. Con el panel abierto en el puerto configurado (`CENTRO_OPERATIONS_PORT`, 4187 por defecto) la CLI no ejecuta: Orca admite un único consumidor por Run y rechazaría el `worker-start` con `consumer_fenced`; la CLI lo detecta antes de despachar (`panel_active`). Ejecuta desde el panel o ciérralo antes. No hay tareas programadas ni ejecución al abrir la carpeta. Como máximo se procesan cinco trabajos por llamada (ajustable entre 1 y 20). Los encargos nuevos de Orca tienen cinco intentos por defecto y carecen de límite de duración por defecto. En otros proveedores el valor por defecto sigue siendo dos. El máximo configurable es cinco. Una pregunta respondida al trabajador que sigue activo conserva su intento.

Por defecto, las tareas usan Orca y los perfiles existentes de `.codex/agents/`. El modelo y el esfuerzo de cada rol se derivan de su nivel (`ligero`, `estandar`, `profundo`); sin `data/orca-launch-levels.json` se usan los valores actuales de Codex (tabla en [docs/UBUNTU_CLAUDE.md](docs/UBUNTU_CLAUDE.md)). Los análisis pasan por `planificador`; los trabajos de código siguen el pipeline secuencial `ux` → `desarrollador` → `qa` → `revisor`. Dentro de cada encargo actúa un perfil a la vez. Los estados, resúmenes y dispatches de cada etapa quedan en `jobs[].workflow` para mostrarlos en el panel. La primera ejecución registra en Orca la carpeta de análisis o el checkout aislado.

```powershell
.\centro.cmd add --business games --kind analysis --title "Propuesta de juego" --prompt-file ".\ejemplos\videojuegos.txt" --id idea-juego
.\centro.cmd run --execute --max-jobs 1
.\centro.cmd show --id idea-juego
```

## API y cambio a ChatGPT

`auto` intenta Responses API cuando el proceso tiene `OPENAI_API_KEY`; sin esa variable utiliza Codex con ChatGPT. No se crean archivos `.env`, no se modifica ninguna clave existente y las claves no se escriben en los registros. No incluyas claves en las instrucciones. Con `--provider api`, el trabajo queda fijado a API, sin cambio automático.

El presupuesto API empieza en **0 USD** y no se harán llamadas pagadas hasta configurar un límite total, un modelo y tarifas estimadas. Obtén las tarifas vigentes del proveedor e introdúcelas manualmente:

```powershell
.\centro.cmd budget --usd 5 --model MODELO --input-per-million TARIFA_ENTRADA --output-per-million TARIFA_SALIDA
```

Sustituye los tres marcadores por valores reales. El límite es acumulado para esta cola, no mensual. Cada trabajo admite `--max-usd 0.10`; se reserva una estimación conservadora antes de solicitar hasta 1.024 tokens de salida. Esto **no es un límite de facturación garantizado**: tokens, tarifas, otros procesos y ajustes del proveedor pueden diferir. La fuente autorizada del gasto es el panel de consumo/facturación del proveedor. Ante respuestas o transportes ambiguos se conserva la estimación por prudencia; no se devuelve crédito automáticamente.

Solo los códigos explícitos `insufficient_quota`, `billing_hard_limit_reached`, `credits_exhausted` o `credit_balance_exhausted` permiten pasar de API a Codex en un trabajo `auto`, una vez dentro del mismo intento. `insufficient_quota` puede indicar cuota insuficiente y no demuestra por sí solo que se haya agotado dinero. Un error temporal `rate_limit_exceeded` espera 30/60 segundos y respeta el máximo de intentos; no activa el cambio a ChatGPT. Errores de autenticación, presupuesto local, transporte, respuestas incompletas y fallos desconocidos requieren atención. No se recargan créditos ni se cambia el plan automáticamente; el cambio utiliza la suscripción propia con sus límites normales.

## Código en un checkout separado

La cola no usa el repositorio de juego activo ni sus worktrees. Para código, prepara por separado un **checkout independiente** bajo `workspaces\NOMBRE` dentro de esta carpeta, con su propio directorio `.git`. No se aceptan enlaces, junctions que salgan de esta carpeta ni worktrees con metadatos Git compartidos. La cola no clona ni crea worktrees por su cuenta.

```powershell
.\centro.cmd add --business games --kind code --title "Cambio acotado" --prompt-file ".\mi-tarea.txt" --workspace ".\workspaces\mi-checkout" --isolated
```

`--isolated` declara que has preparado y revisado ese checkout. El trabajador usa `workspace-write`, sin aprobaciones automáticas de acciones externas, y recibe instrucciones de no hacer commits, push, merge, publicaciones, compras, mensajes ni otros agentes. Los trabajos manuales entregan cambios para revisión; solo los recibos automáticos elegibles pueden pasar al paso separado de integración después de las cuatro aprobaciones, según [GITHUB_INTEGRATION.md](GITHUB_INTEGRATION.md). Las instrucciones limitan el comportamiento del agente, pero no sustituyen la revisión humana ni un aislamiento del sistema operativo para código no fiable.

## Recuperación y revisión

El registro `data\events.jsonl` es la fuente durable; `data\state.json` es una instantánea reemplazada de forma atómica. Los cambios se sincronizan a disco antes de empezar trabajo. El panel reserva un turno exclusivo por empresa y serializa las escrituras en el historial compartido. La ejecución manual de la CLI reserva ambos turnos. Los trabajos terminados no vuelven a ejecutarse y un `--id` repetido se rechaza.

Al detectar una interrupción, los trabajos afectados pasan a `needs_attention` y bloquean nuevas admisiones en su empresa. Comprueba que no queda un proceso Codex activo y revisa posibles cambios/cargos. Después decide:

```powershell
.\centro.cmd retry --id IDENTIFICADOR --confirm-reviewed
.\centro.cmd resolve --id IDENTIFICADOR --confirm-reviewed
```

`retry` solo reabre si aún quedan intentos; `resolve` lo cierra sin volver a ejecutar. Los tiempos agotados detienen el árbol de procesos y requieren revisión; no se reintenta automáticamente una operación con efectos inciertos. Si no se puede confirmar la parada, el bloqueo queda marcado como inseguro: revisa los procesos antes de retirar manualmente el archivo de bloqueo. Un bloqueo corrupto o una recuperación de bloqueo interrumpida también requieren intervención. Nunca borres `events.jsonl` para desbloquear la cola.

Las instrucciones, las respuestas y los eventos se guardan localmente en texto. Mantén esta carpeta privada y conserva una copia de `data` para recuperarte de fallos de disco. Los archivos no se cifran. La recuperación evita repetir trabajos ambiguos, pero no puede garantizar ejecución exactamente una vez ante fallos externos o del equipo.

## Vigilancia local con límites

El vigilante consulta únicamente archivos locales cada cinco segundos: no llama a modelos mientras la cola está vacía o pausada. Se inicia en simulación; solo `--execute` permite ejecutar. Atiende un trabajo cada vez y cuenta también los intentos fallidos, con los mismos bloqueos y límites de presupuesto de la cola.

```powershell
node watch.mjs --hours 8 --max-jobs 10
node watch.mjs --execute --hours 8 --max-jobs 10
```

Termina al alcanzar el tiempo o el número de intentos configurado (por defecto, ocho horas o diez intentos). Acepta entre un segundo y 24 horas, y entre uno y cien intentos. Un trabajo que requiere revisión detiene el vigilante. Crear un archivo vacío `data\PAUSE` impide despachar trabajos nuevos; retirar ese archivo permite continuar. La pausa no interrumpe un trabajo que ya esté en marcha.

`Ctrl+C` o `SIGTERM` solicita la parada. Al alcanzar el límite de tiempo también se solicita abortar el trabajador activo y se espera su cierre seguro; la limpieza puede prolongar la salida. Una ejecución interrumpida puede quedar en `needs_attention`: revisa antes de reintentar. No fuerces la terminación ni borres bloqueos mientras quede un trabajador activo.

Este proceso vive **solo en este PC**, que debe permanecer encendido y conectado. No arranca automáticamente tras reiniciar ni cambia el inicio de Windows o el Programador de tareas. El acceso móvil depende de la sesión de Orca configurada por separado.

`PAUSAR.cmd` crea el archivo de pausa. El script separado `mantener-activo.ps1` puede impedir temporalmente la suspensión durante ocho horas mientras Orca está abierto, permitiendo apagar la pantalla; libera esa petición al salir o detectar `data\PAUSE`. No cambia permanentemente la configuración de energía de Windows. El vigilante por sí mismo no modifica la suspensión.

## Acceso para dos personas por Tailscale

El panel escucha solo en `127.0.0.1`. Para compartirlo con otra persona, publica el puerto con Tailscale Serve (HTTPS, sin Funnel) y crea `data/tailscale-access.json` (no versionado). El formato antiguo con una sola cuenta sigue valiendo (`{ "hostname": "equipo.tailnet.ts.net", "login": "cuenta@ejemplo.test" }`, que actúa como `admin`). Para varias cuentas:

```json
{ "hostname": "equipo.tailnet.ts.net", "users": [
  { "login": "duenyo@ejemplo.test", "role": "admin" },
  { "login": "colega@ejemplo.test", "role": "ejecutar" },
  { "login": "revisor@ejemplo.test", "role": "revisar" } ] }
```

Una cuenta no listada recibe 403. `revisar` solo consulta; `ejecutar` puede lanzar, reintentar, aprobar y cerrar encargos pero no cambiar la configuración, la autoejecución ni los proyectos; `admin` puede todo. Cada evento del ledger, cada encargo nuevo y cada entrada del historial de autoejecución guardan `actor` (la cuenta de Tailscale, `local` desde este equipo o `cli:<usuario>` desde la CLI). Los registros anteriores no tienen ese campo y el panel los muestra como «desconocido»; el ledger no se reescribe.

## Verificar sin consumo

```powershell
npm test
npm run metrics
```

Las pruebas utilizan carpetas temporales y proveedores simulados: no llaman a OpenAI ni arrancan trabajadores Codex. La instalación inicial tampoco lo hace.

Las suites de navegador (`panel/tests/*.browser.mjs`) necesitan Playwright con Chromium. Este repositorio no lo declara como dependencia: `npm run test:browser` las ejecuta cuando `PLAYWRIGHT_MODULE` apunta a `playwright/index.mjs` de un checkout que ya lo tenga (o existe el checkout histórico `workspaces/portfolio-motion`), y las omite con un aviso y salida 0 cuando no. El flujo de CI de Ubuntu llama a ese script, de modo que hoy las omite; para ejecutarlas en CI haría falta instalar Playwright y sus navegadores en el runner (propuesta en `PROPUESTA.md`). `centro.cmd` usa el Node 24 portable del perfil del propietario (`%USERPROFILE%\Documents\Proyectos\FlechaTrampa\.tools\…`) si existe y, en su defecto, `node` del sistema; otra ruta se fija en `centro.local.cmd` (no versionado, ejemplo en `ejemplos/centro.local.example.cmd`).

## Retirar falsos éxitos de código

Si un trabajo figura como completado pero su respuesta guardada confirma que no implementó nada, conserva la evidencia original y retira ese estado:

```powershell
.\centro.cmd retract --id IDENTIFICADOR --confirm-reviewed
```

El registro conserva la respuesta y anota la corrección como cancelada. El ejecutor de código exige ahora cambios verificables en el checkout antes de marcar un trabajo como completado.
Tras revisar la implementación, una compilación y el APK, el coordinador puede registrar la entrega de un falso éxito ya retirado sin atribuírsela a Codex:

```powershell
.\centro.cmd complete --id IDENTIFICADOR --evidence-file .\informe.md --confirm-reviewed
```

El registro exige cambios visibles en el checkout, conserva la respuesta original bajo `retractedAttemptResult` y etiqueta la entrega como `coordinator-reviewed`.

## Pipeline de calidad de Orca

Antes de inspeccionar contenido del checkout de Videojuegos, la ruta confirmada por job/panel debe ser absoluta y canónica (`path.isAbsolute` y `path.normalize(rutaConfirmada) === rutaConfirmada`). La ruta real consultada localmente con `realpath` debe normalizarse con `path.normalize` y coincidir exactamente con esa ruta absoluta; la referencia de rama activa consultada mediante Git debe coincidir exactamente con la branch ref confirmada. Si la ruta confirmada no es absoluta y canónica, no se puede leer/verificar la ruta local o la branch ref, o cualquiera difiere, el desarrollador se detiene antes de inspeccionar contenido y reporta el dato no verificable o el desajuste.

En Videojuegos, la etapa `developer` se presenta como **Desarrollo de videojuegos (Godot)** y conserva el perfil `desarrollador_games` (**Desarrollador de videojuegos (Godot)**). Antes de inspeccionar o cambiar archivos del checkout, el perfil exige comprobar que su ruta real y la referencia de rama activa (branch ref), leídas del sistema de archivos y Git, coincidan exactamente con la ruta y rama confirmadas en el job/panel. «Destino» incluye checkout y branch ref; una confirmación textual por sí sola no basta. Si alguno de esos valores no se puede leer/verificar o no coincide, el desarrollador se detiene sin inspeccionar ni editar el checkout y reporta el dato no verificable o el desajuste al usuario/panel. Una mención genérica a Godot o un brief vago no autoriza una migración. Un brief confirmado que pida explícitamente migrar Flecha Trampa a Godot puede crear el scaffold inicial mínimo, incluso si todavía falta `project.godot`, cuando el job o UX aporte un criterio verificable suficiente y haya resuelto las decisiones imprescindibles; el scaffold permanece dentro del destino confirmado y no autoriza migrar todo el juego. Nunca se toca el juego original, se crean o cambian ramas/remotes ni se descarga o instala Godot. Esto no afirma que Flecha Trampa ya use Godot ni que exista una validación real del motor. Agencia conserva «Implementación» y el pipeline sigue UX → Desarrollo → QA → Revisión, con los mismos identificadores históricos.

Antes de leer contenido del checkout, el perfil Games ejecuta `node games-checkout-guard.mjs "<ruta-absoluta-confirmada>" "<branch-ref-confirmada>"` desde un entorno que tenga el helper. La herramienta consulta `realpath` y `git symbolic-ref` en modo de solo lectura y solo permite continuar cuando la ruta confirmada es absoluta y normalizada, la ruta canónica coincide exactamente y la branch ref activa coincide exactamente con la confirmada. Ante ruta relativa/vacía, observación no verificable o cualquier diferencia, se detiene; si el helper no está disponible, se pide validación por el panel sin inspeccionar el juego. La función pura valida únicamente los valores que recibe, y la ejecución de esta guarda no equivale a ejecutar o validar un proyecto Godot.

Las tareas de análisis usan el planificador existente. Las tareas de código con el proveedor Orca pasan por diseño UX, implementación, QA y revisión de código, un trabajador cada vez. QA no ejecuta suites de pruebas salvo que el encargo lo solicite. QA y revisión bloquean la entrega si falta evidencia de aceptación o detectan un problema concreto; sus resultados, intentos y dispatches se conservan en `jobs[].workflow` dentro de `data/state.json`.

El panel y la CLI usan el mismo motor de cola y el mismo lanzador Orca; `workspaces/agency-assistant/queue.mjs` y `orca-provider.mjs` son adaptadores finos, no copias del ejecutor. Esto evita que sus reglas de reintento o argumentos se desvíen.

La CLI conserva el despacho manual con `run --execute`; el panel admite además la autoejecución por empresa cuando se activa explícitamente. Tras una interrupción, el reintento confirmado conserva el Run y las etapas aprobadas: consulta el dispatch existente y recupera su respuesta si ya terminó, o se vuelve a conectar si sigue activo. Si Orca no confirmó un dispatch, el flujo se queda en revisión y no lanza otro trabajador a ciegas. Obsidian recibe una nota versionada al quedar `needs_attention` y otra al completarse, con estado, perfiles, dispatches e informes por etapa; así conserva lo escrito previamente.

El panel conserva la empresa seleccionada y separa proyectos, ideas, trabajos y conocimiento. Los cerrados se consultan en Historial; los bloqueos de la cola compartida se muestran incluso cuando afectan al otro negocio. Guardar ideas no requiere Git; enviarlas a desarrollo exige objetivo, criterio de éxito y confirmar proyecto, checkout aislado y rama observada. La validación no crea ni cambia ramas y vuelve a comprobar la rama antes de despachar cada etapa. Los perfiles nuevos de código usan el sufijo `_agency` o `_games` en UX, Desarrollo, QA y Revisión, manteniendo el orden y los perfiles genéricos de registros anteriores; análisis conserva `planificador`.

## Autoejecución local con activación por empresa

El panel incorpora controles explícitos de activar/pausar Agencia y Videojuegos en Trabajos. Ambas empresas empiezan pausadas; la configuración histórica `autoRun` no activa esta función. Esta entrega no activa datos reales ni reinicia el servicio. Las referencias anteriores al despacho exclusivamente manual describen el modo predeterminado: la excepción requiere confirmar la activación por empresa.

Cada envío confirmado de Ideas o Nuevo trabajo conserva un recibo idempotente en `data/auto-run.json`, con brief, job ID y la elegibilidad observada al confirmar. Guardar, editar, archivar, restaurar o activar una empresa no hace elegible la cola anterior. Los recibos manuales permanecen manuales. La UI conserva identificadores de operación en el almacenamiento local del navegador para repetir un envío tras una respuesta ambigua o un refresco sin duplicarlo. Un envío idéntico conserva su recibo; para otro resultado define un encargo distinto.

El panel tiene un ejecutor por empresa. Cada uno admite un solo trabajo y ejecuta sus etapas en orden. Ambos pueden avanzar en checkouts distintos. El bloqueo exclusivo de cada checkout evita que dos trabajos lo usen a la vez. El historial y el presupuesto se escriben con un bloqueo breve compartido. Pausar una empresa impide nuevas admisiones en ella y deja terminar el trabajo admitido. `data/PAUSE` pausa nuevas admisiones en ambas empresas. Una intención pendiente se recupera al abrir el panel. Un intento sin cierre confirmado requiere revisión y detiene las nuevas admisiones de su empresa.

En jobs elegibles de código, tras UX → Desarrollo → QA → Revisión se muestra `Integración GitHub`. Solo usa el recibo creado al confirmar con autoRun activo; los envíos manuales y anteriores no se integran. El proyecto debe tener repositorio, checkout, rama fuente y rama base configurados explícitamente; sin rama base la integración queda bloqueada para revisión. La acción terminal es commit/push confirmado para misma rama, o PR/checks/merge confirmado para ramas distintas. Cada intención queda guardada antes del efecto; los resultados ambiguos pasan a revisión y no se repiten a ciegas. No hay garantía exactly-once, ni se publican APK o workflows. Consulta el preflight, estados, pruebas simuladas y validaciones remotas pendientes en [GITHUB_INTEGRATION.md](GITHUB_INTEGRATION.md).

Para código del panel, configura `propietario/repositorio` GitHub, rama base y un checkout independiente relativo bajo `workspaces`, ya situado en su rama fuente existente. Al guardar el proyecto, el panel comprueba en modo lectura que el `origin` del checkout es ese repositorio y que la rama observada coincide con su SHA remoto; si no puede (sin red, sin remoto, divergencia), guarda igualmente y muestra el aviso en la ficha del proyecto. Antes del inicio se verifica origin, ramas y SHA local/remoto mediante Git de solo consulta; después de las cuatro aprobaciones, solo un recibo autoelegible puede ejecutar la integración Git/`gh` descrita arriba. No se despachan workflows de Actions, ni se crean checkouts, ramas o remotes. La verificación vuelve a ejecutarse en el comienzo del job. El bloqueo `.git/centro-executor.lock` excluye otros ejecutores automáticos del checkout y se conserva ante incertidumbre: revisa el proceso propietario y los efectos antes de retirarlo manualmente.

Consulta recibos, historial, etapa y dispatch en Trabajos. Tras revisar y resolver el job, se puede cerrar su recibo sin reejecutarlo. El reintento de un job sigue siendo manual; desde la raíz usa `node cli.mjs run --execute --id IDENTIFICADOR` para seleccionar exclusivamente ese job. Nunca uses un drenado general para resolver un recibo individual. La función requiere que el panel y el PC sigan abiertos; no instala servicios ni inicio automático.

Regresiones sin consumo ni red: `node --test tests/auto-run.test.mjs` y `node workspaces/agency-assistant/tests/auto-run.browser.mjs`. El informe de desarrollo, limitaciones y pasos de activación tras QA y Revisión está en `AUTO_RUN_DEVELOPMENT.md`.

## Perfil mixto Codex + Claude

Reparto por etapa, rutas, skills, cuota, equipos y memoria compartida: empieza por `docs/ACTIVACION.md`. Todo es opcional y local a cada instalación; sin configurarlo el Centro funciona como antes.
