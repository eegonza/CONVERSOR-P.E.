# Arquitectura del conversor

El navegador presenta el PDF elegido, los renglones extraídos y la vista previa. FastAPI autentica las solicitudes, ejecuta el analizador y prepara el Excel. Supabase Auth gestiona las identidades. Postgres conserva las conversiones y los eventos de auditoría.

| Componente | Responsabilidad | Alcance en esta versión |
| --- | --- | --- |
| HTML, CSS y JavaScript | Carga, revisión, selección de exportación, historial y administración. | Una interfaz de escritorio adaptable servida por FastAPI desde el mismo origen. |
| FastAPI y Uvicorn | HTTP local, sesiones, validación, autorización y coordinación de la conversión. | Un proceso de aplicación. Las sesiones en memoria se cierran al reiniciar. |
| pypdf | Lectura de la capa de texto en un subproceso local. | Las variantes observadas se reconocen por estructura y posición. Los escaneos sin texto requieren OCR en una fase posterior. |
| openpyxl | Generación local de un `.xlsx` con tabla nativa y filtros. | Los identificadores se escriben como texto con los ceros iniciales. Los importes y cantidades presentes se escriben como números. |
| Supabase Auth y Postgres | Identidades, roles, conversiones, extracción estructurada y auditoría. | Las lecturas usan el token de la persona autenticada y se restringen mediante RLS. Las escrituras de procesamiento y auditoría se reservan al servidor. |

## Flujo de información

1. El operador selecciona un PDF. La aplicación valida el archivo y calcula su huella SHA-256 para detectar el mismo archivo en el historial de esa cuenta.
2. El analizador local obtiene los números de salida, las filas de cada página, los encabezados, el pie y los problemas detectados. La conversión registra el resultado de extracción y las horas de carga y procesamiento por separado en Postgres.
3. El operador corrige los datos, elige filas y columnas y solicita una vista previa. El servidor valida los valores y la selección, conserva la procedencia y calcula los resúmenes respaldados por los datos disponibles.
4. El operador confirma el número de salida y deja constancia de las inconsistencias aceptadas. El servidor vincula la aprobación a la versión de la vista previa y genera `SALIDA [NÚMERO DE SALIDA].xlsx` con esa selección.

La aplicación mantiene la posición y los valores impresos de los renglones. El `01` separado antes del código se omite en la columna **Código**. Un valor vacío queda vacío y un cero impreso se conserva. El orden inicial coloca **Unidades** antes de **Costo**. Los renglones repetidos se distinguen por página y posición. El resumen de las filas elegidas y los totales impresos del PDF tienen procedencias distintas.

Un impuesto correspondiente a las líneas seleccionadas requiere datos que permitan justificarlo. Si la selección, los campos incompletos o las diferencias del documento impiden determinarlo, el resumen lo deja pendiente. La aplicación conserva las cifras impresas del pie como referencia para revisión.

## Modelo de datos

| Entidad | Contenido |
| --- | --- |
| `auth.users` | Identidades de Supabase Auth. |
| `profiles` | Nombre, rol y estado de cada persona. |
| `conversions` | Propietario, archivo de origen, hash, fechas y extracción estructurada. |
| `audit_events` | Eventos de conversión, exportación y administración, con actor y fecha. |

Las migraciones mantienen las restricciones, las políticas de acceso y las funciones de escritura. Cada operación usa la identidad que el servidor validó con Supabase. Las funciones comprueban el estado, el rol y la relación con el registro antes de escribir. Un operador consulta sus conversiones. Un administrador activo puede consultar las conversiones y la auditoría global, y administrar los perfiles. La desactivación de una cuenta mantiene sus vínculos históricos.

## Compatibilidad documental

La referencia de desarrollo son las cinco salidas analizadas en la fase de validación. Incluyen las variantes con y sin **Estilo**, encabezados repetidos y varias páginas con texto seleccionable. Cuando el formato no rotula **Estilo**, el descriptor intermedio conserva un campo propio. Si un PDF contiene varias salidas reconocibles, cada número requiere su propia selección y confirmación. Un PDF escaneado, un formato distinto o una descripción incompleta requiere revisión con el aviso que presenta la aplicación.
