# Reparto del pipeline: agente, modelo y esfuerzo por etapa

Cada etapa (Planificación, Diseño, Desarrollo, QA, Revisión) puede lanzarse con un agente distinto
(`codex` o `claude`), con su modelo y su esfuerzo. La integración con GitHub la ejecuta el motor, sin modelo.

Hay **una sola resolución** (`resolveStageLaunch` en `pipeline-config.mjs`). La usan la CLI, Ideas, Nuevo
trabajo, los reintentos y la ejecución automática, porque todas terminan en el mismo lanzamiento de etapa.

## Activación

Sin `data/pipeline.json` el Centro lanza exactamente como antes: un único agente (`CENTRO_ORCA_AGENT`,
Codex si no se define) y los niveles de `data/orca-launch-levels.json`.

Para activar el perfil mixto en una instalación:

1. `node cli.mjs preview --business agency --kind code` y `--business games`, con el archivo todavía sin copiar, para ver el reparto actual.
2. Copia `ejemplos/pipeline.mixto.example.json` a `data/pipeline.json` (no se versiona: cada PC tiene el suyo).
3. Repite la vista previa y comprueba el reparto nuevo.
4. Comprueba en **esa** instalación que Orca acepta cada modelo y esfuerzo con sus dos cuentas. El Centro valida
   la forma del archivo, no que el proveedor ofrezca el modelo. Un modelo rechazado deja la etapa en
   `failed/rejected` sin trabajador creado; se corrige el archivo y se reintenta.

Desactivar es borrar o renombrar `data/pipeline.json`.

## En el panel

- **Ajustes → Agentes y modelos por etapa** edita el reparto por ámbito (general, empresa, proyecto). «Cargar perfil
  mixto de ejemplo» rellena el formulario y no aplica nada hasta «Guardar reparto». Solo el rol `admin` puede guardar.
- Cada guardado valida antes de escribir, deja el archivo anterior en `data/pipeline.json.anterior` y añade una línea a
  `data/pipeline-changes.jsonl` (cuándo, quién, huella anterior y nueva).
- **Nuevo trabajo → Reparto de este encargo** muestra con qué se lanzaría cada etapa y permite fijar agente, modelo o
  esfuerzo solo para ese encargo.
- En la página de un trabajo, cada etapa lanzada muestra lo que usó («Modelo») y cada etapa pendiente lo que usaría hoy
  («Modelo previsto»). Lo previsto se fija en el momento de lanzar la etapa.

## Precedencia

De menos a más específico. Gana el más específico **campo a campo** (`agent`, `model`, `effort`):

| Capa | Dónde |
| --- | --- |
| por defecto | `CENTRO_ORCA_AGENT` + `roles` de `data/orca-launch-levels.json` |
| general | `general.roles` de `data/pipeline.json` |
| empresa | `empresas.agency` / `empresas.games` |
| proyecto | `projects.<id>` de `orca-launch-levels.json` (formato anterior) y después `proyectos.<id>` de `pipeline.json` |
| encargo | `launch` del encargo (`--launch-file` en la CLI) |

Una entrada de rol admite `agent`, `model`, `effort`, o bien `level` (`ligero`, `estandar`, `profundo`), que
se traduce con la tabla `agents` de `orca-launch-levels.json` para el agente vigente.

Reglas de combinación:

- Un `model` pertenece a un proveedor: la entrada que lo nombra debe indicar también `agent`.
- **Cambio de proveedor**: si una capa cambia el `agent`, el modelo y el esfuerzo heredados del otro proveedor
  se descartan. La etapa usa lo que diga esa capa y, en su defecto, el nivel del rol en la tabla del nuevo agente.
  Un nombre de modelo de Claude nunca llega a Codex, ni al revés.
- `level` sustituye a la vez modelo y esfuerzo heredados.
- `model`/`effort` sin valor final = el que tenga por defecto el agente (no se pasa el flag).

## Elección en un encargo

```json
{ "roles": { "desarrollador": { "agent": "claude", "model": "opus", "effort": "high" }, "qa": { "effort": "high" } } }
```

El formato anterior `{ "agent": "claude", "roles": { "qa": { "model": "sonnet" } } }` sigue admitido con su
significado: la elección solo se aplica si la etapa se lanza con ese agente, y no lo selecciona. La vista
previa avisa cuando una elección así se ignora.

### Escaladas

`escaladas` define lanzamientos más potentes con nombre y los roles que cubren. Un encargo la pide por rol
indicando por qué, con qué alcance y qué resultado verificable espera; los tres textos quedan en el registro
de la etapa:

```json
{ "roles": { "revisor": { "escalada": "gpt-astra", "motivo": "Dos revisiones discrepan sobre una condición de carrera",
  "alcance": "Solo save_manager.gd", "resultado": "Reproducción determinista o descarte razonado" } } }
```

## Reintentos y recuperación

- Cada etapa registra el lanzamiento resuelto (`launch`) antes de iniciar el trabajador.
- Un **retry nativo** (misma Task de Orca, tras un dispatch `failed`, `cancelled` o `abandoned`) reutiliza el
  agente, modelo, esfuerzo e instrucciones registrados, aunque la configuración haya cambiado después.
- Un lanzamiento **rechazado** por Orca no creó trabajador: el reintento vuelve a resolver la configuración,
  que es lo que permite corregir un modelo inválido.
- Un dispatch incierto no se relanza: se consulta el mismo dispatch, como hasta ahora.

## Límites conocidos

- Se registra el modelo pedido (por ejemplo el alias `sonnet`). La versión concreta que resolvió el proveedor
  no se registra todavía: falta comprobar si `worker-show` de Orca la expone.
- En el panel, Ideas usa el reparto configurado (general, empresa, proyecto); la elección por encargo está en Nuevo trabajo y en la CLI.
- Las sesiones de coordinador las abre cada persona en Orca; su modelo no lo decide este archivo.
