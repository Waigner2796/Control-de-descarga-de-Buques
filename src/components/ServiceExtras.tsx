import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardPaste, Pencil, Plus, RotateCcw } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { rpc, supabase, unwrap } from '@/lib/supabase';
import { useServiceCargo, useServiceKpis } from '@/lib/service-data';
import { fmt0, fmt1, fmt3, fmtDpi, parseNum } from '@/lib/format';
import { Badge, Button, DataTable, Dot, ErrorBox, Field, Input, Meter, Modal, ReasonDialog, SearchInput, Section, Select, Textarea, useToast, type Column } from '@/components/ui';
import { BagSamplesPanel, ShiftProgressTable } from './BagOps';

type SvcRef = { id: string; status: string; timezone: string; cargo_type: 'bulk' | 'bags'; operation_kind: 'discharge' | 'load' };
const locked = (s: SvcRef) => ['finalized', 'cancelled'].includes(s.status);

/** BL del servicio: avance, terminar/reabrir, agregar y ajustar cantidad (auditado). */
export function BlTab({ svc }: { svc: SvcRef }) {
  const { can } = useAuth();
  const toast = useToast();
  const cargo = useServiceCargo(svc.id);
  const load = svc.operation_kind === 'load';
  const [add, setAdd] = useState<{ product_id: string; bl_number: string; qty: string } | null>(null);
  const [edit, setEdit] = useState<{ id: string; number: string; qty: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prodOf = (id: string) => cargo.products.find((p) => p.product_id === id);
  const units = (tmv: number, pid: string) => { const b = prodOf(pid)?.bag_weight_kg; return b ? (Number(tmv) * 1000) / Number(b) : null; };
  const setStatus = async (id: string, status: string) => { try { await rpc('set_bl_status', { p_bl: id, p_status: status }); cargo.refetch(); } catch (e) { toast((e as Error).message, 'bad'); } };
  const cols: Column<(typeof cargo.bls)[number]>[] = [
    { key: 'n', header: 'BL', cell: (b) => <b className="num">{b.bl_number}</b> },
    { key: 'p', header: 'Producto', cell: (b) => { const p = prodOf(b.product_id); return <span className="inline-flex items-center gap-1.5">{p && <Dot color={p.product.color} />}{p?.product.name}</span>; } },
    { key: 'q', header: 'Manifestado (TM)', align: 'right', cell: (b) => fmt3(b.planned_tm) },
    { key: 'd', header: `${load ? 'Cargado' : 'Descargado'} (TM)`, align: 'right', cell: (b) => <b>{fmt3(b.discharged_tm)}</b> },
    { key: 'f', header: 'Diferencia (TM)', align: 'right', cell: (b) => { const d = Number(b.discharged_tm) - Number(b.planned_tm); return <span className={d > 0 ? 'font-semibold text-red' : ''}>{d > 0 ? '+' : ''}{fmt3(d)}</span>; } },
    ...(svc.cargo_type === 'bags' ? [{ key: 'u', header: 'Sacos', align: 'right' as const, cell: (b: (typeof cargo.bls)[number]) => `${fmt0(units(b.discharged_tm, b.product_id))} / ${fmt0(units(b.planned_tm, b.product_id))}` }] : []),
    { key: 'm', header: 'Avance', cell: (b) => <div className="min-w-[110px]"><Meter value={Number(b.planned_tm) ? Math.min(100, (Number(b.discharged_tm) / Number(b.planned_tm)) * 100) : 0} /></div> },
    { key: 's', header: 'Estado', cell: (b) => <Badge tone={b.status === 'completed' ? 'ok' : 'info'}>{b.status === 'completed' ? 'Terminado' : 'En curso'}</Badge> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (b) => !locked(svc) && (
      <div className="flex justify-end gap-1">
        {b.status === 'open' ? <Button size="sm" variant="ghost" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setStatus(b.id, 'completed')}>Terminar</Button>
          : <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setStatus(b.id, 'open')}>Reabrir</Button>}
        {(can('cargo.adjust') || can('services.manage')) && <Button size="sm" variant="ghost" aria-label={`Editar BL ${b.bl_number}`} icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit({ id: b.id, number: b.bl_number, qty: String(Number(b.planned_tm)) })} />}
      </div>) },
  ];
  const saveAdd = async () => {
    setErr(null);
    try { await rpc('add_service_bl', { p_service: svc.id, p: { product_id: add!.product_id, bl_number: add!.bl_number, planned_tm: parseNum(add!.qty) } }); toast('BL agregado'); setAdd(null); cargo.refetch(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Section title="Conocimientos de embarque (BL)" actions={can('services.manage') && !locked(svc) && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdd({ product_id: cargo.products[0]?.product_id ?? '', bl_number: '', qty: '' })}>Agregar BL</Button>}>
      {cargo.bls.length ? <DataTable columns={cols} rows={cargo.bls} rowKey={(b) => b.id} /> : <p className="text-mute">Este servicio no maneja BL.</p>}
      <p className="mt-2 text-[13px] text-mute">«Terminar» quita el BL de la pantalla de pesaje para trabajar el siguiente; se puede reabrir. Lo {load ? 'cargado' : 'descargado'} por BL solo cambia con pesajes, anulaciones o correcciones auditadas.</p>
      <Modal open={!!add} onClose={() => setAdd(null)} title="Agregar BL" footer={<><Button onClick={() => setAdd(null)}>Cancelar</Button><Button variant="primary" onClick={saveAdd}>Agregar</Button></>}>
        {add && <div className="grid gap-3">
          <Field label="Producto"><Select value={add.product_id} onChange={(e) => setAdd({ ...add, product_id: e.target.value })}>{cargo.products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product.name}</option>)}</Select></Field>
          <Field label="Número de BL"><Input value={add.bl_number} onChange={(e) => setAdd({ ...add, bl_number: e.target.value })} /></Field>
          <Field label="Cantidad (TM)"><Input type="number" min="0" step="0.001" className="num text-right" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} /></Field>
          {err && <ErrorBox error={err} />}
        </div>}
      </Modal>
      <ReasonDialog open={!!edit} onClose={() => setEdit(null)} title="Ajustar BL" confirmLabel="Guardar" description="El cambio queda en la auditoría con su motivo."
        extra={edit && <div className="grid gap-3 sm:grid-cols-2"><Field label="Número de BL"><Input value={edit.number} onChange={(e) => setEdit({ ...edit, number: e.target.value })} /></Field><Field label="Cantidad (TM)"><Input type="number" step="0.001" className="num text-right" value={edit.qty} onChange={(e) => setEdit({ ...edit, qty: e.target.value })} /></Field></div>}
        onConfirm={async (reason) => { await rpc('update_service_bl', { p_bl: edit!.id, p: { bl_number: edit!.number, planned_tm: parseNum(edit!.qty) }, p_reason: reason }); toast('BL actualizado'); setEdit(null); cargo.refetch(); }} />
    </Section>
  );
}

