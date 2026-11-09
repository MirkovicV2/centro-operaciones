# Centro de operaciones local

Centro local de trabajo para dos líneas: videojuegos (`games`) y agencia digital (`agency`). Funciona con Node 20 o posterior, sin dependencias. Incluye un panel web de solo loopback para la cola, Obsidian, ideas, renovaciones y la secretaria de Telegram; Orca conserva su propio panel de sesiones de agentes.

## Empezar

Para abrir el panel en una terminal de esta carpeta:

```powershell
node dashboard.mjs
```

Abre `http://127.0.0.1:4187` en el navegador. En Windows puedes iniciar el panel con `ABRIR_PANEL.cmd`; el acceso directo de escritorio `Centro de Operaciones` arranca el servidor si hace falta y abre la pagina. Para usar la cola desde terminal:

```powershell
.\centro.cmd status
.\centro.cmd add --business agency --kind analysis --title "Oferta inicial" --prompt-file ".\ejemplos\agencia.txt" --id oferta-agencia
.\centro.cmd run
```

`run` solo muestra una simulación. Para ejecutar expresamente la cola, usa `run --execute`. No hay tareas programadas ni ejecución al abrir la carpeta. Como máximo se procesan cinco trabajos por llamada (ajustable entre 1 y 20). Los encargos nuevos de Orca tienen cinco intentos por defecto y carecen de límite de duración por defecto. En otros proveedores el valor por defecto es dos intentos. Una pregunta respondida al trabajador que sigue activo conserva su intento.

Para un análisis con la suscripción de ChatGPT, añade `--provider codex`. Se exige que el Codex nativo instalado esté conectado mediante ChatGPT; la cola consulta `codex login status`, sin leer ni copiar credenciales. La ejecución elimina las claves API del entorno del subproceso e ignora la configuración personal, desactiva apps/plugins/hooks y utiliza modo de solo lectura. El modelo es `gpt-6-luna` con esfuerzo `high` para análisis y `gpt-6.1-sol` con `medium` para código; puedes cambiarlos mediante `OPERATIONS_CODEX_MODEL` y `OPERATIONS_CODEX_EFFORT`. Sigue sujeta a los límites del plan y a la disponibilidad de Codex.

```powershell
.\centro.cmd add --business games --kind analysis --title "Propuesta de juego" --prompt-file ".\ejemplos\videojuegos.txt" --provider codex --id idea-juego
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

`--isolated` declara que has preparado y revisado ese checkout. El trabajador usa `workspace-write`, sin aprobaciones automáticas de acciones externas, y recibe instrucciones de no hacer commits, push, merge, publicaciones, compras, mensajes ni otros agentes. Esta versión entrega cambios para revisión; no integra ni publica automáticamente. Las instrucciones limitan el comportamiento del agente, pero no sustituyen la revisión humana ni un aislamiento del sistema operativo para código no fiable.

## Recuperación y revisión

El registro `data\events.jsonl` es la fuente durable; `data\state.json` es una instantánea reemplazada de forma atómica. Los cambios se sincronizan a disco antes de empezar trabajo. Un único bloqueo impide ejecuciones o escrituras concurrentes. Los trabajos terminados no vuelven a ejecutarse y un `--id` repetido se rechaza.

Al detectar una interrupción, los trabajos que estaban ejecutándose pasan a `needs_attention` y bloquean el resto de ejecuciones. Comprueba que no queda un proceso Codex activo y revisa posibles cambios/cargos. Después decide:

```powershell
.\centro.cmd retry --id IDENTIFICADOR --confirm-reviewed
.\centro.cmd resolve --id IDENTIFICADOR --confirm-reviewed
```

`retry` solo reabre si aún quedan intentos; `resolve` lo cierra sin volver a ejecutar. Los tiempos agotados detienen el árbol de procesos y requieren revisión; no se reintenta automáticamente una operación con efectos inciertos. Si no se puede confirmar la parada, el bloqueo queda marcado como inseguro: revisa los procesos antes de retirar manualmente el archivo de bloqueo. Un bloqueo corrupto o una recuperación de bloqueo interrumpida también requieren intervención. Nunca borres `events.jsonl` para desbloquear la cola.

Las instrucciones, las respuestas y los eventos se guardan localmente en texto. Mantén esta carpeta privada y conserva una copia de `data` para recuperarte de fallos de disco. Los archivos no se cifran. La recuperación evita repetir trabajos ambiguos, pero no puede garantizar ejecución exactamente una vez ante fallos externos o del equipo.

## Inventario de dominios y secretaria de Telegram

El panel local y la secretaria de Telegram están en [`agency-assistant/README.md`](agency-assistant/README.md). Incluye una web en `http://127.0.0.1:4187` para cola, preguntas para Daniel, notas de Obsidian, inventario manual de dominios y avisos. La documentación se exporta cuando hay una bóveda configurada. El lector de contexto documental no está conectado al ejecutor raíz; véase [coordinación y límites](../PIPELINE_COORDINATION.md).

