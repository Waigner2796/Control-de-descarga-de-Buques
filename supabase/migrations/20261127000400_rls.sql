-- =============================================================================
-- VESSEL CONTROL · Migración 004 · Row Level Security y privilegios
-- Principio: anon no ve nada; authenticated solo lo que sus pertenencias permiten.
-- Las escrituras críticas (pesajes, saldos, correcciones, reportes, firmas,
-- auditoría) NO tienen privilegios de escritura directa: solo RPC validadas.
-- Los helpers app.* devuelven conjuntos → `col in (select app.fn())` (initplan).
-- =============================================================================

-- Base: nada para anon, nada directo para authenticated hasta concederlo abajo.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
  end loop;
end $$;
-- FORCE afecta al dueño de la tabla; las funciones SECURITY DEFINER las ejecuta
-- el rol postgres (superusuario / BYPASSRLS), por lo que siguen funcionando.

-- ---------------------------------------------------------------- catálogos globales
grant select on public.roles, public.permissions, public.role_permissions to authenticated;
create policy roles_read on public.roles for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);

-- ---------------------------------------------------------------- organizaciones
grant select on public.organizations to authenticated;
grant update (name, legal_name, tax_id, country, address, phone, email, website, logo_path) on public.organizations to authenticated;
create policy organizations_read on public.organizations for select to authenticated using (
  id in (select app.my_org_ids())
  or id in (select app.my_customer_org_ids())
  or (select app.is_platform_admin())
);
create policy organizations_update on public.organizations for update to authenticated
  using (id in (select app.orgs_with_perm('org.manage')))
  with check (id in (select app.orgs_with_perm('org.manage')));

grant select, insert on public.terminals to authenticated;
grant update (code, name, port_name, address, timezone, status) on public.terminals to authenticated;
create policy terminals_read on public.terminals for select to authenticated using (
  id in (select app.my_terminal_ids())
  or organization_id in (select app.orgs_with_perm('org.manage'))
  or id in (select s.terminal_id from public.services s)
);
create policy terminals_insert on public.terminals for insert to authenticated
  with check (organization_id in (select app.orgs_with_perm('org.manage')));
create policy terminals_update on public.terminals for update to authenticated
  using (organization_id in (select app.orgs_with_perm('org.manage')))
  with check (organization_id in (select app.orgs_with_perm('org.manage')));

-- ---------------------------------------------------------------- perfiles y miembros
grant select on public.user_profiles to authenticated;
grant update (full_name, phone, position) on public.user_profiles to authenticated;
create policy user_profiles_read on public.user_profiles for select to authenticated using (
  user_id = (select auth.uid())
  or user_id in (select m.user_id from public.organization_members m)
  or user_id in (select cu.user_id from public.customer_users cu)
);
create policy user_profiles_update_own on public.user_profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select on public.platform_admins to authenticated;
create policy platform_admins_read_own on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.organization_members to authenticated;
create policy organization_members_read on public.organization_members for select to authenticated using (
  organization_id in (select app.my_org_ids()) or user_id = (select auth.uid())
);

grant select on public.terminal_members to authenticated;
create policy terminal_members_read on public.terminal_members for select to authenticated using (
  organization_id in (select app.my_org_ids())
);

-- ---------------------------------------------------------------- configuración
grant select on public.organization_settings, public.operational_thresholds to authenticated;
grant update (default_timezone, weight_input_unit, report_footer, dpi_exposure_in_reports, notify_customers_email)
  on public.organization_settings to authenticated;
grant update (long_cycle_minutes, max_cycle_hours, max_downtime_hours, max_net_kg, reconciliation_tolerance_tm)
  on public.operational_thresholds to authenticated;
create policy organization_settings_read on public.organization_settings for select to authenticated
  using (organization_id in (select app.my_org_ids()));
create policy organization_settings_update on public.organization_settings for update to authenticated
  using (organization_id in (select app.orgs_with_perm('org.manage')))
  with check (organization_id in (select app.orgs_with_perm('org.manage')));
