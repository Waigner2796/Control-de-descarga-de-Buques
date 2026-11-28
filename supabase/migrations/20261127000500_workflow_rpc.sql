-- =============================================================================
-- VESSEL CONTROL · Migración 005 · Funciones transaccionales del flujo operativo
-- Todas: SECURITY DEFINER + search_path vacío + validación explícita de identidad
-- y permisos con app.require_*; mensajes de error en español para la interfaz.
-- =============================================================================

-- ---------------------------------------------------------------- utilidades internas
create or replace function app.req_text(p jsonb, k text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(p ->> k), '');
begin
  if v is null then raise exception 'Falta el campo obligatorio: %', k using errcode = '22023'; end if;
  return v;
end $$;

create or replace function app.opt_text(p jsonb, k text) returns text
language sql immutable set search_path = '' as $$ select nullif(btrim(p ->> k), '') $$;

create or replace function app.require_reason(p_reason text, p_min int default 8) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_reason is null or length(btrim(p_reason)) < p_min then
    raise exception 'Indique el motivo (mínimo % caracteres)', p_min using errcode = '22023';
  end if;
  return btrim(p_reason);
end $$;

create or replace function app.terminal_tz(p_terminal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select timezone from public.terminals where id = p_terminal
$$;

-- Convierte 'YYYY-MM-DDTHH:MI[:SS]' en hora local de la terminal a timestamptz (UTC).
create or replace function app.local_to_ts(p_terminal uuid, p_local text) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text := app.terminal_tz(p_terminal);
begin
  if p_local is null or btrim(p_local) = '' then return null; end if;
  return (p_local::timestamp) at time zone v_tz;
exception when others then
  raise exception 'Fecha/hora inválida: %', p_local using errcode = '22007';
end $$;

create or replace function app.time_mode_for_scale(p_scale uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(ss.time_capture_mode, ts.time_capture_mode, 'manual')
  from public.scales s
  left join public.scale_settings ss on ss.scale_id = s.id
  left join public.terminal_settings ts on ts.terminal_id = s.terminal_id
  where s.id = p_scale
$$;
grant execute on function app.time_mode_for_scale(uuid) to authenticated, service_role;

create or replace function app.member_role(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role_code from public.organization_members m
  where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.status = 'active' and app.is_active_user()
$$;

-- Báscula autorizada: el Administrador Master puede operar cualquier báscula de sus
-- terminales; el resto de usuarios solo las que tiene asignadas en scale_users.
create or replace function app.is_scale_authorized(p_scale uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.scales s
    where s.id = p_scale
      and app.has_terminal_perm(s.terminal_id, 'weighing.register')
      and (app.member_role(s.organization_id) = 'master_admin'
           or exists (select 1 from public.scale_users su where su.scale_id = s.id and su.user_id = (select auth.uid())))
  )
$$;
grant execute on function app.is_scale_authorized(uuid) to authenticated, service_role;

create or replace function app.notify_users(p_org uuid, p_users uuid[], p_kind text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (organization_id, recipient_user_id, kind, title, body, link)
  select p_org, u, p_kind, p_title, coalesce(p_body, ''), p_link
  from (select distinct unnest(p_users) as u) x where u is not null
$$;

create or replace function app.users_with_terminal_perm(p_terminal uuid, p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.user_id), '{}')
  from public.terminals t
  join public.organization_members m on m.organization_id = t.organization_id and m.status = 'active'
  join public.user_profiles p on p.user_id = m.user_id and p.status = 'active'
  where t.id = p_terminal
    and (m.all_terminals or m.role_code = 'master_admin'
         or exists (select 1 from public.terminal_members tm where tm.terminal_id = t.id and tm.user_id = m.user_id))
    and (exists (select 1 from public.role_permissions rp where rp.role_code = m.role_code and rp.permission_code = p_perm)
         or p_perm = any (m.extra_permissions))
$$;

-- Incrementa la revisión de datos del servicio. Si ya estaba finalizado, el informe
-- vigente queda "en revisión" y se encola una nueva versión documental.
create or replace function app.bump_service_revision(p_service uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_report uuid; v_job uuid;
begin
  perform set_config('app.rpc', 'on', true);
  update public.services set data_revision = data_revision + 1 where id = p_service returning * into v_svc;
  perform set_config('app.rpc', 'off', true);
  if v_svc.status <> 'finalized' then return null; end if;

  insert into public.generated_reports (organization_id, terminal_id, service_id, customer_id, status)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id, 'generating')
  on conflict (service_id, kind) do update
    set status = case when public.generated_reports.current_version_id is null then 'generating' else 'revision_pending' end
  returning id into v_report;

  insert into public.report_jobs (organization_id, terminal_id, service_id, report_id, data_revision, idempotency_key, requested_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_report, v_svc.data_revision,
          'final_service:' || v_svc.id || ':' || v_svc.data_revision, auth.uid())
  on conflict (idempotency_key) do nothing
  returning id into v_job;
  return v_job;
end $$;

-- ---------------------------------------------------------------- contexto del usuario
create or replace function public.my_context() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'profile', (select jsonb_build_object('user_id', p.user_id, 'full_name', p.full_name, 'email', p.email, 'phone', p.phone,
                  'position', p.position, 'kind', p.kind, 'status', p.status, 'must_change_password', p.must_change_password)
                from public.user_profiles p where p.user_id = auth.uid()),
    'is_platform_admin', exists (select 1 from public.platform_admins a where a.user_id = auth.uid()),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'organization_id', m.organization_id, 'organization_name', o.name, 'organization_logo', o.logo_path,
        'role_code', m.role_code, 'role_name', r.name, 'all_terminals', m.all_terminals,
        'permissions', (select coalesce(jsonb_agg(distinct q.x), '[]'::jsonb) from (
                          select rp.permission_code as x from public.role_permissions rp where rp.role_code = m.role_code
                          union select unnest(m.extra_permissions)) q),
        'terminal_ids', (select coalesce(jsonb_agg(tm.terminal_id), '[]'::jsonb) from public.terminal_members tm
                         where tm.user_id = m.user_id and tm.organization_id = m.organization_id),
        'scale_ids', (select coalesce(jsonb_agg(su.scale_id), '[]'::jsonb) from public.scale_users su
                      where su.user_id = m.user_id and su.organization_id = m.organization_id)
      ) order by o.name)
      from public.organization_members m
      join public.organizations o on o.id = m.organization_id and o.status = 'active'
      join public.roles r on r.code = m.role_code
      where m.user_id = auth.uid() and m.status = 'active'), '[]'::jsonb),
    'customer_links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_user_id', cu.id, 'customer_id', c.id, 'customer_name', c.trade_name, 'customer_logo', c.logo_path,
        'organization_id', o.id, 'organization_name', o.name, 'organization_logo', o.logo_path,
        'can_view_reports', coalesce(pp.can_view_reports, true), 'can_download_reports', coalesce(pp.can_download_reports, true),
        'can_view_documents', coalesce(pp.can_view_documents, true), 'can_view_productivity', coalesce(pp.can_view_productivity, true)))
      from public.customer_users cu
      join public.customers c on c.id = cu.customer_id and c.status = 'active'
      join public.organizations o on o.id = cu.organization_id and o.status = 'active'
      left join public.customer_portal_permissions pp on pp.customer_user_id = cu.id
      where cu.user_id = auth.uid() and cu.status = 'active'), '[]'::jsonb)
  )
