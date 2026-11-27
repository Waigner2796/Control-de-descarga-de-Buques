-- =============================================================================
-- VESSEL CONTROL · Migración 010 · Marca de la empresa, esquemas de turnos,
-- operaciones de carga o descarga y método de sacos.
-- · Configuración del Master: nombre, logotipo, paleta (2–3 colores) y descargo
--   de responsabilidad (disclaimer) para el informe PDF.
-- · Esquemas de turnos por terminal; cada servicio elige el suyo al crearse.
-- · Servicio de descarga o de carga.
-- · Sacos: conteo de sacos por bodega y turno (ledger), sacos dañados por turno
--   (sucio, roto, mojado, al mar) y verificación del peso de cada saco con su
--   temperatura (tara general por presentación; neto y promedios automáticos).
-- =============================================================================

-- ---------------------------------------------------------------- marca de la empresa
alter table public.organization_settings
  add column brand_colors text[] not null default array['#0b4f71', '#1874a8']::text[]
    check (cardinality(brand_colors) between 1 and 3 and array_to_string(brand_colors, ',') ~* '^#[0-9a-f]{6}(,#[0-9a-f]{6}){0,2}$'),
  add column report_disclaimer text check (report_disclaimer is null or length(report_disclaimer) <= 3000);
grant update (brand_colors, report_disclaimer) on public.organization_settings to authenticated;

-- ---------------------------------------------------------------- descarga o carga
alter table public.services
  add column operation_kind text not null default 'discharge' check (operation_kind in ('discharge', 'load'));

-- ---------------------------------------------------------------- esquemas de turnos
create table public.shift_plans (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 80),
  is_default      boolean not null default false,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now()
);
create unique index shift_plans_name_uq on public.shift_plans (terminal_id, lower(btrim(name)));
create unique index shift_plans_default_uq on public.shift_plans (terminal_id) where is_default;
create trigger shift_plans_scope before insert or update of terminal_id on public.shift_plans
  for each row execute function app.inherit_terminal_scope();
create trigger audit_shift_plans after insert or update on public.shift_plans for each row execute function app.audit_trigger();
create trigger shift_plans_no_delete before delete on public.shift_plans for each row execute function app.prevent_delete();

insert into public.shift_plans (organization_id, terminal_id, name, is_default)
select organization_id, id, 'Turnos de la terminal', true from public.terminals;

alter table public.shifts add column plan_id uuid references public.shift_plans(id) on delete restrict;
update public.shifts s set plan_id = p.id from public.shift_plans p where p.terminal_id = s.terminal_id and p.is_default;
alter table public.shifts alter column plan_id set not null;
create index shifts_plan_idx on public.shifts (plan_id);

create or replace function app.default_shift_plan(p_terminal uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  select id into v from public.shift_plans where terminal_id = p_terminal and status = 'active' order by is_default desc, created_at limit 1;
  if v is null then
    insert into public.shift_plans (organization_id, terminal_id, name, is_default)
    select organization_id, id, 'Turnos de la terminal', not exists (select 1 from public.shift_plans where terminal_id = p_terminal and is_default)
    from public.terminals where id = p_terminal
    returning id into v;
  end if;
  return v;
end $$;

-- Un turno siempre pertenece a un esquema de su misma terminal.
create or replace function app.shifts_plan_chk() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.plan_id is null then new.plan_id := app.default_shift_plan(new.terminal_id); end if;
  if not exists (select 1 from public.shift_plans where id = new.plan_id and terminal_id = new.terminal_id) then
    raise exception 'El esquema de turnos no pertenece a la terminal' using errcode = '23514'; end if;
  return new;
end $$;
create trigger shifts_zplan before insert or update on public.shifts for each row execute function app.shifts_plan_chk();

alter table public.services add column shift_plan_id uuid references public.shift_plans(id) on delete restrict;
-- Relleno técnico de una columna nueva: sin pasar por las guardas de edición (también
-- aplica a servicios finalizados) ni generar auditoría de usuario.
alter table public.services disable trigger user;
update public.services s set shift_plan_id = p.id from public.shift_plans p where p.terminal_id = s.terminal_id and p.is_default;
alter table public.services enable trigger user;

-- Turno de un instante según el esquema del servicio (maneja medianoche).
create or replace function app.service_shift_for(p_service uuid, p_ts timestamptz) returns uuid
language sql stable security definer set search_path = '' as $$
  select sh.id
  from public.services sv
  join public.terminals t on t.id = sv.terminal_id
  join public.shifts sh on sh.plan_id = coalesce(sv.shift_plan_id, (select p.id from public.shift_plans p where p.terminal_id = sv.terminal_id and p.is_default))
  cross join lateral (select (p_ts at time zone t.timezone)::time as lt) x
  where sv.id = p_service and sh.status = 'active'
    and case when sh.start_time < sh.end_time then x.lt >= sh.start_time and x.lt < sh.end_time
             else x.lt >= sh.start_time or x.lt < sh.end_time end
  order by sh.sort
  limit 1
$$;

-- Inicio y fin del periodo del turno que contiene un instante (fecha real del turno).
create or replace function app.shift_period_start(p_shift uuid, p_ts timestamptz) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select ((case when s.start_time < s.end_time or (p_ts at time zone t.timezone)::time >= s.start_time
                then (p_ts at time zone t.timezone)::date else (p_ts at time zone t.timezone)::date - 1 end) + s.start_time) at time zone t.timezone
  from public.shifts s join public.terminals t on t.id = s.terminal_id where s.id = p_shift
$$;
create or replace function app.shift_period_end(p_shift uuid, p_start timestamptz) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select p_start + case when s.end_time > s.start_time then s.end_time - s.start_time else s.end_time - s.start_time + interval '24 hours' end
  from public.shifts s where s.id = p_shift
$$;

create or replace function app.set_ticket_shift() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.shift_id := app.service_shift_for(new.service_id, new.weighed_at);
  return new;
end $$;
create trigger weigh_tickets_shift before insert or update of weighed_at on public.weigh_tickets
  for each row execute function app.set_ticket_shift();
create or replace function app.set_downtime_shift() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.shift_id := app.service_shift_for(new.service_id, new.started_at);
  return new;
end $$;
create trigger downtime_events_shift before insert or update of started_at on public.downtime_events
  for each row execute function app.set_downtime_shift();

alter table public.shift_plans enable row level security;
alter table public.shift_plans force row level security;
revoke all on public.shift_plans from anon, authenticated;
grant select, insert on public.shift_plans to authenticated;
grant update (name, is_default, status) on public.shift_plans to authenticated;
grant all on public.shift_plans to service_role;
create policy shift_plans_read on public.shift_plans for select to authenticated using (terminal_id in (select app.my_terminal_ids()));
create policy shift_plans_insert on public.shift_plans for insert to authenticated
  with check (terminal_id in (select app.terminals_with_perm('org.manage')));
create policy shift_plans_update on public.shift_plans for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('org.manage'))) with check (terminal_id in (select app.terminals_with_perm('org.manage')));