create policy operational_thresholds_read on public.operational_thresholds for select to authenticated
  using (organization_id in (select app.my_org_ids()));
create policy operational_thresholds_update on public.operational_thresholds for update to authenticated
  using (organization_id in (select app.orgs_with_perm('org.manage')))
  with check (organization_id in (select app.orgs_with_perm('org.manage')));

grant select, insert on public.terminal_settings to authenticated;
grant update (time_capture_mode) on public.terminal_settings to authenticated;
create policy terminal_settings_read on public.terminal_settings for select to authenticated
  using (terminal_id in (select app.my_terminal_ids()));
create policy terminal_settings_write on public.terminal_settings for insert to authenticated
  with check (terminal_id in (select app.terminals_with_perm('org.manage')) or terminal_id in (select app.terminals_with_perm('scales.manage')));
create policy terminal_settings_update on public.terminal_settings for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('org.manage')) or terminal_id in (select app.terminals_with_perm('scales.manage')))
  with check (terminal_id in (select app.terminals_with_perm('org.manage')) or terminal_id in (select app.terminals_with_perm('scales.manage')));

grant select, insert, update, delete on public.shifts to authenticated;
create policy shifts_read on public.shifts for select to authenticated using (terminal_id in (select app.my_terminal_ids()));
create policy shifts_insert on public.shifts for insert to authenticated with check (terminal_id in (select app.terminals_with_perm('org.manage')));
create policy shifts_update on public.shifts for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('org.manage'))) with check (terminal_id in (select app.terminals_with_perm('org.manage')));
create policy shifts_delete on public.shifts for delete to authenticated using (terminal_id in (select app.terminals_with_perm('org.manage')));

-- ---------------------------------------------------------------- clientes
grant select, insert on public.customers to authenticated;
grant update (code, trade_name, legal_name, tax_id, country, address, main_contact, representative, email, phone, status, notes, logo_path)
  on public.customers to authenticated;
create policy customers_read on public.customers for select to authenticated using (
  organization_id in (select app.orgs_with_perm('customers.view'))
  or id in (select app.my_customer_ids())
  or id in (select s.customer_id from public.services s)
);
create policy customers_insert on public.customers for insert to authenticated
  with check (organization_id in (select app.orgs_with_perm('customers.manage')));
create policy customers_update on public.customers for update to authenticated
  using (organization_id in (select app.orgs_with_perm('customers.manage')))
  with check (organization_id in (select app.orgs_with_perm('customers.manage')));

grant select, insert, update, delete on public.customer_contacts to authenticated;
create policy customer_contacts_read on public.customer_contacts for select to authenticated
  using (organization_id in (select app.orgs_with_perm('customers.view')));
create policy customer_contacts_insert on public.customer_contacts for insert to authenticated
  with check (customer_id in (select c.id from public.customers c where c.organization_id in (select app.orgs_with_perm('customers.manage'))));
create policy customer_contacts_update on public.customer_contacts for update to authenticated
  using (organization_id in (select app.orgs_with_perm('customers.manage')))
  with check (customer_id in (select c.id from public.customers c where c.organization_id in (select app.orgs_with_perm('customers.manage'))));
create policy customer_contacts_delete on public.customer_contacts for delete to authenticated
  using (organization_id in (select app.orgs_with_perm('customers.manage')));

grant select on public.customer_users to authenticated;
create policy customer_users_read on public.customer_users for select to authenticated using (
  organization_id in (select app.orgs_with_perm('customers.view')) or user_id = (select auth.uid())
);

grant select on public.customer_portal_permissions to authenticated;
grant update (can_view_reports, can_download_reports, can_view_documents, can_view_productivity) on public.customer_portal_permissions to authenticated;
create policy customer_portal_permissions_read on public.customer_portal_permissions for select to authenticated using (
  organization_id in (select app.orgs_with_perm('customers.view'))
  or customer_user_id in (select cu.id from public.customer_users cu where cu.user_id = (select auth.uid()))
);
create policy customer_portal_permissions_update on public.customer_portal_permissions for update to authenticated
  using (organization_id in (select app.orgs_with_perm('portal_users.manage')))
  with check (organization_id in (select app.orgs_with_perm('portal_users.manage')));

