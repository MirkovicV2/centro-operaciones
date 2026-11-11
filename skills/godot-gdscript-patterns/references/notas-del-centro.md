# Notas del Centro sobre godot-gdscript-patterns

Añadido local. Los demás archivos de esta skill son los originales, sin cambios.

- **Versión del motor.** Los ejemplos son de Godot 4.x. Contrasta cada API con la versión instalada y acreditada del
  proyecto antes de aplicarla; no actualices el motor para que un ejemplo encaje.
- **Guardado (patrón 7).** El ejemplo cifra con una clave escrita en el código (`ENCRYPTION_KEY`). No la copies: una
  clave dentro del binario no protege nada y fija un formato. Usa el formato y la ruta de guardado que ya tenga el
  proyecto. Cambiar formato, ruta o cifrado de un guardado existente es una decisión de datos: consúltala al coordinador
  y conserva la compatibilidad con los guardados anteriores salvo decisión expresa. No borres guardados de prueba ajenos.
- **Autoloads y bus de eventos.** Úsalos solo si el proyecto ya los usa o el encargo lo pide; no reorganices la
  arquitectura para adoptar un patrón.
- **Rendimiento.** Mide antes de aplicar pooling u otras optimizaciones; en Android registra dispositivo y método.
- **Alcance.** Estos patrones son ejemplos de oficio. El encargo, sus criterios y la skill `game-production` deciden qué
  se construye.
