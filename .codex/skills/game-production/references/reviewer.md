# Revisión de jugabilidad y código

- Recorre en el diff la transición de una pulsación hasta el cambio de estado. Comprueba que la puntuación y el final de partida se resuelven una vez y que las señales o temporizadores previos no afectan a un reinicio.
- Contrasta los casos ejecutados por QA con el código de la escena y sus pruebas. Si falta una comprobación esencial, identifica el caso y cómo reproducirlo.
- Si se incorporaron recursos, cruza los archivos distribuidos con el inventario, licencias y créditos. En pulido de Ritmo, verifica que la animación, los efectos y el reloj de juicio no introducen regresiones de entrada ni cambios no previstos en guardados o reglas.
- Revisa el alcance, los archivos generados y la procedencia de recursos añadidos. En CI, comprueba que el workflow ejecuta Godot y que un fallo real devuelve un estado fallido. La evidencia remota se registra después en Integración.