-- ---------------------------------------------------------------- operadores del servicio (sin báscula: sacos)
create table public.service_operators (
  service_id      uuid not null references public.services(id) on delete restrict,
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  created_at      timestamptz not null default now(),
  primary key (service_id, user_id)
);
create index service_operators_user_idx on public.service_operators (user_id);
create trigger service_operators_scope before insert or update on public.service_operators
  for each row execute function app.inherit_service_scope();
create trigger audit_service_operators after insert or delete on public.service_operators for each row execute function app.audit_trigger();

create or replace function app.my_operator_service_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select ss.service_id from public.service_scales ss where ss.scale_id in (select app.my_scale_ids())
  union
  select so.service_id from public.service_operators so
  join public.organization_members m on m.organization_id = so.organization_id and m.user_id = so.user_id
  where so.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
$$;

create or replace function app.is_service_operator(p_service uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.service_scales ss where ss.service_id = p_service and app.is_scale_authorized(ss.scale_id))
      or exists (select 1 from public.service_operators so join public.services s on s.id = so.service_id
                 where so.service_id = p_service and so.user_id = (select auth.uid()) and app.has_terminal_perm(s.terminal_id, 'weighing.register'))
      or exists (select 1 from public.services s where s.id = p_service and app.has_terminal_perm(s.terminal_id, 'weighing.register')
                 and app.member_role(s.organization_id) = 'master_admin')
$$;

