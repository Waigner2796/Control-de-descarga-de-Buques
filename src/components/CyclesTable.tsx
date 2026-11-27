import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, History, Pencil, XCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { unwrap, supabase } from '@/lib/supabase';
import { useProducts, useRealtime, useScales, useServicesLite, useUrlState } from '@/lib/hooks';
import { cyclesQuery, fetchAll, type CycleRow } from '@/lib/queries';
import { date, fmt0, fmt2, fmtDpi, minutes, time } from '@/lib/format';
import { ACTIVE } from '@/lib/labels';
import { exportCycles } from '@/lib/excel/exports';
import { Badge, Button, DataTable, Dot, ErrorBox, FilterBar, Input, Modal, Pagination, SearchInput, Select, StatusBadge, useToast, type Column } from '@/components/ui';
import { CorrectionDialog, RecordHistory } from './CorrectionDialog';

/** Tabla de ciclos de báscula con paginación, orden y filtros resueltos en el servidor. */
export function CyclesTable({ orgId, serviceId, tz, longCycle = 30 }: { orgId: string; serviceId?: string; tz: string; longCycle?: number }) {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setF] = useUrlState({ svc: '', hold: '', prod: '', scale: '', shift: '', plate: '', ticket: '', from: '', to: '', st: 'valid', bl: '', sort: 'weighed_at', dir: 'desc', page: '1', size: '25' });
  const page = Number(f.page) || 1, size = Number(f.size) || 25;
  const service = serviceId ?? f.svc;
  const services = useServicesLite(serviceId ? null : orgId);
  const scales = useScales(orgId);
  const products = useProducts(orgId);
  const holds = useQuery({ queryKey: ['holds-of', service], enabled: !!service, queryFn: async () => unwrap(await supabase.from('service_holds').select('id, hold_number').eq('service_id', service).order('hold_number')) as { id: string; hold_number: number }[] });
  const bls = useQuery({ queryKey: ['bls-of', service], enabled: !!service, queryFn: async () => unwrap(await supabase.from('service_bls').select('id, bl_number').eq('service_id', service).order('sort')) as { id: string; bl_number: string }[] });
  const shifts = useQuery({ queryKey: ['shifts-all', orgId], queryFn: async () => unwrap(await supabase.from('shifts').select('id, name, terminal_id').eq('organization_id', orgId).order('sort')) as { id: string; name: string }[] });
  const filters = { service, hold: f.hold, product: f.prod, scale: f.scale, shift: f.shift, plate: f.plate, ticket: f.ticket, from: f.from, to: f.to, status: f.st, bl: f.bl };
  const q = useQuery({
    queryKey: ['cycles', orgId, filters, f.sort, f.dir, page, size], placeholderData: keepPreviousData,
    queryFn: async () => {
      const r = await cyclesQuery(orgId, filters, tz).order(f.sort, { ascending: f.dir === 'asc' }).order('id', { ascending: false }).range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as CycleRow[], count: r.count ?? 0 };
    },
  });
  useRealtime('weigh_tickets', service ? `service_id=eq.${service}` : `organization_id=eq.${orgId}`, [['cycles', orgId]]);
  const [corr, setCorr] = useState<{ row: CycleRow; mode: 'update' | 'void' } | null>(null);
  const [hist, setHist] = useState<CycleRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const canCorrect = can('corrections.request') || can('corrections.approve');

  const doExport = async () => {
    setExporting(true);
    try {
      const rows = await fetchAll<CycleRow>(() => cyclesQuery(orgId, filters, tz, false), [{ col: 'weighed_at', asc: true }, { col: 'id', asc: true }]);
      await exportCycles(rows, tz, { title: service ? `Ciclos · ${rows[0]?.service_number ?? ''}` : 'Ciclos de báscula', filters });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setExporting(false); }
  };

  const rowsHaveUnits = (q.data?.rows ?? []).some((r) => r.cargo_type === 'bags');
  const cols: Column<CycleRow>[] = [
    { key: 'ticket', header: 'Boleta', sortKey: 'ticket_number', cell: (r) => <span className="num font-semibold">{r.ticket_number}{r.revision > 1 && <Badge tone="info" className="ml-1.5">corregido</Badge>}</span> },
    ...(!serviceId ? [{ key: 'svc', header: 'Servicio', sortKey: 'service_number', hideBelow: 'lg' as const, cell: (r: CycleRow) => <span className="num">{r.service_number}</span> }] : []),
    { key: 'date', header: 'Fecha', sortKey: 'weighed_at', cell: (r) => date(r.weighed_at, tz) },
    { key: 'hora', header: 'Hora', cell: (r) => <span className="num">{time(r.weighed_at, tz)}</span> },
    { key: 'cyc', header: 'Ciclo', sortKey: 'cycle_seconds', align: 'right', cell: (r) => r.cycle_minutes == null
      ? <span className="text-mute" title="Primera pasada del camión en el servicio">—</span>
      : <span className={Number(r.cycle_minutes) > longCycle ? 'font-bold text-red' : ''} title={r.prev_weighed_at ? `Pasada anterior: ${time(r.prev_weighed_at, tz)}` : undefined}>{minutes(r.cycle_minutes)}</span> },
    { key: 'plate', header: 'Placa', sortKey: 'truck_plate', cell: (r) => <b>{r.truck_plate}</b> },
    { key: 'tc', header: 'TC', hideBelow: 'lg', cell: (r) => r.tractor_plate ?? '—' },
    { key: 'drv', header: 'Piloto', hideBelow: 'lg', cell: (r) => <span className="text-[13.5px]">{r.driver_name}{r.driver_dpi && <span className="block text-[12px] text-mute">{fmtDpi(r.driver_dpi)}</span>}</span> },
    { key: 'scale', header: 'Báscula / punto', sortKey: 'scale_name', hideBelow: 'md', cell: (r) => r.scale_name },
    { key: 'bl', header: 'BL', sortKey: 'bl_number', hideBelow: 'md', cell: (r) => r.bl_number ? <span className="num">{r.bl_number}</span> : <span className="text-mute">—</span> },
    { key: 'hold', header: 'Bodega', sortKey: 'hold_number', align: 'center', cell: (r) => r.hold_number },
    { key: 'prod', header: 'Producto', sortKey: 'product_name', hideBelow: 'md', cell: (r) => <span className="inline-flex items-center gap-1.5"><Dot color={r.product_color} />{r.product_name}</span> },
    { key: 'gross', header: 'Bruto kg', sortKey: 'gross_kg', align: 'right', hideBelow: 'lg', cell: (r) => fmt0(r.gross_kg) },
    { key: 'tare', header: 'Tara kg', sortKey: 'tare_kg', align: 'right', hideBelow: 'lg', cell: (r) => fmt0(r.tare_kg) },
    { key: 'netkg', header: 'Neto kg', sortKey: 'net_kg', align: 'right', hideBelow: 'lg', cell: (r) => fmt0(r.net_kg) },
    { key: 'net', header: 'Neto TM', sortKey: 'net_tm', align: 'right', cell: (r) => <b>{fmt2(r.net_tm)}</b> },
    ...(rowsHaveUnits ? [{ key: 'units', header: 'Sacos', align: 'right' as const, cell: (r: CycleRow) => (r.units == null ? '—' : fmt0(r.units)) }] : []),
    { key: 'st', header: 'Estado', cell: (r) => <StatusBadge map={ACTIVE} value={r.status} /> },
    { key: 'act', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (r) => (
      <div className="flex justify-end gap-0.5">
        <Button size="sm" variant="ghost" aria-label="Historial" icon={<History className="h-4 w-4" />} onClick={() => setHist(r)} />
        {canCorrect && r.status === 'valid' && <>
          <Button size="sm" variant="ghost" aria-label="Corregir" icon={<Pencil className="h-4 w-4" />} onClick={() => setCorr({ row: r, mode: 'update' })} />
          <Button size="sm" variant="ghost" aria-label="Anular" icon={<XCircle className="h-4 w-4 text-red" />} onClick={() => setCorr({ row: r, mode: 'void' })} />
        </>}
      </div>
    ) },
  ];

  return (
    <div>
      <FilterBar>
        {!serviceId && <Select aria-label="Servicio" value={f.svc} onChange={(e) => setF({ svc: e.target.value, hold: '' })}><option value="">Todos los servicios</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name}</option>)}</Select>}
        <SearchInput value={f.plate} onChange={(v) => setF({ plate: v })} placeholder="Placa" />
        <SearchInput value={f.ticket} onChange={(v) => setF({ ticket: v })} placeholder="Número de boleta" />
        <Select aria-label="Báscula" value={f.scale} onChange={(e) => setF({ scale: e.target.value })}><option value="">Todas las básculas</option>{scales.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        {service && <Select aria-label="Bodega" value={f.hold} onChange={(e) => setF({ hold: e.target.value })}><option value="">Todas las bodegas</option>{holds.data?.map((h) => <option key={h.id} value={h.id}>Bodega {h.hold_number}</option>)}</Select>}
        {service && !!bls.data?.length && <Select aria-label="BL" value={f.bl} onChange={(e) => setF({ bl: e.target.value })}><option value="">Todos los BL</option>{bls.data.map((b) => <option key={b.id} value={b.id}>BL {b.bl_number}</option>)}</Select>}
        <Select aria-label="Producto" value={f.prod} onChange={(e) => setF({ prod: e.target.value })}><option value="">Todos los productos</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        <Select aria-label="Turno" value={f.shift} onChange={(e) => setF({ shift: e.target.value })}><option value="">Todos los turnos</option>{shifts.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Input type="date" aria-label="Desde" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
        <Input type="date" aria-label="Hasta" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
        <Select aria-label="Estado" value={f.st} onChange={(e) => setF({ st: e.target.value })}><option value="valid">Válidos</option><option value="voided">Anulados</option><option value="">Todos</option></Select>
        <Button icon={<FileSpreadsheet className="h-4 w-4" />} loading={exporting} onClick={doExport}>Exportar Excel</Button>
      </FilterBar>
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} sort={{ key: f.sort, asc: f.dir === 'asc' }}
        onSort={(k) => setF({ sort: k, dir: f.sort === k && f.dir === 'desc' ? 'asc' : 'desc' })} rowClassName={(r) => (r.status === 'voided' ? 'opacity-60' : undefined)} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} />
      <p className="mt-2 text-[13px] text-mute">Ciclo = tiempo entre la pasada anterior del mismo camión y esta boleta (la primera pasada no tiene ciclo). En rojo, ciclos mayores a {longCycle} min.</p>
      {corr && <CorrectionDialog target={{ type: 'weigh_ticket', row: corr.row }} mode={corr.mode} tz={tz} onClose={() => setCorr(null)} />}
      <Modal open={!!hist} onClose={() => setHist(null)} title={`Historial de la boleta ${hist?.ticket_number ?? ''}`}>{hist && <RecordHistory targetId={hist.id} tz={tz} />}</Modal>
    </div>
  );
}
