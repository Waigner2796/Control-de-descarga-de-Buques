import { useEffect } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { useOrg } from '@/lib/auth';
import { useServicesLite, useUrlState } from '@/lib/hooks';
import { exportProductivity } from '@/lib/excel/exports';
import { ProductivityPanel } from '@/components/ProductivityPanel';
import { Button, EmptyState, FilterBar, Input, PageHeader, Select, useToast } from '@/components/ui';

export default function Productivity() {
  const { orgId } = useOrg();
  const toast = useToast();
  const services = useServicesLite(orgId, ['in_operation', 'suspended', 'closing', 'finalized']);
  const [f, setF] = useUrlState({ svc: '', from: '', to: '' });
  useEffect(() => { if (!f.svc && services.data?.length) setF({ svc: services.data[0].id }); }, [services.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const svc = services.data?.find((s) => s.id === f.svc);
  return (
    <div>
      <PageHeader title="Productividad" sub="Indicadores por servicio: tonelaje, camiones, toneladas por hora, ciclos, tiempo perdido y tiempo efectivo."
        actions={svc && <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => exportProductivity(svc.id, svc.service_number, svc.timezone, f.from, f.to).catch((e) => toast(e.message, 'bad'))}>Exportar Excel</Button>} />
      <FilterBar>
        <Select aria-label="Servicio" value={f.svc} onChange={(e) => setF({ svc: e.target.value })} className="lg:min-w-[320px]">{services.data?.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name} · {s.customer_name}</option>)}</Select>
        <Input type="date" aria-label="Desde" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
        <Input type="date" aria-label="Hasta" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
      </FilterBar>
      {svc ? <ProductivityPanel serviceId={svc.id} tz={svc.timezone} from={f.from} to={f.to} /> : <EmptyState title="Sin servicios con operación">La productividad se calcula a partir de los pesajes registrados.</EmptyState>}
    </div>
  );
}
