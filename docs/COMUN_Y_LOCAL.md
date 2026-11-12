# Qué es común del equipo y qué es local de cada PC

Esta es la frontera entre lo que viaja en el repositorio (`main`) y lo que cada instalación crea y conserva en su `data/` y en su equipo. Si dudas dónde va algo: lo que dos PCs deben compartir para trabajar igual va aquí, en el repositorio; lo que contiene rutas, cuentas, estado de trabajos o datos de una persona se queda local.

## Común (versionado)

| Qué | Dónde |
|---|---|
| Código del Centro: cola, conector Orca, workflow v2, auto-run, integración con GitHub, CLI | raíz |
| El panel (backend e interfaz) | `panel/` |
| Perfiles de agentes de Orca/Codex y su modelo por defecto | `.codex/agents/`, `.codex/config.toml` |
| Contratos de cada empresa | `contratos/` |
| Skills con huella verificada y `game-production` | `skills/`, `.codex/skills/` |
| Los PCs del equipo y sus recursos | `equipos/equipos.json` |
| **Reparto de modelos por etapa del equipo** (el perfil que se instala por defecto) | `perfil-equipo/pipeline.json` |
| **Conjuntos de referencias de diseño del equipo** (capturas y notas que se instalan en cada PC) | `perfil-equipo/referencias/<ámbito>/<conjunto>/` |
| Memoria compartida de proyecto | `memoria/` |
| Plantillas de configuración opcional | `ejemplos/` |
| Documentación, lanzadores de Windows y Ubuntu, CI y pruebas | `docs/`, `*.cmd`, `panel/*.sh`, `.github/`, `tests/` |

## Local (no se sube nunca)

| Qué | Dónde |
|---|---|
| Cola, estado e historial de eventos | `data/state.json`, `data/events.jsonl` |
| Peticiones, ideas y preguntas | `data/operations-inbox.json` |
| Auto-run y recibos | `data/auto-run.json` |
| Vínculo de los coordinadores con Orca (ids de sesión de este PC) | `data/coordinator-bindings.json` |
| Ruta de la bóveda de Obsidian y de la cola | `data/operations-dashboard.json` |
| Informes, dossiers, prompts, referencias instaladas o importadas en este PC y continuaciones | `data/dossiers/`, `data/stage-reports/`, `data/prompts/`, `data/references/`… |
| Ajustes por proyecto del reparto (ids de proyecto locales) | `proyectos` dentro de `data/pipeline.json` |
| Checkouts de proyectos y entregas | `workspaces/`, `analysis/`, `entregas/`, `.artifacts/` |
| Bóveda de Obsidian, repos privados de clientes | fuera del repositorio |
| Sesiones y ajustes de Orca (coordinadores, permisos de agentes), cuentas de Claude/Codex/`gh`, credenciales | fuera del repositorio |
| Variable `CENTRO_ORCA_AGENT`, `centro.local.cmd` | entorno del PC |

## Puesta en marcha en un PC nuevo

1. Descarga `main` y arranca el panel como indica el README.
2. `node cli.mjs instalar` (en Windows, `centro.cmd instalar`). Crea en `data/` lo que falte a partir de lo común:
   - `data/pipeline.json` con el reparto de `perfil-equipo/pipeline.json`;
   - `data/references/…` con los conjuntos de `perfil-equipo/referencias/` (hoy `global/paneles-agentes` y `agency/webs-inspiracion`), verificados con su huella;
   - `data/equipo.json` con la identidad de este PC, elegida por su sistema (`equipos/equipos.json`).

   No sobrescribe nada que ya exista: un conjunto de referencias que este PC ya tiene no se reimporta. `--sin-pipeline` no crea el reparto de modelos y `--sin-referencias` no instala las referencias.
3. `node cli.mjs preview --business agency --kind code` muestra qué agente y modelo recibirá cada etapa.
4. Comprueba en ese PC que Orca acepta esos modelos y esfuerzos con tus cuentas: el Centro valida la forma del archivo, no que el proveedor ofrezca el modelo (`PIPELINE_CONFIG.md`). Si no los tienes, cámbialos en **Ajustes → Agentes y modelos por etapa** o borra `data/pipeline.json` para volver al agente único.
5. Conecta tu bóveda en **Conocimiento**, registra tus proyectos y vincula tus coordinadores de Orca (`COORDINATOR_OPERATIONS.md`).

Para cambiar el perfil del equipo, edita `perfil-equipo/pipeline.json` y súbelo: lo recibirán los PCs que ejecuten `instalar` por primera vez; los que ya tienen su `data/pipeline.json` conservan el suyo.

Para compartir un conjunto nuevo de referencias, pon sus archivos (imágenes png/jpg/webp/gif de hasta 5 MB y notas `.md`) en `perfil-equipo/referencias/<global|agency|games>/<nombre>/` y súbelo. Lo que no es del equipo, como las referencias de una idea o de un proyecto concreto, se queda local porque su identificador solo existe en ese PC. Antes de subir capturas de webs ajenas, recuerda que el repositorio es público.
