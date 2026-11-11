# Memoria de proyecto

Hay tres fuentes de contexto, y cada una dice qué es:

| Fuente | Dónde vive | Qué aporta |
| --- | --- | --- |
| Estado del proyecto (`projectState`) | La cola de esta instalación | Última integración verificada, candidato en curso y sus etapas. |
| Notas de Obsidian (`sources`) | La bóveda local de cada persona | Extractos con ruta, líneas y huella. `docs/OBSIDIAN.md`. |
| **Memoria compartida** (`sharedMemory`) | `memoria/<empresa>/<proyecto>.json`, en el repositorio del Centro | Lo que el equipo ha aceptado, con su estado. |

La memoria compartida es la que llega a los dos PCs y la que sigue disponible cuando Obsidian no se puede leer.

## Estados

Cada entrada tiene un tipo y un estado. Ninguna entrada puede pasar por vigente sin serlo:

| Tipo | Estados | |
| --- | --- | --- |
| `decision` | `vigente`, `sustituida` | Una sustituida nombra la decisión que la reemplazó, y esta la nombra a ella. |
| `contexto` | `vigente` | Hechos aceptados del producto. |
| `candidato` | `en_evaluacion`, `descartado` | Un descartado conserva su estado y su motivo para siempre. |
| `leccion` | `validada` | Problema, causa, solución, evidencia y cuándo se aplica. |

Toda entrada lleva `referencia` (qué versión del proyecto sirve de referencia) y `procedencia` (quién la originó).

## Qué recibe un trabajador

Al consultar el contexto de su encargo recibe `sharedMemory` con:

- `vigente`: decisiones y contexto vigentes y lecciones validadas.
- `enEvaluacion`: candidatos aún sin decidir, marcados como tales.
- `versionDeReferencia`: la última integración verificada del proyecto (`mergeSha`, rama y fecha), o `null` si no hay ninguna.
- `historialOmitido`: cuántas entradas sustituidas o descartadas existen. Solo llegan, en `historial` y con su estado,
  si la consulta pide `includeHistory: true`.
- `sha256` de las entradas, para saber qué memoria se entregó.

El resultado está acotado: si no cabe, se recorta primero el historial, después lo que está en evaluación, y lo vigente
se conserva.

### Flecha Trampa

`memoria/games/flecha-trampa.json` recoge como decisión vigente el **ritmo rápido tipo StepMania**, y el antiguo
planteamiento **match-3** como decisión sustituida por ella. Un trabajador recibe la primera siempre y la segunda solo
si pide antecedentes.

Pendiente del equipo: anotar hasta qué versión estuvo vigente el match-3 y completar el texto de ambas decisiones.

## Lecciones

Cualquiera puede proponer una lección, también un modelo. Proponer no tiene ningún efecto en los encargos:

```
node cli.mjs memory-propose --business games --title "Flecha Trampa" --evidence-file leccion.json
```

```json
{ "id": "audio-pausa", "titulo": "El audio se desincroniza al pausar", "fecha": "2026-11-11",
  "referencia": { "descripcion": "Versión con el reloj de audio", "commit": "abc1234" },
  "problema": "…", "causa": "…", "solucion": "…", "aplicaCuando": "…",
  "procedencia": { "origen": "agente", "detalle": "Propuesta por Desarrollo", "jobId": "ID_DEL_ENCARGO", "etapa": "developer" },
  "evidencia": [ { "tipo": "informe", "jobId": "ID_DEL_ENCARGO", "etapa": "qa" }, { "tipo": "commit", "sha": "abc1234" }, { "tipo": "archivo", "ruta": "scripts/audio.gd" } ] }
```

La propuesta queda en `data/memory-proposals/` (local). Para incorporarla:

```
node cli.mjs memory-accept --business games --title "Flecha Trampa" --id audio-pausa --confirm-reviewed
```

Antes de escribir nada se comprueba:

- **Procedencia.** Si viene de un agente o del coordinador, el encargo que nombra existe en este proyecto.
- **Cada referencia.** Un `informe` existe en disco y su huella coincide con la registrada por la etapa; un `commit`
  existe en el checkout del proyecto; un `archivo` existe y, si se indicó huella, coincide.
- Una `nota` sin referencia solo vale como evidencia cuando la aporta el usuario.

Si algo no se sostiene, la lección no se incorpora y la propuesta sigue en local. Si todo se sostiene, se escribe en
`memoria/` con las huellas y la fecha de verificación, y se comparte con un commit normal del repositorio del Centro.

## Qué no va aquí

`memoria/` se comparte por el repositorio. No se guardan secretos (una entrada con forma de clave o token se rechaza),
credenciales, rutas personales ni estado operativo: eso sigue en el `data/` de cada instalación.

## Límites

- Un proyecto se localiza por su nombre (o un `alias`), porque su identificador es distinto en cada PC. Los dos PCs
  deben llamar igual al proyecto.
- Aceptar una lección la escribe en el árbol de trabajo del Centro; compartirla requiere el commit y el PR habituales.
- Decisiones, contexto y candidatos se editan en el archivo y pasan por revisión de PR; solo las lecciones tienen
  flujo de propuesta y verificación automática.
