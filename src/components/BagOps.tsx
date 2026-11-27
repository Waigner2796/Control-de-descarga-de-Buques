import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { XCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { rpc, supabase, unwrap, uuid } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useServiceCargo, type ShiftPeriod } from '@/lib/service-data';
import { periodLabel, shiftAt, usePlanShifts } from '@/lib/shifts';
import { dt, fmt0, fmt1, fmt2, fmt3, localInput, parseNum, time } from '@/lib/format';
import { Badge, Button, DataTable, Dot, ErrorBox, Field, Input, Notice, ReasonDialog, Section, Select, Tabs, useToast, type Column } from '@/components/ui';
import type { WeighSvc } from '@/pages/admin/Weighing';

type Tally = { id: string; service_hold_id: string; product_id: string; bl_id: string | null; shift_id: string; period_start: string; period_end: string; bags: number; net_tm: number; status: string; registered_by_name: string | null; registered_at: string; void_reason: string | null };
type Damage = { id: string; shift_id: string; period_start: string; dirty: number; broken: number; wet: number; to_sea: number; notes: string | null };
type Sample = { id: string; product_id: string; ticket_number: string; gross_kg: number; tare_kg: number; net_kg: number; temperature_c: number; sampled_at: string; shift_id: string | null; status: string; registered_by: string; registered_by_name: string | null; created_at: string };

