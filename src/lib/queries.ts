import { supabase } from './supabase';
import { addDays, localDayStartIso } from './format';

export type CycleFilters = { service?: string; vessel?: string; hold?: string; product?: string; scale?: string; shift?: string; plate?: string; ticket?: string; from?: string; to?: string; status?: string; customer?: string };
export type CycleRow = {
  id: string; service_id: string; service_number: string; vessel_name: string; customer_name: string; ticket_number: string; truck_plate: string; tractor_plate: string | null;
  driver_name: string; driver_dpi: string; nominal_capacity_tm: number | null; gross_kg: number; tare_kg: number; net_kg: number; net_tm: number; started_at: string; ended_at: string;
  cycle_minutes: number; time_capture_mode: string; operation_date: string; shift_name: string | null; status: string; revision: number; scale_id: string; scale_name: string;
  service_hold_id: string; hold_number: number; product_id: string; product_name: string; product_color: string; registered_by_name: string | null; notes: string | null; terminal_id: string;
};
export const CYCLE_COLS = 'id, service_id, service_number, vessel_name, customer_name, ticket_number, truck_plate, tractor_plate, driver_name, driver_dpi, nominal_capacity_tm, gross_kg, tare_kg, net_kg, net_tm, started_at, ended_at, cycle_minutes, time_capture_mode, operation_date, shift_name, status, revision, scale_id, scale_name, service_hold_id, hold_number, product_id, product_name, product_color, registered_by_name, notes, terminal_id';

const clean = (s: string) => s.replace(/[%_,()]/g, '').trim();

/** Consulta de ciclos con filtros aplicados en el servidor (índices en weigh_tickets). */
export function cyclesQuery(orgId: string, f: CycleFilters, tz: string, count = true) {
  let q = supabase.from('operational_cycles').select(CYCLE_COLS, count ? { count: 'exact' } : undefined).eq('organization_id', orgId);
  if (f.service) q = q.eq('service_id', f.service);
  if (f.customer) q = q.eq('customer_id', f.customer);
  if (f.vessel) q = q.eq('vessel_id', f.vessel);
  if (f.hold) q = q.eq('service_hold_id', f.hold);
  if (f.product) q = q.eq('product_id', f.product);
  if (f.scale) q = q.eq('scale_id', f.scale);
  if (f.shift) q = q.eq('shift_id', f.shift);
  if (f.status) q = q.eq('status', f.status);
  if (f.plate && clean(f.plate)) q = q.ilike('truck_plate', `%${clean(f.plate)}%`);
  if (f.ticket && clean(f.ticket)) q = q.ilike('ticket_number', `%${clean(f.ticket)}%`);
  if (f.from) q = q.gte('started_at', localDayStartIso(f.from, tz));
  if (f.to) q = q.lt('started_at', localDayStartIso(addDays(f.to, 1), tz));
  return q;
}

/** Descarga todas las filas en lotes (para exportaciones que respetan los filtros). */
export async function fetchAll<T>(build: () => ReturnType<typeof cyclesQuery> | any, order: { col: string; asc: boolean }[], batch = 1000, max = 100_000): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let from = 0; from < max; from += batch) {
    let q = build();
    for (const o of order) q = q.order(o.col, { ascending: o.asc });
    const { data, error } = await q.range(from, from + batch - 1);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if (!data || data.length < batch) break;
  }
  return out;
}

export type DowntimeRow = {
  id: string; service_id: string; service_number: string; vessel_name: string; customer_name: string; cause_id: string; cause_name: string; category_name: string; category_color: string;
  started_at: string; ended_at: string; duration_minutes: number; duration_hours: number; scope: string; service_hold_id: string | null; hold_number: number | null; scale_id: string | null; scale_name: string | null;
  observations: string | null; operation_date: string; shift_name: string | null; status: string; revision: number; reported_by_name: string | null; terminal_id: string;
};
export const DOWNTIME_COLS = 'id, service_id, service_number, vessel_name, customer_name, cause_id, cause_name, category_name, category_color, started_at, ended_at, duration_minutes, duration_hours, scope, service_hold_id, hold_number, scale_id, scale_name, observations, operation_date, shift_name, status, revision, reported_by_name, terminal_id';
