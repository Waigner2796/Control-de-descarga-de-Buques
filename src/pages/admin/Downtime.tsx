import { useOrg } from '@/lib/auth';
import { useServicesLite, useTerminals, useUrlState } from '@/lib/hooks';
import { DEFAULT_TZ } from '@/lib/format';
import { DowntimeList, DowntimeSummary } from '@/components/DowntimePanel';
import { FilterBar, Input, PageHeader, Section, Select, Tabs } from '@/components/ui';

export default function Downtime() {
  const { orgId } = useOrg();
  const terminals = useTerminals(orgId);
  const services = useServicesLite(orgId);
  const tz = terminals.data?.[0]?.timezone ?? DEFAULT_TZ;
  const [f, setF] = useUrlState({ view: 'registro', ssvc: '', sfrom: '', sto: '' });
  return (
    <div>
      <PageHeader title="Tiempos perdidos" sub="Registro de tiempos perdidos (operational downtime): identifique y cuantifique las interrupciones de la descarga." />
      <Tabs value={f.view} onChange={(v) => setF({ view: v })} tabs={[{ id: 'registro', label: 'Registro' }, { id: 'analisis', label: 'Dashboard y Pareto' }]} />
      {f.view === 'registro' ? <DowntimeList orgId={orgId} tz={tz} /> : (
        <div className="grid gap-4">
          <FilterBar>
            <Select aria-label="Servicio" value={f.ssvc} onChange={(e) => setF({ ssvc: e.target.value })}><option value="">Todos los servicios</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name}</option>)}</Select>
            <Input type="date" aria-label="Desde" value={f.sfrom} onChange={(e) => setF({ sfrom: e.target.value })} />
            <Input type="date" aria-label="Hasta" value={f.sto} onChange={(e) => setF({ sto: e.target.value })} />
          </FilterBar>
          <Section><DowntimeSummary orgId={orgId} serviceId={f.ssvc || undefined} tz={tz} from={f.sfrom} to={f.sto} /></Section>
        </div>
      )}
    </div>
  );
}