/** Datos de sacos de un servicio (conteos, dañados, muestras), en tiempo real. */
export function useBagData(serviceId: string) {
  const tallies = useQuery({ queryKey: ['bag-tallies', serviceId], queryFn: async () => unwrap(await supabase.from('bag_tallies').select('id, service_hold_id, product_id, bl_id, shift_id, period_start, period_end, bags, net_tm, status, registered_by_name, registered_at, void_reason').eq('service_id', serviceId).order('period_start', { ascending: false }).order('registered_at', { ascending: false }).range(0, 4999)) as Tally[] });
  const damages = useQuery({ queryKey: ['bag-damages', serviceId], queryFn: async () => unwrap(await supabase.from('bag_damages').select('id, shift_id, period_start, dirty, broken, wet, to_sea, notes').eq('service_id', serviceId).order('period_start', { ascending: false })) as Damage[] });
  const samples = useQuery({ queryKey: ['bag-samples', serviceId], queryFn: async () => unwrap(await supabase.from('bag_samples').select('id, product_id, ticket_number, gross_kg, tare_kg, net_kg, temperature_c, sampled_at, shift_id, status, registered_by, registered_by_name, created_at').eq('service_id', serviceId).order('sampled_at', { ascending: false }).range(0, 4999)) as Sample[] });
  useRealtime('bag_tallies', `service_id=eq.${serviceId}`, [['bag-tallies', serviceId], ['service-kpis', serviceId]]);
  useRealtime('bag_samples', `service_id=eq.${serviceId}`, [['bag-samples', serviceId]]);
  return { tallies: tallies.data ?? [], damages: damages.data ?? [], samples: samples.data ?? [], refetch: () => { tallies.refetch(); damages.refetch(); samples.refetch(); } };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Pantalla del operador para servicios en sacos. */
export function BagWeighing({ svc }: { svc: WeighSvc }) {
  const tz = svc.timezone;
  const load = svc.operation_kind === 'load';
  const cargo = useServiceCargo(svc.id);
  const bag = useBagData(svc.id);
  const shifts = usePlanShifts(svc.shift_plan_id);
  const [tab, setTab] = useState('conteo');
  const cur = useMemo(() => (shifts.data ? shiftAt(shifts.data, localInput(new Date(), tz)) : null), [shifts.data, tz]);
  const [per, setPer] = useState({ shift: '', date: '' });
  useEffect(() => { if (cur && !per.shift) setPer({ shift: cur.shift.id, date: cur.date }); }, [cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const shift = shifts.data?.find((s) => s.id === per.shift);
  const inPeriod = (shiftId: string | null, iso: string) => shiftId === per.shift && localInput(iso, tz).slice(0, 10) === per.date;
  const perTallies = bag.tallies.filter((t) => t.status === 'valid' && inPeriod(t.shift_id, t.period_start));
  const perDamage = bag.damages.find((d) => inPeriod(d.shift_id, d.period_start));
  const perSamples = bag.samples.filter((s) => s.status === 'valid' && s.shift_id === per.shift && shiftAt(shifts.data ?? [], localInput(s.sampled_at, tz))?.date === per.date);
  const units = (tmv: number, productId: string) => { const b = cargo.bagOf(productId); return b ? (tmv * 1000) / b : 0; };
  const totalUnits = cargo.cargo.reduce((a, c) => a + units(Number(c.initial_tm), c.product_id), 0);
  const doneUnits = cargo.cargo.reduce((a, c) => a + units(Number(c.discharged_tm), c.product_id), 0);
  const perBags = perTallies.reduce((a, t) => a + t.bags, 0);
  const sAvg = avg(perSamples.map((s) => Number(s.net_kg)));
  const tAvg = avg(perSamples.map((s) => Number(s.temperature_c)));
  const target = cargo.products[0]?.bag_weight_kg ?? null;

  const periodPicker = (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Turno"><Select value={per.shift} onChange={(e) => setPer((p) => ({ ...p, shift: e.target.value }))}>{shifts.data?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)})</option>)}</Select></Field>
      <Field label="Fecha en que inició el turno"><Input type="date" value={per.date} onChange={(e) => setPer((p) => ({ ...p, date: e.target.value }))} /></Field>
    </div>
  );
  if (!svc.shift_plan_id || (shifts.data && !shifts.data.length)) return <Notice tone="warn">El servicio no tiene un esquema de turnos con turnos activos. Configúrelo en «Configuración › Turnos».</Notice>;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
      <div className="grid content-start gap-5">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'conteo', label: 'Conteo por turno' }, { id: 'peso', label: 'Peso de sacos' }, { id: 'danados', label: 'Sacos dañados' }]} />
        {tab === 'conteo' && <TallyForm svc={svc} cargo={cargo} periodPicker={periodPicker} per={per} shiftName={shift?.name} perTallies={perTallies} onDone={bag.refetch} />}
        {tab === 'peso' && <SampleForm svc={svc} cargo={cargo} samples={bag.samples} onDone={bag.refetch} />}
        {tab === 'danados' && <DamageForm svc={svc} periodPicker={periodPicker} per={per} current={perDamage} onDone={bag.refetch} />}
      </div>
      <aside className="grid content-start gap-5 xl:sticky xl:top-4 xl:self-start">
        <Section title="Acumulado para cuadrar">
          <div className="grid gap-3">
            <div className="rounded-lg bg-panel px-3 py-2.5">
              <div className="text-[13px] text-mute">{shift ? periodLabel(shift, per.date) : 'Turno'}</div>
              <div className="num mt-0.5 flex flex-wrap items-baseline gap-x-3"><span><b className="text-[22px]">{fmt0(perBags)}</b> sacos</span><span><b>{fmt2(perTallies.reduce((a, t) => a + Number(t.net_tm), 0))}</b> TM</span></div>
              {perTallies.length > 0 && <div className="mt-1 text-[13px] text-mute">{cargo.holds.map((h) => { const b = perTallies.filter((t) => t.service_hold_id === h.id).reduce((a, t) => a + t.bags, 0); return b ? `B${h.hold_number}: ${fmt0(b)}` : null; }).filter(Boolean).join(' · ')}</div>}
              <div className="mt-1 text-[13px] text-mute">Dañados: {perDamage ? fmt0(perDamage.dirty + perDamage.broken + perDamage.wet + perDamage.to_sea) : 0}</div>
            </div>
            <div className="rounded-lg bg-panel px-3 py-2.5">
              <div className="text-[13px] text-mute">Servicio · {load ? 'cargado' : 'descargado'}</div>
              <div className="num mt-0.5"><b className="text-[22px]">{fmt0(doneUnits)}</b> <span className="text-mute">de {fmt0(totalUnits)} sacos</span></div>
              <div className="text-[13px] text-mute">{fmt0(totalUnits - doneUnits)} sacos pendientes · {fmt1(cargo.discharged)} de {fmt0(cargo.initial)} TM</div>
            </div>
            <div className="rounded-lg bg-panel px-3 py-2.5">
              <div className="text-[13px] text-mute">Peso de sacos en el turno</div>
              <div className="num mt-0.5 flex flex-wrap items-baseline gap-x-3"><span><b className="text-[22px]">{fmt0(perSamples.length)}</b> sacos</span>
                <span>neto prom. <b>{sAvg == null ? '—' : `${fmt2(sAvg)} kg`}</b></span><span><b>{tAvg == null ? '—' : `${fmt1(tAvg)} °C`}</b></span></div>
              {target != null && sAvg != null && <div className="text-[13px] text-mute">Objetivo {fmt2(target)} kg · diferencia {sAvg - target >= 0 ? '+' : ''}{fmt2(sAvg - target)} kg</div>}
            </div>
          </div>
        </Section>
      </aside>
    </div>
  );
}

