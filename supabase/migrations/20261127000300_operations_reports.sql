-- =============================================================================
-- VESSEL CONTROL · Migración 003 · Pesajes, ledger de tonelaje, tiempos perdidos,
-- productividad, reportes, firmas, correcciones y notificaciones.
-- Captura de pesos EXCLUSIVAMENTE manual (sin integración con básculas).
-- Marcas horarias de báscula: SOLO hora de inicio y hora final.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Visitas a báscula: soporte de la modalidad "hora actual del servidor".
-- La hora de inicio y la final las fija now() del servidor, no el navegador.
-- -----------------------------------------------------------------------------
create table public.scale_visits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  scale_id        uuid not null references public.scales(id) on delete restrict,
  started_at      timestamptz not null,
  ended_at        timestamptz,
  status          text not null default 'open' check (status in ('open', 'completed', 'cancelled')),
  draft           jsonb not null default '{}',
  opened_by       uuid not null references auth.users(id),
  ticket_id       uuid,
  cancel_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index scale_visits_scale_open_idx on public.scale_visits (scale_id) where status = 'open';
create index scale_visits_service_idx on public.scale_visits (service_id, status);

-- -----------------------------------------------------------------------------
-- Tickets de pesaje (cada fila = un ciclo de báscula)
-- -----------------------------------------------------------------------------
create table public.weigh_tickets (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  terminal_id          uuid not null references public.terminals(id) on delete restrict,
  service_id           uuid not null references public.services(id) on delete restrict,
  customer_id          uuid not null references public.customers(id) on delete restrict,
  vessel_id            uuid not null references public.vessels(id) on delete restrict,
  service_hold_id      uuid not null references public.service_holds(id) on delete restrict,
  cargo_id             uuid not null references public.service_hold_cargo(id) on delete restrict,
  product_id           uuid not null references public.products(id) on delete restrict,
  scale_id             uuid not null references public.scales(id) on delete restrict,
  visit_id             uuid references public.scale_visits(id) on delete restrict,
  ticket_number        text not null check (length(btrim(ticket_number)) between 1 and 40),
  truck_id             uuid references public.trucks(id) on delete restrict,
  tractor_id           uuid references public.tractors(id) on delete restrict,
  driver_id            uuid references public.drivers(id) on delete restrict,
  truck_plate          text not null,
  tractor_plate        text,
  driver_name          text not null,
  driver_dpi           text not null check (driver_dpi ~ '^[0-9]{13}$'),
  nominal_capacity_tm  numeric(8,3) check (nominal_capacity_tm is null or nominal_capacity_tm > 0),
  gross_kg             numeric(12,2) not null check (gross_kg > 0),
  tare_kg              numeric(12,2) not null check (tare_kg > 0),
  net_kg               numeric(12,2) generated always as (gross_kg - tare_kg) stored,
  net_tm               numeric(14,3) generated always as (round((gross_kg - tare_kg) / 1000.0, 3)) stored,
  started_at           timestamptz not null,
  ended_at             timestamptz not null,
  cycle_seconds        numeric(12,0) generated always as (extract(epoch from (ended_at - started_at))) stored,
  time_capture_mode    text not null check (time_capture_mode in ('manual', 'server_now')),
  operation_date       date not null,
  shift_id             uuid references public.shifts(id) on delete set null,
  status               text not null default 'valid' check (status in ('valid', 'voided')),
  void_reason          text,
  voided_at            timestamptz,
  voided_by            uuid references auth.users(id),
  notes                text,
  revision             int not null default 1,
  client_request_id    uuid not null unique,
  registered_by        uuid not null references auth.users(id),
  registered_by_name   text,
  registered_at        timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint weigh_tickets_gross_gt_tare check (gross_kg > tare_kg),
  constraint weigh_tickets_times check (ended_at >= started_at)
);
-- Ticket único por báscula entre los válidos.
create unique index weigh_tickets_scale_number_uq on public.weigh_tickets (scale_id, lower(ticket_number)) where status = 'valid';
-- Índices para paginación del lado del servidor y filtros de ciclos.
create index weigh_tickets_service_started_idx on public.weigh_tickets (service_id, started_at desc, id desc);
create index weigh_tickets_terminal_started_idx on public.weigh_tickets (terminal_id, started_at desc, id desc);
create index weigh_tickets_org_started_idx on public.weigh_tickets (organization_id, started_at desc);
create index weigh_tickets_scale_started_idx on public.weigh_tickets (scale_id, started_at desc);
create index weigh_tickets_hold_idx on public.weigh_tickets (service_hold_id);
create index weigh_tickets_cargo_idx on public.weigh_tickets (cargo_id);
create index weigh_tickets_product_idx on public.weigh_tickets (product_id);
create index weigh_tickets_customer_idx on public.weigh_tickets (customer_id, started_at desc);
create index weigh_tickets_vessel_idx on public.weigh_tickets (vessel_id);
create index weigh_tickets_truck_idx on public.weigh_tickets (truck_id);
create index weigh_tickets_date_idx on public.weigh_tickets (service_id, operation_date);
create index weigh_tickets_shift_idx on public.weigh_tickets (shift_id);
create index weigh_tickets_registered_by_idx on public.weigh_tickets (registered_by);
create index weigh_tickets_plate_trgm on public.weigh_tickets using gin (truck_plate extensions.gin_trgm_ops);
create index weigh_tickets_ticket_trgm on public.weigh_tickets using gin (ticket_number extensions.gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Ledger de tonelaje (append-only). discharged_tm = Σ quantity_tm por cargo.
-- discharge: +neto · reversal: −neto previo (anulación / corrección)
-- -----------------------------------------------------------------------------
create table public.cargo_movements (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  cargo_id        uuid not null references public.service_hold_cargo(id) on delete restrict,
  ticket_id       uuid references public.weigh_tickets(id) on delete restrict,
  ticket_revision int,
  kind            text not null check (kind in ('discharge', 'reversal')),
  quantity_tm     numeric(14,3) not null check (quantity_tm <> 0),
  balance_after_tm numeric(14,3) not null,
  reason          text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now(),
  check ((kind = 'discharge' and quantity_tm > 0) or (kind = 'reversal' and quantity_tm < 0))
);
create index cargo_movements_cargo_idx on public.cargo_movements (cargo_id, id);
create index cargo_movements_ticket_idx on public.cargo_movements (ticket_id);
create index cargo_movements_service_idx on public.cargo_movements (service_id);
-- Un mismo ticket/revisión solo puede descontar una vez.
create unique index cargo_movements_discharge_once on public.cargo_movements (ticket_id, ticket_revision) where kind = 'discharge';
create unique index cargo_movements_reversal_once on public.cargo_movements (ticket_id, ticket_revision) where kind = 'reversal';

create table public.ticket_reversals (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete restrict,
  terminal_id          uuid not null references public.terminals(id) on delete restrict,
  service_id           uuid not null references public.services(id) on delete restrict,
  ticket_id            uuid not null references public.weigh_tickets(id) on delete restrict,
  ticket_revision      int not null,
  reversal_movement_id bigint not null references public.cargo_movements(id),
  reason               text not null,
  kind                 text not null check (kind in ('void', 'correction')),
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now()
);
create index ticket_reversals_ticket_idx on public.ticket_reversals (ticket_id);

-- Ajustes auditados del tonelaje manifestado (p.ej. conocimiento de embarque corregido).
create table public.cargo_adjustments (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  terminal_id        uuid not null references public.terminals(id) on delete restrict,
  service_id         uuid not null references public.services(id) on delete restrict,
  cargo_id           uuid not null references public.service_hold_cargo(id) on delete restrict,
  previous_initial_tm numeric(14,3) not null,
  new_initial_tm     numeric(14,3) not null check (new_initial_tm > 0),
  reason             text not null check (length(btrim(reason)) >= 8),
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now()
);
create index cargo_adjustments_service_idx on public.cargo_adjustments (service_id);

-- Ahora que existe el ledger, se activa el control de saldos de service_hold_cargo.
create trigger service_hold_cargo_zchk before insert or update on public.service_hold_cargo
  for each row execute function app.service_hold_cargo_chk();

-- -----------------------------------------------------------------------------
-- Tiempos perdidos
-- -----------------------------------------------------------------------------
create table public.downtime_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 80),
  color           text not null default '#5a6a79' check (color ~* '^#[0-9a-f]{6}$'),
  sort            int not null default 0,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now()
);
create unique index downtime_categories_uq on public.downtime_categories (organization_id, lower(btrim(name)));

