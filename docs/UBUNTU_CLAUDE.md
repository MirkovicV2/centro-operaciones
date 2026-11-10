# Centro de Operaciones en Ubuntu 26.10 con Claude Code

Windows y Ubuntu usan este repositorio. Cada equipo ejecuta su propio panel, cola, coordinadores y bóveda. Compartís el código mediante GitHub. Si los dos trabajáis sobre el mismo proyecto, usad ramas y copias de trabajo independientes.

## Abrir el panel

Instala Git, curl y Python 3. Python se usa en las pruebas de recuperación de evidencia archivada. Instala Node.js 20 o posterior y npm desde Ubuntu o [Node.js](https://nodejs.org/en/download).

```bash
sudo apt update
sudo apt install git curl python3
node --version
npm --version
git clone https://github.com/MirkovicV2/centro-operaciones.git
cd centro-operaciones
CENTRO_ORCA_AGENT=claude npm start
```

Abre [el panel local](http://127.0.0.1:4187) y deja esa terminal abierta. Puedes explorar la interfaz, guardar ideas y conectar Obsidian antes de configurar Orca. Para ejecutar la batería local, abre otra terminal en el repositorio y usa `npm test`.

## Conectar Orca y Claude Code

1. Instala [Orca para Linux](https://www.onorca.dev/docs/install) y registra su CLI desde **Settings → General → Orca CLI**. En Ubuntu, la CLI externa se llama `orca-ide`. El ejecutable `orca` del sistema puede ser el lector de pantalla de GNOME.
2. Instala [Claude Code](https://code.claude.com/docs/en/setup) e inicia sesión con tu propia cuenta. Comprueba `claude --version` fuera y dentro de Orca. Desde la terminal que abre el panel, comprueba `orca-ide orchestration worker-start --help`. Para indicar otra ubicación de la CLI, exporta `ORCA_CLI_COMMAND` con la ruta absoluta a su ejecutable antes de arrancar el panel.
3. Abre el clon en Orca y crea una sesión **Claude Code** para la empresa que quieras probar. En esa sesión, pídele que lea [COORDINATOR_OPERATIONS.md](COORDINATOR_OPERATIONS.md) y [COORDINATOR_PREPARATION.md](COORDINATOR_PREPARATION.md). Pídele que, desde su propia identidad de terminal, cree una Run con `orchestration run-create --objective "Coordinación local de Agencia" --json`, verifique su propietario con `orchestration run-show --id RUN --full --json` y te devuelva `run.id` y `run.coordinator_handle`. Mantén la sesión abierta. Para Videojuegos, usa una sesión y una Run distintas.
4. Crea `data/coordinator-bindings.json` bajo el clon. Sustituye los dos valores del ejemplo por los que devolvió Orca. Si añades Videojuegos, crea otra entrada con `business: "games"` y enlázala en `businesses.games`.

```json
{
  "schemaVersion": 1,
  "coordinators": [{
    "id": "agencia-local",
    "name": "Coordinador de Agencia",
    "business": "agency",
    "runId": "run_REEMPLAZAR",
    "senderId": "term_REEMPLAZAR"
  }],
  "businesses": { "agency": "agencia-local" },
  "projects": {}
}
```

Comprueba la conexión con `curl -fsS http://127.0.0.1:4187/api/coordinators`. Si la Run o el propietario no coinciden, revisa esos datos en la terminal del coordinador. Conserva el lanzamiento con `CENTRO_ORCA_AGENT=claude npm start`. El valor selecciona Claude para los trabajadores que lanza el panel y para la preparación indicada al coordinador. Los trabajadores usan el modelo configurado en Claude Code. Sin esa variable, el panel usa Codex. La recuperación desde archivos de sesión privados es específica de Codex. Claude usa la entrega y la transcripción nativas de Orca.

## Abrir los agentes Claude como Terminal

Orca 1.4.253 abre por defecto los agentes nuevos como **sesión de chat** (`agentDefaultSurface: chat`). Un trabajador así (`structworker_…`) no tiene terminal: la cola no puede observar su salida en vivo y en la prueba E2E solo las etapas con trabajadores de **Terminal** cerraron con normalidad. Antes de ejecutar encargos:

1. **Settings → Agents → «Open agents as»**: pon Claude (y Codex) en **Terminal** («Set all to Terminal»). Internamente queda `nativeChatProviders = { claude: false, codex: false }`.
2. **Settings → Agents → «Agent Permissions»**: elige el modo de permisos de los trabajadores.
   - «Ask for approval» (`ask`): cada comando pide aprobación; la etapa no termina sola. No sirve para la cola.
   - «Accept edits» (`accept-edits`): aprueba ediciones, pero sigue preguntando por los comandos Bash de verificación.
   - «Approve for me» (`auto`), **recomendado**: un clasificador aprueba o deniega cada comando. Con la [plantilla de permisos](#permisos-de-los-trabajadores-claude) los comandos simples pasan; los encadenados pueden denegarse.
   - «Full access» (`full-access`): ejecuta todo sin diálogo. La lista `deny` del checkout es la única barrera; úsalo solo con checkouts de prueba.

Al arrancar con `CENTRO_ORCA_AGENT=claude`, el panel lee en modo solo lectura la configuración de Orca (`~/.config/orca/profiles/<perfil>/profile-state.db`, dominio `settings`) y avisa por consola si Claude se abrirá como chat o si el modo de permisos es `ask`. El resultado está en `settings.orcaPreflight` de `/api/state`. Si la configuración no se puede leer, avisa de que hay que comprobarlo a mano; nunca la modifica.

## Permisos de los trabajadores Claude

Claude Code lee `.claude/settings.local.json` del checkout en el que trabaja. La plantilla [ejemplos/claude-settings.local.example.json](../ejemplos/claude-settings.local.example.json) permite lo que necesita un trabajador de la cola y deniega lo que el contrato prohíbe. Cópiala al checkout aislado de cada proyecto de prueba y sustituye los marcadores; el panel no la aplica automáticamente a checkouts ajenos.

| Permitido | Denegado |
| --- | --- |
| Leer su encargo en `data/dispatch-specs/**` y los informes en `data/stage-reports/**` | `git push`, `git commit`, `gh`, `sudo`, `rm`, `wget` |
| `sha256sum`, `wc -c`, `npm test`, `node --test`, `git status`, `git diff`; lectura con la herramienta Read solo en las rutas permitidas | `curl` a otros hosts y a `localhost` (solo `127.0.0.1:<PUERTO>`); `cat` y `ls`, que leerían cualquier ruta |
| `curl -X POST http://127.0.0.1:<PUERTO>/api/jobs/*/context` | Escribir en `data/` y `.artifacts/` del centro |
| `orca orchestration send --type worker_done`, `ask`, `dispatch-show` | `worker-start`, `run-create`, `task-create`, `dispatch`, `worker-stop`, `coordinator-start`, `worktree`, `agent`, `terminal`, `repo` |

Las reglas `Bash(...)` solo reconocen comandos simples. Por eso el brief pide a los trabajadores un comando por llamada, sin `;`, `&&`, `|`, variables ni `cd` (por ejemplo `sha256sum <ruta>` y la lectura del encargo con la herramienta Read), y una única llamada `curl` para la consulta de contexto. En la prueba E2E los comandos encadenados con `cd …; cat …` fueron los que provocaron diálogos de aprobación o denegaciones del modo automático.

## Niveles por rol: modelo y esfuerzo

Cada rol tiene un nivel (`ligero`, `estandar`, `profundo`) que cada agente traduce a `--model/--effort` de `worker-start`. Sin configuración, Codex recibe exactamente los flags de siempre y Claude no recibe ninguno (usa el modelo de su instalación).

| Rol | Nivel por defecto | Codex (defecto) | Claude (defecto) |
| --- | --- | --- | --- |
| planificador | profundo | `gpt-6-luna` / `high` | sin flags |
| ux, desarrollador, qa, revisor | estandar | `gpt-6.1-sol` / `medium` | sin flags |
| (cualquiera) | ligero | `gpt-6.1-sol` / `low` | sin flags |

Para cambiar niveles o definir flags de Claude, copia [ejemplos/orca-launch-levels.example.json](../ejemplos/orca-launch-levels.example.json) a `data/orca-launch-levels.json` (no versionado). Solo se aplican las entradas que escribas; un archivo inválido detiene el despacho con el error `launch_levels_invalid` en lugar de lanzar con flags adivinados. El nivel usado queda en `jobs[].workflow.steps[].launchLevel`.

**Tres capas de elección (gana la más concreta):**

1. **Por defecto:** `roles` → nivel → `agents.<agente>.<nivel>` en `data/orca-launch-levels.json`.
2. **Por proyecto:** `"projects": { "<id del proyecto>": { "roles": { "revisor": "profundo" } } }` en el mismo archivo.
3. **Por encargo:** al crearlo, `launch: { "agent": "claude", "roles": { "revisor": { "model": "opus", "effort": "medium" }, "qa": { "model": "sonnet", "effort": "high" } } }`. Desde la CLI: `node cli.mjs add ... --launch-file modelos.json`. Como los nombres de modelo dependen del agente, una elección para `claude` no se aplica si el encargo corre con Codex.

Cada etapa guarda en `steps[].launch` con qué se lanzó (`agent`, `model`, `effort`, `level` y `source`: `por defecto`, `proyecto` o `encargo`), y el informe del encargo en Peticiones y la ficha de la etapa lo muestran. Sin el archivo y sin elección en el encargo, Claude no recibe flags y Codex usa sus valores de siempre.

## Prueba en dos pasos

1. En **Peticiones → Nueva consulta → Preguntar al coordinador**, envía «Resume qué dice Obsidian sobre el color principal del Proyecto de prueba». Mira **Peticiones** para ver el aviso, las fuentes y la respuesta. Esta opción abre una consulta.
2. Para ejecutar etapas, registra un proyecto de prueba con su checkout Git independiente bajo `workspaces/`, rama de trabajo y rama base. En **Trabajos → Nuevo trabajo**, selecciona el proyecto y pide un cambio pequeño con un criterio verificable. Comprueba el destino que muestra el panel y activa autoejecución solo para la empresa de prueba. Para probar preparación desde cero, usa una **idea sin proyecto** con autorización explícita para crear el destino y envíala al coordinador.

Para probar publicación, instala [GitHub CLI](https://cli.github.com/) y autentícate con tu propia cuenta. Autoriza el alcance y el repositorio de prueba explícitamente.

### Versión de GitHub CLI

La integración lee campos de PR (`baseRefOid`, `headRepositoryOwner`, `mergeCommit`…) que el `gh` 2.46.0 de los repositorios de Ubuntu no conoce («Unknown JSON field»). La 2.103.3 del repositorio oficial funciona; la versión mínima exacta no se ha determinado. Antes de integrar, el panel comprueba sin red la lista de campos de `gh pr list --json` y bloquea la integración con un mensaje accionable si falta alguno. Instala `gh` desde el repositorio oficial siguiendo [la guía de instalación en Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) (requiere `sudo`: alta del keyring y de `/etc/apt/sources.list.d/github-cli.list`, `apt update`, `apt install gh`) y comprueba `gh --version` y `gh pr list --json 2>&1 | grep baseRefOid`. Para QA Android en Ubuntu, prepara el SDK y un emulador local si el encargo lo exige. El lanzador de AVD incluido para Windows es específico de esa instalación.

## Documentación del flujo

- [Contratos de encargo y entrega v1](ORCA_CONTRACTS.md)
- [Conectar y organizar Obsidian](OBSIDIAN.md)
- [Operación de coordinación](COORDINATOR_OPERATIONS.md)
- [Preparación de un proyecto nuevo](COORDINATOR_PREPARATION.md)
