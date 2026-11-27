import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, Clock3, RotateCcw, Truck } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { rpc, supabase, unwrap, uuid } from '@/lib/supabase';
import { useRealtime, useScales } from '@/lib/hooks';
import { useServiceCargo } from '@/lib/service-data';
import { addDays, date, fmt0, fmt1, fmt2, localInput, minutes, parseNum, pct, time } from '@/lib/format';
import { TIME_MODE } from '@/lib/labels';
import { Badge, Button, Dot, EmptyState, ErrorBox, Field, Input, Meter, Notice, PageHeader, Section, Select, useToast } from '@/components/ui';
import { BagWeighing } from '@/components/BagOps';

export type WeighSvc = { id: string; service_number: string; vessel_name: string; customer_name: string; timezone: string; terminal_id: string;
  cargo_type: 'bulk' | 'bags'; operation_kind: 'discharge' | 'load'; shift_plan_id: string | null };
type SvcTruck = { id: string; plate: string; tractor_plate: string | null; driver_name: string; driver_dpi: string | null; status: string };
type Pass = { id: string; ticket_number: string; truck_plate: string; hold_number: number; product_name: string; bl_number: string | null;
  net_kg: number; net_tm: number; weighed_at: string; cycle_minutes: number | null; operation_date: string };
const EMPTY = { plate: '', driver: '', tc: '', dpi: '', gross: '', tare: '', ticket: '', notes: '', date: '', time: '' };
const store = {
  get: <T,>(k: string): T | null => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento local */ } },
};
const normPlate = (p: string) => p.toUpperCase().replace(/\s+/g, '');
export const seg = 'press flex min-h-[44px] flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-45';

/** Registro de pesaje: el operador elige el servicio; granel = boletas por báscula/punto; sacos = conteo por turno y peso de sacos. */
export default function Weighing() {
  const { orgId } = useOrg();
  const { ctx } = useAuth();
  const [sp] = useSearchParams();
  const services = useQuery({
    queryKey: ['weigh-services', orgId],
    queryFn: async () => unwrap(await supabase.from('service_overview').select('id, service_number, vessel_name, customer_name, timezone, terminal_id, cargo_type, operation_kind, shift_plan_id')
      .eq('organization_id', orgId).eq('status', 'in_operation').order('service_number')) as WeighSvc[],
  });
  const [svcId, setSvcId] = useState(sp.get('servicio') ?? store.get<string>('vc:pesaje:svc') ?? '');
  useEffect(() => { if (services.data && !services.data.some((s) => s.id === svcId)) setSvcId(services.data[0]?.id ?? ''); }, [services.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (svcId) store.set('vc:pesaje:svc', svcId); }, [svcId]);
  const svc = services.data?.find((s) => s.id === svcId);

  if (services.isLoading) return null;
  if (!services.data?.length) return <EmptyState icon={<Truck className="h-8 w-8" />} title="Sin servicios en operación asignados">Un administrador debe asignarle una báscula o punto del servicio (granel) o agregarlo como operador (sacos).</EmptyState>;
  return (
    <div className="pb-20 xl:pb-0">
      <PageHeader title="Registro de pesaje" sub={`Operador: ${ctx?.profile?.full_name ?? ''}`}
        actions={svc && <Badge tone={svc.cargo_type === 'bags' ? 'warn' : 'info'}>{svc.cargo_type === 'bags' ? 'Sacos' : 'Granel'} · {svc.operation_kind === 'load' ? 'Carga' : 'Descarga'}</Badge>} />
      <Field label="Servicio" className="mb-5 max-w-2xl">
        <Select value={svcId} onChange={(e) => setSvcId(e.target.value)}>
          {services.data.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name} · {s.customer_name} · {s.cargo_type === 'bags' ? 'sacos' : 'granel'}</option>)}
        </Select>
      </Field>
      {svc && (svc.cargo_type === 'bags' ? <BagWeighing key={svc.id} svc={svc} /> : <BulkWeighing key={svc.id} svc={svc} />)}
    </div>
  );
}

