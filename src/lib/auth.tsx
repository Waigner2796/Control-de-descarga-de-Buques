import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, supabase } from './supabase';

export type Membership = {
  organization_id: string; organization_name: string; organization_logo: string | null;
  role_code: string; role_name: string; all_terminals: boolean; permissions: string[]; terminal_ids: string[]; scale_ids: string[];
};
export type CustomerLink = {
  customer_user_id: string; customer_id: string; customer_name: string; customer_logo: string | null;
  organization_id: string; organization_name: string; organization_logo: string | null;
  can_view_reports: boolean; can_download_reports: boolean; can_view_documents: boolean; can_view_productivity: boolean;
};
export type MyContext = {
  user_id: string;
  profile: { user_id: string; full_name: string; email: string; phone: string | null; position: string | null; kind: string; status: string; must_change_password: boolean } | null;
  is_platform_admin: boolean;
  memberships: Membership[];
  customer_links: CustomerLink[];
};

type AuthValue = {
  session: Session | null;
  ready: boolean;
  ctx: MyContext | null;
  ctxLoading: boolean;
  recovering: boolean;
  setRecovering: (v: boolean) => void;
  orgId: string | null;
  setOrgId: (id: string) => void;
  membership: Membership | null;
  customerLink: CustomerLink | null;
  setCustomerId: (id: string) => void;
  can: (perm: string) => boolean;
  refresh: () => Promise<unknown>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthValue | null>(null);
const ORG_KEY = 'vc.org';
const CUST_KEY = 'vc.customer';
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* almacenamiento no disponible */ } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [orgId, setOrgIdState] = useState<string | null>(read(ORG_KEY));
  const [customerId, setCustomerIdState] = useState<string | null>(read(CUST_KEY));

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true);
      setSession(s);
      if (event === 'SIGNED_OUT') qc.clear();
    });
    return () => sub.subscription.unsubscribe();
  }, [qc]);

  const uid = session?.user.id ?? null;
  const ctxQ = useQuery({
    queryKey: ['my_context', uid],
    queryFn: () => rpc<MyContext>('my_context'),
    enabled: !!uid,
    staleTime: 60_000,
  });
  const ctx = ctxQ.data ?? null;

  const membership = useMemo(() => {
    if (!ctx?.memberships.length) return null;
    return ctx.memberships.find((m) => m.organization_id === orgId) ?? ctx.memberships[0];
  }, [ctx, orgId]);
  const customerLink = useMemo(() => {
    if (!ctx?.customer_links.length) return null;
    return ctx.customer_links.find((c) => c.customer_id === customerId) ?? ctx.customer_links[0];
  }, [ctx, customerId]);

  const setOrgId = useCallback((id: string) => { setOrgIdState(id); write(ORG_KEY, id); qc.invalidateQueries(); }, [qc]);
  const setCustomerId = useCallback((id: string) => { setCustomerIdState(id); write(CUST_KEY, id); qc.invalidateQueries(); }, [qc]);
  const can = useCallback((perm: string) => !!membership?.permissions.includes(perm), [membership]);
  const signOut = useCallback(async () => { await supabase.auth.signOut(); qc.clear(); }, [qc]);

  const value: AuthValue = {
    session, ready, ctx, ctxLoading: !!uid && ctxQ.isLoading, recovering, setRecovering,
    orgId: membership?.organization_id ?? null, setOrgId, membership, customerLink, setCustomerId, can,
    refresh: () => ctxQ.refetch(), signOut,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fuera de AuthProvider');
  return v;
}

/** Organización activa (para personal interno). */
export function useOrg() {
  const { orgId, membership } = useAuth();
  return { orgId: orgId!, membership: membership! };
}
