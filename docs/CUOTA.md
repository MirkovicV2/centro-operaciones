# Cuota, suscripciones y fallos de proveedor

## Qué sabe el Centro y qué no

El Centro lanza trabajadores a través de Orca con la autenticación que cada persona configuró allí. **No puede
consultar el saldo de una suscripción.** Lo que sabe es lo que se anota en `data/quota.json` (local, uno por PC):

- lo que tú observas en la pantalla de uso de cada proveedor y apuntas en **Ajustes → Cuota y suscripciones**;
- lo que el motor deduce cuando un trabajador termina sin entrega y su salida apunta a un límite. Esto se guarda como
  *inferido* y se muestra así hasta que lo confirmes.

Por eso cada estado dice cómo se conoce:

| Estado | Significa |
| --- | --- |
| Disponible | Observación reciente, por debajo de la línea de reserva. |
| En la reserva personal | Observación reciente en la línea de reserva o por encima. El resto es tuyo. |
| Agotada | El proveedor dejó de aceptar trabajo (marcado por ti, o inferido), hasta una hora conocida. |
| Uso no conocido | No hay observación, caducó, o la cuota se reinició después de la última. **No** se trata como «queda de sobra». |

## Política

Explícita, en el mismo archivo:

| Campo | Por defecto | |
| --- | --- | --- |
| `reservaPersonalPorcentaje` | 10 | Parte de cada suscripción que el Centro no gasta. No admite menos de 10. |
| `avisoPorcentaje` | 75 | Uso desde el que el panel avisa. |
| `caducidadObservacionHoras` | 6 | Pasado este tiempo, una observación deja de contar. |
| `sinDatos` | `admitir` | `admitir` lanza y deja el aviso en la etapa; `esperar` no lanza sin observación reciente. |
| `alAgotar` | `esperar` | `esperar`, o `sustituir` por el proveedor de `sustituciones`. |

- **Espera.** Antes de empezar o reanudar un encargo se comprueban todos los proveedores que usarán sus etapas
  pendientes. Si alguno está en reserva o agotado, el encargo queda «En espera · Cuota del proveedor», **sin consumir
  un intento**, y otro encargo que no dependa de ese proveedor puede ejecutarse. Vuelve a comprobarse en cada ciclo.
- **Sustitución.** Solo para una etapa que aún no tiene trabajador, solo hacia un proveedor con suscripción declarada y
  uso observado por debajo de la reserva. Queda anotado en la etapa («Proveedor sustituido»). El modelo y el esfuerzo
  son los del nivel de ese rol para el nuevo proveedor.
- **Nunca** compra, recarga, ni pasa trabajo a facturación por API. Esas decisiones son tuyas.

Sin `data/quota.json` no hay política: las etapas se lanzan sin comprobar el uso, como antes.

## Autenticación y consumo adicional

El panel muestra, por proveedor, la autenticación que declaras (suscripción, API o sin comprobar) y avisa si:

- `ANTHROPIC_API_KEY` u `OPENAI_API_KEY` están definidas en el entorno del Centro: si Orca o sus trabajadores las
  heredan, el consumo puede ir a facturación por API en lugar de a la suscripción;
- un proveedor está declarado con API;
- no se ha declarado cómo se autentica.

El Centro lee solo el nombre de esas variables, nunca su valor. Cómo se autentica realmente Orca hay que comprobarlo en Orca.

## Tipos de parada

Un encargo detenido se muestra por su causa, con el siguiente paso (`failure-taxonomy.mjs`):

| Tipo | Ejemplos | Qué hacer |
| --- | --- | --- |
| Fallo del producto | QA o Revisión rechazan el candidato | Leer los hallazgos; vuelve a Desarrollo. |
| Configuración inválida | reparto, skill, contrato o cuota mal definidos; Orca rechaza el modelo | Corregir el archivo y reintentar. No se creó trabajador. |
| Cuota del proveedor | en reserva o agotada | Esperar al reinicio, actualizar la observación o sustituir. |
| Proveedor u Orca no disponible | Orca cerrado, el proveedor no responde | Reintentar más tarde; el candidato no cambió. |
| Resultado incierto | no consta si el trabajador arrancó o terminó | Consultar el mismo dispatch; nunca se lanza una copia. |
| Bloqueo operativo | la etapa no pudo hacer su comprobación | Reintentar la etapa sobre el mismo candidato. |
| Decisión pendiente | preguntas imprescindibles sin responder | Responder en Ideas y preguntas. |
| Consulta interna | Desarrollo pide un dictamen de Diseño | Lo resuelve el coordinador. |
| Permiso pendiente / Prueba humana pendiente | la pregunta lleva una clave `permiso-…` o `prueba-humana-…` | Conceder o hacer la prueba y responder. |

## Sustituir el proveedor de una etapa que falló

Cuando un trabajador terminó sin completar su etapa (por cuota, por ejemplo) puedes repetirla con el otro proveedor:

```
node cli.mjs retry --id <encargo> --confirm-reviewed --substitute codex --reason "Claude sin cuota hasta las 18:00"
```

- Solo si consta que el trabajador anterior **terminó** (Orca informó su estado final) o que el lanzamiento fue
  rechazado. Con un dispatch incierto se rechaza: primero se consulta ese dispatch.
- Se crea una asignación nueva en Orca que sucede a la anterior. Los cambios que dejó en el checkout y su informe
  parcial se conservan, y el nuevo encargo se los señala para que no repita ni dé por bueno lo ya hecho.
- El reintento normal, sin `--substitute`, repite la misma Task con el mismo proveedor, modelo y esfuerzo.

## Límites verificados

- Las frases con las que se reconoce un límite o una indisponibilidad en la salida de un trabajador son una hipótesis
  de trabajo, no comprobada con cuentas reales. Solo se aplican a un trabajador fallido **sin entrega**; un resultado
  inferido se guarda como tal y un encargo así queda pendiente de tu revisión.
- Una cuota que se agota a mitad de un encargo ya empezado sí consume ese intento.
- La sustitución desde el panel de un encargo con recibo de autoejecución pendiente de revisión no está disponible;
  usa la CLI.
