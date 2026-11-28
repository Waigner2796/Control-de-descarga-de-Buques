import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from './supabase';

/** Estado de filtros, orden y página en la URL (se conserva al paginar y al recargar). */
export function useUrlState<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams();
  const state = useMemo(() => {
    const o = { ...defaults } as Record<string, string>;
    for (const k of Object.keys(defaults)) { const v = sp.get(k); if (v != null) o[k] = v; }
    return o as T;
  }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = useCallback((patch: Partial<T>, resetPage = true) => {
    setSp((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === '' || v === defaults[k]) next.delete(k); else next.set(k, String(v));
      }
      if (resetPage && !('page' in patch)) next.delete('page');
      return next;
    }, { replace: true });
  }, [setSp]); // eslint-disable-line react-hooks/exhaustive-deps
  return [state, set] as const;
}

/** Invalida consultas cuando cambian filas (Supabase Realtime respeta RLS del suscriptor). */
export function useRealtime(table: string, filter: string | null, keys: unknown[][], enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const ch = supabase.channel(`rt:${table}:${filter ?? 'all'}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, () => {
        keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [table, filter, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}

export type Terminal = { id: string; code: string; name: string; timezone: string; status: string; port_name: string | null; address: string | null };
export const useTerminals = (orgId: string | null) => useQuery({
  queryKey: ['terminals', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('terminals').select('id, code, name, timezone, status, port_name, address').eq('organization_id', orgId!).order('name')) as Terminal[],
});
export type Option = { id: string; name: string };
export const useCustomersLite = (orgId: string | null) => useQuery({
  queryKey: ['customers-lite', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('customers').select('id, code, trade_name, status').eq('organization_id', orgId!).order('trade_name')) as { id: string; code: string; trade_name: string; status: string }[],
});
export type Vessel = { id: string; name: string; imo_number: string | null; vessel_type: string; flag: string | null; capacity_tm: number | null; holds_count: number; notes: string | null; status: string };
export const useVessels = (orgId: string | null) => useQuery({
  queryKey: ['vessels', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('vessels').select('*').eq('organization_id', orgId!).order('name')) as Vessel[],
});
export type Product = { id: string; code: string | null; name: string; color: string; description: string | null; status: string };
export const useProducts = (orgId: string | null) => useQuery({
  queryKey: ['products', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('products').select('*').eq('organization_id', orgId!).order('name')) as Product[],
});
export type Scale = { id: string; terminal_id: string; code: string; name: string; location: string | null; status: string };
export const useScales = (orgId: string | null) => useQuery({
  queryKey: ['scales', orgId], enabled: !!orgId,
  queryFn: async () => unwrap(await supabase.from('scales').select('id, terminal_id, code, name, location, status').eq('organization_id', orgId!).order('code')) as Scale[],
});
export type ServiceLite = { id: string; service_number: string; status: string; vessel_name: string; customer_name: string; terminal_id: string; timezone: string; customer_id: string; vessel_id: string };
export const useServicesLite = (orgId: string | null, statuses?: string[]) => useQuery({
  queryKey: ['services-lite', orgId, statuses?.join(',')], enabled: !!orgId,
  queryFn: async () => {
    let q = supabase.from('service_overview').select('id, service_number, status, vessel_name, customer_name, terminal_id, timezone, customer_id, vessel_id').eq('organization_id', orgId!).order('created_at', { ascending: false }).limit(500);
    if (statuses?.length) q = q.in('status', statuses);
    return unwrap(await q) as ServiceLite[];
  },
});
export type Member = { id: string; user_id: string; role_code: string; status: string; all_terminals: boolean; extra_permissions: string[]; position: string | null; created_at: string; profile?: { full_name: string; email: string } };
export const useMembers = (orgId: string | null) => useQuery({
  queryKey: ['members', orgId], enabled: !!orgId,
  queryFn: async () => {
    const m = unwrap(await supabase.from('organization_members').select('id, user_id, role_code, status, all_terminals, extra_permissions, position, created_at').eq('organization_id', orgId!)) as Member[];
    const ids = m.map((x) => x.user_id);
    const p = ids.length ? unwrap(await supabase.from('user_profiles').select('user_id, full_name, email').in('user_id', ids)) as { user_id: string; full_name: string; email: string }[] : [];
    return m.map((x) => ({ ...x, profile: p.find((y) => y.user_id === x.user_id) })).sort((a, b) => (a.profile?.full_name ?? '').localeCompare(b.profile?.full_name ?? ''));
  },
});
