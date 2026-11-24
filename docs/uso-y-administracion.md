# Uso y administración

## Conversión y exportación

1. Inicia sesión con la cuenta que te dio el administrador.
2. Selecciona un PDF en la pantalla principal o arrástralo al área de carga. Si el mismo archivo ya figura en tu historial, puedes retomar su conversión.
3. Selecciona la salida que quieres revisar cuando el PDF contenga más de una. Comprueba el número con el encabezado del original. La previsualización del PDF depende del archivo seleccionado en el navegador. El historial conserva los datos extraídos.
4. Usa los filtros y compara los campos dudosos con la página y el renglón indicados. Corrige los valores cuando dispongas de respaldo. Conserva los ceros iniciales en los códigos. Deja vacío un campo cuyo valor desconozcas.
5. Selecciona las columnas, ajusta su orden y excluye las filas que no deben aparecer en el Excel. Revisa la vista previa de exportación y compárala con los totales impresos del documento.
6. Confirma el número de salida. Si la aplicación permite continuar con un aviso, registra el motivo. Usa **Validar y generar Excel** para descargar `SALIDA [NÚMERO DE SALIDA].xlsx`.

Si cambias los datos o la selección después de revisar la vista previa, genera una vista nueva y comprueba los importes antes de descargar. Si el PDF no tiene texto seleccionable o no se reconoce el formato, revisa el diagnóstico y solicita una copia digital compatible.

## Administración de usuarios

**Administrador inicial.** Aplica primero la migración. En **Authentication → Users** del Dashboard de Supabase, crea una cuenta confirmada y copia su UUID. Ejecuta la siguiente consulta desde **SQL Editor**, sustituyendo el UUID por el de esa cuenta. Comprueba que devuelve exactamente el perfil esperado antes de iniciar sesión.

```sql
update public.profiles
set role = 'admin', active = true
where id = '<uuid-del-administrador>'::uuid
returning id, email, role, active;
```

En **Usuarios**, un administrador activo puede crear perfiles, ajustar sus permisos y activar o desactivar el acceso. Las cuentas creadas en el Dashboard de Supabase quedan inactivas en la aplicación hasta que se habiliten. La desactivación conserva el historial de conversiones y auditoría. Entrega las credenciales iniciales mediante el canal interno de la organización.

| Acceso | Operador | Administrador |
| --- | --- | --- |
| Cargar, revisar y exportar | Sí | Sí |
| Consultar conversiones propias | Sí | Sí |
| Consultar conversiones y auditoría global | | Sí |
| Administrar usuarios y roles | | Sí |

## Recuperación de acceso

1. Configura el correo saliente en Supabase Auth y agrega la URL completa de la aplicación a la lista de redirecciones permitidas. Para desarrollo local la URL es `http://127.0.0.1:8000/`. Quien use ese enlace debe acceder desde el equipo que tiene el servidor local en ejecución.
2. En la plantilla de restablecimiento de contraseña, usa la siguiente dirección para el enlace de recuperación.

   ```html
   <a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=recovery">
     Restablecer contraseña
   </a>
   ```

3. Solicita el enlace desde la pantalla de ingreso, ábrelo en el navegador y establece una nueva contraseña. Verifica la entrega de correo y el acceso desde una cuenta de prueba antes de habilitar el flujo a los operadores. [Documentación de plantillas de Supabase](https://supabase.com/docs/guides/auth/auth-email-templates)
