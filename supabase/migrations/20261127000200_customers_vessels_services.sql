-- =============================================================================
-- VESSEL CONTROL · Migración 002 · Clientes, buques, productos, servicios, básculas
-- Pesos y tonelajes: NUMERIC. Fechas: TIMESTAMPTZ (UTC). Identificadores: UUID.
-- organization_id / terminal_id se desnormalizan en tablas hijas y se FIJAN desde
-- el padre mediante triggers (el cliente no puede falsificarlos).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Clientes
-- -----------------------------------------------------------------------------
create table public.customers (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  code              text not null check (length(btrim(code)) between 1 and 30),
  trade_name        text not null check (length(btrim(trade_name)) between 2 and 160),
  legal_name        text,
  tax_id            text,
  country           text,
  address           text,
  main_contact      text,
  representative    text,
  email             text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone             text,
  status            text not null default 'active' check (status in ('active', 'inactive')),
  notes             text,
  logo_path         text,
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);
create unique index customers_org_code_uq on public.customers (organization_id, lower(btrim(code)));
create index customers_org_name_idx on public.customers (organization_id, lower(trade_name));
create index customers_name_trgm on public.customers using gin (trade_name extensions.gin_trgm_ops);

create table public.customer_contacts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  customer_id     uuid not null references public.customers(id) on delete cascade,
  full_name       text not null,
  position        text,
  email           text,
  phone           text,
  is_primary      boolean not null default false,
  created_at      timestamptz not null default now()
);
create index customer_contacts_customer_idx on public.customer_contacts (customer_id);

create table public.customer_users (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  customer_id     uuid not null references public.customers(id) on delete restrict,
  user_id         uuid not null references auth.users(id) on delete cascade,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (customer_id, user_id)
);
create index customer_users_user_idx on public.customer_users (user_id);

create table public.customer_portal_permissions (
  customer_user_id      uuid primary key references public.customer_users(id) on delete cascade,
  organization_id       uuid not null references public.organizations(id) on delete restrict,
  customer_id           uuid not null references public.customers(id) on delete restrict,
  can_view_reports      boolean not null default true,
  can_download_reports  boolean not null default true,
  can_view_documents    boolean not null default true,
  can_view_productivity boolean not null default true,
  updated_at            timestamptz not null default now()
);

-- Clientes a los que pertenece el usuario autenticado (portal).
create or replace function app.my_customer_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cu.customer_id
  from public.customer_users cu
  join public.customers c on c.id = cu.customer_id and c.status = 'active'
  join public.organizations o on o.id = cu.organization_id and o.status = 'active'
  where cu.user_id = (select auth.uid()) and cu.status = 'active' and app.is_active_user()
$$;

