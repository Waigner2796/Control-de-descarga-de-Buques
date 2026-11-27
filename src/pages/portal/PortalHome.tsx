import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { useServiceCargo } from '@/lib/service-data';
import { dt, fmt0, fmt1, pct } from '@/lib/format';
import { SERVICE_STATUS } from '@/lib/labels';
import { ShipView } from '@/components/ShipView';
import { ReportButtons } from '@/components/ReportLinks';
import { Badge, Button, EmptyState, Kpi, Meter, Section, StatusBadge } from '@/components/ui';
import { usePortalReports, usePortalServices, type PortalService } from './shared';

function LiveVessel({ s }: { s: PortalService }) {
  const cargo = useServiceCargo(s.id);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div><Link to={`/portal/servicios/${s.id}`} className="font-cond text-[26px] font-bold hover:underline">{s.vessel_name}</Link><div className="text-[14px] text-mute">Servicio {s.service_number} · {s.terminal_name}</div></div>
        <div className="text-right"><div className="num text-[34px] font-bold leading-none text-portal">{pct(cargo.initial ? (cargo.discharged / cargo.initial) * 100 : 0)}</div><div className="text-[14px] text-mute">{fmt1(cargo.discharged)} de {fmt0(cargo.initial)} TM descargadas</div></div>
      </div>
      <ShipView holds={cargo.ship} vesselName={s.vessel_name} />
    </div>
  );
}

export default function PortalHome() {
  const { customerLink } = useAuth();
  const services = usePortalServices();
  const reports = usePortalReports();
  useRealtime('services', `customer_id=eq.${customerLink?.customer_id}`, [['portal-services']], !!customerLink);
  const list = services.data ?? [];
  const active = list.filter((s) => ['preparing', 'in_operation', 'suspended', 'closing'].includes(s.status));
  const live = list.filter((s) => s.status === 'in_operation');
  const sum = (k: keyof PortalService) => list.reduce((a, s) => a + Number(s[k] ?? 0), 0);
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[32px] font-bold leading-tight">Hola, {customerLink?.customer_name}</h1>
        <p className="mt-1 text-mute">Estado de sus servicios de descarga con {customerLink?.organization_name?.replace(/\.$/, "")}.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi loading={services.isLoading} label="Servicios contratados" value={list.length} />
        <Kpi loading={services.isLoading} label="En ejecución" value={active.length} tone="portal" />
        <Kpi loading={services.isLoading} label="Finalizados" value={list.filter((s) => s.status === 'finalized').length} />
        <Kpi loading={services.isLoading} label="Tonelaje descargado" value={`${fmt0(sum('discharged_tm'))} TM`} />
        <Kpi loading={services.isLoading} label="Tonelaje pendiente" value={`${fmt0(list.filter((s) => s.status !== 'finalized').reduce((a, s) => a + Number(s.pending_tm), 0))} TM`} tone="red" />
        <Kpi loading={reports.isLoading} label="Reportes disponibles" value={(reports.data ?? []).filter((r) => r.status === 'signed').length} />
      </div>
      {live.map((s) => <Section key={s.id}><LiveVessel s={s} /></Section>)}
      {!live.length && active.length > 0 && (
        <Section title="Operaciones en curso">
          <ul className="grid gap-3 md:grid-cols-2">{active.map((s) => (
            <li key={s.id}><Link to={`/portal/servicios/${s.id}`} className="block rounded-xl border border-line p-4 hover:border-portal"><div className="flex items-center justify-between gap-2"><b>{s.vessel_name}</b><StatusBadge map={SERVICE_STATUS} value={s.status} /></div><div className="text-[13.5px] text-mute">{s.service_number}</div><Meter tone="portal" className="mt-2" value={s.progress_pct} /></Link></li>
          ))}</ul>
        </Section>
      )}
      <Section title="Últimos reportes" actions={<Link to="/portal/reportes"><Button variant="ghost" icon={<ArrowRight className="h-4 w-4" />}>Ver todos</Button></Link>}>
        {(reports.data ?? []).filter((r) => r.status === 'signed').slice(0, 5).map((r) => (
          <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-2.5 last:border-0">
            <div><b className="num">{r.service_number}</b> · {r.vessel_name}<div className="text-[13px] text-mute">Versión {r.version} · firmado {dt(r.signed_at)}</div></div>
            {customerLink?.can_download_reports ? <ReportButtons portal compact path={r.storage_path} filename={`Informe-${r.service_number}-v${r.version}.pdf`} /> : <Badge tone="portal">Disponible</Badge>}
          </div>
        ))}
        {!reports.data?.some((r) => r.status === 'signed') && <EmptyState title="Aún no hay reportes">El informe final firmado aparece aquí cuando el servicio finaliza.</EmptyState>}
      </Section>
    </div>
  );
}
