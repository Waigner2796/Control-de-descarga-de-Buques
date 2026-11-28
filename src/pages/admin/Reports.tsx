import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet } from 'lucide-react';
import { useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useCustomersLite, useServicesLite, useUrlState } from '@/lib/hooks';
import { dt } from '@/lib/format';
import { VERSION_STATUS } from '@/lib/labels';
import { exportCustomerConsolidated, exportProductivity, exportServiceReport, exportServiceSheet } from '@/lib/excel/exports';
import { Button, DataTable, EmptyState, FilterBar, Field, PageHeader, Pagination, Section, Select, StatusBadge, Tabs, useToast, type Column } from '@/components/ui';
import { ReportButtons } from '@/components/ReportLinks';

type Row = { id: string; service_id: string; service_number: string; vessel_name: string; customer_name: string; version: number; status: string; generated_at: string; signed_at: string | null; signer_name: string | null; storage_path: string | null; draft_path: string | null; verification_code: string; supersede_reason: string | null };

export default function Reports() {
  const { orgId } = useOrg();
  const [f, setF] = useUrlState({ view: 'pdf', estado: '', cust: '', page: '1', size: '25' });
  const page = Number(f.page) || 1, size = Number(f.size) || 25;
  const customers = useCustomersLite(orgId);
  const q = useQuery({
    queryKey: ['reports', orgId, f], placeholderData: keepPreviousData, enabled: f.view === 'pdf',
    queryFn: async () => {
      let qq = supabase.from('report_overview').select('id, service_id, service_number, vessel_name, customer_name, version, status, generated_at, signed_at, signer_name, storage_path, draft_path, verification_code, supersede_reason', { count: 'exact' }).eq('organization_id', orgId);
      if (f.estado) qq = qq.eq('status', f.estado);
      if (f.cust) qq = qq.eq('customer_id', f.cust);
      const r = await qq.order('generated_at', { ascending: false }).range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as Row[], count: r.count ?? 0 };
    },
  });
  const cols: Column<Row>[] = [
    { key: 's', header: 'Servicio', cell: (r) => <Link to={`/app/servicios/${r.service_id}?tab=reportes`} className="num font-semibold hover:underline">{r.service_number}</Link> },
    { key: 'v', header: 'Buque', cell: (r) => r.vessel_name },
    { key: 'c', header: 'Cliente', cell: (r) => r.customer_name },
    { key: 've', header: 'Versión', align: 'right', cell: (r) => `v${r.version}` },
    { key: 'st', header: 'Estado', cell: (r) => <StatusBadge map={VERSION_STATUS} value={r.status} /> },
    { key: 'g', header: 'Generado', hideBelow: 'md', cell: (r) => dt(r.generated_at) },
    { key: 'f', header: 'Firmado', hideBelow: 'md', cell: (r) => (r.signed_at ? <span className="text-[13.5px]">{dt(r.signed_at)}<span className="block text-mute">{r.signer_name}</span></span> : '—') },
    { key: 'a', header: <span className="sr-only">PDF</span>, align: 'right', cell: (r) => <ReportButtons compact path={r.storage_path ?? r.draft_path} filename={`Informe-${r.service_number}-v${r.version}.pdf`} /> },
  ];
  return (
    <div>
      <PageHeader title="Reportes" sub="Informes finales firmados y exportaciones a Excel que respetan los filtros seleccionados." />
      <Tabs value={f.view} onChange={(v) => setF({ view: v })} tabs={[{ id: 'pdf', label: 'Informes finales (PDF)' }, { id: 'excel', label: 'Exportaciones Excel' }]} />
      {f.view === 'pdf' ? (
        <>
          <FilterBar>
            <Select aria-label="Estado" value={f.estado} onChange={(e) => setF({ estado: e.target.value })}><option value="">Todos los estados</option>{Object.entries(VERSION_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
            <Select aria-label="Cliente" value={f.cust} onChange={(e) => setF({ cust: e.target.value })}><option value="">Todos los clientes</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</Select>
          </FilterBar>
          <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} empty={<EmptyState title="Sin informes">Los informes finales se generan automáticamente al finalizar un servicio.</EmptyState>} />
          <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} />
        </>
      ) : <ExcelExports orgId={orgId} />}
    </div>
  );
}

function ExcelExports({ orgId }: { orgId: string }) {
  const toast = useToast();
  const services = useServicesLite(orgId);
  const customers = useCustomersLite(orgId);
  const [svc, setSvc] = useState('');
  const [cust, setCust] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const s = services.data?.find((x) => x.id === svc);
  const run = async (k: string, fn: () => Promise<unknown>) => { setBusy(k); try { await fn(); } catch (e) { toast((e as Error).message, 'bad'); } setBusy(null); };
  const items: [string, string, string][] = [
    ['service', 'Reporte por servicio', 'Libro completo: resumen, pesajes, bodegas, básculas, ciclos, resumen por hora y tiempos perdidos.'],
    ['trucks', 'Detalle de camiones', 'Todos los pesajes válidos con transporte, pesos y horas.'],
    ['cycles', 'Ciclos', 'Hora de inicio, hora final y tiempo de ciclo por ticket.'],
    ['downtime', 'Tiempos perdidos', 'Eventos con duración, alcance y observaciones.'],
    ['tonnage', 'Resumen de tonelaje', 'Inicial, descargado y pendiente por bodega y producto.'],
    ['scales', 'Productividad por báscula', 'Camiones, toneladas, promedios y TM/h por báscula.'],
    ['holds', 'Productividad por bodega', 'Avance y tiempo perdido por bodega.'],
  ];
  return (
    <div className="grid gap-5">
      <Section title="Por servicio">
        <Field label="Servicio" className="max-w-xl"><Select value={svc} onChange={(e) => setSvc(e.target.value)}><option value="">Seleccione…</option>{services.data?.map((x) => <option key={x.id} value={x.id}>{x.service_number} · {x.vessel_name} · {x.customer_name}</option>)}</Select></Field>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map(([k, title, desc]) => (
            <div key={k} className="flex flex-col gap-2 rounded-xl border border-line p-3.5">
              <b className="font-cond text-[17px]">{title}</b><p className="flex-1 text-[13.5px] text-mute">{desc}</p>
              <Button disabled={!s} loading={busy === k} icon={<FileSpreadsheet className="h-4 w-4" />}
                onClick={() => run(k, () => (k === 'service' ? exportServiceReport(s!.id) : k === 'scales' || k === 'holds' ? exportProductivity(s!.id, s!.service_number, s!.timezone) : exportServiceSheet(s!.id, k as 'trucks' | 'cycles' | 'downtime' | 'tonnage')))}>Descargar</Button>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Reporte consolidado del cliente">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Cliente" className="min-w-[280px]"><Select value={cust} onChange={(e) => setCust(e.target.value)}><option value="">Seleccione…</option>{customers.data?.map((c) => <option key={c.id} value={c.id}>{c.trade_name}</option>)}</Select></Field>
          <Button disabled={!cust} loading={busy === 'cust'} icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => run('cust', () => exportCustomerConsolidated(cust, customers.data!.find((c) => c.id === cust)!.trade_name))}>Descargar consolidado</Button>
        </div>
      </Section>
    </div>
  );
}
