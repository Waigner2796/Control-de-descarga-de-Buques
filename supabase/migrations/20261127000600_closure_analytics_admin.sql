-- =============================================================================
-- VESSEL CONTROL · Migración 006 · Cierre, productividad, dashboards, reportes,
-- verificación, administración de usuarios, alta de empresas y vistas.
-- =============================================================================

-- ---------------------------------------------------------------- métricas de servicio
-- Diferencia explícita entre: tiempo de ciclo de báscula, tiempo perdido reportado y
-- tiempo efectivo de operación. No se calculan esperas entre camiones (no hay eventos
-- que permitan medirlas).
create or replace function app.service_metrics(p_service uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_svc public.services; v_tz text; v_from timestamptz := coalesce(p_from, '-infinity'); v_to timestamptz := coalesce(p_to, 'infinity');
  v_first timestamptz; v_last timestamptz; v_span_h numeric; v_tons numeric; v_trucks int; v_avg_cycle numeric;
  v_op_down_min numeric; v_total_down_min numeric; v_events int; v_eff_h numeric; v_tot jsonb;
begin
  select * into v_svc from public.services where id = p_service;
  if not found then return null; end if;
  v_tz := app.terminal_tz(v_svc.terminal_id);

  select count(*), coalesce(sum(net_tm), 0), min(started_at), max(ended_at), avg(cycle_seconds) / 60.0
    into v_trucks, v_tons, v_first, v_last, v_avg_cycle
  from public.weigh_tickets where service_id = p_service and status = 'valid' and started_at >= v_from and started_at < v_to;
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

  select jsonb_build_object('initial_tm', coalesce(sum(initial_tm), 0), 'discharged_tm', coalesce(sum(discharged_tm), 0),
                            'pending_tm', coalesce(sum(initial_tm - discharged_tm), 0),
                            'progress_pct', case when sum(initial_tm) > 0 then round(sum(discharged_tm) / sum(initial_tm) * 100, 2) else 0 end)
    into v_tot from public.service_hold_cargo where service_id = p_service;

  return jsonb_build_object(
    'service_id', p_service, 'timezone', v_tz, 'from', p_from, 'to', p_to, 'computed_at', now(),
    'totals', v_tot,
    'trucks', v_trucks,
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
          'tph', case when max(t.ended_at) > min(t.started_at)
                      then round(sum(t.net_tm) / (extract(epoch from (max(t.ended_at) - min(t.started_at))) / 3600.0), 2) end,
          'downtime_minutes', (select round(coalesce(sum(d.duration_minutes), 0), 2) from public.downtime_events d
                               where d.service_id = p_service and d.status = 'valid' and d.scope = 'scale' and d.scale_id = sc.id
                                 and d.started_at >= v_from and d.started_at < v_to)) x
        from public.service_scales ss
        join public.scales sc on sc.id = ss.scale_id
        left join public.weigh_tickets t on t.scale_id = sc.id and t.service_id = p_service and t.status = 'valid'
              and t.started_at >= v_from and t.started_at < v_to
        where ss.service_id = p_service
        group by sc.id, sc.code, sc.name) q), '[]'::jsonb),
    'by_hold', coalesce((
      select jsonb_agg(x order by (x ->> 'hold_number')::int, x ->> 'vessel_name') from (
        select jsonb_build_object('service_hold_id', h.id, 'hold_number', h.hold_number, 'vessel_name', v.name,
          'initial_tm', (select coalesce(sum(c.initial_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'discharged_tm', (select coalesce(sum(c.discharged_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'pending_tm', (select coalesce(sum(c.initial_tm - c.discharged_tm), 0) from public.service_hold_cargo c where c.service_hold_id = h.id),
          'trucks', (select count(*) from public.weigh_tickets t where t.service_hold_id = h.id and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to),
          'tons', (select round(coalesce(sum(t.net_tm), 0), 3) from public.weigh_tickets t where t.service_hold_id = h.id and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to),
          'downtime_minutes', (select round(coalesce(sum(d.duration_minutes), 0), 2) from public.downtime_events d
                               where d.service_hold_id = h.id and d.status = 'valid' and d.scope = 'hold' and d.started_at >= v_from and d.started_at < v_to),
          'products', (select coalesce(jsonb_agg(jsonb_build_object('cargo_id', c.id, 'product_id', p.id, 'name', p.name, 'color', p.color,
                          'initial_tm', c.initial_tm, 'discharged_tm', c.discharged_tm, 'pending_tm', c.initial_tm - c.discharged_tm) order by p.name), '[]'::jsonb)
                       from public.service_hold_cargo c join public.products p on p.id = c.product_id where c.service_hold_id = h.id)) x
        from public.service_holds h join public.vessels v on v.id = h.vessel_id
        where h.service_id = p_service) q), '[]'::jsonb),
    'by_product', coalesce((
      select jsonb_agg(x order by x ->> 'name') from (
        select jsonb_build_object('product_id', p.id, 'name', p.name, 'color', p.color,
          'initial_tm', sum(c.initial_tm), 'discharged_tm', sum(c.discharged_tm), 'pending_tm', sum(c.initial_tm - c.discharged_tm),
          'trucks', (select count(*) from public.weigh_tickets t where t.service_id = p_service and t.product_id = p.id and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to),
          'tons', (select round(coalesce(sum(t.net_tm), 0), 3) from public.weigh_tickets t where t.service_id = p_service and t.product_id = p.id and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to)) x
        from public.service_hold_cargo c join public.products p on p.id = c.product_id
        where c.service_id = p_service group by p.id, p.name, p.color) q), '[]'::jsonb),
    'hourly', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'tons', round(tons, 3), 'trucks', trucks, 'cum_tons', round(cum, 3)) order by h)
      from (select h, tons, trucks, sum(tons) over (order by h) cum from (
              select date_trunc('hour', t.started_at at time zone v_tz) h, sum(t.net_tm) tons, count(*) trucks
              from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to
              group by 1) q0) q), '[]'::jsonb),
    'hourly_by_scale', coalesce((
      select jsonb_agg(jsonb_build_object('hour', h, 'scale_id', scale_id, 'tons', round(tons, 3), 'trucks', trucks) order by h)
      from (select date_trunc('hour', t.started_at at time zone v_tz) h, t.scale_id, sum(t.net_tm) tons, count(*) trucks
            from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to
            group by 1, 2) q), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('date', d, 'tons', round(tons, 3), 'trucks', trucks) order by d)
      from (select t.operation_date d, sum(t.net_tm) tons, count(*) trucks
            from public.weigh_tickets t where t.service_id = p_service and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to
            group by 1) q), '[]'::jsonb),
    'by_shift', coalesce((
      select jsonb_agg(jsonb_build_object('shift', shift, 'tons', round(tons, 3), 'trucks', trucks) order by srt)
      from (select coalesce(sh.name, 'Sin turno') shift, sum(t.net_tm) tons, count(*) trucks, min(coalesce(sh.sort, 99)) srt
            from public.weigh_tickets t left join public.shifts sh on sh.id = t.shift_id
            where t.service_id = p_service and t.status = 'valid' and t.started_at >= v_from and t.started_at < v_to
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

-- Acceso: personal con productividad/servicios en la terminal, operador del servicio,
-- o cliente propietario con permiso de productividad (solo agregados).
create or replace function public.service_kpis(p_service uuid, p_from timestamptz default null, p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_term uuid; v_cust uuid;
begin
  select terminal_id, customer_id into v_term, v_cust from public.services where id = p_service;
  if v_term is null or not (
       app.has_terminal_perm(v_term, 'productivity.view')
    or app.has_terminal_perm(v_term, 'services.view')
    or p_service in (select app.my_operator_service_ids())
    or v_cust in (select app.my_customer_ids_with('productivity'))) then
    raise exception 'Servicio inexistente o sin acceso' using errcode = '42501';
  end if;
  return app.service_metrics(p_service, p_from, p_to);
end $$;
grant execute on function public.service_kpis(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------- cierre y reapertura
create or replace function public.close_service(p_service uuid, p_note text default null, p_conclusions text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_svc public.services; v_open int; v_pendcorr int; v_bad int; v_pending numeric; v_tol numeric; v_report uuid; v_job uuid;
begin
  select * into v_svc from public.services where id = p_service for update;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'services.close');
  if v_svc.status not in ('in_operation', 'suspended', 'closing') then
    raise exception 'Solo se puede finalizar un servicio en operación, suspendido o en proceso de cierre (estado: %)', v_svc.status using errcode = '22023';
  end if;
  -- 1. Sin registros pendientes de procesar
  select count(*) into v_open from public.scale_visits where service_id = p_service and status = 'open';
  if v_open > 0 then raise exception 'Hay % visita(s) de báscula abiertas; ciérrelas o cancélelas antes de finalizar', v_open using errcode = '22023'; end if;
  select count(*) into v_pendcorr from public.correction_requests where service_id = p_service and status = 'pending';
  if v_pendcorr > 0 then raise exception 'Hay % corrección(es) pendientes de aprobación', v_pendcorr using errcode = '22023'; end if;
  -- 2. Conciliación de tonelaje: saldo acumulado = ledger = suma de tickets válidos
  select count(*) into v_bad from public.service_hold_cargo c
  where c.service_id = p_service and (
        c.discharged_tm <> (select coalesce(sum(m.quantity_tm), 0) from public.cargo_movements m where m.cargo_id = c.id)
     or c.discharged_tm <> (select coalesce(sum(t.net_tm), 0) from public.weigh_tickets t where t.cargo_id = c.id and t.status = 'valid'));
  if v_bad > 0 then raise exception 'Error de conciliación en % línea(s) de carga; contacte al administrador', v_bad using errcode = 'XX000'; end if;
  select coalesce(sum(initial_tm - discharged_tm), 0) into v_pending from public.service_hold_cargo where service_id = p_service;
  select reconciliation_tolerance_tm into v_tol from public.operational_thresholds where organization_id = v_svc.organization_id;
  if v_pending > coalesce(v_tol, 0) and (p_note is null or length(btrim(p_note)) < 8) then
    raise exception 'Quedan % TM pendientes según el manifiesto; registre una nota de conciliación para cerrar', round(v_pending, 3) using errcode = '22023';
  end if;
  -- 3. Cierre
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

create or replace function public.reopen_service(p_service uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_reason text := app.require_reason(p_reason);
begin
  select * into v_svc from public.services where id = p_service for update;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'services.reopen');
  if v_svc.status <> 'finalized' then raise exception 'Solo se reabren servicios finalizados' using errcode = '22023'; end if;
  perform app.set_reason('Reapertura: ' || v_reason);
  perform set_config('app.rpc', 'on', true);
  update public.services set status = 'in_operation', finalized_at = null, data_revision = data_revision + 1 where id = p_service;
  perform set_config('app.rpc', 'off', true);
  update public.generated_reports set status = 'revision_pending' where service_id = p_service and current_version_id is not null;
  insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
  values (v_svc.organization_id, 'service_reopen', v_svc.id, 'approved', auth.uid(), app.actor_name(), v_reason);
  return jsonb_build_object('status', 'in_operation');
end $$;
grant execute on function public.reopen_service(uuid, text) to authenticated;

-- Reintento manual de generación (idempotente: no crea trabajos duplicados).
create or replace function public.retry_report_job(p_service uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_svc public.services; v_job uuid; v_report uuid;
begin
  select * into v_svc from public.services where id = p_service;
  if not found then raise exception 'Servicio inexistente' using errcode = '42501'; end if;
  perform app.require_terminal_perm(v_svc.terminal_id, 'reports.generate');
  if v_svc.status <> 'finalized' then raise exception 'El informe final se genera al finalizar el servicio' using errcode = '22023'; end if;
  select id into v_report from public.generated_reports where service_id = p_service and kind = 'final_service';
  update public.report_jobs set status = 'queued', attempts = 0, last_error = null, locked_until = null
   where service_id = p_service and data_revision = v_svc.data_revision and status = 'failed' returning id into v_job;
  if v_job is null then
    insert into public.report_jobs (organization_id, terminal_id, service_id, report_id, data_revision, idempotency_key, requested_by)
    values (v_svc.organization_id, v_svc.terminal_id, v_svc.id, v_report, v_svc.data_revision,
            'final_service:' || v_svc.id || ':' || v_svc.data_revision, auth.uid())
    on conflict (idempotency_key) do nothing returning id into v_job;
  end if;
  if v_job is null then
    select id into v_job from public.report_jobs where idempotency_key = 'final_service:' || v_svc.id || ':' || v_svc.data_revision;
  end if;
  return v_job;
end $$;
grant execute on function public.retry_report_job(uuid) to authenticated;

-- ---------------------------------------------------------------- dashboards (SECURITY INVOKER: RLS filtra)
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
    where t.status = 'valid' and t.started_at >= f_from and t.started_at < f_to and (f_prod is null or t.product_id = f_prod)
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
    'tph', (select case when max(ended_at) > min(started_at) then round(sum(net_tm) / (extract(epoch from (max(ended_at) - min(started_at))) / 3600.0), 2) end from t),
    'tph_last_3h', (select round(coalesce(sum(net_tm), 0) / 3.0, 2) from t where t.ended_at >= now() - interval '3 hours'),
    'trucks_last_hour', (select count(*) from t where t.ended_at >= now() - interval '1 hour'),
    'tons_last_hour', (select coalesce(sum(net_tm), 0) from t where t.ended_at >= now() - interval '1 hour')
  ) into v;
  return v;
end $$;
grant execute on function public.dashboard_summary(jsonb) to authenticated;

create or replace function public.downtime_summary(p jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  f_term uuid := nullif(p ->> 'terminal_id', '')::uuid; f_cust uuid := nullif(p ->> 'customer_id', '')::uuid;
  f_svc uuid := nullif(p ->> 'service_id', '')::uuid; f_scope text := nullif(p ->> 'scope', '');
  f_from timestamptz := coalesce(nullif(p ->> 'from', '')::timestamptz, '-infinity');
  f_to timestamptz := coalesce(nullif(p ->> 'to', '')::timestamptz, 'infinity');
  v jsonb;
begin
  with d as (
    select d.*, dc.name cause, cat.name category, cat.color, sh.name shift_name, h.hold_number, sc.name scale_name
    from public.downtime_events d
    join public.downtime_causes dc on dc.id = d.cause_id
    join public.downtime_categories cat on cat.id = d.category_id
    left join public.shifts sh on sh.id = d.shift_id
    left join public.service_holds h on h.id = d.service_hold_id
    left join public.scales sc on sc.id = d.scale_id
    where d.status = 'valid' and d.started_at >= f_from and d.started_at < f_to
      and (f_term is null or d.terminal_id = f_term) and (f_cust is null or d.customer_id = f_cust)
      and (f_svc is null or d.service_id = f_svc) and (f_scope is null or d.scope = f_scope)
  ), tot as (select coalesce(sum(duration_minutes), 0) m, count(*) n from d)
  select jsonb_build_object(
    'total_minutes', (select m from tot), 'total_hours', round((select m from tot) / 60.0, 2), 'events', (select n from tot),
    'top_cause', (select cause from d group by cause order by sum(duration_minutes) desc limit 1),
    'by_scope', coalesce((select jsonb_object_agg(scope, mins) from (select scope, round(sum(duration_minutes), 2) mins from d group by scope) q), '{}'::jsonb),
    'pareto', coalesce((select jsonb_agg(jsonb_build_object('cause', cause, 'category', category, 'color', color, 'minutes', round(mins, 2), 'events', n,
                         'pct', case when t > 0 then round(mins / t * 100, 2) else 0 end,
                         'cum_pct', case when t > 0 then round(cum / t * 100, 2) else 0 end) order by mins desc, cause)
                       from (select *, sum(mins) over (order by mins desc, cause) cum from (
                               select cause, category, color, sum(duration_minutes) mins, count(*) n, (select m from tot) t from d group by cause, category, color) q0) q), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'color', color, 'minutes', round(mins, 2)) order by mins desc)
                       from (select category, color, sum(duration_minutes) mins from d group by category, color) q), '[]'::jsonb),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('date', operation_date, 'minutes', round(mins, 2), 'events', n) order by operation_date)
                       from (select operation_date, sum(duration_minutes) mins, count(*) n from d group by operation_date) q), '[]'::jsonb),
    'by_shift', coalesce((select jsonb_agg(jsonb_build_object('shift', coalesce(shift_name, 'Sin turno'), 'minutes', round(mins, 2), 'events', n) order by mins desc)
                       from (select shift_name, sum(duration_minutes) mins, count(*) n from d group by shift_name) q), '[]'::jsonb),
    'by_hold', coalesce((select jsonb_agg(jsonb_build_object('hold_number', hold_number, 'minutes', round(mins, 2), 'events', n) order by hold_number)
                       from (select hold_number, sum(duration_minutes) mins, count(*) n from d where scope = 'hold' group by hold_number) q), '[]'::jsonb),
    'by_scale', coalesce((select jsonb_agg(jsonb_build_object('scale', scale_name, 'minutes', round(mins, 2), 'events', n) order by mins desc)
                       from (select scale_name, sum(duration_minutes) mins, count(*) n from d where scope = 'scale' group by scale_name) q), '[]'::jsonb)
  ) into v;
  return v;