type Truck = { id: string; plate: string; tractor_plate: string | null; driver_name: string; driver_dpi: string | null; carrier: string | null; status: string; created_at: string };

/** Lista de camiones y pilotos del servicio (no se comparte con otros servicios). */
export function TrucksTab({ svc }: { svc: SvcRef }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['service-trucks-all', svc.id], queryFn: async () => unwrap(await supabase.from('service_trucks').select('id, plate, tractor_plate, driver_name, driver_dpi, carrier, status, created_at').eq('service_id', svc.id).order('plate')) as Truck[] });
  const passes = useQuery({ queryKey: ['truck-passes', svc.id], queryFn: async () => unwrap(await supabase.from('weigh_tickets').select('truck_plate').eq('service_id', svc.id).eq('status', 'valid').range(0, 9999)) as { truck_plate: string }[] });
  const count = useMemo(() => { const m = new Map<string, number>(); (passes.data ?? []).forEach((r) => m.set(r.truck_plate, (m.get(r.truck_plate) ?? 0) + 1)); return m; }, [passes.data]);
  const [search, setSearch] = useState('');
  const [paste, setPaste] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const editable = !locked(svc) && can('services.manage');
  const rows = (q.data ?? []).filter((t) => !search || t.plate.includes(search.toUpperCase()) || t.driver_name.toLowerCase().includes(search.toLowerCase()));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['service-trucks-all', svc.id] }); qc.invalidateQueries({ queryKey: ['service-trucks', svc.id] }); };
  const save = async () => {
    setErr(null);
    const list = (paste ?? '').split(/\r?\n/).map((l) => l.split(/\t|;|,/).map((c) => c.trim())).filter((c) => c[0] && !/placa|plate/i.test(c[0]))
      .map((c) => ({ plate: c[0], driver_name: c[1] ?? '', tractor_plate: c[2] || null, driver_dpi: c[3] || null }));
    try { const r = await rpc<{ inserted: number; updated: number }>('upsert_service_trucks', { p_service: svc.id, p_rows: list }); toast(`${r.inserted} agregados · ${r.updated} actualizados`); setPaste(null); refresh(); }
    catch (e) { setErr((e as Error).message); }
  };
  const cols: Column<Truck>[] = [
    { key: 'p', header: 'Placa', cell: (t) => <b className="num">{t.plate}</b> },
    { key: 'd', header: 'Piloto', cell: (t) => <span>{t.driver_name}{t.driver_dpi && <span className="block text-[12px] text-mute">{fmtDpi(t.driver_dpi)}</span>}</span> },
    { key: 't', header: 'TC', hideBelow: 'md', cell: (t) => t.tractor_plate ?? '—' },
    { key: 'n', header: 'Pasadas', align: 'right', cell: (t) => fmt0(count.get(t.plate) ?? 0) },
    { key: 's', header: 'Estado', cell: (t) => <Badge tone={t.status === 'active' ? 'ok' : 'mute'}>{t.status === 'active' ? 'Activo' : 'Inactivo'}</Badge> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (t) => editable && (
      <Button size="sm" variant="ghost" onClick={async () => { try { await rpc('set_service_truck_status', { p_truck: t.id, p_status: t.status === 'active' ? 'inactive' : 'active' }); refresh(); } catch (e) { toast((e as Error).message, 'bad'); } }}>{t.status === 'active' ? 'Desactivar' : 'Activar'}</Button>) },
  ];
  return (
    <Section title={`Camiones y pilotos (${q.data?.length ?? 0})`} actions={<div className="flex gap-2"><SearchInput value={search} onChange={setSearch} placeholder="Placa o piloto" />{(editable || can('weighing.register')) && !locked(svc) && <Button size="sm" icon={<ClipboardPaste className="h-4 w-4" />} onClick={() => setPaste('')}>Agregar o pegar</Button>}</div>}>
      <DataTable columns={cols} rows={rows} rowKey={(t) => t.id} loading={q.isLoading} />
      <p className="mt-2 text-[13px] text-mute">Esta lista es solo de este servicio. Los camiones nuevos registrados en báscula se agregan automáticamente.</p>
      <Modal open={paste != null} onClose={() => setPaste(null)} title="Agregar camiones" footer={<><Button onClick={() => setPaste(null)}>Cancelar</Button><Button variant="primary" onClick={save} disabled={!paste?.trim()}>Guardar</Button></>}>
        <p className="mb-2 text-[14px] text-mute">Una fila por camión: <b>Placa, Piloto</b> y opcionalmente <b>Placa TC, DPI</b> (puede pegar desde Excel). Si la placa ya existe, se actualiza el piloto.</p>
        <Textarea rows={8} className="num" value={paste ?? ''} onChange={(e) => setPaste(e.target.value)} />
        {err && <ErrorBox error={err} />}
      </Modal>
    </Section>
  );
}