grant select, insert on public.customer_documents to authenticated;
grant update (title, category, visible_to_customer, status, service_id) on public.customer_documents to authenticated;
create policy customer_documents_read on public.customer_documents for select to authenticated using (
  organization_id in (select app.orgs_with_perm('customers.view'))
  or (customer_id in (select app.my_customer_ids_with('documents')) and visible_to_customer and status = 'active')
);
create policy customer_documents_insert on public.customer_documents for insert to authenticated
  with check (customer_id in (select c.id from public.customers c where c.organization_id in (select app.orgs_with_perm('customers.manage'))));
create policy customer_documents_update on public.customer_documents for update to authenticated
  using (organization_id in (select app.orgs_with_perm('customers.manage')))
  with check (organization_id in (select app.orgs_with_perm('customers.manage')));

-- ---------------------------------------------------------------- buques y productos
grant select, insert on public.vessels to authenticated;
grant update (name, imo_number, vessel_type, flag, capacity_tm, holds_count, notes, status) on public.vessels to authenticated;
create policy vessels_read on public.vessels for select to authenticated using (
  organization_id in (select app.my_org_ids()) or id in (select s.vessel_id from public.services s)
);
create policy vessels_insert on public.vessels for insert to authenticated
  with check (organization_id in (select app.orgs_with_perm('vessels.manage')));
create policy vessels_update on public.vessels for update to authenticated
  using (organization_id in (select app.orgs_with_perm('vessels.manage')))
  with check (organization_id in (select app.orgs_with_perm('vessels.manage')));

grant select, insert, update, delete on public.vessel_holds to authenticated;
create policy vessel_holds_read on public.vessel_holds for select to authenticated using (
  organization_id in (select app.my_org_ids()) or vessel_id in (select s.vessel_id from public.services s)
);
create policy vessel_holds_insert on public.vessel_holds for insert to authenticated
  with check (vessel_id in (select v.id from public.vessels v where v.organization_id in (select app.orgs_with_perm('vessels.manage'))));
create policy vessel_holds_update on public.vessel_holds for update to authenticated
  using (organization_id in (select app.orgs_with_perm('vessels.manage')))
  with check (vessel_id in (select v.id from public.vessels v where v.organization_id in (select app.orgs_with_perm('vessels.manage'))));
create policy vessel_holds_delete on public.vessel_holds for delete to authenticated
  using (organization_id in (select app.orgs_with_perm('vessels.manage')));

grant select, insert on public.products to authenticated;
grant update (code, name, color, description, status) on public.products to authenticated;
create policy products_read on public.products for select to authenticated using (
  organization_id in (select app.my_org_ids()) or id in (select c.product_id from public.service_hold_cargo c)
);
create policy products_insert on public.products for insert to authenticated
  with check (organization_id in (select app.orgs_with_perm('vessels.manage')));
create policy products_update on public.products for update to authenticated
  using (organization_id in (select app.orgs_with_perm('vessels.manage')))
  with check (organization_id in (select app.orgs_with_perm('vessels.manage')));

-- ---------------------------------------------------------------- servicios
grant select on public.services to authenticated;
grant update (service_number, customer_id, vessel_id, planned_start, estimated_end, responsible_user_id, responsible_name, observations)
  on public.services to authenticated;
create policy services_read on public.services for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view'))
  or id in (select app.my_operator_service_ids())
  or customer_id in (select app.my_customer_ids())
);
create policy services_update on public.services for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')))
  with check (terminal_id in (select app.terminals_with_perm('services.manage')));

