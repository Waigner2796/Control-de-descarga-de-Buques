import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useServiceCargo } from '@/lib/service-data';
import { dt, fmt0, fmt1, fmt3, pct } from '@/lib/format';
import { SERVICE_STATUS, VERSION_STATUS } from '@/lib/labels';
import { ShipView } from '@/components/ShipView';
import { ProductivityPanel } from '@/components/ProductivityPanel';
import { ReportButtons } from '@/components/ReportLinks';
import { DataTable, DL, Dot, EmptyState, Kpi, Meter, Notice, PageHeader, Section, Spinner, StatusBadge } from '@/components/ui';
import { usePortalReports, usePortalServices } from './shared';

export default function PortalServiceDetail() {
  const { id } = useParams();
  const { customerLink } = useAuth();
  const services = usePortalServices();
  const s = services.data?.find((x) => x.id === id);
  const cargo = useServiceCargo(s ? id : null);
  const reports = usePortalReports(id);
  if (services.isLoading) return <Spinner />;
  if (!s) return <EmptyState title="Servicio no disponible">El servicio no existe o no pertenece a su cuenta.</EmptyState>;
  const tz = s.timezone;
  return (
    <div className="grid gap-5">
      <div>
        <Link to="/portal/servicios" className="mb-3 inline-flex items-center gap-1.5 text-[14px] font-semibold text-mute hover:text-ink"><ArrowLeft className="h-4 w-4" />Mis servicios</Link>
        <PageHeader title={<span className="num">{s.service_number}</span>} sub={<span className="flex flex-wrap items-center gap-2"><StatusBadge map={SERVICE_STATUS} value={s.status} /><b className="text-ink">{s.vessel_name}</b> · {s.terminal_name}</span>} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Tonelaje inicial" value={`${fmt0(cargo.initial)} TM`} />
        <Kpi label="Descargado" value={`${fmt1(cargo.discharged)} TM`} tone="portal" sub={pct(cargo.initial ? (cargo.discharged / cargo.initial) * 100 : 0)} />
        <Kpi label="Pendiente" value={`${fmt1(cargo.pending)} TM`} tone="red" />
        <Kpi label="Bodegas" value={s.holds_count} />
      </div>
      <Section title="Bodegas">
        {cargo.ship.length > 0 && <ShipView holds={cargo.ship} vesselName={s.vessel_name} className="mb-4" />}
        <DataTable rows={cargo.cargo} rowKey={(c) => c.id} columns={[
          { key: 'h', header: 'Bodega', cell: (c) => `Bodega ${cargo.holds.find((h) => h.id === c.service_hold_id)?.hold_number ?? ''}` },
          { key: 'p', header: 'Producto', cell: (c) => <span className="inline-flex items-center gap-2"><Dot color={c.product.color} />{c.product.name}</span> },
          { key: 'i', header: 'Inicial (TM)', align: 'right', cell: (c) => fmt3(c.initial_tm) },
          { key: 'd', header: 'Descargado (TM)', align: 'right', cell: (c) => fmt3(c.discharged_tm) },
          { key: 'pe', header: 'Pendiente (TM)', align: 'right', cell: (c) => fmt3(Number(c.initial_tm) - Number(c.discharged_tm)) },
          { key: 'a', header: 'Avance', cell: (c) => <Meter tone="portal" className="min-w-[90px]" value={Number(c.initial_tm) ? (Number(c.discharged_tm) / Number(c.initial_tm)) * 100 : 0} /> },
        ]} />
      </Section>
      <Section title="Información de la operación">
        <DL cols={3} items={[['Buque', `${s.vessel_name}${s.imo_number ? ` · IMO ${s.imo_number}` : ''}`], ['Productos', s.products], ['Terminal', s.terminal_name],
          ['Inicio programado', dt(s.planned_start, tz)], ['Inicio de operación', dt(s.actual_start, tz)], ['Finalización', dt(s.finalized_at, tz)], ['Observaciones', s.observations]]} />
      </Section>
      {customerLink?.can_view_productivity && <Section title="Resumen de productividad"><ProductivityPanel serviceId={s.id} tz={tz} portal /></Section>}
      {customerLink?.can_view_reports && (
        <Section title="Reportes finales">
          {s.status === 'finalized' && !reports.data?.length && <Notice tone="info">El informe final está en proceso de firma. Recibirá una notificación cuando esté disponible.</Notice>}
          {s.status !== 'finalized' && <p className="text-[14px] text-mute">El informe final estará disponible al concluir la operación.</p>}
          {!!reports.data?.length && <DataTable rows={reports.data} rowKey={(r) => r.id} columns={[
            { key: 'v', header: 'Versión', cell: (r) => <b>v{r.version}</b> },
            { key: 's', header: 'Estado', cell: (r) => <StatusBadge map={VERSION_STATUS} value={r.status} /> },
            { key: 'f', header: 'Firmado', cell: (r) => <span className="text-[13.5px]">{dt(r.signed_at, tz)}<span className="block text-mute">{r.signer_name}</span></span> },
            { key: 'c', header: 'Verificación', hideBelow: 'md', cell: (r) => <Link to={`/verificar/${r.verification_code}`} className="num text-[12.5px] text-portal hover:underline">{r.verification_code}</Link> },
            { key: 'a', header: <span className="sr-only">PDF</span>, align: 'right', cell: (r) => customerLink.can_download_reports ? <ReportButtons portal compact path={r.storage_path} filename={`Informe-${r.service_number}-v${r.version}.pdf`} /> : null },
          ]} />}
        </Section>
      )}
    </div>
  );
}
