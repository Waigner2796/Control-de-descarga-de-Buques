import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { FileText, FolderOpen, LayoutDashboard, LogOut, Menu, Ship, UserRound, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAssetUrl } from '@/lib/assets';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NotificationsButton } from '@/components/Notifications';

/** Portal del cliente: identidad propia (navegación superior, acento teal) y sin herramientas administrativas. */
export function PortalLayout() {
  const { ctx, customerLink, setCustomerId, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const custLogo = useAssetUrl('org-assets', customerLink?.customer_logo);
  const orgLogo = useAssetUrl('org-assets', customerLink?.organization_logo);
  const items = [
    { to: '/portal', label: 'Mi dashboard', icon: LayoutDashboard, end: true, show: true },
    { to: '/portal/servicios', label: 'Mis servicios', icon: Ship, show: true },
    { to: '/portal/reportes', label: 'Mis reportes', icon: FileText, show: !!customerLink?.can_view_reports },
    { to: '/portal/documentos', label: 'Mis documentos', icon: FolderOpen, show: !!customerLink?.can_view_documents },
    { to: '/portal/perfil', label: 'Mi perfil', icon: UserRound, show: true },
  ].filter((i) => i.show);
  const link = (i: (typeof items)[number]) => (
    <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => clsx('press inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-[14.5px] font-semibold',
      isActive ? 'bg-portalsoft text-portal' : 'text-mute hover:bg-panel hover:text-ink')}>
      <i.icon className="h-4 w-4" />{i.label}
    </NavLink>
  );
  return (
    <div className="min-h-full bg-panel/40">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1240px] items-center gap-4 px-4 py-3 md:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {custLogo ? <img src={custLogo} alt="" className="h-9 w-auto max-w-[120px] object-contain" /> : (
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-portal font-cond text-[17px] font-bold text-white">{customerLink?.customer_name?.slice(0, 1)}</span>
            )}
            <div className="min-w-0">
              <b className="block truncate font-cond text-[18px] leading-tight">{customerLink?.customer_name}</b>
              <span className="block truncate text-[12.5px] text-mute">Portal de clientes · {customerLink?.organization_name}</span>
            </div>
          </div>
          <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Portal">{items.map(link)}</nav>
          <div className="ml-auto flex items-center gap-1">
            {(ctx?.customer_links.length ?? 0) > 1 && (
              <select aria-label="Cliente" value={customerLink?.customer_id} onChange={(e) => setCustomerId(e.target.value)} className="field hidden min-h-[36px] w-auto py-1 md:block">
                {ctx!.customer_links.map((c) => <option key={c.customer_id} value={c.customer_id}>{c.customer_name}</option>)}
              </select>
            )}
            <NotificationsButton portal />
            <button onClick={signOut} className="press hidden items-center gap-1.5 rounded-lg px-3 py-2 text-[13.5px] font-semibold text-mute hover:bg-panel hover:text-ink md:inline-flex"><LogOut className="h-4 w-4" />Salir</button>
            <button onClick={() => setOpen((v) => !v)} className="press rounded-lg p-2 hover:bg-panel lg:hidden" aria-label="Menú">{open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}</button>
          </div>
        </div>
        {open && (
          <nav className="grid gap-1 border-t border-line px-4 py-3 lg:hidden animate-fade-up" aria-label="Portal móvil">
            {items.map(link)}
            <button onClick={signOut} className="press inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3 text-[14.5px] font-semibold text-mute hover:bg-panel"><LogOut className="h-4 w-4" />Cerrar sesión</button>
          </nav>
        )}
      </header>
      <main className="mx-auto max-w-[1240px] px-4 py-6 md:px-6"><Outlet /></main>
      <footer className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-5 text-[13px] text-mute md:px-6">
        <span className="flex items-center gap-2">{orgLogo && <img src={orgLogo} alt="" className="h-6 w-auto" />}Servicio prestado por {customerLink?.organization_name}</span>
        <ThemeToggle />
      </footer>
    </div>
  );
}
