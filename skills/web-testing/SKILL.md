---
name: web-testing
description: Comprobar una web local en navegador real — funcionamiento, móvil, accesibilidad básica y errores de consola — con el Playwright que ya tenga el proyecto.
license: Apache-2.0 (adaptación; términos completos en LICENSE.txt)
---

# Pruebas de navegador para webs de la Agencia

Adaptación del Centro de `webapp-testing` (anthropics/skills). Conserva su método —decidir el enfoque, reconocer la
página renderizada antes de actuar, esperar a que cargue— y lo ajusta a las reglas del Centro. Los cambios respecto al
original están en `skills/registry.json`.

## Antes de empezar

- Usa el Playwright que **ya** tenga el proyecto (`npx playwright --version`, o el script de pruebas de `package.json`).
  No instales paquetes ni navegadores y no uses red externa. Si no hay navegador automatizable, dilo como comprobación
  pendiente (`unverified`) con el motivo; no lo sustituyas por una lectura del código.
- Un comando simple por llamada. Arranca el servidor con el script del proyecto y, cuando termines, detén el proceso
  que arrancaste. Prueba solo contra `localhost` / `127.0.0.1`.
- Escribe guiones y capturas fuera del diff del candidato (carpeta temporal), salvo que el encargo pida añadir pruebas.

## Elegir el enfoque

1. **HTML estático**: lee el archivo para localizar selectores y ábrelo con `file://`.
2. **Web dinámica con servidor ya en marcha**: reconoce y luego actúa (abajo).
3. **Web dinámica sin servidor**: arráncalo con el script del proyecto, espera a que el puerto responda y continúa en 2.

## Reconocer y luego actuar

1. Navega y espera a que la página termine de cargar (`networkidle` o un elemento concreto) **antes** de inspeccionar.
2. Captura pantalla completa o inspecciona el DOM renderizado.
3. Elige selectores a partir de lo que ves: por rol y nombre accesible primero, después texto, y solo al final CSS.
4. Ejecuta las acciones y comprueba el resultado observable (texto, URL, estado), no solo que no hubo excepción.

Registra los mensajes de consola y las peticiones fallidas durante el recorrido: un error de consola en el flujo
principal es un hallazgo aunque la pantalla parezca correcta.

## Qué recorrer en cada web

- **Flujo principal** del encargo de principio a fin, y su caso de error más probable (campo vacío, dato inválido).
- **Móvil**: repite el flujo a 320 px y 390 px de ancho. Sin desplazamiento horizontal, sin texto cortado ni solapado,
  objetivos táctiles de al menos 44 px, menú y diálogos utilizables.
- **Escritorio**: 1440 px. Comprueba que el ancho de línea y la jerarquía siguen el diseño.
- **Teclado**: recorre el flujo solo con Tab, Mayús+Tab, Intro y Escape. El foco siempre visible, orden lógico, los
  diálogos atrapan el foco y lo devuelven al cerrar.
- **Accesibilidad básica**: cada control con nombre accesible, imágenes con texto alternativo pertinente, un solo `h1`
  y encabezados en orden, contraste suficiente en texto y controles, `prefers-reduced-motion` respetado. Si el proyecto
  incluye axe u otra herramienta, úsala y conserva su salida; si no, comprueba a mano y dilo así.
- **Estado al recargar**: lo que el usuario escribió o eligió no se pierde donde el diseño promete conservarlo.

## En la entrega

Para cada criterio: comando o pasos, anchura de pantalla, resultado observado y captura o salida que lo acredita.
Distingue un fallo reproducible del producto (`failed`, con pasos) de una comprobación que no pudiste hacer
(`unverified`, con el motivo).
