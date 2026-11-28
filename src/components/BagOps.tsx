import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { XCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { rpc, supabase, unwrap, uuid } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { useServiceCargo, type ShiftPeriod } from '@/lib/service-data';
import { periodLabel, shiftAt, usePlanShifts, type Shift } from '@/lib/shifts';
import { dt, fmt0, fmt1, fmt2, fmt3, localInput, parseNum, time } from '@/lib/format';
import { Badge, Button, DataTable, Dot, ErrorBox, Field, Input, Notice, ReasonDialog, Section, Select, Tabs, useToast, type Column } from '@/components/ui';
import type { WeighSvc } from '@/pages/admin/Weighing';

type Tally = { id: string; service_hold_id: string; product_id: string; bl_id: string | null; shift_id: string | null; period_start: string | null; period_end: string | null; bags: number; net_tm: number; status: string;
  registered_by_name: string | null; registered_at: string; void_reason: string | null; ticket_number: string; truck_plate: string; tractor_plate: string | null; lot: string | null; tallied_at: string; batch_id: string };
type Damage = { id: string; shift_id: string; period_start: string; dirty: number; broken: number; wet: number; to_sea: number; notes: string | null };
type Sample = { id: string; product_id: string; ticket_number: string; gross_kg: number; tare_kg: number; net_kg: number; temperature_c: number; sampled_at: string; shift_id: string | null; status: string; registered_by: string; registered_by_name: string | null; created_at: string };

/** Datos de sacos de un servicio (conteos, dañados, muestras), en tiempo real. */
export function useBagData(serviceId: string) {
  const tallies = useQuery({ queryKey: ['bag-tallies', serviceId], queryFn: async () => unwrap(await supabase.from('bag_tallies').select('id, service_hold_id, product_id, bl_id, shift_id, period_start, period_end, bags, net_tm, status, registered_by_name, registered_at, void_reason, ticket_number, truck_plate, tractor_plate, lot, tallied_at, batch_id').eq('service_id', serviceId).order('tallied_at', { ascending: false }).range(0, 4999)) as Tally[] });
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
  const perTallies = bag.tallies.filter((t) => t.status === 'valid' && t.period_start && inPeriod(t.shift_id, t.period_start));
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
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'conteo', label: 'Boleta de sacos' }, { id: 'peso', label: 'Peso de sacos' }, { id: 'danados', label: 'Sacos dañados' }]} />
        {tab === 'conteo' && <TallyForm svc={svc} cargo={cargo} shifts={shifts.data ?? []} tallies={bag.tallies} onDone={bag.refetch} />}
        {tab === 'peso' && <SampleForm svc={svc} cargo={cargo} samples={bag.samples} onDone={bag.refetch} />}
        {tab === 'danados' && <DamageForm svc={svc} periodPicker={periodPicker} per={per} current={perDamage} onDone={bag.refetch} />}
      </div>
      <aside className="grid content-start gap-5 xl:sticky xl:top-4 xl:self-start">
        <Section title="Acumulado para cuadrar">
          <div className="grid gap-3">
            {periodPicker}
            <div className="rounded-lg bg-panel px-3 py-2.5">
              <div className="text-[13px] text-mute">{shift ? periodLabel(shift, per.date) : 'Turno'}</div>
              <div className="num mt-0.5 flex flex-wrap items-baseline gap-x-3"><span><b className="text-[22px]">{fmt0(perBags)}</b> sacos</span><span><b>{fmt0(new Set(perTallies.map((t) => t.batch_id)).size)}</b> boletas</span><span><b>{fmt2(perTallies.reduce((a, t) => a + Number(t.net_tm), 0))}</b> TM</span></div>
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

const store = {
  get: <T,>(k: string): T | null => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set: (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento local */ } },
};
const seg = (on: boolean) => `press flex min-h-[44px] flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-45 ${on ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel'}`;