end $$;
grant execute on function public.downtime_summary(jsonb) to authenticated;

-- ---------------------------------------------------------------- reportes: funciones de trabajador (solo service_role)
create or replace function public.worker_claim_report_job(p_job uuid default null) returns setof public.report_jobs
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.report_jobs j set status = 'processing', attempts = j.attempts + 1, started_at = now(),
         locked_until = now() + interval '5 minutes', last_error = null
  where j.id = (
    select x.id from public.report_jobs x
    where (p_job is null or x.id = p_job)
      and x.attempts < x.max_attempts
      and (x.status = 'queued' or x.status = 'failed' or (x.status = 'processing' and x.locked_until < now()))
    order by x.created_at
    limit 1
    for update skip locked)
  returning j.*;
end $$;

create or replace function public.worker_fail_report_job(p_job uuid, p_error text) returns void
language sql security definer set search_path = '' as $$
  update public.report_jobs set status = 'failed', last_error = left(p_error, 2000), locked_until = null, finished_at = now() where id = p_job;
  update public.generated_reports r set status = case when r.current_version_id is null then 'failed' else r.status end
   where r.id = (select report_id from public.report_jobs where id = p_job)
     and (select status from public.report_jobs where id = p_job) = 'failed'
     and (select attempts >= max_attempts from public.report_jobs where id = p_job);
