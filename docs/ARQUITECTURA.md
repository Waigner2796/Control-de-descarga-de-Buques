# Arquitectura

## Visión general

```
Navegador (React)  ──supabase-js──►  PostgREST ──► PostgreSQL (RLS + funciones SECURITY DEFINER)
      │                              Realtime  ──► cambios filtrados por RLS de cada suscriptor
      │                              Storage   ──► buckets privados, URLs firmadas
      └──functions.invoke──►  Edge Functions (Deno, service_role solo aquí)
                                ├─ admin-users     alta/baja de cuentas, contraseñas temporales
                                ├─ report-worker   borrador del informe final (PDF)
                                └─ report-sign     firma + sello + SHA-256 + publicación
```

- Toda escritura crítica pasa por funciones PostgreSQL transaccionales (`register_weigh_ticket`, `request_correction`, `close_service`, …). Las tablas de saldos, pesajes, ledger, reportes, firmas y auditoría **no** tienen privilegios de escritura directa para `authenticated`.
- Las lecturas usan la API REST con RLS. Las vistas (`service_overview`, `customer_portfolio`, `operational_cycles`, `downtime_overview`, `report_overview`) son `security_invoker`, por lo que aplican el RLS del usuario.
- Fechas en `timestamptz` (UTC). Cada terminal tiene zona horaria; la interfaz muestra la hora local de la terminal y las horas digitadas se convierten en el servidor con `AT TIME ZONE`.
- Pesos en `numeric`; se capturan en kg (o TM según configuración) y se calcula en toneladas métricas (1 TM = 1,000 kg).

## Modelo de datos (sección 17 del requerimiento)

| Grupo | Tablas implementadas | Notas |
|---|---|---|
| Multiempresa | `organizations`, `terminals`, `organization_members`, `terminal_members`, `user_profiles`, `roles`, `permissions`, `role_permissions`, `platform_admins` | `permissions`/`role_permissions` materializan la matriz de roles; `extra_permissions` permite conceder permisos puntuales (p. ej. cierre a un supervisor). |
| Clientes | `customers`, `customer_contacts`, `customer_documents`, `customer_users`, `customer_portal_permissions` | |
| Buques y servicios | `vessels`, `vessel_holds`, `services`, `service_holds`, `products`, `service_hold_cargo`, `service_scales` | `service_holds.vessel_id` admite varios buques por servicio. |
| Básculas y transporte | `scales`, `scale_settings`, `scale_users`, `trucks`, `tractors` (matrícula TC), `drivers`, `weigh_tickets`, `scale_visits` | `ticket_cargo_allocations` se implementa como `cargo_movements` (cada ticket asigna su neto a una línea bodega/producto); no se duplica la tabla. |
| Tiempos y productividad | `operational_cycles` (vista sobre `weigh_tickets`), `downtime_events`, `downtime_categories`, `downtime_causes`, `shifts`, `productivity_snapshots` | El ciclo es atributo del ticket (`cycle_seconds` generado), por eso es vista y no copia. `downtime_causes` es el catálogo editable de eventos. |
| Tonelaje | `cargo_movements` (ledger), `cargo_adjustments`, `ticket_reversals` | |
| Documentación | `report_templates`, `report_jobs`, `generated_reports`, `report_versions`, `digital_signatures`, `company_seals`, `authorized_signers` | |
| Auditoría | `audit_logs`, `correction_requests`, `correction_history`, `approval_records` | |
| Configuración | `organization_settings`, `terminal_settings`, `scale_settings`, `operational_thresholds` | |
| Otros | `notifications` | Avisos del portal y del equipo interno. |

## Saldos y ledger

`service_hold_cargo.discharged_tm` es una caché del ledger `cargo_movements`:

- Pesaje: `+neto` (movimiento `discharge`).
- Anulación o corrección: `−neto anterior` (`reversal`) y, si aplica, `+neto nuevo` en la línea correcta.
- La fila del saldo se bloquea (`FOR UPDATE`) durante el pesaje; con varias básculas sobre el mismo producto, las transacciones se serializan y la restricción `CHECK (discharged_tm BETWEEN 0 AND initial_tm)` impide saldos negativos.
- Índices únicos `(ticket_id, ticket_revision)` por tipo de movimiento impiden descontar dos veces la misma revisión; `client_request_id` hace idempotente el registro.
- Al finalizar, `close_service` verifica `saldo = Σ ledger = Σ tickets válidos` para cada línea.

## Flujo del servicio

`Programado → En preparación → En operación ⇄ Suspendido → En proceso de cierre → Finalizado` (o `Cancelado` antes de tener pesajes válidos).

Al **finalizar**: sin visitas de báscula abiertas, sin correcciones pendientes, conciliación, nota obligatoria si queda pendiente mayor a la tolerancia → instantánea de productividad → `generated_reports` + `report_jobs` (clave idempotente `servicio:revisión`) → el frontend invoca `report-worker` → borrador “pendiente de firma” → el firmante firma con `report-sign` → versión inmutable publicada en el portal y notificación al cliente.

Una **corrección** posterior al cierre incrementa `data_revision`, marca el informe “nueva versión en curso” y encola un nuevo trabajo; al firmar la nueva versión, la anterior queda `superseded` con su motivo y sigue disponible.

## Captura de horas en báscula

Solo **hora de inicio** y **hora final**. Modalidad por terminal (con excepción por báscula):

- **Manual**: el operador escribe fecha, inicio y final; si la final es menor que el inicio se propone el día siguiente y se avisa.
- **Hora del servidor**: botones que crean/cierran una `scale_visit` con `now()` del servidor; el navegador no puede alterar las horas.

## Productividad

`service_kpis` diferencia: tiempo de ciclo (final − inicio en báscula), tiempo perdido reportado (suma de eventos), parada de toda la operación (eventos de alcance «operación» fusionados y recortados a la ventana operativa) y tiempo efectivo (ventana − parada). No se calculan esperas entre camiones porque no existen esas marcas.

## Reglas de negocio (sección 19)

| # | Regla | Dónde se garantiza |
|---|---|---|
| 1 | Número de servicio manual | `create_service` exige `service_number`; índice único `(organization_id, lower(service_number))`. |
| 2–6 | Empresa → clientes → servicios → buques/bodegas → productos; varias básculas | Claves foráneas + `service_holds`, `service_hold_cargo`, `service_scales`. |
| 7 | Pesajes manuales | No existe integración con dispositivos; el formulario captura bruto y tara. |
| 8–10 | Descuento por producto y bodega, sin negativos, transaccional | `register_weigh_ticket`, bloqueo de fila y `CHECK`. |
| 11–12 | Solo inicio/final; modalidad configurable | `weigh_tickets.started_at/ended_at`, `terminal_settings`, `scale_settings`, `scale_visits`. |
| 13 | Tiempos perdidos independientes | `downtime_events`. |
| 14 | Paginación en servidor | `range()` + `count` sobre `operational_cycles` con índices. |
| 15 | Correcciones auditadas | `correction_requests`, `correction_history`, `audit_logs`, `approval_records`. |
| 16 | Informe automático al cerrar | `close_service` → `report_jobs` → `report-worker`. |
| 17 | Informes firmados inmutables | Trigger `report_versions_guard`, Storage sin `update/delete`, rutas únicas. |
| 18 | Corrección posterior → nueva versión | `bump_service_revision`. |
| 19 | Cliente solo ve lo suyo | RLS (`app.my_customer_ids*`), Storage y vistas `security_invoker`. |
| 20 | Sin borrado físico | Triggers `prevent_delete` en tablas operativas críticas. |
