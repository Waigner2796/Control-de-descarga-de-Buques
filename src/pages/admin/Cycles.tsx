import { useOrg } from '@/lib/auth';
import { useTerminals } from '@/lib/hooks';
import { DEFAULT_TZ } from '@/lib/format';
import { CyclesTable } from '@/components/CyclesTable';
import { PageHeader } from '@/components/ui';

export default function Cycles() {
  const { orgId } = useOrg();
  const terminals = useTerminals(orgId);
  const tz = terminals.data?.[0]?.timezone ?? DEFAULT_TZ;
  return (
    <div>
      <PageHeader title="Ciclos de báscula" sub="Cada ciclo es un pesaje: hora final − hora de inicio. Paginación, filtros y orden se resuelven en el servidor." />
      <CyclesTable orgId={orgId} tz={tz} />
    </div>
  );
}