create or replace function app.my_customer_ids_with(p_flag text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select cu.customer_id
  from public.customer_users cu
  join public.customers c on c.id = cu.customer_id and c.status = 'active'
  join public.organizations o on o.id = cu.organization_id and o.status = 'active'
  left join public.customer_portal_permissions pp on pp.customer_user_id = cu.id
  where cu.user_id = (select auth.uid()) and cu.status = 'active' and app.is_active_user()
    and case p_flag
          when 'reports'      then coalesce(pp.can_view_reports, true)
          when 'download'     then coalesce(pp.can_download_reports, true)
          when 'documents'    then coalesce(pp.can_view_documents, true)
          when 'productivity' then coalesce(pp.can_view_productivity, true)
          else false end
$$;

create or replace function app.my_customer_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.organization_id from public.customers c where c.id in (select app.my_customer_ids())
$$;
grant execute on function app.my_customer_ids(), app.my_customer_ids_with(text), app.my_customer_org_ids() to authenticated, service_role;

create table public.customer_documents (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  service_id          uuid,
  title               text not null check (length(btrim(title)) between 2 and 200),
  category            text not null default 'General',
  storage_path        text not null unique,
  mime_type           text,
  size_bytes          bigint check (size_bytes is null or size_bytes >= 0),
  visible_to_customer boolean not null default false,
  status              text not null default 'active' check (status in ('active', 'archived')),
  uploaded_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index customer_documents_customer_idx on public.customer_documents (customer_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Buques y productos (catálogos por organización)
-- -----------------------------------------------------------------------------
create table public.vessels (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 120),
  imo_number      text check (imo_number is null or imo_number ~ '^[0-9]{7}$'),
  vessel_type     text not null default 'Granelero',
  flag            text,
  capacity_tm     numeric(14,3) check (capacity_tm is null or capacity_tm > 0),
  holds_count     int not null default 1 check (holds_count between 1 and 30),
  notes           text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now()
);
create unique index vessels_org_imo_uq on public.vessels (organization_id, imo_number) where imo_number is not null;
create index vessels_org_name_idx on public.vessels (organization_id, lower(name));

create table public.vessel_holds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  vessel_id       uuid not null references public.vessels(id) on delete cascade,
  hold_number     int  not null check (hold_number between 1 and 30),
  capacity_tm     numeric(14,3) check (capacity_tm is null or capacity_tm > 0),
  created_at      timestamptz not null default now(),
  unique (vessel_id, hold_number)
);

create table public.products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  code            text,
  name            text not null check (length(btrim(name)) between 2 and 80),
  color           text not null default '#1874a8' check (color ~* '^#[0-9a-f]{6}$'),
  description     text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index products_org_name_uq on public.products (organization_id, lower(btrim(name)));

-- -----------------------------------------------------------------------------
-- Servicios de descarga
-- -----------------------------------------------------------------------------
create table public.services (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  terminal_id          uuid not null references public.terminals(id) on delete restrict,
  customer_id          uuid not null references public.customers(id) on delete restrict,
  vessel_id            uuid not null references public.vessels(id) on delete restrict,
  -- Número comercial ingresado MANUALMENTE (nunca generado por el sistema).
  service_number       text not null check (length(btrim(service_number)) between 1 and 40 and service_number = btrim(service_number)),
  status               text not null default 'scheduled'
                       check (status in ('scheduled','preparing','in_operation','suspended','closing','finalized','cancelled')),
  planned_start        timestamptz,
  estimated_end        timestamptz,
  actual_start         timestamptz,
  finalized_at         timestamptz,
  responsible_user_id  uuid references auth.users(id) on delete set null,
  responsible_name     text,
  observations         text,
  closure_note         text,
  data_revision        int not null default 0,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  check (estimated_end is null or planned_start is null or estimated_end >= planned_start)
);
-- Unicidad del número de servicio dentro de la empresa (sin distinguir mayúsculas).
create unique index services_org_number_uq on public.services (organization_id, lower(service_number));
create index services_terminal_status_idx on public.services (terminal_id, status);
create index services_customer_idx on public.services (customer_id, created_at desc);
create index services_vessel_idx on public.services (vessel_id);
create index services_number_trgm on public.services using gin (service_number extensions.gin_trgm_ops);

-- Valida que cliente, buque y terminal pertenecen a la misma organización.
create or replace function app.services_scope_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.terminals where id = new.terminal_id and organization_id = new.organization_id) then
    raise exception 'La terminal no pertenece a la empresa' using errcode = '23514'; end if;
  if not exists (select 1 from public.customers where id = new.customer_id and organization_id = new.organization_id) then
    raise exception 'El cliente no pertenece a la empresa' using errcode = '23514'; end if;
  if not exists (select 1 from public.vessels where id = new.vessel_id and organization_id = new.organization_id) then
    raise exception 'El buque no pertenece a la empresa' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and (new.organization_id <> old.organization_id) then
    raise exception 'No se puede cambiar la empresa de un servicio' using errcode = '23514'; end if;
  return new;
end $$;
create trigger services_scope before insert or update on public.services
  for each row execute function app.services_scope_chk();

-- Hereda organization_id / terminal_id del servicio padre (no confiables desde el cliente).
create or replace function app.inherit_service_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_term uuid;
begin
  if tg_op = 'UPDATE' and new.service_id is distinct from old.service_id then
    raise exception 'No se puede mover el registro a otro servicio' using errcode = '23514';
  end if;
  select organization_id, terminal_id into v_org, v_term from public.services where id = new.service_id;
  if v_org is null then raise exception 'Servicio inexistente' using errcode = '23503'; end if;
  new.organization_id := v_org;
  new.terminal_id := v_term;
  return new;
