# Skills

Una skill es una guía de oficio que el Centro entrega a un trabajador junto a su encargo. Sirven igual a Codex y a
Claude: el motor las selecciona, comprueba su huella, las copia a la carpeta del encargo y anota qué entregó.

## Catálogo

`skills/registry.json` es la fuente de verdad y se comparte por el repositorio.

| Skill | Empresa · etapas | Entrega | Origen | Licencia |
| --- | --- | --- | --- | --- |
| `game-production` (obligatoria) | Videojuegos · Diseño, Desarrollo, QA, Revisión | En el encargo, con la referencia del perfil | Propia (`.codex/skills/game-production`) | Propia |
| `godot-gdscript-patterns` | Videojuegos · Desarrollo, Revisión | Por referencia | `wshobson/agents` @ `9c61ab2` | MIT |
| `frontend-design` | Agencia · Diseño, Desarrollo | Por referencia | `anthropics/skills` @ `2c5958e` | Apache-2.0 |
| `web-testing` | Agencia · Desarrollo, QA, Revisión | Por referencia | Adaptación de `anthropics/skills` `webapp-testing` @ `2c5958e` | Apache-2.0 |

Cobertura: en Agencia, diseño (`frontend-design`) y accesibilidad, adaptación móvil y pruebas de navegador
(`web-testing`); en Videojuegos, controles, animaciones, audio, Android y verificación en el motor (`game-production`)
y arquitectura GDScript, guardado y rendimiento (`godot-gdscript-patterns`).

### Qué se revisó y qué se dejó fuera

- **`frontend-design`**: incorporada sin cambios. Habla de «cliente»; el encargo indica al trabajador que su
  interlocutor es el coordinador.
- **`webapp-testing`**: se incorpora el método (elegir enfoque, reconocer la página renderizada antes de actuar,
  esperar a la carga) reescrito como `web-testing`. **No** se incorporan `scripts/with_server.py` —ejecuta órdenes con
  `shell=True` y encadenadas, incompatible con la regla de un comando simple por llamada de los permisos de Claude— ni
  `examples/`, que usan Playwright de Python y escriben en rutas de otro entorno. Se añade lo que faltaba para Agencia:
  móvil, teclado y accesibilidad básica.
- **`godot-gdscript-patterns`**: incorporada sin cambios más una nota local. El ejemplo de guardado cifra con una clave
  escrita en el código; la nota indica no copiarla y tratar cualquier cambio de formato de guardado como decisión de datos.

## Selección

1. **Empresa, etapa y tipo de encargo**: `appliesTo` de cada skill.
2. **Proyecto** (opcional, local): `data/skills.json`, ver `ejemplos/skills.example.json`.
3. **Encargo** (opcional): `--skills-file` en la CLI, `{"add":[…],"remove":[…]}`.

`remove` solo retira skills opcionales. Una obligatoria se mantiene y el intento queda anotado en la etapa.

## Entrega

- **Por referencia**: el encargo lleva un resumen breve y la ruta de una copia verificada en
  `data/dispatch-specs/<encargo>/skills/<skill>-<huella>/`, con su SHA-256. Esa carpeta es la que ya pueden leer los
  trabajadores de Claude con la plantilla de permisos, y Codex igual. El trabajador lee la guía si la necesita.
- **En el encargo** (`game-production`): el texto va dentro del encargo, como hasta ahora.
- La copia es por encargo y direccionada por contenido: un cambio posterior en el repositorio no altera lo entregado a
  una asignación, y una copia manipulada se rechaza.

## Suministrada y consultada

- **Suministrada** (`skills` de la etapa): lo que el Centro entregó, con la huella. Es un hecho comprobado.
- **Consultada** (`skillsConsulted`): lo que el trabajador declara en `evidence` con `skill:<id>`. Es una declaración
  del agente y solo cuentan las skills que esa etapa recibió.

El panel y el informe muestran ambas por separado.

## Skill ausente o modificada

Antes de cada lanzamiento se compara cada archivo con su huella.

| Skill | Falta o cambió | Efecto |
| --- | --- | --- |
| Obligatoria | sí | La etapa no se lanza (`skill_missing` / `skill_changed`). No se crea trabajador; el reintento vuelve a comprobar. |
| Opcional | sí | No se entrega. La etapa continúa y muestra «Skill no entregada» con el motivo. |

Una asignación ya lanzada, su reanudación y su retry nativo conservan lo que recibieron: un cambio posterior no las
bloquea.

- `node cli.mjs skills` muestra el estado de cada skill.
- `node cli.mjs skills-accept --id <skill>` registra las nuevas huellas **después** de revisar el cambio. No acepta
  archivos que falten.

## Añadir o actualizar una skill

1. Revisa instrucciones, referencias y auxiliares. Descarta lo que ejecute órdenes encadenadas, instale paquetes, use
   red o dependa de rutas de otro entorno.
2. Copia los archivos a `skills/<id>/` con su archivo de licencia.
3. Añade la entrada en `skills/registry.json`: `source` (repositorio, ruta, commit), `license`, `localChanges`,
   `appliesTo`, `mode`, `required` y `files`.
4. `node cli.mjs skills-accept --id <id>` y `npm test`.

Los archivos de skills se guardan con finales de línea LF en Windows y Ubuntu (`.gitattributes`); si no, las huellas no
coincidirían entre equipos.
