# Publicación del conversor en GitHub Pages y Supabase

GitHub Pages sirve el sitio y Supabase Auth inicia la sesión. La función `conversor-api` valida el perfil y los permisos de cada solicitud y utiliza las tablas, el historial y la auditoría existentes. Las operaciones privilegiadas usan las claves disponibles dentro de Supabase Edge Functions.

El navegador procesa el PDF y genera el Excel con el mismo lector y el mismo generador de la versión local. Supabase recibe el nombre, la huella y los datos estructurados del PDF para guardar la revisión. El PDF original permanece en el navegador. La vista previa se calcula en Supabase y el archivo se construye a partir de esa selección aprobada. Un token de sesión permanece en memoria de la pestaña y volver a cargar el sitio requiere iniciar sesión otra vez.

## 1. Completa la base de datos y el usuario de Supabase

Aplica la [migración inicial](../supabase/migrations/20261124000100_initial.sql) al proyecto una sola vez. Conserva `public` entre los esquemas de la API de datos y usa los permisos de la migración. Crea y activa el primer administrador según el [manual de administración](uso-y-administracion.md#administración-de-usuarios). Desactiva el registro público y las sesiones anónimas en Supabase Auth.

## 2. Despliega la función en tu proyecto

Desde una terminal con Node.js y una copia de este repositorio, autentícate en la CLI con tu cuenta de Supabase y despliega la función indicada. La CLI lee los archivos de `supabase/functions/conversor-api` y la configuración de `supabase/config.toml`. La función verifica cada sesión directamente con Supabase Auth antes de acceder a los registros. [Despliegue de Edge Functions](https://supabase.com/docs/guides/functions/deploy).

```powershell
npx --yes supabase@3.4.0 login
npx --yes supabase@3.4.0 functions deploy conversor-api --project-ref xvjscltcvanrwqmgfcey
```

El origen HTTP permitido en la función es `https://eegonza.github.io`. Si publicas la interfaz con otro dominio, configura `CONVERSOR_WEB_ORIGIN` como el origen de ese sitio en [Secretos de Edge Functions](https://supabase.com/dashboard/project/xvjscltcvanrwqmgfcey/functions/secrets).

## 3. Publica la interfaz en GitHub Pages

1. En [Variables de GitHub Actions](https://github.com/eegonza/CONVERSOR-P.E./settings/variables/actions), agrega `SUPABASE_PUBLISHABLE_KEY` con la clave **Publishable** que empieza con `sb_publishable_`. Cópiala desde [Claves de tu proyecto](https://supabase.com/dashboard/project/xvjscltcvanrwqmgfcey/settings/api-keys/). La clave administrativa se usa dentro de Supabase.
2. En [Pages en el repositorio](https://github.com/eegonza/CONVERSOR-P.E./settings/pages), elige **GitHub Actions** en **Build and deployment → Source**.
3. En [Actions](https://github.com/eegonza/CONVERSOR-P.E./actions), abre **Publicar el conversor en GitHub Pages**, elige **Run workflow** y selecciona `main`. Abre el enlace que indique **Visit site** al terminar la publicación. La dirección predeterminada para este repositorio es `https://eegonza.github.io/CONVERSOR-P.E./`.

La compilación utiliza la URL de Supabase indicada en el código. Si se usa otro proyecto, establece `SUPABASE_URL` en las variables de GitHub Actions antes de ejecutar el flujo.

## 4. Configura la recuperación por correo

En [Configuración de URL de tu proyecto](https://supabase.com/dashboard/project/xvjscltcvanrwqmgfcey/auth/url-configuration), usa la dirección publicada como **Site URL** y agrégala también a **Redirect URLs**. Incluye la barra final de la URL. Configura [SMTP](https://supabase.com/dashboard/project/xvjscltcvanrwqmgfcey/auth/smtp) y usa la plantilla de [recuperación del manual](uso-y-administracion.md#recuperación-de-acceso).

## 5. Comprueba el flujo en el sitio publicado

Inicia sesión con el administrador, carga un PDF con texto seleccionable, elige filas y columnas, revisa los importes y confirma el número de salida. Comprueba que el Excel llamado `SALIDA [NÚMERO].xlsx` coincide con la vista previa. Repite con un operador y verifica que su historial esté limitado a sus conversiones.

Para construir la versión web durante el desarrollo usa Node.js 24 y Python 3.12. En `web`, ejecuta `npm ci`, `npm test` y `npm run build`. La compilación descarga las mismas dependencias de Python fijadas en `uv.lock`, verifica sus huellas y las sirve como parte del sitio.

La distribución del intérprete incluye Pyodide 314.0.8. Su código fuente y su licencia MPL 2.0 están disponibles en el proyecto de Pyodide. [Código fuente y licencia de Pyodide](https://github.com/pyodide/pyodide/tree/314.0.8).

La verificación previa a la publicación cubrió las cinco muestras aprobadas en Chromium, con 462 renglones, y confirmó las tablas Excel generadas por el navegador. En esa prueba, el almacenamiento y la autenticación de Supabase se simularon y el código de la función de revisión se ejecutó contra ese entorno. La prueba del enlace publicado requiere la configuración del proyecto en los pasos anteriores.
