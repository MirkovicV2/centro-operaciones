# Asistente privado de la agencia

Aplicación web local para ver la cola, capturar ideas, responder preguntas de los agentes y conectar Obsidian. Incluye el bot de Telegram para tareas personales, renovaciones de IONOS y avisos.

## Estado

- **Código:** preparado en esta copia aislada del centro de operaciones.
- **Almacén:** se crea en `data/agency-assistant.json`, excluido de Git por `.gitignore`.
- **Panel:** `http://127.0.0.1:4187`, limitado al PC local.
- **Obsidian:** conecta la ruta de la bóveda una vez en el panel. Los resultados e ideas se guardan como notas Markdown.
- **Telegram:** crea/conecta el bot y autoriza un chat privado con el instalador de Windows.
- **IONOS:** inventario manual; no consulta ni modifica cuentas o DNS.
- **Avisos:** solo se envían al chat privado autorizado, nunca a clientes.

## Conectar Telegram

1. Abre [@BotFather](https://t.me/BotFather), crea un bot nuevo con `/newbot` y conserva su token. No lo pegues en este chat ni lo guardes en Git.
2. Abre el bot que acabas de crear y envíale `/start`.
3. En PowerShell, instala el arranque automático de Windows:

   ```powershell
   Set-Location -LiteralPath 'C:\Users\brank\Documents\ChatGPT\Proyectos Dani\CentroOperaciones\workspaces\agency-assistant'
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agency-assistant\install-windows-autostart.ps1
   ```

   El asistente de instalación te pedirá la carpeta del centro de operaciones, el token mediante un campo seguro y el ID de chat que detecte. Cifra el token con DPAPI para tu usuario de Windows, registra una tarea para iniciar el panel y el bot al iniciar sesión y los arranca inmediatamente. No compartas el token ni el ID por este chat.

4. Abre `http://127.0.0.1:4187` en Orca. En **Conexión local → Obsidian**, pega la ruta raíz de tu bóveda, guarda la conexión y, cuando estés listo, activa **Ejecutar automáticamente la cola**.

La tarea `CentroOperaciones-PanelLocal` se ejecuta oculta al iniciar sesión en tu cuenta de Windows y se reintenta si el proceso se detiene. El PC debe permanecer encendido y sin suspensión; si se reinicia, inicia sesión para que arranque. Para detenerla o quitarla, usa `Stop-ScheduledTask -TaskName CentroOperaciones-PanelLocal` o `Unregister-ScheduledTask -TaskName CentroOperaciones-PanelLocal`. El panel está en `http://127.0.0.1:4187` y los registros en `data/operations-dashboard.log`.

## Obsidian, ideas y agentes

En el panel, conecta la carpeta raíz de tu bóveda de Obsidian. Los trabajos terminados se exportan automáticamente a `Centro de Operaciones/Trabajos/Agencia` o `Videojuegos`. Las ideas y respuestas se guardan en `Centro de Operaciones/Ideas/<empresa>`. Las notas recientes de contexto, ideas y trabajos se incluyen como referencias no confiables en futuras tareas del mismo negocio. Puedes añadir contexto en `Centro de Operaciones/Contexto/Agencia` y `Centro de Operaciones/Contexto/Videojuegos`.

Cuando un agente necesite una decisión de Daniel, termina su respuesta con `## Preguntas para Daniel`. El panel la captura en una bandeja y, si Telegram está conectado, envía la pregunta al chat privado. Responde desde la web o con `/responder ID tu respuesta` en Telegram. La respuesta se guarda en Obsidian y genera una continuación del trabajo en la cola; con autoejecución activa, el agente la retoma sin que tengas que volver a lanzarlo.

El mapa local se construye desde los enlaces `[[wikilink]]` de la bóveda. Graphify oficial lee Notion; no se conecta directamente a archivos de Obsidian. Este panel no usa Graphify ni duplica la bóveda en Notion.

La ejecución automática está desactivada al principio. Puedes activarla en el panel; procesa un trabajo cada vez y se pausa si aparece un trabajo que necesita revisión. Se mantienen los límites de presupuesto y las reglas de checkouts aislados. No hace commits, merge, pagos ni publicaciones.

Sin instalar una tarea, el panel puede arrancarse con `node dashboard.mjs`. El token de Telegram y el ID del chat deben estar en el entorno para habilitar el bot.

## Pendientes y recordatorios

- `/anotar preparar propuesta`: guarda una tarea sin fecha.
- `/recordar mañana a las 09:30 revisar IONOS`: entiende hoy/mañana, hora de 24 horas y una descripción breve.
- `/recordar 2026-11-12 16:00 enviar factura`: acepta fecha ISO y hora.
- `/pendientes`: lista las tareas abiertas.
- `/hecho 2`: completa una tarea.

La zona horaria inicial es `Europe/Madrid`. El bot confirma lo que guarda y no usa un modelo de IA para interpretar texto libre; si no reconoce fecha y hora, pide el formato esperado.

## Inventario de IONOS

Añade cada dominio con cliente, dominio, correo o alias de la cuenta, fecha de renovación y estado de auto-renovación:

```text
/dominio agregar Cliente | ejemplo.es | cuenta-agencia o correo | 2027-04-30 | sí
```

- `/dominios`: inventario activo ordenado por próxima renovación.
- `/renovaciones`: vencidos y los próximos 90 días; acepta otro horizonte de 1 a 3650 días.
- `/dominio renovar ejemplo.es 2027-05-15`: cambia la fecha y reinicia sus avisos.
- `/dominio auto ejemplo.es desconocido`: marca la auto-renovación.
- `/dominio cuenta ejemplo.es alias-nuevo`: cambia la referencia de acceso.
- `/dominio archivar ejemplo.es`: lo retira de las listas activas.

El asistente recuerda renovaciones al entrar en la ventana de 30 días, a 7 días, a 1 día y el día del vencimiento. Si una renovación ya pasó, envía un aviso de vencido. Los hitos se registran para evitar repetir el mismo aviso tras cada consulta.

`accountRef` sirve para recordar **qué correo o alias** usar y queda en texto local sin cifrar. No guardes contraseñas, códigos de recuperación, tokens, claves API, datos bancarios ni accesos de clientes aquí; conserva esos secretos en un gestor de contraseñas.

## Avisos del centro de operaciones

Cada 20 segundos, mientras el bot consulta Telegram, revisa trabajos con estado `needs_attention` en la cola local y envía un aviso una vez por intento. El mensaje no reintenta, resuelve ni ejecuta el trabajo. Para detener todos los avisos de la cola en esa sesión, define `TELEGRAM_NOTIFY_QUEUE=false`.

Los datos de dominios y tareas se guardan localmente en JSON sin cifrar. Protege la cuenta de Windows y conserva una copia segura de `data/` si quieres respaldo. El estado local no se sincroniza entre equipos.

`CENTRO_OPERACIONES_ROOT` apunta a la carpeta del centro cuya cola quieres vigilar. El instalador guarda esta ruta en su configuración local para consultar la cola correcta aunque el bot se ejecute desde otra copia.

## Límites de esta primera entrega

- No se conecta a la API de IONOS ni modifica registros DNS, pagos, renovaciones o cuentas.
- No almacena contraseñas o claves.
- No es un proceso alojado 24/7. Para recibir avisos con el PC apagado, hará falta desplegarlo en un servidor privado y proteger allí sus secretos y datos.
- Los avisos se intentan entregar cuando el bot está en marcha; Telegram o la red pueden fallar y no hay garantía de entrega exactamente una vez.

## Telegram como bandeja de entrada

- Los mensajes libres al bot se guardan en la bandeja del panel y, si Obsidian está conectado, también como nota en `Centro de Operaciones/Mensajes/Telegram`.
- `/mensajes` lista los mensajes pendientes; `/archivar ID` los marca como tratados. También puedes hacerlo desde el panel.
- `/idea agencia texto` y `/idea videojuegos texto` guardan directamente una idea. `/agenda` lista avisos con fecha.
- Los mensajes libres no crean tareas automáticamente. Usa `/anotar` o `/recordar` para evitar que una frase ambigua genere una acción o un aviso por error.

## Google Calendar

La preferencia es Google Calendar, pero todavía no hay sincronización desde este proceso local. La conexión de Google de una sesión externa no se comparte con el bot. La integración local requiere configurar un cliente OAuth de aplicación de escritorio y autorizar una vez la cuenta en este PC; los tokens quedarán fuera del repositorio. Hasta completar ese paso, los recordatorios son locales y se notifican por Telegram, no aparecen como eventos de Google Calendar.

Las ideas se pueden guardar como referencia o enviar al planificador desde la propia tarjeta. Al enviarlas, se crea un trabajo de análisis del negocio correspondiente: el perfil prepara objetivo, pasos priorizados, entregables, criterios comprobables y preguntas, sin modificar código ni archivos. La ejecución depende del ajuste de autoejecución de la cola; también puedes dejarla apagada y lanzar la cola manualmente.

## Proyectos y flujos

El panel permite crear un registro por juego, web o producto. Cada proyecto tiene un flujo inicial según su línea de negocio, etapa actual, siguiente acción y estado activo/pausado/completado. Asocia ideas y trabajos a un proyecto para revisar sus encargos recientes y mantener el contexto de Obsidian separado por proyecto. La etapa y el siguiente paso se actualizan manualmente; el panel no los deduce del resultado de un agente.
