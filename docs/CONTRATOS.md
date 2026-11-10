# Contratos de rol (global, empresa y proyecto)

Instrucciones opcionales que especializan el perfil de cada etapa sin tocar el código del Centro. Viven en el `data/` de cada instalación, nunca en el checkout que editan los agentes:

```
data/contracts/global/<etapa>.md               todos los proyectos
data/contracts/empresa-<empresa>/<etapa>.md    una empresa (agency, games)
data/contracts/proyecto-<id del proyecto>/<etapa>.md   un proyecto
```

Etapas: `planner`, `ux`, `developer`, `qa`, `reviewer`. Cada capa es opcional y se añade al encargo del trabajador en ese orden (la más específica concreta a la anterior), con su ruta y su SHA-256 para saber qué se le dio. Si no hay ningún archivo, el encargo no cambia.

Un contrato especializa el rol (qué revisar, qué estilo seguir, qué skill aplicar). No puede cambiar permisos, publicación, el contrato de entrega ni las reglas de la asignación: el encargo se lo recuerda al agente y las reglas del Centro van después. Límite: 16 000 bytes por archivo; un enlace simbólico o un archivo mayor bloquea la etapa con `project_contract_invalid` y un mensaje que dice qué arreglar.

Las skills se escriben igual: dentro del contrato de la etapa a la que sirven.