create table public.downtime_causes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  category_id     uuid not null references public.downtime_categories(id) on delete restrict,
  name            text not null check (length(btrim(name)) between 2 and 120),
  default_scope   text not null default 'operation' check (default_scope in ('operation', 'hold', 'scale')),
  sort            int not null default 0,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now()
);
create unique index downtime_causes_uq on public.downtime_causes (organization_id, lower(btrim(name)));

create table public.downtime_events (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  terminal_id      uuid not null references public.terminals(id) on delete restrict,
  service_id       uuid not null references public.services(id) on delete restrict,
  customer_id      uuid not null references public.customers(id) on delete restrict,
  vessel_id        uuid not null references public.vessels(id) on delete restrict,
  cause_id         uuid not null references public.downtime_causes(id) on delete restrict,
  category_id      uuid not null references public.downtime_categories(id) on delete restrict,
  started_at       timestamptz not null,
  ended_at         timestamptz not null,
  duration_minutes numeric(12,2) generated always as (round(extract(epoch from (ended_at - started_at)) / 60.0, 2)) stored,
  -- Alcance: toda la operación, una bodega o una báscula (no se asume parada total).
  scope            text not null check (scope in ('operation', 'hold', 'scale')),
  service_hold_id  uuid references public.service_holds(id) on delete restrict,
  scale_id         uuid references public.scales(id) on delete restrict,
  observations     text,
  operation_date   date not null,
  shift_id         uuid references public.shifts(id) on delete set null,
  status           text not null default 'valid' check (status in ('valid', 'voided')),
  void_reason      text,
  revision         int not null default 1,
  client_request_id uuid not null unique,
  reported_by      uuid not null references auth.users(id),
  reported_by_name text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint downtime_positive check (ended_at > started_at),
  constraint downtime_scope_hold check (scope <> 'hold' or service_hold_id is not null),
  constraint downtime_scope_scale check (scope <> 'scale' or scale_id is not null)
);
create index downtime_events_service_idx on public.downtime_events (service_id, started_at desc);
create index downtime_events_terminal_idx on public.downtime_events (terminal_id, started_at desc);
create index downtime_events_cause_idx on public.downtime_events (cause_id);
create index downtime_events_category_idx on public.downtime_events (category_id);
create index downtime_events_hold_idx on public.downtime_events (service_hold_id);
create index downtime_events_scale_idx on public.downtime_events (scale_id);

