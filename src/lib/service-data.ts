import { useQuery } from '@tanstack/react-query';
import { rpc, supabase, unwrap } from './supabase';
import { useRealtime } from './hooks';
import type { ShipHold } from '@/components/ShipView';

export type CargoLine = { id: string; service_hold_id: string; product_id: string; initial_tm: number; discharged_tm: number; notes: string | null; product: { name: string; color: string } };
export type HoldRow = { id: string; hold_number: number; vessel_id: string; capacity_tm: number | null; vessel: { name: string } };
export type ServiceProduct = { id: string; product_id: string; bag_weight_kg: number | null; bag_tare_kg: number | null; uses_bl: boolean; sort: number; product: { name: string; color: string } };
export type BlRow = { id: string; product_id: string; service_product_id: string; bl_number: string; planned_tm: number; discharged_tm: number; status: 'open' | 'completed'; sort: number; completed_at: string | null };

/** Unidades (sacos) equivalentes a un tonelaje según el peso por saco. */
export const toUnits = (tmValue: number, bagKg: number | null | undefined) => (bagKg && bagKg > 0 ? (Number(tmValue) * 1000) / bagKg : null);

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
  const productsQ = useQuery({
    queryKey: ['service-products', serviceId], enabled: !!serviceId,
    queryFn: async () => unwrap(await supabase.from('service_products').select('id, product_id, bag_weight_kg, bag_tare_kg, uses_bl, sort, product:products(name, color)').eq('service_id', serviceId!).order('sort')) as unknown as ServiceProduct[],
  });
  const blsQ = useQuery({
    queryKey: ['service-bls', serviceId], enabled: !!serviceId,
    queryFn: async () => unwrap(await supabase.from('service_bls').select('id, product_id, service_product_id, bl_number, planned_tm, discharged_tm, status, sort, completed_at').eq('service_id', serviceId!).order('sort').order('bl_number')) as unknown as BlRow[],
  });
  useRealtime('service_hold_cargo', serviceId ? `service_id=eq.${serviceId}` : null, [['service-cargo', serviceId], ['service-kpis', serviceId]], !!serviceId);
  useRealtime('service_bls', serviceId ? `service_id=eq.${serviceId}` : null, [['service-bls', serviceId]], !!serviceId);
  const holds = holdsQ.data ?? [];
  const cargo = cargoQ.data ?? [];
  const products = productsQ.data ?? [];
  const bls = blsQ.data ?? [];
  const ship: ShipHold[] = holds.map((h) => ({
    id: h.id, hold_number: h.hold_number,
    products: cargo.filter((c) => c.service_hold_id === h.id).map((c) => ({
      cargo_id: c.id, name: c.product?.name ?? '', color: c.product?.color ?? '#1874a8', initial_tm: Number(c.initial_tm), pending_tm: Number(c.initial_tm) - Number(c.discharged_tm),
      bag_weight_kg: products.find((p) => p.product_id === c.product_id)?.bag_weight_kg ?? null,
    })),
  }));
  const initial = cargo.reduce((a, c) => a + Number(c.initial_tm), 0);
  const discharged = cargo.reduce((a, c) => a + Number(c.discharged_tm), 0);
  const bagOf = (productId: string) => products.find((p) => p.product_id === productId)?.bag_weight_kg ?? null;
  return { holds, cargo, ship, products, bls, bagOf, initial, discharged, pending: initial - discharged, loading: holdsQ.isLoading || cargoQ.isLoading,
    refetch: () => { holdsQ.refetch(); cargoQ.refetch(); productsQ.refetch(); blsQ.refetch(); } };
}

export type ShiftPeriod = { n: number; shift_id: string; shift_name: string | null; from: string; to: string; holds: { hold_number: number; tm: number; bags: number | null }[];
  tm: number; bags: number | null; cum_tm: number; cum_bags: number; damaged: { dirty: number; broken: number; wet: number; to_sea: number; total: number; notes: string | null } | null };

export type Kpis = {
  totals: { initial_tm: number; discharged_tm: number; pending_tm: number; progress_pct: number; initial_kg: number; discharged_kg: number; initial_units: number | null; discharged_units: number | null };
  cargo_type: 'bulk' | 'bags'; distinct_trucks: number; cycles_count: number;
  operation_kind: 'discharge' | 'load'; bags_in_range?: number; damaged_bags?: number;
  shift_periods: ShiftPeriod[];
  bag_samples: { count: number; avg_gross_kg: number | null; avg_net_kg: number | null; avg_temp_c: number | null; min_net_kg: number | null; max_net_kg: number | null; target_net_kg: number | null };
  by_bl: { bl_id: string; bl_number: string; product_id: string; product: string; color: string; planned_tm: number; discharged_tm: number; pending_tm: number; status: string; progress_pct: number; bag_weight_kg: number | null; planned_units: number | null; discharged_units: number | null; trucks: number }[];
  trucks: number; tons_in_range: number; avg_tm_per_truck: number | null; avg_cycle_minutes: number | null; window_hours: number | null; tph: number | null;
  downtime_minutes_reported: number; downtime_events: number; downtime_operation_minutes: number; effective_hours: number | null; tph_effective: number | null;
  trucks_per_hour: number | null; service_hours: number | null; timezone: string;
  by_scale: { scale_id: string; code: string; name: string; trucks: number; tons: number; avg_cycle_minutes: number | null; avg_tm_per_truck: number | null; tph: number | null; downtime_minutes: number }[];
  by_hold: { service_hold_id: string; hold_number: number; vessel_name: string; initial_tm: number; discharged_tm: number; pending_tm: number; trucks: number; tons: number; downtime_minutes: number; products: { cargo_id: string; name: string; color: string; initial_tm: number; discharged_tm: number; pending_tm: number }[] }[];
  by_product: { product_id: string; name: string; color: string; bag_weight_kg: number | null; uses_bl: boolean; initial_tm: number; discharged_tm: number; pending_tm: number; initial_units: number | null; discharged_units: number | null; trucks: number; tons: number }[];
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
