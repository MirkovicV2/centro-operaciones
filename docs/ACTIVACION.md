# Evolución del Centro: integración y activación

## Qué cambia sin tocar nada

Nada. Todo lo nuevo es opcional y local a cada instalación. Sin estos archivos el Centro lanza como antes:

| Archivo local | Activa | Ejemplo |
| --- | --- | --- |
| `data/pipeline.json` | Reparto por etapa (perfil mixto) | `ejemplos/pipeline.mixto.example.json` |
| `data/quota.json` | Reserva personal y política de cuota | `ejemplos/quota.example.json` |
| `data/equipo.json` | Identidad del PC, recursos, concurrencia y reserva de ramas | `ejemplos/equipo.example.json` |
| `data/skills.json` | Ajustes de skills por proyecto | `ejemplos/skills.example.json` |

Los trabajos existentes y los archivos actuales siguen valiendo: los identificadores de roles y etapas no cambian, y
un trabajo sin los campos nuevos se comporta exactamente como antes. No hay migración que ejecutar.

Lo único que cambia para todos al integrar:

- el encargo de cada etapa se organiza en ocho secciones (mismo contenido, `docs/CONTRATOS.md`);
- el encargo de Codex incluye una línea con la orden para verificar la huella en su shell;
- las skills pasan por el catálogo con huella (`docs/SKILLS.md`); `game-production` se entrega igual que antes;
- el arranque del panel en Windows espera hasta 30 s.

## Orden de integración

Cada PR se apoya en el anterior:

1. `david/pipeline-mixto` — reparto por etapa y resolución única.
2. `david/pipeline-panel` — Ajustes, vista previa y elección por encargo en el panel.
3. `david/rutas-adaptadas` — rutas con motivo por etapa omitida.
4. `david/skills-registradas` — catálogo de skills.
5. `david/contratos-unificados` — contrato de ocho secciones y adaptación Codex/Claude.
6. `david/cuota-y-fallos` — cuota, sustitución y tipos de parada.
7. `david/equipos-y-reservas` — equipos, recursos y reserva de ramas.
8. `david/memoria-de-proyecto` — memoria compartida.
9. `david/pilotos-y-activacion` — métricas del reparto, pilotos y este documento.

## Actualizar una instalación

Windows (PowerShell) y Ubuntu, en la carpeta del Centro:

```
git pull
npm test
```

`npm test` debe pasar entero antes de abrir el panel. Si falla la prueba de skills («every registered skill is intact»),
el checkout cambió los finales de línea: `git add --renormalize .` y vuelve a comprobar con `node cli.mjs skills`.

Después abre el panel como siempre (`ABRIR_PANEL.cmd` en Windows, `npm start` en Ubuntu).

## Activar el perfil mixto en un PC

La instalación de Dani está en pausa para reservar cuota. Integrar estos PRs no la reanuda: la autoejecución sigue
siendo un interruptor por empresa que solo cambia quien lo pulsa.

1. **Modelos.** Comprueba en Orca, con las dos cuentas de ese PC, que existen los modelos y esfuerzos del ejemplo.
   El Centro valida la forma del archivo, no la oferta del proveedor.
2. **Cuota.** Ajustes → Cuota y suscripciones: declara la autenticación de cada proveedor, anota el uso observado y
   guarda. Deja la reserva en el 10 % o más.
3. **Equipo.** Copia `ejemplos/equipo.example.json` a `data/equipo.json` con el id de ese PC y corrige sus recursos en
   `equipos/equipos.json`. Deja `reservas.activas` en `false` hasta el paso 6.
4. **Reparto.** Ajustes → Agentes y modelos por etapa → «Cargar perfil mixto de ejemplo» → revisa → «Guardar reparto».
5. **Vista previa.** `node cli.mjs preview --business agency --kind code` y `--business games`. Debe mostrar Claude en
   Diseño y Desarrollo y Codex en QA y Revisión.
6. **Reserva de ramas** (cuando los dos PCs estén listos): `reservas.activas: true` en ambos, tras comprobar con un
   proyecto de prueba que GitHub acepta la ref `refs/centro/claims/…`.
7. **Piloto.** Con la autorización de `docs/PILOTOS.md`, activa la autoejecución de una empresa y lanza un piloto.

Volver atrás: Ajustes → «Volver al agente único», o borrar el archivo local correspondiente.

## Recuperación

| Situación | Dónde |
| --- | --- |
| Un encargo se detiene | Su página dice el tipo de parada y el siguiente paso (`docs/CUOTA.md`, «Tipos de parada»). |
| Reintento con otro proveedor | `docs/CUOTA.md`, «Sustituir el proveedor». |
| Skill ausente o modificada | `docs/SKILLS.md`. |
| Rama reservada por el otro PC o reserva abandonada | `docs/EQUIPOS.md`. |
| Dispatch incierto, integración a medias, Workflow V2 | Sin cambios: `docs/COORDINATOR_OPERATIONS.md`, `GITHUB_INTEGRATION.md`, `docs/WORKFLOW_V2.md`. |

## Comprobado y pendiente

Comprobado con Orca simulado (`npm test`) y con el panel en navegador:

- entrada por CLI y por Nuevo trabajo con reparto por encargo; Ideas usa el reparto configurado;
- Claude en Diseño y Desarrollo y Codex en QA y Revisión en las dos empresas;
- rutas adaptadas y etapa añadida por cambio de alcance;
- precedencia, compatibilidad y separación de modelos entre proveedores;
- retry tras cambiar la configuración; lanzamiento incierto; proveedor indisponible; cuota en reserva y agotada;
- sustitución de proveedor sin duplicar trabajadores;
- skills ausentes o modificadas; contexto vigente, descartado y sustituido; exclusividad entre dos clones;
- panel a 320 px y 1440 px con conservación de valores, foco y desplegables al refrescar.

Pendiente, porque necesita vuestros equipos o cuentas:

- ejecuciones con agentes reales: hay un primer piloto en Ubuntu, solo con Claude (docs/PILOTOS.md); falta Codex, Diseño y Videojuegos;
- que los modelos y esfuerzos del ejemplo existan en vuestras cuentas;
- Windows: no se ha ejecutado nada allí. En concreto, que Git Bash de Claude incluye `sha256sum` y que el arranque
  del panel con la espera de 30 s se comporta como el ajuste local de Dani;
- GitHub: que acepta las refs de reserva y que no chocan con la protección de ramas;
- las dos suites de accesibilidad del panel (`dashboard-accessibility`, `dashboard-github-integration`) no se pudieron
  ejecutar aquí por faltar `axe-core`; ejecútalas en un PC que lo tenga;
- los recursos reales de cada PC en `equipos/equipos.json`;
- el modelo de las sesiones de coordinador (clasificación, memoria y coordinación), que se elige al abrir la sesión
  en Orca y no desde el Centro;
- registrar la versión concreta del modelo cuando se usa un alias (`sonnet`): falta ver si Orca la expone;
- exigir al coordinador un diagnóstico y una hipótesis nueva para continuar tras rondas sin progreso: hoy el motor ya
  detiene las correcciones automáticas cuando fallan los mismos criterios dos veces o tras cinco rondas, pero no pide
  ese diagnóstico de forma estructurada;
- añadir Diseño a un encargo cuando Desarrollo ya tiene asignación; sustitución de proveedor desde el panel para
  encargos con recibo de autoejecución pendiente; elección de reparto por encargo desde Ideas.