function TallyForm({ svc, cargo, periodPicker, per, shiftName, perTallies, onDone }: {
  svc: WeighSvc; cargo: ReturnType<typeof useServiceCargo>; periodPicker: React.ReactNode; per: { shift: string; date: string }; shiftName?: string; perTallies: Tally[]; onDone: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const lines = [...cargo.cargo].sort((a, b) => (cargo.holds.find((h) => h.id === a.service_hold_id)?.hold_number ?? 0) - (cargo.holds.find((h) => h.id === b.service_hold_id)?.hold_number ?? 0));
  const [rows, setRows] = useState<Record<string, { bags: string; bl: string }>>({});
  const [notes, setNotes] = useState('');
  const [reqId, setReqId] = useState(uuid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voidT, setVoidT] = useState<Tally | null>(null);
  const blsFor = (productId: string) => cargo.bls.filter((b) => b.product_id === productId && b.status === 'open');
  const rowOf = (id: string, productId: string) => rows[id] ?? { bags: '', bl: blsFor(productId)[0]?.id ?? '' };
  const pendBags = (c: (typeof lines)[number]) => { const b = cargo.bagOf(c.product_id); return b ? Math.floor(((Number(c.initial_tm) - Number(c.discharged_tm)) * 1000) / b) : 0; };
  const total = lines.reduce((a, c) => a + (Number(rowOf(c.id, c.product_id).bags) || 0), 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    const payload = lines.map((c) => ({ c, r: rowOf(c.id, c.product_id) })).filter(({ r }) => Number(r.bags) > 0)
      .map(({ c, r }) => ({ service_hold_id: c.service_hold_id, product_id: c.product_id, bl_id: r.bl || null, bags: Math.round(Number(r.bags)) }));
    if (!per.shift || !per.date) return setErr('Seleccione el turno y su fecha.');
    if (!payload.length) return setErr('Indique los sacos de al menos una bodega.');
    setBusy(true);
    try {
      const r = await rpc<{ bags: number; duplicate: boolean }>('register_bag_tally', { p: { client_request_id: reqId, service_id: svc.id, shift_id: per.shift, shift_date: per.date, rows: payload, notes } });
      toast(r.duplicate ? 'Este conteo ya estaba registrado.' : `Conteo registrado: ${fmt0(r.bags)} sacos · ${shiftName ?? ''}`);
      setRows({}); setNotes(''); setReqId(uuid()); onDone(); cargo.refetch(); qc.invalidateQueries({ queryKey: ['service-kpis', svc.id] });
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const canVoid = can('corrections.approve') || can('services.manage');
  return (
    <form onSubmit={submit} className="grid gap-5">
      <Section title={`Sacos ${svc.operation_kind === 'load' ? 'cargados' : 'descargados'} por bodega en el turno`}>
        {periodPicker}
        <div className="mt-4 grid gap-2">
          {lines.map((c) => {
            const h = cargo.holds.find((x) => x.id === c.service_hold_id); const r = rowOf(c.id, c.product_id); const opts = blsFor(c.product_id);
            const sp = cargo.products.find((p) => p.product_id === c.product_id);
            return (
              <div key={c.id} className="grid items-center gap-2 rounded-lg border border-line p-2.5 sm:grid-cols-[1fr_auto_150px]">
                <div><b className="font-cond text-[16px]">Bodega {h?.hold_number}</b> <span className="inline-flex items-center gap-1.5 text-[14px]"><Dot color={c.product.color} />{c.product.name}</span>
                  <div className="num text-[12.5px] text-mute">{fmt0(pendBags(c))} sacos pendientes · {fmt0(perTallies.filter((t) => t.service_hold_id === c.service_hold_id && t.product_id === c.product_id).reduce((a, t) => a + t.bags, 0))} ya contados en este turno</div></div>
                {sp?.uses_bl ? <Select aria-label={`BL de la bodega ${h?.hold_number}`} value={r.bl} onChange={(e) => setRows((x) => ({ ...x, [c.id]: { ...r, bl: e.target.value } }))}>{opts.length ? opts.map((b) => <option key={b.id} value={b.id}>BL {b.bl_number}</option>) : <option value="">Sin BL abierto</option>}</Select> : <span />}
                <Input aria-label={`Sacos de la bodega ${h?.hold_number}`} type="number" min="0" step="1" inputMode="numeric" placeholder="Sacos" className="num text-right text-[17px]" value={r.bags} onChange={(e) => setRows((x) => ({ ...x, [c.id]: { ...r, bags: e.target.value } }))} />
              </div>
            );
          })}
        </div>
        <Field label="Notas (opcional)" className="mt-3"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </Section>
      {err && <ErrorBox error={err} />}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!total}>Registrar conteo{total ? ` · ${fmt0(total)} sacos` : ''}</Button>
      {perTallies.length > 0 && (
        <Section title="Conteos registrados en este turno">
          <ul className="grid gap-1.5 text-[14px]">
            {perTallies.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-panel/60">
                <span className="flex-1">Bodega {cargo.holds.find((h) => h.id === t.service_hold_id)?.hold_number} · {cargo.products.find((p) => p.product_id === t.product_id)?.product.name}{t.bl_id && ` · BL ${cargo.bls.find((b) => b.id === t.bl_id)?.bl_number}`}<span className="block text-[12.5px] text-mute">{t.registered_by_name} · {time(t.registered_at, svc.timezone)}</span></span>
                <b className="num">{fmt0(t.bags)} sacos</b>
                {canVoid && <Button size="sm" variant="ghost" aria-label="Anular conteo" icon={<XCircle className="h-4 w-4 text-red" />} onClick={() => setVoidT(t)} />}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <ReasonDialog open={!!voidT} onClose={() => setVoidT(null)} title="Anular conteo" danger confirmLabel="Anular"
        description={voidT ? `Se revertirán ${fmt0(voidT.bags)} sacos (${fmt3(voidT.net_tm)} TM) del saldo y del BL. El registro se conserva como anulado.` : ''}
        onConfirm={async (reason) => { await rpc('void_bag_tally', { p_tally: voidT!.id, p_reason: reason }); toast('Conteo anulado'); setVoidT(null); onDone(); cargo.refetch(); }} />
    </form>
  );
}

function SampleForm({ svc, cargo, samples, onDone }: { svc: WeighSvc; cargo: ReturnType<typeof useServiceCargo>; samples: Sample[]; onDone: () => void }) {
  const { can, ctx } = useAuth();
  const toast = useToast();
  const [prod, setProd] = useState('');
  useEffect(() => { if (!prod && cargo.products[0]) setProd(cargo.products[0].product_id); }, [cargo.products]); // eslint-disable-line react-hooks/exhaustive-deps
  const sp = cargo.products.find((p) => p.product_id === prod);
  const tare = sp?.bag_tare_kg == null ? null : Number(sp.bag_tare_kg);
  const [v, setV] = useState({ ticket: '', gross: '', temp: '' });
  const [tareInput, setTareInput] = useState('');
  const [reqId, setReqId] = useState(uuid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voidS, setVoidS] = useState<Sample | null>(null);
  const grossRef = useRef<HTMLInputElement>(null);
  const g = parseNum(v.gross);
  const net = tare != null && Number.isFinite(g) ? g - tare : null;
  const ticketRows = samples.filter((s) => s.status === 'valid' && s.ticket_number === v.ticket.trim());
  const tNet = avg(ticketRows.map((s) => Number(s.net_kg)));
  const tTemp = avg(ticketRows.map((s) => Number(s.temperature_c)));
  const saveTare = async () => {
    try { await rpc('update_service_product', { p_service_product: sp!.id, p: { bag_tare_kg: Number(tareInput) } }); toast('Tara del saco guardada'); cargo.refetch(); }
    catch (e) { setErr((e as Error).message); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!v.ticket.trim()) return setErr('Escriba el número de boleta.');
    if (!(g > 0)) return setErr('Escriba el peso del saco.');
    if (v.temp.trim() === '') return setErr('Escriba la temperatura del saco (°C).');
    setBusy(true);
    try {
      const r = await rpc<{ net_kg: number; temperature_c: number }>('register_bag_sample', { p: { client_request_id: reqId, service_id: svc.id, product_id: prod, ticket_number: v.ticket.trim(), gross_kg: g, temperature_c: parseNum(v.temp) } });
      toast(`Saco registrado: neto ${fmt2(r.net_kg)} kg · ${fmt1(r.temperature_c)} °C`);
      setV((x) => ({ ...x, gross: '', temp: '' })); setReqId(uuid()); onDone(); grossRef.current?.focus();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const canVoidAny = can('corrections.approve') || can('services.manage');
  const recent = samples.filter((s) => s.status === 'valid').slice(0, 10);
  return (
    <div className="grid gap-5">
      <form onSubmit={submit} className="grid gap-5">
        <Section title="Peso de cada saco">
          <div className="grid gap-4 sm:grid-cols-2">
            {cargo.products.length > 1 && <Field label="Producto"><Select value={prod} onChange={(e) => setProd(e.target.value)}>{cargo.products.map((p) => <option key={p.product_id} value={p.product_id}>{p.product.name}</option>)}</Select></Field>}
            <Field label="Boleta (camión)" required hint="Se mantiene para registrar varios sacos del mismo camión."><Input value={v.ticket} onChange={(e) => setV((x) => ({ ...x, ticket: e.target.value }))} className="num text-[17px] font-semibold" /></Field>
          </div>
          {tare == null ? (
            <Notice tone="warn" className="mt-4">Falta la tara general del saco para este producto.{can('services.manage') && <span className="mt-2 flex gap-2"><Input type="number" step="0.001" min="0" placeholder="Tara (kg)" value={tareInput} onChange={(e) => setTareInput(e.target.value)} className="max-w-[140px]" /><Button size="sm" onClick={saveTare} disabled={tareInput === ''}>Guardar tara</Button></span>}</Notice>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Peso del saco (kg)" required><Input ref={grossRef} type="number" step="0.01" min="0" inputMode="decimal" value={v.gross} onChange={(e) => setV((x) => ({ ...x, gross: e.target.value }))} className="num text-right text-[18px]" /></Field>
              <Field label="Temperatura (°C)" required><Input type="number" step="0.1" inputMode="decimal" value={v.temp} onChange={(e) => setV((x) => ({ ...x, temp: e.target.value }))} className="num text-right text-[18px]" /></Field>
              <Field label="Neto = peso − tara"><div className="num flex min-h-[44px] items-center justify-end rounded-lg bg-seasoft px-3 text-[18px] font-bold">{net == null ? '—' : `${fmt2(net)} kg`}</div></Field>
              <p className="text-[13px] text-mute sm:col-span-3">Tara general del saco: <b>{fmt3(tare)} kg</b>{sp?.bag_weight_kg ? <> · objetivo neto <b>{fmt2(sp.bag_weight_kg)} kg</b></> : null}</p>
            </div>
          )}
        </Section>
        {err && <ErrorBox error={err} />}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={tare == null}>Registrar saco</Button>
      </form>
      {v.ticket.trim() && (
        <Section title={`Boleta ${v.ticket.trim()}: ${ticketRows.length} saco(s)`} actions={tNet != null && <span className="num text-[14px]">Promedio <b>{fmt2(tNet)} kg</b> · <b>{fmt1(tTemp)} °C</b></span>}>
          {ticketRows.length ? <ol className="num grid gap-1 text-[14px]">{ticketRows.map((s, i) => <li key={s.id} className="flex justify-between rounded px-2 py-1 odd:bg-panel/60"><span>Saco {ticketRows.length - i}</span><span>{fmt2(s.gross_kg)} kg · neto <b>{fmt2(s.net_kg)}</b> kg · {fmt1(s.temperature_c)} °C</span></li>)}</ol> : <p className="text-mute">Sin sacos registrados para esta boleta.</p>}
        </Section>
      )}
      <Section title="Últimos sacos registrados">
        {recent.length ? <ul className="grid gap-1 text-[14px]">{recent.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded px-2 py-1 odd:bg-panel/60">
            <span className="num w-11 text-mute">{time(s.sampled_at, svc.timezone)}</span>
            <span className="flex-1">Boleta <b className="num">{s.ticket_number}</b></span>
            <span className="num">{fmt2(s.net_kg)} kg · {fmt1(s.temperature_c)} °C</span>
            {(canVoidAny || (s.registered_by === ctx?.user_id && Date.now() - new Date(s.created_at).getTime() < 30 * 60e3)) && <Button size="sm" variant="ghost" aria-label="Anular saco" icon={<XCircle className="h-4 w-4 text-red" />} onClick={() => setVoidS(s)} />}
          </li>))}</ul> : <p className="text-mute">Sin registros todavía.</p>}
      </Section>
      <ReasonDialog open={!!voidS} onClose={() => setVoidS(null)} title="Anular registro de saco" danger confirmLabel="Anular" minLength={4}
        description={voidS ? `Boleta ${voidS.ticket_number} · ${fmt2(voidS.net_kg)} kg. El registro se conserva como anulado.` : ''}
        onConfirm={async (reason) => { await rpc('void_bag_sample', { p_sample: voidS!.id, p_reason: reason }); toast('Registro anulado'); setVoidS(null); onDone(); }} />
    </div>
  );
}

function DamageForm({ svc, periodPicker, per, current, onDone }: { svc: WeighSvc; periodPicker: React.ReactNode; per: { shift: string; date: string }; current?: Damage; onDone: () => void }) {
  const toast = useToast();
  const E = { dirty: '0', broken: '0', wet: '0', to_sea: '0', notes: '' };
  const [v, setV] = useState(E);
  useEffect(() => { setV(current ? { dirty: String(current.dirty), broken: String(current.broken), wet: String(current.wet), to_sea: String(current.to_sea), notes: current.notes ?? '' } : E); }, [current?.id, per.shift, per.date]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const L: [keyof typeof E, string][] = [['dirty', 'Sucios'], ['broken', 'Rotos'], ['wet', 'Mojados'], ['to_sea', 'Al mar']];
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await rpc('set_bag_damages', { p: { service_id: svc.id, shift_id: per.shift, shift_date: per.date, ...v } }); toast('Sacos dañados guardados'); onDone(); }
    catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={save} className="grid gap-5">
      <Section title="Sacos dañados o rechazados en el turno">
        {periodPicker}
        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">{L.map(([k, l]) => <Field key={k} label={l}><Input type="number" min="0" step="1" inputMode="numeric" className="num text-right text-[17px]" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} /></Field>)}</div>
        <Field label="Notas (opcional)" className="mt-3"><Input value={v.notes} onChange={(e) => setV((x) => ({ ...x, notes: e.target.value }))} /></Field>
        <p className="mt-2 text-[13px] text-mute">Se guarda un registro por turno; al volver a guardar se actualiza con auditoría.</p>
      </Section>
      {err && <ErrorBox error={err} />}
      <Button type="submit" variant="primary" size="lg" loading={busy}>Guardar sacos dañados · Total {fmt0(L.reduce((a, [k]) => a + (Number(v[k]) || 0), 0))}</Button>
    </form>
  );
}

/** Avance por turno (granel y sacos): cantidades por bodega, total del turno y acumulado. */
export function ShiftProgressTable({ periods, holds, tz, bags, load }: { periods: ShiftPeriod[]; holds: number[]; tz: string; bags: boolean; load: boolean }) {
  void tz;
  const f = (iso: string) => { const [d, t] = iso.split('T'); const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y} ${t}`; };
  if (!periods.length) return <p className="text-mute">Aún no hay registros por turno.</p>;
  const val = (p: ShiftPeriod, h: number) => { const x = p.holds.find((y) => y.hold_number === h); return bags ? fmt0(x?.bags ?? 0) : fmt3(x?.tm ?? 0); };
  const tot = (h: number) => periods.reduce((a, p) => { const x = p.holds.find((y) => y.hold_number === h); return a + Number(bags ? x?.bags ?? 0 : x?.tm ?? 0); }, 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="num w-full min-w-[720px] text-[13px]">
        <thead className="bg-panel text-mute"><tr>
          <th className="px-2 py-1.5 text-left">Turno</th><th className="px-2 py-1.5 text-left">Desde</th><th className="px-2 py-1.5 text-left">Hasta</th>
          {holds.map((h) => <th key={h} className="px-2 py-1.5 text-right">Bodega {h}</th>)}
          <th className="px-2 py-1.5 text-right">{load ? 'Cargado' : 'Descargado'} en turno</th><th className="px-2 py-1.5 text-right">Acumulado</th>
          {bags && <th className="px-2 py-1.5 text-right">Dañados</th>}
        </tr></thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.n} className="border-t border-line">
              <td className="px-2 py-1.5"><b>{p.n}</b> <span className="text-mute">{p.shift_name}</span></td><td className="whitespace-nowrap px-2 py-1.5">{f(p.from)}</td><td className="whitespace-nowrap px-2 py-1.5">{f(p.to)}</td>
              {holds.map((h) => <td key={h} className="px-2 py-1.5 text-right">{val(p, h)}</td>)}
              <td className="px-2 py-1.5 text-right font-semibold">{bags ? fmt0(p.bags ?? 0) : fmt3(p.tm)}</td>
              <td className="px-2 py-1.5 text-right">{bags ? fmt0(p.cum_bags) : fmt3(p.cum_tm)}</td>
              {bags && <td className="px-2 py-1.5 text-right" title={p.damaged ? `Sucios ${p.damaged.dirty} · Rotos ${p.damaged.broken} · Mojados ${p.damaged.wet} · Al mar ${p.damaged.to_sea}` : undefined}>{fmt0(p.damaged?.total ?? 0)}</td>}
            </tr>
          ))}
          <tr className="border-t-2 border-edge font-semibold"><td className="px-2 py-1.5" colSpan={3}>Total {bags ? '(sacos)' : '(TM)'}</td>
            {holds.map((h) => <td key={h} className="px-2 py-1.5 text-right">{bags ? fmt0(tot(h)) : fmt3(tot(h))}</td>)}
            <td className="px-2 py-1.5 text-right">{bags ? fmt0(periods.reduce((a, p) => a + (p.bags ?? 0), 0)) : fmt3(periods.reduce((a, p) => a + Number(p.tm), 0))}</td><td />
            {bags && <td className="px-2 py-1.5 text-right">{fmt0(periods.reduce((a, p) => a + (p.damaged?.total ?? 0), 0))}</td>}</tr>
        </tbody>
      </table>
    </div>
  );
}

/** Verificación del peso de sacos: promedio por boleta frente al objetivo, con gráfico. */
export function BagSamplesPanel({ serviceId, tz, target }: { serviceId: string; tz: string; target: number | null }) {
  const { samples } = useBagData(serviceId);
  const valid = samples.filter((s) => s.status === 'valid');
  const byTicket = useMemo(() => {
    const m = new Map<string, Sample[]>();
    [...valid].reverse().forEach((s) => m.set(s.ticket_number, [...(m.get(s.ticket_number) ?? []), s]));
    return [...m.entries()].map(([ticket, rows], i) => ({ n: i + 1, ticket, samples: rows.length, first: rows[0].sampled_at,
      avg_net: avg(rows.map((r) => Number(r.net_kg)))!, avg_temp: avg(rows.map((r) => Number(r.temperature_c)))!, target }));
  }, [valid, target]); // eslint-disable-line react-hooks/exhaustive-deps
  const cols: Column<(typeof byTicket)[number]>[] = [
    { key: 'n', header: 'Camión', align: 'right', cell: (r) => r.n },
    { key: 't', header: 'Boleta', cell: (r) => <b className="num">{r.ticket}</b> },
    { key: 'f', header: 'Primer saco', cell: (r) => dt(r.first, tz) },
    { key: 's', header: 'Sacos', align: 'right', cell: (r) => r.samples },
    { key: 'o', header: 'Objetivo (kg)', align: 'right', cell: () => (target == null ? '—' : fmt2(target)) },
    { key: 'a', header: 'Neto promedio (kg)', align: 'right', cell: (r) => <b>{fmt2(r.avg_net)}</b> },
    { key: 'c', header: 'Temperatura prom. (°C)', align: 'right', cell: (r) => fmt1(r.avg_temp) },
  ];
  if (!valid.length) return <p className="text-mute">Aún no hay sacos pesados en este servicio.</p>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[14px]">
        <span>Sacos verificados: <b className="num">{fmt0(valid.length)}</b></span>
        <span>Neto promedio: <b className="num">{fmt2(avg(valid.map((s) => Number(s.net_kg))))} kg</b>{target != null && <span className="text-mute"> (objetivo {fmt2(target)} kg)</span>}</span>
        <span>Temperatura promedio: <b className="num">{fmt1(avg(valid.map((s) => Number(s.temperature_c))))} °C</b></span>
      </div>
      <div className="h-[260px] min-w-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={byTicket} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="n" stroke="var(--axis)" tick={{ fill: 'rgb(var(--c-mute))', fontSize: 12 }} tickLine={false} label={{ value: 'Camiones', position: 'insideBottomRight', offset: -2, fill: 'rgb(var(--c-mute))', fontSize: 12 }} />
            <YAxis domain={['auto', 'auto']} stroke="var(--axis)" tick={{ fill: 'rgb(var(--c-mute))', fontSize: 12 }} tickLine={false} width={48} tickFormatter={(x) => fmt2(x)} />
            <Tooltip formatter={(x) => `${fmt2(x)} kg`} labelFormatter={(l) => `Camión ${l} · boleta ${byTicket[Number(l) - 1]?.ticket ?? ''}`} />
            <Legend />
            {target != null && <Line type="linear" dataKey="target" name="Objetivo" stroke="var(--s1)" strokeWidth={2} dot={false} isAnimationActive={false} />}
            <Line type="monotone" dataKey="avg_net" name="Neto promedio" stroke="var(--s2)" strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <DataTable columns={cols} rows={byTicket} rowKey={(r) => r.ticket} />
      <Badge tone="mute" className="justify-self-start">Neto = peso del saco − tara general de la presentación</Badge>
    </div>
  );
}
