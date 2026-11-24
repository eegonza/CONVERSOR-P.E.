# Conversor PDF a Excel

Aplicación web local para revisar salidas de producto de City Mall, S.A. y exportarlas a Excel. La aplicación conserva el origen por página y renglón, las apariciones repetidas y los campos vacíos. El operador revisa los datos, confirma el número de salida y decide qué filas y columnas se exportarán.

## Requisitos

- Python 3.12 y [uv](https://docs.astral.sh/uv/getting-started/installation/).
- Un proyecto de Supabase que administres con su base de datos Postgres.
- Un navegador actual. La interfaz y la extracción se ejecutan en el equipo local. Supabase recibe las solicitudes de autenticación y conserva los datos extraídos y el historial de auditoría.

## Instalación local

1. Clona este repositorio e instala las dependencias.

   ```sh
   git clone https://github.com/eegonza/CONVERSOR-P.E..git conversor-pe
   cd conversor-pe
   uv sync
   ```

2. Aplica [`20261124000100_initial.sql`](supabase/migrations/20261124000100_initial.sql) al proyecto. En el Dashboard puedes ejecutar el archivo SQL desde **SQL Editor**. Si gestionas las migraciones mediante la CLI, usa `supabase link --project-ref <referencia-del-proyecto>` seguido de `supabase db push` desde la raíz. Elige un método para mantener coherente el historial de migraciones. Conserva `app_private` fuera de los esquemas expuestos por la API.

3. En Supabase Auth, habilita el ingreso por correo y contraseña, desactiva el registro público general y por correo y las sesiones anónimas, y configura el primer administrador. Si vas a usar la recuperación, configura el envío de correo y su redirección. [Administración de usuarios](docs/uso-y-administracion.md#administración-de-usuarios) y [recuperación de acceso](docs/uso-y-administracion.md#recuperación-de-acceso).

4. Copia `.env.example` a `.env` y completa las variables. En PowerShell puedes usar `Copy-Item .env.example .env`.

   | Variable | Configuración |
   | --- | --- |
   | `APP_ORIGIN` | URL exacta con la que abrirás la aplicación. Para desarrollo local usa `http://127.0.0.1:8000`. |
   | `SUPABASE_URL` | URL del proyecto de Supabase, disponible en su Dashboard. |
   | `SUPABASE_PUBLISHABLE_KEY` | Clave publicable del proyecto. La variable `SUPABASE_ANON_KEY` admite la clave heredada. |
   | `SUPABASE_SECRET_KEY` | Clave de servidor requerida para guardar conversiones, registrar auditoría y crear usuarios. La variable `SUPABASE_SERVICE_ROLE_KEY` admite la clave heredada. |
   | `PDF_MAX_BYTES` | Tamaño máximo de entrada, 20 MiB por defecto. |
   | `PDF_MAX_PAGES` | Límite de 100 páginas por archivo por defecto. |
   | `PDF_TIMEOUT` | Límite de 40 segundos por análisis por defecto. |

5. Inicia la aplicación y abre `http://127.0.0.1:8000` en el navegador. Usa la misma dirección configurada en `APP_ORIGIN`.

   ```sh
   uv run uvicorn conversor.main:app --host 127.0.0.1 --port 8000 --no-access-log --limit-concurrency 32
   ```

Guarda `.env` fuera del control de versiones. La aplicación usa una sesión local por proceso. Ejecuta un solo proceso de Uvicorn y vuelve a iniciar sesión después de reiniciar el servidor.

## Documentación

- [Uso, administración y configuración de recuperación](docs/uso-y-administracion.md)
- [Arquitectura, flujo de datos y compatibilidad](docs/arquitectura.md)
- [Seguridad, conservación y respaldo](docs/seguridad-y-recuperacion.md)

## Comprobaciones de desarrollo

```sh
uv run pytest
uv run ruff check .
node --check conversor/static/app.js
```

En la primera entrega pasaron 19 pruebas de Python. Se completó el flujo de carga, revisión y descarga para los cinco PDF de validación, y se comprobó al reabrir los Excel que conservaban los 462 renglones y sus códigos. La interfaz se verificó en Chromium con una API simulada. Los permisos y la auditoría se probaron en PostgreSQL 17, y también se comprobó la autenticación, el alta de perfiles y el acceso a datos con GoTrue y PostgREST locales.

La comprobación de JavaScript requiere Node.js. Para verificar el flujo con Supabase Auth y correo reales, aplica la migración a un proyecto de pruebas y usa una cuenta de cada rol. La prueba SQL prepara datos temporales dentro de una transacción que revierte al terminar. Ejecútala con `psql` y una conexión de administración al proyecto de pruebas.

```sh
psql "$SUPABASE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/tests/access_and_audit.sql
```