/** Avance por turno y, en servicios en sacos, verificación del peso de sacos. */
export function ShiftsTab({ svc, holds }: { svc: SvcRef; holds: number[] }) {
  const k = useServiceKpis(svc.id);
  const cargo = useServiceCargo(svc.id);
  const bags = svc.cargo_type === 'bags';
  return (
    <div className="grid gap-5">
      <Section title={`Avance por turno (${bags ? 'sacos' : 'TM'})`} actions={k.data && <span className="num text-[14px] text-mute">{fmt0(k.data.shift_periods.length)} turnos con registros</span>}>
        {k.data ? <ShiftProgressTable periods={k.data.shift_periods} holds={holds} tz={svc.timezone} bags={bags} load={svc.operation_kind === 'load'} /> : <p className="text-mute">Cargando…</p>}
      </Section>
      {bags && (
        <Section title="Verificación del peso de sacos">
          <BagSamplesPanel serviceId={svc.id} tz={svc.timezone} target={cargo.products[0]?.bag_weight_kg ?? null} />
        </Section>
      )}
      {bags && k.data && <p className="text-[13px] text-mute">Sacos dañados en el servicio: {fmt0(k.data.damaged_bags ?? 0)} · {fmt1(k.data.totals.discharged_tm)} TM {svc.operation_kind === 'load' ? 'cargadas' : 'descargadas'}.</p>}
    </div>
  );
}
