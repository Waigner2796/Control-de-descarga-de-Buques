import { useNavigate } from 'react-router-dom';
import { useUrlState } from '@/lib/hooks';
import { date, fmt1, pct } from '@/lib/format';
import { SERVICE_STATUS } from '@/lib/labels';
import { DataTable, EmptyState, Meter, PageHeader, SearchInput, StatusBadge, Tabs, type Column } from '@/components/ui';
import { usePortalServices, type PortalService } from './shared';

export default function PortalServices() {
  const nav = useNavigate();
  const q = usePortalServices();
  const [f, setF] = useUrlState({ tab: 'curso', q: '' });
  const rows = (q.data ?? []).filter((s) => (f.tab === 'curso' ? s.status !== 'finalized' : f.tab === 'finalizadas' ? s.status === 'finalized' : true))
    .filter((s) => !f.q || `${s.service_number} ${s.vessel_name}`.toLowerCase().includes(f.q.toLowerCase()));
  const cols: Column<PortalService>[] = [
    { key: 'n', header: 'Servicio', cell: (s) => <b className="num">{s.service_number}</b> },
    { key: 'v', header: 'Buque', cell: (s) => s.vessel_name },
    { key: 'p', header: 'Productos', hideBelow: 'md', wrap: true, cell: (s) => <span className="text-[13.5px]">{s.products}</span> },
    { key: 'i', header: 'Inicial (TM)', align: 'right', cell: (s) => fmt1(s.initial_tm) },
    { key: 'd', header: 'Descargado (TM)', align: 'right', cell: (s) => fmt1(s.discharged_tm) },
    { key: 'pe', header: 'Pendiente (TM)', align: 'right', cell: (s) => fmt1(s.pending_tm) },
    { key: 'a', header: 'Avance', cell: (s) => <div className="min-w-[100px]"><span className="num text-[13px]">{pct(s.progress_pct)}</span><Meter tone="portal" value={s.progress_pct} /></div> },
    { key: 'f', header: 'Fechas', hideBelow: 'lg', cell: (s) => <span className="text-[13px]">{date(s.actual_start ?? s.planned_start, s.timezone)} – {date(s.finalized_at, s.timezone)}</span> },
    { key: 's', header: 'Estado', cell: (s) => <StatusBadge map={SERVICE_STATUS} value={s.status} /> },
  ];
  return (
    <div>
      <PageHeader title="Mis servicios" sub="Consulte el avance y el detalle de cada operación de descarga." />
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={[{ id: 'curso', label: 'Operaciones en curso' }, { id: 'finalizadas', label: 'Operaciones finalizadas' }, { id: 'todas', label: 'Todas' }]} />
      <div className="mb-3 max-w-sm"><SearchInput value={f.q} onChange={(v) => setF({ q: v })} placeholder="Buscar servicio o buque" /></div>
      <DataTable columns={cols} rows={rows} rowKey={(s) => s.id} loading={q.isLoading} onRowClick={(s) => nav(`/portal/servicios/${s.id}`)} empty={<EmptyState title="Sin servicios en esta vista" />} />
    </div>
  );
}
