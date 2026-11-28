import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, Building2, ClipboardCheck, FileText, History, LayoutDashboard, LogOut, Menu, PenTool, Scale, Settings, Ship, Timer, UserRound, Users, Weight, X, ListOrdered, Globe2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useAssetUrl } from '@/lib/assets';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NotificationsButton } from '@/components/Notifications';

type Item = { to: string; label: string; icon: typeof Ship; perms?: string[]; end?: boolean };
const NAV: { group: string; items: Item[] }[] = [
  { group: 'Operación', items: [
    { to: '/app', label: 'Dashboard', icon: LayoutDashboard, end: true, perms: ['services.view', 'weighing.register', 'customers.view'] },
    { to: '/app/servicios', label: 'Servicios', icon: Ship, perms: ['services.view', 'weighing.register'] },
    { to: '/app/pesaje', label: 'Registro de pesaje', icon: Weight, perms: ['weighing.register'] },
    { to: '/app/ciclos', label: 'Ciclos', icon: ListOrdered, perms: ['weighing.view_all', 'weighing.register'] },
    { to: '/app/tiempos-perdidos', label: 'Tiempos perdidos', icon: Timer, perms: ['downtime.register', 'services.view'] },
    { to: '/app/productividad', label: 'Productividad', icon: BarChart3, perms: ['productivity.view'] },
    { to: '/app/correcciones', label: 'Correcciones', icon: ClipboardCheck, perms: ['corrections.request', 'corrections.approve'] },
  ] },
  { group: 'Clientes y documentos', items: [
    { to: '/app/clientes', label: 'Cartera de clientes', icon: Building2, perms: ['customers.view'] },
    { to: '/app/reportes', label: 'Reportes', icon: FileText, perms: ['reports.view'] },
    { to: '/app/firmas', label: 'Firma y sello', icon: PenTool, perms: ['signatures.manage', 'reports.sign'] },
  ] },
  { group: 'Catálogos y control', items: [
    { to: '/app/basculas', label: 'Básculas', icon: Scale, perms: ['scales.manage', 'weighing.view_all'] },
    { to: '/app/usuarios', label: 'Usuarios y permisos', icon: Users, perms: ['users.manage'] },
    { to: '/app/auditoria', label: 'Auditoría', icon: History, perms: ['audit.view'] },
    { to: '/app/configuracion', label: 'Configuración', icon: Settings, perms: ['org.manage', 'downtime.manage', 'scales.manage'] },
  ] },
];

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(t); }, []);
  return (
    <div className="flex items-center gap-2.5 text-[13px]">
      <i className="h-2.5 w-2.5 flex-none rounded-full bg-[#5ee39a] animate-live" aria-hidden />
      <div>
        <div className="num text-[19px] font-semibold leading-none">{now.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        <div className="opacity-80">{now.toLocaleDateString('es-GT', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      </div>
    </div>
  );
}

export function AdminLayout() {
  const { ctx, membership, can, setOrgId, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const logo = useAssetUrl('org-assets', membership?.organization_logo);
  const pending = useQuery({
    queryKey: ['corrections-pending-count', membership?.organization_id], enabled: !!membership && can('corrections.approve'), refetchInterval: 60_000,
    queryFn: async () => (await supabase.from('correction_requests').select('id', { count: 'exact', head: true }).eq('organization_id', membership!.organization_id).eq('status', 'pending')).count ?? 0,
  });
  const signing = useQuery({
    queryKey: ['reports-pending-sign', membership?.organization_id], enabled: !!membership && can('reports.sign'), refetchInterval: 60_000,
    queryFn: async () => unwrap(await supabase.from('report_versions').select('id', { count: 'exact', head: true }).eq('organization_id', membership!.organization_id).eq('status', 'pending_signature')) as unknown as number,
  });

  if (!membership && !/\/app\/(plataforma|perfil)/.test(loc.pathname)) return <Navigate to="/app/plataforma" replace />;
  const badge = (to: string) => (to === '/app/correcciones' ? pending.data : undefined);

  const side = (
    <div className="flex h-full flex-col gap-5 overflow-y-auto bg-harbor px-3.5 py-5 text-white">
      <div className="flex items-center gap-2.5 px-1.5">
        <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden><rect width="32" height="32" rx="7" fill="#fff" /><path d="M5 18h22l-3 7H8z" fill="#0b4f71" /><rect x="9" y="12" width="4" height="6" fill="#1874a8" /><rect x="14" y="10" width="4" height="8" fill="#cf3b25" /><rect x="19" y="13" width="4" height="5" fill="#f0b400" /></svg>
        <div className="min-w-0"><b className="block font-cond text-[19px] leading-none">Vessel Control</b><span className="block truncate text-[13px] opacity-80">{membership?.organization_name ?? 'Plataforma'}</span></div>
      </div>
      {logo && <img src={logo} alt="" className="mx-1.5 max-h-12 w-auto self-start rounded bg-white/95 p-1.5" />}
      {(ctx?.memberships.length ?? 0) > 1 && (
        <label className="mx-1.5 grid gap-1 text-[12.5px] opacity-90">Empresa
          <select value={membership?.organization_id} onChange={(e) => setOrgId(e.target.value)} className="min-h-[38px] rounded-lg border border-white/30 bg-white/10 px-2 text-[14px] text-white [&>option]:text-ink">
            {ctx!.memberships.map((m) => <option key={m.organization_id} value={m.organization_id}>{m.organization_name}</option>)}
          </select>
        </label>
      )}
      <div className="px-1.5"><Clock /></div>
      <nav className="grid gap-4" aria-label="Principal">
        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.perms || i.perms.some(can));
          if (!items.length) return null;
          return (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-semibold uppercase tracking-wide opacity-60">{g.group}</div>
              <div className="grid gap-0.5">
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => clsx('press flex min-h-[40px] items-center gap-3 rounded-lg px-3 text-[14.5px] font-medium',
                    isActive ? 'bg-white text-harbor dark:text-[#0a3a57]' : 'text-white/90 hover:bg-white/10 hover:text-white')}>
                    <i.icon className="h-[18px] w-[18px] flex-none" aria-hidden />
                    <span className="flex-1 truncate">{i.label}</span>
                    {!!badge(i.to) && <span className="rounded-full bg-red px-1.5 text-[11.5px] font-bold text-white">{badge(i.to)}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
        {ctx?.is_platform_admin && (
          <NavLink to="/app/plataforma" className={({ isActive }) => clsx('press flex min-h-[40px] items-center gap-3 rounded-lg px-3 text-[14.5px] font-medium', isActive ? 'bg-white text-harbor' : 'text-white/90 hover:bg-white/10')}>
            <Globe2 className="h-[18px] w-[18px]" />Empresas (plataforma)
          </NavLink>
        )}
      </nav>
      <div className="mt-auto grid gap-2 border-t border-white/15 pt-4">
        <Link to="/app/perfil" className="press flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/10">
          <UserRound className="h-5 w-5 flex-none" />
          <span className="min-w-0"><b className="block truncate text-[14px]">{ctx?.profile?.full_name || ctx?.profile?.email}</b><span className="block truncate text-[12.5px] opacity-80">{membership?.role_name ?? 'Administrador de plataforma'}</span></span>
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle dark />
          <button onClick={signOut} className="press ml-auto inline-flex min-h-[36px] items-center gap-2 rounded-lg px-3 text-[13.5px] font-semibold hover:bg-white/10"><LogOut className="h-4 w-4" />Cerrar sesión</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh lg:block">{side}</aside>
      <header className="sticky top-0 z-40 flex items-center gap-3 bg-harbor px-4 py-2.5 text-white lg:hidden">
        <button onClick={() => setOpen(true)} className="press rounded-lg p-1.5 hover:bg-white/10" aria-label="Abrir menú"><Menu className="h-6 w-6" /></button>
        <b className="font-cond text-[18px]">Vessel Control</b>
        <div className="ml-auto flex items-center gap-1">
          {(can('reports.sign') && (signing.data ?? 0) > 0) && <Link to="/app/reportes" className="rounded-full bg-warn px-2 text-[12px] font-bold text-white">{signing.data} por firmar</Link>}
          <NotificationsButton light />
        </div>
      </header>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px] animate-slide-left">
            <button onClick={() => setOpen(false)} className="absolute right-2 top-2 z-10 rounded-lg p-1.5 text-white hover:bg-white/10" aria-label="Cerrar menú"><X className="h-5 w-5" /></button>
            {side}
          </div>
        </div>
      )}
      <main className="min-w-0 pb-16">
        <div className="hidden items-center justify-end gap-3 px-8 pt-4 lg:flex">
          {(can('reports.sign') && (signing.data ?? 0) > 0) && <Link to="/app/reportes?estado=pending_signature" className="inline-flex items-center gap-1.5 rounded-full bg-warnsoft px-3 py-1 text-[13px] font-semibold text-warn"><PenTool className="h-3.5 w-3.5" />{signing.data} informe(s) por firmar</Link>}
          <NotificationsButton />
        </div>
        <div className="mx-auto max-w-[1440px] px-4 py-5 md:px-8"><Outlet /></div>
      </main>
    </div>
  );
}

