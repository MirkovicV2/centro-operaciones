# Equipos: dos PCs sobre los mismos proyectos

Cada persona ejecuta su Centro y su Orca en su PC, con sus cuentas, su cola y sus checkouts. Lo que comparten es el
repositorio del Centro (contratos, skills, este catálogo de equipos) y los repositorios de los proyectos.

## Quién es cada PC

- `equipos/equipos.json` — compartido y versionado: los PCs del equipo, su sistema y sus recursos. Sin secretos.
- `data/equipo.json` — local: cuál de ellos es esta instalación. Ver `ejemplos/equipo.example.json`.

```json
{ "version": 1, "id": "david-ubuntu", "concurrencia": 1, "reservas": { "activas": true, "caducidadMinutos": 30, "remoto": "origin" } }
```

Sin `data/equipo.json` la instalación funciona como antes: no comprueba recursos ni reserva ramas, y anota en sus
encargos un equipo provisional con el nombre del host.

Cada encargo queda con su **equipo responsable** al empezar, y cada etapa lo registra. Un encargo anotado para otro PC
no se ejecuta en este.

## Recursos

Recursos declarables: `godot`, `emuladorAndroid`, `telefonoFisico`, `gpu`, `navegador`.

- Un encargo de código de Videojuegos necesita siempre `godot`.
- Otros se declaran al admitir: `node cli.mjs add … --requires emuladorAndroid,telefonoFisico`.
- Si a este PC le falta alguno, el encargo queda en espera «Falta un recurso en este PC» y dice qué equipo lo tiene.
  No se intenta la comprobación en un PC que no puede hacerla.

**Pendiente de confirmar:** los recursos de `equipos/equipos.json` son una primera propuesta. Corrige los de tu PC.

## Un trabajo a la vez

`concurrencia` es 1 por defecto: mientras un trabajo está en marcha en este PC, los demás esperan «En cola de este PC».
Se puede subir hasta 4. Dos trabajos nunca comparten checkout (eso ya lo impedía la cola) ni rama reservada.

## Reserva de ramas

Con `reservas.activas`, antes de empezar o reanudar un encargo de código, y antes de lanzar cada trabajador, este PC
reserva la rama del proyecto **en el remoto del proyecto**: una ref `refs/centro/claims/<rama>` que apunta a un commit
pequeño cuyo mensaje dice quién la tiene, para qué encargo y hasta cuándo.

Cada cambio es un *compare-and-swap* que hace el servidor de Git (`git push --force-with-lease` con el valor exacto
esperado), así que dos PCs que piden a la vez no pueden ganar los dos.

| Situación | Qué ocurre |
| --- | --- |
| La rama está libre | Este PC la reserva y trabaja. |
| La tiene el otro PC | El encargo espera «Reservado por otro equipo», con su nombre, su encargo y la hora de caducidad. No consume intento. |
| Reinicio de este PC | Al volver, el remoto dice que la reserva sigue siendo suya (mismo equipo y encargo): la renueva y continúa. No hay estado local que perder. |
| Sin conexión | No se puede reservar ni renovar: el encargo espera. Sin reserva confirmada no se despacha. |
| Reserva abandonada | Si no se renueva, caduca (`caducidadMinutos`). El otro PC la toma de forma atómica y queda anotado de quién la tomó. |
| Este PC vuelve tras perderla | Antes de lanzar el siguiente trabajador ve que la rama es de otro: se detiene con `claim_lost`. No pone un segundo trabajador sobre la rama. |
| El encargo termina e integra | Libera la rama. Solo borra la reserva si sigue siendo suya. |
| Existe una ref con ese nombre que no es una reserva del Centro | No se sobrescribe; el encargo espera con el aviso. |

Requisitos: `git` con permiso de escritura en el remoto del proyecto (el mismo que ya usa la integración).

### Límites verificados

- Probado contra un remoto Git local con dos clones, incluida la carrera de dos peticiones simultáneas. **No probado
  contra GitHub**: falta comprobar que acepta refs bajo `refs/centro/` en vuestros repositorios y que las reglas de
  protección de ramas no las afectan.
- La caducidad compara la hora del PC que reservó con la del que consulta: un desfase de reloj de minutos adelanta o
  retrasa la toma de una reserva abandonada. Por eso el mínimo es 5 minutos y el valor por defecto 30.
- Un trabajador que ya está en marcha no se interrumpe al perder la reserva; se comprueba antes de lanzar el siguiente.
- Un encargo detenido en «Requiere revisión» no renueva: su reserva caduca y el otro PC puede tomar la rama. El trabajo
  parcial queda en el checkout del primer PC.
- Las colas no se sincronizan entre PCs: un encargo se ejecuta en el PC donde se admitió.
