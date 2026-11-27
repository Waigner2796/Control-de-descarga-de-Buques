import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';

export type PortalService = { id: string; service_number: string; status: string; vessel_name: string; imo_number: string | null; terminal_name: string; timezone: string; products: string; holds_count: number;
  initial_tm: number; discharged_tm: number; pending_tm: number; progress_pct: number; planned_start: string | null; estimated_end: string | null; actual_start: string | null; finalized_at: string | null; observations: string | null; report_status: string | null; operation_kind: 'discharge' | 'load'; cargo_type: 'bulk' | 'bags' };
export const PS_COLS = 'id, service_number, status, vessel_name, imo_number, terminal_name, timezone, products, holds_count, initial_tm, discharged_tm, pending_tm, progress_pct, planned_start, estimated_end, actual_start, finalized_at, observations, report_status, operation_kind, cargo_type';

export type PortalReport = { id: string; service_id: string; service_number: string; vessel_name: string; version: number; status: string; signed_at: string | null; signer_name: string | null; signer_position: string | null; storage_path: string | null; verification_code: string; sha256: string | null; superseded_at: string | null; supersede_reason: string | null; operation_date: string | null; published_at: string | null };
export const PR_COLS = 'id, service_id, service_number, vessel_name, version, status, signed_at, signer_name, signer_position, storage_path, verification_code, sha256, superseded_at, supersede_reason, operation_date, published_at';

/** Servicios del cliente seleccionado (RLS ya limita a sus propios servicios). */
export function usePortalServices() {
  const { customerLink } = useAuth();
  const cid = customerLink?.customer_id;
  return useQuery({ queryKey: ['portal-services', cid], enabled: !!cid, queryFn: async () => unwrap(await supabase.from('service_overview').select(PS_COLS).eq('customer_id', cid!).neq('status', 'cancelled').order('created_at', { ascending: false })) as PortalService[] });
}
export function usePortalReports(serviceId?: string) {
  const { customerLink } = useAuth();
  const cid = customerLink?.customer_id;
  return useQuery({
    queryKey: ['portal-reports', cid, serviceId], enabled: !!cid && !!customerLink?.can_view_reports,
    queryFn: async () => { let q = supabase.from('report_overview').select(PR_COLS).eq('customer_id', cid!); if (serviceId) q = q.eq('service_id', serviceId); return unwrap(await q.order('published_at', { ascending: false })) as PortalReport[]; },
  });
}