-- Quién registra conteos y pesos de sacos: operadores asignados, administración operativa y supervisión.
create or replace function app.can_register_bags(p_service uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_service_operator(p_service)
      or exists (select 1 from public.services s where s.id = p_service
                 and (app.has_terminal_perm(s.terminal_id, 'services.manage') or app.has_terminal_perm(s.terminal_id, 'corrections.approve')))
$$;

alter table public.service_operators enable row level security;
alter table public.service_operators force row level security;
revoke all on public.service_operators from anon, authenticated;
grant select on public.service_operators to authenticated;
grant all on public.service_operators to service_role;
create policy service_operators_read on public.service_operators for select to authenticated using (
  user_id = (select auth.uid()) or terminal_id in (select app.terminals_with_perm('services.view'))
);

create or replace function public.set_service_operators(p_service uuid, p_user_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.services := app.require_open_service(p_service); u uuid;
begin
  perform app.require_terminal_perm(v.terminal_id, 'services.manage');
  delete from public.service_operators where service_id = p_service and not (user_id = any (coalesce(p_user_ids, '{}')));
  foreach u in array coalesce(p_user_ids, '{}') loop
    if not exists (select 1 from public.organization_members m where m.organization_id = v.organization_id and m.user_id = u and m.status = 'active') then
      raise exception 'El operador seleccionado no pertenece a la empresa' using errcode = '22023'; end if;
    insert into public.service_operators (service_id, user_id, organization_id, terminal_id) values (p_service, u, v.organization_id, v.terminal_id)
    on conflict do nothing;
  end loop;
end $$;

-- Tara general del saco (y peso) por producto del servicio.
create or replace function public.update_service_product(p_service_product uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare sp public.service_products; v_tare numeric := nullif(p ->> 'bag_tare_kg', '')::numeric;
begin
  select * into sp from public.service_products where id = p_service_product;
  if not found then raise exception 'Producto inexistente' using errcode = '42501'; end if;
  perform app.require_open_service(sp.service_id);
  perform app.require_terminal_perm(sp.terminal_id, 'services.manage');
  if p ? 'bag_tare_kg' and (v_tare is null or v_tare < 0) then raise exception 'Tara del saco inválida' using errcode = '22023'; end if;
  update public.service_products set bag_tare_kg = case when p ? 'bag_tare_kg' then v_tare else bag_tare_kg end where id = p_service_product;
end $$;

-- ---------------------------------------------------------------- sacos: conteo por bodega y turno
create table public.bag_tallies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  terminal_id      uuid not null references public.terminals(id) on delete restrict,
  service_id       uuid not null references public.services(id) on delete restrict,
  cargo_id         uuid not null references public.service_hold_cargo(id) on delete restrict,
  service_hold_id  uuid not null references public.service_holds(id) on delete restrict,
  product_id       uuid not null references public.products(id) on delete restrict,
  bl_id            uuid references public.service_bls(id) on delete restrict,
  shift_id         uuid not null references public.shifts(id) on delete restrict,
  period_start     timestamptz not null,
  period_end       timestamptz not null,
  bags             int not null check (bags > 0),
  net_tm           numeric(14,3) not null check (net_tm > 0),
  operation_date   date not null,
  status           text not null default 'valid' check (status in ('valid', 'voided')),
  void_reason      text,
  voided_at        timestamptz,
  voided_by        uuid references auth.users(id),
  notes            text,
  batch_id         uuid not null,
  registered_by    uuid not null references auth.users(id),
  registered_by_name text,
  registered_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (period_end > period_start)
);
create index bag_tallies_service_idx on public.bag_tallies (service_id, period_start);
create index bag_tallies_cargo_idx on public.bag_tallies (cargo_id);
create index bag_tallies_batch_idx on public.bag_tallies (batch_id);
create trigger bag_tallies_touch before update on public.bag_tallies for each row execute function app.touch_updated_at();
create trigger audit_bag_tallies after insert or update on public.bag_tallies for each row execute function app.audit_trigger();
create trigger bag_tallies_no_delete before delete on public.bag_tallies for each row execute function app.prevent_delete();

alter table public.cargo_movements add column tally_id uuid references public.bag_tallies(id) on delete restrict;
create unique index cargo_movements_tally_discharge_once on public.cargo_movements (tally_id) where kind = 'discharge' and tally_id is not null;
create unique index cargo_movements_tally_reversal_once on public.cargo_movements (tally_id) where kind = 'reversal' and tally_id is not null;

-- Sacos dañados o rechazados por turno.
create table public.bag_damages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  shift_id        uuid not null references public.shifts(id) on delete restrict,
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  dirty           int not null default 0 check (dirty >= 0),
  broken          int not null default 0 check (broken >= 0),
  wet             int not null default 0 check (wet >= 0),
  to_sea          int not null default 0 check (to_sea >= 0),
  notes           text,
  updated_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (service_id, period_start)
);
create trigger bag_damages_touch before update on public.bag_damages for each row execute function app.touch_updated_at();
create trigger audit_bag_damages after insert or update on public.bag_damages for each row execute function app.audit_trigger();
create trigger bag_damages_no_delete before delete on public.bag_damages for each row execute function app.prevent_delete();

-- Verificación del peso de cada saco (muestreo) con temperatura.
create table public.bag_samples (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  product_id      uuid not null references public.products(id) on delete restrict,
  ticket_number   text not null check (length(btrim(ticket_number)) between 1 and 40),
  gross_kg        numeric(8,3) not null check (gross_kg > 0 and gross_kg < 500),
  tare_kg         numeric(8,3) not null check (tare_kg >= 0),
  net_kg          numeric(8,3) generated always as (gross_kg - tare_kg) stored,
  temperature_c   numeric(5,2) not null check (temperature_c between -30 and 90),
  sampled_at      timestamptz not null default now(),
  shift_id        uuid references public.shifts(id) on delete set null,
  operation_date  date not null,
  status          text not null default 'valid' check (status in ('valid', 'voided')),
  void_reason     text,
  client_request_id uuid not null unique,
  registered_by   uuid not null references auth.users(id),
  registered_by_name text,
  created_at      timestamptz not null default now(),
  check (gross_kg > tare_kg)
);
create index bag_samples_service_idx on public.bag_samples (service_id, sampled_at);
create trigger audit_bag_samples after insert or update on public.bag_samples for each row execute function app.audit_trigger();
create trigger bag_samples_no_delete before delete on public.bag_samples for each row execute function app.prevent_delete();

alter table public.bag_tallies enable row level security;
alter table public.bag_tallies force row level security;
alter table public.bag_damages enable row level security;
alter table public.bag_damages force row level security;
alter table public.bag_samples enable row level security;
alter table public.bag_samples force row level security;
revoke all on public.bag_tallies, public.bag_damages, public.bag_samples from anon, authenticated;
grant select on public.bag_tallies, public.bag_damages, public.bag_samples to authenticated;
grant all on public.bag_tallies, public.bag_damages, public.bag_samples to service_role;
create policy bag_tallies_read on public.bag_tallies for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view')) or service_id in (select app.my_operator_service_ids()));
create policy bag_damages_read on public.bag_damages for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view')) or service_id in (select app.my_operator_service_ids()));
create policy bag_samples_read on public.bag_samples for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view')) or service_id in (select app.my_operator_service_ids()));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.bag_tallies, public.bag_samples;
  end if;
end $$;

-- Periodo (inicio/fin) de un turno del esquema del servicio en una fecha dada.
create or replace function app.service_shift_period(p_service uuid, p_shift uuid, p_date date, out shift public.shifts, out period_start timestamptz, out period_end timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_svc public.services;
begin
  select * into v_svc from public.services where id = p_service;
  select * into shift from public.shifts where id = p_shift and plan_id = v_svc.shift_plan_id and status = 'active';
  if shift.id is null then raise exception 'Seleccione un turno del esquema del servicio' using errcode = '22023'; end if;
  if p_date is null then raise exception 'Indique la fecha del turno' using errcode = '22023'; end if;
  period_start := (p_date + shift.start_time) at time zone app.terminal_tz(v_svc.terminal_id);
  period_end := app.shift_period_end(shift.id, period_start);
end $$;

-- Registra el conteo de sacos de un turno (varias bodegas a la vez) y descuenta los saldos.
create or replace function public.register_bag_tally(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_batch uuid := nullif(p ->> 'client_request_id', '')::uuid;
  v_svc public.services; v_per record; r jsonb; v_cargo public.service_hold_cargo; v_sp public.service_products; v_bl public.service_bls;
  v_prod uuid; v_bags int; v_tm numeric; v_bal numeric; v_id uuid; v_n int := 0; v_total int := 0; v_hold_no int;
begin
  if auth.uid() is null then raise exception 'No autenticado' using errcode = '42501'; end if;
  if v_batch is null then raise exception 'Falta client_request_id' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = nullif(p ->> 'service_id', '')::uuid;
  if not found or not app.can_register_bags(v_svc.id) then
    raise exception 'No está autorizado para registrar en este servicio' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_batch::text, 0));
  if exists (select 1 from public.bag_tallies where batch_id = v_batch) then
    return jsonb_build_object('duplicate', true, 'bags', (select sum(bags) from public.bag_tallies where batch_id = v_batch));
  end if;
  if v_svc.cargo_type <> 'bags' then raise exception 'El conteo por turno es para servicios en sacos' using errcode = '22023'; end if;
  if v_svc.status <> 'in_operation' then
    raise exception 'El servicio % no está en operación (estado: %)', v_svc.service_number, v_svc.status using errcode = '22023'; end if;
  select * into v_per from app.service_shift_period(v_svc.id, nullif(p ->> 'shift_id', '')::uuid, nullif(p ->> 'shift_date', '')::date);
  if v_per.period_start > now() + interval '1 hour' then raise exception 'El turno aún no ha comenzado' using errcode = '22023'; end if;

  for r in select * from jsonb_array_elements(coalesce(p -> 'rows', '[]'::jsonb)) loop
    v_bags := nullif(r ->> 'bags', '')::int;
    if v_bags is null or v_bags = 0 then continue; end if;
    if v_bags < 0 then raise exception 'Los sacos deben ser mayores que cero' using errcode = '22023'; end if;
    v_bl := null;
    if nullif(r ->> 'bl_id', '') is not null then
      select * into v_bl from public.service_bls where id = (r ->> 'bl_id')::uuid and service_id = v_svc.id;
      if not found then raise exception 'El BL no pertenece al servicio' using errcode = '22023'; end if;
    end if;
    v_prod := coalesce(v_bl.product_id, nullif(r ->> 'product_id', '')::uuid);
    select * into v_sp from public.service_products where service_id = v_svc.id and product_id = v_prod;
    if not found then raise exception 'Seleccione un producto del servicio' using errcode = '22023'; end if;
    if v_sp.uses_bl and v_bl.id is null then raise exception 'Seleccione el BL de cada conteo' using errcode = '22023'; end if;
    if coalesce(v_sp.bag_weight_kg, 0) <= 0 then raise exception 'El producto no tiene peso por saco configurado' using errcode = '22023'; end if;
    select * into v_cargo from public.service_hold_cargo
     where service_id = v_svc.id and service_hold_id = nullif(r ->> 'service_hold_id', '')::uuid and product_id = v_prod for update;
    if not found then raise exception 'La bodega no contiene ese producto en este servicio' using errcode = '22023'; end if;
    if v_bl.id is not null then
      select * into v_bl from public.service_bls where id = v_bl.id for update;
      if v_bl.status <> 'open' then raise exception 'El BL % está terminado; reábralo para registrar', v_bl.bl_number using errcode = '22023'; end if;
    end if;
    v_tm := round(v_bags * v_sp.bag_weight_kg / 1000.0, 3);
    if v_tm > v_cargo.initial_tm - v_cargo.discharged_tm then
      select hold_number into v_hold_no from public.service_holds where id = v_cargo.service_hold_id;
      raise exception 'Los % sacos exceden lo pendiente de la bodega % (% sacos)', v_bags, v_hold_no,
        floor((v_cargo.initial_tm - v_cargo.discharged_tm) * 1000 / v_sp.bag_weight_kg) using errcode = '22023';
    end if;
    insert into public.bag_tallies (organization_id, terminal_id, service_id, cargo_id, service_hold_id, product_id, bl_id, shift_id,
      period_start, period_end, bags, net_tm, operation_date, notes, batch_id, registered_by, registered_by_name)
    values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_cargo.id, v_cargo.service_hold_id, v_prod, v_bl.id, (v_per.shift).id,
      v_per.period_start, v_per.period_end, v_bags, v_tm, app.local_date(v_svc.terminal_id, v_per.period_start), app.opt_text(p, 'notes'),
      v_batch, auth.uid(), app.actor_name())
    returning id into v_id;
    perform set_config('app.ledger_write', 'on', true);
    update public.service_hold_cargo set discharged_tm = discharged_tm + v_tm where id = v_cargo.id returning discharged_tm into v_bal;
    if v_bl.id is not null then update public.service_bls set discharged_tm = discharged_tm + v_tm where id = v_bl.id; end if;
    perform set_config('app.ledger_write', 'off', true);
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, tally_id, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_cargo.id, v_bl.id, v_id, 'discharge', v_tm, v_bal,
            'Conteo de ' || v_bags || ' sacos (' || (v_per.shift).name || ')', auth.uid());
    v_n := v_n + 1; v_total := v_total + v_bags;
  end loop;
  if v_n = 0 then raise exception 'Indique la cantidad de sacos de al menos una bodega' using errcode = '22023'; end if;
  return jsonb_build_object('duplicate', false, 'rows', v_n, 'bags', v_total, 'from', v_per.period_start, 'to', v_per.period_end);
