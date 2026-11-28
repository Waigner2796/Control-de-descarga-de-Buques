import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useRealtime } from '@/lib/hooks';
import { date, dt } from '@/lib/format';
import { VERSION_STATUS } from '@/lib/labels';
import { ReportButtons } from '@/components/ReportLinks';
import { DataTable, EmptyState, PageHeader, StatusBadge, type Column } from '@/components/ui';
import { NoAccess } from '@/pages/auth/AuthPages';
import { usePortalReports, type PortalReport } from './shared';

export default function PortalReports() {
  const { customerLink } = useAuth();
  const q = usePortalReports();
  useRealtime('report_versions', customerLink ? `customer_id=eq.${customerLink.customer_id}` : null, [['portal-reports']], !!customerLink);
  if (!customerLink?.can_view_reports) return <NoAccess inline />;
  const cols: Column<PortalReport>[] = [
    { key: 's', header: 'Servicio', cell: (r) => <Link to={`/portal/servicios/${r.service_id}`} className="num font-semibold hover:underline">{r.service_number}</Link> },
    { key: 'b', header: 'Buque', cell: (r) => r.vessel_name },
    { key: 'd', header: 'Fecha', cell: (r) => date(r.operation_date) },
    { key: 'v', header: 'Versión', cell: (r) => `v${r.version}` },
    { key: 'st', header: 'Estado', wrap: true, cell: (r) => <div><StatusBadge map={VERSION_STATUS} value={r.status} />{r.supersede_reason && <span className="mt-0.5 block max-w-[260px] text-[12px] text-mute">{r.supersede_reason}</span>}</div> },
    { key: 'e', header: 'Emisión', hideBelow: 'md', cell: (r) => <span className="text-[13.5px]">{dt(r.signed_at)}<span className="block text-mute">{r.signer_name} · {r.signer_position}</span></span> },
    { key: 'c', header: 'Firma y sello', hideBelow: 'lg', cell: (r) => <Link to={`/verificar/${r.verification_code}`} className="inline-flex items-center gap-1 text-[13px] font-semibold text-portal hover:underline"><ShieldCheck className="h-4 w-4" />Verificar</Link> },
    { key: 'a', header: <span className="sr-only">Documento</span>, align: 'right', cell: (r) => (customerLink.can_download_reports ? <ReportButtons portal compact path={r.storage_path} filename={`Informe-${r.service_number}-v${r.version}.pdf`} /> : <span className="text-[13px] text-mute">Solo consulta</span>) },
  ];
  return (
    <div>
      <PageHeader title="Mis reportes" sub="Informes finales firmados y sellados. Las descargas usan enlaces temporales y privados." />
      <DataTable columns={cols} rows={q.data} rowKey={(r) => r.id} loading={q.isLoading} rowClassName={(r) => (r.status === 'superseded' ? 'opacity-75' : undefined)}
        empty={<EmptyState icon={<ShieldCheck className="h-8 w-8" />} title="Aún no hay reportes">Cuando finalice un servicio y el informe sea firmado, lo encontrará aquí.</EmptyState>} />
      <p className="mt-3 text-[13px] text-mute">Una versión «Sustituida» fue reemplazada por una corrección autorizada; se conserva para su consulta.</p>
    </div>
  );
}
