-- =============================================================================
-- VESSEL CONTROL · Migración 001 · Fundaciones multiempresa
--   * Esquemas: public (API), app (helpers internos, NO expuesto por PostgREST)
--   * Catálogo de roles y permisos
--   * Organizaciones, terminales, miembros, perfiles, administradores de plataforma
--   * Configuración por organización / terminal / umbrales operativos
--   * Helpers de autorización usados por RLS (devuelven conjuntos → initplan único)
--   * Auditoría genérica por trigger y bloqueo de borrado físico
-- Regla: la autorización NUNCA se basa en user_metadata/app_metadata del JWT,
-- solo en tablas de pertenencia controladas por el backend.
-- =============================================================================

create extension if not exists pg_trgm with schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

-- Las funciones nuevas NO deben ser ejecutables por anon/public por defecto.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema app revoke execute on functions from public, anon, authenticated;
-- Las tablas nuevas no se conceden a anon.
alter default privileges in schema public revoke all on tables from anon;

-- -----------------------------------------------------------------------------
-- Roles y permisos
-- -----------------------------------------------------------------------------
create table public.roles (
  code        text primary key check (code ~ '^[a-z_]+$'),
  name        text not null,
  description text not null default '',
  scope       text not null check (scope in ('staff', 'customer')),
  sort        int  not null default 0
);

create table public.permissions (
  code        text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
  name        text not null,
  module      text not null
);

create table public.role_permissions (
  role_code       text not null references public.roles(code) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_code, permission_code)
);

insert into public.roles (code, name, description, scope, sort) values
  ('master_admin',   'Administrador Master',    'Acceso completo a la plataforma de la empresa', 'staff', 1),
  ('ops_admin',      'Administrador operativo', 'Clientes, servicios, buques, bodegas, básculas e informes', 'staff', 2),
  ('supervisor',     'Supervisor',              'Supervisión de pesajes, tiempos perdidos y autorización de correcciones', 'staff', 3),
  ('scale_operator', 'Operador de báscula',     'Registro de pesajes en sus básculas autorizadas', 'staff', 4),
  ('analyst',        'Analista / Visualizador', 'Consulta de indicadores y reportes, solo lectura', 'staff', 5),
  ('signer',         'Firmante autorizado',     'Revisión y firma de reportes finales', 'staff', 6),
  ('customer',       'Cliente',                 'Acceso exclusivo a su expediente en el portal', 'customer', 7);

insert into public.permissions (code, name, module) values
  ('org.manage',            'Empresa, terminales y configuración general', 'Configuración'),
  ('users.manage',          'Gestión de usuarios internos',                'Usuarios'),
  ('permissions.manage',    'Gestión de roles y permisos',                 'Usuarios'),
  ('customers.view',        'Consultar cartera de clientes',               'Clientes'),
  ('customers.manage',      'Crear y editar clientes y documentos',        'Clientes'),
  ('portal_users.manage',   'Crear usuarios del portal del cliente',       'Clientes'),
  ('vessels.manage',        'Catálogo de buques y productos',              'Buques'),
  ('services.view',         'Consultar servicios y operaciones',           'Servicios'),
  ('services.manage',       'Crear servicios, bodegas y tonelajes',        'Servicios'),
  ('services.status',       'Cambiar estado operativo de servicios',       'Servicios'),
  ('services.close',        'Cierre operativo (finalizar servicio)',       'Servicios'),
  ('services.reopen',       'Reapertura autorizada de servicios',          'Servicios'),
  ('cargo.adjust',          'Ajuste auditado de tonelaje manifestado',     'Servicios'),
  ('scales.manage',         'Básculas y su configuración',                 'Básculas'),
  ('weighing.register',     'Registrar pesajes',                           'Básculas'),
  ('weighing.view_all',     'Consultar pesajes de todas las básculas',     'Básculas'),
  ('downtime.register',     'Registrar tiempos perdidos',                  'Tiempos perdidos'),
  ('downtime.manage',       'Catálogo de causas de tiempo perdido',        'Tiempos perdidos'),
  ('corrections.request',   'Solicitar correcciones',                      'Correcciones'),
  ('corrections.approve',   'Autorizar y aplicar correcciones',            'Correcciones'),
  ('productivity.view',     'Consultar productividad',                     'Productividad'),
  ('reports.view',          'Consultar reportes',                          'Reportes'),
  ('reports.generate',      'Generar y regenerar reportes',                'Reportes'),
  ('reports.sign',          'Firmar reportes finales',                     'Reportes'),
  ('signatures.manage',     'Configurar firmantes, firmas y sellos',       'Reportes'),
  ('audit.view',            'Consultar auditoría',                         'Auditoría');

