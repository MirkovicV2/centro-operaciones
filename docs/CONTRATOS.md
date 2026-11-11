# Contratos

## El contrato de cada asignación

Todo encargo que recibe un trabajador, sea de Codex o de Claude, tiene las mismas ocho secciones en el mismo orden:

1. **Objetivo** — la tarea, el encargo con su criterio de éxito y qué hace esta etapa.
2. **Alcance** — destino confirmado, guardas y lo que la etapa no puede hacer (commit, push, publicar).
3. **Entradas** — informes de etapas anteriores, evidencia humana, contexto documental.
4. **Decisiones vigentes** — las respondidas por el usuario o el coordinador y las rectificaciones de alcance.
5. **Criterios de aceptación** — los del producto. La revisión posterior, los checks remotos y el merge son criterios
   de cierre: los acredita el motor después, con sus propios requisitos, y ningún trabajador los marca por adelantado.
6. **Evidencias exigidas** — qué debe respaldar la entrega de esa etapa.
7. **Devolución y escalado** — a dónde va un defecto, una duda interna o una decisión que no le corresponde.
8. **Entregables** — qué entrega la etapa y el formato obligatorio de la entrega.

Antes de las secciones van el perfil del rol, las skills (`docs/SKILLS.md`) y los contratos de rol de este documento:
dicen cómo trabajar; las secciones dicen qué es esta asignación. El motor no envía un encargo al que le falte una sección.

Lo que entrega cada etapa, sus evidencias y sus reglas de devolución están en `stage-contract.mjs`.

### Codex y Claude, Windows y Ubuntu

El encargo es el mismo. Solo cambia la línea que explica cómo verificar la huella y leer el archivo, porque cambian las
herramientas (`provider-adapter.mjs`):

| | Windows | Ubuntu |
| --- | --- | --- |
| Codex | `(Get-FileHash -Algorithm SHA256 -LiteralPath '<ruta>').Hash`, comparando sin distinguir mayúsculas | `sha256sum '<ruta>'` |
| Claude | `sha256sum "<ruta>"` en su herramienta Bash (Git Bash) y lectura con Read | igual |

Las rutas van siempre entre comillas: la carpeta del Centro puede contener espacios. En Claude, la orden coincide con
la regla `Bash(sha256sum:*)` de la plantilla de permisos del checkout.

Pendiente de comprobar en una instalación real: que Git Bash de la instalación Windows de Claude incluye `sha256sum`.

## Contratos de rol (global, empresa y proyecto)

Instrucciones opcionales que especializan el perfil de cada etapa sin tocar el código del Centro. Hay dos lugares:

```
contratos/<ámbito>/<etapa>.md        compartidos: versionados en el repositorio, iguales en todos los PCs
data/contracts/<ámbito>/<etapa>.md   locales: solo esta instalación; nunca en el checkout que editan los agentes
```

Ámbitos, en este orden: `global`, `empresa-<empresa>` (agency, games) y `proyecto-<id del proyecto>`. Dentro de cada
ámbito se aplica primero el compartido y después el local.

Etapas: `planner`, `ux`, `developer`, `qa`, `reviewer`. Cada capa es opcional y se añade al encargo del trabajador en ese orden (la más específica concreta a la anterior), con su ruta y su SHA-256. La etapa registra qué contratos recibió y el panel los muestra. Si no hay ningún archivo, el encargo no cambia.

Un contrato especializa el rol (qué revisar, qué estilo seguir, qué skill aplicar). No puede cambiar permisos, publicación, el contrato de entrega ni las reglas de la asignación: el encargo se lo recuerda al agente y las reglas del Centro van después. Límite: 16 000 bytes por archivo; un enlace simbólico o un archivo mayor bloquea la etapa con `project_contract_invalid` y un mensaje que dice qué arreglar.

Las skills tienen su propio catálogo con huella y procedencia: `docs/SKILLS.md`.
