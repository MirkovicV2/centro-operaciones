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

Lo que salió, y cómo quedó (rama `david/correcciones-piloto`; nada de esto se ha repetido aún con agentes reales):

| Qué pasó | Arreglo |
| --- | --- |
| El contrato local de Desarrollo mandaba leer una skill fuera del checkout y Claude Code pidió permiso: 18 minutos parado sin que el panel lo dijera. | El motor mira la pantalla del trabajador cada medio minuto y, si hay un diálogo de aprobación, lo lleva a Atención. Al lanzar se anotan los archivos citados que el checkout no deja leer. |
| Cada etapa esperaba 2 minutos entre la entrega y el cierre del trabajador: 6 de los 9,5 minutos de máquina. | Se pide `worker-release` al recibir la entrega. Falta medirlo en Orca real. |
| El coordinador enrutó el primer aviso en 27 s y no reaccionó al segundo hasta que se le escribió. | El correo de Orca no despierta a una sesión parada. El panel escribe una línea fija en su terminal cuando está inactiva, con reintento acotado. |
| El repositorio ya no existía: recibo bloqueado sin reintento ni detalle. | La causa queda en el recibo, se puede volver a comprobar el mismo recibo, el diálogo de destino avisa antes de enviar y ofrece recrear el repositorio. |
| A un encargo sin interfaz se le ofrecieron `frontend-design` y `web-testing`. | Esas dos skills solo se ofrecen por defecto en la ruta con Diseño. |
| La vista previa anunciaba Codex estando en la reserva. | La vista previa aplica la política de cuota. |
| Reenviar el mismo texto tras cancelar apuntaba a la solicitud vieja. | Si la anterior está cerrada, es una solicitud nueva. |
| Una observación en la reserva caducaba y reabría el proveedor. | Vale hasta el reinicio anotado. |

Pendiente: cambiar de proveedor cuando un trabajador se corta por cuota a mitad de etapa (hoy lo relanza la persona), y el piloto con Codex.