-- Ediciones directas de servicio: bloqueadas en servicios finalizados o cancelados,
-- y cliente/buque solo modificables antes de iniciar la operación.
create or replace function app.services_edit_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('app.rpc', true), '') = 'on' then return new; end if;
  if old.status in ('finalized', 'cancelled') then
    raise exception 'El servicio está %; requiere reapertura autorizada', old.status using errcode = '42501';
  end if;
  if (new.customer_id <> old.customer_id or new.vessel_id <> old.vessel_id)
     and old.status not in ('scheduled', 'preparing') then
    raise exception 'El cliente y el buque solo pueden cambiarse antes de iniciar la operación' using errcode = '42501';
  end if;
  if new.status is distinct from old.status or new.data_revision is distinct from old.data_revision
     or new.finalized_at is distinct from old.finalized_at or new.actual_start is distinct from old.actual_start then
    raise exception 'El estado del servicio solo cambia mediante las funciones de flujo operativo' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger services_edit_guard before update on public.services
  for each row execute function app.services_edit_guard();

grant select, insert, delete on public.service_scales to authenticated;
create policy service_scales_read on public.service_scales for select to authenticated
  using (service_id in (select s.id from public.services s));
create policy service_scales_insert on public.service_scales for insert to authenticated
  with check (service_id in (select s.id from public.services s where s.terminal_id in (select app.terminals_with_perm('services.manage'))));
create policy service_scales_delete on public.service_scales for delete to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')));

-- Configuración de bodegas/carga bloqueada una vez finalizado o cancelado el servicio.
create or replace function app.service_config_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  -- Las funciones transaccionales (ledger de pesajes/correcciones) ya validan el estado.
  if coalesce(current_setting('app.rpc', true), '') = 'on'
     or coalesce(current_setting('app.ledger_write', true), '') = 'on' then return coalesce(new, old); end if;
  select status into v_status from public.services where id = coalesce(new.service_id, old.service_id);
  if v_status in ('finalized', 'cancelled') then
    raise exception 'El servicio está %; la configuración de bodegas no puede cambiar', v_status using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

grant select, insert, delete on public.service_holds to authenticated;
grant update (hold_number, capacity_tm, vessel_hold_id) on public.service_holds to authenticated;
create policy service_holds_read on public.service_holds for select to authenticated
  using (service_id in (select s.id from public.services s));
create policy service_holds_insert on public.service_holds for insert to authenticated
  with check (service_id in (select s.id from public.services s where s.terminal_id in (select app.terminals_with_perm('services.manage'))));
create policy service_holds_update on public.service_holds for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')))
  with check (terminal_id in (select app.terminals_with_perm('services.manage')));
create policy service_holds_delete on public.service_holds for delete to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')));
create trigger service_holds_guard before insert or update or delete on public.service_holds
  for each row execute function app.service_config_guard();

grant select, insert, delete on public.service_hold_cargo to authenticated;
grant update (initial_tm, notes) on public.service_hold_cargo to authenticated;
create policy service_hold_cargo_read on public.service_hold_cargo for select to authenticated
  using (service_id in (select s.id from public.services s));
create policy service_hold_cargo_insert on public.service_hold_cargo for insert to authenticated
  with check (service_id in (select s.id from public.services s where s.terminal_id in (select app.terminals_with_perm('services.manage'))));
create policy service_hold_cargo_update on public.service_hold_cargo for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')))
  with check (terminal_id in (select app.terminals_with_perm('services.manage')));
create policy service_hold_cargo_delete on public.service_hold_cargo for delete to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.manage')) and discharged_tm = 0);
create trigger service_hold_cargo_guard before insert or update or delete on public.service_hold_cargo
  for each row execute function app.service_config_guard();

-- ---------------------------------------------------------------- básculas
grant select, insert on public.scales to authenticated;
grant update (code, name, location, status) on public.scales to authenticated;
create policy scales_read on public.scales for select to authenticated using (terminal_id in (select app.my_terminal_ids()));
create policy scales_insert on public.scales for insert to authenticated with check (terminal_id in (select app.terminals_with_perm('scales.manage')));
create policy scales_update on public.scales for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('scales.manage'))) with check (terminal_id in (select app.terminals_with_perm('scales.manage')));

