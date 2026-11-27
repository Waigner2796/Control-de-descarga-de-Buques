# Vessel Control

Plataforma multiempresa para empresas de descarga de buques graneleros: cartera de clientes, servicios de descarga, buques y bodegas, básculas con captura manual de pesos, ciclos, tiempos perdidos, productividad, correcciones auditadas, informe final en PDF con firma gráfica y sello, y portal privado para cada cliente.

| Capa | Tecnología |
|---|---|
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS, TanStack Query, Recharts |
| Backend | Supabase: PostgreSQL 17, Auth, Realtime, Storage, Edge Functions (Deno) |
| Documentos | PDF con `pdf-lib` (Edge Function), Excel con ExcelJS (navegador) |
| Hosting | Vercel (frontend estático) + proyecto Supabase dedicado |

## Qué incluye

- **Dos entornos**: panel administrativo (barra lateral, azul puerto) y portal del cliente (navegación superior, identidad propia, sin herramientas administrativas).
- **Aislamiento real**: Row Level Security en todas las tablas por empresa, terminal, cliente y báscula; Storage privado con URLs firmadas de corta duración; ninguna autorización basada en metadatos del JWT.
- **Operaciones críticas en el servidor**: registro de pesaje con bloqueo de saldo e idempotencia, correcciones con movimientos compensatorios, cierre con conciliación, generación y firma de informes.
- **Buque dinámico** en tiempo real: cada bodega muestra sus productos y baja con cada pesaje.
- **Ciclos con paginación del lado del servidor** (25/50/100, filtros en la URL, orden por columna, búsqueda por matrícula y ticket).
- **Informe final automático** al finalizar el servicio, firma por un firmante autorizado, hash SHA-256, verificación pública por código y versiones sustituidas sin borrado.

## Puesta en marcha local

Requisitos: Node 22, Docker.

```bash
npm install
```

```bash
npx supabase start
```

```bash
npx supabase functions serve --env-file supabase/functions/.env.example
```

```bash
npm run seed:demo
```

```bash
cp .env.example .env.local
```

Complete `.env.local` con `VITE_SUPABASE_URL=http://127.0.0.1:54321` y la `ANON_KEY` que muestra `npx supabase status`, y luego:

```bash
npm run dev
```

Usuarios de demostración (solo locales, contraseña `VesselDemo2026`, dominio `vessel.local`): `master@`, `operaciones@`, `supervisor@`, `bascula1@`, `bascula2@` (báscula en modalidad hora del servidor), `analista@`, `firmante@`, `admin@` (plataforma), `cliente.fertisur@` y `cliente.molinos@` (portal). El script `seed-demo` se niega a ejecutarse contra un servidor que no sea local.

> En entornos donde el contenedor de Edge Functions no puede descargar paquetes npm (p. ej. inspección TLS), use `npm run edge:local` (empaqueta dependencias desde `node_modules`) y antes de hacer commit `npm run edge:prod-deps`.

## Pruebas

```bash
npm test
```

```bash
npm run test:e2e
```

`test:e2e` necesita el stack local y las Edge Functions en ejecución: 45 pruebas contra Auth, PostgREST, RLS, Storage y las funciones reales. La matriz de las 28 pruebas obligatorias está en [docs/PRUEBAS.md](docs/PRUEBAS.md).

## Documentación

- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): modelo de datos, flujos y reglas de negocio.
- [docs/SEGURIDAD.md](docs/SEGURIDAD.md): RLS, roles, contraseñas, Storage, firma.
- [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md): Supabase + Vercel paso a paso.
- [docs/PRUEBAS.md](docs/PRUEBAS.md): pruebas obligatorias y evidencia.
- [docs/PLANTILLA_EXCEL.md](docs/PLANTILLA_EXCEL.md): estado de la plantilla Excel de la empresa.

## Estructura

```
src/                     Frontend (pages/admin, pages/portal, components, lib)
supabase/migrations/     Esquema, RLS, funciones transaccionales, Storage
supabase/functions/      admin-users, report-worker, report-sign (+ _shared/report-pdf.ts)
tests/unit, tests/e2e    Pruebas
scripts/                 Datos de demostración (demo-data.mjs compartido) y utilidades locales
legacy/                  Prototipo HTML original (referencia visual y funcional)
.claude/skills/          Skills de diseño instaladas para futuras sesiones
```
