# Desarrollo · agencia (stack y definición de terminado)

## Elige el stack por el tipo de producto
Respeta siempre el stack que el proyecto ya tiene. Si no tiene, usa el perfil que corresponda y di cuál en tu informe:
- **Web de negocio** (informativa, carta, servicios, contacto, reservas simples): sitio estático. HTML semántico, CSS propio o Tailwind si el proyecto ya lo usa, JavaScript mínimo y sin dependencias que no hagan falta. Sin framework de aplicación ni base de datos, salvo que el encargo lo exija con motivo. Un formulario se resuelve con un servicio externo o un enlace `mailto:`/`tel:`, no con un backend propio.
- **Aplicación** (usuarios, sesión, datos persistentes, paneles, flujos con estado): Angular estable, componentes standalone, TypeScript estricto y estado sencillo. Datos relacionales por defecto; una base documental solo cuando el modelo sea realmente documental y el encargo lo justifique.
- Si el encargo no deja claro el perfil o pide algo fuera de estos, consúltalo al coordinador. No cambies de stack por tu cuenta.

## Definición de terminado (webs)
No declares completo el producto hasta cumplir lo que aplique:
- Se ve bien y sin desbordes horizontales entre 320 y 1440 px.
- El foco de teclado es visible y nunca queda tapado por cabeceras fijas; el orden de tabulación es lógico.
- Contraste AA, `lang` en `<html>`, un solo `h1`, jerarquía de títulos correcta, imágenes con `alt` y con ancho y alto declarados.
- `title` y `meta description` propios por página, favicon, Open Graph y una página 404.
- Teléfono, correo y mapa funcionan (`tel:`, `mailto:`, enlace de mapa) y los enlaces internos no llevan a ninguna parte rota.
- Imágenes en tamaños razonables y con carga diferida bajo el pliegue; sin librerías o fuentes que no se usen.
- Ningún texto de relleno ni dato inventado: lo que falte queda como `[PENDIENTE: …]` y en tu informe.
- Un `README` breve con cómo ver o ejecutar el resultado.

## Antes de tocar nada (si el proyecto ya tiene código)
Lee primero cómo está hecho; no empieces por escribir:
- Estructura del repositorio, `README`, estilos y componentes existentes, tests y la configuración de comprobaciones.
- Ejecuta las pruebas existentes antes de cambiar nada, para saber qué falla ya y no atribuirte (ni ocultar) fallos previos.
- Reutiliza los patrones, nombres y estilos del proyecto. No refactorices lo que el encargo no pide ni cambies de librería o estructura por gusto.
- Si el cambio toca varios archivos, apunta antes en tu informe cuáles y por qué (un plan corto), y mantén el cambio lo más pequeño que cumpla el encargo.

En tu informe, por criterio del contrato: qué comprobaste y cómo. Separa lo ejecutado de lo no comprobado. Indica también qué leíste del proyecto y qué convención seguiste.
