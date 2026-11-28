# Seguridad y aislamiento

## Principios

1. **Ninguna decisión de autorización se toma en el navegador.** La interfaz oculta lo que el usuario no puede hacer, pero el bloqueo real lo hacen RLS, los privilegios por columna y las funciones del servidor.
2. **No se usan `user_metadata`/`app_metadata` del JWT para autorizar.** Las pertenencias viven en `organization_members`, `terminal_members`, `scale_users` y `customer_users`, que solo modifican funciones del servidor.
3. **La clave `service_role` solo existe en las Edge Functions.** El frontend usa la clave pública (anon/publishable).

## RLS

- Todas las tablas de `public` tienen RLS habilitado y forzado; `anon` no tiene privilegios sobre ninguna tabla.
- Los helpers del esquema `app` (no expuesto por la API) devuelven **conjuntos** de ids (`app.terminals_with_perm('weighing.view_all')`, `app.my_customer_ids()`, …) y se usan como `columna IN (SELECT …)`, que PostgreSQL evalúa una sola vez por consulta.
- Cada helper exige perfil activo, contraseña temporal ya cambiada y membresía activa: desactivar a un usuario corta su acceso de inmediato aunque su JWT siga vigente.
- `organization_id` y `terminal_id` de las tablas hijas se fijan por trigger desde el registro padre; un cliente de la API no puede insertar filas en otra empresa.
- Clientes del portal: leen solo sus servicios, bodegas, cargas, reportes publicados y documentos marcados como visibles; nunca pesajes individuales, DPI, tiempos perdidos, auditoría ni datos de otros clientes. La productividad del portal se entrega agregada mediante `service_kpis`.
- Pruebas automáticas cubren: cliente A contra servicio de cliente B (por id), empresa B contra empresa A, `anon`, escritura de clientes, escalamiento de rol, último Administrador Master, usuario desactivado con JWT vigente y contraseña temporal (ver `tests/e2e`).

## Escrituras críticas

Sin `INSERT/UPDATE/DELETE` para `authenticated` en: `weigh_tickets`, `cargo_movements`, `ticket_reversals`, `cargo_adjustments`, `scale_visits`, `downtime_events`, `report_versions`, `digital_signatures`, `report_jobs`, `correction_*`, `approval_records`, `audit_logs`, `organization_members`. El saldo `discharged_tm` no tiene privilegio de columna y un trigger rechaza cualquier cambio fuera del ledger. Las funciones `SECURITY DEFINER` usan `search_path = ''` y validan identidad y permiso al inicio.

## Cuentas y contraseñas

- Registro público deshabilitado (`enable_signup = false`); las cuentas las crea `admin-users`.
- Contraseña temporal aleatoria (14 caracteres) mostrada **una sola vez** al administrador, o invitación por correo. Política mínima: 10 caracteres con mayúsculas, minúsculas y números.
- Cambio obligatorio en el primer ingreso verificado en el servidor: se guarda el hash que tenía GoTrue al crear la cuenta y `confirm_password_changed` comprueba que cambió.
- No hay forma de consultar contraseñas existentes; solo restablecerlas. Restablecer revoca las sesiones del usuario.
- Desactivación: RLS corta el acceso al instante; si el usuario no tiene otras pertenencias activas se bloquea en Auth y se revocan sus sesiones.
- Nadie puede cambiar su propio rol, estado o permisos; solo un Administrador Master asigna o modifica a otro Master; la empresa conserva al menos un Master activo.

## Storage

Buckets privados `org-assets`, `reports` y `customer-documents`. Las descargas usan URLs firmadas de 2 minutos que Storage emite tras evaluar políticas por ruta. Los PDF de reportes solo los escribe `service_role` y no existen políticas de actualización ni borrado: el archivo firmado no puede sobrescribirse.

## Firma del informe

El informe lleva una **firma gráfica** (imagen del firmante) y el **sello** de la empresa, la identidad del firmante (usuario autenticado y vinculado como firmante autorizado), la fecha y hora de emisión, un código de verificación y el **hash SHA-256** del PDF final registrado en `digital_signatures` con evidencia (sesión, IP, agente). Cualquier persona puede comprobar en `/verificar` que su archivo coincide con el hash registrado.

**No es una firma electrónica avanzada ni certificada.** Si se requiere validez jurídica formal, se debe integrar un proveedor de firma electrónica conforme a la legislación aplicable (la columna `digital_signatures.signature_type` ya contempla `certified_provider`).
