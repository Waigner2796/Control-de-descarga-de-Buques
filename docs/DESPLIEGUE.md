# Despliegue (Supabase + Vercel)

> Use un **proyecto Supabase dedicado** a Vessel Control. Las migraciones crean tablas como `organizations` que pueden chocar con otras aplicaciones.

## 1. Supabase

1. Cree el proyecto y vincúlelo:

```bash
npx supabase link --project-ref <ref-del-proyecto>
```

2. Aplique las migraciones (no ejecute `seed-demo` en producción):

```bash
npx supabase db push
```

3. Despliegue las Edge Functions (usan los `deno.json` con especificadores `npm:`):

```bash
npx supabase functions deploy admin-users report-worker report-sign
```

4. Variables de las funciones:

```bash
npx supabase secrets set PUBLIC_APP_URL=https://<su-app>.vercel.app PUBLIC_VERIFY_URL=https://<su-app>.vercel.app/verificar ALLOWED_ORIGINS=https://<su-app>.vercel.app
```

Opcional, correo a clientes al publicar un informe (Resend):

```bash
npx supabase secrets set RESEND_API_KEY=<clave> NOTIFY_FROM_EMAIL=reportes@<su-dominio>
```

5. En **Authentication** del panel de Supabase:
   - Desactive el registro público (Allow new users to sign up: off).
   - Longitud mínima de contraseña 10 y requisitos de mayúsculas, minúsculas y números.
   - Site URL = URL de Vercel; Redirect URLs: `https://<su-app>.vercel.app/restablecer`.
   - Configure SMTP propio para invitaciones y recuperación.

6. Primer administrador de plataforma: cree el usuario en Authentication → Users y ejecute en el SQL Editor (reemplace el correo):

```sql
insert into public.user_profiles (user_id, full_name, email) select id, 'Administrador', email from auth.users where email = 'admin@su-dominio.com';
insert into public.platform_admins (user_id) select id from auth.users where email = 'admin@su-dominio.com';
```

Luego, desde **Empresas (plataforma)** en la app, cree cada empresa con su Administrador Master.

7. Reintentos automáticos de informes (opcional, recomendado). Con `pg_cron` y `pg_net` habilitados, y la clave `service_role` guardada en Vault con el nombre `service_role_key`:

```sql
select cron.schedule('vessel-report-worker', '* * * * *', $$
  select net.http_post(
    url := 'https://<ref>.supabase.co/functions/v1/report-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb)
  where exists (select 1 from public.report_jobs where status in ('queued', 'failed') and attempts < max_attempts);
$$);
```

## 2. Vercel

1. Importe el repositorio (framework Vite; `vercel.json` ya define build, SPA y cabeceras de seguridad).
2. Variables de entorno (públicas):
   - `VITE_SUPABASE_URL` = URL del proyecto
   - `VITE_SUPABASE_ANON_KEY` = clave anon/publishable
3. Nunca configure la clave `service_role` en Vercel.

## 3. Entorno de demostración publicado

Existe un entorno **solo de demostración** (datos ficticios, no apto para operación real):

| Pieza | Valor |
|---|---|
| App (Vercel, proyecto `vessel-control`) | https://vessel-control-blond.vercel.app |
| Supabase (proyecto `vessel-control`) | `haeszikengvliafzhefj` (us-east-1, plan gratuito) |
| Usuarios | Los mismos roles que en local, con dominio `vesselcontrol.example`. La contraseña la custodia el titular; no se publica en el repositorio. |

Notas:

- Las migraciones 001–008 están aplicadas. Las Edge Functions `admin-users`, `report-worker` y `report-sign` se desplegaron importando el código de este repositorio fijado a un commit; después de fusionar a `main`, vuelva a desplegarlas con el comando del paso 1.3 para que queden autocontenidas.
- La función `demo-bootstrap` (carga inicial única) quedó desactivada y responde 410.
- Vercel despliega producción desde `main`; las ramas generan *previews* protegidas por Vercel Authentication.
- Para operar con datos reales, cree **otro** proyecto Supabase siguiendo la sección 1, sin datos de demostración.

## 4. Comprobación posterior

- Inicie sesión como Master, cree una terminal, básculas, buque, productos, un cliente y un servicio.
- Registre un pesaje, finalice el servicio, firme el informe y verifique el código en `/verificar`.
- Ejecute los asesores de seguridad y rendimiento de Supabase (Database → Advisors).
