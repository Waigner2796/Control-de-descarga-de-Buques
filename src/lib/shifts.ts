import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from './supabase';
import { addDays } from './format';

export type Shift = { id: string; name: string; start_time: string; end_time: string; sort: number; status: string; plan_id: string; terminal_id: string };
export type ShiftPlan = { id: string; terminal_id: string; name: string; is_default: boolean; status: string };

const hm = (t: string) => t.slice(0, 5);

/** Turno (y fecha en que inició) que contiene una hora local 'YYYY-MM-DDTHH:MM'. Maneja la medianoche. */
export function shiftAt(shifts: Shift[], local: string) {
  const t = local.slice(11, 16), day = local.slice(0, 10);
  for (const s of shifts) {
    const a = hm(s.start_time), b = hm(s.end_time);
    if (a < b ? t >= a && t < b : t >= a || t < b) return { shift: s, date: a < b || t >= a ? day : addDays(day, -1) };
  }
  return null;
}

/** «Turno 2 · 03/03 14:00–22:00» */
export function periodLabel(s: Pick<Shift, 'name' | 'start_time' | 'end_time'>, date: string) {
  const [, m, d] = date.split('-');
  return `${s.name} · ${d}/${m} ${hm(s.start_time)}–${hm(s.end_time)}`;
}

export const usePlanShifts = (planId: string | null | undefined) => useQuery({
  queryKey: ['plan-shifts', planId], enabled: !!planId,
  queryFn: async () => unwrap(await supabase.from('shifts').select('id, name, start_time, end_time, sort, status, plan_id, terminal_id').eq('plan_id', planId!).eq('status', 'active').order('sort')) as Shift[],
});

export const useShiftPlans = (orgId: string | null) => useQuery({
  queryKey: ['shift-plans', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('shift_plans').select('id, terminal_id, name, is_default, status').eq('organization_id', orgId!).order('name')) as ShiftPlan[],
});