/** Boleta de sacos de un camión: placa, TC, número de boleta, bodega, BL y lotes con su cantidad de sacos. */
function TallyForm({ svc, cargo, shifts, tallies, onDone }: { svc: WeighSvc; cargo: ReturnType<typeof useServiceCargo>; shifts: Shift[]; tallies: Tally[]; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const tz = svc.timezone;
  const trucks = useQuery({ queryKey: ['service-trucks', svc.id], queryFn: async () => unwrap(await supabase.from('service_trucks').select('id, plate, tractor_plate, driver_name, status').eq('service_id', svc.id).order('plate')) as { id: string; plate: string; tractor_plate: string | null; status: string }[] });
  const selKey = `vc:sacos:sel:${svc.id}`;
  const [sel, setSel] = useState<{ hold: string; bl: string; prod: string }>(() => store.get(selKey) ?? { hold: '', bl: '', prod: '' });
  useEffect(() => { store.set(selKey, sel); }, [sel, selKey]);
  const openBls = cargo.bls.filter((b) => b.status === 'open');
  const bl = openBls.find((b) => b.id === sel.bl) ?? null;
  const prodId = bl?.product_id ?? sel.prod;
  const sp = cargo.products.find((p) => p.product_id === prodId);
  useEffect(() => {
    if (!cargo.products.length || bl || (sp && !sp.uses_bl)) return;
    if (openBls[0]) setSel((x) => ({ ...x, bl: openBls[0].id, prod: openBls[0].product_id }));
    else { const p = cargo.products.find((x) => !x.uses_bl); if (p) setSel((x) => ({ ...x, bl: '', prod: p.product_id })); }
  }, [cargo.products, cargo.bls]); // eslint-disable-line react-hooks/exhaustive-deps
  const bagKg = Number(sp?.bag_weight_kg ?? 0);
  const pendBags = (c: (typeof cargo.cargo)[number]) => (bagKg ? Math.floor(((Number(c.initial_tm) - Number(c.discharged_tm)) * 1000) / bagKg) : 0);
  const holdLines = cargo.cargo.filter((c) => c.product_id === prodId).sort((a, b) => (cargo.holds.find((h) => h.id === a.service_hold_id)?.hold_number ?? 0) - (cargo.holds.find((h) => h.id === b.service_hold_id)?.hold_number ?? 0));
  useEffect(() => { if (holdLines.length && !holdLines.some((c) => c.service_hold_id === sel.hold && pendBags(c) > 0)) setSel((x) => ({ ...x, hold: (holdLines.find((c) => pendBags(c) > 0) ?? holdLines[0]).service_hold_id })); }, [prodId, cargo.cargo]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = holdLines.find((c) => c.service_hold_id === sel.hold);

  const nowL = () => localInput(new Date(), tz);
  const [v, setV] = useState(() => { const l = nowL(); return { ticket: '', plate: '', tc: '', date: l.slice(0, 10), time: l.slice(11, 16), notes: '' }; });
  const [lots, setLots] = useState<{ lot: string; bags: string }[]>(() => store.get(`vc:sacos:lots:${svc.id}`) ?? [{ lot: '', bags: '' }]);
  const known = trucks.data?.find((t) => t.plate === v.plate.toUpperCase().replace(/\s+/g, ''));
  useEffect(() => { if (known?.tractor_plate) setV((x) => ({ ...x, tc: x.tc || known.tractor_plate! })); }, [known?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = lots.reduce((a, l) => a + (Number(l.bags) || 0), 0);
  const typed = v.date && v.time ? `${v.date}T${v.time}` : '';
  const cur = typed ? shiftAt(shifts, typed) : null;
  const [reqId, setReqId] = useState(uuid());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [voidT, setVoidT] = useState<Tally | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!v.ticket.trim()) return setErr('Escriba el número de boleta.');
    if (v.plate.trim().length < 2) return setErr('Escriba la placa del camión.');
    if (sp?.uses_bl && !bl) return setErr('Seleccione el BL.');
    if (!line) return setErr('Seleccione la bodega.');
    if (!total) return setErr('Indique los sacos de la boleta.');
    if (total > pendBags(line)) return setErr(`Los ${fmt0(total)} sacos exceden lo pendiente de la bodega (${fmt0(pendBags(line))} sacos).`);
    if (typed > localInput(new Date(Date.now() + 5 * 60e3), tz)) return setErr('La hora de la boleta no puede estar en el futuro.');
    setBusy(true);
    try {
      const r = await rpc<{ bags: number; net_tm: number; duplicate: boolean; shift_name: string | null }>('register_bag_tally', { p: {
        client_request_id: reqId, service_id: svc.id, ticket_number: v.ticket.trim(), truck_plate: v.plate, tractor_plate: v.tc, service_hold_id: sel.hold,
        product_id: prodId, bl_id: bl?.id ?? null, tallied_local: typed || null, notes: v.notes, lots: lots.filter((l) => Number(l.bags) > 0).map((l) => ({ lot: l.lot.trim() || null, bags: Math.round(Number(l.bags)) })) } });
      toast(r.duplicate ? 'Esta boleta ya estaba registrada (no se duplicó).' : `Boleta ${v.ticket.trim()}: ${fmt0(r.bags)} sacos · ${fmt3(r.net_tm)} TM${r.shift_name ? ` · ${r.shift_name}` : ''}`);
      const kept = lots.map((l) => ({ lot: l.lot, bags: '' }));
      setLots(kept); store.set(`vc:sacos:lots:${svc.id}`, kept);
      const l = nowL(); setV({ ticket: '', plate: '', tc: '', date: l.slice(0, 10), time: l.slice(11, 16), notes: '' }); setReqId(uuid());
      onDone(); cargo.refetch(); qc.invalidateQueries({ queryKey: ['service-kpis', svc.id] });
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const canVoid = can('corrections.approve') || can('services.manage');
  const recent = tallies.filter((t) => t.status === 'valid').slice(0, 12);
  return (
    <form onSubmit={submit} className="grid gap-5">
      <Section title="BL, producto y bodega">
        <div className="grid gap-4">
          {(openBls.length > 0 || cargo.products.length > 1) && (
            <div><div className="lbl mb-1.5">{openBls.length ? 'BL que se está trabajando' : 'Producto'}</div><div className="flex flex-wrap gap-2">
              {openBls.map((b) => { const pr = cargo.products.find((p) => p.product_id === b.product_id); return (
                <button type="button" key={b.id} aria-pressed={b.id === bl?.id} onClick={() => setSel((x) => ({ ...x, bl: b.id, prod: b.product_id }))} className={seg(b.id === bl?.id)}>
                  <span className="inline-flex items-center gap-1.5">{pr && <Dot color={pr.product.color} />}BL {b.bl_number}</span>
                  <span className="num text-[12px] font-normal text-mute">{pr?.product.name} · {fmt0(((Number(b.planned_tm) - Number(b.discharged_tm)) * 1000) / (Number(pr?.bag_weight_kg) || 50))} sacos restantes</span>
                </button>); })}
              {cargo.products.filter((p) => !p.uses_bl).map((p) => <button type="button" key={p.id} aria-pressed={!bl && prodId === p.product_id} onClick={() => setSel((x) => ({ ...x, bl: '', prod: p.product_id }))} className={seg(!bl && prodId === p.product_id)}><span className="inline-flex items-center gap-1.5"><Dot color={p.product.color} />{p.product.name}</span><span className="text-[12px] font-normal text-mute">sin BL</span></button>)}
            </div></div>
          )}
          <div><div className="lbl mb-1.5">Bodega</div><div className="flex flex-wrap gap-2">{holdLines.map((c) => { const h = cargo.holds.find((x) => x.id === c.service_hold_id); const pb = pendBags(c); return (
            <button type="button" key={c.id} disabled={pb <= 0} aria-pressed={c.service_hold_id === sel.hold} onClick={() => setSel((x) => ({ ...x, hold: c.service_hold_id }))} className={seg(c.service_hold_id === sel.hold)}>Bodega {h?.hold_number}<span className="num text-[12px] font-normal text-mute">{pb <= 0 ? 'completa' : `${fmt0(pb)} sacos pend.`}</span></button>); })}</div></div>
        </div>
      </Section>
      <Section title="Boleta del camión">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Número de boleta" required><Input value={v.ticket} onChange={(e) => setV((x) => ({ ...x, ticket: e.target.value }))} className="num text-[17px] font-semibold" /></Field>
          <Field label="Placa del camión" required><Input list="bag-plates" value={v.plate} onChange={(e) => setV((x) => ({ ...x, plate: e.target.value.toUpperCase() }))} autoComplete="off" className="num font-semibold" /></Field>
          <datalist id="bag-plates">{trucks.data?.filter((t) => t.status === 'active').map((t) => <option key={t.id} value={t.plate} />)}</datalist>
          <Field label="Placa TC"><Input value={v.tc} onChange={(e) => setV((x) => ({ ...x, tc: e.target.value.toUpperCase() }))} /></Field>
        </div>
        <div className="mt-4"><div className="lbl mb-1.5">Lotes y sacos</div>
          <div className="grid gap-2">{lots.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_150px_auto] items-center gap-2">
              <Input aria-label={`Lote ${i + 1}`} placeholder="Lote" value={l.lot} onChange={(e) => setLots((x) => x.map((y, j) => (j === i ? { ...y, lot: e.target.value } : y)))} />
              <Input aria-label={`Sacos del lote ${i + 1}`} type="number" min="0" step="1" inputMode="numeric" placeholder="Sacos" className="num text-right text-[17px]" value={l.bags} onChange={(e) => setLots((x) => x.map((y, j) => (j === i ? { ...y, bags: e.target.value } : y)))} />
              <button type="button" className="press rounded-lg p-1.5 text-mute hover:text-red disabled:opacity-30" disabled={lots.length === 1} aria-label="Quitar lote" onClick={() => setLots((x) => x.filter((_, j) => j !== i))}><XCircle className="h-4 w-4" /></button>
            </div>))}</div>
          <button type="button" className="mt-2 text-[13.5px] font-semibold text-sea hover:underline" onClick={() => setLots((x) => [...x, { lot: '', bags: '' }])}>+ Otro lote en la misma boleta</button>
        </div>
        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-seasoft px-4 py-3">
          <span className="text-[14px] text-mute">Total de la boleta</span>
          <span className="num text-[26px] font-bold">{fmt0(total)} sacos{bagKg ? ` · ${fmt3((total * bagKg) / 1000)} TM` : ''}</span>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Fecha"><Input type="date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value }))} /></Field>
          <Field label="Hora de la boleta" required><Input type="time" value={v.time} onChange={(e) => setV((x) => ({ ...x, time: e.target.value }))} /></Field>
          <Button type="button" onClick={() => { const l = nowL(); setV((x) => ({ ...x, date: l.slice(0, 10), time: l.slice(11, 16) })); }}>Hora actual</Button>
          <p className="text-[13px] text-mute sm:col-span-3">{cur ? `Se registra en ${periodLabel(cur.shift, cur.date)}.` : 'La hora no cae en ningún turno del esquema; no aparecerá en el avance por turno.'}</p>
        </div>
        <Field label="Notas (opcional)" className="mt-3"><Input value={v.notes} onChange={(e) => setV((x) => ({ ...x, notes: e.target.value }))} /></Field>
      </Section>
      {err && <ErrorBox error={err} />}
      <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!total || !line}>Registrar boleta{total ? ` · ${fmt0(total)} sacos` : ''}</Button>
      {recent.length > 0 && (
        <Section title="Últimas boletas">
          <ul className="grid gap-1.5 text-[14px]">
            {recent.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 odd:bg-panel/60">
                <span className="num w-11 text-mute">{time(t.tallied_at, tz)}</span>
                <span className="min-w-0 flex-1"><b className="num">{t.ticket_number}</b> · {t.truck_plate}{t.tractor_plate ? ` / ${t.tractor_plate}` : ''}
                  <span className="block text-[12.5px] text-mute">B{cargo.holds.find((h) => h.id === t.service_hold_id)?.hold_number}{t.lot ? ` · lote ${t.lot}` : ''}{t.bl_id ? ` · BL ${cargo.bls.find((b) => b.id === t.bl_id)?.bl_number ?? ''}` : ''}</span></span>
                <b className="num">{fmt0(t.bags)} sacos</b>
                {canVoid && <Button size="sm" variant="ghost" aria-label="Anular boleta" icon={<XCircle className="h-4 w-4 text-red" />} onClick={() => setVoidT(t)} />}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <ReasonDialog open={!!voidT} onClose={() => setVoidT(null)} title="Anular boleta de sacos" danger confirmLabel="Anular"
        description={voidT ? `Boleta ${voidT.ticket_number}${voidT.lot ? `, lote ${voidT.lot}` : ''}: se revertirán ${fmt0(voidT.bags)} sacos (${fmt3(voidT.net_tm)} TM) del saldo y del BL. El registro se conserva como anulado.` : ''}
        onConfirm={async (reason) => { await rpc('void_bag_tally', { p_tally: voidT!.id, p_reason: reason }); toast('Boleta anulada'); setVoidT(null); onDone(); cargo.refetch(); }} />
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