`agency-assistant/install-panel-autostart.ps1` registra el panel para que arranque al iniciar sesión en Windows, sin Telegram. Cuando tengas un bot, `agency-assistant/install-windows-autostart.ps1` sustituye esa misma tarea para arrancar panel y secretaria juntos. Requiere el PC encendido y que la sesión de Windows esté abierta; no funciona como servicio antes de iniciar sesión. El panel solo encola trabajos y mantiene autoRun=false; el despacho se realiza manualmente mediante run --execute. Los datos se guardan localmente en `data/`, carpeta excluida de Git.

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

## Verificar sin consumo

```powershell
node --test tests/queue.test.mjs
node --test tests/watch.test.mjs
```

Las pruebas utilizan carpetas temporales y proveedores simulados: no llaman a OpenAI ni arrancan trabajadores Codex. La instalación inicial tampoco lo hace. `centro.cmd` usa el Node 24 portable existente si está disponible y, en su defecto, `node` del sistema.

## Flujo de agentes desde el panel

En Proyectos, selecciona y guarda una vez el «Checkout de desarrollo»: solo se ofrecen checkouts independientes válidos bajo `workspaces/`, sin rutas personales predefinidas. No se selecciona automáticamente el checkout de ningún proyecto.

Al capturar una idea puedes guardarla, enviarla al Planificador o enviarla a desarrollo. También puedes enviar a desarrollo una idea guardada aunque ya tenga un análisis. La captura se conserva primero localmente y se intenta exportar a Obsidian; el panel distingue ambos resultados. Desarrollo exige objetivo, criterio de éxito y confirmar proyecto, checkout y rama observada; crea un único trabajo Orca enlazado y lo deja en cola sin ejecutarlo. Si el ejecutor está ocupado, la solicitud queda guardada y se convierte en trabajo en cola cuando se libera el bloqueo; su ejecución posterior es manual. Sin checkout válido se conserva la idea sin crear un trabajo inválido. Los encargos mantienen el límite de 12.000 bytes: una idea mayor se conserva íntegra y se pide dividirla, sin ejecutar una versión recortada.

El panel recupera trabajos interrumpidos solo tras adquirir el bloqueo y confirmar que no queda un propietario local activo. Los trabajos quedan en «Requiere revisión», conservando informes y dispatches. «Reintentar después de revisar» exige confirmación y conserva el mismo trabajo, Run, etapas aprobadas y su historial. Para un dispatch conocido, consulta Orca y recupera el resultado si ya terminó o vuelve a conectarse si sigue activo; nunca inicia un segundo dispatch para sustituir uno incierto. Si no quedó confirmación de dispatch, mantiene el bloqueo y pide revisar Orca. «Cerrar trabajo» exige confirmación y no cancela dispatches de Orca. QA y Revisión solo aprueban si la última línea, sin texto adicional, es exactamente `RESULTADO: APROBADO`; si el resumen precede el marcador, debe ir en una línea anterior.

Los encargos nuevos creados en el panel se envían a Orca. Las ideas pasan por `planificador`; las tareas de código siguen `ux` → `desarrollador` → `qa` → `revisor`, con un perfil activo cada vez. Abre cada tarjeta de la cola para ver estados, perfiles, dispatches e informes de etapa. Cada empresa tiene un ejecutor de fondo. La ejecución automática requiere activación por empresa y un recibo elegible. Los encargos pueden avanzar en paralelo en checkouts distintos. Dentro de cada encargo las etapas siguen en orden. Los perfiles nuevos usan sufijos _agency y _games; los registros anteriores conservan sus perfiles genéricos. El mismo motor de cola y lanzador se comparten con Centro de Operaciones para que el panel y la CLI apliquen las mismas reglas. Obsidian conserva una nota versionada al quedar pendiente de revisión y otra al completar, con dispatches y mensajes de cada etapa.
