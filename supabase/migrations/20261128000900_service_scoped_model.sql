-- =============================================================================
-- VESSEL CONTROL · Migración 009 · Modelo definido por servicio
-- · El buque, sus bodegas (1 a 6), los productos, los BL y la presentación
--   (granel o sacos) se definen al crear cada servicio.
-- · Camiones y pilotos por servicio: cada servicio tiene su propia lista.
-- · Básculas / puntos de descarga elegidos o creados al crear el servicio.
-- · Pesaje con UNA sola hora. El ciclo es el tiempo entre dos pasadas
--   consecutivas del mismo camión en el mismo servicio.
-- · Tiempos perdidos: los eventos «Otros» exigen describir lo ocurrido.
-- =============================================================================

-- ---------------------------------------------------------------- servicio: presentación de la carga
alter table public.services
  add column cargo_type text not null default 'bulk' check (cargo_type in ('bulk', 'bags'));

-- ---------------------------------------------------------------- productos del servicio
create table public.service_products (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete restrict,
  -- Solo para carga en sacos: peso de cada saco (permite contar unidades).
  bag_weight_kg   numeric(10,3) check (bag_weight_kg is null or bag_weight_kg > 0),
  -- Tara general del saco según la presentación (para la verificación del peso de sacos).
  bag_tare_kg     numeric(8,3) check (bag_tare_kg is null or bag_tare_kg >= 0),
  uses_bl         boolean not null default false,
  sort            int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (service_id, product_id)
);
create index service_products_product_idx on public.service_products (product_id);
create trigger service_products_scope before insert or update on public.service_products
  for each row execute function app.inherit_service_scope();

create or replace function app.service_products_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.products p where p.id = new.product_id and p.organization_id = new.organization_id) then
    raise exception 'El producto no pertenece a la empresa' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and new.product_id <> old.product_id then
    raise exception 'No se puede cambiar el producto; agregue uno nuevo' using errcode = '23514'; end if;
  return new;
end $$;
create trigger service_products_zchk before insert or update on public.service_products
  for each row execute function app.service_products_chk();

-- Toda línea de carga (bodega × producto) tiene su producto de servicio.
create or replace function app.ensure_service_product() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.service_products (organization_id, terminal_id, service_id, product_id)
  values (new.organization_id, new.terminal_id, new.service_id, new.product_id)
  on conflict (service_id, product_id) do nothing;
  return null;
end $$;

-- ---------------------------------------------------------------- BL (bill of lading) por producto
create table public.service_bls (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  terminal_id        uuid not null references public.terminals(id) on delete restrict,
  service_id         uuid not null references public.services(id) on delete restrict,
  service_product_id uuid not null references public.service_products(id) on delete restrict,
  product_id         uuid not null references public.products(id) on delete restrict,
  bl_number          text not null check (length(btrim(bl_number)) between 1 and 60 and bl_number = btrim(bl_number)),
  planned_tm         numeric(14,3) not null check (planned_tm > 0),
  -- Acumulado descargado: SOLO lo modifican las funciones del ledger.
  discharged_tm      numeric(14,3) not null default 0 check (discharged_tm >= 0),
  status             text not null default 'open' check (status in ('open', 'completed')),
  sort               int not null default 0,
  completed_at       timestamptz,
  completed_by       uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  created_by         uuid references auth.users(id) on delete set null,
  updated_at         timestamptz not null default now()
);
create unique index service_bls_number_uq on public.service_bls (service_id, lower(bl_number));
create index service_bls_product_idx on public.service_bls (service_product_id);
create trigger service_bls_scope before insert or update on public.service_bls
  for each row execute function app.inherit_service_scope();

create or replace function app.service_bls_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.service_products sp where sp.id = new.service_product_id
                   and sp.service_id = new.service_id and sp.product_id = new.product_id) then
    raise exception 'El BL no corresponde a un producto del servicio' using errcode = '23514'; end if;
  if tg_op = 'INSERT' and new.discharged_tm <> 0 then
    raise exception 'El BL inicia sin descargas' using errcode = '42501'; end if;
  if tg_op = 'UPDATE' and new.discharged_tm is distinct from old.discharged_tm
     and coalesce(current_setting('app.ledger_write', true), '') <> 'on' then
    raise exception 'Lo descargado por BL solo cambia mediante pesajes, anulaciones o correcciones auditadas' using errcode = '42501'; end if;
  return new;
end $$;
create trigger service_bls_zchk before insert or update on public.service_bls
  for each row execute function app.service_bls_chk();

-- ---------------------------------------------------------------- camiones y pilotos del servicio
create table public.service_trucks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  plate           text not null check (plate = upper(btrim(plate)) and length(plate) between 2 and 20),
  tractor_plate   text check (tractor_plate is null or (tractor_plate = upper(btrim(tractor_plate)) and length(tractor_plate) between 2 and 20)),
  driver_name     text not null check (length(btrim(driver_name)) between 2 and 120),
  driver_dpi      text check (driver_dpi is null or driver_dpi ~ '^[0-9]{13}$'),
  carrier         text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  unique (service_id, plate)
);
create index service_trucks_plate_trgm on public.service_trucks using gin (plate extensions.gin_trgm_ops);
create trigger service_trucks_scope before insert or update on public.service_trucks
  for each row execute function app.inherit_service_scope();

-- ---------------------------------------------------------------- pesajes: una sola hora y ciclo entre pasadas
drop view if exists public.operational_cycles;
alter table public.weigh_tickets disable trigger user;

alter table public.weigh_tickets
  add column weighed_at       timestamptz,
  add column bl_id            uuid references public.service_bls(id) on delete restrict,
  add column service_truck_id uuid references public.service_trucks(id) on delete restrict,
  add column prev_ticket_id   uuid references public.weigh_tickets(id) on delete restrict;
update public.weigh_tickets set weighed_at = started_at;
alter table public.weigh_tickets alter column weighed_at set not null;
alter table public.weigh_tickets drop constraint weigh_tickets_times;
alter table public.weigh_tickets drop column cycle_seconds;
alter table public.weigh_tickets drop column started_at, drop column ended_at;
-- Segundos desde la pasada anterior del mismo camión en el servicio (null en la primera
-- pasada o si el intervalo supera el máximo configurado). Lo mantiene un disparador.
alter table public.weigh_tickets add column cycle_seconds numeric(12,0) check (cycle_seconds is null or cycle_seconds >= 0);
-- El DPI del piloto es opcional (la lista de camiones del servicio lo puede incluir).
alter table public.weigh_tickets alter column driver_dpi drop not null;
alter table public.weigh_tickets drop constraint weigh_tickets_driver_dpi_check;
alter table public.weigh_tickets add constraint weigh_tickets_driver_dpi_check check (driver_dpi is null or driver_dpi ~ '^[0-9]{13}$');

-- Boleta única por servicio y báscula/punto entre los registros válidos.
drop index if exists public.weigh_tickets_scale_number_uq;
create unique index weigh_tickets_service_scale_number_uq on public.weigh_tickets (service_id, scale_id, lower(ticket_number)) where status = 'valid';
create index weigh_tickets_service_weighed_idx on public.weigh_tickets (service_id, weighed_at desc, id desc);
create index weigh_tickets_terminal_weighed_idx on public.weigh_tickets (terminal_id, weighed_at desc, id desc);
create index weigh_tickets_org_weighed_idx on public.weigh_tickets (organization_id, weighed_at desc);
create index weigh_tickets_scale_weighed_idx on public.weigh_tickets (scale_id, weighed_at desc);
create index weigh_tickets_customer_weighed_idx on public.weigh_tickets (customer_id, weighed_at desc);
create index weigh_tickets_truck_pass_idx on public.weigh_tickets (service_id, truck_plate, weighed_at);
create index weigh_tickets_bl_idx on public.weigh_tickets (bl_id);
create index weigh_tickets_service_truck_idx on public.weigh_tickets (service_truck_id);
create index weigh_tickets_prev_idx on public.weigh_tickets (prev_ticket_id);

alter table public.cargo_movements add column bl_id uuid references public.service_bls(id) on delete restrict;
create index cargo_movements_bl_idx on public.cargo_movements (bl_id);

-- Recalcula los ciclos de un camión dentro de un servicio (orden por hora de pesaje).
create or replace function app.recompute_truck_cycles(p_service uuid, p_plate text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_max numeric;
begin
  if p_service is null or p_plate is null then return; end if;
  -- Serializa recálculos concurrentes del mismo camión (pesajes simultáneos en dos básculas).
  perform pg_advisory_xact_lock(hashtextextended(p_service::text || '|' || p_plate, 0));
  select coalesce(o.max_cycle_hours, 24) into v_max
    from public.services s left join public.operational_thresholds o on o.organization_id = s.organization_id
   where s.id = p_service;
  with ord as (
    select t.id, t.weighed_at, lag(t.id) over w as prev_id, lag(t.weighed_at) over w as prev_at
    from public.weigh_tickets t
    where t.service_id = p_service and t.truck_plate = p_plate and t.status = 'valid'
    window w as (order by t.weighed_at, t.registered_at, t.id)
  ), calc as (
    select id, prev_id,
           case when prev_at is null then null
                when extract(epoch from (weighed_at - prev_at)) > coalesce(v_max, 24) * 3600 then null
                else round(extract(epoch from (weighed_at - prev_at))) end as secs
    from ord
  )
  update public.weigh_tickets t set prev_ticket_id = c.prev_id, cycle_seconds = c.secs
  from calc c
  where t.id = c.id and (t.prev_ticket_id is distinct from c.prev_id or t.cycle_seconds is distinct from c.secs);
  update public.weigh_tickets t set prev_ticket_id = null, cycle_seconds = null
  where t.service_id = p_service and t.truck_plate = p_plate and t.status <> 'valid'
    and (t.prev_ticket_id is not null or t.cycle_seconds is not null);
end $$;

-- Datos existentes: productos del servicio, lista de camiones y ciclos.
insert into public.service_products (organization_id, terminal_id, service_id, product_id)
select distinct c.organization_id, c.terminal_id, c.service_id, c.product_id from public.service_hold_cargo c
on conflict (service_id, product_id) do nothing;

insert into public.service_trucks (organization_id, terminal_id, service_id, plate, tractor_plate, driver_name, driver_dpi)
select distinct on (t.service_id, t.truck_plate) t.organization_id, t.terminal_id, t.service_id, t.truck_plate, t.tractor_plate,
       case when length(btrim(t.driver_name)) >= 2 then btrim(t.driver_name) else 'Sin nombre' end, t.driver_dpi
from public.weigh_tickets t
order by t.service_id, t.truck_plate, t.registered_at desc
on conflict (service_id, plate) do nothing;

update public.weigh_tickets t set service_truck_id = st.id
from public.service_trucks st where st.service_id = t.service_id and st.plate = t.truck_plate;

do $$
declare r record;
begin
  for r in select distinct service_id, truck_plate from public.weigh_tickets loop
    perform app.recompute_truck_cycles(r.service_id, r.truck_plate);
  end loop;
end $$;

alter table public.weigh_tickets enable trigger user;

create or replace function app.weigh_tickets_cycles() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.recompute_truck_cycles(new.service_id, new.truck_plate);
  if tg_op = 'UPDATE' and old.truck_plate is distinct from new.truck_plate then
    perform app.recompute_truck_cycles(old.service_id, old.truck_plate);
  end if;
  return null;
end $$;
create trigger weigh_tickets_cycles after insert or update of weighed_at, truck_plate, status on public.weigh_tickets
  for each row execute function app.weigh_tickets_cycles();

create trigger service_hold_cargo_product after insert on public.service_hold_cargo
  for each row execute function app.ensure_service_product();

-- La auditoría genérica ignora el recálculo automático de ciclos.
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
    where k not in ('updated_at', 'cycle_seconds', 'prev_ticket_id') and (v_new -> k) is distinct from (v_old -> k);
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

-- Auditoría, sello de actualización y prohibición de borrado físico de las tablas nuevas.
create trigger service_products_touch before update on public.service_products for each row execute function app.touch_updated_at();
create trigger service_bls_touch before update on public.service_bls for each row execute function app.touch_updated_at();
create trigger service_trucks_touch before update on public.service_trucks for each row execute function app.touch_updated_at();
create trigger audit_service_products after insert or update on public.service_products for each row execute function app.audit_trigger();
create trigger audit_service_bls after insert or update on public.service_bls for each row execute function app.audit_trigger();
create trigger audit_service_trucks after insert or update on public.service_trucks for each row execute function app.audit_trigger();
create trigger service_products_no_delete before delete on public.service_products for each row execute function app.prevent_delete();
create trigger service_bls_no_delete before delete on public.service_bls for each row execute function app.prevent_delete();
create trigger service_trucks_no_delete before delete on public.service_trucks for each row execute function app.prevent_delete();

-- Con el ciclo entre pasadas (viaje redondo del camión), el umbral de «ciclo largo» por
-- defecto pasa de 30 a 90 minutos (solo donde seguía el valor por defecto).
alter table public.operational_thresholds alter column long_cycle_minutes set default 90;
update public.operational_thresholds set long_cycle_minutes = 90 where long_cycle_minutes = 30;

-- ---------------------------------------------------------------- tiempos perdidos: «Otros» con descripción
alter table public.downtime_causes add column requires_description boolean not null default false;
update public.downtime_causes set requires_description = true where lower(btrim(name)) in ('otro', 'otros');

-- ---------------------------------------------------------------- RLS de las tablas nuevas (escritura solo vía RPC)
alter table public.service_products enable row level security;
alter table public.service_products force row level security;
alter table public.service_bls enable row level security;
alter table public.service_bls force row level security;
alter table public.service_trucks enable row level security;
alter table public.service_trucks force row level security;
revoke all on public.service_products, public.service_bls, public.service_trucks from anon, authenticated;
grant select on public.service_products, public.service_bls, public.service_trucks to authenticated;
grant all on public.service_products, public.service_bls, public.service_trucks to service_role;
create policy service_products_read on public.service_products for select to authenticated
  using (service_id in (select s.id from public.services s));
create policy service_bls_read on public.service_bls for select to authenticated
  using (service_id in (select s.id from public.services s));
-- Placas, pilotos y DPI: solo personal con acceso al servicio u operadores de sus básculas.
create policy service_trucks_read on public.service_trucks for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view')) or service_id in (select app.my_operator_service_ids())
);
grant update (requires_description) on public.downtime_causes to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.service_bls;
  end if;