$$;
grant execute on function public.my_context() to authenticated;

-- Confirma en servidor que la contraseña temporal fue reemplazada (compara hashes de GoTrue).
create or replace function public.confirm_password_changed() returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_initial text; v_current text;
begin
  if auth.uid() is null then raise exception 'No autenticado' using errcode = '42501'; end if;
  select initial_hash into v_initial from app.pending_password_changes where user_id = auth.uid();
  select encrypted_password into v_current from auth.users where id = auth.uid();
  if v_initial is not null and v_current is not distinct from v_initial then
    raise exception 'La contraseña aún no ha sido cambiada' using errcode = '42501';
  end if;
  delete from app.pending_password_changes where user_id = auth.uid();
  update public.user_profiles set must_change_password = false, password_changed_at = now() where user_id = auth.uid();
  return true;
end $$;
grant execute on function public.confirm_password_changed() to authenticated;

-- ---------------------------------------------------------------- servicios
create or replace function public.create_service(p jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_terminal uuid := (app.req_text(p, 'terminal_id'))::uuid;
  v_org uuid; v_id uuid; v_number text := app.req_text(p, 'service_number');
  v_status text := coalesce(app.opt_text(p, 'status'), 'scheduled');
  v_hold jsonb; v_cargo jsonb; v_hold_id uuid; v_scale text; v_vessel uuid;
begin
  perform app.require_terminal_perm(v_terminal, 'services.manage');
  select organization_id into v_org from public.terminals where id = v_terminal;
  if v_status not in ('scheduled', 'preparing') then
    raise exception 'Un servicio nuevo inicia como Programado o En preparación' using errcode = '22023';
  end if;
  if exists (select 1 from public.services where organization_id = v_org and lower(service_number) = lower(v_number)) then
    raise exception 'El número de servicio "%" ya existe en la empresa', v_number using errcode = '23505';
  end if;
  v_vessel := (app.req_text(p, 'vessel_id'))::uuid;

  insert into public.services (organization_id, terminal_id, customer_id, vessel_id, service_number, status,
                               planned_start, estimated_end, responsible_user_id, responsible_name, observations, created_by)
  values (v_org, v_terminal, (app.req_text(p, 'customer_id'))::uuid, v_vessel, v_number, v_status,
          nullif(p ->> 'planned_start', '')::timestamptz, nullif(p ->> 'estimated_end', '')::timestamptz,
          nullif(p ->> 'responsible_user_id', '')::uuid, app.opt_text(p, 'responsible_name'),
          app.opt_text(p, 'observations'), auth.uid())
  returning id into v_id;

  for v_hold in select * from jsonb_array_elements(coalesce(p -> 'holds', '[]'::jsonb)) loop
    insert into public.service_holds (organization_id, terminal_id, service_id, vessel_id, vessel_hold_id, hold_number, capacity_tm)
    values (v_org, v_terminal, v_id, coalesce(nullif(v_hold ->> 'vessel_id', '')::uuid, v_vessel),
            nullif(v_hold ->> 'vessel_hold_id', '')::uuid, (v_hold ->> 'hold_number')::int,
            nullif(v_hold ->> 'capacity_tm', '')::numeric)
    returning id into v_hold_id;
    for v_cargo in select * from jsonb_array_elements(coalesce(v_hold -> 'cargo', '[]'::jsonb)) loop
      insert into public.service_hold_cargo (organization_id, terminal_id, service_id, service_hold_id, product_id, initial_tm)
      values (v_org, v_terminal, v_id, v_hold_id, (v_cargo ->> 'product_id')::uuid, (v_cargo ->> 'initial_tm')::numeric);
    end loop;
  end loop;

  for v_scale in select jsonb_array_elements_text(coalesce(p -> 'scale_ids', '[]'::jsonb)) loop
    insert into public.service_scales (service_id, scale_id, organization_id, terminal_id)
    values (v_id, v_scale::uuid, v_org, v_terminal);
  end loop;
  return v_id;
end $$;
grant execute on function public.create_service(jsonb) to authenticated;

create or replace function public.change_service_status(p_service uuid, p_status text, p_reason text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_ok boolean;
begin
  select * into v_svc from public.services where id = p_service for update;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'services.status');
  if p_status = 'finalized' then
    raise exception 'Para finalizar use el cierre de operación (valida, concilia y genera el informe)' using errcode = '22023';
  end if;
  v_ok := case v_svc.status
    when 'scheduled'    then p_status in ('preparing', 'in_operation', 'cancelled')
    when 'preparing'    then p_status in ('scheduled', 'in_operation', 'cancelled')
    when 'in_operation' then p_status in ('suspended', 'closing')
    when 'suspended'    then p_status in ('in_operation', 'closing', 'cancelled')
    when 'closing'      then p_status in ('in_operation', 'suspended')
    else false end;
  if not v_ok then
    raise exception 'Transición no permitida: % → %', v_svc.status, p_status using errcode = '22023';
  end if;
  if p_status in ('suspended', 'cancelled') then perform app.require_reason(p_reason); end if;
  if p_status = 'cancelled' then
    perform app.require_terminal_perm(v_svc.terminal_id, 'services.manage');
    if exists (select 1 from public.weigh_tickets where service_id = p_service and status = 'valid') then
      raise exception 'No se puede cancelar un servicio con pesajes válidos; anúlelos o finalice el servicio' using errcode = '22023';
    end if;
  end if;
  perform app.set_reason(p_reason);
  perform set_config('app.rpc', 'on', true);
  update public.services
     set status = p_status,
         actual_start = case when p_status = 'in_operation' and actual_start is null then now() else actual_start end
   where id = p_service;
  perform set_config('app.rpc', 'off', true);
  if p_status <> 'in_operation' then
    update public.scale_visits set status = 'cancelled', cancel_reason = 'Servicio cambió a ' || p_status
     where service_id = p_service and status = 'open' and p_status = 'cancelled';
  end if;
  return p_status;
end $$;
grant execute on function public.change_service_status(uuid, text, text) to authenticated;

-- Ajuste auditado del tonelaje manifestado (no toca el saldo descargado).
create or replace function public.adjust_cargo_initial(p_cargo uuid, p_new_initial numeric, p_reason text) returns numeric
language plpgsql security definer set search_path = '' as $$
declare v_c public.service_hold_cargo; v_status text; v_reason text := app.require_reason(p_reason);
begin
  select * into v_c from public.service_hold_cargo where id = p_cargo for update;
  if not found then raise exception 'Carga inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_c.terminal_id, 'cargo.adjust');
  select status into v_status from public.services where id = v_c.service_id;
  if v_status in ('finalized', 'cancelled') then
    raise exception 'El servicio está %; requiere reapertura', v_status using errcode = '22023';
  end if;
  if p_new_initial is null or p_new_initial <= 0 then raise exception 'Tonelaje inválido' using errcode = '22023'; end if;
  if p_new_initial < v_c.discharged_tm then
    raise exception 'El nuevo tonelaje (% TM) es menor que lo ya descargado (% TM)', p_new_initial, v_c.discharged_tm using errcode = '22023';
  end if;
  perform app.set_reason(v_reason);
  perform set_config('app.ledger_write', 'on', true);
  update public.service_hold_cargo set initial_tm = p_new_initial where id = p_cargo;
  perform set_config('app.ledger_write', 'off', true);
  insert into public.cargo_adjustments (organization_id, terminal_id, service_id, cargo_id, previous_initial_tm, new_initial_tm, reason, created_by)
  values (v_c.organization_id, v_c.terminal_id, v_c.service_id, v_c.id, v_c.initial_tm, p_new_initial, v_reason, auth.uid());
  insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
  values (v_c.organization_id, 'cargo_adjustment', v_c.id, 'approved', auth.uid(), app.actor_name(), v_reason);
  return p_new_initial;
end $$;
grant execute on function public.adjust_cargo_initial(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------- visitas (modalidad hora del servidor)
create or replace function public.start_scale_visit(p_scale uuid, p_service uuid, p_draft jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_scale public.scales; v_svc public.services; v_visit public.scale_visits;
begin
  select * into v_scale from public.scales where id = p_scale;
  if not found or not app.is_scale_authorized(p_scale) then
    raise exception 'No está autorizado para operar esta báscula' using errcode = '42501'; end if;
  if v_scale.status <> 'active' then raise exception 'La báscula no está activa' using errcode = '22023'; end if;
  if app.time_mode_for_scale(p_scale) <> 'server_now' then
    raise exception 'Esta báscula usa captura manual de horas' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = p_service;
  if not found or v_svc.status <> 'in_operation' then
    raise exception 'El servicio no está en operación' using errcode = '22023'; end if;
  if not exists (select 1 from public.service_scales where service_id = p_service and scale_id = p_scale) then
    raise exception 'La báscula no está asignada a este servicio' using errcode = '22023'; end if;
  insert into public.scale_visits (organization_id, terminal_id, service_id, scale_id, started_at, draft, opened_by)
  values (v_scale.organization_id, v_scale.terminal_id, p_service, p_scale, now(), coalesce(p_draft, '{}'), auth.uid())
  returning * into v_visit;
  return to_jsonb(v_visit);
end $$;

create or replace function public.stamp_scale_visit_end(p_visit uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.scale_visits;
begin
  select * into v from public.scale_visits where id = p_visit for update;
  if not found or not app.is_scale_authorized(v.scale_id) then
    raise exception 'Visita inexistente o no autorizada' using errcode = '42501'; end if;
  if v.status <> 'open' then raise exception 'La visita ya no está abierta' using errcode = '22023'; end if;
  update public.scale_visits set ended_at = now() where id = p_visit returning * into v;
  return to_jsonb(v);
end $$;

create or replace function public.cancel_scale_visit(p_visit uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare v public.scale_visits;
begin
  select * into v from public.scale_visits where id = p_visit for update;
  if not found or not app.is_scale_authorized(v.scale_id) then
    raise exception 'Visita inexistente o no autorizada' using errcode = '42501'; end if;
  if v.status <> 'open' then raise exception 'La visita ya no está abierta' using errcode = '22023'; end if;
  update public.scale_visits set status = 'cancelled', cancel_reason = app.require_reason(p_reason, 4) where id = p_visit;
end $$;
grant execute on function public.start_scale_visit(uuid, uuid, jsonb), public.stamp_scale_visit_end(uuid),
  public.cancel_scale_visit(uuid, text) to authenticated;

-- ---------------------------------------------------------------- transporte (upsert interno)
create or replace function app.upsert_transport(p_org uuid, p_plate text, p_tc text, p_dpi text, p_driver text, p_capn numeric,
  out truck_id uuid, out tractor_id uuid, out driver_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.trucks (organization_id, plate, nominal_capacity_tm) values (p_org, p_plate, p_capn)
  on conflict (organization_id, plate) do update set nominal_capacity_tm = coalesce(excluded.nominal_capacity_tm, public.trucks.nominal_capacity_tm)
  returning id into truck_id;
  if p_tc is not null then
    insert into public.tractors (organization_id, plate) values (p_org, p_tc)
    on conflict (organization_id, plate) do update set plate = excluded.plate
    returning id into tractor_id;
  end if;
  insert into public.drivers (organization_id, dpi, full_name) values (p_org, p_dpi, p_driver)
  on conflict (organization_id, dpi) do update set full_name = excluded.full_name
  returning id into driver_id;
end $$;

create or replace function app.norm_plate(p text) returns text
language sql immutable set search_path = '' as $$ select nullif(upper(regexp_replace(btrim(coalesce(p, '')), '\s+', '', 'g')), '') $$;
create or replace function app.norm_dpi(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text := regexp_replace(coalesce(p, ''), '\D', '', 'g');
begin
  if v !~ '^[0-9]{13}$' then raise exception 'El DPI debe tener 13 dígitos' using errcode = '22023'; end if;
  return v;
end $$;

-- Valida pesos (en kg) contra reglas y umbrales; devuelve neto en TM.
create or replace function app.check_weights(p_org uuid, p_gross numeric, p_tare numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v_max numeric;
begin
  if p_gross is null or p_tare is null then raise exception 'Ingrese peso bruto y tara' using errcode = '22023'; end if;
  if p_gross <= 0 or p_tare <= 0 then raise exception 'Los pesos deben ser mayores que cero' using errcode = '22023'; end if;
  if p_gross <= p_tare then raise exception 'El peso bruto debe ser mayor que la tara' using errcode = '22023'; end if;
  select max_net_kg into v_max from public.operational_thresholds where organization_id = p_org;
  if v_max is not null and (p_gross - p_tare) > v_max then
    raise exception 'El peso neto (% kg) supera el máximo configurado (% kg)', p_gross - p_tare, v_max using errcode = '22023';
  end if;
  return round((p_gross - p_tare) / 1000.0, 3);
end $$;

create or replace function app.check_cycle(p_org uuid, p_start timestamptz, p_end timestamptz) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_max numeric;
begin
  if p_start is null or p_end is null then raise exception 'Registre la hora de inicio y la hora final' using errcode = '22023'; end if;
  if p_end < p_start then raise exception 'La hora final no puede ser anterior a la hora de inicio' using errcode = '22023'; end if;
  if p_end > now() + interval '5 minutes' then raise exception 'La hora final no puede estar en el futuro' using errcode = '22023'; end if;
  select max_cycle_hours into v_max from public.operational_thresholds where organization_id = p_org;
  if v_max is not null and extract(epoch from (p_end - p_start)) > v_max * 3600 then
    raise exception 'El ciclo supera el máximo configurado de % horas', v_max using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------- registro de pesaje
-- Descuenta el neto del producto y bodega correspondientes dentro de una transacción,
-- con bloqueo de fila del saldo (concurrencia entre básculas) e idempotencia por
-- client_request_id (reintentos de red no duplican descuentos).
create or replace function public.register_weigh_ticket(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req uuid := nullif(p ->> 'client_request_id', '')::uuid;
  v_existing public.weigh_tickets;
  v_scale public.scales; v_svc public.services; v_cargo public.service_hold_cargo; v_visit public.scale_visits;
  v_mode text; v_started timestamptz; v_ended timestamptz;
  v_gross numeric; v_tare numeric; v_net numeric; v_balance numeric; v_unit text;
  v_plate text; v_tc text; v_dpi text; v_driver text; v_capn numeric; v_number text;
  v_tr record; v_id uuid; v_constraint text; v_hold_no int; v_prod text;
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
  if not exists (select 1 from public.service_scales where service_id = v_svc.id and scale_id = v_scale.id) then
    raise exception 'La báscula no está asignada a este servicio' using errcode = '22023'; end if;

  -- Bloqueo del saldo (serializa básculas que descargan el mismo producto/bodega).
  select c.* into v_cargo from public.service_hold_cargo c
   where c.service_id = v_svc.id and c.service_hold_id = nullif(p ->> 'service_hold_id', '')::uuid
     and c.product_id = nullif(p ->> 'product_id', '')::uuid
   for update;
  if not found then raise exception 'La bodega seleccionada no contiene ese producto en este servicio' using errcode = '22023'; end if;

  -- Re-verificación de idempotencia ya con el bloqueo tomado.
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
    select h.hold_number, pr.name into v_hold_no, v_prod
      from public.service_holds h, public.products pr where h.id = v_cargo.service_hold_id and pr.id = v_cargo.product_id;
    raise exception 'El neto (% TM) excede el saldo pendiente (% TM) de la bodega % · %. Solicite un ajuste de tonelaje.',
      v_net, v_cargo.initial_tm - v_cargo.discharged_tm, v_hold_no, v_prod using errcode = '22023';
  end if;

  v_mode := app.time_mode_for_scale(v_scale.id);
  if v_mode = 'server_now' then
    select * into v_visit from public.scale_visits where id = nullif(p ->> 'visit_id', '')::uuid for update;
    if not found or v_visit.scale_id <> v_scale.id or v_visit.service_id <> v_svc.id then
      raise exception 'Registre la hora de inicio con el botón de la báscula' using errcode = '22023'; end if;
    if v_visit.status <> 'open' then raise exception 'La visita de báscula ya fue cerrada' using errcode = '22023'; end if;
    if v_visit.ended_at is null then raise exception 'Registre la hora final con el botón de la báscula' using errcode = '22023'; end if;
    v_started := v_visit.started_at; v_ended := v_visit.ended_at;
  else
    v_started := app.local_to_ts(v_svc.terminal_id, p ->> 'started_local');
    v_ended := app.local_to_ts(v_svc.terminal_id, p ->> 'ended_local');
  end if;
  perform app.check_cycle(v_svc.organization_id, v_started, v_ended);

  v_plate := app.norm_plate(p ->> 'truck_plate');
  if v_plate is null then raise exception 'Ingrese la matrícula del camión' using errcode = '22023'; end if;
  v_tc := app.norm_plate(p ->> 'tractor_plate');
  v_driver := app.req_text(p, 'driver_name');
  v_dpi := app.norm_dpi(p ->> 'driver_dpi');
  v_capn := nullif(p ->> 'nominal_capacity_tm', '')::numeric;
  v_number := app.req_text(p, 'ticket_number');

  select * into v_tr from app.upsert_transport(v_svc.organization_id, v_plate, v_tc, v_dpi, v_driver, v_capn);

  begin
    insert into public.weigh_tickets (
      organization_id, terminal_id, service_id, customer_id, vessel_id, service_hold_id, cargo_id, product_id, scale_id, visit_id,
      ticket_number, truck_id, tractor_id, driver_id, truck_plate, tractor_plate, driver_name, driver_dpi, nominal_capacity_tm,
      gross_kg, tare_kg, started_at, ended_at, time_capture_mode, operation_date, shift_id, notes,
      client_request_id, registered_by, registered_by_name)
    values (
      v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id,
      (select h.vessel_id from public.service_holds h where h.id = v_cargo.service_hold_id),
      v_cargo.service_hold_id, v_cargo.id, v_cargo.product_id, v_scale.id, v_visit.id,
      v_number, v_tr.truck_id, v_tr.tractor_id, v_tr.driver_id, v_plate, v_tc, v_driver, v_dpi, v_capn,
      v_gross, v_tare, v_started, v_ended, v_mode, app.local_date(v_svc.terminal_id, v_started),
      app.shift_for(v_svc.terminal_id, v_started), app.opt_text(p, 'notes'),
      v_req, auth.uid(), app.actor_name())
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'weigh_tickets_scale_number_uq' then
      raise exception 'El ticket % ya está registrado en esta báscula', v_number using errcode = '23505';
    end if;
    select * into v_existing from public.weigh_tickets where client_request_id = v_req;
    if found then return jsonb_build_object('ticket_id', v_existing.id, 'duplicate', true, 'net_tm', v_existing.net_tm); end if;
    raise;
  end;

  perform set_config('app.ledger_write', 'on', true);
  update public.service_hold_cargo set discharged_tm = discharged_tm + v_net where id = v_cargo.id
  returning discharged_tm into v_balance;
  perform set_config('app.ledger_write', 'off', true);
  insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, ticket_id, ticket_revision, kind,
                                      quantity_tm, balance_after_tm, reason, created_by)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_cargo.id, v_id, 1, 'discharge', v_net, v_balance,
          'Pesaje ticket ' || v_number, auth.uid());

  if v_visit.id is not null then
    update public.scale_visits set status = 'completed', ticket_id = v_id where id = v_visit.id;
  end if;

  return jsonb_build_object('ticket_id', v_id, 'duplicate', false, 'net_tm', v_net,
                            'pending_tm', v_cargo.initial_tm - v_balance, 'discharged_tm', v_balance,
                            'started_at', v_started, 'ended_at', v_ended);
end $$;
grant execute on function public.register_weigh_ticket(jsonb) to authenticated;

-- ---------------------------------------------------------------- tiempos perdidos
create or replace function app.check_downtime(p_org uuid, p_start timestamptz, p_end timestamptz) returns void
language plpgsql stable security definer set search_path = '' as $$
declare v_max numeric;
begin
  if p_start is null or p_end is null then raise exception 'Ingrese fecha y hora de inicio y final' using errcode = '22023'; end if;
  if p_end <= p_start then
    raise exception 'La hora final debe ser posterior a la de inicio (si cruza la medianoche, indique la fecha del día siguiente)' using errcode = '22023';
  end if;
  if p_end > now() + interval '5 minutes' then raise exception 'La hora final no puede estar en el futuro' using errcode = '22023'; end if;
  select max_downtime_hours into v_max from public.operational_thresholds where organization_id = p_org;
  if v_max is not null and extract(epoch from (p_end - p_start)) > v_max * 3600 then
    raise exception 'El evento supera el máximo configurado de % horas', v_max using errcode = '22023';
  end if;
end $$;

create or replace function app.check_downtime_scope(p_service uuid, p_scope text, p_hold uuid, p_scale uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_scope not in ('operation', 'hold', 'scale') then raise exception 'Alcance inválido' using errcode = '22023'; end if;
  if p_hold is not null and not exists (select 1 from public.service_holds where id = p_hold and service_id = p_service) then
    raise exception 'La bodega no pertenece al servicio' using errcode = '22023'; end if;
  if p_scale is not null and not exists (select 1 from public.service_scales where scale_id = p_scale and service_id = p_service) then
    raise exception 'La báscula no está asignada al servicio' using errcode = '22023'; end if;
  if p_scope = 'hold' and p_hold is null then raise exception 'Seleccione la bodega afectada' using errcode = '22023'; end if;
  if p_scope = 'scale' and p_scale is null then raise exception 'Seleccione la báscula afectada' using errcode = '22023'; end if;
end $$;

create or replace function public.register_downtime(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req uuid := nullif(p ->> 'client_request_id', '')::uuid;
  v_svc public.services; v_cause public.downtime_causes; v_start timestamptz; v_end timestamptz;
  v_scope text := coalesce(app.opt_text(p, 'scope'), 'operation');
  v_hold uuid := nullif(p ->> 'service_hold_id', '')::uuid; v_scale uuid := nullif(p ->> 'scale_id', '')::uuid;
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
  v_start := app.local_to_ts(v_svc.terminal_id, p ->> 'started_local');
  v_end := app.local_to_ts(v_svc.terminal_id, p ->> 'ended_local');
  perform app.check_downtime(v_svc.organization_id, v_start, v_end);
  perform app.check_downtime_scope(v_svc.id, v_scope, v_hold, v_scale);

  insert into public.downtime_events (organization_id, terminal_id, service_id, customer_id, vessel_id, cause_id, category_id,
    started_at, ended_at, scope, service_hold_id, scale_id, observations, operation_date, shift_id,
    client_request_id, reported_by, reported_by_name)
  values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_svc.customer_id, v_svc.vessel_id, v_cause.id, v_cause.category_id,
    v_start, v_end, v_scope, v_hold, v_scale, app.opt_text(p, 'observations'),
    app.local_date(v_svc.terminal_id, v_start), app.shift_for(v_svc.terminal_id, v_start),
    v_req, auth.uid(), app.actor_name())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', false,
                            'duration_minutes', round(extract(epoch from (v_end - v_start)) / 60.0, 2));
end $$;
grant execute on function public.register_downtime(jsonb) to authenticated;

-- ---------------------------------------------------------------- correcciones
-- Campos corregibles por tipo de registro.
create or replace function app.correction_fields(p_type text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_type
    when 'weigh_ticket' then array['truck_plate','tractor_plate','driver_name','driver_dpi','gross_kg','tare_kg',
                                   'service_hold_id','product_id','scale_id','started_local','ended_local',
                                   'ticket_number','nominal_capacity_tm','notes']
    when 'downtime_event' then array['cause_id','started_local','ended_local','scope','service_hold_id','scale_id','observations']
  end
$$;

create or replace function app.fmt_local(p_terminal uuid, p_ts timestamptz) returns text
language sql stable security definer set search_path = '' as $$
  select to_char(p_ts at time zone app.terminal_tz(p_terminal), 'YYYY-MM-DD"T"HH24:MI:SS')
$$;

-- Aplica una corrección o anulación a un ticket con movimientos compensatorios.
create or replace function app.apply_ticket_change(p_ticket uuid, p_action text, p_changes jsonb, p_reason text,
                                                   p_request uuid, p_approved_by uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t public.weigh_tickets; n public.weigh_tickets; v_svc public.services;
  v_old_cargo public.service_hold_cargo; v_new_cargo uuid; v_new_net numeric; v_balance numeric; v_mov bigint;
  v_key text; v_old text; v_new text; v_job uuid; v_tr record; v_pending numeric;
begin
  select * into t from public.weigh_tickets where id = p_ticket for update;
  if t.status = 'voided' then raise exception 'El ticket ya está anulado' using errcode = '22023'; end if;
  select * into v_svc from public.services where id = t.service_id;
  if v_svc.status = 'cancelled' then raise exception 'El servicio está cancelado' using errcode = '22023'; end if;
  perform app.set_reason(p_reason);

  if p_action = 'void' then
    select * into v_old_cargo from public.service_hold_cargo where id = t.cargo_id for update;
    perform set_config('app.ledger_write', 'on', true);
    update public.service_hold_cargo set discharged_tm = discharged_tm - t.net_tm where id = t.cargo_id returning discharged_tm into v_balance;
    perform set_config('app.ledger_write', 'off', true);
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.cargo_id, t.id, t.revision, 'reversal', -t.net_tm, v_balance, 'Anulación: ' || p_reason, auth.uid())
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

  -- Nuevos valores (sobre una copia del registro).
  n := t;
  if p_changes ? 'truck_plate' then n.truck_plate := app.norm_plate(p_changes ->> 'truck_plate');
    if n.truck_plate is null then raise exception 'Matrícula inválida' using errcode = '22023'; end if; end if;
  if p_changes ? 'tractor_plate' then n.tractor_plate := app.norm_plate(p_changes ->> 'tractor_plate'); end if;
  if p_changes ? 'driver_name' then n.driver_name := app.req_text(p_changes, 'driver_name'); end if;
  if p_changes ? 'driver_dpi' then n.driver_dpi := app.norm_dpi(p_changes ->> 'driver_dpi'); end if;
  if p_changes ? 'gross_kg' then n.gross_kg := (p_changes ->> 'gross_kg')::numeric; end if;
  if p_changes ? 'tare_kg' then n.tare_kg := (p_changes ->> 'tare_kg')::numeric; end if;
  if p_changes ? 'ticket_number' then n.ticket_number := app.req_text(p_changes, 'ticket_number'); end if;
  if p_changes ? 'nominal_capacity_tm' then n.nominal_capacity_tm := nullif(p_changes ->> 'nominal_capacity_tm', '')::numeric; end if;
  if p_changes ? 'notes' then n.notes := app.opt_text(p_changes, 'notes'); end if;
  if p_changes ? 'started_local' then n.started_at := app.local_to_ts(t.terminal_id, p_changes ->> 'started_local'); end if;
  if p_changes ? 'ended_local' then n.ended_at := app.local_to_ts(t.terminal_id, p_changes ->> 'ended_local'); end if;
  if p_changes ? 'scale_id' then
    n.scale_id := (p_changes ->> 'scale_id')::uuid;
    if not exists (select 1 from public.service_scales where service_id = t.service_id and scale_id = n.scale_id) then
      raise exception 'La báscula no está asignada al servicio' using errcode = '22023'; end if;
  end if;
  if p_changes ? 'service_hold_id' then n.service_hold_id := (p_changes ->> 'service_hold_id')::uuid; end if;
  if p_changes ? 'product_id' then n.product_id := (p_changes ->> 'product_id')::uuid; end if;

  v_new_net := app.check_weights(t.organization_id, n.gross_kg, n.tare_kg);
  perform app.check_cycle(t.organization_id, n.started_at, n.ended_at);

  select c.id into v_new_cargo from public.service_hold_cargo c
   where c.service_id = t.service_id and c.service_hold_id = n.service_hold_id and c.product_id = n.product_id;
  if v_new_cargo is null then raise exception 'La bodega no contiene ese producto en este servicio' using errcode = '22023'; end if;

  -- Movimientos compensatorios si cambia el neto o la bodega/producto.
  if v_new_net <> t.net_tm or v_new_cargo <> t.cargo_id then
    perform 1 from public.service_hold_cargo where id in (t.cargo_id, v_new_cargo) order by id for update;
    perform set_config('app.ledger_write', 'on', true);
    update public.service_hold_cargo set discharged_tm = discharged_tm - t.net_tm where id = t.cargo_id returning discharged_tm into v_balance;
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.cargo_id, t.id, t.revision, 'reversal', -t.net_tm, v_balance, 'Corrección: ' || p_reason, auth.uid())
    returning id into v_mov;
    insert into public.ticket_reversals (organization_id, terminal_id, service_id, ticket_id, ticket_revision, reversal_movement_id, reason, kind, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, t.id, t.revision, v_mov, p_reason, 'correction', auth.uid());
    select initial_tm - discharged_tm into v_pending from public.service_hold_cargo where id = v_new_cargo;
    if v_new_net > v_pending then
      raise exception 'El neto corregido (% TM) excede el saldo pendiente (% TM) de la bodega/producto destino', v_new_net, v_pending using errcode = '22023';
    end if;
    update public.service_hold_cargo set discharged_tm = discharged_tm + v_new_net where id = v_new_cargo returning discharged_tm into v_balance;
    insert into public.cargo_movements (organization_id, terminal_id, service_id, cargo_id, ticket_id, ticket_revision, kind, quantity_tm, balance_after_tm, reason, created_by)
    values (t.organization_id, t.terminal_id, t.service_id, v_new_cargo, t.id, t.revision + 1, 'discharge', v_new_net, v_balance, 'Corrección: ' || p_reason, auth.uid());
    perform set_config('app.ledger_write', 'off', true);
  end if;

  if n.truck_plate <> t.truck_plate or n.tractor_plate is distinct from t.tractor_plate
     or n.driver_dpi <> t.driver_dpi or n.driver_name <> t.driver_name then
    select * into v_tr from app.upsert_transport(t.organization_id, n.truck_plate, n.tractor_plate, n.driver_dpi, n.driver_name, n.nominal_capacity_tm);
    n.truck_id := v_tr.truck_id; n.tractor_id := v_tr.tractor_id; n.driver_id := v_tr.driver_id;
  end if;

  begin
    update public.weigh_tickets set
      truck_plate = n.truck_plate, tractor_plate = n.tractor_plate, driver_name = n.driver_name, driver_dpi = n.driver_dpi,
      truck_id = n.truck_id, tractor_id = n.tractor_id, driver_id = n.driver_id,
      gross_kg = n.gross_kg, tare_kg = n.tare_kg, ticket_number = n.ticket_number, nominal_capacity_tm = n.nominal_capacity_tm,
      notes = n.notes, started_at = n.started_at, ended_at = n.ended_at, scale_id = n.scale_id,
      service_hold_id = n.service_hold_id, product_id = n.product_id, cargo_id = v_new_cargo,
      vessel_id = (select h.vessel_id from public.service_holds h where h.id = n.service_hold_id),
      operation_date = app.local_date(t.terminal_id, n.started_at), shift_id = app.shift_for(t.terminal_id, n.started_at),
      revision = t.revision + 1
    where id = t.id returning * into n;
  exception when unique_violation then
    raise exception 'El ticket % ya existe en la báscula', n.ticket_number using errcode = '23505';
  end;

  for v_key in select jsonb_object_keys(p_changes) loop
    v_old := case v_key
      when 'started_local' then app.fmt_local(t.terminal_id, t.started_at)
      when 'ended_local' then app.fmt_local(t.terminal_id, t.ended_at)
      else to_jsonb(t) ->> v_key end;
    v_new := case v_key
      when 'started_local' then app.fmt_local(t.terminal_id, n.started_at)
      when 'ended_local' then app.fmt_local(t.terminal_id, n.ended_at)
      else to_jsonb(n) ->> v_key end;
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

-- Solicitud de corrección: si el usuario tiene autorización se aplica de inmediato;
-- de lo contrario queda pendiente de aprobación por un supervisor.
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

create or replace function public.review_correction(p_request uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.correction_requests; v_rev int; v_res jsonb;
begin
  select * into r from public.correction_requests where id = p_request for update;
  if not found then raise exception 'Solicitud inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(r.terminal_id, 'corrections.approve');
  if r.status <> 'pending' then raise exception 'La solicitud ya fue %', r.status using errcode = '22023'; end if;
  if r.requested_by = auth.uid() then
    raise exception 'Una solicitud debe ser revisada por un usuario distinto al solicitante' using errcode = '42501'; end if;
  if not p_approve then
    perform app.require_reason(p_note, 4);
    update public.correction_requests set status = 'rejected', reviewed_by = auth.uid(), reviewed_by_name = app.actor_name(),
           reviewed_at = now(), review_note = p_note where id = r.id;
    insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
    values (r.organization_id, 'correction', r.id, 'rejected', auth.uid(), app.actor_name(), p_note);
    perform app.notify_users(r.organization_id, array[r.requested_by], 'correction_rejected', 'Corrección rechazada', p_note, '/app/correcciones');
    return jsonb_build_object('status', 'rejected');
  end if;
  if r.target_type = 'weigh_ticket' then select revision into v_rev from public.weigh_tickets where id = r.target_id;
  else select revision into v_rev from public.downtime_events where id = r.target_id; end if;
  if v_rev <> r.target_revision then
    raise exception 'El registro cambió desde la solicitud; debe solicitarse de nuevo' using errcode = '40001'; end if;
  update public.correction_requests set status = 'applied', reviewed_by = auth.uid(), reviewed_by_name = app.actor_name(),
         reviewed_at = now(), review_note = p_note, applied_at = now() where id = r.id;
  v_res := case r.target_type
    when 'weigh_ticket' then app.apply_ticket_change(r.target_id, r.action, r.changes, r.reason, r.id, auth.uid())
    else app.apply_downtime_change(r.target_id, r.action, r.changes, r.reason, r.id, auth.uid()) end;
  insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
  values (r.organization_id, 'correction', r.id, 'approved', auth.uid(), app.actor_name(), p_note);
  perform app.notify_users(r.organization_id, array[r.requested_by], 'correction_applied', 'Corrección aplicada', r.reason, '/app/correcciones');
  return jsonb_build_object('status', 'applied', 'result', v_res);
end $$;
grant execute on function public.review_correction(uuid, boolean, text) to authenticated;

create or replace function public.cancel_correction(p_request uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.correction_requests set status = 'cancelled', reviewed_at = now(), review_note = 'Cancelada por el solicitante'
   where id = p_request and requested_by = auth.uid() and status = 'pending';
  if not found then raise exception 'Solicitud no encontrada o ya procesada' using errcode = '22023'; end if;
end $$;
grant execute on function public.cancel_correction(uuid) to authenticated;
