export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'mute' | 'portal';

export const SERVICE_STATUS: Record<string, { label: string; tone: Tone }> = {
  scheduled: { label: 'Programado', tone: 'info' },
  preparing: { label: 'En preparación', tone: 'info' },
  in_operation: { label: 'En operación', tone: 'ok' },
  suspended: { label: 'Suspendido', tone: 'warn' },
  closing: { label: 'En proceso de cierre', tone: 'warn' },
  finalized: { label: 'Finalizado', tone: 'mute' },
  cancelled: { label: 'Cancelado', tone: 'bad' },
};
export const SERVICE_FLOW: Record<string, string[]> = {
  scheduled: ['preparing', 'in_operation', 'cancelled'],
  preparing: ['scheduled', 'in_operation', 'cancelled'],
  in_operation: ['suspended', 'closing'],
  suspended: ['in_operation', 'closing', 'cancelled'],
  closing: ['in_operation', 'suspended'],
  finalized: [],
  cancelled: [],
};
export const REPORT_STATUS: Record<string, { label: string; tone: Tone }> = {
  generating: { label: 'Generando', tone: 'info' },
  pending_signature: { label: 'Pendiente de firma', tone: 'warn' },
  current: { label: 'Firmado y publicado', tone: 'ok' },
  revision_pending: { label: 'Nueva versión en curso', tone: 'warn' },
  failed: { label: 'Error de generación', tone: 'bad' },
};
export const VERSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_signature: { label: 'Pendiente de firma', tone: 'warn' },
  signed: { label: 'Vigente · firmado', tone: 'ok' },
  superseded: { label: 'Sustituido', tone: 'mute' },
  discarded: { label: 'Descartado', tone: 'mute' },
};
export const CORRECTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente', tone: 'warn' },
  applied: { label: 'Aplicada', tone: 'ok' },
  rejected: { label: 'Rechazada', tone: 'bad' },
  cancelled: { label: 'Cancelada', tone: 'mute' },
};
export const ACTIVE: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Activo', tone: 'ok' },
  inactive: { label: 'Inactivo', tone: 'mute' },
  maintenance: { label: 'Mantenimiento', tone: 'warn' },
  valid: { label: 'Válido', tone: 'ok' },
  voided: { label: 'Anulado', tone: 'bad' },
};
export const SCOPE: Record<string, string> = { operation: 'Toda la operación', hold: 'Bodega', scale: 'Báscula' };
export const TIME_MODE: Record<string, string> = { manual: 'Captura manual', server_now: 'Hora actual del servidor' };

export const FIELD_LABEL: Record<string, string> = {
  truck_plate: 'Matrícula del camión', tractor_plate: 'Matrícula TC', driver_name: 'Piloto', driver_dpi: 'DPI',
  gross_kg: 'Peso bruto (kg)', tare_kg: 'Tara (kg)', service_hold_id: 'Bodega', product_id: 'Producto', scale_id: 'Báscula',
  started_local: 'Hora de inicio', ended_local: 'Hora final', ticket_number: 'Número de ticket', nominal_capacity_tm: 'Capacidad nominal',
  notes: 'Notas', cause_id: 'Evento', scope: 'Alcance', observations: 'Observaciones', status: 'Estado',
};

export const PERMISSION_GROUPS = [
  'Configuración', 'Usuarios', 'Clientes', 'Buques', 'Servicios', 'Básculas', 'Tiempos perdidos', 'Correcciones', 'Productividad', 'Reportes', 'Auditoría',
];

export const AUDIT_TABLE: Record<string, string> = {
  organizations: 'Empresa', terminals: 'Terminal', organization_members: 'Usuario interno', terminal_members: 'Acceso a terminal',
  organization_settings: 'Configuración', terminal_settings: 'Configuración de terminal', operational_thresholds: 'Umbrales',
  customers: 'Cliente', customer_users: 'Usuario del portal', customer_portal_permissions: 'Permisos del portal', customer_documents: 'Documento',
  vessels: 'Buque', products: 'Producto', services: 'Servicio', service_holds: 'Bodega del servicio', service_hold_cargo: 'Carga por bodega',
  service_scales: 'Báscula del servicio', scales: 'Báscula', scale_settings: 'Configuración de báscula', scale_users: 'Operador de báscula',
  shifts: 'Turno', weigh_tickets: 'Pesaje', cargo_adjustments: 'Ajuste de tonelaje', downtime_events: 'Tiempo perdido',
  downtime_categories: 'Categoría de tiempo perdido', downtime_causes: 'Evento del catálogo', report_versions: 'Versión de reporte',
  digital_signatures: 'Firma', authorized_signers: 'Firmante', company_seals: 'Sello', correction_requests: 'Corrección', scale_visits: 'Visita de báscula',
};
export const AUDIT_ACTION: Record<string, string> = { INSERT: 'Creación', UPDATE: 'Modificación', DELETE: 'Eliminación' };
