# Evaluación de integraciones

Fecha de consulta: **8 de noviembre de 2026**. Alcance: copia aislada; evaluación documental, sin instalar paquetes, configurar servicios ni enviar trazas. El `node` observado en terminal es **20.10.0**. Los lanzadores pueden escoger otro ejecutable portable: cualquier adopción futura debe comprobar la versión efectiva del proceso.

**Decisión: no añadir integraciones ahora.** Los eventos, artefactos e informes locales y la exportación de `metrics.mjs` permiten establecer una línea base de trabajos, intentos, estados, tiempos y cobertura de consumo. No se ha demostrado una insuficiencia que justifique otro servicio. Esto no demuestra una mejora de rendimiento ni ahorro de tokens.

## Agent Skills locales

**Problema que resuelven.** Procedimientos reutilizables y referencias que se cargan cuando hacen falta. El formato exige `SKILL.md` y permite scripts y recursos adicionales. La versión puede indicarse en los metadatos de cada skill; no hay que confundirla con una versión de Node. Leer Markdown no requiere un runtime Node concreto; los scripts adjuntos sí pueden tener requisitos propios. [Especificación oficial](https://agentskills.io/specification).

**Estado comprobado.** Ya existen `orca-cli`, `orchestration` y `orca-computer-use` bajo `%USERPROFILE%\.agents\skills`. Los dos primeros son entradas que remiten a la guía correspondiente al ejecutable Orca. No se ha identificado una versión independiente en sus cabeceras.

**Compatibilidad e integración.** Pueden orientar al agente anfitrión con Node 20.10.0, sujeto a los requisitos de sus comandos. No está demostrada su carga automática por los trabajadores: `orca-provider.mjs` lee perfiles `.codex/agents/*.toml`; `providers.mjs` desactiva apps/plugins y omite el descubrimiento de skills del anfitrión en su vía Codex directa. Instalar una skill no valida identidades, recuperaciones ni contratos de la cola. Tampoco transfiere sesiones, credenciales o herramientas de ChatGPT a Orca.

**Coste, datos y mantenimiento.** No se añade una suscripción por conservar esos archivos. Su contenido puede entrar en el contexto enviado al proveedor; scripts y comandos tienen sus propios efectos y costes. Mantener instrucciones acotadas y guías alineadas con la CLI. Complejidad baja mientras sean documentación; mayor si se crea un cargador. **Conservar lo instalado, sin conectar otro mecanismo.**

## MCP Inspector

**Problema que resuelve.** Inspecciona y prueba servidores MCP y sus intercambios; no observa por sí solo un pipeline que se comunica mediante la CLI de Orca. Puede conectar con servidores locales o remotos y llamar sus herramientas. [Documentación oficial](https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector).

**Versión y Node.** La versión **2.14.0** declara `^22.23.4 || ^24.22.1 || >=26.12.1`: **excluye Node 20.10.0**. La guía rápida menciona 22.19.0+, pero el paquete concreto es más restrictivo. Una prueba futura debe fijar versión y verificar su manifiesto; no cambiar el runtime del proyecto solo para incorporarlo. [Manifiesto de 2.14.0](https://github.com/modelcontextprotocol/inspector/blob/2.14.0/package.json).

**Coste, datos y mantenimiento.** Software abierto, con licencia en transición Apache-2.0/MIT; no requiere una suscripción al Inspector. Las llamadas al servidor objetivo pueden tener costes y efectos propios. Los argumentos/resultados llegan al servidor elegido; el uso de `npx` también descarga y ejecuta software. Añade dependencias y actualizaciones que mantener. [Licencia publicada](https://github.com/modelcontextprotocol/inspector/blob/2.14.0/LICENSE).

**Decisión.** No instalar ni ejecutar. Reconsiderar únicamente ante un servidor MCP concreto cuyo contrato o transporte necesite diagnóstico reproducible.

## Langfuse

**Problema que resuelve.** Centralizar trazas, consultas y evaluación de varias ejecuciones. Aquí exigiría instrumentar el coordinador y correlacionar trabajo, intento, etapa y dispatch. Instalarlo no revela automáticamente el consumo interno de un subproceso Orca ni recupera tokens que el proveedor no comunica; tampoco habilita herramientas o sesiones de ChatGPT.

**Versión y Node.** La matriz oficial identifica servidor **v4** y SDK JS/TS **v6**, que requiere **Node 22+** y Langfuse Cloud o servidor propio **4.59.0+**. El SDK actual **no es compatible con Node 20.10.0**. Una alternativa mediante OpenTelemetry o un SDK anterior necesitaría otra evaluación de compatibilidad y soporte. [Matriz oficial](https://langfuse.com/docs/compatibility).

**Coste.** Cloud Hobby: gratis, 50.000 unidades/mes, acceso a datos de 30 días y dos usuarios. Core: 29 USD/mes, 100.000 unidades incluidas, después 8 USD/100.000 en el primer tramo, acceso de 90 días. Las unidades son puntos de trazado/evaluación, no tokens del modelo. El alojamiento propio puede ser gratuito en licencia, pero requiere infraestructura y operación. Precios consultados en la fecha indicada. [Precios oficiales](https://langfuse.com/pricing).

**Datos y mantenimiento.** Exportaría la telemetría seleccionada al endpoint configurado. Una futura prueba debería limitarla inicialmente a identificadores, estados, tiempos y contadores, filtrando antes de enviar cualquier instrucción, respuesta o secreto. Langfuse ofrece enmascaramiento antes de la exportación. [Enmascaramiento](https://langfuse.com/docs/observability/features/masking). El alojamiento propio añade almacenamiento, copias de seguridad y actualizaciones; Docker Compose no proporciona por sí solo alta disponibilidad ni escalado. [Guía de despliegue](https://langfuse.com/self-hosting/deployment/docker-compose).

**Decisión.** No instalar, crear cuenta ni configurar exportación. Reconsiderar si mediciones reales muestran que consultar varios equipos, retener mucho más historial o investigar correlaciones supera las herramientas locales. Cualquier prueba deberá conservar la distinción entre consumo medido, desconocido y estimado; `null` no significa cero.
