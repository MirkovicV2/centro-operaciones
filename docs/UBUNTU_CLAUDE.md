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

## Prueba en dos pasos

1. En **Peticiones → Nueva consulta → Preguntar al coordinador**, envía «Resume qué dice Obsidian sobre el color principal del Proyecto de prueba». Mira **Peticiones** para ver el aviso, las fuentes y la respuesta. Esta opción abre una consulta.
2. Para ejecutar etapas, registra un proyecto de prueba con su checkout Git independiente bajo `workspaces/`, rama de trabajo y rama base. En **Trabajos → Nuevo trabajo**, selecciona el proyecto y pide un cambio pequeño con un criterio verificable. Comprueba el destino que muestra el panel y activa autoejecución solo para la empresa de prueba. Para probar preparación desde cero, usa una **idea sin proyecto** con autorización explícita para crear el destino y envíala al coordinador.

Para probar publicación, instala [GitHub CLI](https://cli.github.com/) y autentícate con tu propia cuenta. Autoriza el alcance y el repositorio de prueba explícitamente. Para QA Android en Ubuntu, prepara el SDK y un emulador local si el encargo lo exige. El lanzador de AVD incluido para Windows es específico de esa instalación.

## Documentación del flujo

- [Contratos de encargo y entrega v1](ORCA_CONTRACTS.md)
- [Conectar y organizar Obsidian](OBSIDIAN.md)
- [Operación de coordinación](COORDINATOR_OPERATIONS.md)
- [Preparación de un proyecto nuevo](COORDINATOR_PREPARATION.md)
