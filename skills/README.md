# Skills del Centro

Guías de oficio que el Centro entrega a los trabajadores de Codex y Claude según empresa, etapa y encargo.
Son neutrales respecto al proveedor: el motor copia las seleccionadas junto al encargo de cada asignación, donde
ambos pueden leerlas, y registra qué se suministró.

- `registry.json` es la fuente de verdad: origen, revisión, licencia, cambios locales, a qué aplica cada skill y la
  huella SHA-256 de cada archivo.
- Una skill cuyo contenido no coincide con su huella **no se entrega**. Si es obligatoria, la etapa se detiene antes de
  lanzar el trabajador; si es opcional, se omite y queda anotado en la etapa.
- Tras revisar un cambio: `node cli.mjs skills-accept --id <skill>`. Para ver el estado: `node cli.mjs skills`.

Detalle en `docs/SKILLS.md`.