end $$;

-- Básculas que operan un servicio (una operación usa varias básculas a la vez).
create table public.scales (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  code            text not null check (length(btrim(code)) between 1 and 30),
  name            text not null,
  location        text,
  status          text not null default 'active' check (status in ('active', 'maintenance', 'inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index scales_terminal_code_uq on public.scales (terminal_id, lower(btrim(code)));

create or replace function app.inherit_terminal_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.terminals where id = new.terminal_id;
  if v_org is null then raise exception 'Terminal inexistente' using errcode = '23503'; end if;
  new.organization_id := v_org;
  return new;
end $$;
create trigger scales_scope before insert or update of terminal_id on public.scales
  for each row execute function app.inherit_terminal_scope();
create trigger terminal_settings_scope before insert or update of terminal_id on public.terminal_settings
  for each row execute function app.inherit_terminal_scope();
create trigger terminal_members_scope before insert or update of terminal_id on public.terminal_members
  for each row execute function app.inherit_terminal_scope();

create table public.scale_settings (
  scale_id          uuid primary key references public.scales(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  terminal_id       uuid not null references public.terminals(id) on delete restrict,
  -- null = hereda la modalidad de la terminal
  time_capture_mode text check (time_capture_mode is null or time_capture_mode in ('manual', 'server_now')),
  updated_at        timestamptz not null default now()
);

create table public.scale_users (
  scale_id        uuid not null references public.scales(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (scale_id, user_id)
);
create index scale_users_user_idx on public.scale_users (user_id);

create or replace function app.inherit_scale_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_term uuid;
begin
  select organization_id, terminal_id into v_org, v_term from public.scales where id = new.scale_id;
  if v_org is null then raise exception 'Báscula inexistente' using errcode = '23503'; end if;
  new.organization_id := v_org; new.terminal_id := v_term;
  return new;
end $$;
create trigger scale_settings_scope before insert or update on public.scale_settings
  for each row execute function app.inherit_scale_scope();
create trigger scale_users_scope before insert or update on public.scale_users
  for each row execute function app.inherit_scale_scope();

create table public.service_scales (
  service_id      uuid not null references public.services(id) on delete restrict,
  scale_id        uuid not null references public.scales(id) on delete restrict,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (service_id, scale_id)
);
create index service_scales_scale_idx on public.service_scales (scale_id);
create trigger service_scales_scope before insert or update on public.service_scales
  for each row execute function app.inherit_service_scope();

create or replace function app.service_scales_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.scales s where s.id = new.scale_id and s.terminal_id = new.terminal_id) then
    raise exception 'La báscula no pertenece a la terminal del servicio' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger service_scales_chk after insert or update on public.service_scales
  for each row execute function app.service_scales_chk();

-- Básculas autorizadas para el usuario y servicios visibles por un operador de báscula.
create or replace function app.my_scale_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select su.scale_id
  from public.scale_users su
  join public.organization_members m on m.organization_id = su.organization_id and m.user_id = su.user_id
  where su.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
$$;

create or replace function app.my_operator_service_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select ss.service_id from public.service_scales ss where ss.scale_id in (select app.my_scale_ids())
$$;
grant execute on function app.my_scale_ids(), app.my_operator_service_ids() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Bodegas del servicio y carga por bodega/producto (saldos individuales)
-- -----------------------------------------------------------------------------
create table public.service_holds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  vessel_id       uuid not null references public.vessels(id) on delete restrict,
  vessel_hold_id  uuid references public.vessel_holds(id) on delete set null,
  hold_number     int  not null check (hold_number between 1 and 30),
  capacity_tm     numeric(14,3) check (capacity_tm is null or capacity_tm > 0),
  created_at      timestamptz not null default now(),
  unique (service_id, vessel_id, hold_number)
);
create index service_holds_service_idx on public.service_holds (service_id);
create trigger service_holds_scope before insert or update on public.service_holds
  for each row execute function app.inherit_service_scope();

create or replace function app.service_holds_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.vessels v where v.id = new.vessel_id and v.organization_id = new.organization_id) then
    raise exception 'El buque de la bodega no pertenece a la empresa' using errcode = '23514'; end if;
  return new;
end $$;
create trigger service_holds_zchk before insert or update on public.service_holds
  for each row execute function app.service_holds_chk();

create table public.service_hold_cargo (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  service_hold_id uuid not null references public.service_holds(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete restrict,
  initial_tm      numeric(14,3) not null check (initial_tm > 0),
  -- Saldo acumulado: SOLO lo modifican las funciones transaccionales (ledger).
  discharged_tm   numeric(14,3) not null default 0,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (service_hold_id, product_id),
  constraint service_hold_cargo_no_negative check (discharged_tm >= 0 and discharged_tm <= initial_tm)
);
create index service_hold_cargo_service_idx on public.service_hold_cargo (service_id);
create trigger service_hold_cargo_scope before insert or update on public.service_hold_cargo
  for each row execute function app.inherit_service_scope();

create or replace function app.service_hold_cargo_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.service_holds h where h.id = new.service_hold_id and h.service_id = new.service_id) then
    raise exception 'La bodega no pertenece al servicio' using errcode = '23514'; end if;
  if not exists (select 1 from public.products p where p.id = new.product_id and p.organization_id = new.organization_id) then
    raise exception 'El producto no pertenece a la empresa' using errcode = '23514'; end if;
  -- El saldo acumulado nunca se edita directamente (solo vía ledger con app.ledger_write).
  if tg_op = 'INSERT' and new.discharged_tm <> 0 then
    raise exception 'El tonelaje descargado inicia en cero' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and new.discharged_tm is distinct from old.discharged_tm
     and coalesce(current_setting('app.ledger_write', true), '') <> 'on' then
    raise exception 'El saldo descargado solo cambia mediante pesajes, anulaciones o correcciones auditadas' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and new.initial_tm is distinct from old.initial_tm
     and coalesce(current_setting('app.ledger_write', true), '') <> 'on' then
    if exists (select 1 from public.cargo_movements m where m.cargo_id = new.id) then
      raise exception 'El tonelaje inicial con pesajes registrados solo se modifica con un ajuste auditado' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Transporte (catálogos alimentados desde los pesajes)
-- -----------------------------------------------------------------------------
create table public.trucks (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  plate                text not null check (plate = upper(btrim(plate)) and length(plate) between 2 and 20),
  nominal_capacity_tm  numeric(8,3) check (nominal_capacity_tm is null or nominal_capacity_tm > 0),
  carrier              text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (organization_id, plate)
);
create index trucks_plate_trgm on public.trucks using gin (plate extensions.gin_trgm_ops);

create table public.tractors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  plate           text not null check (plate = upper(btrim(plate)) and length(plate) between 2 and 20),
  created_at      timestamptz not null default now(),
  unique (organization_id, plate)
);

create table public.drivers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  dpi             text not null check (dpi ~ '^[0-9]{13}$'),
  full_name       text not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, dpi)
);