-- -----------------------------------------------------------------------------
-- Productividad: instantáneas congeladas (p. ej. al cierre del servicio)
-- -----------------------------------------------------------------------------
create table public.productivity_snapshots (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  terminal_id     uuid not null references public.terminals(id) on delete restrict,
  service_id      uuid not null references public.services(id) on delete restrict,
  kind            text not null check (kind in ('closure', 'manual')),
  data_revision   int not null,
  metrics         jsonb not null,
  taken_by        uuid references auth.users(id),
  taken_at        timestamptz not null default now()
);
create index productivity_snapshots_service_idx on public.productivity_snapshots (service_id, taken_at desc);

-- -----------------------------------------------------------------------------
-- Reportes, firmas y sellos
-- -----------------------------------------------------------------------------
create table public.report_templates (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  kind               text not null default 'final_service' check (kind in ('final_service')),
  title              text not null default 'INFORME FINAL DE OPERACIÓN DE DESCARGA',
  primary_color      text not null default '#0b4f71' check (primary_color ~* '^#[0-9a-f]{6}$'),
  show_customer_logo boolean not null default true,
  conclusions_default text not null default '',
  footer_text        text not null default '',
  updated_at         timestamptz not null default now(),
  unique (organization_id, kind)
);

create table public.authorized_signers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  user_id         uuid references auth.users(id) on delete restrict,
  full_name       text not null,
  position        text not null,
  signature_path  text,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table public.company_seals (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  name            text not null,
  image_path      text,
  is_default      boolean not null default false,
  status          text not null default 'active' check (status in ('active', 'inactive')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index company_seals_default_uq on public.company_seals (organization_id) where is_default and status = 'active';

create table public.generated_reports (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  terminal_id        uuid not null references public.terminals(id) on delete restrict,
  service_id         uuid not null references public.services(id) on delete restrict,
  customer_id        uuid not null references public.customers(id) on delete restrict,
  kind               text not null default 'final_service' check (kind in ('final_service')),
  -- current: hay versión firmada vigente · revision_pending: hubo corrección, nueva versión en curso
  status             text not null default 'generating' check (status in ('generating','pending_signature','current','revision_pending','failed')),
  current_version_id uuid,
  conclusions        text not null default '',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (service_id, kind)
);
create index generated_reports_customer_idx on public.generated_reports (customer_id);

create table public.report_versions (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  terminal_id         uuid not null references public.terminals(id) on delete restrict,
  report_id           uuid not null references public.generated_reports(id) on delete restrict,
  service_id          uuid not null references public.services(id) on delete restrict,
  customer_id         uuid not null references public.customers(id) on delete restrict,
  version             int not null check (version >= 1),
  data_revision       int not null,
  status              text not null default 'pending_signature'
                      check (status in ('pending_signature', 'signed', 'superseded', 'discarded')),
  draft_path          text,
  storage_path        text,
  sha256              text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes          bigint,
  verification_code   text not null unique,
  generated_at        timestamptz not null default now(),
  generated_by        uuid references auth.users(id),
  signed_at           timestamptz,
  signed_by           uuid references auth.users(id),
  signer_id           uuid references public.authorized_signers(id),
  signer_name         text,
  signer_position     text,
  seal_id             uuid references public.company_seals(id),
  published_at        timestamptz,
  superseded_at       timestamptz,
  superseded_by       uuid references public.report_versions(id),
  supersede_reason    text,
  change_summary      text,
  unique (report_id, version),
  check (status <> 'signed' or (sha256 is not null and storage_path is not null and signed_at is not null))
);
create index report_versions_service_idx on public.report_versions (service_id, version desc);
create index report_versions_customer_idx on public.report_versions (customer_id, published_at desc);
create unique index report_versions_storage_uq on public.report_versions (storage_path) where storage_path is not null;

alter table public.generated_reports
  add constraint generated_reports_current_fk foreign key (current_version_id) references public.report_versions(id);

-- Inmutabilidad: una versión firmada no cambia salvo para marcarse como sustituida.
create or replace function app.report_versions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status in ('signed', 'superseded') then
    if new.status = 'superseded' and old.status = 'signed'
       and new.sha256 = old.sha256 and new.storage_path = old.storage_path
       and new.signed_at = old.signed_at and new.signer_id is not distinct from old.signer_id
       and new.version = old.version and new.verification_code = old.verification_code then
      return new;
    end if;
    if new is not distinct from old then return new; end if;
    raise exception 'Un reporte firmado es inmutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger report_versions_guard before update on public.report_versions
  for each row execute function app.report_versions_guard();

create table public.digital_signatures (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete restrict,
  report_version_id  uuid not null unique references public.report_versions(id) on delete restrict,
  signer_id          uuid not null references public.authorized_signers(id),
  signed_by          uuid not null references auth.users(id),
  signer_name        text not null,
  signer_position    text not null,
  seal_id            uuid references public.company_seals(id),
  document_sha256    text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  -- 'graphic': imagen de firma + sello insertados y hash SHA-256 de integridad.
  -- NO es una firma criptográfica con certificado (ver docs/SEGURIDAD.md).
  signature_type     text not null default 'graphic' check (signature_type in ('graphic', 'certified_provider')),
  evidence           jsonb not null default '{}',
  signed_at          timestamptz not null default now()
);

create table public.report_jobs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  terminal_id      uuid not null references public.terminals(id) on delete restrict,
  service_id       uuid not null references public.services(id) on delete restrict,
  report_id        uuid not null references public.generated_reports(id) on delete restrict,
  data_revision    int not null,
  -- Idempotencia: un único trabajo por servicio y revisión de datos.
  idempotency_key  text not null unique,
  status           text not null default 'queued' check (status in ('queued', 'processing', 'done', 'failed')),
  attempts         int not null default 0,
  max_attempts     int not null default 5,
  last_error       text,
  locked_until     timestamptz,
  result_version_id uuid references public.report_versions(id),
  requested_by     uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
create index report_jobs_pending_idx on public.report_jobs (status, created_at) where status in ('queued', 'processing', 'failed');

-- -----------------------------------------------------------------------------
-- Correcciones, aprobaciones e historial
-- -----------------------------------------------------------------------------
create table public.correction_requests (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  terminal_id      uuid not null references public.terminals(id) on delete restrict,
  service_id       uuid not null references public.services(id) on delete restrict,
  target_type      text not null check (target_type in ('weigh_ticket', 'downtime_event')),
  target_id        uuid not null,
  target_revision  int not null,
  action           text not null default 'update' check (action in ('update', 'void')),
  changes          jsonb not null default '{}',
  previous_values  jsonb not null default '{}',
  reason           text not null check (length(btrim(reason)) >= 8),
  status           text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'cancelled')),
  requested_by     uuid not null references auth.users(id),
  requested_by_name text,
  requested_at     timestamptz not null default now(),
  reviewed_by      uuid references auth.users(id),
  reviewed_by_name text,
  reviewed_at      timestamptz,
  review_note      text,
  applied_at       timestamptz
);
create index correction_requests_status_idx on public.correction_requests (organization_id, status, requested_at desc);
create index correction_requests_target_idx on public.correction_requests (target_type, target_id);
create unique index correction_requests_one_pending on public.correction_requests (target_type, target_id) where status = 'pending';

