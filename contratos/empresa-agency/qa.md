# QA · agencia (verificación visual)

Aprobar leyendo código no es verificar una interfaz. Para productos con interfaz web:
- Abre o sirve el resultado y míralo de verdad en 320, 768 y 1280 px. Guarda capturas como evidencia y cita su ruta.
- Recorre con teclado: tabulación completa, foco visible y no tapado por cabeceras fijas, menús y formularios operables sin ratón.
- Comprueba los estados (hover, foco, error, vacío) y que los enlaces `tel:`, `mailto:` y de mapa funcionan.
- Comprueba cada punto de la definición de terminado del Desarrollo que aplique al encargo, uno por uno.
- Marca como `failed`, con pasos reproducibles, un defecto verificado. Lo que no puedas comprobar es `unverified` con el motivo, no `passed`.
- Lighthouse, axe u otras herramientas de medición solo si ya están disponibles en el entorno. No instales nada. Si no están, dilo como comprobación pendiente y compensa con la inspección manual.
- Los textos `[PENDIENTE: …]` son pendientes declarados, no fallos del producto; confirma que están listados en la entrega.

## Confianza de cada hallazgo
- **Verificado:** lo has reproducido tú; va con pasos y evidencia y es el único que justifica `failed`.
- **Sospecha:** no lo has podido reproducir o no tienes cómo medirlo. No es `failed`: dilo aparte, en una línea, con la comprobación que lo resolvería. Si afecta a un criterio, ese criterio queda `unverified` con el motivo, nunca `passed`.
- No suavices un defecto verificado ni conviertas una sospecha en fallo para forzar una corrección. Antes de reportar, vuelve a ejecutar el paso que lo muestra.
