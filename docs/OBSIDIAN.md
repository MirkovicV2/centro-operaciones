# Obsidian en el Centro de Operaciones

1. Instala [Obsidian](https://obsidian.md/help/install) y crea o abre una bóveda local. Para la prueba, usa una carpeta separada, por ejemplo `/home/tu-usuario/Obsidian/CentroPruebas`.
2. En el panel abre **Conocimiento → Obsidian**, pega la ruta absoluta a la **raíz** de esa bóveda y guarda.
3. Dentro de la bóveda, crea una nota de contexto en la carpeta de la empresa. Usa `Centro de Operaciones/Contexto/Agencia/` para `agency` o `Centro de Operaciones/Contexto/Videojuegos/` para `games`. Guarda las notas Markdown directamente en la carpeta indicada.

Para probar el buscador, guarda este ejemplo como `proyecto-prueba-colores.md` en `Contexto/Agencia/`.

```markdown
---
tipo: "guia-operativa"
empresa: "agency"
---

# Colores del Proyecto de prueba

El color principal del Proyecto de prueba es azul petróleo.
```

Sin `proyecto_id`, la nota queda disponible para los proyectos de esa empresa. Para limitarla a un proyecto, añade `proyecto_id: "ID_REAL"` en la cabecera. Puedes obtener el identificador en `GET /api/state`, dentro de `projects`. Usa `tipo: "decisiones-proyecto"` para decisiones de producto vigentes con proyecto asignado. Las fichas `proyecto-vigente-*.md` las genera el panel.

Desde **Preguntar al coordinador** consulta el color. En **Peticiones → Ver recorrido, decisiones y contexto** comprueba si la nota aparece entre las fuentes entregadas y si el coordinador la citó. El panel entrega extractos de la empresa y del proyecto correspondiente, con ruta, líneas y hash. Para pedir antecedentes, el agente usa `includeHistory: true` con una consulta nueva.

La ficha del proyecto distingue la última integración verificada del candidato activo y sus etapas. Los resultados y las respuestas guardadas se archivan como notas operativas. Cuando resuelvas un incidente, guarda en Contexto el síntoma, la causa comprobada, la recuperación y la evidencia. Una decisión que cambie el producto va en la nota de decisiones del proyecto. Un ensayo descartado va en el historial o en una nota de diagnóstico fechada.

Para colaborar, compartid solo las notas de equipo que acordéis. Cada uno conecta su propia copia local en el panel. Las credenciales, los recibos de consultas y la cola se guardan en cada instalación.