end $$;

create or replace function public.void_bag_tally(p_tally uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.bag_tallies; v_reason text := app.require_reason(p_reason); v_bal numeric; v_job uuid;
begin
  select * into t from public.bag_tallies where id = p_tally for update;
  if not found then raise exception 'Conteo inexistente' using errcode = '42501'; end if;
  if not (app.has_terminal_perm(t.terminal_id, 'corrections.approve') or app.has_terminal_perm(t.terminal_id, 'services.manage')) then
    raise exception 'Permiso insuficiente para anular conteos' using errcode = '42501'; end if;
  if t.status = 'voided' then raise exception 'El conteo ya está anulado' using errcode = '22023'; end if;
  if (select status from public.services where id = t.service_id) = 'cancelled' then raise exception 'El servicio está cancelado' using errcode = '22023'; end if;
  perform app.set_reason(v_reason);
  perform 1 from public.service_hold_cargo where id = t.cargo_id for update;
  if t.bl_id is not null then perform 1 from public.service_bls where id = t.bl_id for update; end if;
  perform set_config('app.ledger_write', 'on', true);
  update public.service_hold_cargo set discharged_tm = discharged_tm - t.net_tm where id = t.cargo_id returning discharged_tm into v_bal;
  if t.bl_id is not null then update public.service_bls set discharged_tm = discharged_tm - t.net_tm where id = t.bl_id; end if;
  perform set_config('app.ledger_write', 'off', true);
  insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, bl_id, tally_id, kind, quantity_tm, balance_after_tm, reason, created_by)
  values (t.organization_id, t.terminal_id, t.service_id, t.cargo_id, t.bl_id, t.id, 'reversal', -t.net_tm, v_bal, 'Anulación de conteo: ' || v_reason, auth.uid());
  update public.bag_tallies set status = 'voided', void_reason = v_reason, voided_at = now(), voided_by = auth.uid() where id = t.id;
  v_job := app.bump_service_revision(t.service_id, v_reason);
  return jsonb_build_object('tally_id', t.id, 'job_id', v_job);
end $$;

