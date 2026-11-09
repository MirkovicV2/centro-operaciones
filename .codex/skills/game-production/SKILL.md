---
name: game-production
description: Diseñar, implementar y verificar partidas jugables en la rama de Videojuegos del Centro de Operaciones. Cubre controles, ritmo, feedback y pruebas en el motor asignado.
---

# Producción de videojuegos

Usa el alcance y los criterios del encargo como fuente de verdad. Identifica primero la escena y la versión del motor acreditadas. Un checkout híbrido puede incluir otra versión del juego. Conserva las reglas y datos que el encargo no modifica.

Aplica la referencia de tu perfil.

- Diseño de videojuegos: [diseño de partida](references/ux.md).
- Desarrollo: [implementación Godot](references/developer.md).
- QA: [verificación en el motor](references/qa.md).
- Revisión: [revisión de jugabilidad y código](references/reviewer.md).

## Referencias de producción

Elige solo las referencias pertinentes al encargo. La primera fuente de decisiones sigue siendo la versión jugable del proyecto y el feedback del usuario. Indica qué decisión aporta cada referencia consultada.

- Presentación móvil y progresión. [Candy Crush Saga de King](https://play.google.com/store/apps/details?id=com.king.candycrushsaga) sirve para estudiar jerarquía, lectura del progreso y celebraciones. Diseña arte, pantallas, sonidos y mecánicas propios del proyecto.
- Ritmo. [StepMania Player.cpp](https://github.com/stepmania/stepmania/blob/5_1-new/src/Player.cpp) sirve para estudiar ventanas de juicio, feedback y combos. [gd-rhythm](https://github.com/scenent/gd-rhythm) es un ejemplo pequeño de Godot 4 con velocidad de notas, juicio y combo. Consúltalos como código de referencia. Sus canciones y recursos incluidos requieren comprobación independiente.
- Godot. [Sincronización con audio](https://docs.godotengine.org/en/stable/tutorials/audio/sync_with_audio.html), [gestos táctiles](https://docs.godotengine.org/en/stable/classes/class_inputeventscreendrag.html) y [demos oficiales MIT](https://github.com/godotengine/godot-demo-projects), incluida la de [partículas 2D](https://store.godotengine.org/asset/godot-foundation/particles-2d-demo/). Contrasta la API con la versión instalada antes de aplicarla.
- Recursos. Busca primero en la [tienda oficial de Godot](https://store.godotengine.org/) y en la [biblioteca oficial](https://docs.godotengine.org/en/stable/community/asset_library/what_is_assetlib.html). [Kenney UI Audio](https://kenney.nl/assets/ui-audio) ofrece efectos de interfaz CC0. Para una pista electrónica, [EDM Detection Mode de Kevin MacLeod](https://incompetech.com/music/royalty-free/index.html?Search=Search&isrc=USUAN1500026) es una candidata CC BY 4.0. Evalúa su encaje con la carta rítmica y conserva el crédito si se usa. La selección también puede ser original.

Si el encargo autoriza incorporar recursos gratuitos, valida antes el archivo concreto y su permiso de redistribución y adaptación comercial. Registra archivo, autor, URL, versión o revisión, licencia, crédito y cambios en un inventario junto a la entrega. Conserva los avisos exigidos. Descarta música y recursos de procedencia o licencia dudosa. Usa solo los archivos necesarios y evita ejecutar scripts o instalar complementos de las referencias sin autorización del encargo.