insert into public.role_permissions (role_code, permission_code)
select 'master_admin', code from public.permissions;

insert into public.role_permissions (role_code, permission_code) values
  ('ops_admin','customers.view'),('ops_admin','customers.manage'),('ops_admin','portal_users.manage'),
  ('ops_admin','vessels.manage'),('ops_admin','services.view'),('ops_admin','services.manage'),
  ('ops_admin','services.status'),('ops_admin','services.close'),('ops_admin','services.reopen'),
  ('ops_admin','cargo.adjust'),('ops_admin','scales.manage'),('ops_admin','weighing.view_all'),
  ('ops_admin','downtime.register'),('ops_admin','downtime.manage'),('ops_admin','corrections.request'),
  ('ops_admin','productivity.view'),('ops_admin','reports.view'),('ops_admin','reports.generate'),
  ('ops_admin','audit.view'),
  ('supervisor','services.view'),('supervisor','weighing.view_all'),('supervisor','downtime.register'),
  ('supervisor','corrections.request'),('supervisor','corrections.approve'),('supervisor','productivity.view'),
  ('supervisor','reports.view'),('supervisor','services.status'),
  ('scale_operator','weighing.register'),('scale_operator','corrections.request'),
  ('analyst','customers.view'),('analyst','services.view'),('analyst','weighing.view_all'),
  ('analyst','productivity.view'),('analyst','reports.view'),
  ('signer','services.view'),('signer','productivity.view'),('signer','reports.view'),('signer','reports.sign');

-- -----------------------------------------------------------------------------
-- Organizaciones (empresas prestadoras del servicio = tenants)
-- -----------------------------------------------------------------------------
create table public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 160),
  legal_name  text,
  tax_id      text,
  country     text,
  address     text,
  phone       text,
  email       text,
  website     text,
  logo_path   text,
  status      text not null default 'active' check (status in ('active', 'inactive')),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create table public.terminals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code            text not null check (length(btrim(code)) between 1 and 30),
  name            text not null,
  port_name       text,
  address         text,
  timezone        text not null default 'America/Guatemala',
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index terminals_org_code_uq on public.terminals (organization_id, lower(btrim(code)));
create index terminals_org_idx on public.terminals (organization_id);

create or replace function app.validate_timezone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = new.timezone) then
    raise exception 'Zona horaria inválida: %', new.timezone using errcode = '22023';
  end if;
  return new;
end $$;
create trigger terminals_tz_chk before insert or update of timezone on public.terminals
  for each row execute function app.validate_timezone();

create table public.user_profiles (
  user_id                 uuid primary key references auth.users(id) on delete cascade,
  full_name               text not null default '',
  email                   text,
  phone                   text,
  position                text,
  kind                    text not null default 'staff' check (kind in ('staff', 'customer')),
  status                  text not null default 'active' check (status in ('active', 'inactive')),
  must_change_password    boolean not null default false,
  password_changed_at     timestamptz,
  last_seen_at            timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now()
);

create table public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  user_id           uuid not null references auth.users(id) on delete cascade,
  role_code         text not null references public.roles(code),
  status            text not null default 'active' check (status in ('active', 'inactive')),
  all_terminals     boolean not null default true,
  extra_permissions text[] not null default '{}',
  position          text,
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);

create or replace function app.check_member_role() returns trigger
language plpgsql set search_path = '' as $$
declare v_scope text;
begin
  select scope into v_scope from public.roles where code = new.role_code;
  if v_scope is distinct from 'staff' then
    raise exception 'El rol % no es un rol interno', new.role_code using errcode = '22023';
  end if;
  if exists (select 1 from unnest(new.extra_permissions) p
             where p not in (select code from public.permissions)) then
    raise exception 'Permiso adicional inválido' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger organization_members_role_chk before insert or update on public.organization_members
  for each row execute function app.check_member_role();

