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