grant select, insert on public.scale_settings to authenticated;
grant update (time_capture_mode) on public.scale_settings to authenticated;
create policy scale_settings_read on public.scale_settings for select to authenticated using (terminal_id in (select app.my_terminal_ids()));
create policy scale_settings_insert on public.scale_settings for insert to authenticated
  with check (scale_id in (select s.id from public.scales s where s.terminal_id in (select app.terminals_with_perm('scales.manage'))));
create policy scale_settings_update on public.scale_settings for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('scales.manage'))) with check (terminal_id in (select app.terminals_with_perm('scales.manage')));

grant select, insert, delete on public.scale_users to authenticated;
create policy scale_users_read on public.scale_users for select to authenticated using (terminal_id in (select app.my_terminal_ids()));
create policy scale_users_insert on public.scale_users for insert to authenticated
  with check (scale_id in (select s.id from public.scales s where s.terminal_id in (select app.terminals_with_perm('scales.manage')))
              and user_id in (select m.user_id from public.organization_members m where m.organization_id in (select app.orgs_with_perm('scales.manage'))));
create policy scale_users_delete on public.scale_users for delete to authenticated
  using (terminal_id in (select app.terminals_with_perm('scales.manage')));

-- ---------------------------------------------------------------- transporte (solo lectura; se alimenta desde RPC)
grant select on public.trucks, public.tractors, public.drivers to authenticated;
create policy trucks_read on public.trucks for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy tractors_read on public.tractors for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy drivers_read on public.drivers for select to authenticated using (organization_id in (select app.my_org_ids()));

-- ---------------------------------------------------------------- pesajes y ledger (solo lectura; escritura vía RPC)
grant select on public.scale_visits, public.weigh_tickets to authenticated;
create policy scale_visits_read on public.scale_visits for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('weighing.view_all')) or scale_id in (select app.my_scale_ids())
);
create policy weigh_tickets_read on public.weigh_tickets for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('weighing.view_all')) or scale_id in (select app.my_scale_ids())
);

grant select on public.cargo_movements, public.ticket_reversals, public.cargo_adjustments to authenticated;
create policy cargo_movements_read on public.cargo_movements for select to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.view')));
create policy ticket_reversals_read on public.ticket_reversals for select to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.view')));
create policy cargo_adjustments_read on public.cargo_adjustments for select to authenticated
  using (terminal_id in (select app.terminals_with_perm('services.view')));

-- ---------------------------------------------------------------- tiempos perdidos
grant select, insert on public.downtime_categories, public.downtime_causes to authenticated;
grant update (name, color, sort, status) on public.downtime_categories to authenticated;
grant update (name, category_id, default_scope, sort, status) on public.downtime_causes to authenticated;
create policy downtime_categories_read on public.downtime_categories for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy downtime_categories_insert on public.downtime_categories for insert to authenticated with check (organization_id in (select app.orgs_with_perm('downtime.manage')));
create policy downtime_categories_update on public.downtime_categories for update to authenticated
  using (organization_id in (select app.orgs_with_perm('downtime.manage'))) with check (organization_id in (select app.orgs_with_perm('downtime.manage')));
create policy downtime_causes_read on public.downtime_causes for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy downtime_causes_insert on public.downtime_causes for insert to authenticated
  with check (organization_id in (select app.orgs_with_perm('downtime.manage'))
              and category_id in (select c.id from public.downtime_categories c where c.organization_id = downtime_causes.organization_id));
create policy downtime_causes_update on public.downtime_causes for update to authenticated
  using (organization_id in (select app.orgs_with_perm('downtime.manage')))
  with check (organization_id in (select app.orgs_with_perm('downtime.manage'))
              and category_id in (select c.id from public.downtime_categories c where c.organization_id = downtime_causes.organization_id));

grant select on public.downtime_events to authenticated;
create policy downtime_events_read on public.downtime_events for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view'))
  or terminal_id in (select app.terminals_with_perm('downtime.register'))
);

grant select on public.productivity_snapshots to authenticated;
create policy productivity_snapshots_read on public.productivity_snapshots for select to authenticated
  using (terminal_id in (select app.terminals_with_perm('productivity.view')));