create or replace function public.set_bag_damages(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_per record; v_row public.bag_damages; k text;
begin
  select * into v_svc from public.services where id = nullif(p ->> 'service_id', '')::uuid;
  if not found or not app.can_register_bags(v_svc.id) then
    raise exception 'No está autorizado para registrar en este servicio' using errcode = '42501'; end if;
  if v_svc.cargo_type <> 'bags' then raise exception 'Los sacos dañados aplican a servicios en sacos' using errcode = '22023'; end if;
  if v_svc.status in ('finalized', 'cancelled') then raise exception 'El servicio está %', v_svc.status using errcode = '22023'; end if;
  foreach k in array array['dirty', 'broken', 'wet', 'to_sea'] loop
    if coalesce(nullif(p ->> k, '')::int, 0) < 0 then raise exception 'Las cantidades no pueden ser negativas' using errcode = '22023'; end if;
  end loop;
  select * into v_per from app.service_shift_period(v_svc.id, nullif(p ->> 'shift_id', '')::uuid, nullif(p ->> 'shift_date', '')::date);
  insert into public.bag_damages (organization_id, terminal_id, service_id, shift_id, period_start, period_end, dirty, broken, wet, to_sea, notes, updated_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, (v_per.shift).id, v_per.period_start, v_per.period_end,
          coalesce(nullif(p ->> 'dirty', '')::int, 0), coalesce(nullif(p ->> 'broken', '')::int, 0), coalesce(nullif(p ->> 'wet', '')::int, 0),
          coalesce(nullif(p ->> 'to_sea', '')::int, 0), app.opt_text(p, 'notes'), auth.uid())
  on conflict (service_id, period_start) do update set dirty = excluded.dirty, broken = excluded.broken, wet = excluded.wet,
    to_sea = excluded.to_sea, notes = excluded.notes, updated_by = excluded.updated_by
  returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.register_bag_sample(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req uuid := nullif(p ->> 'client_request_id', '')::uuid; v_svc public.services; v_sp public.service_products;
  v_gross numeric := nullif(p ->> 'gross_kg', '')::numeric; v_temp numeric := nullif(p ->> 'temperature_c', '')::numeric;
  v_row public.bag_samples; v_ticket text; v_at timestamptz;
begin
  if auth.uid() is null then raise exception 'No autenticado' using errcode = '42501'; end if;
  if v_req is null then raise exception 'Falta client_request_id' using errcode = '22023'; end if;
  select * into v_row from public.bag_samples where client_request_id = v_req;
  if found then return to_jsonb(v_row) || jsonb_build_object('duplicate', true); end if;
  select * into v_svc from public.services where id = nullif(p ->> 'service_id', '')::uuid;
  if not found or not app.can_register_bags(v_svc.id) then
    raise exception 'No está autorizado para registrar en este servicio' using errcode = '42501'; end if;
  if v_svc.cargo_type <> 'bags' then raise exception 'El peso de sacos aplica a servicios en sacos' using errcode = '22023'; end if;
  if v_svc.status <> 'in_operation' then
    raise exception 'El servicio % no está en operación (estado: %)', v_svc.service_number, v_svc.status using errcode = '22023'; end if;
  select * into v_sp from public.service_products where service_id = v_svc.id and product_id = nullif(p ->> 'product_id', '')::uuid;
  if not found then raise exception 'Seleccione un producto del servicio' using errcode = '22023'; end if;
  if v_sp.bag_tare_kg is null then raise exception 'Configure la tara general del saco para este producto' using errcode = '22023'; end if;
  v_ticket := app.req_text(p, 'ticket_number');
  if v_gross is null or v_gross <= 0 then raise exception 'Ingrese el peso del saco' using errcode = '22023'; end if;
  if v_gross <= v_sp.bag_tare_kg then raise exception 'El peso del saco debe ser mayor que la tara (% kg)', v_sp.bag_tare_kg using errcode = '22023'; end if;
  if v_temp is null then raise exception 'Ingrese la temperatura del saco (°C)' using errcode = '22023'; end if;
  if v_temp < -30 or v_temp > 90 then raise exception 'Temperatura fuera de rango (−30 a 90 °C)' using errcode = '22023'; end if;
  -- Hora del registro: la del servidor, o la indicada (registro posterior), nunca futura.
  v_at := coalesce(app.local_to_ts(v_svc.terminal_id, p ->> 'sampled_local'), now());
  if v_at > now() + interval '5 minutes' then raise exception 'La hora no puede estar en el futuro' using errcode = '22023'; end if;
  insert into public.bag_samples (organization_id, terminal_id, service_id, product_id, ticket_number, gross_kg, tare_kg, temperature_c,
    sampled_at, shift_id, operation_date, client_request_id, registered_by, registered_by_name)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_sp.product_id, v_ticket, v_gross, v_sp.bag_tare_kg, v_temp,
    v_at, app.service_shift_for(v_svc.id, v_at), app.local_date(v_svc.terminal_id, v_at), v_req, auth.uid(), app.actor_name())
  returning * into v_row;
  return to_jsonb(v_row) || jsonb_build_object('duplicate', false);
end $$;

-- Anulación: supervisión/administración, o el mismo operador dentro de los 30 minutos siguientes.
create or replace function public.void_bag_sample(p_sample uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare b public.bag_samples; v_reason text := app.require_reason(p_reason, 4);
begin
  select * into b from public.bag_samples where id = p_sample for update;
  if not found then raise exception 'Registro inexistente' using errcode = '42501'; end if;
  if not (app.has_terminal_perm(b.terminal_id, 'corrections.approve') or app.has_terminal_perm(b.terminal_id, 'services.manage')
          or (b.registered_by = auth.uid() and b.created_at > now() - interval '30 minutes')) then
    raise exception 'Sin permiso para anular este registro' using errcode = '42501'; end if;
  if b.status = 'voided' then raise exception 'El registro ya está anulado' using errcode = '22023'; end if;
  perform app.set_reason(v_reason);
  update public.bag_samples set status = 'voided', void_reason = v_reason where id = p_sample;
end $$;

-- ---------------------------------------------------------------- avance por turno y verificación de sacos
create or replace function app.shift_progress(p_service uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with svc as (select s.id, app.terminal_tz(s.terminal_id) tz from public.services s where s.id = p_service),
  mv as (
    select t.service_hold_id hold_id, t.net_tm tm, null::int bags, t.shift_id, app.shift_period_start(t.shift_id, t.weighed_at) ps
    from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.shift_id is not null
    union all
    select b.service_hold_id, b.net_tm, b.bags, b.shift_id, b.period_start from public.bag_tallies b where b.service_id = p_service and b.status = 'valid'
  ),
  periods as (
    select distinct on (ps) ps, shift_id from (
      select ps, shift_id from mv
      union all
      select d.period_start, d.shift_id from public.bag_damages d where d.service_id = p_service) u
    order by ps
  ),
  agg as (
    select row_number() over (order by p.ps) n, p.ps, p.shift_id,
      (select coalesce(sum(tm), 0) from mv where mv.ps = p.ps) tm,
      (select sum(bags) from mv where mv.ps = p.ps) bags,
      (select coalesce(jsonb_agg(jsonb_build_object('hold_number', h.hold_number, 'tm', round(coalesce(x.tm, 0), 3), 'bags', x.bags) order by h.hold_number), '[]'::jsonb)
         from public.service_holds h
         left join (select hold_id, sum(tm) tm, sum(bags) bags from mv where mv.ps = p.ps group by hold_id) x on x.hold_id = h.id
        where h.service_id = p_service) holds
    from periods p
  ),
  cum as (select a.*, sum(a.tm) over (order by a.n) cum_tm, sum(coalesce(a.bags, 0)) over (order by a.n) cum_bags from agg a)
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', c.n, 'shift_id', c.shift_id, 'shift_name', sh.name,
      'from', to_char(c.ps at time zone svc.tz, 'YYYY-MM-DD"T"HH24:MI'),
      'to', to_char(app.shift_period_end(c.shift_id, c.ps) at time zone svc.tz, 'YYYY-MM-DD"T"HH24:MI'),
      'holds', c.holds, 'tm', round(c.tm, 3), 'bags', c.bags, 'cum_tm', round(c.cum_tm, 3), 'cum_bags', c.cum_bags,
      'damaged', (select jsonb_build_object('dirty', d.dirty, 'broken', d.broken, 'wet', d.wet, 'to_sea', d.to_sea,
                                            'total', d.dirty + d.broken + d.wet + d.to_sea, 'notes', d.notes)
                  from public.bag_damages d where d.service_id = p_service and d.period_start = c.ps)
    ) order by c.n), '[]'::jsonb)
  from cum c cross join svc left join public.shifts sh on sh.id = c.shift_id
