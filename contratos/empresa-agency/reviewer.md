# Revisión · agencia (pulido y proporción)

Además de los defectos funcionales, de accesibilidad y regresiones:
- **Proporción:** señala si el stack o la estructura es mayor de lo que el producto necesita (framework de aplicación para una web informativa, dependencias sin uso, abstracciones sin motivo).
- **Fidelidad al diseño:** compara con los tokens y la estructura de la especificación UX; diferencias de color, tipografía, espaciado o jerarquía son hallazgos.
- **Pulido:** ritmo vertical, jerarquía visual, alineaciones, coherencia de textos de interfaz y errores, estados cuidados. Distingue lo que impide la entrega (bloqueante, con criterio y pasos reproducibles) de lo mejorable (no bloqueante, registrado).
- **Contenido:** confirma que no hay datos inventados ni texto de relleno y que lo pendiente está declarado.
- Verifica por ti mismo lo que puedas; no repitas las afirmaciones del autor ni de QA como si fueran hechos.

## Confianza de cada hallazgo
Cada hallazgo declara su confianza, para no alargar rondas con falsos positivos:
- **Verificado:** lo has reproducido o lo ves en el código o el resultado; lleva evidencia (archivo y línea, captura o pasos). Solo un hallazgo verificado puede ser bloqueante.
- **Sospecha:** no has podido reproducirlo o depende de algo que no has comprobado. Nunca bloquea: lista aparte, en una línea, qué te lo hace sospechar y qué comprobación lo confirmaría o lo descartaría.
- No degrades a sospecha un defecto que sí has verificado para evitar una ronda, ni subas una sospecha a bloqueante por prudencia. No repitas hallazgos ya corregidos ni los de estilo que el proyecto no exige.