-- ---------------------------------------------------------------- reportes, firmas, sellos
grant select, insert on public.report_templates to authenticated;
grant update (title, primary_color, show_customer_logo, conclusions_default, footer_text) on public.report_templates to authenticated;
create policy report_templates_read on public.report_templates for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy report_templates_insert on public.report_templates for insert to authenticated with check (organization_id in (select app.orgs_with_perm('signatures.manage')));
create policy report_templates_update on public.report_templates for update to authenticated
  using (organization_id in (select app.orgs_with_perm('signatures.manage'))) with check (organization_id in (select app.orgs_with_perm('signatures.manage')));

grant select, insert on public.authorized_signers, public.company_seals to authenticated;
grant update (user_id, full_name, position, signature_path, status) on public.authorized_signers to authenticated;
grant update (name, image_path, is_default, status) on public.company_seals to authenticated;
create policy authorized_signers_read on public.authorized_signers for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy authorized_signers_insert on public.authorized_signers for insert to authenticated with check (organization_id in (select app.orgs_with_perm('signatures.manage')));
create policy authorized_signers_update on public.authorized_signers for update to authenticated
  using (organization_id in (select app.orgs_with_perm('signatures.manage'))) with check (organization_id in (select app.orgs_with_perm('signatures.manage')));
create policy company_seals_read on public.company_seals for select to authenticated using (organization_id in (select app.my_org_ids()));
create policy company_seals_insert on public.company_seals for insert to authenticated with check (organization_id in (select app.orgs_with_perm('signatures.manage')));
create policy company_seals_update on public.company_seals for update to authenticated
  using (organization_id in (select app.orgs_with_perm('signatures.manage'))) with check (organization_id in (select app.orgs_with_perm('signatures.manage')));

grant select on public.generated_reports to authenticated;
grant update (conclusions) on public.generated_reports to authenticated;
create policy generated_reports_read on public.generated_reports for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('reports.view'))
  or customer_id in (select app.my_customer_ids_with('reports'))
);
create policy generated_reports_update on public.generated_reports for update to authenticated
  using (terminal_id in (select app.terminals_with_perm('reports.generate')))
  with check (terminal_id in (select app.terminals_with_perm('reports.generate')));

grant select on public.report_versions to authenticated;
create policy report_versions_read on public.report_versions for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('reports.view'))
  or (customer_id in (select app.my_customer_ids_with('reports'))
      and status in ('signed', 'superseded') and published_at is not null)
);

grant select on public.digital_signatures to authenticated;
create policy digital_signatures_read on public.digital_signatures for select to authenticated
  using (report_version_id in (select v.id from public.report_versions v));

grant select on public.report_jobs to authenticated;
create policy report_jobs_read on public.report_jobs for select to authenticated
  using (terminal_id in (select app.terminals_with_perm('reports.view')));

-- ---------------------------------------------------------------- correcciones y auditoría
grant select on public.correction_requests, public.correction_history, public.approval_records, public.audit_logs to authenticated;
create policy correction_requests_read on public.correction_requests for select to authenticated using (
  requested_by = (select auth.uid())
  or terminal_id in (select app.terminals_with_perm('corrections.approve'))
  or terminal_id in (select app.terminals_with_perm('services.view'))
);
create policy correction_history_read on public.correction_history for select to authenticated using (
  terminal_id in (select app.terminals_with_perm('services.view'))
  or (target_type = 'weigh_ticket' and target_id in (select t.id from public.weigh_tickets t))
);
create policy approval_records_read on public.approval_records for select to authenticated using (
  organization_id in (select app.orgs_with_perm('audit.view'))
  or organization_id in (select app.orgs_with_perm('corrections.approve'))
);
create policy audit_logs_read on public.audit_logs for select to authenticated
  using (organization_id in (select app.orgs_with_perm('audit.view')));

-- ---------------------------------------------------------------- notificaciones
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
create policy notifications_read on public.notifications for select to authenticated using (recipient_user_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_user_id = (select auth.uid())) with check (recipient_user_id = (select auth.uid()));

-- service_role (Edge Functions) conserva acceso completo y omite RLS.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