function BulkWeighing({ svc }: { svc: WeighSvc }) {
  const { orgId, membership } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const tz = svc.timezone;
  const load = svc.operation_kind === 'load';
  const scales = useScales(orgId);
  const svcScales = useQuery({ queryKey: ['svc-scale-ids', svc.id], queryFn: async () => (unwrap(await supabase.from('service_scales').select('scale_id').eq('service_id', svc.id)) as { scale_id: string }[]).map((x) => x.scale_id) });
  const isMaster = membership.role_code === 'master_admin';
  const mine = (scales.data ?? []).filter((s) => s.status === 'active' && svcScales.data?.includes(s.id) && (isMaster || membership.scale_ids.includes(s.id)));
  const [scaleId, setScaleId] = useState(store.get<string>(`vc:pesaje:scale:${svc.id}`) ?? '');
  useEffect(() => { if (mine.length && !mine.some((s) => s.id === scaleId)) setScaleId(mine[0].id); }, [mine.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (scaleId) store.set(`vc:pesaje:scale:${svc.id}`, scaleId); }, [scaleId, svc.id]);
  const scale = mine.find((s) => s.id === scaleId);

  const settings = useQuery({
    queryKey: ['scale-mode', scaleId], enabled: !!scale,
    queryFn: async () => {
      const [ss, ts, th, os] = await Promise.all([
        supabase.from('scale_settings').select('time_capture_mode').eq('scale_id', scaleId).maybeSingle(),
        supabase.from('terminal_settings').select('time_capture_mode').eq('terminal_id', scale!.terminal_id).maybeSingle(),
        supabase.from('operational_thresholds').select('long_cycle_minutes').eq('organization_id', orgId).maybeSingle(),
        supabase.from('organization_settings').select('weight_input_unit').eq('organization_id', orgId).maybeSingle(),
      ]);
      return { mode: (ss.data?.time_capture_mode ?? ts.data?.time_capture_mode ?? 'manual') as 'manual' | 'server_now', longCycle: Number(th.data?.long_cycle_minutes ?? 90), unit: (os.data?.weight_input_unit ?? 'kg') as 'kg' | 'tm' };
    },
  });
  const mode = settings.data?.mode ?? 'manual';
  const unit = settings.data?.unit ?? 'kg';
  const longCycle = settings.data?.longCycle ?? 90;

  // BL / producto / bodega activos (se recuerdan por báscula y servicio)
  const cargo = useServiceCargo(svc.id);
  const selKey = `vc:pesaje:sel:${scaleId}:${svc.id}`;
  const [sel, setSel] = useState({ bl: '', prod: '', hold: '' });
  useEffect(() => { setSel(store.get(selKey) ?? { bl: '', prod: '', hold: '' }); }, [selKey]);
  useEffect(() => { if (scaleId) store.set(selKey, sel); }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const pendOf = (cId: string) => { const c = cargo.cargo.find((x) => x.id === cId); return c ? Number(c.initial_tm) - Number(c.discharged_tm) : 0; };
  const openBls = cargo.bls.filter((b) => b.status === 'open');
  const doneBls = cargo.bls.filter((b) => b.status === 'completed');
  const bl = openBls.find((b) => b.id === sel.bl) ?? null;
  const prodId = bl?.product_id ?? sel.prod;
  const sProd = cargo.products.find((p) => p.product_id === prodId);
  const needsBl = !!sProd?.uses_bl;
  const noBlProducts = cargo.products.filter((p) => !p.uses_bl);
  useEffect(() => {
    if (!cargo.products.length) return;
    if (bl || (sProd && !sProd.uses_bl)) return;
    if (openBls[0]) setSel((s) => ({ ...s, bl: openBls[0].id, prod: openBls[0].product_id }));
    else if (noBlProducts[0]) setSel((s) => ({ ...s, bl: '', prod: noBlProducts[0].product_id }));
  }, [cargo.products, cargo.bls]); // eslint-disable-line react-hooks/exhaustive-deps
  const holdOpts = cargo.cargo.filter((c) => c.product_id === prodId)
    .map((c) => ({ line: c, hold: cargo.holds.find((h) => h.id === c.service_hold_id), pending: pendOf(c.id) }))
    .sort((a, b) => (a.hold?.hold_number ?? 0) - (b.hold?.hold_number ?? 0));
  useEffect(() => {
    if (!holdOpts.length || holdOpts.some((o) => o.line.service_hold_id === sel.hold && o.pending > 0)) return;
    const o = holdOpts.find((x) => x.pending > 0) ?? holdOpts[0];
    setSel((s) => ({ ...s, hold: o.line.service_hold_id }));
  }, [prodId, cargo.cargo]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = holdOpts.find((o) => o.line.service_hold_id === sel.hold)?.line;

  // Camiones del servicio
  const trucks = useQuery({ queryKey: ['service-trucks', svc.id], queryFn: async () => unwrap(await supabase.from('service_trucks').select('id, plate, tractor_plate, driver_name, driver_dpi, status').eq('service_id', svc.id).order('plate')) as SvcTruck[] });
  const [v, setV] = useState(EMPTY);
  const known = trucks.data?.find((t) => t.plate === normPlate(v.plate));
  useEffect(() => { if (known) setV((x) => ({ ...x, driver: known.driver_name, tc: known.tractor_plate ?? '', dpi: known.driver_dpi ?? '' })); }, [known?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hora única del pesaje
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const i = setInterval(() => setNow(new Date()), mode === 'server_now' ? 1000 : 30_000); return () => clearInterval(i); }, [mode]);
  const resetTime = () => { const l = localInput(new Date(), tz); setV((x) => ({ ...x, date: l.slice(0, 10), time: l.slice(11, 16) })); };
  useEffect(resetTime, [tz]); // eslint-disable-line react-hooks/exhaustive-deps
  const nowLocal = localInput(now, tz);
  const typed = v.date && v.time ? `${v.date}T${v.time}` : '';
  const future = mode === 'manual' && !!typed && typed > localInput(new Date(now.getTime() + 5 * 60e3), tz);

  // Acumulado de la báscula en el servicio
  const acc = useQuery({
    queryKey: ['scale-acc', scaleId, svc.id], enabled: !!scaleId,
    queryFn: async () => unwrap(await supabase.from('operational_cycles').select('id, ticket_number, truck_plate, hold_number, product_name, bl_number, net_kg, net_tm, weighed_at, cycle_minutes, operation_date')
      .eq('scale_id', scaleId).eq('service_id', svc.id).eq('status', 'valid').order('weighed_at', { ascending: false }).range(0, 4999)) as Pass[],
  });
  useRealtime('weigh_tickets', scaleId ? `scale_id=eq.${scaleId}` : null, [['scale-acc', scaleId, svc.id]], !!scaleId);
  const today = nowLocal.slice(0, 10);
  const sum = (rows: Pass[]) => ({ n: rows.length, kg: rows.reduce((a, r) => a + Number(r.net_kg), 0) });
  const accAll = useMemo(() => sum(acc.data ?? []), [acc.data]);
  const accToday = useMemo(() => sum((acc.data ?? []).filter((r) => r.operation_date === today)), [acc.data, today]);
  const accBl = useMemo(() => sum((acc.data ?? []).filter((r) => bl && r.bl_number === bl.bl_number)), [acc.data, bl]);

  const g = parseNum(v.gross), t = parseNum(v.tare);
  const netKg = unit === 'tm' ? (g - t) * 1000 : g - t;
  const netOk = Number.isFinite(netKg) && netKg > 0;
  const pending = line ? pendOf(line.id) : 0;
  const over = netOk && netKg / 1000 > pending + 1e-9;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const [reqId, setReqId] = useState(uuid());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finishBl = async () => {
    if (!bl) return;
    try {
      await rpc('set_bl_status', { p_bl: bl.id, p_status: 'completed' });
      const next = openBls.find((b) => b.id !== bl.id && b.product_id === bl.product_id) ?? openBls.find((b) => b.id !== bl.id);
      setSel((s) => ({ ...s, bl: next?.id ?? '', prod: next?.product_id ?? s.prod }));
      toast(`BL ${bl.bl_number} terminado${next ? ` · ahora BL ${next.bl_number}` : ''}`);
      cargo.refetch();
    } catch (e) { setErr((e as Error).message); }
  };
  const reopenBl = async (id: string) => {
    try { await rpc('set_bl_status', { p_bl: id, p_status: 'open' }); cargo.refetch(); setSel((s) => ({ ...s, bl: id })); }
    catch (e) { setErr((e as Error).message); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!scale) return setErr('Seleccione la báscula o punto de descarga.');
    if (needsBl && !bl) return setErr('Seleccione el BL que se está trabajando.');
    if (!line) return setErr('Seleccione la bodega.');
    if (!normPlate(v.plate)) return setErr('Seleccione o escriba la placa del camión.');
    if (v.driver.trim().length < 2) return setErr('Escriba el nombre del piloto.');
    if (!v.ticket.trim()) return setErr('Escriba el número de boleta.');
    if (!netOk) return setErr('El peso bruto debe ser mayor que la tara.');
    if (over) return setErr(`El neto (${fmt2(netKg / 1000)} TM) excede el saldo pendiente (${fmt2(pending)} TM) de la bodega. Solicite un ajuste de tonelaje.`);
    if (mode === 'manual' && !typed) return setErr('Registre la hora del pesaje.');
    if (future) return setErr('La hora del pesaje no puede estar en el futuro.');
    setBusy(true);
    try {
      const r = await rpc<{ net_tm: number; net_kg: number; duplicate: boolean; cycle_seconds: number | null; new_truck: boolean }>('register_weigh_ticket', { p: {
        client_request_id: reqId, scale_id: scaleId, service_id: svc.id, service_hold_id: sel.hold, product_id: prodId, bl_id: bl?.id ?? null,
        ticket_number: v.ticket.trim(), service_truck_id: known?.id ?? null, truck_plate: v.plate, driver_name: v.driver.trim(), tractor_plate: v.tc, driver_dpi: v.dpi,
        gross: v.gross, tare: v.tare, weight_unit: unit, notes: v.notes, weighed_local: mode === 'manual' ? typed : null,
      } });
      if (r.duplicate) toast('Esta boleta ya estaba registrada (no se duplicó).', 'info');
      else toast(`Boleta ${v.ticket.trim()}: ${fmt0(r.net_kg)} kg · ${fmt2(r.net_tm)} TM · ${r.cycle_seconds == null ? 'primera pasada del camión' : `ciclo ${minutes(Number(r.cycle_seconds) / 60)}`}`);
      if (r.new_truck) toast(`Camión ${normPlate(v.plate)} agregado a la lista del servicio`, 'info');
      setV(EMPTY); resetTime(); setReqId(uuid());
      ['scale-acc', 'cycles', 'dashboard', 'service-trucks'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      cargo.refetch();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };

  if (scales.isLoading || svcScales.isLoading) return null;
  if (!mine.length) return <Notice tone="warn">No tiene una báscula o punto de descarga asignado en este servicio. Un administrador debe asignárselo.</Notice>;
  const blProd = (id: string) => cargo.products.find((p) => p.product_id === id)?.product;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
      <form onSubmit={submit} className="grid content-start gap-5">
        <Section title="Báscula, BL y bodega" actions={<Badge tone="info"><Clock3 className="h-3.5 w-3.5" />{TIME_MODE[mode]}</Badge>}>
          <div className="grid gap-4">
            <div><div className="lbl mb-1.5">Báscula / punto de descarga</div><div className="flex flex-wrap gap-2">{mine.map((s) => <button type="button" key={s.id} aria-pressed={s.id === scaleId} onClick={() => setScaleId(s.id)} className={clsx(seg, s.id === scaleId ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}>{s.name}<span className="text-[12px] font-normal text-mute">{s.location || s.code}</span></button>)}</div></div>
            {cargo.bls.length > 0 && (
              <div>
                <div className="lbl mb-1.5 flex items-center gap-2">BL que se está trabajando{bl && <Button type="button" size="sm" variant="ghost" icon={<CheckCircle2 className="h-4 w-4" />} onClick={finishBl}>Terminar BL {bl.bl_number}</Button>}</div>
                <div className="flex flex-wrap gap-2">
                  {openBls.map((b) => { const left = Number(b.planned_tm) - Number(b.discharged_tm); const pr = blProd(b.product_id); return (
                    <button type="button" key={b.id} aria-pressed={b.id === bl?.id} onClick={() => setSel((s) => ({ ...s, bl: b.id, prod: b.product_id }))} className={clsx(seg, b.id === bl?.id ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}>
                      <span className="inline-flex items-center gap-1.5">{pr && <Dot color={pr.color} />}BL {b.bl_number}</span>
                      <span className="num text-[12px] font-normal text-mute">{pr?.name} · {left > 0 ? `${fmt1(left)} TM por ${load ? 'cargar' : 'descargar'}` : `excedido ${fmt1(-left)} TM`}</span>
                    </button>); })}
                  {noBlProducts.map((p) => <button type="button" key={p.id} aria-pressed={!bl && prodId === p.product_id} onClick={() => setSel((s) => ({ ...s, bl: '', prod: p.product_id }))} className={clsx(seg, !bl && prodId === p.product_id ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}><span className="inline-flex items-center gap-1.5"><Dot color={p.product.color} />{p.product.name}</span><span className="text-[12px] font-normal text-mute">sin BL</span></button>)}
                </div>
                {doneBls.length > 0 && <p className="mt-2 text-[13px] text-mute">Terminados: {doneBls.map((b, i) => <span key={b.id}>{i > 0 && ' · '}BL {b.bl_number} <button type="button" className="font-semibold text-sea hover:underline" onClick={() => reopenBl(b.id)}><RotateCcw className="inline h-3 w-3" /> reabrir</button></span>)}</p>}
              </div>
            )}
            {cargo.bls.length === 0 && cargo.products.length > 1 && (
              <div><div className="lbl mb-1.5">Producto</div><div className="flex flex-wrap gap-2">{cargo.products.map((p) => <button type="button" key={p.id} aria-pressed={prodId === p.product_id} onClick={() => setSel((s) => ({ ...s, prod: p.product_id }))} className={clsx(seg, prodId === p.product_id ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}><span className="inline-flex items-center gap-1.5"><Dot color={p.product.color} />{p.product.name}</span></button>)}</div></div>
            )}
            <div><div className="lbl mb-1.5">Bodega</div><div className="flex flex-wrap gap-2">{holdOpts.map((o) => <button type="button" key={o.line.id} disabled={o.pending <= 0} aria-pressed={o.line.service_hold_id === sel.hold} onClick={() => setSel((s) => ({ ...s, hold: o.line.service_hold_id }))} className={clsx(seg, o.line.service_hold_id === sel.hold ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}>Bodega {o.hold?.hold_number}<span className="num text-[12px] font-normal text-mute">{o.pending <= 0 ? 'completa' : `${fmt0(o.pending)} TM`}</span></button>)}</div></div>
          </div>
        </Section>

        <Section title="Camión y piloto">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Placa del camión" required hint={!v.plate ? `${trucks.data?.length ?? 0} camiones en la lista del servicio` : known ? 'Camión de la lista del servicio' : 'Camión nuevo: se agregará a la lista del servicio'}>
              <Input list="svc-plates" value={v.plate} onChange={(e) => setV((x) => ({ ...x, plate: e.target.value.toUpperCase() }))} autoComplete="off" className="num text-[17px] font-semibold" />
            </Field>
            <datalist id="svc-plates">{trucks.data?.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.plate}>{x.driver_name}</option>)}</datalist>
            <Field label="Piloto" required><Input value={v.driver} onChange={set('driver')} /></Field>
            <Field label="Placa TC (opcional)"><Input value={v.tc} onChange={(e) => setV((x) => ({ ...x, tc: e.target.value.toUpperCase() }))} /></Field>
            <Field label="DPI (opcional)" hint="13 dígitos"><Input inputMode="numeric" value={v.dpi} onChange={set('dpi')} /></Field>
          </div>
        </Section>

        <Section title="Boleta de pesaje">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Número de boleta" required><Input value={v.ticket} onChange={set('ticket')} className="num text-[17px] font-semibold" /></Field>
            <Field label={`Peso bruto (${unit === 'kg' ? 'kg' : 'TM'})`} required><Input type="number" step={unit === 'kg' ? '1' : '0.001'} min="0" inputMode="decimal" value={v.gross} onChange={set('gross')} className="num text-right text-[18px]" /></Field>
            <Field label={`Tara (${unit === 'kg' ? 'kg' : 'TM'})`} required><Input type="number" step={unit === 'kg' ? '1' : '0.001'} min="0" inputMode="decimal" value={v.tare} onChange={set('tare')} className="num text-right text-[18px]" /></Field>
          </div>
          <div className={clsx('mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-xl px-4 py-3', netOk && !over ? 'bg-seasoft' : v.gross && v.tare ? 'bg-redsoft' : 'bg-panel')}>
            <span className="text-[14px] text-mute">Peso neto = bruto − tara</span>
            <span className={clsx('num text-[28px] font-bold', (!netOk || over) && v.gross && v.tare && 'text-red')}>{Number.isFinite(netKg) ? `${fmt0(netKg)} kg · ${fmt2(netKg / 1000)} TM` : '—'}</span>
            {v.gross && v.tare && !netOk && <span className="w-full text-[14px] text-red">El peso bruto debe ser mayor que la tara.</span>}
            {over && <span className="w-full text-[14px] text-red">Excede el saldo pendiente de {fmt2(pending)} TM de la bodega.</span>}
          </div>
          <div className="mt-4">
            {mode === 'manual' ? (
              <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <Field label="Fecha"><Input type="date" value={v.date} onChange={set('date')} /></Field>
                <Field label="Hora del pesaje" required><Input type="time" value={v.time} onChange={set('time')} /></Field>
                <Button type="button" onClick={resetTime}>Hora actual</Button>
                <p className="text-[13px] text-mute sm:col-span-3">Una sola hora por boleta: el ciclo se calcula contra la pasada anterior del mismo camión.</p>
                {future && <Notice tone="warn" className="sm:col-span-3">La hora es posterior a la actual. Si la boleta es de ayer, <button type="button" className="font-semibold underline" onClick={() => setV((x) => ({ ...x, date: addDays(x.date, -1) }))}>use la fecha {date(addDays(v.date, -1))}</button>.</Notice>}
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-panel px-4 py-3">
                <span className="text-[14px] text-mute">La hora la registra el servidor al guardar la boleta.</span>
                <span className="num text-[22px] font-bold">{time(now, tz, true)}</span>
              </div>
            )}
          </div>
          <Field label="Notas (opcional)" className="mt-4"><Input value={v.notes} onChange={set('notes')} /></Field>
        </Section>
        {err && <ErrorBox error={err} />}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!line}>Registrar boleta{v.ticket ? ` ${v.ticket}` : ''}</Button>
      </form>

      <aside className="grid content-start gap-5 xl:sticky xl:top-4 xl:self-start">
        <Section title="Acumulado para cuadrar">
          <div className="grid gap-3">
            <AccRow title={`${scale?.name ?? 'Báscula'} · hoy`} n={accToday.n} kg={accToday.kg} />
            <AccRow title={`${scale?.name ?? 'Báscula'} · todo el servicio`} n={accAll.n} kg={accAll.kg} />
            {bl && (
              <div className="rounded-lg border border-line p-3">
                <div className="flex items-baseline justify-between gap-2"><b>BL {bl.bl_number}</b><span className="text-[13px] text-mute">{blProd(bl.product_id)?.name}</span></div>
                <div className="num mt-1 text-[22px] font-bold">{fmt2(bl.discharged_tm)} <span className="text-[14px] font-medium text-mute">de {fmt0(bl.planned_tm)} TM</span></div>
                <Meter value={Number(bl.planned_tm) ? (Number(bl.discharged_tm) / Number(bl.planned_tm)) * 100 : 0} tone={Number(bl.discharged_tm) > Number(bl.planned_tm) ? 'red' : 'sea'} />
                <div className="mt-1 flex justify-between text-[13px] text-mute"><span>Esta báscula: {fmt0(accBl.n)} boletas · {fmt0(accBl.kg)} kg</span><span>{fmt1(Number(bl.planned_tm) - Number(bl.discharged_tm))} TM restantes</span></div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 text-[14px]">
              <div><div className="text-mute">Bodega seleccionada</div><b className="num">{fmt1(pending)} TM</b></div>
              <div><div className="text-mute">Buque · {load ? 'cargado' : 'descargado'}</div><b className="num">{pct(cargo.initial ? (cargo.discharged / cargo.initial) * 100 : 0)}</b></div>
            </div>
          </div>
        </Section>
        <Section title="Últimas boletas de esta báscula">
          {acc.data?.length ? (
            <ol className="grid gap-1.5">
              {acc.data.slice(0, 8).map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[14px] odd:bg-panel/60">
                  <span className="num w-11 text-mute">{time(r.weighed_at, tz)}</span>
                  <span className="min-w-0 flex-1 truncate"><b>{r.truck_plate}</b> · {r.ticket_number}<span className="block text-[12.5px] text-mute">B{r.hold_number}{r.bl_number ? ` · BL ${r.bl_number}` : ` · ${r.product_name}`} · {r.cycle_minutes == null ? '1.ª pasada' : <>ciclo <span className={Number(r.cycle_minutes) > longCycle ? 'font-semibold text-red' : ''}>{minutes(r.cycle_minutes)}</span></>}</span></span>
                  <span className="num font-semibold">{fmt0(r.net_kg)} kg</span>
                </li>
              ))}
            </ol>
          ) : <p className="text-mute">Sin boletas todavía.</p>}
        </Section>
      </aside>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 px-4 py-2 backdrop-blur xl:hidden" aria-live="polite">
        <div className="num mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-x-4 text-[14px]">
          <span><span className="text-mute">Hoy:</span> <b>{fmt0(accToday.n)}</b> boletas · <b>{fmt0(accToday.kg)}</b> kg</span>
          {bl && <span><span className="text-mute">BL {bl.bl_number}:</span> <b>{fmt1(Number(bl.planned_tm) - Number(bl.discharged_tm))}</b> TM restantes</span>}
        </div>
      </div>
    </div>
  );
}

export function AccRow({ title, n, kg, unitsLabel }: { title: string; n: number; kg: number; unitsLabel?: string }) {
  return (
    <div className="rounded-lg bg-panel px-3 py-2.5">
      <div className="text-[13px] text-mute">{title}</div>
      <div className="num mt-0.5 flex flex-wrap items-baseline gap-x-3 text-[15px]">
        <span><b className="text-[20px]">{fmt0(n)}</b> {unitsLabel ?? 'boletas'}</span>
        <span><b>{fmt0(kg)}</b> kg</span>
        <span><b>{fmt2(kg / 1000)}</b> TM</span>
      </div>
    </div>
  );
}
