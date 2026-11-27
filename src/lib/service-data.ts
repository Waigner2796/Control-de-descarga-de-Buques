import { useQuery } from '@tanstack/react-query';
import { rpc, supabase, unwrap } from './supabase';
import { useRealtime } from './hooks';
import type { ShipHold } from '@/components/ShipView';

export type CargoLine = { id: string; service_hold_id: string; product_id: string; initial_tm: number; discharged_tm: number; notes: string | null; product: { name: string; color: string } };
export type HoldRow = { id: string; hold_number: number; vessel_id: string; capacity_tm: number | null; vessel: { name: string } };

/** Bodegas y saldos del servicio, actualizados en tiempo real por cada pesaje. */
export function useServiceCargo(serviceId: string | null | undefined) {
  const holdsQ = useQuery({
    queryKey: ['service-holds', serviceId], enabled: !!serviceId,
    queryFn: async () => unwrap(await supabase.from('service_holds').select('id, hold_number, vessel_id, capacity_tm, vessel:vessels(name)').eq('service_id', serviceId!).order('hold_number')) as unknown as HoldRow[],
  });
  const cargoQ = useQuery({
    queryKey: ['service-cargo', serviceId], enabled: !!serviceId,
    queryFn: async () => unwrap(await supabase.from('service_hold_cargo').select('id, service_hold_id, product_id, initial_tm, discharged_tm, notes, product:products(name, color)').eq('service_id', serviceId!)) as unknown as CargoLine[],
  });
  useRealtime('service_hold_cargo', serviceId ? `service_id=eq.${serviceId}` : null, [['service-cargo', serviceId], ['service-kpis', serviceId]], !!serviceId);
  const holds = holdsQ.data ?? [];
  const cargo = cargoQ.data ?? [];
  const ship: ShipHold[] = holds.map((h) => ({
    id: h.id, hold_number: h.hold_number,
    products: cargo.filter((c) => c.service_hold_id === h.id).map((c) => ({
      cargo_id: c.id, name: c.product?.name ?? '', color: c.product?.color ?? '#1874a8', initial_tm: Number(c.initial_tm), pending_tm: Number(c.initial_tm) - Number(c.discharged_tm),
    })),
  }));
  const initial = cargo.reduce((a, c) => a + Number(c.initial_tm), 0);
  const discharged = cargo.reduce((a, c) => a + Number(c.discharged_tm), 0);
  return { holds, cargo, ship, initial, discharged, pending: initial - discharged, loading: holdsQ.isLoading || cargoQ.isLoading, refetch: () => { holdsQ.refetch(); cargoQ.refetch(); } };
}

export type Kpis = {
  totals: { initial_tm: number; discharged_tm: number; pending_tm: number; progress_pct: number };
  trucks: number; tons_in_range: number; avg_tm_per_truck: number | null; avg_cycle_minutes: number | null; window_hours: number | null; tph: number | null;
  downtime_minutes_reported: number; downtime_events: number; downtime_operation_minutes: number; effective_hours: number | null; tph_effective: number | null;
  trucks_per_hour: number | null; service_hours: number | null; timezone: string;
  by_scale: { scale_id: string; code: string; name: string; trucks: number; tons: number; avg_cycle_minutes: number | null; avg_tm_per_truck: number | null; tph: number | null; downtime_minutes: number }[];
  by_hold: { service_hold_id: string; hold_number: number; vessel_name: string; initial_tm: number; discharged_tm: number; pending_tm: number; trucks: number; tons: number; downtime_minutes: number; products: { cargo_id: string; name: string; color: string; initial_tm: number; discharged_tm: number; pending_tm: number }[] }[];
  by_product: { product_id: string; name: string; color: string; initial_tm: number; discharged_tm: number; pending_tm: number; trucks: number; tons: number }[];
  hourly: { hour: string; tons: number; trucks: number; cum_tons: number }[];
  hourly_by_scale: { hour: string; scale_id: string; tons: number; trucks: number }[];
  daily: { date: string; tons: number; trucks: number }[];
  by_shift: { shift: string; tons: number; trucks: number }[];
  downtime_by_cause: { cause: string; category: string; color: string; minutes: number; events: number; pct: number; cum_pct: number }[];
};

export function useServiceKpis(serviceId: string | null | undefined, from?: string | null, to?: string | null) {
  return useQuery({
    queryKey: ['service-kpis', serviceId, from ?? null, to ?? null], enabled: !!serviceId,
    queryFn: () => rpc<Kpis>('service_kpis', { p_service: serviceId, p_from: from || null, p_to: to || null }),
    refetchInterval: 60_000,
  });
}

/** Etiqueta de hora local 'YYYY-MM-DDTHH:00:00' → '14:00' o 'dd/mm 14:00'. */
export function hourLabel(h: string, withDay = false) {
  const [d, t] = h.split('T');
  const hh = (t ?? '').slice(0, 5);
  if (!withDay) return hh;
  const [, m, dd] = d.split('-');
  return `${dd}/${m} ${hh}`;
}
