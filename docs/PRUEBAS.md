# Pruebas obligatorias (sección 21)

Evidencia automática: `tests/e2e/backend.test.ts` (35 pruebas) y `tests/e2e/reports.test.ts` (10 pruebas) contra el stack Supabase real (Auth, PostgREST, RLS, Storage, Edge Functions); `tests/unit/report-pdf.test.ts` (5 pruebas). Además se verificaron flujos en navegador con Playwright (pesaje en ambas modalidades, aprobación de corrección, cierre, firma, exportaciones y portal).

| # | Prueba | Evidencia |
|---|---|---|
| 1 | Crear dos empresas | `backend` · beforeAll (`platform_create_organization` ×2) |
| 2 | Varios clientes por empresa | `backend` · beforeAll (A: 2, B: 1), `reports` (2) |
| 3 | Usuarios administrativos | `backend` · 8 roles internos; `reports` · alta vía `admin-users` |
| 4 | Usuarios de clientes | `backend` · 3 usuarios; `reports` · alta con contraseña temporal |
| 5–6 | Acceso a datos de otro cliente rechazado | `Aislamiento (RLS)…`: por UUID, vista, KPIs, pesajes, auditoría, otra empresa, anon |
| 7 | Servicios con números manuales | `Multiempresa…`: número manual, duplicado rechazado sin distinguir mayúsculas, otra empresa puede repetirlo |
| 8–9 | Varias bodegas y varios productos por bodega | `una bodega admite varios productos…` |
| 10–11 | Pesajes manuales desde varias básculas | `registra un pesaje manual…`, concurrencia con dos básculas |
| 12 | Horas en ambas modalidades | `modalidad "hora del servidor"…` + flujo en navegador (manual y botones) |
| 13 | Ciclos y paginación | `pagina, cuenta, filtra y ordena en el servidor` |
| 14 | Tiempos perdidos | `distingue alcance…`, resumen y Pareto |
| 15 | Medianoche | `calcula correctamente un evento que atraviesa la medianoche` (23:30→01:15 = 105 min) |
| 16–17 | Corrección y tonelaje actualizado | `el operador solicita, el supervisor aprueba…`, traslado entre bodega/producto |
| 18 | Historial de auditoría | `anular revierte el descuento…` (audit_logs con motivo) y `correction_history` |
| 19–20 | Finalizar y generar PDF automáticamente | `finaliza, crea un único trabajo…`, `al finalizar se genera automáticamente un borrador único` |
| 21–22 | Firmar, sellar y verificar integridad | `firma: hash SHA-256 registrado = hash del archivo…`, verificación pública |
| 23–24 | Cliente descarga; otro cliente no | `el cliente propietario descarga con URL firmada…; otro cliente no` |
| 25 | Nueva versión tras corrección | `una corrección posterior genera v2; al firmarla, v1 queda sustituida` |
| 26 | Excel con el formato de la plantilla | Exportaciones verificadas (hojas, fórmulas de totales, filtros). **Pendiente** replicar la plantilla oficial: no fue adjuntada (ver PLANTILLA_EXCEL.md). |
| 27 | Registros simultáneos | `registros simultáneos desde dos básculas…` (6 pesajes concurrentes, 3 aceptados por saldo) |
| 28 | Sin descuentos duplicados | `reintentos con el mismo client_request_id…` (6 envíos, 1 ticket, 1 descuento) + conciliación |

Otras verificaciones: escalamiento de privilegios, último Master, desactivación inmediata, contraseña temporal verificada en servidor, inmutabilidad del PDF firmado (sobrescritura y alteración del hash rechazadas), PDF con 2,500 pesajes (paginación del documento).
