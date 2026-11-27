import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Ship } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { rpc, supabase, unwrap } from '@/lib/supabase';
import { useCustomersLite, useProducts, useRealtime, useScales, useServicesLite, useTerminals, useUrlState, useVessels } from '@/lib/hooks';
import { hourLabel, useServiceCargo, useServiceKpis } from '@/lib/service-data';
import { DEFAULT_TZ, ago, fmt0, fmt1, fmt2, localDayStartIso, localDateInput, addDays, minutes, pct, time } from '@/lib/format';
import { SERVICE_STATUS } from '@/lib/labels';
import { ShipView } from '@/components/ShipView';
import { HoldDrawer } from '@/components/HoldDrawer';
import { ChartFrame, Columns } from '@/components/charts';
import { Badge, Button, EmptyState, FilterBar, Input, Kpi, Meter, PageHeader, Section, Select, StatusBadge } from '@/components/ui';

type Summary = Record<string, number | null>;
type Active = { id: string; service_number: string; status: string; vessel_name: string; customer_name: string; terminal_name: string; timezone: string; progress_pct: number; pending_tm: number; initial_tm: number; actual_start: string | null; estimated_end: string | null };

export default function Dashboard() {
  const { orgId, membership } = useOrg();
  const { can } = useAuth();
  const [f, setF] = useUrlState({ terminal: '', customer: '', vessel: '', service: '', product: '', from: '', to: '', sel: '' });
  const terminals = useTerminals(orgId);
  const customers = useCustomersLite(orgId);
  const vessels = useVessels(orgId);
  const products = useProducts(orgId);
  const services = useServicesLite(orgId);
  const scales = useScales(orgId);
  const tz = terminals.data?.find((t) => t.id === f.terminal)?.timezone ?? terminals.data?.[0]?.timezone ?? DEFAULT_TZ;
  const fromIso = f.from ? localDayStartIso(f.from, tz) : null;
  const toIso = f.to ? localDayStartIso(addDays(f.to, 1), tz) : null;

  const summary = useQuery({
    queryKey: ['dashboard', orgId, f.terminal, f.customer, f.vessel, f.service, f.product, fromIso, toIso],
    queryFn: () => rpc<Summary>('dashboard_summary', { p: { organization_id: orgId, terminal_id: f.terminal, customer_id: f.customer, vessel_id: f.vessel, service_id: f.service, product_id: f.product, from: fromIso, to: toIso } }),
    refetchInterval: 60_000,
  });
  const active = useQuery({
    queryKey: ['dashboard-active', orgId, f.terminal, f.customer, f.vessel],
    queryFn: async () => {
      let q = supabase.from('service_overview').select('id, service_number, status, vessel_name, customer_name, terminal_name, timezone, progress_pct, pending_tm, initial_tm, actual_start, estimated_end')
        .eq('organization_id', orgId).in('status', ['in_operation', 'suspended', 'closing', 'preparing']).order('status');
      if (f.terminal) q = q.eq('terminal_id', f.terminal);
      if (f.customer) q = q.eq('customer_id', f.customer);
      if (f.vessel) q = q.eq('vessel_id', f.vessel);
      return unwrap(await q) as Active[];
    },
  });
  const order: Record<string, number> = { in_operation: 0, closing: 1, suspended: 2, preparing: 3 };
  const list = useMemo(() => [...(active.data ?? [])].sort((a, b) => order[a.status] - order[b.status]), [active.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const selId = f.sel && list.some((s) => s.id === f.sel) ? f.sel : list[0]?.id ?? null;
  const sel = list.find((s) => s.id === selId) ?? null;
  const stz = sel?.timezone ?? tz;
  const cargo = useServiceCargo(selId);
  const last12 = useMemo(() => new Date(Date.now() - 12 * 3600e3).toISOString(), [selId]); // eslint-disable-line react-hooks/exhaustive-deps
  const kpis = useServiceKpis(selId, last12, null);
  const [holdId, setHoldId] = useState<string | null>(null);

  const feed = useQuery({
    queryKey: ['dashboard-feed', orgId, f.terminal],
    queryFn: async () => {
      let q = supabase.from('operational_cycles').select('id, ticket_number, truck_plate, scale_name, vessel_name, hold_number, product_name, net_tm, ended_at, service_id').eq('organization_id', orgId).eq('status', 'valid').order('ended_at', { ascending: false }).limit(8);
      if (f.terminal) q = q.eq('terminal_id', f.terminal);
      return unwrap(await q) as { id: string; ticket_number: string; truck_plate: string; scale_name: string; vessel_name: string; hold_number: number; product_name: string; net_tm: number; ended_at: string }[];
    },
  });
  const today = useQuery({
    queryKey: ['dashboard-scales-today', orgId],
    queryFn: async () => unwrap(await supabase.from('weigh_tickets').select('scale_id, net_tm, ended_at').eq('organization_id', orgId).eq('status', 'valid').gte('ended_at', localDayStartIso(localDateInput(new Date(), tz), tz)).limit(5000)) as { scale_id: string; net_tm: number; ended_at: string }[],
  });
  useRealtime('weigh_tickets', `organization_id=eq.${orgId}`, [['dashboard'], ['dashboard-feed'], ['dashboard-scales-today'], ['dashboard-active']]);

  const s = summary.data ?? {};
  const hourly = (kpis.data?.hourly ?? []).map((h) => ({ hora: hourLabel(h.hour), tons: Number(h.tons) }));
  const tph3 = Number(s.tph_last_3h ?? 0);
  const eta = sel && tph3 > 0 && sel.status === 'in_operation' ? new Date(Date.now() + (Number(sel.pending_tm) / tph3) * 3600e3) : null;
  const holdRow = cargo.holds.find((h) => h.id === holdId) ?? null;

  return (
    <div>
      <PageHeader title="Dashboard" sub={`${membership.organization_name} · operación en tiempo real`}
        actions={<Link to="/app/servicios"><Button>Ver servicios</Button></Link>} />
      <FilterBar>
        <Select aria-label="Terminal" value={f.terminal} onChange={(e) => setF({ terminal: e.target.value })}><option value="">Todas las terminales</option>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select aria-label="Cliente" value={f.customer} onChange={(e) => setF({ customer: e.target.value })}><option value="">Todos los clientes</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</Select>
        <Select aria-label="Buque" value={f.vessel} onChange={(e) => setF({ vessel: e.target.value })}><option value="">Todos los buques</option>{vessels.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
        <Select aria-label="Servicio" value={f.service} onChange={(e) => setF({ service: e.target.value })}><option value="">Todos los servicios</option>{services.data?.map((v) => <option key={v.id} value={v.id}>{v.service_number} · {v.vessel_name}</option>)}</Select>
        <Select aria-label="Producto" value={f.product} onChange={(e) => setF({ product: e.target.value })}><option value="">Todos los productos</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Input type="date" aria-label="Desde" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
        <Input type="date" aria-label="Hasta" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
      </FilterBar>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi loading={summary.isLoading} label="Clientes activos" value={fmt0(s.active_customers)} />
        <Kpi loading={summary.isLoading} label="Servicios activos" value={fmt0(s.services_active)} sub={`${fmt0(s.services_scheduled)} programados`} />
        <Kpi loading={summary.isLoading} label="Servicios finalizados" value={fmt0(s.services_finalized)} />
        <Kpi loading={summary.isLoading} label="Buques en operación" value={fmt0(s.vessels_in_operation)} />
        <Kpi loading={summary.isLoading} label="Tonelaje descargado" value={`${fmt0(s.discharged_tm)} TM`} sub={`+${fmt0(s.tons_last_hour)} TM en la última hora`} />
        <Kpi loading={summary.isLoading} tone="red" label="Tonelaje pendiente" value={`${fmt0(s.pending_tm)} TM`} sub="servicios no finalizados" />
        <Kpi loading={summary.isLoading} label="Camiones" value={fmt0(s.trucks)} sub={`+${fmt0(s.trucks_last_hour)} en la última hora`} />
        <Kpi loading={summary.isLoading} label="Promedio de ciclo" value={minutes(s.avg_cycle_minutes)} sub="hora final − hora de inicio" />
        <Kpi loading={summary.isLoading} label="Horas perdidas" value={`${fmt1(s.downtime_hours)} h`} sub={`${fmt0(s.downtime_events)} eventos reportados`} />
        <Kpi loading={summary.isLoading} label="Productividad" value={`${fmt0(s.tph)} TM/h`} sub={`${fmt0(s.tph_last_3h)} TM/h en las últimas 3 h`} />
      </div>

      <Section className="mt-5" title="Buques en operación">
        {list.length === 0 ? (
          <EmptyState icon={<Ship className="h-8 w-8" />} title="No hay buques en operación" action={<Link to="/app/servicios"><Button variant="primary">Ir a servicios</Button></Link>}>
            Cuando un servicio pase a «En operación», aquí verá el buque con sus bodegas vaciándose a medida que se registran los pesajes.
          </EmptyState>
        ) : (
          <>
            <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist">
              {list.map((x) => (
                <button key={x.id} role="tab" aria-selected={x.id === selId} onClick={() => setF({ sel: x.id }, false)}
                  className={clsx('press min-w-[210px] flex-none rounded-xl border px-3 py-2.5 text-left', x.id === selId ? 'border-sea ring-1 ring-sea' : 'border-line hover:border-edge')}>
                  <b className="block truncate text-[15px]">{x.vessel_name}</b>
                  <span className="block truncate text-[13px] text-mute">{x.service_number} · {x.status === 'in_operation' ? pct(x.progress_pct) : SERVICE_STATUS[x.status]?.label}</span>
                  <Meter className="mt-2" value={x.progress_pct} />
                </button>
              ))}
            </div>
            {sel && (
              <>
                <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
                  <div className="min-w-0">
                    <Link to={`/app/servicios/${sel.id}`} className="font-cond text-[28px] font-bold leading-tight hover:underline">{sel.vessel_name}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[14px] text-mute"><StatusBadge map={SERVICE_STATUS} value={sel.status} />{sel.service_number} · {sel.customer_name} · {sel.terminal_name}</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-[40px] font-bold leading-none text-red">{fmt1(cargo.pending)} TM</div>
                    <div className="text-[14px] text-mute">{pct(cargo.initial ? (cargo.discharged / cargo.initial) * 100 : 0)} descargado de {fmt0(cargo.initial)} TM{eta ? ` · fin estimado ${eta.toLocaleString('es-GT', { timeZone: stz, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}</div>
                  </div>
                </div>
                <ShipView holds={cargo.ship} selected={holdId} onSelect={setHoldId} vesselName={sel.vessel_name} />
              </>
            )}
          </>
        )}
      </Section>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Section title={sel ? `Toneladas por hora · ${sel.vessel_name}` : 'Toneladas por hora'} actions={kpis.data?.tph != null && <Badge tone="info">Promedio 12 h: {fmt0(kpis.data.tph)} TM/h</Badge>}>
          <ChartFrame height={240} empty={!hourly.length}><Columns data={hourly} x="hora" series={[{ key: 'tons', name: 'Toneladas', color: 'var(--s1)' }]} unit="TM" /></ChartFrame>
        </Section>
        <Section title="Últimos pesajes">
          <ol className="grid gap-1.5">
            {(feed.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[14px] hover:bg-panel/60">
                <span className="num w-11 text-mute">{time(r.ended_at, tz)}</span>
                <span className="min-w-0 flex-1 truncate"><b>{r.truck_plate}</b> · {r.scale_name}<span className="block truncate text-[12.5px] text-mute">{r.vessel_name} · Bodega {r.hold_number} · {r.product_name}</span></span>
                <span className="num font-semibold">{fmt2(r.net_tm)} TM</span>
              </li>
            ))}
            {feed.data?.length === 0 && <li className="py-6 text-center text-[14px] text-mute">Aún no hay pesajes registrados.</li>}
          </ol>
        </Section>
      </div>

      <Section className="mt-5" title="Básculas hoy">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(scales.data ?? []).filter((x) => !f.terminal || x.terminal_id === f.terminal).map((sc) => {
            const l = (today.data ?? []).filter((t) => t.scale_id === sc.id);
            const last = l.reduce<string | null>((a, t) => (!a || t.ended_at > a ? t.ended_at : a), null);
            return (
              <div key={sc.id} className="rounded-xl border border-line p-3.5">
                <div className="flex items-center justify-between gap-2"><b className="truncate">{sc.name}</b><StatusBadge map={{ active: { label: 'Activa', tone: 'ok' }, maintenance: { label: 'Mantenimiento', tone: 'warn' }, inactive: { label: 'Inactiva', tone: 'mute' } }} value={sc.status} /></div>
                <div className="text-[13px] text-mute">{sc.code}{sc.location ? ` · ${sc.location}` : ''}</div>
                <div className="num mt-1.5 text-[22px] font-bold">{fmt0(l.reduce((a, t) => a + Number(t.net_tm), 0))} TM hoy</div>
                <div className="text-[13px] text-mute">{l.length} camiones · último {ago(last)}</div>
              </div>
            );
          })}
        </div>
      </Section>
      {selId && <HoldDrawer serviceId={selId} hold={holdRow} cargo={cargo.cargo} tz={stz} open={!!holdId} onClose={() => setHoldId(null)} canWeigh={sel?.status === 'in_operation' && can('weighing.register')} />}
    </div>
  );
}