$$;

-- Datos completos para el PDF del informe final.
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
    'cargo', (select coalesce(jsonb_agg(jsonb_build_object('hold_number', h.hold_number, 'vessel', v.name, 'product', p.name, 'color', p.color,
                 'initial_tm', c.initial_tm, 'discharged_tm', c.discharged_tm, 'pending_tm', c.initial_tm - c.discharged_tm)
                 order by h.hold_number, p.name), '[]'::jsonb)
              from public.service_hold_cargo c join public.service_holds h on h.id = c.service_hold_id
              join public.vessels v on v.id = h.vessel_id join public.products p on p.id = c.product_id where c.service_id = p_service),
    'tickets', (select coalesce(jsonb_agg(jsonb_build_object('ticket', t.ticket_number, 'plate', t.truck_plate, 'tc', t.tractor_plate,
                 'driver', t.driver_name, 'dpi', t.driver_dpi, 'gross_kg', t.gross_kg, 'tare_kg', t.tare_kg, 'net_kg', t.net_kg, 'net_tm', t.net_tm,
                 'start', to_char(t.started_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'), 'end', to_char(t.ended_at at time zone v_tz, 'DD/MM/YYYY HH24:MI'),
                 'cycle_min', round(t.cycle_seconds / 60.0, 1), 'scale', sc.name, 'hold', h.hold_number, 'product', p.name, 'revision', t.revision)
                 order by t.started_at, t.ticket_number), '[]'::jsonb)
               from public.weigh_tickets t join public.scales sc on sc.id = t.scale_id join public.service_holds h on h.id = t.service_hold_id
               join public.products p on p.id = t.product_id where t.service_id = p_service and t.status = 'valid'),
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
      'first_ticket', (select to_char(min(started_at) at time zone v_tz, 'DD/MM/YYYY HH24:MI') from public.weigh_tickets where service_id = p_service and status = 'valid'),
      'last_ticket', (select to_char(max(ended_at) at time zone v_tz, 'DD/MM/YYYY HH24:MI') from public.weigh_tickets where service_id = p_service and status = 'valid')),
    'previous_version', (select jsonb_build_object('version', rv.version, 'signed_at', rv.signed_at, 'verification_code', rv.verification_code)
                         from public.report_versions rv join public.generated_reports gr on gr.current_version_id = rv.id where gr.service_id = p_service)
  );