create table public.correction_history (
  id               bigint generated always as identity primary key,
  organization_id  uuid not null references public.organizations(id) on delete restrict,
  terminal_id      uuid not null references public.terminals(id) on delete restrict,
  service_id       uuid not null references public.services(id) on delete restrict,
  request_id       uuid references public.correction_requests(id),
  target_type      text not null,
  target_id        uuid not null,
  revision_from    int not null,
  revision_to      int not null,
  field            text not null,
  old_value        text,
  new_value        text,
  reason           text not null,
  snapshot_before  jsonb,
  applied_by       uuid references auth.users(id),
  applied_by_name  text,
  approved_by      uuid references auth.users(id),
  applied_at       timestamptz not null default now()
);
create index correction_history_target_idx on public.correction_history (target_type, target_id, applied_at desc);
create index correction_history_service_idx on public.correction_history (service_id, applied_at desc);

create table public.approval_records (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  subject_type    text not null check (subject_type in ('correction', 'report_signature', 'service_close', 'service_reopen', 'cargo_adjustment')),
  subject_id      uuid not null,
  decision        text not null check (decision in ('approved', 'rejected')),
  decided_by      uuid not null references auth.users(id),
  decided_by_name text,
  note            text,
  decided_at      timestamptz not null default now()
);
create index approval_records_subject_idx on public.approval_records (subject_type, subject_id);