end $$;

-- ---------------------------------------------------------------- utilidades
create or replace function app.is_service_operator(p_service uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.service_scales ss where ss.service_id = p_service and app.is_scale_authorized(ss.scale_id))
$$;

create or replace function app.opt_dpi(p text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if nullif(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '') is null then return null; end if;
  return app.norm_dpi(p);
end $$;

-- Busca el buque por IMO (o por nombre si no hay IMO) o lo crea en el catálogo.
create or replace function app.resolve_vessel(p_org uuid, p jsonb, p_holds int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p ->> 'vessel_id', '')::uuid; v jsonb := p -> 'vessel'; v_name text; v_imo text;
begin
  if v_id is not null then
    if not exists (select 1 from public.vessels where id = v_id and organization_id = p_org) then
      raise exception 'El buque no pertenece a la empresa' using errcode = '22023'; end if;
    return v_id;
  end if;
  if v is null or jsonb_typeof(v) <> 'object' then raise exception 'Indique el nombre del buque' using errcode = '22023'; end if;
  v_name := nullif(btrim(v ->> 'name'), '');
  if v_name is null or length(v_name) < 2 then raise exception 'Indique el nombre del buque' using errcode = '22023'; end if;
  v_imo := nullif(regexp_replace(coalesce(v ->> 'imo_number', ''), '\D', '', 'g'), '');
  if v_imo is not null and v_imo !~ '^[0-9]{7}$' then raise exception 'El número IMO debe tener 7 dígitos' using errcode = '22023'; end if;
  select id into v_id from public.vessels
   where organization_id = p_org
     and ((v_imo is not null and imo_number = v_imo) or (v_imo is null and lower(btrim(name)) = lower(v_name)))
   order by (status = 'active') desc, created_at desc limit 1;
  if v_id is not null then return v_id; end if;
  perform app.require_org_perm(p_org, 'vessels.manage');
  insert into public.vessels (organization_id, name, imo_number, flag, holds_count, created_by)
  values (p_org, v_name, v_imo, nullif(btrim(v ->> 'flag'), ''), coalesce(p_holds, 1), auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Busca el producto por nombre (sin distinguir mayúsculas) o lo crea con un color de la paleta.
create or replace function app.resolve_product(p_org uuid, p_id uuid, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_n int;
  v_colors text[] := array['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17', '#6c5ce7', '#0097a7'];
begin
  if p_id is not null then
    if not exists (select 1 from public.products where id = p_id and organization_id = p_org) then
      raise exception 'El producto no pertenece a la empresa' using errcode = '22023'; end if;
    return p_id;
  end if;
  if p_name is null or length(btrim(p_name)) < 2 then raise exception 'Indique el nombre de cada producto' using errcode = '22023'; end if;
  if length(btrim(p_name)) > 80 then raise exception 'El nombre del producto es demasiado largo (máximo 80)' using errcode = '22023'; end if;
  select id into v_id from public.products where organization_id = p_org and lower(btrim(name)) = lower(btrim(p_name));
  if v_id is not null then return v_id; end if;
  perform app.require_org_perm(p_org, 'vessels.manage');
  select count(*) into v_n from public.products where organization_id = p_org;
  insert into public.products (organization_id, name, color)
  values (p_org, btrim(p_name), v_colors[(v_n % array_length(v_colors, 1)) + 1])
  returning id into v_id;
  return v_id;
end $$;

-- Asigna una báscula/punto de descarga a un servicio. Acepta una báscula existente o
-- un nombre nuevo (se crea en la terminal), y opcionalmente sus operadores y la
-- modalidad de hora (manual u hora del servidor).
create or replace function app.attach_point(p_service uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_scale uuid := nullif(p ->> 'scale_id', '')::uuid; v_name text; v_code text; v_n int;
        v_user text; v_mode text := app.opt_text(p, 'time_capture_mode');
begin
  select * into v_svc from public.services where id = p_service;
  if v_scale is not null then
    if not exists (select 1 from public.scales where id = v_scale and terminal_id = v_svc.terminal_id) then
      raise exception 'La báscula no pertenece a la terminal del servicio' using errcode = '22023'; end if;
  else
    v_name := nullif(btrim(p ->> 'name'), '');
    if v_name is null then raise exception 'Indique el nombre de la báscula o punto de descarga' using errcode = '22023'; end if;
    select id into v_scale from public.scales
     where terminal_id = v_svc.terminal_id and lower(btrim(name)) = lower(v_name)
     order by (status = 'active') desc limit 1;
    if v_scale is null then
      perform app.require_terminal_perm(v_svc.terminal_id, 'scales.manage');
      select count(*) + 1 into v_n from public.scales where terminal_id = v_svc.terminal_id;
      loop
        v_code := 'P' || lpad(v_n::text, 2, '0');
        exit when not exists (select 1 from public.scales where terminal_id = v_svc.terminal_id and lower(btrim(code)) = lower(v_code));
        v_n := v_n + 1;
      end loop;
      insert into public.scales (organization_id, terminal_id, code, name, location)
      values (v_svc.organization_id, v_svc.terminal_id, v_code, v_name, app.opt_text(p, 'location'))
      returning id into v_scale;
    end if;
  end if;
  if exists (select 1 from public.scales where id = v_scale and status <> 'active') then
    perform app.require_terminal_perm(v_svc.terminal_id, 'scales.manage');
    update public.scales set status = 'active' where id = v_scale;
  end if;
  if v_mode is not null then
    if v_mode not in ('manual', 'server_now') then raise exception 'Modalidad de hora inválida' using errcode = '22023'; end if;
    perform app.require_terminal_perm(v_svc.terminal_id, 'scales.manage');
    insert into public.scale_settings (scale_id, organization_id, terminal_id, time_capture_mode)
    values (v_scale, v_svc.organization_id, v_svc.terminal_id, v_mode)
    on conflict (scale_id) do update set time_capture_mode = excluded.time_capture_mode;
  end if;
  insert into public.service_scales (service_id, scale_id, organization_id, terminal_id)
  values (p_service, v_scale, v_svc.organization_id, v_svc.terminal_id) on conflict do nothing;
  for v_user in select jsonb_array_elements_text(coalesce(p -> 'operator_ids', '[]'::jsonb)) loop
    perform app.require_terminal_perm(v_svc.terminal_id, 'scales.manage');
    if not exists (select 1 from public.organization_members m where m.organization_id = v_svc.organization_id
                     and m.user_id = v_user::uuid and m.status = 'active') then
      raise exception 'El operador seleccionado no pertenece a la empresa' using errcode = '22023'; end if;
    insert into public.scale_users (scale_id, user_id, organization_id, terminal_id)
    values (v_scale, v_user::uuid, v_svc.organization_id, v_svc.terminal_id) on conflict do nothing;
  end loop;
  return v_scale;
end $$;

-- Alta/actualización de camiones y pilotos de un servicio (por placa).
create or replace function app.upsert_trucks(p_service uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; r jsonb; v_plate text; v_name text; v_ins int := 0; v_upd int := 0; v_ex boolean;
begin
  select * into v_svc from public.services where id = p_service;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Lista de camiones inválida' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_plate := app.norm_plate(r ->> 'plate');
    if v_plate is null or length(v_plate) < 2 then raise exception 'Cada camión necesita su placa' using errcode = '22023'; end if;
    v_name := nullif(btrim(coalesce(r ->> 'driver_name', '')), '');
    if v_name is null or length(v_name) < 2 then raise exception 'Indique el piloto del camión %', v_plate using errcode = '22023'; end if;
    v_ex := exists (select 1 from public.service_trucks where service_id = p_service and plate = v_plate);
    insert into public.service_trucks (organization_id, terminal_id, service_id, plate, tractor_plate, driver_name, driver_dpi, carrier, created_by)
    values (v_svc.organization_id, v_svc.terminal_id, p_service, v_plate, app.norm_plate(r ->> 'tractor_plate'), v_name,
            app.opt_dpi(r ->> 'driver_dpi'), app.opt_text(r, 'carrier'), auth.uid())
    on conflict (service_id, plate) do update set
      tractor_plate = coalesce(excluded.tractor_plate, public.service_trucks.tractor_plate),
      driver_name = excluded.driver_name,
      driver_dpi = coalesce(excluded.driver_dpi, public.service_trucks.driver_dpi),
      carrier = coalesce(excluded.carrier, public.service_trucks.carrier),
      status = 'active';
    if v_ex then v_upd := v_upd + 1; else v_ins := v_ins + 1; end if;
  end loop;
  return jsonb_build_object('inserted', v_ins, 'updated', v_upd);
end $$;

-- ---------------------------------------------------------------- gestión posterior: puntos, camiones y BL
create or replace function app.require_open_service(p_service uuid) returns public.services
language plpgsql stable security definer set search_path = '' as $$
declare v public.services;
begin
  select * into v from public.services where id = p_service;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  if v.status in ('finalized', 'cancelled') then
    raise exception 'El servicio está %; requiere reapertura autorizada', v.status using errcode = '22023'; end if;
  return v;
end $$;

create or replace function public.add_service_point(p_service uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.services := app.require_open_service(p_service);
begin
  perform app.require_terminal_perm(v.terminal_id, 'services.manage');
  return app.attach_point(p_service, p);
end $$;

create or replace function public.upsert_service_trucks(p_service uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.services := app.require_open_service(p_service);
begin
  if not (app.has_terminal_perm(v.terminal_id, 'services.manage') or app.is_service_operator(p_service)) then
    raise exception 'Sin permiso para editar los camiones de este servicio' using errcode = '42501'; end if;
  return app.upsert_trucks(p_service, p_rows);
end $$;

create or replace function public.set_service_truck_status(p_truck uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare t public.service_trucks;
begin
  select * into t from public.service_trucks where id = p_truck;
  if not found then raise exception 'Camión inexistente' using errcode = '42501'; end if;
  perform app.require_open_service(t.service_id);
  perform app.require_terminal_perm(t.terminal_id, 'services.manage');
  if p_status not in ('active', 'inactive') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  update public.service_trucks set status = p_status where id = p_truck;
end $$;

create or replace function public.add_service_bl(p_service uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v public.services := app.require_open_service(p_service); v_sp public.service_products; v_id uuid;
        v_number text := nullif(btrim(p ->> 'bl_number'), ''); v_qty numeric := round(nullif(p ->> 'planned_tm', '')::numeric, 3);
begin
  perform app.require_terminal_perm(v.terminal_id, 'services.manage');
  select * into v_sp from public.service_products where service_id = p_service and product_id = nullif(p ->> 'product_id', '')::uuid;
  if not found then raise exception 'Seleccione un producto del servicio' using errcode = '22023'; end if;
  if v_number is null then raise exception 'Indique el número de BL' using errcode = '22023'; end if;
  if v_qty is null or v_qty <= 0 then raise exception 'Indique la cantidad del BL' using errcode = '22023'; end if;
  begin
    insert into public.service_bls (organization_id, terminal_id, service_id, service_product_id, product_id, bl_number, planned_tm, sort, created_by)
    values (v.organization_id, v.terminal_id, p_service, v_sp.id, v_sp.product_id, v_number, v_qty,
            coalesce((select max(sort) + 1 from public.service_bls where service_id = p_service), 1), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'El BL % ya existe en el servicio', v_number using errcode = '23505';
  end;
  if not v_sp.uses_bl then
    if exists (select 1 from public.weigh_tickets where service_id = p_service and product_id = v_sp.product_id and status = 'valid') then
      raise exception 'El producto ya tiene pesajes sin BL; corrija esos pesajes antes de manejarlo por BL' using errcode = '22023'; end if;
    update public.service_products set uses_bl = true where id = v_sp.id;
  end if;
  return v_id;
end $$;

create or replace function public.update_service_bl(p_bl uuid, p jsonb, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.service_bls; v_reason text := app.require_reason(p_reason); v_qty numeric;
begin
  select * into b from public.service_bls where id = p_bl for update;
  if not found then raise exception 'BL inexistente' using errcode = '42501'; end if;
  perform app.require_open_service(b.service_id);
  if not (app.has_terminal_perm(b.terminal_id, 'cargo.adjust') or app.has_terminal_perm(b.terminal_id, 'services.manage')) then
    raise exception 'Permiso insuficiente para modificar BL' using errcode = '42501'; end if;
  v_qty := round(nullif(p ->> 'planned_tm', '')::numeric, 3);
  if p ? 'planned_tm' and (v_qty is null or v_qty <= 0) then raise exception 'Cantidad de BL inválida' using errcode = '22023'; end if;
  perform app.set_reason(v_reason);
  begin
    update public.service_bls set
      bl_number = coalesce(nullif(btrim(p ->> 'bl_number'), ''), bl_number),
      planned_tm = coalesce(v_qty, planned_tm)
    where id = p_bl;
  exception when unique_violation then
    raise exception 'Ya existe otro BL con ese número en el servicio' using errcode = '23505';
  end;
end $$;

-- Marca un BL como terminado (o lo reabre). Lo pueden hacer los operadores de las
-- básculas del servicio desde la pantalla de pesaje.
create or replace function public.set_bl_status(p_bl uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b public.service_bls;
begin
  select * into b from public.service_bls where id = p_bl for update;
  if not found then raise exception 'BL inexistente' using errcode = '42501'; end if;
  perform app.require_open_service(b.service_id);
  if not (app.has_terminal_perm(b.terminal_id, 'services.manage') or app.has_terminal_perm(b.terminal_id, 'services.status')
          or app.is_service_operator(b.service_id)) then
    raise exception 'Sin permiso para cambiar el estado del BL' using errcode = '42501'; end if;
  if p_status not in ('open', 'completed') then raise exception 'Estado de BL inválido' using errcode = '22023'; end if;
  update public.service_bls set status = p_status,
         completed_at = case when p_status = 'completed' then now() end,
         completed_by = case when p_status = 'completed' then auth.uid() end
   where id = p_bl returning * into b;
  return to_jsonb(b);
end $$;

-- ---------------------------------------------------------------- registro de pesaje (una hora)
create or replace function public.register_weigh_ticket(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req uuid := nullif(p ->> 'client_request_id', '')::uuid;
  v_existing public.weigh_tickets; v_row public.weigh_tickets;
  v_scale public.scales; v_svc public.services; v_cargo public.service_hold_cargo;
  v_bl public.service_bls; v_sp public.service_products; v_truck public.service_trucks;
  v_mode text; v_at timestamptz; v_gross numeric; v_tare numeric; v_net numeric; v_balance numeric; v_bl_balance numeric; v_unit text;
  v_plate text; v_tc text; v_dpi text; v_driver text; v_number text; v_prod uuid; v_hold uuid;
  v_id uuid; v_constraint text; v_hold_no int; v_prod_name text; v_new_truck boolean := false;
begin
  if auth.uid() is null then raise exception 'No autenticado' using errcode = '42501'; end if;
  if v_req is null then raise exception 'Falta client_request_id' using errcode = '22023'; end if;

  select * into v_scale from public.scales where id = nullif(p ->> 'scale_id', '')::uuid;
  if not found or not app.is_scale_authorized(v_scale.id) then
    raise exception 'No está autorizado para registrar pesajes en esta báscula' using errcode = '42501'; end if;

  select * into v_existing from public.weigh_tickets where client_request_id = v_req;
  if found then
    return jsonb_build_object('ticket_id', v_existing.id, 'duplicate', true, 'net_tm', v_existing.net_tm);
  end if;

  if v_scale.status <> 'active' then raise exception 'La báscula no está activa' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = nullif(p ->> 'service_id', '')::uuid;
  if not found or v_svc.terminal_id <> v_scale.terminal_id then
    raise exception 'Servicio inexistente en la terminal de la báscula' using errcode = '22023'; end if;
  if v_svc.status <> 'in_operation' then
    raise exception 'El servicio % no está en operación (estado: %). Un servicio finalizado requiere reapertura autorizada.',
      v_svc.service_number, v_svc.status using errcode = '22023';
  end if;
  if v_svc.cargo_type = 'bags' then
    raise exception 'El servicio % es de carga en sacos: registre el conteo de sacos por bodega y turno' , v_svc.service_number using errcode = '22023'; end if;
  if not exists (select 1 from public.service_scales where service_id = v_svc.id and scale_id = v_scale.id) then
    raise exception 'La báscula no está asignada a este servicio' using errcode = '22023'; end if;

  -- BL seleccionado → determina el producto.
  v_hold := nullif(p ->> 'service_hold_id', '')::uuid;
  v_prod := nullif(p ->> 'product_id', '')::uuid;
  if nullif(p ->> 'bl_id', '') is not null then
    select * into v_bl from public.service_bls where id = (p ->> 'bl_id')::uuid and service_id = v_svc.id;
    if not found then raise exception 'El BL seleccionado no pertenece a este servicio' using errcode = '22023'; end if;
    if v_prod is not null and v_prod <> v_bl.product_id then
      raise exception 'El BL % corresponde a otro producto', v_bl.bl_number using errcode = '22023'; end if;
    v_prod := v_bl.product_id;
  end if;
  select * into v_sp from public.service_products where service_id = v_svc.id and product_id = v_prod;
  if not found then raise exception 'Seleccione un producto del servicio' using errcode = '22023'; end if;
  if v_sp.uses_bl and v_bl.id is null then raise exception 'Seleccione el BL que se está descargando' using errcode = '22023'; end if;

  -- Bloqueo del saldo (bodega × producto) y luego del BL: serializa básculas concurrentes.
  select c.* into v_cargo from public.service_hold_cargo c
   where c.service_id = v_svc.id and c.service_hold_id = v_hold and c.product_id = v_prod
   for update;
  if not found then raise exception 'La bodega seleccionada no contiene ese producto en este servicio' using errcode = '22023'; end if;
  if v_bl.id is not null then
    select * into v_bl from public.service_bls where id = v_bl.id for update;
    if v_bl.status <> 'open' then
      raise exception 'El BL % está marcado como terminado; reábralo o seleccione otro', v_bl.bl_number using errcode = '22023'; end if;
  end if;

  select * into v_existing from public.weigh_tickets where client_request_id = v_req;
  if found then
    return jsonb_build_object('ticket_id', v_existing.id, 'duplicate', true, 'net_tm', v_existing.net_tm);
  end if;

  v_unit := coalesce(nullif(p ->> 'weight_unit', ''), 'kg');
  v_gross := nullif(p ->> 'gross', '')::numeric;
  v_tare := nullif(p ->> 'tare', '')::numeric;
  if v_unit = 'tm' then v_gross := v_gross * 1000; v_tare := v_tare * 1000;
  elsif v_unit <> 'kg' then raise exception 'Unidad de peso inválida' using errcode = '22023'; end if;
  v_net := app.check_weights(v_svc.organization_id, v_gross, v_tare);

  if v_net > (v_cargo.initial_tm - v_cargo.discharged_tm) then
    select h.hold_number, pr.name into v_hold_no, v_prod_name
      from public.service_holds h, public.products pr where h.id = v_cargo.service_hold_id and pr.id = v_cargo.product_id;
    raise exception 'El neto (% TM) excede el saldo pendiente (% TM) de la bodega % · %. Solicite un ajuste de tonelaje.',
      v_net, v_cargo.initial_tm - v_cargo.discharged_tm, v_hold_no, v_prod_name using errcode = '22023';
  end if;

  -- Una sola hora por pesaje: la escribe el operador o la fija el servidor.
  v_mode := app.time_mode_for_scale(v_scale.id);
  if v_mode = 'server_now' then
    v_at := now();
  else
    v_at := app.local_to_ts(v_svc.terminal_id, p ->> 'weighed_local');
    if v_at is null then raise exception 'Registre la hora del pesaje' using errcode = '22023'; end if;
  end if;
  if v_at > now() + interval '5 minutes' then raise exception 'La hora del pesaje no puede estar en el futuro' using errcode = '22023'; end if;

  -- Camión de la lista del servicio (si la placa es nueva, se agrega a la lista).
  if nullif(p ->> 'service_truck_id', '') is not null then
    select * into v_truck from public.service_trucks where id = (p ->> 'service_truck_id')::uuid and service_id = v_svc.id;
    if not found then raise exception 'El camión no pertenece a la lista de este servicio' using errcode = '22023'; end if;
  else
    v_plate := app.norm_plate(p ->> 'truck_plate');
    if v_plate is null then raise exception 'Seleccione o ingrese la placa del camión' using errcode = '22023'; end if;
    select * into v_truck from public.service_trucks where service_id = v_svc.id and plate = v_plate;
  end if;
  v_driver := coalesce(nullif(btrim(coalesce(p ->> 'driver_name', '')), ''), v_truck.driver_name);
  if v_driver is null or length(v_driver) < 2 then raise exception 'Indique el nombre del piloto' using errcode = '22023'; end if;
  v_tc := coalesce(app.norm_plate(p ->> 'tractor_plate'), v_truck.tractor_plate);
  v_dpi := coalesce(app.opt_dpi(p ->> 'driver_dpi'), v_truck.driver_dpi);
  if v_truck.id is null then
    insert into public.service_trucks (organization_id, terminal_id, service_id, plate, tractor_plate, driver_name, driver_dpi, created_by)
    values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_plate, v_tc, v_driver, v_dpi, auth.uid())
    returning * into v_truck;
    v_new_truck := true;
  elsif v_truck.status <> 'active' then
    update public.service_trucks set status = 'active' where id = v_truck.id;
  end if;
  v_number := app.req_text(p, 'ticket_number');

  begin
    insert into public.weigh_tickets (
      organization_id, terminal_id, service_id, customer_id, vessel_id, service_hold_id, cargo_id, product_id, scale_id,
      bl_id, service_truck_id, ticket_number, truck_plate, tractor_plate, driver_name, driver_dpi,
      gross_kg, tare_kg, weighed_at, time_capture_mode, operation_date, shift_id, notes,
      client_request_id, registered_by, registered_by_name)
    values (
      v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id,
      (select h.vessel_id from public.service_holds h where h.id = v_cargo.service_hold_id),
      v_cargo.service_hold_id, v_cargo.id, v_cargo.product_id, v_scale.id,
      v_bl.id, v_truck.id, v_number, v_truck.plate, v_tc, v_driver, v_dpi,
      v_gross, v_tare, v_at, v_mode, app.local_date(v_svc.terminal_id, v_at),
      app.shift_for(v_svc.terminal_id, v_at), app.opt_text(p, 'notes'),
      v_req, auth.uid(), app.actor_name())
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'weigh_tickets_service_scale_number_uq' then
      raise exception 'La boleta % ya está registrada en esta báscula para este servicio', v_number using errcode = '23505';
    end if;
    select * into v_existing from public.weigh_tickets where client_request_id = v_req;
    if found then return jsonb_build_object('ticket_id', v_existing.id, 'duplicate', true, 'net_tm', v_existing.net_tm); end if;
    raise;
  end;

  perform set_config('app.ledger_write', 'on', true);
  update public.service_hold_cargo set discharged_tm = discharged_tm + v_net where id = v_cargo.id
  returning discharged_tm into v_balance;
  if v_bl.id is not null then
    update public.service_bls set discharged_tm = discharged_tm + v_net where id = v_bl.id returning discharged_tm into v_bl_balance;
  end if;
  perform set_config('app.ledger_write', 'off', true);
  insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, ticket_id, ticket_revision, kind,
                                      quantity_tm, balance_after_tm, reason, created_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_cargo.id, v_bl.id, v_id, 1, 'discharge', v_net, v_balance,
          'Pesaje boleta ' || v_number, auth.uid());

  select * into v_row from public.weigh_tickets where id = v_id;
  return jsonb_build_object('ticket_id', v_id, 'duplicate', false, 'net_tm', v_net, 'net_kg', v_row.net_kg,
                            'pending_tm', v_cargo.initial_tm - v_balance, 'discharged_tm', v_balance,
                            'bl_number', v_bl.bl_number, 'bl_discharged_tm', v_bl_balance, 'bl_planned_tm', v_bl.planned_tm,
                            'weighed_at', v_at, 'cycle_seconds', v_row.cycle_seconds, 'new_truck', v_new_truck,
                            'units', case when v_sp.bag_weight_kg > 0 then round(v_row.net_kg / v_sp.bag_weight_kg, 2) end);
end $$;
grant execute on function public.register_weigh_ticket(jsonb) to authenticated;

drop function if exists public.start_scale_visit(uuid, uuid, jsonb);
drop function if exists public.stamp_scale_visit_end(uuid);
drop function if exists public.cancel_scale_visit(uuid, text);
drop function if exists app.check_cycle(uuid, timestamptz, timestamptz);
drop function if exists app.upsert_transport(uuid, text, text, text, text, numeric);

-- ---------------------------------------------------------------- correcciones
create or replace function app.correction_fields(p_type text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_type
    when 'weigh_ticket' then array['truck_plate','tractor_plate','driver_name','driver_dpi','gross_kg','tare_kg',
                                   'service_hold_id','product_id','bl_id','scale_id','weighed_local',
                                   'ticket_number','nominal_capacity_tm','notes']
    when 'downtime_event' then array['cause_id','started_local','ended_local','scope','service_hold_id','scale_id','observations']
  end
$$;

create or replace function app.apply_ticket_change(p_ticket uuid, p_action text, p_changes jsonb, p_reason text,
                                                   p_request uuid, p_approved_by uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.weigh_tickets; n public.weigh_tickets; v_svc public.services; v_sp public.service_products; v_bl public.service_bls;
  v_new_cargo uuid; v_new_net numeric; v_balance numeric; v_mov bigint;
  v_key text; v_old text; v_new text; v_job uuid; v_pending numeric;
begin
  select * into t from public.weigh_tickets where id = p_ticket for update;
  if t.status = 'voided' then raise exception 'El ticket ya está anulado' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = t.service_id;
  if v_svc.status = 'cancelled' then raise exception 'El servicio está cancelado' using errcode = '22023'; end if;
  perform app.set_reason(p_reason);

  if p_action = 'void' then
    perform 1 from public.service_hold_cargo where id = t.cargo_id for update;
    if t.bl_id is not null then perform 1 from public.service_bls where id = t.bl_id for update; end if;
    perform set_config('app.ledger_write', 'on', true);
    update public.service_hold_cargo set discharged_tm = discharged_tm - t.net_tm where id = t.cargo_id returning discharged_tm into v_balance;
    if t.bl_id is not null then update public.service_bls set discharged_tm = discharged_tm - t.net_tm where id = t.bl_id; end if;
    perform set_config('app.ledger_write', 'off', true);
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.cargo_id, t.bl_id, t.id, t.revision, 'reversal', -t.net_tm, v_balance, 'Anulación: ' || p_reason, auth.uid())
    returning id into v_mov;
    insert into public.ticket_reversals (organization_id, terminal_id, service_id, ticket_id, ticket_revision, reversal_movement_id, reason, kind, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.id, t.revision, v_mov, p_reason, 'void', auth.uid());
    update public.weigh_tickets set status = 'voided', void_reason = p_reason, voided_at = now(), voided_by = auth.uid(),
           revision = revision + 1 where id = t.id returning * into n;
    insert into public.correction_history (organization_id, terminal_id, service_id, request_id, target_type, target_id,
      revision_from, revision_to, field, old_value, new_value, reason, snapshot_before, applied_by, applied_by_name, approved_by)
    values (t.organization_id, t.terminal_id, t.service_id, p_request, 'weigh_ticket', t.id, t.revision, n.revision,
            'status', 'valid', 'voided', p_reason, to_jsonb(t), auth.uid(), app.actor_name(), p_approved_by);
    v_job := app.bump_service_revision(t.service_id, p_reason);
    return jsonb_build_object('ticket_id', t.id, 'revision', n.revision, 'job_id', v_job);
  end if;

  n := t;
  if p_changes ? 'truck_plate' then n.truck_plate := app.norm_plate(p_changes ->> 'truck_plate');
    if n.truck_plate is null or length(n.truck_plate) < 2 then raise exception 'Placa inválida' using errcode = '22023'; end if; end if;
  if p_changes ? 'tractor_plate' then n.tractor_plate := app.norm_plate(p_changes ->> 'tractor_plate'); end if;
  if p_changes ? 'driver_name' then n.driver_name := app.req_text(p_changes, 'driver_name'); end if;
  if p_changes ? 'driver_dpi' then n.driver_dpi := app.opt_dpi(p_changes ->> 'driver_dpi'); end if;
  if p_changes ? 'gross_kg' then n.gross_kg := (p_changes ->> 'gross_kg')::numeric; end if;
  if p_changes ? 'tare_kg' then n.tare_kg := (p_changes ->> 'tare_kg')::numeric; end if;
  if p_changes ? 'ticket_number' then n.ticket_number := app.req_text(p_changes, 'ticket_number'); end if;
  if p_changes ? 'nominal_capacity_tm' then n.nominal_capacity_tm := nullif(p_changes ->> 'nominal_capacity_tm', '')::numeric; end if;
  if p_changes ? 'notes' then n.notes := app.opt_text(p_changes, 'notes'); end if;
  if p_changes ? 'weighed_local' then
    n.weighed_at := app.local_to_ts(t.terminal_id, p_changes ->> 'weighed_local');
    if n.weighed_at is null then raise exception 'Indique la hora del pesaje' using errcode = '22023'; end if;
    if n.weighed_at > now() + interval '5 minutes' then raise exception 'La hora del pesaje no puede estar en el futuro' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'scale_id' then
    n.scale_id := (p_changes ->> 'scale_id')::uuid;
    if not exists (select 1 from public.service_scales where service_id = t.service_id and scale_id = n.scale_id) then
      raise exception 'La báscula no está asignada al servicio' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'service_hold_id' then n.service_hold_id := (p_changes ->> 'service_hold_id')::uuid; end if;
  if p_changes ? 'product_id' then n.product_id := (p_changes ->> 'product_id')::uuid; end if;
  if p_changes ? 'bl_id' then
    n.bl_id := nullif(p_changes ->> 'bl_id', '')::uuid;
    if n.bl_id is not null and not (p_changes ? 'product_id') then
      select product_id into n.product_id from public.service_bls where id = n.bl_id and service_id = t.service_id;
    end if;
  end if;
  select * into v_sp from public.service_products where service_id = t.service_id and product_id = n.product_id;
  if not found then raise exception 'El producto no pertenece al servicio' using errcode = '22023'; end if;
  if not v_sp.uses_bl then n.bl_id := null; end if;
  if v_sp.uses_bl and n.bl_id is null then raise exception 'Seleccione el BL del pesaje' using errcode = '22023'; end if;
  if n.bl_id is not null then
    select * into v_bl from public.service_bls where id = n.bl_id and service_id = t.service_id;
    if not found then raise exception 'El BL no pertenece al servicio' using errcode = '22023'; end if;
    if v_bl.product_id <> n.product_id then raise exception 'El BL % corresponde a otro producto', v_bl.bl_number using errcode = '22023'; end if;
  end if;

  v_new_net := app.check_weights(t.organization_id, n.gross_kg, n.tare_kg);
  select c.id into v_new_cargo from public.service_hold_cargo c
   where c.service_id = t.service_id and c.service_hold_id = n.service_hold_id and c.product_id = n.product_id;
  if v_new_cargo is null then raise exception 'La bodega no contiene ese producto en este servicio' using errcode = '22023'; end if;

  -- Movimientos compensatorios si cambia el neto, la bodega/producto o el BL.
  if v_new_net <> t.net_tm or v_new_cargo <> t.cargo_id or n.bl_id is distinct from t.bl_id then
    perform 1 from public.service_hold_cargo where id in (t.cargo_id, v_new_cargo) order by id for update;
    perform 1 from public.service_bls where id in (t.bl_id, n.bl_id) order by id for update;
    perform set_config('app.ledger_write', 'on', true);
    update public.service_hold_cargo set discharged_tm = discharged_tm - t.net_tm where id = t.cargo_id returning discharged_tm into v_balance;
    if t.bl_id is not null then update public.service_bls set discharged_tm = discharged_tm - t.net_tm where id = t.bl_id; end if;
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.cargo_id, t.bl_id, t.id, t.revision, 'reversal', -t.net_tm, v_balance, 'Corrección: ' || p_reason, auth.uid())
    returning id into v_mov;
    insert into public.ticket_reversals (organization_id, terminal_id, service_id, ticket_id, ticket_revision, reversal_movement_id, reason, kind, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.id, t.revision, v_mov, p_reason, 'correction', auth.uid());
    select initial_tm - discharged_tm into v_pending from public.service_hold_cargo where id = v_new_cargo;
    if v_new_net > v_pending then
      raise exception 'El neto corregido (% TM) excede el saldo pendiente (% TM) de la bodega/producto destino', v_new_net, v_pending using errcode = '22023';
    end if;
    update public.service_hold_cargo set discharged_tm = discharged_tm + v_new_net where id = v_new_cargo returning discharged_tm into v_balance;
    if n.bl_id is not null then update public.service_bls set discharged_tm = discharged_tm + v_new_net where id = n.bl_id; end if;
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, v_new_cargo, n.bl_id, t.id, t.revision + 1, 'discharge', v_new_net, v_balance, 'Corrección: ' || p_reason, auth.uid());
    perform set_config('app.ledger_write', 'off', true);
  end if;

  if n.truck_plate <> t.truck_plate then
    select id into n.service_truck_id from public.service_trucks where service_id = t.service_id and plate = n.truck_plate;
    if n.service_truck_id is null then
      insert into public.service_trucks (organization_id, terminal_id, service_id, plate, tractor_plate, driver_name, driver_dpi, created_by)
      values (t.organization_id, t.terminal_id, t.service_id, n.truck_plate, n.tractor_plate, n.driver_name, n.driver_dpi, auth.uid())
      returning id into n.service_truck_id;
    end if;
  end if;

  begin
    update public.weigh_tickets set
      truck_plate = n.truck_plate, tractor_plate = n.tractor_plate, driver_name = n.driver_name, driver_dpi = n.driver_dpi,
      service_truck_id = n.service_truck_id, gross_kg = n.gross_kg, tare_kg = n.tare_kg, ticket_number = n.ticket_number,
      nominal_capacity_tm = n.nominal_capacity_tm, notes = n.notes, weighed_at = n.weighed_at, scale_id = n.scale_id,
      service_hold_id = n.service_hold_id, product_id = n.product_id, cargo_id = v_new_cargo, bl_id = n.bl_id,
      vessel_id = (select h.vessel_id from public.service_holds h where h.id = n.service_hold_id),
      operation_date = app.local_date(t.terminal_id, n.weighed_at), shift_id = app.shift_for(t.terminal_id, n.weighed_at),
      revision = t.revision + 1
    where id = t.id returning * into n;
  exception when unique_violation then
    raise exception 'La boleta % ya existe en esa báscula para este servicio', n.ticket_number using errcode = '23505';
  end;

  for v_key in select jsonb_object_keys(p_changes) loop
    v_old := case v_key when 'weighed_local' then app.fmt_local(t.terminal_id, t.weighed_at) else to_jsonb(t) ->> v_key end;
    v_new := case v_key when 'weighed_local' then app.fmt_local(t.terminal_id, n.weighed_at) else to_jsonb(n) ->> v_key end;
    if v_old is distinct from v_new then
      insert into public.correction_history (organization_id, terminal_id, service_id, request_id, target_type, target_id,
        revision_from, revision_to, field, old_value, new_value, reason, snapshot_before, applied_by, applied_by_name, approved_by)
      values (t.organization_id, t.terminal_id, t.service_id, p_request, 'weigh_ticket', t.id, t.revision, n.revision,
              v_key, v_old, v_new, p_reason, to_jsonb(t), auth.uid(), app.actor_name(), p_approved_by);
    end if;
  end loop;
  v_job := app.bump_service_revision(t.service_id, p_reason);
  return jsonb_build_object('ticket_id', t.id, 'revision', n.revision, 'net_tm', n.net_tm, 'job_id', v_job);
end $$;

create or replace function public.request_correction(p_target_type text, p_target_id uuid, p_action text, p_changes jsonb,
                                                     p_reason text, p_expected_revision int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid; v_term uuid; v_svc uuid; v_rev int; v_scale uuid; v_status text; v_row jsonb;
  v_reason text := app.require_reason(p_reason); v_req uuid; v_res jsonb; v_prev jsonb := '{}'::jsonb; v_key text;
  v_changes jsonb := coalesce(p_changes, '{}');
begin
  if p_action not in ('update', 'void') then raise exception 'Acción inválida' using errcode = '22023'; end if;
  if p_target_type = 'weigh_ticket' then
    select organization_id, terminal_id, service_id, revision, scale_id, status, to_jsonb(w)
      into v_org, v_term, v_svc, v_rev, v_scale, v_status, v_row from public.weigh_tickets w where id = p_target_id;
    if v_org is null or not (app.has_terminal_perm(v_term, 'weighing.view_all') or v_scale in (select app.my_scale_ids())) then
      raise exception 'Registro inexistente o sin acceso' using errcode = '42501'; end if;
  elsif p_target_type = 'downtime_event' then
    select organization_id, terminal_id, service_id, revision, status, to_jsonb(d)
      into v_org, v_term, v_svc, v_rev, v_status, v_row from public.downtime_events d where id = p_target_id;
    if v_org is null or not (app.has_terminal_perm(v_term, 'services.view') or app.has_terminal_perm(v_term, 'downtime.register')) then
      raise exception 'Registro inexistente o sin acceso' using errcode = '42501'; end if;
  else
    raise exception 'Tipo de registro inválido' using errcode = '22023';
  end if;
  if not (app.has_terminal_perm(v_term, 'corrections.request') or app.has_terminal_perm(v_term, 'corrections.approve')) then
    raise exception 'Permiso insuficiente (corrections.request)' using errcode = '42501'; end if;
  if v_status = 'voided' then raise exception 'El registro está anulado' using errcode = '22023'; end if;
  if p_expected_revision is not null and p_expected_revision <> v_rev then
    raise exception 'El registro fue modificado por otro usuario; recargue antes de corregir' using errcode = '40001'; end if;
  if p_action = 'update' then
    if v_changes = '{}'::jsonb then raise exception 'No hay cambios que aplicar' using errcode = '22023'; end if;
    for v_key in select jsonb_object_keys(v_changes) loop
      if not (v_key = any (app.correction_fields(p_target_type))) then
        raise exception 'El campo % no es corregible', v_key using errcode = '22023'; end if;
      v_prev := v_prev || jsonb_build_object(v_key, case v_key
        when 'weighed_local' then to_jsonb(app.fmt_local(v_term, (v_row ->> 'weighed_at')::timestamptz))
        when 'started_local' then to_jsonb(app.fmt_local(v_term, (v_row ->> 'started_at')::timestamptz))
        when 'ended_local' then to_jsonb(app.fmt_local(v_term, (v_row ->> 'ended_at')::timestamptz))
        else v_row -> v_key end);
    end loop;
  end if;

  if app.has_terminal_perm(v_term, 'corrections.approve') then
    insert into public.correction_requests (organization_id, terminal_id, service_id, target_type, target_id, target_revision,
      action, changes, previous_values, reason, status, requested_by, requested_by_name, reviewed_by, reviewed_by_name, reviewed_at, review_note, applied_at)
    values (v_org, v_term, v_svc, p_target_type, p_target_id, v_rev, p_action, v_changes, v_prev, v_reason, 'applied',
            auth.uid(), app.actor_name(), auth.uid(), app.actor_name(), now(), 'Aplicada directamente por usuario autorizado', now())
    returning id into v_req;
    v_res := case p_target_type
      when 'weigh_ticket' then app.apply_ticket_change(p_target_id, p_action, v_changes, v_reason, v_req, auth.uid())
      else app.apply_downtime_change(p_target_id, p_action, v_changes, v_reason, v_req, auth.uid()) end;
    insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
    values (v_org, 'correction', v_req, 'approved', auth.uid(), app.actor_name(), 'Aplicación directa');
    return jsonb_build_object('status', 'applied', 'request_id', v_req, 'result', v_res);
  end if;

  begin
    insert into public.correction_requests (organization_id, terminal_id, service_id, target_type, target_id, target_revision,
      action, changes, previous_values, reason, requested_by, requested_by_name)
    values (v_org, v_term, v_svc, p_target_type, p_target_id, v_rev, p_action, v_changes, v_prev, v_reason, auth.uid(), app.actor_name())
    returning id into v_req;
  exception when unique_violation then
    raise exception 'Ya existe una solicitud de corrección pendiente para este registro' using errcode = '23505';
  end;
  perform app.notify_users(v_org, app.users_with_terminal_perm(v_term, 'corrections.approve'), 'correction_pending',
    'Corrección pendiente de aprobación', app.actor_name() || ': ' || v_reason, '/app/correcciones');
  return jsonb_build_object('status', 'pending', 'request_id', v_req);
end $$;
grant execute on function public.request_correction(text, uuid, text, jsonb, text, int) to authenticated;

-- ---------------------------------------------------------------- tiempos perdidos
create or replace function public.register_downtime(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req uuid := nullif(p ->> 'client_request_id', '')::uuid;
  v_svc public.services; v_cause public.downtime_causes; v_start timestamptz; v_end timestamptz;
  v_scope text := coalesce(app.opt_text(p, 'scope'), 'operation');
  v_hold uuid := nullif(p ->> 'service_hold_id', '')::uuid; v_scale uuid := nullif(p ->> 'scale_id', '')::uuid;
  v_obs text := app.opt_text(p, 'observations');
  v_id uuid;
begin
  if v_req is null then raise exception 'Falta client_request_id' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = nullif(p ->> 'service_id', '')::uuid;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'downtime.register');
  select id into v_id from public.downtime_events where client_request_id = v_req;
  if found then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  if v_svc.status not in ('preparing', 'in_operation', 'suspended', 'closing') then
    raise exception 'El servicio está % y no admite nuevos registros', v_svc.status using errcode = '22023'; end if;
  select * into v_cause from public.downtime_causes where id = nullif(p ->> 'cause_id', '')::uuid
     and organization_id = v_svc.organization_id and status = 'active';
  if not found then raise exception 'Seleccione un evento válido del catálogo' using errcode = '22023'; end if;
  if v_cause.requires_description and (v_obs is null or length(v_obs) < 3) then
    raise exception 'Describa qué pasó (evento «%»)', v_cause.name using errcode = '22023'; end if;
  v_start := app.local_to_ts(v_svc.terminal_id, p ->> 'started_local');
  v_end := app.local_to_ts(v_svc.terminal_id, p ->> 'ended_local');
  perform app.check_downtime(v_svc.organization_id, v_start, v_end);
  perform app.check_downtime_scope(v_svc.id, v_scope, v_hold, v_scale);

  insert into public.downtime_events (organization_id, terminal_id, service_id, customer_id, vessel_id, cause_id, category_id,
    started_at, ended_at, scope, service_hold_id, scale_id, observations, operation_date, shift_id,
    client_request_id, reported_by, reported_by_name)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id, v_svc.vessel_id, v_cause.id, v_cause.category_id,
    v_start, v_end, v_scope, v_hold, v_scale, v_obs,
    app.local_date(v_svc.terminal_id, v_start), app.shift_for(v_svc.terminal_id, v_start),
    v_req, auth.uid(), app.actor_name())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false,
                            'duration_minutes', round(extract(epoch from (v_end - v_start)) / 60.0, 2));
end $$;
grant execute on function public.register_downtime(jsonb) to authenticated;

create or replace function app.apply_downtime_change(p_event uuid, p_action text, p_changes jsonb, p_reason text,
                                                     p_request uuid, p_approved_by uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.downtime_events; n public.downtime_events; v_cause public.downtime_causes; v_key text; v_old text; v_new text; v_job uuid;
begin
  select * into d from public.downtime_events where id = p_event for update;
  if d.status = 'voided' then raise exception 'El evento ya está anulado' using errcode = '22023'; end if;
  perform app.set_reason(p_reason);
  if p_action = 'void' then
    update public.downtime_events set status = 'voided', void_reason = p_reason, revision = revision + 1 where id = d.id returning * into n;
    insert into public.correction_history (organization_id, terminal_id, service_id, request_id, target_type, target_id,
      revision_from, revision_to, field, old_value, new_value, reason, snapshot_before, applied_by, applied_by_name, approved_by)
    values (d.organization_id, d.terminal_id, d.service_id, p_request, 'downtime_event', d.id, d.revision, n.revision,
            'status', 'valid', 'voided', p_reason, to_jsonb(d), auth.uid(), app.actor_name(), p_approved_by);
    v_job := app.bump_service_revision(d.service_id, p_reason);
    return jsonb_build_object('id', d.id, 'revision', n.revision, 'job_id', v_job);
  end if;
  n := d;
  if p_changes ? 'cause_id' then
    select * into v_cause from public.downtime_causes where id = (p_changes ->> 'cause_id')::uuid and organization_id = d.organization_id;
    if not found then raise exception 'Evento de catálogo inválido' using errcode = '22023'; end if;
    n.cause_id := v_cause.id; n.category_id := v_cause.category_id;
  end if;
  if p_changes ? 'started_local' then n.started_at := app.local_to_ts(d.terminal_id, p_changes ->> 'started_local'); end if;
  if p_changes ? 'ended_local' then n.ended_at := app.local_to_ts(d.terminal_id, p_changes ->> 'ended_local'); end if;
  if p_changes ? 'scope' then n.scope := p_changes ->> 'scope'; end if;
  if p_changes ? 'service_hold_id' then n.service_hold_id := nullif(p_changes ->> 'service_hold_id', '')::uuid; end if;
  if p_changes ? 'scale_id' then n.scale_id := nullif(p_changes ->> 'scale_id', '')::uuid; end if;
  if p_changes ? 'observations' then n.observations := app.opt_text(p_changes, 'observations'); end if;
  select * into v_cause from public.downtime_causes where id = n.cause_id;
  if v_cause.requires_description and (n.observations is null or length(btrim(n.observations)) < 3) then
    raise exception 'Describa qué pasó (evento «%»)', v_cause.name using errcode = '22023'; end if;
  perform app.check_downtime(d.organization_id, n.started_at, n.ended_at);
  perform app.check_downtime_scope(d.service_id, n.scope, n.service_hold_id, n.scale_id);
  update public.downtime_events set cause_id = n.cause_id, category_id = n.category_id, started_at = n.started_at, ended_at = n.ended_at,
    scope = n.scope, service_hold_id = n.service_hold_id, scale_id = n.scale_id, observations = n.observations,
    operation_date = app.local_date(d.terminal_id, n.started_at), shift_id = app.shift_for(d.terminal_id, n.started_at),
    revision = d.revision + 1
  where id = d.id returning * into n;
  for v_key in select jsonb_object_keys(p_changes) loop
    v_old := case v_key when 'started_local' then app.fmt_local(d.terminal_id, d.started_at)
                        when 'ended_local' then app.fmt_local(d.terminal_id, d.ended_at) else to_jsonb(d) ->> v_key end;
    v_new := case v_key when 'started_local' then app.fmt_local(d.terminal_id, n.started_at)
                        when 'ended_local' then app.fmt_local(d.terminal_id, n.ended_at) else to_jsonb(n) ->> v_key end;
    if v_old is distinct from v_new then
      insert into public.correction_history (organization_id, terminal_id, service_id, request_id, target_type, target_id,
        revision_from, revision_to, field, old_value, new_value, reason, snapshot_before, applied_by, applied_by_name, approved_by)
      values (d.organization_id, d.terminal_id, d.service_id, p_request, 'downtime_event', d.id, d.revision, n.revision,
              v_key, v_old, v_new, p_reason, to_jsonb(d), auth.uid(), app.actor_name(), p_approved_by);
    end if;
  end loop;
  v_job := app.bump_service_revision(d.service_id, p_reason);
  return jsonb_build_object('id', d.id, 'revision', n.revision, 'job_id', v_job);
end $$;

create or replace function app.seed_organization_defaults(p_org uuid, p_terminal uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_cat uuid; r record;
begin
  insert into public.organization_settings (organization_id) values (p_org) on conflict do nothing;
  insert into public.operational_thresholds (organization_id) values (p_org) on conflict do nothing;
  insert into public.report_templates (organization_id, kind) values (p_org, 'final_service') on conflict do nothing;
  if p_terminal is not null then
    insert into public.terminal_settings (terminal_id, organization_id) values (p_terminal, p_org) on conflict do nothing;
    insert into public.shifts (organization_id, terminal_id, name, start_time, end_time, sort) values
      (p_org, p_terminal, 'Turno 1', '06:00', '14:00', 1), (p_org, p_terminal, 'Turno 2', '14:00', '22:00', 2),
      (p_org, p_terminal, 'Turno 3', '22:00', '06:00', 3);
  end if;
  for r in select * from (values
    ('Logística', '#c97a00', 1, array['Falta de camiones', 'Problemas logísticos', 'Espera de autorización']),
    ('Equipos', '#cf3b25', 2, array['Problemas con equipos de descarga', 'Falla de grab', 'Falla de tolva', 'Mantenimiento']),
    ('Operativas', '#1874a8', 3, array['Falta de producto en tolva', 'Cambio de bodega', 'Cambio de producto', 'Interrupción operativa', 'Falta de personal']),
    ('Climáticas', '#5a6a79', 4, array['Condiciones climáticas']),
    ('Otros', '#93a4b4', 5, array['Otros'])) as t(name, color, sort, causes) loop
    insert into public.downtime_categories (organization_id, name, color, sort) values (p_org, r.name, r.color, r.sort) returning id into v_cat;
    insert into public.downtime_causes (organization_id, category_id, name, default_scope, sort, requires_description)
    select p_org, v_cat, c, case when c in ('Falla de tolva', 'Falla de grab', 'Falta de producto en tolva', 'Cambio de bodega') then 'hold'
                                 when c = 'Mantenimiento' then 'scale' else 'operation' end, i, c = 'Otros'
    from unnest(r.causes) with ordinality as u(c, i);
  end loop;
end $$;

-- ---------------------------------------------------------------- métricas del servicio
create or replace function app.service_metrics(p_service uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_svc public.services; v_tz text; v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
  v_first timestamptz; v_last timestamptz; v_span_h numeric; v_tons numeric; v_trucks int; v_avg_cycle numeric; v_cycles int; v_distinct int;
  v_op_down_min numeric; v_total_down_min numeric; v_events int; v_eff_h numeric; v_tot jsonb;
begin
  select * into v_svc from public.services where id = p_service;
  if not found then return null; end if;
  v_tz := app.terminal_tz(v_svc.terminal_id);

  select count(*), coalesce(sum(net_tm), 0), min(weighed_at), max(weighed_at), avg(cycle_seconds) / 60.0,
         count(cycle_seconds), count(distinct truck_plate)
    into v_trucks, v_tons, v_first, v_last, v_avg_cycle, v_cycles, v_distinct
  from public.weigh_tickets where service_id = p_service and status = 'valid' and weighed_at >= v_from and weighed_at < v_to;
  v_span_h := case when v_first is not null and v_last > v_first then extract(epoch from (v_last - v_first)) / 3600.0 end;

  select coalesce(sum(duration_minutes), 0), count(*) into v_total_down_min, v_events
  from public.downtime_events where service_id = p_service and status = 'valid' and started_at >= v_from and started_at < v_to;

  -- Tiempo perdido de TODA la operación, fusionando eventos solapados y recortado a la ventana operativa.
  with ev as (
    select greatest(started_at, v_first) s, least(ended_at, v_last) e
    from public.downtime_events
    where service_id = p_service and status = 'valid' and scope = 'operation'
      and v_first is not null and ended_at > v_first and started_at < v_last
  ), o as (
    select s, e, max(e) over (order by s rows between unbounded preceding and 1 preceding) pm from ev
  ), g as (
    select s, e, sum(case when pm is null or s > pm then 1 else 0 end) over (order by s) grp from o
  )
  select coalesce(sum(extract(epoch from (mx - mn))) / 60.0, 0) into v_op_down_min
  from (select min(s) mn, max(e) mx from g group by grp) x;

  v_eff_h := case when v_span_h is not null then greatest(v_span_h - v_op_down_min / 60.0, 0) end;

  select jsonb_build_object('initial_tm', coalesce(sum(c.initial_tm), 0), 'discharged_tm', coalesce(sum(c.discharged_tm), 0),
                            'pending_tm', coalesce(sum(c.initial_tm - c.discharged_tm), 0),
                            'initial_kg', round(coalesce(sum(c.initial_tm), 0) * 1000), 'discharged_kg', round(coalesce(sum(c.discharged_tm), 0) * 1000),
                            'progress_pct', case when sum(c.initial_tm) > 0 then round(sum(c.discharged_tm) / sum(c.initial_tm) * 100, 2) else 0 end,
                            'initial_units', case when v_svc.cargo_type = 'bags' then round(sum(c.initial_tm * 1000 / nullif(sp.bag_weight_kg, 0))) end,
                            'discharged_units', case when v_svc.cargo_type = 'bags' then round(sum(c.discharged_tm * 1000 / nullif(sp.bag_weight_kg, 0))) end)
    into v_tot
  from public.service_hold_cargo c
  left join public.service_products sp on sp.service_id = c.service_id and sp.product_id = c.product_id
  where c.service_id = p_service;

  return jsonb_build_object(
    'service_id', p_service, 'timezone', v_tz, 'from', p_from, 'to', p_to, 'computed_at', now(),
    'cargo_type', v_svc.cargo_type,
    'totals', v_tot,
    'trucks', v_trucks,
    'distinct_trucks', v_distinct,
    'cycles_count', v_cycles,
    'tons_in_range', round(v_tons, 3),
    'avg_tm_per_truck', case when v_trucks > 0 then round(v_tons / v_trucks, 3) end,
    'avg_cycle_minutes', round(v_avg_cycle, 2),
    'first_ticket_at', v_first, 'last_ticket_at', v_last,
    'window_hours', round(v_span_h, 2),
    'tph', case when v_span_h > 0 then round(v_tons / v_span_h, 2) end,
    'downtime_minutes_reported', round(v_total_down_min, 2),
    'downtime_events', v_events,
    'downtime_operation_minutes', round(v_op_down_min, 2),
    'effective_hours', round(v_eff_h, 2),
    'tph_effective', case when v_eff_h > 0 then round(v_tons / v_eff_h, 2) end,
    'trucks_per_hour', case when v_span_h > 0 then round(v_trucks / v_span_h, 2) end,
    'service_hours', round(extract(epoch from (coalesce(v_svc.finalized_at, now()) - v_svc.actual_start)) / 3600.0, 2),
    'by_scale', coalesce((
      select jsonb_agg(x order by x ->> 'name') from (
        select jsonb_build_object('scale_id', sc.id, 'code', sc.code, 'name', sc.name,
          'trucks', count(t.id), 'tons', round(coalesce(sum(t.net_tm), 0), 3),
          'avg_cycle_minutes', round(avg(t.cycle_seconds) / 60.0, 2),
          'avg_tm_per_truck', case when count(t.id) > 0 then round(sum(t.net_tm) / count(t.id), 3) end,
          'tph', case when max(t.weighed_at) > min(t.weighed_at)
                      then round(sum(t.net_tm) / (extract(epoch from (max(t.weighed_at) - min(t.weighed_at))) / 3600.0), 2) end,
          'downtime_minutes', (select round(coalesce(sum(d.duration_minutes), 0), 2) from public.downtime_events d
                               where d.service_id = p_service and d.status = 'valid' and d.scope = 'scale' and d.scale_id = sc.id
                                 and d.started_at >= v_from and d.started_at < v_to)) x
        from public.service_scales ss
        join public.scales sc on sc.id = ss.scale_id
        left join public.weigh_tickets t on t.scale_id = sc.id and t.service_id = p_service and t.status = 'valid'
              and t.weighed_at >= v_from and t.weighed_at < v_to
        where ss.service_id = p_service
        group by sc.id, sc.code, sc.name) q), '[]'::jsonb),
    'by_hold', coalesce((
      select jsonb_agg(x order by (x ->> 'hold_number')::int, x ->> 'vessel_name') from (
        select jsonb_build_object('service_hold_id', h.id, 'hold_number', h.hold_number, 'vessel_name', v.name,
          'initial_tm', (select coalesce(sum(c.initial_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'discharged_tm', (select coalesce(sum(c.discharged_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'pending_tm', (select coalesce(sum(c.initial_tm - c.discharged_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'trucks', (select count(*) from public.weigh_tickets t where t.service_hold_id = h.id and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to),
          'tons', (select round(coalesce(sum(t.net_tm), 0), 3) from public.weigh_tickets t where t.service_hold_id = h.id and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to),
          'downtime_minutes', (select round(coalesce(sum(d.duration_minutes), 0), 2) from public.downtime_events d
                               where d.service_hold_id = h.id and d.status = 'valid' and d.scope = 'hold' and d.started_at >= v_from and d.started_at < v_to),
          'products', (select coalesce(jsonb_agg(jsonb_build_object('cargo_id', c.id, 'product_id', p.id, 'name', p.name, 'color', p.color,
                          'initial_tm', c.initial_tm, 'discharged_tm', c.discharged_tm, 'pending_tm', c.initial_tm - c.discharged_tm) order by p.name), '[]'::jsonb)
                       from public.service_hold_cargo c join public.products p on p.id = c.product_id where c.service_hold_id = h.id)) x
        from public.service_holds h join public.vessels v on v.id = h.vessel_id
        where h.service_id = p_service) q), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(x order by x ->> 'name') from (
        select jsonb_build_object('product_id', p.id, 'name', p.name, 'color', p.color, 'bag_weight_kg', sp.bag_weight_kg, 'uses_bl', coalesce(sp.uses_bl, false),
          'initial_tm', sum(c.initial_tm), 'discharged_tm', sum(c.discharged_tm), 'pending_tm', sum(c.initial_tm - c.discharged_tm),
          'initial_units', case when sp.bag_weight_kg > 0 then round(sum(c.initial_tm) * 1000 / sp.bag_weight_kg) end,
          'discharged_units', case when sp.bag_weight_kg > 0 then round(sum(c.discharged_tm) * 1000 / sp.bag_weight_kg) end,
          'trucks', (select count(*) from public.weigh_tickets t where t.service_id = p_service and t.product_id = p.id and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to),
          'tons', (select round(coalesce(sum(t.net_tm), 0), 3) from public.weigh_tickets t where t.service_id = p_service and t.product_id = p.id and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to)) x
        from public.service_hold_cargo c join public.products p on p.id = c.product_id
        left join public.service_products sp on sp.service_id = c.service_id and sp.product_id = c.product_id
        where c.service_id = p_service group by p.id, p.name, p.color, sp.bag_weight_kg, sp.uses_bl) q), '[]'::jsonb),
    'by_bl', coalesce((
      select jsonb_agg(jsonb_build_object('bl_id', b.id, 'bl_number', b.bl_number, 'product_id', b.product_id, 'product', p.name, 'color', p.color,
          'planned_tm', b.planned_tm, 'discharged_tm', b.discharged_tm, 'pending_tm', b.planned_tm - b.discharged_tm, 'status', b.status,
          'progress_pct', round(b.discharged_tm / b.planned_tm * 100, 2), 'bag_weight_kg', sp.bag_weight_kg,
          'planned_units', case when sp.bag_weight_kg > 0 then round(b.planned_tm * 1000 / sp.bag_weight_kg) end,
          'discharged_units', case when sp.bag_weight_kg > 0 then round(b.discharged_tm * 1000 / sp.bag_weight_kg) end,
          'trucks', (select count(*) from public.weigh_tickets t where t.bl_id = b.id and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to))
        order by b.sort, b.bl_number)
      from public.service_bls b join public.products p on p.id = b.product_id join public.service_products sp on sp.id = b.service_product_id
      where b.service_id = p_service), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'tons', round(tons, 3), 'trucks', trucks, 'cum_tons', round(cum, 3)) order by h)
      from (select h, tons, trucks, sum(tons) over (order by h) cum from (
              select date_trunc('hour', t.weighed_at at time zone v_tz) h, sum(t.net_tm) tons, count(*) trucks
              from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to
              group by 1) q0) q), '[]'::jsonb),
    'hourly_by_scale', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'scale_id', scale_id, 'tons', round(tons, 3), 'trucks', trucks) order by h)
      from (select date_trunc('hour', t.weighed_at at time zone v_tz) h, t.scale_id, sum(t.net_tm) tons, count(*) trucks
            from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to
            group by 1, 2) q), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('date', d, 'tons', round(tons, 3), 'trucks', trucks) order by d)
      from (select t.operation_date d, sum(t.net_tm) tons, count(*) trucks
            from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to
            group by 1) q), '[]'::jsonb),
    'by_shift', coalesce((
      select jsonb_agg(jsonb_build_object('shift', shift, 'tons', round(tons, 3), 'trucks', trucks) order by srt)
      from (select coalesce(sh.name, 'Sin turno') shift, sum(t.net_tm) tons, count(*) trucks, min(coalesce(sh.sort, 99)) srt
            from public.weigh_tickets t left join public.shifts sh on sh.id = t.shift_id
            where t.service_id = p_service and t.status = 'valid' and t.weighed_at >= v_from and t.weighed_at < v_to
            group by sh.name) q), '[]'::jsonb),
    'downtime_by_cause', coalesce((
      select jsonb_agg(jsonb_build_object('cause', cause, 'category', category, 'color', color, 'minutes', round(mins, 2), 'events', n,
                                          'pct', case when tot > 0 then round(mins / tot * 100, 2) else 0 end,
                                          'cum_pct', case when tot > 0 then round(cum / tot * 100, 2) else 0 end)
                       order by mins desc, cause)
      from (select *, sum(mins) over (order by mins desc, cause) cum from (
              select dc.name cause, cat.name category, cat.color, sum(d.duration_minutes) mins, count(*) n,
                     sum(sum(d.duration_minutes)) over () tot
              from public.downtime_events d
              join public.downtime_causes dc on dc.id = d.cause_id
              join public.downtime_categories cat on cat.id = d.category_id
              where d.service_id = p_service and d.status = 'valid' and d.started_at >= v_from and d.started_at < v_to
              group by dc.name, cat.name, cat.color) q0) q), '[]'::jsonb)
  );
end $$;

create or replace function public.dashboard_summary(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  f_org uuid := nullif(p ->> 'organization_id', '')::uuid; f_term uuid := nullif(p ->> 'terminal_id', '')::uuid;
  f_cust uuid := nullif(p ->> 'customer_id', '')::uuid; f_ves uuid := nullif(p ->> 'vessel_id', '')::uuid;
  f_svc uuid := nullif(p ->> 'service_id', '')::uuid; f_prod uuid := nullif(p ->> 'product_id', '')::uuid;
  f_from timestamptz := coalesce(nullif(p ->> 'from', '')::timestamptz, '-infinity');
  f_to timestamptz := coalesce(nullif(p ->> 'to', '')::timestamptz, 'infinity');
  v jsonb;
begin
  with s as (
    select * from public.services x
    where (f_org is null or x.organization_id = f_org) and (f_term is null or x.terminal_id = f_term)
      and (f_cust is null or x.customer_id = f_cust) and (f_ves is null or x.vessel_id = f_ves) and (f_svc is null or x.id = f_svc)
  ), c as (
    select c.* from public.service_hold_cargo c join s on s.id = c.service_id
    where s.status <> 'cancelled' and (f_prod is null or c.product_id = f_prod)
  ), t as (
    select t.* from public.weigh_tickets t join s on s.id = t.service_id
    where t.status = 'valid' and t.weighed_at >= f_from and t.weighed_at < f_to and (f_prod is null or t.product_id = f_prod)
  ), d as (
    select d.* from public.downtime_events d join s on s.id = d.service_id
    where d.status = 'valid' and d.started_at >= f_from and d.started_at < f_to
  )
  select jsonb_build_object(
    'active_customers', (select count(*) from public.customers cu where cu.status = 'active'
                          and (f_org is null or cu.organization_id = f_org) and (f_cust is null or cu.id = f_cust)),
    'services_total', (select count(*) from s),
    'services_active', (select count(*) from s where status in ('preparing', 'in_operation', 'suspended', 'closing')),
    'services_in_operation', (select count(*) from s where status = 'in_operation'),
    'services_finalized', (select count(*) from s where status = 'finalized'),
    'services_scheduled', (select count(*) from s where status = 'scheduled'),
    'vessels_in_operation', (select count(distinct vessel_id) from s where status = 'in_operation'),
    'initial_tm', (select coalesce(sum(initial_tm), 0) from c),
    'discharged_tm', (select coalesce(sum(discharged_tm), 0) from c),
    'pending_tm', (select coalesce(sum(initial_tm - discharged_tm), 0) from c join s on s.id = c.service_id where s.status <> 'finalized'),
    'trucks', (select count(*) from t),
    'tons_in_range', (select coalesce(sum(net_tm), 0) from t),
    'avg_cycle_minutes', (select round(avg(cycle_seconds) / 60.0, 2) from t),
    'downtime_hours', (select round(coalesce(sum(duration_minutes), 0) / 60.0, 2) from d),
    'downtime_events', (select count(*) from d),
    'tph', (select case when max(weighed_at) > min(weighed_at) then round(sum(net_tm) / (extract(epoch from (max(weighed_at) - min(weighed_at))) / 3600.0), 2) end from t),
    'tph_last_3h', (select round(coalesce(sum(net_tm), 0) / 3.0, 2) from t where t.weighed_at >= now() - interval '3 hours'),
    'trucks_last_hour', (select count(*) from t where t.weighed_at >= now() - interval '1 hour'),
    'tons_last_hour', (select coalesce(sum(net_tm), 0) from t where t.weighed_at >= now() - interval '1 hour')
  ) into v;
  return v;
end $$;
grant execute on function public.dashboard_summary(jsonb) to authenticated;

-- ---------------------------------------------------------------- cierre: concilia también por BL
create or replace function public.close_service(p_service uuid, p_note text default null, p_conclusions text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_svc public.services; v_pendcorr int; v_bad int; v_pending numeric; v_tol numeric; v_report uuid; v_job uuid;
begin
  select * into v_svc from public.services where id = p_service for update;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'services.close');
  if v_svc.status not in ('in_operation', 'suspended', 'closing') then
    raise exception 'Solo se puede finalizar un servicio en operación, suspendido o en proceso de cierre (estado: %)', v_svc.status using errcode = '22023';
  end if;
  select count(*) into v_pendcorr from public.correction_requests where service_id = p_service and status = 'pending';
  if v_pendcorr > 0 then raise exception 'Hay % corrección(es) pendientes de aprobación', v_pendcorr using errcode = '22023'; end if;
  -- Conciliación: saldo acumulado = ledger = suma de tickets válidos (por bodega/producto y por BL)
  select count(*) into v_bad from public.service_hold_cargo c
  where c.service_id = p_service and (
        c.discharged_tm <> (select coalesce(sum(m.quantity_tm), 0) from public.cargo_movements m where m.cargo_id = c.id)
     or c.discharged_tm <> (select coalesce(sum(t.net_tm), 0) from public.weigh_tickets t where t.cargo_id = c.id and t.status = 'valid'));
  select v_bad + count(*) into v_bad from public.service_bls b
  where b.service_id = p_service and (
        b.discharged_tm <> (select coalesce(sum(m.quantity_tm), 0) from public.cargo_movements m where m.bl_id = b.id)
     or b.discharged_tm <> (select coalesce(sum(t.net_tm), 0) from public.weigh_tickets t where t.bl_id = b.id and t.status = 'valid'));
  if v_bad > 0 then raise exception 'Error de conciliación en % línea(s) de carga o BL; contacte al administrador', v_bad using errcode = 'XX000'; end if;
  select coalesce(sum(initial_tm - discharged_tm), 0) into v_pending from public.service_hold_cargo where service_id = p_service;
  select reconciliation_tolerance_tm into v_tol from public.operational_thresholds where organization_id = v_svc.organization_id;
  if v_pending > coalesce(v_tol, 0) and (p_note is null or length(btrim(p_note)) < 8) then
    raise exception 'Quedan % TM pendientes según el manifiesto; registre una nota de conciliación para cerrar', round(v_pending, 3) using errcode = '22023';
  end if;
  perform app.set_reason(coalesce(p_note, 'Cierre de operación'));
  perform set_config('app.rpc', 'on', true);
  update public.services set status = 'finalized', finalized_at = now(), closure_note = nullif(btrim(p_note), ''),
         data_revision = data_revision + 1
   where id = p_service returning * into v_svc;
  perform set_config('app.rpc', 'off', true);
  insert into public.productivity_snapshots (organization_id, terminal_id, service_id, kind, data_revision, metrics, taken_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, 'closure', v_svc.data_revision, app.service_metrics(v_svc.id), auth.uid());
  insert into public.generated_reports (organization_id, terminal_id, service_id, customer_id, status, conclusions)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id, 'generating',
          coalesce(nullif(btrim(p_conclusions), ''), (select conclusions_default from public.report_templates where organization_id = v_svc.organization_id and kind = 'final_service'), ''))
  on conflict (service_id, kind) do update
    set status = case when public.generated_reports.current_version_id is null then 'generating' else 'revision_pending' end,
        conclusions = coalesce(nullif(btrim(p_conclusions), ''), public.generated_reports.conclusions)
  returning id into v_report;
  insert into public.report_jobs (organization_id, terminal_id, service_id, report_id, data_revision, idempotency_key, requested_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_report, v_svc.data_revision,
          'final_service:' || v_svc.id || ':' || v_svc.data_revision, auth.uid())
  on conflict (idempotency_key) do nothing returning id into v_job;
  insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
  values (v_svc.organization_id, 'service_close', v_svc.id, 'approved', auth.uid(), app.actor_name(), p_note);
  return jsonb_build_object('status', 'finalized', 'report_id', v_report, 'job_id', v_job, 'pending_tm', v_pending);
end $$;
grant execute on function public.close_service(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- datos del informe PDF
create or replace function public.worker_report_payload(p_service uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_svc public.services; v_tz text;
begin
  select * into v_svc from public.services where id = p_service;
  if not found then raise exception 'Servicio inexistente'; end if;
  v_tz := app.terminal_tz(v_svc.terminal_id);
  return jsonb_build_object(
    'service', to_jsonb(v_svc),
    'organization', (select to_jsonb(o) from public.organizations o where o.id = v_svc.organization_id),
    'settings', (select to_jsonb(s) from public.organization_settings s where s.organization_id = v_svc.organization_id),
    'template', (select to_jsonb(t) from public.report_templates t where t.organization_id = v_svc.organization_id and t.kind = 'final_service'),
    'report', (select to_jsonb(r) from public.generated_reports r where r.service_id = p_service and r.kind = 'final_service'),
    'customer', (select to_jsonb(c) from public.customers c where c.id = v_svc.customer_id),
    'terminal', (select to_jsonb(t) from public.terminals t where t.id = v_svc.terminal_id),
    'vessel', (select to_jsonb(v) from public.vessels v where v.id = v_svc.vessel_id),
    'vessels', (select coalesce(jsonb_agg(distinct v.name), '[]'::jsonb) from public.service_holds h join public.vessels v on v.id = h.vessel_id where h.service_id = p_service),
    'responsible', coalesce(v_svc.responsible_name, (select full_name from public.user_profiles where user_id = v_svc.responsible_user_id)),
    'metrics', app.service_metrics(p_service),
    'cargo_type', v_svc.cargo_type,
    'cargo', (select coalesce(jsonb_agg(jsonb_build_object('hold_number', h.hold_number, 'vessel', v.name, 'product', p.name, 'color', p.color,
                 'initial_tm', c.initial_tm, 'discharged_tm', c.discharged_tm, 'pending_tm', c.initial_tm - c.discharged_tm,
                 'bag_weight_kg', sp.bag_weight_kg,
                 'initial_units', case when sp.bag_weight_kg > 0 then round(c.initial_tm * 1000 / sp.bag_weight_kg) end,
                 'discharged_units', case when sp.bag_weight_kg > 0 then round(c.discharged_tm * 1000 / sp.bag_weight_kg) end)
                 order by h.hold_number, p.name), '[]'::jsonb)
              from public.service_hold_cargo c join public.service_holds h on h.id = c.service_hold_id
              join public.vessels v on v.id = h.vessel_id join public.products p on p.id = c.product_id
              left join public.service_products sp on sp.service_id = c.service_id and sp.product_id = c.product_id
              where c.service_id = p_service),
    'bls', (select coalesce(jsonb_agg(jsonb_build_object('bl', b.bl_number, 'product', p.name, 'planned_tm', b.planned_tm,
                 'discharged_tm', b.discharged_tm, 'diff_tm', b.discharged_tm - b.planned_tm, 'status', b.status,
                 'planned_units', case when sp.bag_weight_kg > 0 then round(b.planned_tm * 1000 / sp.bag_weight_kg) end,
                 'discharged_units', case when sp.bag_weight_kg > 0 then round(b.discharged_tm * 1000 / sp.bag_weight_kg) end)
                 order by b.sort, b.bl_number), '[]'::jsonb)
            from public.service_bls b join public.products p on p.id = b.product_id join public.service_products sp on sp.id = b.service_product_id
            where b.service_id = p_service),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('ticket', t.ticket_number, 'plate', t.truck_plate, 'tc', t.tractor_plate,
                 'driver', t.driver_name, 'dpi', t.driver_dpi, 'gross_kg', t.gross_kg, 'tare_kg', t.tare_kg, 'net_kg', t.net_kg, 'net_tm', t.net_tm,
                 'time', to_char(t.weighed_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
                 'cycle_min', round(t.cycle_seconds / 60.0, 1), 'scale', sc.name, 'hold', h.hold_number, 'product', p.name,
                 'bl', b.bl_number, 'units', case when sp.bag_weight_kg > 0 then round(t.net_kg / sp.bag_weight_kg) end, 'revision', t.revision)
                 order by t.weighed_at, t.ticket_number), '[]'::jsonb)
               from public.weigh_tickets t join public.scales sc on sc.id = t.scale_id join public.service_holds h on h.id = t.service_hold_id
               join public.products p on p.id = t.product_id left join public.service_bls b on b.id = t.bl_id
               left join public.service_products sp on sp.service_id = t.service_id and sp.product_id = t.product_id
               where t.service_id = p_service and t.status = 'valid'),
    'voided_tickets', (select count(*) from public.weigh_tickets where service_id = p_service and status = 'voided'),
    'downtime', (select coalesce(jsonb_agg(jsonb_build_object('date', to_char(d.started_at at time zone v_tz, 'DD/MM/YYYY'),
                 'start', to_char(d.started_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'), 'end', to_char(d.ended_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
                 'cause', dc.name, 'category', cat.name, 'scope', d.scope, 'hold', h.hold_number, 'scale', sc.name,
                 'minutes', d.duration_minutes, 'observations', d.observations) order by d.started_at), '[]'::jsonb)
                 from public.downtime_events d join public.downtime_causes dc on dc.id = d.cause_id join public.downtime_categories cat on cat.id = d.category_id
                 left join public.service_holds h on h.id = d.service_hold_id left join public.scales sc on sc.id = d.scale_id
                 where d.service_id = p_service and d.status = 'valid'),
    'corrections', (select count(distinct request_id) from public.correction_history where service_id = p_service),
    'dates', jsonb_build_object(
      'start', to_char(coalesce(v_svc.actual_start, v_svc.planned_start) at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
      'end', to_char(v_svc.finalized_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
      'first_ticket', (select to_char(min(weighed_at) at time zone v_tz, 'DD/MM/YYYY HH24:MI') from public.weigh_tickets where service_id = p_service and status = 'valid'),
      'last_ticket', (select to_char(max(weighed_at) at time zone v_tz, 'DD/MM/YYYY HH24:MI') from public.weigh_tickets where service_id = p_service and status = 'valid')),
    'previous_version', (select jsonb_build_object('version', rv.version, 'signed_at', rv.signed_at, 'verification_code', rv.verification_code)
                         from public.report_versions rv join public.generated_reports gr on gr.current_version_id = rv.id where gr.service_id = p_service)
  );
end $$;

-- ---------------------------------------------------------------- vistas
create view public.operational_cycles with (security_invoker = true) as
select t.id, t.organization_id, t.terminal_id, t.service_id, t.customer_id, t.vessel_id, t.service_hold_id, t.cargo_id, t.product_id, t.scale_id,
       t.bl_id, t.service_truck_id, t.ticket_number, t.truck_plate, t.tractor_plate, t.driver_name, t.driver_dpi, t.nominal_capacity_tm,
       t.gross_kg, t.tare_kg, t.net_kg, t.net_tm, t.weighed_at, t.prev_ticket_id, t.cycle_seconds,
       round(t.cycle_seconds / 60.0, 2) as cycle_minutes,
       case when t.cycle_seconds is not null then t.weighed_at - make_interval(secs => t.cycle_seconds::double precision) end as prev_weighed_at,
       t.time_capture_mode, t.operation_date, t.shift_id,
       t.status, t.revision, t.registered_by, t.registered_by_name, t.registered_at, t.notes,
       s.service_number, s.cargo_type, v.name as vessel_name, sc.name as scale_name, sc.code as scale_code,
       h.hold_number, p.name as product_name, p.color as product_color, sh.name as shift_name, c.trade_name as customer_name,
       b.bl_number, sp.bag_weight_kg,
       case when sp.bag_weight_kg > 0 then round(t.net_kg / sp.bag_weight_kg, 2) end as units
from public.weigh_tickets t
join public.services s on s.id = t.service_id
join public.vessels v on v.id = t.vessel_id
join public.scales sc on sc.id = t.scale_id
join public.service_holds h on h.id = t.service_hold_id
join public.products p on p.id = t.product_id
join public.customers c on c.id = t.customer_id
left join public.shifts sh on sh.id = t.shift_id
left join public.service_bls b on b.id = t.bl_id
left join public.service_products sp on sp.service_id = t.service_id and sp.product_id = t.product_id;

create or replace view public.service_overview with (security_invoker = true) as
select s.id, s.organization_id, s.terminal_id, s.customer_id, s.vessel_id, s.service_number, s.status,
       s.planned_start, s.estimated_end, s.actual_start, s.finalized_at, s.responsible_name, s.responsible_user_id,
       s.observations, s.created_at, s.data_revision,
       c.trade_name as customer_name, c.code as customer_code, v.name as vessel_name, v.imo_number, t.name as terminal_name, t.timezone,
       coalesce(k.initial_tm, 0) as initial_tm, coalesce(k.discharged_tm, 0) as discharged_tm,
       coalesce(k.initial_tm - k.discharged_tm, 0) as pending_tm,
       case when k.initial_tm > 0 then round(k.discharged_tm / k.initial_tm * 100, 2) else 0 end as progress_pct,
       coalesce(k.products, '') as products, coalesce(k.holds, 0) as holds_count,
       gr.status as report_status, gr.current_version_id,
       s.cargo_type
from public.services s
join public.customers c on c.id = s.customer_id
join public.vessels v on v.id = s.vessel_id
join public.terminals t on t.id = s.terminal_id
left join lateral (
  select sum(x.initial_tm) initial_tm, sum(x.discharged_tm) discharged_tm,
         string_agg(distinct p.name, ', ') products, count(distinct x.service_hold_id) holds
  from public.service_hold_cargo x join public.products p on p.id = x.product_id
  where x.service_id = s.id) k on true
left join public.generated_reports gr on gr.service_id = s.id and gr.kind = 'final_service';

grant select on public.operational_cycles, public.service_overview to authenticated;

-- ---------------------------------------------------------------- privilegios de ejecución
grant execute on function public.add_service_point(uuid, jsonb), public.upsert_service_trucks(uuid, jsonb),
  public.set_service_truck_status(uuid, text), public.add_service_bl(uuid, jsonb), public.update_service_bl(uuid, jsonb, text),
  public.set_bl_status(uuid, text) to authenticated;

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;
grant execute on function public.verify_report(text) to anon, authenticated;
