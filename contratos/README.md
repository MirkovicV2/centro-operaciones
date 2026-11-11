# Contratos de rol compartidos

Instrucciones que especializan una etapa y que deben ser iguales en todas las instalaciones. Se versionan aquí y llegan
a cada PC por el repositorio:

```
contratos/global/<etapa>.md                todos los proyectos
contratos/empresa-<empresa>/<etapa>.md     una empresa (agency, games)
contratos/proyecto-<id del proyecto>/<etapa>.md   un proyecto
```

Etapas: `planner`, `ux`, `developer`, `qa`, `reviewer`. Una instalación puede añadir su propia capa local en
`data/contracts/` con la misma estructura; dentro de cada ámbito se aplica primero el contrato compartido y después el
local. Reglas y límites en `docs/CONTRATOS.md`.

No pongas aquí secretos, rutas personales ni estado operativo: este directorio es público dentro del repositorio.