create table public.terminal_members (
  terminal_id     uuid not null references public.terminals(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (terminal_id, user_id)
);
create index terminal_members_user_idx on public.terminal_members (user_id);

-- Contraseñas temporales: se guarda el hash que GoTrue tenía al crear la cuenta,
-- para verificar en servidor que la contraseña realmente cambió.
create table app.pending_password_changes (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  initial_hash   text not null,
  created_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Configuración
-- -----------------------------------------------------------------------------
create table public.organization_settings (
  organization_id        uuid primary key references public.organizations(id) on delete cascade,
  default_timezone       text not null default 'America/Guatemala',
  weight_input_unit      text not null default 'kg' check (weight_input_unit in ('kg', 'tm')),
  report_footer          text not null default '',
  dpi_exposure_in_reports text not null default 'masked' check (dpi_exposure_in_reports in ('full', 'masked', 'hidden')),
  notify_customers_email boolean not null default true,
  updated_at             timestamptz not null default now()
);

create table public.terminal_settings (
  terminal_id       uuid primary key references public.terminals(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  time_capture_mode text not null default 'manual' check (time_capture_mode in ('manual', 'server_now')),
  updated_at        timestamptz not null default now()
);

create table public.operational_thresholds (
  organization_id              uuid primary key references public.organizations(id) on delete cascade,
  long_cycle_minutes           numeric(8,2) not null default 30 check (long_cycle_minutes > 0),
  max_cycle_hours              numeric(8,2) not null default 24 check (max_cycle_hours > 0),
  max_downtime_hours           numeric(8,2) not null default 96 check (max_downtime_hours > 0),
  max_net_kg                   numeric(12,2) not null default 80000 check (max_net_kg > 0),
  reconciliation_tolerance_tm  numeric(12,3) not null default 0.5 check (reconciliation_tolerance_tm >= 0),
  updated_at                   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Utilidades genéricas
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger organizations_touch before update on public.organizations for each row execute function app.touch_updated_at();
create trigger terminals_touch before update on public.terminals for each row execute function app.touch_updated_at();
create trigger user_profiles_touch before update on public.user_profiles for each row execute function app.touch_updated_at();
create trigger organization_members_touch before update on public.organization_members for each row execute function app.touch_updated_at();
create trigger organization_settings_touch before update on public.organization_settings for each row execute function app.touch_updated_at();
create trigger terminal_settings_touch before update on public.terminal_settings for each row execute function app.touch_updated_at();
create trigger operational_thresholds_touch before update on public.operational_thresholds for each row execute function app.touch_updated_at();

-- Bloqueo de borrado físico de información operativa crítica.
create or replace function app.prevent_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'No se permite eliminar físicamente registros de %. Use anulación o desactivación.', tg_table_name
    using errcode = '42501';
end $$;

-- -----------------------------------------------------------------------------
-- Helpers de autorización (SECURITY DEFINER, search_path vacío, solo lectura).
-- Devuelven CONJUNTOS para usarse como `col in (select app.fn())` → se evalúan
-- una sola vez por consulta (initplan) en lugar de una vez por fila.
-- Todos exigen: perfil activo, contraseña temporal ya cambiada y membresía activa.
-- -----------------------------------------------------------------------------
create or replace function app.uid() returns uuid
language sql stable set search_path = '' as $$ select auth.uid() $$;

create or replace function app.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_profiles p
    where p.user_id = (select auth.uid())
      and p.status = 'active'
      and p.must_change_password = false
  )
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins a where a.user_id = (select auth.uid()))
     and app.is_active_user()
$$;

create or replace function app.my_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.organization_id
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  where m.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
$$;

create or replace function app.member_permissions(p_org uuid) returns setof text
language sql stable security definer set search_path = '' as $$
  select rp.permission_code
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  join public.role_permissions rp on rp.role_code = m.role_code
  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'
    and app.is_active_user()
  union
  select unnest(m.extra_permissions)
  from public.organization_members m
  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active'
    and app.is_active_user()
$$;

create or replace function app.has_perm(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.member_permissions(p_org) x where x = p_perm)
$$;

create or replace function app.orgs_with_perm(p_perm text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.organization_id
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id and o.status = 'active'
  where m.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
    and (
      exists (select 1 from public.role_permissions rp where rp.role_code = m.role_code and rp.permission_code = p_perm)
      or p_perm = any (m.extra_permissions)
    )
$$;

-- Terminales accesibles por el usuario (miembro activo y con alcance a esa terminal).
create or replace function app.my_terminal_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id
  from public.terminals t
  join public.organization_members m on m.organization_id = t.organization_id
  join public.organizations o on o.id = t.organization_id and o.status = 'active'
  where m.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
    and (m.all_terminals or m.role_code = 'master_admin'
         or exists (select 1 from public.terminal_members tm where tm.terminal_id = t.id and tm.user_id = m.user_id))
$$;

-- Terminales donde el usuario tiene un permiso concreto.
create or replace function app.terminals_with_perm(p_perm text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select t.id
  from public.terminals t
  join public.organization_members m on m.organization_id = t.organization_id
  join public.organizations o on o.id = t.organization_id and o.status = 'active'
  where m.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
    and (m.all_terminals or m.role_code = 'master_admin'
         or exists (select 1 from public.terminal_members tm where tm.terminal_id = t.id and tm.user_id = m.user_id))
    and (
      exists (select 1 from public.role_permissions rp where rp.role_code = m.role_code and rp.permission_code = p_perm)
      or p_perm = any (m.extra_permissions)
    )
$$;

create or replace function app.has_terminal_perm(p_terminal uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.terminals_with_perm(p_perm) x where x = p_terminal)
$$;

grant execute on function app.uid(), app.is_active_user(), app.is_platform_admin(), app.my_org_ids(),
  app.member_permissions(uuid), app.has_perm(uuid, text), app.orgs_with_perm(text),
  app.my_terminal_ids(), app.terminals_with_perm(text), app.has_terminal_perm(uuid, text)
  to authenticated, service_role;

-- Exige un permiso o aborta con 42501 (usado por las RPC privilegiadas).
create or replace function app.require_terminal_perm(p_terminal uuid, p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not app.has_terminal_perm(p_terminal, p_perm) then
    raise exception 'Permiso insuficiente (%)', p_perm using errcode = '42501';
  end if;
end $$;

create or replace function app.require_org_perm(p_org uuid, p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not app.has_perm(p_org, p_perm) then
    raise exception 'Permiso insuficiente (%)', p_perm using errcode = '42501';
  end if;
end $$;
grant execute on function app.require_terminal_perm(uuid, text), app.require_org_perm(uuid, text) to authenticated, service_role;

create or replace function app.actor_name() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(p.full_name, ''), p.email, 'sistema')
  from public.user_profiles p where p.user_id = (select auth.uid())
$$;
grant execute on function app.actor_name() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Auditoría
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid,
  terminal_id     uuid,
  table_name      text not null,
  record_id       text,
  action          text not null,
  actor_id        uuid,
  actor_name      text,
  reason          text,
  changed_fields  text[],
  old_data        jsonb,
  new_data        jsonb,
  created_at      timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_record_idx on public.audit_logs (table_name, record_id);

create or replace function app.audit_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb; v_new jsonb; v_fields text[]; v_org uuid; v_term uuid; v_id text;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(k) into v_fields
    from jsonb_object_keys(v_new) k
    where k not in ('updated_at') and (v_new -> k) is distinct from (v_old -> k);
    if v_fields is null then return new; end if;
  end if;
  v_org := coalesce((v_new ->> 'organization_id')::uuid, (v_old ->> 'organization_id')::uuid,
                    case when tg_table_name = 'organizations' then coalesce((v_new->>'id')::uuid, (v_old->>'id')::uuid) end);
  v_term := coalesce((v_new ->> 'terminal_id')::uuid, (v_old ->> 'terminal_id')::uuid);
  v_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'user_id', v_old ->> 'user_id',
                   v_new ->> 'organization_id', v_new ->> 'terminal_id', v_new ->> 'scale_id');
  insert into public.audit_logs (organization_id, terminal_id, table_name, record_id, action, actor_id, actor_name,
                                 reason, changed_fields, old_data, new_data)
  values (v_org, v_term, tg_table_name, v_id, tg_op, auth.uid(), app.actor_name(),
          nullif(current_setting('app.reason', true), ''), v_fields, v_old, v_new);
  return coalesce(new, old);
end $$;

create or replace function app.set_reason(p_reason text) returns void
language sql set search_path = '' as $$ select set_config('app.reason', coalesce(p_reason, ''), true) $$;
grant execute on function app.set_reason(text) to authenticated, service_role;

create trigger audit_organizations after insert or update on public.organizations for each row execute function app.audit_trigger();
create trigger audit_terminals after insert or update on public.terminals for each row execute function app.audit_trigger();
create trigger audit_organization_members after insert or update or delete on public.organization_members for each row execute function app.audit_trigger();
create trigger audit_terminal_members after insert or delete on public.terminal_members for each row execute function app.audit_trigger();
create trigger audit_organization_settings after insert or update on public.organization_settings for each row execute function app.audit_trigger();
create trigger audit_terminal_settings after insert or update on public.terminal_settings for each row execute function app.audit_trigger();
create trigger audit_operational_thresholds after insert or update on public.operational_thresholds for each row execute function app.audit_trigger();
create trigger audit_logs_no_delete before delete or update on public.audit_logs for each row execute function app.prevent_delete();
create trigger organizations_no_delete before delete on public.organizations for each row execute function app.prevent_delete();
