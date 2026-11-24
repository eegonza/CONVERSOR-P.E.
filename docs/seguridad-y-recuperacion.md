# Seguridad y recuperación

## Controles de acceso y datos

Usa el servidor HTTP en la interfaz local `127.0.0.1`. Para el acceso por red, configura un origen HTTPS y un proxy inverso con TLS. El origen configurado debe coincidir con el que abre el usuario. El servidor conserva la sesión temporal en memoria y el navegador guarda un identificador opaco en una cookie `HttpOnly` con `SameSite`. Las operaciones autenticadas de escritura exigen un token CSRF. El servidor aplica límites a los intentos de autenticación y a las cargas.

Mantén las claves confidenciales de Supabase en el servidor, mediante `.env` con acceso limitado a quien ejecuta la aplicación. Mantén deshabilitado el registro público. Las consultas usan el token de la persona autenticada. Las políticas de Postgres limitan los datos según el rol, el perfil activo y la propiedad del registro. El servidor verifica la identidad antes de realizar las escrituras de procesamiento y auditoría con su credencial privilegiada. Las funciones de escritura vuelven a verificar los permisos del actor. Los eventos de auditoría son de solo inserción para el flujo normal de la aplicación.

Los PDF se procesan localmente en un subproceso con límites de tamaño, número de páginas y tiempo. Los límites de recursos del proceso dependen del sistema operativo. Los valores de PDF se muestran como texto y los campos de texto de Excel se escriben como celdas literales. Conserva actualizados el analizador PDF, el servidor y el navegador.

## Conservación

La aplicación conserva los datos extraídos y la auditoría en Supabase. Los bytes del PDF original y el Excel descargado quedan bajo custodia del usuario o de la organización. El repositorio contiene el código y las migraciones. Guarda los originales, exportaciones, claves y copias de seguridad en ubicaciones con control de acceso y cifrado.

La organización debe aprobar por separado los plazos de conservación de originales, Excel, conversiones, auditoría y copias de seguridad. Define quién autoriza la eliminación y quién puede recuperar una copia. La desactivación de usuarios mantiene su identidad histórica para la auditoría.

## Respaldo y restauración

1. Verifica qué respaldos y ventanas de recuperación ofrece el plan del proyecto. Registra la frecuencia de copia, el periodo de conservación y el punto de recuperación requerido. El respaldo debe preservar las identidades de Auth junto con los perfiles y conversiones que las referencian. [Respaldos de base de datos de Supabase](https://supabase.com/docs/guides/platform/backups)
2. Conserva las migraciones en el repositorio y documenta por separado la configuración de autenticación, las redirecciones y las plantillas. Para una copia lógica adicional, sigue el procedimiento de copia y restauración de Supabase para roles, esquema y datos. Guarda las exportaciones cifradas y usa un canal seguro para las credenciales de conexión. [Copia y restauración con la CLI de Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)
3. Restaura primero en un proyecto de prueba. Comprueba los perfiles y sus permisos, el número de conversiones y eventos, y la integridad de una muestra con los identificadores originales. Verifica los eventos previos y posteriores a la restauración y documenta cualquier desajuste.
4. Tras comprobar la restauración, actualiza la configuración del servidor con las credenciales del destino autorizado y reinicia el servicio. Comprueba el acceso y una conversión con cada rol antes de habilitar de nuevo el acceso ordinario.

Los respaldos de Supabase cubren lo almacenado en ese servicio. Incluye los PDF originales y los Excel descargados en el procedimiento de respaldo local si la política aprobada exige conservarlos.

## Alcance operativo

Un acceso administrativo al proyecto de Supabase puede modificar la configuración o la base más allá de lo que permite la aplicación. Restringe ese acceso y protégelo con los controles de identidad de la organización. El subproceso de PDF hereda los permisos del usuario del sistema que ejecuta el servidor. Para un despliegue compartido, ejecuta el servidor con una cuenta de servicio de privilegios mínimos y verifica la configuración TLS, la entrega de correo y la recuperación en el entorno real.
