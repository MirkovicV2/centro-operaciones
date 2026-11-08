# Desarrollo del perfil Godot — games

Objetivo: corregir el bloqueo de QA `task_5a00f43c54e5` (`ctx_0d16471942fc`). Criterio: antes de inspeccionar o cambiar contenido del checkout, exigir una comparación exacta entre la ruta real del checkout asignado y la branch ref activa frente a los valores confirmados en el job/panel; si cualquiera no se puede verificar o no coincide, detenerse sin inspeccionar ni editar e informar del desajuste. "Destino" incluye checkout y branch ref, no basta una confirmación textual. Esta es una preparación de perfil: no se inició ninguna migración.

## Cambios

- `.codex/agents/desarrollador_games.toml`: exige leer y comparar exactamente ruta real del checkout y branch ref activa con valores del job/panel antes de inspeccionar contenido; ante un valor no verificable o mismatch, exige parar sin leer/editar checkout y reportar el problema. Conserva confirmación, alcance y guardas previas.
- `README.md`: documenta que destino es checkout más branch ref y que el desarrollador debe parar y reportar ante imposibilidad de verificar o mismatch.
- `tests/games-profile.test.mjs`: añade regresiones específicas para comparación exacta y parada/report ante mismatch o valor no verificable; conserva las comprobaciones del criterio de scaffold y guardas previas.

Se conservan las protecciones: una migración solo se inicia si el job confirmado pide explícitamente migrar Flecha Trampa a Godot; el scaffold inicial requiere criterios UX verificables suficientes y decisiones imprescindibles resueltas, y sigue permitido aunque falte `project.godot`. Nunca se accede al juego original, se crean o cambian ramas o remotes, se descarga o instala Godot ni se ejecuta migración en esta tarea; no se cambian perfiles distintos al perfil indicado, routing, etapas ni `autoRun`.

## Verificaciones

- `node --test tests/games-profile.test.mjs`: **exit 0, 4/4 pruebas aprobadas**, incluida la regresión de comparación exacta de ruta/branch ref y parada con reporte ante mismatch o valor no verificable.
- `node --check tests/games-profile.test.mjs`: **exit 0**.
- `git diff --check`: **exit 0**, sin errores de whitespace. Git mostró su aviso CRLF/LF para `queue.mjs`, que ya tenía cambios locales y queda fuera del alcance.

## Límites

No se inspeccionó ningún checkout de juego ni el original, no se ejecutó ningún trabajo real y no se usaron red, GitHub ni Actions. No se instaló ni ejecutó Godot; este resultado solo verifica las instrucciones y regresiones del perfil, no un proyecto ni el motor. QA posterior y Revisión independiente siguen pendientes del coordinador.

## Corrección de la revisión task_18e57a29f648 / dispatch ctx_2ed7ae222dcb

La ruta confirmada por job/panel debe ser absoluta y canónica: comprobar `path.isAbsolute` y que `path.normalize(rutaConfirmada) === rutaConfirmada`. Consultar la ruta real local con `realpath`, normalizarla con `path.normalize` y exigir igualdad exacta con la ruta absoluta confirmada. Consultar la branch ref actual con Git y exigir igualdad exacta con la confirmada. Si la ruta confirmada no es absoluta/canónica, no se puede leer/verificar ruta o branch ref, o hay una diferencia, parar antes de inspeccionar contenido y reportar. La regresión comprueba explícitamente absolutitud, canonicalidad, comparación de ruta y branch ref, y la parada; no depende de una frase genérica.

Se conservan los límites de migración: una mención breve/genérica a Godot no autoriza migrar. Solo un job confirmado que pida explícitamente migrar y cuente con criterio UX verificable suficiente permite un scaffold inicial mínimo, incluso si falta `project.godot`, y las decisiones UX imprescindibles deben estar resueltas. No se migra ahora ni se toca el juego original o workspaces de juego; no se crean/cambian ramas o remotes, no se descarga/instala Godot ni se modifica routing, etapas, perfiles o `autoRun`.

### Verificaciones exactas

- `node --test tests/games-profile.test.mjs` — **exit 0**, 4 pruebas aprobadas, 0 fallidas.
- `node --check tests/games-profile.test.mjs` — **exit 0**.
- `git diff --check` — **exit 0**; Git emitió el aviso CRLF/LF para `queue.mjs`, archivo con cambios locales ajenos a esta corrección.

No se crearon ni ejecutaron jobs reales y no se usaron red, GitHub ni Actions.

## Corrección de QA: ejecutar la guarda local

La revisión anterior comprobaba sobre todo que el perfil mencionara las reglas. Para hacerlas ejecutables, `games-checkout-guard.mjs` aporta `checkGamesCheckoutGuard` y la decisión pura `evaluateGamesCheckoutGuard`. El perfil Games debe llamar al helper disponible en el entorno del centro antes de inspeccionar contenido, por ejemplo `node games-checkout-guard.mjs "<ruta-absoluta-confirmada>" "<branch-ref-confirmada>"`; si no puede acceder o ejecutarlo, debe parar y pedir validación por el panel sin leer el juego.

La guarda rechaza ruta confirmada vacía, relativa o no normalizada, observación local `realpath` no verificable, discrepancia de ruta canónica, rama confirmada vacía/desconocida, branch ref activa desconocida y rama distinta. Su colector usa `realpath` y `git symbolic-ref --quiet --short HEAD`, ambos de solo lectura; si la ruta no coincide, no consulta Git. Las pruebas usan un directorio temporal para la coincidencia y dependencias simuladas para los escenarios de parada, mismatch de ruta y mismatch de rama.

La función pura valida solo los datos que recibe; el comando ejecutable obtiene las observaciones locales antes de pasárselas. Esta comprobación de ruta y rama no ejecuta Godot ni equivale a validar un proyecto Godot.

Reglas conservadas para esta corrección: no migrar ahora; solo un job confirmado que pida explícitamente migrar puede iniciar un scaffold si el criterio UX es suficiente y las decisiones imprescindibles están resueltas, aunque falte `project.godot`. No se toca el juego original ni workspaces de juego, no se crean/cambian ramas o remotes, no se instala Godot y no se cambian routing, etapas, perfiles o `autoRun`.