-- -----------------------------------------------------------------------------
-- Turnos por terminal
-- -----------------------------------------------------------------------------
create table public.shifts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete cascade,
  name            text not null,
  start_time      time not null,
  end_time        time not null check (end_time <> start_time),
  sort            int not null default 0,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now()
);
create index shifts_terminal_idx on public.shifts (terminal_id);
create trigger shifts_scope before insert or update of terminal_id on public.shifts
  for each row execute function app.inherit_terminal_scope();

-- Turno correspondiente a un instante en la hora local de la terminal (maneja medianoche).
create or replace function app.shift_for(p_terminal uuid, p_ts timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
  select s.id
  from public.shifts s
  join public.terminals t on t.id = s.terminal_id
  cross join lateral (select (p_ts at time zone t.timezone)::time as lt) x
  where s.terminal_id = p_terminal and s.status = 'active'
    and case when s.start_time < s.end_time
             then x.lt >= s.start_time and x.lt < s.end_time
             else x.lt >= s.start_time or x.lt < s.end_time end
  order by s.sort
  limit 1
$$;

create or replace function app.local_date(p_terminal uuid, p_ts timestamptz) returns date
language sql stable security definer set search_path = '' as $$
  select (p_ts at time zone t.timezone)::date from public.terminals t where t.id = p_terminal
$$;
grant execute on function app.shift_for(uuid, timestamptz), app.local_date(uuid, timestamptz) to authenticated, service_role;

-- updated_at
create trigger customers_touch before update on public.customers for each row execute function app.touch_updated_at();
create trigger customer_users_touch before update on public.customer_users for each row execute function app.touch_updated_at();
create trigger customer_portal_permissions_touch before update on public.customer_portal_permissions for each row execute function app.touch_updated_at();
create trigger customer_documents_touch before update on public.customer_documents for each row execute function app.touch_updated_at();
create trigger vessels_touch before update on public.vessels for each row execute function app.touch_updated_at();
create trigger products_touch before update on public.products for each row execute function app.touch_updated_at();
create trigger services_touch before update on public.services for each row execute function app.touch_updated_at();
create trigger scales_touch before update on public.scales for each row execute function app.touch_updated_at();
create trigger scale_settings_touch before update on public.scale_settings for each row execute function app.touch_updated_at();
create trigger service_hold_cargo_touch before update on public.service_hold_cargo for each row execute function app.touch_updated_at();
create trigger trucks_touch before update on public.trucks for each row execute function app.touch_updated_at();
create trigger drivers_touch before update on public.drivers for each row execute function app.touch_updated_at();

-- Herencia de organización desde el cliente / buque padre
create or replace function app.inherit_customer_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.customers where id = new.customer_id;
  if v_org is null then raise exception 'Cliente inexistente' using errcode = '23503'; end if;
  new.organization_id := v_org;
  return new;
end $$;
create trigger customer_contacts_scope before insert or update on public.customer_contacts for each row execute function app.inherit_customer_scope();
create trigger customer_users_scope before insert or update on public.customer_users for each row execute function app.inherit_customer_scope();
create trigger customer_documents_scope before insert or update on public.customer_documents for each row execute function app.inherit_customer_scope();

create or replace function app.customer_portal_permissions_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select organization_id, customer_id into new.organization_id, new.customer_id
  from public.customer_users where id = new.customer_user_id;
  if new.organization_id is null then raise exception 'Usuario de cliente inexistente' using errcode = '23503'; end if;
  return new;
end $$;
create trigger customer_portal_permissions_scope before insert or update on public.customer_portal_permissions
  for each row execute function app.customer_portal_permissions_scope();

create or replace function app.inherit_vessel_scope() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.vessels where id = new.vessel_id;
  if v_org is null then raise exception 'Buque inexistente' using errcode = '23503'; end if;
  new.organization_id := v_org;
  return new;
end $$;
create trigger vessel_holds_scope before insert or update on public.vessel_holds for each row execute function app.inherit_vessel_scope();

-- Auditoría de catálogos y configuración operativa
create trigger audit_customers after insert or update on public.customers for each row execute function app.audit_trigger();
create trigger audit_customer_users after insert or update on public.customer_users for each row execute function app.audit_trigger();
create trigger audit_customer_portal_permissions after insert or update on public.customer_portal_permissions for each row execute function app.audit_trigger();
create trigger audit_customer_documents after insert or update on public.customer_documents for each row execute function app.audit_trigger();
create trigger audit_vessels after insert or update on public.vessels for each row execute function app.audit_trigger();
create trigger audit_products after insert or update on public.products for each row execute function app.audit_trigger();
create trigger audit_services after insert or update on public.services for each row execute function app.audit_trigger();
create trigger audit_service_holds after insert or update or delete on public.service_holds for each row execute function app.audit_trigger();
create trigger audit_service_hold_cargo after insert or update or delete on public.service_hold_cargo for each row execute function app.audit_trigger();
create trigger audit_service_scales after insert or delete on public.service_scales for each row execute function app.audit_trigger();
create trigger audit_scales after insert or update on public.scales for each row execute function app.audit_trigger();
create trigger audit_scale_settings after insert or update on public.scale_settings for each row execute function app.audit_trigger();
create trigger audit_scale_users after insert or delete on public.scale_users for each row execute function app.audit_trigger();
create trigger audit_shifts after insert or update on public.shifts for each row execute function app.audit_trigger();

create trigger services_no_delete before delete on public.services for each row execute function app.prevent_delete();
create trigger customers_no_delete before delete on public.customers for each row execute function app.prevent_delete();