-- -----------------------------------------------------------------------------
-- Notificaciones (portal y equipo interno)
-- -----------------------------------------------------------------------------
create table public.notifications (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  kind              text not null,
  title             text not null,
  body              text not null default '',
  link              text,
  read_at           timestamptz,
  emailed_at        timestamptz,
  created_at        timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Triggers: alcance, updated_at, auditoría, no-borrado
-- -----------------------------------------------------------------------------
create trigger scale_visits_touch before update on public.scale_visits for each row execute function app.touch_updated_at();
create trigger weigh_tickets_touch before update on public.weigh_tickets for each row execute function app.touch_updated_at();
create trigger downtime_events_touch before update on public.downtime_events for each row execute function app.touch_updated_at();
create trigger generated_reports_touch before update on public.generated_reports for each row execute function app.touch_updated_at();
create trigger authorized_signers_touch before update on public.authorized_signers for each row execute function app.touch_updated_at();
create trigger company_seals_touch before update on public.company_seals for each row execute function app.touch_updated_at();
create trigger report_templates_touch before update on public.report_templates for each row execute function app.touch_updated_at();

create trigger audit_weigh_tickets after insert or update on public.weigh_tickets for each row execute function app.audit_trigger();
create trigger audit_cargo_adjustments after insert on public.cargo_adjustments for each row execute function app.audit_trigger();
create trigger audit_downtime_events after insert or update on public.downtime_events for each row execute function app.audit_trigger();
create trigger audit_downtime_categories after insert or update on public.downtime_categories for each row execute function app.audit_trigger();
create trigger audit_downtime_causes after insert or update on public.downtime_causes for each row execute function app.audit_trigger();
create trigger audit_report_versions after insert or update on public.report_versions for each row execute function app.audit_trigger();
create trigger audit_digital_signatures after insert on public.digital_signatures for each row execute function app.audit_trigger();
create trigger audit_authorized_signers after insert or update on public.authorized_signers for each row execute function app.audit_trigger();
create trigger audit_company_seals after insert or update on public.company_seals for each row execute function app.audit_trigger();
create trigger audit_correction_requests after insert or update on public.correction_requests for each row execute function app.audit_trigger();
create trigger audit_scale_visits after insert or update on public.scale_visits for each row execute function app.audit_trigger();

create trigger weigh_tickets_no_delete before delete on public.weigh_tickets for each row execute function app.prevent_delete();
create trigger cargo_movements_no_change before update or delete on public.cargo_movements for each row execute function app.prevent_delete();
create trigger ticket_reversals_no_change before update or delete on public.ticket_reversals for each row execute function app.prevent_delete();
create trigger cargo_adjustments_no_change before update or delete on public.cargo_adjustments for each row execute function app.prevent_delete();
create trigger downtime_events_no_delete before delete on public.downtime_events for each row execute function app.prevent_delete();
create trigger report_versions_no_delete before delete on public.report_versions for each row execute function app.prevent_delete();
create trigger digital_signatures_no_change before update or delete on public.digital_signatures for each row execute function app.prevent_delete();
create trigger correction_history_no_change before update or delete on public.correction_history for each row execute function app.prevent_delete();
create trigger approval_records_no_change before update or delete on public.approval_records for each row execute function app.prevent_delete();
create trigger scale_visits_no_delete before delete on public.scale_visits for each row execute function app.prevent_delete();
