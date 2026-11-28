-- =============================================================================
-- VESSEL CONTROL · Migración 007 · Storage privado y Realtime
-- Buckets PRIVADOS. Descarga solo mediante URLs firmadas de corta duración que
-- Storage emite tras evaluar estas políticas (no existen URLs públicas).
-- Los PDF de reportes solo los escribe el backend (service_role); ningún usuario
-- puede sobrescribirlos ni borrarlos → versión inmutable.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('org-assets', 'org-assets', false, 5242880, array['image/png', 'image/jpeg']),
  ('reports', 'reports', false, 52428800, array['application/pdf']),
  ('customer-documents', 'customer-documents', false, 26214400, null)
on conflict (id) do update set public = false;

-- ---------------------------------------------------------------- org-assets
-- Rutas: {org}/branding/* · {org}/customers/{customer}/* · {org}/signatures/* · {org}/seals/*
create policy org_assets_read on storage.objects for select to authenticated using (
  bucket_id = 'org-assets' and (
    ((storage.foldername(name))[2] in ('branding', 'customers')
       and (storage.foldername(name))[1] in (select x::text from app.my_org_ids() x))
    or ((storage.foldername(name))[2] = 'branding'
       and (storage.foldername(name))[1] in (select x::text from app.my_customer_org_ids() x))
    or ((storage.foldername(name))[2] = 'customers'
       and (storage.foldername(name))[3] in (select x::text from app.my_customer_ids() x))
    or ((storage.foldername(name))[2] in ('signatures', 'seals')
       and ((storage.foldername(name))[1] in (select x::text from app.orgs_with_perm('signatures.manage') x)
         or (storage.foldername(name))[1] in (select x::text from app.orgs_with_perm('reports.sign') x)))
  )
);
create policy org_assets_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'org-assets' and (
    ((storage.foldername(name))[2] = 'branding'
       and (storage.foldername(name))[1] in (select x::text from app.orgs_with_perm('org.manage') x))
    or ((storage.foldername(name))[2] = 'customers'
       and (storage.foldername(name))[3] in (select c.id::text from public.customers c
                                             where c.organization_id::text = (storage.foldername(name))[1]
                                               and c.organization_id in (select app.orgs_with_perm('customers.manage')))
       )
    or ((storage.foldername(name))[2] in ('signatures', 'seals')
       and (storage.foldername(name))[1] in (select x::text from app.orgs_with_perm('signatures.manage') x))
  )
);

-- ---------------------------------------------------------------- reports
create policy reports_read on storage.objects for select to authenticated using (
  bucket_id = 'reports' and (
    exists (select 1 from public.report_versions v
            where (v.storage_path = objects.name or v.draft_path = objects.name)
              and v.terminal_id in (select app.terminals_with_perm('reports.view')))
    or exists (select 1 from public.report_versions v
            where v.storage_path = objects.name
              and v.status in ('signed', 'superseded') and v.published_at is not null
              and v.customer_id in (select app.my_customer_ids_with('download')))
  )
);

-- ---------------------------------------------------------------- customer-documents
-- Ruta: {org}/{customer}/{archivo}
create policy customer_documents_obj_read on storage.objects for select to authenticated using (
  bucket_id = 'customer-documents' and (
    (storage.foldername(name))[1] in (select x::text from app.orgs_with_perm('customers.view') x)
    or exists (select 1 from public.customer_documents d
               where d.storage_path = objects.name and d.visible_to_customer and d.status = 'active'
                 and d.customer_id in (select app.my_customer_ids_with('documents')))
  )
);
create policy customer_documents_obj_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'customer-documents'
  and (storage.foldername(name))[2] in (select c.id::text from public.customers c
                                        where c.organization_id::text = (storage.foldername(name))[1]
                                          and c.organization_id in (select app.orgs_with_perm('customers.manage')))
);

-- ---------------------------------------------------------------- realtime (respeta RLS por suscriptor)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.service_hold_cargo, public.weigh_tickets, public.downtime_events,
      public.services, public.notifications, public.report_versions, public.generated_reports, public.correction_requests;
  end if;
end $$;
alter table public.service_hold_cargo replica identity full;
alter table public.services replica identity full;
