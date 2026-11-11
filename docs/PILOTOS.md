# Pilotos del perfil mixto

Tres encargos pequeños para comprobar el perfil mixto con agentes reales. **No se han ejecutado.** Todo lo acreditado
hasta ahora se obtuvo con Orca simulado (`npm test`) y con el panel en navegador con respuestas interceptadas.

## Autorización

Un piloto lanza trabajadores reales y consume cuota de las dos suscripciones. Antes de cada uno, quien lo ejecuta deja
anotado en la petición del panel:

- qué piloto, en qué PC y con qué cuentas;
- el uso observado de cada proveedor antes de empezar (Ajustes → Cuota);
- el máximo que acepta gastar (por ejemplo, «hasta el 60 % de uso de Claude»).

Sin esa autorización identificada no se activa la autoejecución de la empresa.

## Los tres pilotos

| Piloto | Encargo | Ruta | Qué ejercita |
| --- | --- | --- | --- |
| Web (Agencia) | `ejemplos/pilotos/piloto-web.txt` | `interfaz` | Claude en Diseño y Desarrollo, Codex en QA y Revisión; `frontend-design` y `web-testing`. |
| Godot (Videojuegos) | `ejemplos/pilotos/piloto-godot.txt` | `interfaz` | Claude con esfuerzo high; `game-production` y `godot-gdscript-patterns`; memoria de Flecha Trampa; recurso `godot`. |
| Corrección del Centro | `ejemplos/pilotos/piloto-centro.txt` | `funcional` | Ruta sin Diseño con su motivo; cambio pequeño con prueba. |

Para cada uno: admitirlo desde el panel (Ideas o Nuevo trabajo), revisar la vista previa del reparto antes de enviar y
dejar que el coordinador elija la ruta.

## Qué medir

`node metrics.mjs` incluye el bloque `pipeline`, calculado de lo que registró cada etapa:

- `stages`: lanzamientos por etapa, agente, modelo y esfuerzo, y cómo terminaron;
- `returnsToDevelopment`: devoluciones de QA o Revisión a Desarrollo;
- `blockingFindings`: defectos bloqueantes encontrados;
- `humanAnswers`: intervenciones humanas (respuestas y decisiones);
- `quotaStops`: paradas por cuota;
- `timeToAcceptanceMs`: tiempo desde la admisión hasta la entrega.
- `routes`: por ruta, encargos, devoluciones, defectos bloqueantes, Diseño añadido después y `toReview`, los encargos
  sin Diseño que conviene revisar (periodo de prueba de `docs/RUTAS.md`).

El consumo observable es el que muestre la pantalla de uso de cada proveedor antes y después: el Centro no recibe
tokens ni saldo. Anótalo junto al resultado.

## Cómo leer el resultado

Con tres encargos no hay base para conclusiones generales; sí para decisiones de reparto concretas:

- Si QA devuelve a Desarrollo más de una vez por fallos que una lectura atenta habría evitado, prueba Desarrollo con
  esfuerzo high antes de cambiar de modelo.
- Si Revisión no encuentra nada que QA no hubiera encontrado, baja su esfuerzo a medium.
- Si Diseño consume una parte grande de la cuota de Claude en encargos sin interfaz, el coordinador debería haber
  elegido la ruta `funcional`.
- Si una etapa se detiene por cuota a mitad de encargo, sube `avisoPorcentaje` o actualiza la observación antes de empezar.

Distingue siempre en el informe lo obtenido con agentes reales de lo obtenido en simulación.

## Primer piloto real (11-11-2026, PC de David)

Encargo «Añadir `truncate(s, max)` en `src/text.mjs` con tests» en el sandbox `eoc-e2e-sandbox`, enviado desde Nuevo
trabajo. Se hizo en el sandbox y no en el Centro porque ya tenía checkout y permisos. Referencia: el encargo `slugify`
del 10-11 en el mismo proyecto (todo Claude, ruta completa). Un solo encargo trivial: sirve para saber qué funciona, no
para comparar modelos.

| | Referencia (10-11) | Piloto (11-11) |
| --- | --- | --- |
| Ruta | `interfaz`: Diseño tardó 2 min 48 s en concluir «no aplica» | `funcional`, elegida por el coordinador con motivo registrado |
| Desarrollo | Claude, modelo por defecto | Claude `sonnet` medium |
| QA y Revisión | Claude | Claude por sustitución: Codex estaba en la reserva (93 %) |
| Paradas | 3 (dos recuperaciones y la integración) | 1 (permiso de lectura, 18 min esperando a la persona) |
| Devoluciones y defectos bloqueantes | 0 | 0 |
| Resultado | PR fusionada | PR fusionada; 14/14 pruebas, repetidas fuera del pipeline |

Funcionó con agentes reales: ruta sin Diseño, modelo y esfuerzo por etapa, sustitución por cuota anotada en QA y
Revisión, equipo responsable, contrato en ocho secciones, integración.

No se ha ejercitado: Codex (ni `gpt-6.1-sol` en Orca), Diseño con Claude, escaladas, reservas de rama, Windows.

Lo que salió:

- El contrato local de Desarrollo mandaba leer una skill fuera del checkout (`~/dev/es-skills`) y Claude Code pidió
  permiso: la etapa esperó 18 minutos. Las skills que cite un contrato deben estar en la lista `allow` del checkout o
  registradas en el Centro (docs/SKILLS.md), que las copia donde el trabajador ya puede leer.
- Cada etapa espera unos 2 minutos entre la entrega y el cierre del trabajador en Orca: 6 de los 9 minutos y medio de
  máquina. El trabajo real fue de 28 s en QA y 46 s en Revisión. Es el punto con más margen; falta saber si Orca
  permite cerrar antes.
- El coordinador enrutó el primer aviso en 27 s y no reaccionó al segundo hasta que se le escribió.
- Un fallo de Git antes de admitir (el repositorio ya no existía) deja el recibo bloqueado sin reintento y sin el
  detalle del error.
- A un encargo sin interfaz se le ofrecieron `frontend-design` y `web-testing`; la vista previa del formulario no
  tiene en cuenta la cuota y anunciaba Codex.
- Una observación en la reserva caducaba y reabría el proveedor (corregido).