end $$;

create or replace function app.new_verification_code() returns text
language sql volatile set search_path = '' as $$
  select 'VC-' || string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(b, i) % 32) + 1, 1), '' order by i)
  from (select extensions.gen_random_bytes(12) b) x, generate_series(0, 11) i
$$;

-- Registra la versión borrador (pendiente de firma) generada por el trabajador.
create or replace function public.worker_record_draft(p_job uuid, p_draft_path text, p_verification_code text, p_change_summary text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare j public.report_jobs; r public.generated_reports; v_ver int; v_id uuid;
begin
  select * into j from public.report_jobs where id = p_job for update;
  if j.status <> 'processing' then raise exception 'El trabajo no está en proceso'; end if;
  select * into r from public.generated_reports where id = j.report_id for update;
  select coalesce(max(version), 0) + 1 into v_ver from public.report_versions where report_id = r.id;
  update public.report_versions set status = 'discarded' where report_id = r.id and status = 'pending_signature';
  insert into public.report_versions (organization_id, terminal_id, report_id, service_id, customer_id, version, data_revision,
                                      status, draft_path, verification_code, change_summary, generated_by)
  values (r.organization_id, r.terminal_id, r.id, r.service_id, r.customer_id, v_ver, j.data_revision,
          'pending_signature', p_draft_path, p_verification_code, p_change_summary, j.requested_by)
  returning id into v_id;
  update public.generated_reports set status = case when current_version_id is null then 'pending_signature' else 'revision_pending' end
   where id = r.id;
  update public.report_jobs set status = 'done', finished_at = now(), locked_until = null, result_version_id = v_id where id = p_job;
  perform app.notify_users(r.organization_id, app.users_with_terminal_perm(r.terminal_id, 'reports.sign'), 'report_pending_signature',
    'Informe pendiente de firma', 'Versión ' || v_ver || ' del servicio ' || (select service_number from public.services where id = r.service_id),
    '/app/reportes');
  return v_id;
end $$;

-- Firma: congela la versión (hash SHA-256), sustituye la anterior, publica y notifica.
create or replace function public.worker_sign_version(p_version uuid, p_user uuid, p_signer uuid, p_seal uuid, p_storage_path text,
                                                      p_sha256 text, p_size bigint, p_issued_at timestamptz, p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.report_versions; s public.authorized_signers; r public.generated_reports; v_prev uuid; v_ok boolean; v_svc text; v_recipients uuid[];
begin
  select * into v from public.report_versions where id = p_version for update;
  if not found or v.status <> 'pending_signature' then raise exception 'La versión no está pendiente de firma' using errcode = '22023'; end if;
  if exists (select 1 from public.report_versions x where x.report_id = v.report_id and x.version > v.version) then
    raise exception 'Existe una versión más reciente; firme la última versión' using errcode = '22023'; end if;
  select * into s from public.authorized_signers where id = p_signer and organization_id = v.organization_id and status = 'active';
  if not found or s.user_id is distinct from p_user then raise exception 'Firmante no autorizado' using errcode = '42501'; end if;
  select exists (
    select 1 from public.organization_members m
    join public.user_profiles up on up.user_id = m.user_id and up.status = 'active' and not up.must_change_password
    where m.organization_id = v.organization_id and m.user_id = p_user and m.status = 'active'
      and (exists (select 1 from public.role_permissions rp where rp.role_code = m.role_code and rp.permission_code = 'reports.sign')
           or 'reports.sign' = any (m.extra_permissions))) into v_ok;
  if not v_ok then raise exception 'El usuario no tiene permiso de firma' using errcode = '42501'; end if;
  if p_issued_at < now() - interval '15 minutes' or p_issued_at > now() + interval '1 minute' then
    raise exception 'Hora de emisión inválida' using errcode = '22023'; end if;
  if p_seal is not null and not exists (select 1 from public.company_seals where id = p_seal and organization_id = v.organization_id and status = 'active') then
    raise exception 'Sello inválido' using errcode = '22023'; end if;

  select * into r from public.generated_reports where id = v.report_id for update;
  v_prev := r.current_version_id;
  update public.report_versions set status = 'signed', storage_path = p_storage_path, sha256 = p_sha256, size_bytes = p_size,
         signed_at = p_issued_at, signed_by = p_user, signer_id = s.id, signer_name = s.full_name, signer_position = s.position,
         seal_id = p_seal, published_at = now()
   where id = v.id;
  if v_prev is not null then
    update public.report_versions set status = 'superseded', superseded_at = now(), superseded_by = v.id,
           supersede_reason = coalesce(v.change_summary, 'Sustituida por la versión ' || v.version)
     where id = v_prev and status = 'signed';
  end if;
  update public.generated_reports set current_version_id = v.id, status = 'current' where id = r.id;
  insert into public.digital_signatures (organization_id, report_version_id, signer_id, signed_by, signer_name, signer_position, seal_id,
                                         document_sha256, signature_type, evidence, signed_at)
  values (v.organization_id, v.id, s.id, p_user, s.full_name, s.position, p_seal, p_sha256, 'graphic', coalesce(p_evidence, '{}'), p_issued_at);
  insert into public.approval_records (organization_id, subject_type, subject_id, decision, decided_by, decided_by_name, note)
  values (v.organization_id, 'report_signature', v.id, 'approved', p_user, s.full_name, 'Firma de versión ' || v.version);
  select service_number into v_svc from public.services where id = v.service_id;
  select coalesce(array_agg(cu.user_id), '{}') into v_recipients
    from public.customer_users cu left join public.customer_portal_permissions pp on pp.customer_user_id = cu.id
   where cu.customer_id = v.customer_id and cu.status = 'active' and coalesce(pp.can_view_reports, true);
  perform app.notify_users(v.organization_id, v_recipients, 'report_published',
    case when v_prev is null then 'Informe final disponible' else 'Nueva versión del informe final' end,
    'Servicio ' || v_svc || ' · versión ' || v.version || case when v_prev is not null then ' (sustituye la versión anterior)' else '' end,
    '/portal/reportes');
  return jsonb_build_object('version_id', v.id, 'version', v.version, 'superseded', v_prev, 'recipients', to_jsonb(v_recipients));
end $$;

-- Copia el hash de la contraseña temporal recién creada (para verificar su cambio).
create or replace function public.worker_register_temp_password(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  insert into app.pending_password_changes (user_id, initial_hash)
  select id, encrypted_password from auth.users where id = p_user
  on conflict (user_id) do update set initial_hash = excluded.initial_hash, created_at = now();
  update public.user_profiles set must_change_password = true where user_id = p_user;
$$;

create or replace function public.worker_revoke_sessions(p_user uuid) returns void
language sql security definer set search_path = '' as $$
  delete from auth.refresh_tokens where user_id::uuid = p_user;
  delete from auth.sessions where user_id = p_user;
$$;

revoke execute on function public.worker_claim_report_job(uuid), public.worker_fail_report_job(uuid, text),
  public.worker_report_payload(uuid), public.worker_record_draft(uuid, text, text, text),
  public.worker_sign_version(uuid, uuid, uuid, uuid, text, text, bigint, timestamptz, jsonb),
  public.worker_register_temp_password(uuid), public.worker_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function public.worker_claim_report_job(uuid), public.worker_fail_report_job(uuid, text),
  public.worker_report_payload(uuid), public.worker_record_draft(uuid, text, text, text),
  public.worker_sign_version(uuid, uuid, uuid, uuid, text, text, bigint, timestamptz, jsonb),
  public.worker_register_temp_password(uuid), public.worker_revoke_sessions(uuid) to service_role;

-- Verificación pública de un documento por su código (impreso en el PDF).
create or replace function public.verify_report(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select jsonb_build_object('found', true, 'status', v.status, 'version', v.version, 'service_number', s.service_number,
      'vessel', ve.name, 'customer', c.trade_name, 'organization', o.name, 'signed_at', v.signed_at,
      'signer_name', v.signer_name, 'signer_position', v.signer_position, 'sha256', v.sha256,
      'superseded_at', v.superseded_at, 'superseded_by_version', (select x.version from public.report_versions x where x.id = v.superseded_by),
      'signature_type', 'graphic')
    from public.report_versions v
    join public.services s on s.id = v.service_id join public.vessels ve on ve.id = s.vessel_id
    join public.customers c on c.id = v.customer_id join public.organizations o on o.id = v.organization_id
    where v.verification_code = upper(btrim(p_code)) and v.status in ('signed', 'superseded')),
    jsonb_build_object('found', false))
$$;
grant execute on function public.verify_report(text) to anon, authenticated;

-- ---------------------------------------------------------------- administración de usuarios
create or replace function public.has_permission(p_org uuid, p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$ select app.has_perm(p_org, p_perm) $$;
grant execute on function public.has_permission(uuid, text) to authenticated;

create or replace function public.admin_update_member(p_member uuid, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare m public.organization_members; v_role text := app.opt_text(p, 'role_code'); v_status text := app.opt_text(p, 'status');
        v_caller_role text; v_terms uuid[]; v_extra text[];
begin
  select * into m from public.organization_members where id = p_member for update;
  if not found then raise exception 'Miembro inexistente' using errcode = '42501'; end if;
  perform app.require_org_perm(m.organization_id, 'users.manage');
  v_caller_role := app.member_role(m.organization_id);
  if m.user_id = auth.uid() and (v_role is not null and v_role <> m.role_code or v_status is not null and v_status <> m.status or p ? 'extra_permissions') then
    raise exception 'No puede modificar su propio rol, estado o permisos' using errcode = '42501'; end if;
  if (v_role = 'master_admin' or m.role_code = 'master_admin') and v_caller_role <> 'master_admin' then
    raise exception 'Solo un Administrador Master puede asignar o modificar a otro Administrador Master' using errcode = '42501'; end if;
  if p ? 'extra_permissions' then
    perform app.require_org_perm(m.organization_id, 'permissions.manage');
    select coalesce(array_agg(x), '{}') into v_extra from jsonb_array_elements_text(p -> 'extra_permissions') x;
  end if;
  if m.role_code = 'master_admin' and (coalesce(v_role, 'master_admin') <> 'master_admin' or coalesce(v_status, 'active') <> 'active')
     and (select count(*) from public.organization_members where organization_id = m.organization_id and role_code = 'master_admin' and status = 'active') <= 1 then
    raise exception 'La empresa debe conservar al menos un Administrador Master activo' using errcode = '22023'; end if;
  perform app.set_reason(app.opt_text(p, 'reason'));
  update public.organization_members set
    role_code = coalesce(v_role, role_code), status = coalesce(v_status, status),
    all_terminals = coalesce((p ->> 'all_terminals')::boolean, all_terminals),
    extra_permissions = coalesce(v_extra, extra_permissions),
    position = case when p ? 'position' then app.opt_text(p, 'position') else position end
  where id = p_member;
  if p ? 'terminal_ids' then
    select coalesce(array_agg(x::uuid), '{}') into v_terms from jsonb_array_elements_text(p -> 'terminal_ids') x;
    delete from public.terminal_members where user_id = m.user_id and organization_id = m.organization_id and not (terminal_id = any (v_terms));
    insert into public.terminal_members (terminal_id, user_id, organization_id)
    select t.id, m.user_id, m.organization_id from public.terminals t where t.id = any (v_terms) and t.organization_id = m.organization_id
    on conflict do nothing;
  end if;
end $$;
grant execute on function public.admin_update_member(uuid, jsonb) to authenticated;

create or replace function public.admin_set_customer_user_status(p_customer_user uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare cu public.customer_users;
begin
  select * into cu from public.customer_users where id = p_customer_user for update;
  if not found then raise exception 'Usuario inexistente' using errcode = '42501'; end if;
  perform app.require_org_perm(cu.organization_id, 'portal_users.manage');
  if p_status not in ('active', 'inactive') then raise exception 'Estado inválido' using errcode = '22023'; end if;
  update public.customer_users set status = p_status where id = p_customer_user;
end $$;
grant execute on function public.admin_set_customer_user_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------- alta de empresas (administrador de plataforma)
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
    insert into public.downtime_causes (organization_id, category_id, name, default_scope, sort)
    select p_org, v_cat, c, case when c in ('Falla de tolva', 'Falla de grab', 'Falta de producto en tolva', 'Cambio de bodega') then 'hold'
                                 when c = 'Mantenimiento' then 'scale' else 'operation' end, i
    from unnest(r.causes) with ordinality as u(c, i);
  end loop;
end $$;

create or replace function public.platform_create_organization(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_term uuid;
begin
  if not app.is_platform_admin() then raise exception 'Solo el administrador de la plataforma crea empresas' using errcode = '42501'; end if;
  insert into public.organizations (name, legal_name, tax_id, country, address, phone, email, created_by)
  values (app.req_text(p, 'name'), app.opt_text(p, 'legal_name'), app.opt_text(p, 'tax_id'), app.opt_text(p, 'country'),
          app.opt_text(p, 'address'), app.opt_text(p, 'phone'), app.opt_text(p, 'email'), auth.uid())
  returning id into v_org;
  insert into public.terminals (organization_id, code, name, port_name, timezone)
  values (v_org, coalesce(app.opt_text(p, 'terminal_code'), 'T1'), coalesce(app.opt_text(p, 'terminal_name'), 'Terminal principal'),
          app.opt_text(p, 'port_name'), coalesce(app.opt_text(p, 'timezone'), 'America/Guatemala'))
  returning id into v_term;
  perform app.seed_organization_defaults(v_org, v_term);
  return jsonb_build_object('organization_id', v_org, 'terminal_id', v_term);
end $$;
grant execute on function public.platform_create_organization(jsonb) to authenticated;

-- Valores por defecto al crear terminales adicionales.
create or replace function app.terminal_defaults() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.terminal_settings (terminal_id, organization_id) values (new.id, new.organization_id) on conflict do nothing;
  if not exists (select 1 from public.shifts where terminal_id = new.id) and exists (select 1 from public.organization_settings where organization_id = new.organization_id) then
    insert into public.shifts (organization_id, terminal_id, name, start_time, end_time, sort) values
      (new.organization_id, new.id, 'Turno 1', '06:00', '14:00', 1), (new.organization_id, new.id, 'Turno 2', '14:00', '22:00', 2),
      (new.organization_id, new.id, 'Turno 3', '22:00', '06:00', 3);
  end if;
  return new;
end $$;
create trigger terminals_defaults after insert on public.terminals for each row execute function app.terminal_defaults();

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns void
language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
   where recipient_user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
$$;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------- vistas (security_invoker: aplican RLS del usuario)
create or replace view public.service_overview with (security_invoker = true) as
select s.id, s.organization_id, s.terminal_id, s.customer_id, s.vessel_id, s.service_number, s.status,
       s.planned_start, s.estimated_end, s.actual_start, s.finalized_at, s.responsible_name, s.responsible_user_id,
       s.observations, s.created_at, s.data_revision,
       c.trade_name as customer_name, c.code as customer_code, v.name as vessel_name, v.imo_number, t.name as terminal_name, t.timezone,
       coalesce(k.initial_tm, 0) as initial_tm, coalesce(k.discharged_tm, 0) as discharged_tm,
       coalesce(k.initial_tm - k.discharged_tm, 0) as pending_tm,
       case when k.initial_tm > 0 then round(k.discharged_tm / k.initial_tm * 100, 2) else 0 end as progress_pct,
       coalesce(k.products, '') as products, coalesce(k.holds, 0) as holds_count,
       gr.status as report_status, gr.current_version_id
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

create or replace view public.customer_portfolio with (security_invoker = true) as
select c.id, c.organization_id, c.code, c.trade_name, c.legal_name, c.tax_id, c.country, c.email, c.phone, c.status, c.created_at,
       coalesce(a.total, 0) as services_total,
       coalesce(a.active, 0) as services_active,
       coalesce(a.finalized, 0) as services_finalized,
       a.last_operation_at,
       coalesce(a.discharged_tm, 0) as discharged_tm
from public.customers c
left join lateral (
  select count(*) total,
         count(*) filter (where s.status in ('preparing', 'in_operation', 'suspended', 'closing')) active,
         count(*) filter (where s.status = 'finalized') finalized,
         max(coalesce(s.finalized_at, s.actual_start, s.planned_start, s.created_at)) last_operation_at,
         (select sum(x.discharged_tm) from public.service_hold_cargo x join public.services s2 on s2.id = x.service_id
           where s2.customer_id = c.id) discharged_tm
  from public.services s where s.customer_id = c.id and s.status <> 'cancelled') a on true;

create or replace view public.operational_cycles with (security_invoker = true) as
select t.id, t.organization_id, t.terminal_id, t.service_id, t.customer_id, t.vessel_id, t.service_hold_id, t.cargo_id, t.product_id, t.scale_id,
       t.ticket_number, t.truck_plate, t.tractor_plate, t.driver_name, t.driver_dpi, t.nominal_capacity_tm,
       t.gross_kg, t.tare_kg, t.net_kg, t.net_tm, t.started_at, t.ended_at, t.cycle_seconds,
       round(t.cycle_seconds / 60.0, 2) as cycle_minutes, t.time_capture_mode, t.operation_date, t.shift_id,
       t.status, t.revision, t.registered_by, t.registered_by_name, t.registered_at, t.notes,
       s.service_number, v.name as vessel_name, sc.name as scale_name, sc.code as scale_code,
       h.hold_number, p.name as product_name, p.color as product_color, sh.name as shift_name, c.trade_name as customer_name
from public.weigh_tickets t
join public.services s on s.id = t.service_id
join public.vessels v on v.id = t.vessel_id
join public.scales sc on sc.id = t.scale_id
join public.service_holds h on h.id = t.service_hold_id
join public.products p on p.id = t.product_id
join public.customers c on c.id = t.customer_id
left join public.shifts sh on sh.id = t.shift_id;

create or replace view public.downtime_overview with (security_invoker = true) as
select d.id, d.organization_id, d.terminal_id, d.service_id, d.customer_id, d.vessel_id, d.cause_id, d.category_id,
       d.started_at, d.ended_at, d.duration_minutes, round(d.duration_minutes / 60.0, 2) as duration_hours,
       d.scope, d.service_hold_id, d.scale_id, d.observations, d.operation_date, d.shift_id, d.status, d.revision,
       d.reported_by, d.reported_by_name, d.created_at,
       s.service_number, v.name as vessel_name, c.trade_name as customer_name, dc.name as cause_name, cat.name as category_name,
       cat.color as category_color, h.hold_number, sc.name as scale_name, sh.name as shift_name
from public.downtime_events d
join public.services s on s.id = d.service_id
join public.vessels v on v.id = d.vessel_id
join public.customers c on c.id = d.customer_id
join public.downtime_causes dc on dc.id = d.cause_id
join public.downtime_categories cat on cat.id = d.category_id
left join public.service_holds h on h.id = d.service_hold_id
left join public.scales sc on sc.id = d.scale_id
left join public.shifts sh on sh.id = d.shift_id;

create or replace view public.report_overview with (security_invoker = true) as
select rv.id, rv.organization_id, rv.terminal_id, rv.report_id, rv.service_id, rv.customer_id, rv.version, rv.status,
       rv.verification_code, rv.sha256, rv.size_bytes, rv.storage_path, rv.draft_path, rv.generated_at, rv.signed_at, rv.signer_name,
       rv.signer_position, rv.published_at, rv.superseded_at, rv.superseded_by, rv.supersede_reason, rv.change_summary,
       s.service_number, s.status as service_status, v.name as vessel_name, c.trade_name as customer_name,
       coalesce(s.finalized_at, s.actual_start) as operation_date
from public.report_versions rv
join public.services s on s.id = rv.service_id
join public.vessels v on v.id = s.vessel_id
join public.customers c on c.id = rv.customer_id;

grant select on public.service_overview, public.customer_portfolio, public.operational_cycles,
  public.downtime_overview, public.report_overview to authenticated;

-- Índices auxiliares para RLS / vistas
create index if not exists service_hold_cargo_product_idx on public.service_hold_cargo (product_id);
create index if not exists services_org_idx on public.services (organization_id);
create index if not exists customer_users_customer_idx on public.customer_users (customer_id);