$$;

create or replace function app.bag_sample_summary(p_service uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('count', count(*), 'avg_gross_kg', round(avg(b.gross_kg), 3), 'avg_net_kg', round(avg(b.net_kg), 3),
                            'avg_temp_c', round(avg(b.temperature_c), 2), 'min_net_kg', min(b.net_kg), 'max_net_kg', max(b.net_kg),
                            'target_net_kg', (select max(sp.bag_weight_kg) from public.service_products sp where sp.service_id = p_service))
  from public.bag_samples b where b.service_id = p_service and b.status = 'valid'
$$;

-- Verificación de sacos agrupada por turno y por boleta (camión), para el informe.
create or replace function app.bag_sample_report(p_service uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with svc as (select app.terminal_tz(s.terminal_id) tz from public.services s where s.id = p_service),
  b as (
    select bs.*, case when bs.shift_id is not null then app.shift_period_start(bs.shift_id, bs.sampled_at) end ps,
           sp.bag_weight_kg target_net, sp.bag_weight_kg + coalesce(sp.bag_tare_kg, 0) target_gross, p.name product
    from public.bag_samples bs
    join public.service_products sp on sp.service_id = bs.service_id and sp.product_id = bs.product_id
    join public.products p on p.id = bs.product_id
    where bs.service_id = p_service and bs.status = 'valid'
  ),
  tk as (
    select ps, shift_id, ticket_number, product, min(sampled_at) first_at, count(*) n, avg(gross_kg) g, avg(net_kg) nt, avg(temperature_c) tc,
           max(target_net) target_net, max(target_gross) target_gross
    from b group by ps, shift_id, ticket_number, product
  ),
  per as (
    select ps, shift_id,
      jsonb_agg(jsonb_build_object('ticket', ticket_number, 'product', product, 'samples', n, 'avg_gross_kg', round(g, 3), 'avg_net_kg', round(nt, 3),
                                   'avg_temp_c', round(tc, 2), 'target_net_kg', target_net, 'target_gross_kg', target_gross) order by first_at) rows_,
      sum(n) samples
    from tk group by ps, shift_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'shift_name', sh.name,
      'from', to_char(per.ps at time zone svc.tz, 'DD/MM/YYYY HH24:MI'),
      'to', to_char(app.shift_period_end(per.shift_id, per.ps) at time zone svc.tz, 'DD/MM/YYYY HH24:MI'),
      'rows', per.rows_, 'samples', per.samples,
      'avg_gross_kg', (select round(avg(gross_kg), 3) from b where b.ps is not distinct from per.ps),
      'avg_net_kg', (select round(avg(net_kg), 3) from b where b.ps is not distinct from per.ps),
      'avg_temp_c', (select round(avg(temperature_c), 2) from b where b.ps is not distinct from per.ps)
    ) order by per.ps nulls last), '[]'::jsonb)
  from per cross join svc left join public.shifts sh on sh.id = per.shift_id
$$;

