import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Ship } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useCustomersLite, useRealtime, useTerminals, useUrlState, useVessels } from '@/lib/hooks';
import { date, fmt1, pct } from '@/lib/format';
import { REPORT_STATUS, SERVICE_STATUS } from '@/lib/labels';
import { Button, DataTable, EmptyState, ErrorBox, FilterBar, Meter, PageHeader, Pagination, SearchInput, Select, StatusBadge, type Column } from '@/components/ui';

type Row = { id: string; service_number: string; status: string; customer_name: string; vessel_name: string; terminal_name: string; timezone: string; products: string; initial_tm: number; discharged_tm: number; pending_tm: number; progress_pct: number; planned_start: string | null; actual_start: string | null; finalized_at: string | null; report_status: string | null };

export default function Services() {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useUrlState({ q: '', status: '', terminal: '', customer: '', vessel: '', sort: 'created_at', dir: 'desc', page: '1', size: '25' });
  const page = Number(f.page) || 1, size = Number(f.size) || 25;
  const terminals = useTerminals(orgId);
  const customers = useCustomersLite(orgId);
  const vessels = useVessels(orgId);
  const q = useQuery({
    queryKey: ['services', orgId, f], placeholderData: keepPreviousData,
    queryFn: async () => {
      let qq = supabase.from('service_overview').select('id, service_number, status, customer_name, vessel_name, terminal_name, timezone, products, initial_tm, discharged_tm, pending_tm, progress_pct, planned_start, actual_start, finalized_at, report_status', { count: 'exact' }).eq('organization_id', orgId);
      if (f.q) qq = qq.ilike('service_number', `%${f.q.replace(/[%_]/g, '')}%`);
      if (f.status) qq = qq.eq('status', f.status);
      if (f.terminal) qq = qq.eq('terminal_id', f.terminal);
      if (f.customer) qq = qq.eq('customer_id', f.customer);
      if (f.vessel) qq = qq.eq('vessel_id', f.vessel);
      const r = await qq.order(f.sort, { ascending: f.dir === 'asc', nullsFirst: false }).order('id').range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as Row[], count: r.count ?? 0 };
    },
  });
  useRealtime('services', `organization_id=eq.${orgId}`, [['services', orgId]]);
  const cols: Column<Row>[] = [
    { key: 'n', header: 'Servicio', sortKey: 'service_number', cell: (r) => <b className="num">{r.service_number}</b> },
    { key: 'v', header: 'Buque', sortKey: 'vessel_name', cell: (r) => <div className="min-w-[140px]"><b>{r.vessel_name}</b><div className="text-[13px] text-mute">{r.terminal_name}</div></div> },
    { key: 'c', header: 'Cliente', sortKey: 'customer_name', cell: (r) => r.customer_name },
    { key: 'p', header: 'Productos', hideBelow: 'lg', wrap: true, cell: (r) => <span className="text-[13.5px]">{r.products || '—'}</span> },
    { key: 'pr', header: 'Avance', sortKey: 'progress_pct', cell: (r) => <div className="min-w-[120px]"><div className="num text-[13px]">{pct(r.progress_pct)} · <span className="text-red">{fmt1(r.pending_tm)} TM</span></div><Meter value={r.progress_pct} className="mt-1" /></div> },
    { key: 's', header: 'Inicio', sortKey: 'actual_start', hideBelow: 'md', cell: (r) => date(r.actual_start ?? r.planned_start, r.timezone) },
    { key: 'st', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge map={SERVICE_STATUS} value={r.status} /> },
    { key: 'r', header: 'Informe', hideBelow: 'md', cell: (r) => r.report_status ? <StatusBadge map={REPORT_STATUS} value={r.report_status} /> : <span className="text-mute">—</span> },
  ];
  return (
    <div>
      <PageHeader title="Servicios de descarga" sub="Cada servicio es una operación comercial y operativa para un cliente."
        actions={can('services.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/app/servicios/nuevo')}>Nuevo servicio</Button>} />
      <FilterBar>
        <SearchInput value={f.q} onChange={(v) => setF({ q: v })} placeholder="Buscar número de servicio" />
        <Select aria-label="Estado" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Todos los estados</option>{Object.entries(SERVICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        <Select aria-label="Terminal" value={f.terminal} onChange={(e) => setF({ terminal: e.target.value })}><option value="">Todas las terminales</option>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select aria-label="Cliente" value={f.customer} onChange={(e) => setF({ customer: e.target.value })}><option value="">Todos los clientes</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</Select>
        <Select aria-label="Buque" value={f.vessel} onChange={(e) => setF({ vessel: e.target.value })}><option value="">Todos los buques</option>{vessels.data?.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
      </FilterBar>
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} onRowClick={(r) => nav(`/app/servicios/${r.id}`)}
        sort={{ key: f.sort, asc: f.dir === 'asc' }} onSort={(k) => setF({ sort: k, dir: f.sort === k && f.dir === 'asc' ? 'desc' : 'asc' })}
        empty={Object.values({ q: f.q, s: f.status, t: f.terminal, c: f.customer, v: f.vessel }).some(Boolean) ? undefined :
          <EmptyState icon={<Ship className="h-8 w-8" />} title="Aún no hay servicios" action={can('services.manage') && <Button variant="primary" onClick={() => nav('/app/servicios/nuevo')}>Registrar el primer servicio</Button>}>
            Registre el servicio con el número comercial de su empresa, el buque, sus bodegas y el tonelaje por producto.
          </EmptyState>} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} />
    </div>
  );
}
