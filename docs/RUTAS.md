# Rutas de un encargo

La ruta decide qué etapas recorre un encargo. La elige quien lo admite (el coordinador al enrutar, o la CLI) y
queda guardada en el trabajo con su motivo.

| Encargo | Ruta | Etapas |
| --- | --- | --- |
| Consulta o análisis | `kind: analysis` | Coordinación → Planificación → informe |
| Interfaz o jugabilidad | `interfaz` (por defecto) | Diseño → Desarrollo → QA → Revisión → integración |
| Cambio funcional sin interfaz | `funcional` | Desarrollo → QA → Revisión → integración |
| Documentación | `documentacion` | Desarrollo (edición) → QA (comprobaciones de documentación) → Revisión → integración |

Reglas:

- **Solo Diseño puede omitirse.** QA, Revisión y las comprobaciones de integración forman parte de todas las rutas de
  código. Un encargo que toca seguridad, datos, guardados, permisos o publicación conserva así todas sus verificaciones,
  elija la ruta que elija el coordinador. No hay clasificación por palabras: la garantía es estructural.
- **Toda etapa omitida tiene una razón visible.** `funcional` y `documentacion` exigen `reason`. La etapa permanece en
  el flujo como «Omitido» con ese motivo, en la tarjeta del trabajo, en su página y en el informe.
- Las etapas siguientes reciben el motivo en lugar de una especificación vacía, y la instrucción de consultar al
  coordinador si aparece una decisión de diseño.
- Sin `route`, el trabajo se comporta exactamente como antes (`interfaz`).

## Elegir la ruta

- Coordinador: `POST /api/coordinator/requests/<id>/route` con `{"kind":"code","route":{"id":"funcional","reason":"…"},…}`.
- CLI: `node cli.mjs add … --kind code --route funcional --reason "Solo cambia el cálculo de IVA en el servidor"`.

## Devoluciones dentro de la ruta

No cambian con este documento; son las que ya ejecuta el motor:

- **QA o Revisión → Desarrollo**: un fallo reproducible del contrato abre una ronda de corrección sobre el mismo
  candidato y revalida después.
- **Desarrollo → Diseño**: en una ruta con Diseño, el retorno autorizado por el coordinador encadena el dictamen de
  Diseño y una nueva asignación de Desarrollo en el mismo trabajo.

## Añadir una etapa por cambio de alcance

Si el alcance cambia y ahora hace falta Diseño:

- Coordinador: `POST /api/jobs/<id>/stages` con `{"stage":"ux","reason":"qué cambió"}`.
- CLI: `node cli.mjs add-stage --id <id> --stage ux --reason "qué cambió"`.

Queda registrado quién la añadió, cuándo y por qué, y se muestra en la página del trabajo.

**Límite verificado:** solo se admite mientras Desarrollo no tenga ninguna asignación (trabajo en cola o pendiente de
revisión, sin Task de Desarrollo). Un desarrollador que ya recibió su encargo sin diseño no puede recibir uno a mitad
sin rehacer su asignación; en ese caso la duda de diseño se resuelve con la consulta al coordinador, o se crea un
encargo nuevo con la ruta completa.