-- Las métricas incluyen avance por turno, operación (carga/descarga) y sacos.
alter function app.service_metrics(uuid, timestamptz, timestamptz) rename to service_metrics_base;
create or replace function app.service_metrics(p_service uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := app.service_metrics_base(p_service, p_from, p_to); v_svc public.services; v_bags bigint; v_tm numeric;
begin
  if v is null then return null; end if;
  select * into v_svc from public.services where id = p_service;
  v := v || jsonb_build_object('operation_kind', v_svc.operation_kind, 'shift_periods', app.shift_progress(p_service),
                               'bag_samples', app.bag_sample_summary(p_service));
  if v_svc.cargo_type = 'bags' then
    select coalesce(sum(bags), 0), coalesce(sum(net_tm), 0) into v_bags, v_tm from public.bag_tallies
     where service_id = p_service and status = 'valid' and period_start >= coalesce(p_from, '-infinity') and period_start < coalesce(p_to, 'infinity');
    v := v || jsonb_build_object('bags_in_range', v_bags, 'tons_in_range', round(v_tm, 3),
      'damaged_bags', (select coalesce(sum(dirty + broken + wet + to_sea), 0) from public.bag_damages where service_id = p_service));
  end if;
  return v;
end $$;

-- Cierre: la conciliación incluye los conteos de sacos.
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
  select count(*) into v_bad from public.service_hold_cargo c
  where c.service_id = p_service and (
        c.discharged_tm <> (select coalesce(sum(m.quantity_tm), 0) from public.cargo_movements m where m.cargo_id = c.id)
     or c.discharged_tm <> (select coalesce(sum(t.net_tm), 0) from public.weigh_tickets t where t.cargo_id = c.id and t.status = 'valid')
                         + (select coalesce(sum(b.net_tm), 0) from public.bag_tallies b where b.cargo_id = c.id and b.status = 'valid'));
  select v_bad + count(*) into v_bad from public.service_bls bl
  where bl.service_id = p_service and (
        bl.discharged_tm <> (select coalesce(sum(m.quantity_tm), 0) from public.cargo_movements m where m.bl_id = bl.id)
     or bl.discharged_tm <> (select coalesce(sum(t.net_tm), 0) from public.weigh_tickets t where t.bl_id = bl.id and t.status = 'valid')
                          + (select coalesce(sum(b.net_tm), 0) from public.bag_tallies b where b.bl_id = bl.id and b.status = 'valid'));
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

-- Datos del informe: se agregan la verificación de sacos y los datos de la operación.
alter function public.worker_report_payload(uuid) rename to worker_report_payload_base;
create or replace function public.worker_report_payload(p_service uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_svc public.services;
begin
  select * into v_svc from public.services where id = p_service;
  return public.worker_report_payload_base(p_service) || jsonb_build_object(
    'operation_kind', v_svc.operation_kind,
    'bag_sample_report', app.bag_sample_report(p_service),
    'shift_plan', (select name from public.shift_plans where id = v_svc.shift_plan_id));
end $$;
revoke execute on function public.worker_report_payload(uuid), public.worker_report_payload_base(uuid) from public, anon, authenticated;
grant execute on function public.worker_report_payload(uuid), public.worker_report_payload_base(uuid) to service_role;

-- ---------------------------------------------------------------- vista de servicios
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
       s.cargo_type, s.operation_kind, s.shift_plan_id
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
grant select on public.service_overview to authenticated;

-- ---------------------------------------------------------------- creación del servicio
-- Formato:
-- { terminal_id, service_number, status, customer_id, planned_start, estimated_end,
--   responsible_user_id, responsible_name, observations,
--   cargo_type: 'bulk' | 'bags', operation_kind: 'discharge' | 'load', shift_plan_id,
--   operator_ids: [usuarios que registran conteos y pesos de sacos],
--   vessel_id | vessel: { name, imo_number, flag },
--   holds_count: 1..6,
--   products: [{ product_id | product_name, bag_weight_kg, uses_bl,
--                bag_tare_kg, holds: [{ hold_number, planned_tm }], bls: [{ bl_number, planned_tm }] }],
--   points: [{ scale_id } | { name, location, operator_ids, time_capture_mode }],
--   trucks: [{ plate, driver_name, tractor_plate, driver_dpi, carrier }] }
-- También acepta el formato anterior (holds[].cargo[] y scale_ids).
create or replace function public.create_service(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_terminal uuid := (app.req_text(p, 'terminal_id'))::uuid;
  v_org uuid; v_id uuid; v_number text := app.req_text(p, 'service_number');
  v_status text := coalesce(app.opt_text(p, 'status'), 'scheduled');
  v_type text := coalesce(app.opt_text(p, 'cargo_type'), 'bulk');
  v_vessel uuid; v_holds int; v_products jsonb := p -> 'products';
  v_prod jsonb; v_h jsonb; v_bl jsonb; v_pt jsonb; v_scale text; v_pid uuid; v_sp uuid; v_hold_id uuid;
  v_total numeric; v_bl_total numeric; v_qty numeric; v_hn int; v_bag numeric; v_uses_bl boolean; v_i int := 0; v_j int;
  v_seen uuid[] := '{}'; v_bl_number text;
  v_kind text := coalesce(app.opt_text(p, 'operation_kind'), 'discharge');
  v_plan uuid := nullif(p ->> 'shift_plan_id', '')::uuid; v_user text;
begin
  perform app.require_terminal_perm(v_terminal, 'services.manage');
  select organization_id into v_org from public.terminals where id = v_terminal;
  if v_status not in ('scheduled', 'preparing') then
    raise exception 'Un servicio nuevo inicia como Programado o En preparación' using errcode = '22023';
  end if;
  if v_type not in ('bulk', 'bags') then raise exception 'Indique si la carga es a granel o en sacos' using errcode = '22023'; end if;
  if v_kind not in ('discharge', 'load') then raise exception 'Indique si el servicio es de descarga o de carga' using errcode = '22023'; end if;
  if v_plan is null then v_plan := app.default_shift_plan(v_terminal); end if;
  if not exists (select 1 from public.shift_plans where id = v_plan and terminal_id = v_terminal and status = 'active') then
    raise exception 'El esquema de turnos no pertenece a la terminal' using errcode = '22023'; end if;
  if exists (select 1 from public.services where organization_id = v_org and lower(service_number) = lower(v_number)) then
    raise exception 'El número de servicio "%" ya existe en la empresa', v_number using errcode = '23505';
  end if;

  if v_products is null and jsonb_typeof(p -> 'holds') = 'array' then
    select jsonb_agg(jsonb_build_object('product_id', x.pid, 'holds', x.hs)) into v_products
    from (select c ->> 'product_id' as pid,
                 jsonb_agg(jsonb_build_object('hold_number', (h ->> 'hold_number')::int, 'planned_tm', c -> 'initial_tm')) as hs
          from jsonb_array_elements(p -> 'holds') h, jsonb_array_elements(coalesce(h -> 'cargo', '[]'::jsonb)) c
          group by 1) x;
    select max((h ->> 'hold_number')::int) into v_holds from jsonb_array_elements(p -> 'holds') h;
  end if;
  v_holds := coalesce(nullif(p ->> 'holds_count', '')::int, v_holds);
  v_vessel := app.resolve_vessel(v_org, p, v_holds);
  if v_holds is null then select least(holds_count, 6) into v_holds from public.vessels where id = v_vessel; end if;
  if v_holds is null or v_holds < 1 or v_holds > 6 then
    raise exception 'El buque debe tener de 1 a 6 bodegas' using errcode = '22023'; end if;
  if v_products is null or jsonb_typeof(v_products) <> 'array' or jsonb_array_length(v_products) = 0 then
    raise exception 'Agregue al menos un producto con su cantidad por bodega' using errcode = '22023'; end if;

  insert into public.services (organization_id, terminal_id, customer_id, vessel_id, service_number, status, cargo_type, operation_kind, shift_plan_id,
                               planned_start, estimated_end, responsible_user_id, responsible_name, observations, created_by)
  values (v_org, v_terminal, (app.req_text(p, 'customer_id'))::uuid, v_vessel, v_number, v_status, v_type, v_kind, v_plan,
          nullif(p ->> 'planned_start', '')::timestamptz, nullif(p ->> 'estimated_end', '')::timestamptz,
          nullif(p ->> 'responsible_user_id', '')::uuid, app.opt_text(p, 'responsible_name'),
          app.opt_text(p, 'observations'), auth.uid())
  returning id into v_id;

  for v_hn in 1 .. v_holds loop
    insert into public.service_holds (organization_id, terminal_id, service_id, vessel_id, hold_number)
    values (v_org, v_terminal, v_id, v_vessel, v_hn);
  end loop;

  for v_prod in select * from jsonb_array_elements(v_products) loop
    v_i := v_i + 1;
    v_pid := app.resolve_product(v_org, nullif(v_prod ->> 'product_id', '')::uuid, app.opt_text(v_prod, 'product_name'));
    if v_pid = any (v_seen) then raise exception 'Hay un producto repetido en el servicio' using errcode = '22023'; end if;
    v_seen := v_seen || v_pid;
    v_bag := case when v_type = 'bags' then nullif(v_prod ->> 'bag_weight_kg', '')::numeric end;
    if v_type = 'bags' and (v_bag is null or v_bag <= 0) then
      raise exception 'Indique el peso por saco (kg) de cada producto' using errcode = '22023'; end if;
    v_uses_bl := coalesce(nullif(v_prod ->> 'uses_bl', '')::boolean, jsonb_array_length(coalesce(v_prod -> 'bls', '[]'::jsonb)) > 0);
    insert into public.service_products (organization_id, terminal_id, service_id, product_id, bag_weight_kg, bag_tare_kg, uses_bl, sort)
    values (v_org, v_terminal, v_id, v_pid, v_bag, case when v_type = 'bags' then nullif(v_prod ->> 'bag_tare_kg', '')::numeric end, v_uses_bl, v_i)
    returning id into v_sp;

    v_total := 0;
    for v_h in select * from jsonb_array_elements(coalesce(v_prod -> 'holds', '[]'::jsonb)) loop
      v_hn := nullif(v_h ->> 'hold_number', '')::int;
      v_qty := round(nullif(v_h ->> 'planned_tm', '')::numeric, 3);
      if v_qty is null or v_qty = 0 then continue; end if;
      if v_qty < 0 then raise exception 'Las cantidades deben ser mayores que cero' using errcode = '22023'; end if;
      if v_hn is null or v_hn < 1 or v_hn > v_holds then
        raise exception 'La bodega % no existe (el buque tiene % bodegas)', v_hn, v_holds using errcode = '22023'; end if;
      select id into v_hold_id from public.service_holds where service_id = v_id and hold_number = v_hn;
      begin
        insert into public.service_hold_cargo (organization_id, terminal_id, service_id, service_hold_id, product_id, initial_tm)
        values (v_org, v_terminal, v_id, v_hold_id, v_pid, v_qty);
      exception when unique_violation then
        raise exception 'La bodega % tiene el mismo producto dos veces', v_hn using errcode = '22023';
      end;
      v_total := v_total + v_qty;
    end loop;
    if v_total = 0 then
      raise exception 'Indique en qué bodega(s) viene cada producto y cuántas toneladas' using errcode = '22023'; end if;
    if nullif(v_prod ->> 'planned_tm', '') is not null and abs(round((v_prod ->> 'planned_tm')::numeric, 3) - v_total) > 0.01 then
      raise exception 'La suma por bodegas (% TM) no coincide con el total del producto (% TM)', v_total, round((v_prod ->> 'planned_tm')::numeric, 3)
        using errcode = '22023'; end if;

    if v_uses_bl then
      v_bl_total := 0; v_j := 0;
      for v_bl in select * from jsonb_array_elements(coalesce(v_prod -> 'bls', '[]'::jsonb)) loop
        v_j := v_j + 1;
        v_bl_number := nullif(btrim(v_bl ->> 'bl_number'), '');
        v_qty := round(nullif(v_bl ->> 'planned_tm', '')::numeric, 3);
        if v_bl_number is null then raise exception 'Indique el número de cada BL' using errcode = '22023'; end if;
        if v_qty is null or v_qty <= 0 then raise exception 'Indique la cantidad del BL %', v_bl_number using errcode = '22023'; end if;
        begin
          insert into public.service_bls (organization_id, terminal_id, service_id, service_product_id, product_id, bl_number, planned_tm, sort, created_by)
          values (v_org, v_terminal, v_id, v_sp, v_pid, v_bl_number, v_qty, v_j, auth.uid());
        exception when unique_violation then
          raise exception 'El BL % está repetido en el servicio', v_bl_number using errcode = '23505';
        end;
        v_bl_total := v_bl_total + v_qty;
      end loop;
      if v_j = 0 then raise exception 'El producto viene por BL: agregue al menos un BL con su cantidad' using errcode = '22023'; end if;
      if abs(v_bl_total - v_total) > 0.01 then
        raise exception 'La suma de los BL (% TM) no coincide con la cantidad del producto (% TM)', v_bl_total, v_total using errcode = '22023'; end if;
    end if;
  end loop;

  for v_pt in select * from jsonb_array_elements(coalesce(p -> 'points', '[]'::jsonb)) loop
    perform app.attach_point(v_id, v_pt);
  end loop;
  for v_scale in select jsonb_array_elements_text(coalesce(p -> 'scale_ids', '[]'::jsonb)) loop
    perform app.attach_point(v_id, jsonb_build_object('scale_id', v_scale));
  end loop;
  for v_user in select jsonb_array_elements_text(coalesce(p -> 'operator_ids', '[]'::jsonb)) loop
    if not exists (select 1 from public.organization_members m where m.organization_id = v_org and m.user_id = v_user::uuid and m.status = 'active') then
      raise exception 'El operador seleccionado no pertenece a la empresa' using errcode = '22023'; end if;
    insert into public.service_operators (service_id, user_id, organization_id, terminal_id) values (v_id, v_user::uuid, v_org, v_terminal) on conflict do nothing;
  end loop;
  if jsonb_typeof(p -> 'trucks') = 'array' and jsonb_array_length(p -> 'trucks') > 0 then
    perform app.upsert_trucks(v_id, p -> 'trucks');
  end if;
  return v_id;
end $$;
grant execute on function public.create_service(jsonb) to authenticated;

-- ---------------------------------------------------------------- privilegios de ejecución
grant execute on function public.set_service_operators(uuid, uuid[]), public.update_service_product(uuid, jsonb),
  public.register_bag_tally(jsonb), public.void_bag_tally(uuid, text), public.set_bag_damages(jsonb),
  public.register_bag_sample(jsonb), public.void_bag_sample(uuid, text) to authenticated;

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
