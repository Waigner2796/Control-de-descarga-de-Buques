import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Clock3, Play, Square, Truck } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { rpc, supabase, unwrap, uuid } from '@/lib/supabase';
import { useRealtime, useScales } from '@/lib/hooks';
import { useServiceCargo } from '@/lib/service-data';
import { addDays, date, dt, fmt0, fmt1, fmt2, localInput, minutes, parseNum, pct, time } from '@/lib/format';
import { TIME_MODE } from '@/lib/labels';
import { Badge, Button, Dot, EmptyState, ErrorBox, Field, Input, Meter, Notice, PageHeader, Section, Select, useToast } from '@/components/ui';

type Visit = { id: string; started_at: string; ended_at: string | null; status: string; draft: Record<string, string>; service_id: string };
const EMPTY = { plate: '', tc: '', driver: '', dpi: '', capn: '', gross: '', tare: '', ticket: '', notes: '', date: '', start: '', endDate: '', end: '' };

export default function Weighing() {
  const { orgId, membership } = useOrg();
  const { ctx } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp] = useSearchParams();
  const scales = useScales(orgId);
  const isMaster = membership.role_code === 'master_admin';
  const mine = (scales.data ?? []).filter((s) => s.status === 'active' && (isMaster || membership.scale_ids.includes(s.id)));
  const [scaleId, setScaleId] = useState('');
  useEffect(() => { if (!scaleId && mine.length) setScaleId(mine[0].id); }, [mine.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const scale = mine.find((s) => s.id === scaleId);

  const settings = useQuery({
    queryKey: ['scale-mode', scaleId], enabled: !!scale,
    queryFn: async () => {
      const [ss, ts, th, os] = await Promise.all([
        supabase.from('scale_settings').select('time_capture_mode').eq('scale_id', scaleId).maybeSingle(),
        supabase.from('terminal_settings').select('time_capture_mode').eq('terminal_id', scale!.terminal_id).maybeSingle(),
        supabase.from('operational_thresholds').select('long_cycle_minutes, max_net_kg').eq('organization_id', orgId).maybeSingle(),
        supabase.from('organization_settings').select('weight_input_unit').eq('organization_id', orgId).maybeSingle(),
      ]);
      return { mode: (ss.data?.time_capture_mode ?? ts.data?.time_capture_mode ?? 'manual') as 'manual' | 'server_now', longCycle: Number(th.data?.long_cycle_minutes ?? 30), unit: (os.data?.weight_input_unit ?? 'kg') as 'kg' | 'tm' };
    },
  });
  const mode = settings.data?.mode ?? 'manual';
  const unit = settings.data?.unit ?? 'kg';

  const services = useQuery({
    queryKey: ['scale-services', scaleId], enabled: !!scaleId,
    queryFn: async () => {
      const ids = (unwrap(await supabase.from('service_scales').select('service_id').eq('scale_id', scaleId)) as { service_id: string }[]).map((x) => x.service_id);
      if (!ids.length) return [];
      return unwrap(await supabase.from('service_overview').select('id, service_number, vessel_name, customer_name, timezone, status').in('id', ids).eq('status', 'in_operation')) as { id: string; service_number: string; vessel_name: string; customer_name: string; timezone: string }[];
    },
  });
  const [svcId, setSvcId] = useState(sp.get('servicio') ?? '');
  useEffect(() => { if (services.data && !services.data.some((s) => s.id === svcId)) setSvcId(services.data[0]?.id ?? ''); }, [services.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const svc = services.data?.find((s) => s.id === svcId);
  const tz = svc?.timezone ?? 'America/Guatemala';
  const cargo = useServiceCargo(svcId || null);
  const [holdId, setHoldId] = useState(sp.get('bodega') ?? '');
  const [prodId, setProdId] = useState('');
  const pendOf = (cId: string) => { const c = cargo.cargo.find((x) => x.id === cId); return c ? Number(c.initial_tm) - Number(c.discharged_tm) : 0; };
  useEffect(() => {
    const ok = cargo.holds.find((h) => h.id === holdId && cargo.cargo.some((c) => c.service_hold_id === h.id && pendOf(c.id) > 0));
    if (!ok) setHoldId(cargo.holds.find((h) => cargo.cargo.some((c) => c.service_hold_id === h.id && pendOf(c.id) > 0))?.id ?? '');
  }, [cargo.cargo, cargo.holds]); // eslint-disable-line react-hooks/exhaustive-deps
  const holdLines = cargo.cargo.filter((c) => c.service_hold_id === holdId);
  useEffect(() => { if (!holdLines.some((c) => c.product_id === prodId && pendOf(c.id) > 0)) setProdId(holdLines.find((c) => pendOf(c.id) > 0)?.product_id ?? ''); }, [holdId, cargo.cargo]); // eslint-disable-line react-hooks/exhaustive-deps
  const line = holdLines.find((c) => c.product_id === prodId);

  const [v, setV] = useState(EMPTY);
  const [reqId, setReqId] = useState(uuid());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [autoNext, setAutoNext] = useState(false);
  useEffect(() => { const now = localInput(new Date(), tz); setV((x) => ({ ...x, date: x.date || now.slice(0, 10), endDate: x.endDate || now.slice(0, 10) })); }, [tz]);
  useEffect(() => {
    if (mode !== 'manual' || !v.start || !v.end) return;
    if (v.endDate === v.date && v.end < v.start) { setV((x) => ({ ...x, endDate: addDays(x.date, 1) })); setAutoNext(true); }
    else if (autoNext && v.end >= v.start) { setV((x) => ({ ...x, endDate: x.date })); setAutoNext(false); }
  }, [v.start, v.end, v.date]); // eslint-disable-line react-hooks/exhaustive-deps

  // Visita abierta (modalidad hora del servidor)
  const visits = useQuery({
    queryKey: ['open-visits', scaleId], enabled: !!scaleId && mode === 'server_now',
    queryFn: async () => unwrap(await supabase.from('scale_visits').select('id, started_at, ended_at, status, draft, service_id').eq('scale_id', scaleId).eq('status', 'open').order('started_at')) as Visit[],
  });
  const [visitId, setVisitId] = useState<string | null>(null);
  const visit = visits.data?.find((x) => x.id === visitId) ?? null;
  useEffect(() => { if (visitId && visits.data && !visits.data.some((x) => x.id === visitId)) setVisitId(null); }, [visits.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const last = useQuery({
    queryKey: ['scale-last', scaleId], enabled: !!scaleId,
    queryFn: async () => unwrap(await supabase.from('operational_cycles').select('id, ticket_number, truck_plate, hold_number, product_name, net_tm, started_at, ended_at, cycle_minutes').eq('scale_id', scaleId).eq('status', 'valid').order('ended_at', { ascending: false }).limit(8)) as { id: string; ticket_number: string; truck_plate: string; hold_number: number; product_name: string; net_tm: number; started_at: string; ended_at: string; cycle_minutes: number }[],
  });
  useRealtime('weigh_tickets', scaleId ? `scale_id=eq.${scaleId}` : null, [['scale-last', scaleId]], !!scaleId);
  const trucks = useQuery({ queryKey: ['trucks', orgId], queryFn: async () => unwrap(await supabase.from('trucks').select('plate').eq('organization_id', orgId).order('plate').limit(2000)) as { plate: string }[] });

  const lookupTruck = async (plate: string) => {
    const p = plate.trim().toUpperCase();
    if (p.length < 3) return;
    const { data } = await supabase.from('weigh_tickets').select('tractor_plate, driver_name, driver_dpi, nominal_capacity_tm').eq('organization_id', orgId).eq('truck_plate', p).order('registered_at', { ascending: false }).limit(1);
    const t = data?.[0];
    if (t) setV((x) => ({ ...x, tc: x.tc || t.tractor_plate || '', driver: x.driver || t.driver_name, dpi: x.dpi || t.driver_dpi, capn: x.capn || (t.nominal_capacity_tm ? String(t.nominal_capacity_tm) : '') }));
  };

  const g = parseNum(v.gross), t = parseNum(v.tare);
  const netKg = unit === 'tm' ? (g - t) * 1000 : g - t;
  const netOk = Number.isFinite(netKg) && netKg > 0;
  const pending = line ? pendOf(line.id) : 0;
  const over = netOk && netKg / 1000 > pending + 1e-9;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const cycleManual = mode === 'manual' && v.start && v.end ? (new Date(`${v.endDate}T${v.end}:00Z`).getTime() - new Date(`${v.date}T${v.start}:00Z`).getTime()) / 60000 : null;
  const cycleServer = visit?.ended_at ? (new Date(visit.ended_at).getTime() - new Date(visit.started_at).getTime()) / 60000 : null;

  const startVisit = async () => {
    try {
      const r = await rpc<Visit>('start_scale_visit', { p_scale: scaleId, p_service: svcId, p_draft: { plate: v.plate, tc: v.tc, driver: v.driver, dpi: v.dpi } });
      setVisitId(r.id); qc.invalidateQueries({ queryKey: ['open-visits', scaleId] }); toast(`Hora de inicio registrada: ${time(r.started_at, tz, true)}`, 'info');
    } catch (e) { setErr((e as Error).message); }
  };
  const endVisit = async () => {
    if (!visit) return;
    try { const r = await rpc<Visit>('stamp_scale_visit_end', { p_visit: visit.id }); qc.invalidateQueries({ queryKey: ['open-visits', scaleId] }); toast(`Hora final registrada: ${time(r.ended_at, tz, true)}`, 'info'); }
    catch (e) { setErr((e as Error).message); }
  };
  const resume = (x: Visit) => { setVisitId(x.id); setV((y) => ({ ...y, plate: x.draft?.plate ?? y.plate, tc: x.draft?.tc ?? y.tc, driver: x.draft?.driver ?? y.driver, dpi: x.draft?.dpi ?? y.dpi })); if (x.service_id) setSvcId(x.service_id); };

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!svc || !line) return setErr('Seleccione servicio, bodega y producto.');
    if (!netOk) return setErr('El peso bruto debe ser mayor que la tara.');
    if (over) return setErr(`El neto (${fmt2(netKg / 1000)} TM) excede el saldo pendiente (${fmt2(pending)} TM). Solicite un ajuste de tonelaje.`);
    if (mode === 'manual' && (!v.start || !v.end)) return setErr('Registre la hora de inicio y la hora final.');
    if (mode === 'server_now' && !visit?.ended_at) return setErr('Use los botones para registrar la hora de inicio y la hora final.');
    setBusy(true);
    try {
      const r = await rpc<{ net_tm: number; pending_tm: number; duplicate: boolean }>('register_weigh_ticket', { p: {
        client_request_id: reqId, scale_id: scaleId, service_id: svc.id, service_hold_id: holdId, product_id: prodId,
        ticket_number: v.ticket, truck_plate: v.plate, tractor_plate: v.tc, driver_name: v.driver, driver_dpi: v.dpi, nominal_capacity_tm: v.capn || null,
        gross: v.gross, tare: v.tare, weight_unit: unit, notes: v.notes,
        started_local: mode === 'manual' ? `${v.date}T${v.start}` : null, ended_local: mode === 'manual' ? `${v.endDate}T${v.end}` : null, visit_id: visit?.id ?? null,
      } });
      toast(r.duplicate ? 'Este pesaje ya estaba registrado (no se duplicó).' : `Ticket ${v.ticket} registrado: ${fmt2(r.net_tm)} TM · saldo ${fmt1(r.pending_tm)} TM`, r.duplicate ? 'info' : 'ok');
      setV((x) => ({ ...EMPTY, date: x.date, endDate: x.date })); setReqId(uuid()); setVisitId(null); setAutoNext(false);
      ['scale-last', 'open-visits', 'cycles', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      cargo.refetch();
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };

  if (scales.isLoading) return null;
  if (!mine.length) return <EmptyState icon={<Truck className="h-8 w-8" />} title="No tiene básculas autorizadas">Un administrador debe asignarle una báscula activa en «Básculas» para registrar pesajes.</EmptyState>;

  const seg = 'press flex min-h-[44px] flex-col items-start justify-center rounded-lg border px-3 py-1.5 text-left text-[14px] font-semibold disabled:opacity-45 disabled:cursor-not-allowed';
  return (
    <div>
      <PageHeader title="Registro de pesaje" sub={`${scale?.name ?? ''}${scale?.location ? ` · ${scale.location}` : ''} · Operador: ${ctx?.profile?.full_name ?? ''}`}
        actions={<Badge tone="info"><Clock3 className="h-3.5 w-3.5" />{TIME_MODE[mode]}</Badge>} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <form onSubmit={submit} className="grid content-start gap-5">
          <Section title="Información del servicio">
            <div className="grid gap-4">
              <div><div className="lbl mb-1.5">Báscula</div><div className="flex flex-wrap gap-2">{mine.map((s) => <button type="button" key={s.id} aria-pressed={s.id === scaleId} onClick={() => { setScaleId(s.id); setVisitId(null); }} className={clsx(seg, s.id === scaleId ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}>{s.name}<span className="text-[12px] font-normal text-mute">{s.code}</span></button>)}</div></div>
              <Field label="Servicio">
                <Select value={svcId} onChange={(e) => setSvcId(e.target.value)}>{services.data?.length ? services.data.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name} · {s.customer_name}</option>) : <option value="">Sin servicios en operación asignados a esta báscula</option>}</Select>
              </Field>
              {svc && <>
                <div><div className="lbl mb-1.5">Bodega</div><div className="flex flex-wrap gap-2">{cargo.holds.map((h) => { const P = cargo.cargo.filter((c) => c.service_hold_id === h.id).reduce((a, c) => a + pendOf(c.id), 0); return <button type="button" key={h.id} disabled={P <= 0} aria-pressed={h.id === holdId} onClick={() => setHoldId(h.id)} className={clsx(seg, h.id === holdId ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}>Bodega {h.hold_number}<span className="num text-[12px] font-normal text-mute">{P <= 0 ? 'completa' : `${fmt0(P)} TM`}</span></button>; })}</div></div>
                <div><div className="lbl mb-1.5">Producto</div><div className="flex flex-wrap gap-2">{holdLines.map((c) => { const P = pendOf(c.id); return <button type="button" key={c.id} disabled={P <= 0} aria-pressed={c.product_id === prodId} onClick={() => setProdId(c.product_id)} className={clsx(seg, c.product_id === prodId ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel')}><span className="inline-flex items-center gap-1.5"><Dot color={c.product.color} />{c.product.name}</span><span className="num text-[12px] font-normal text-mute">{P <= 0 ? 'completo' : `${fmt1(P)} TM`}</span></button>; })}</div></div>
              </>}
            </div>
          </Section>

          <Section title="Información del transporte">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Matrícula del camión" required><Input list="plates" value={v.plate} onChange={(e) => setV((x) => ({ ...x, plate: e.target.value.toUpperCase() }))} onBlur={(e) => lookupTruck(e.target.value)} autoComplete="off" /></Field>
              <datalist id="plates">{trucks.data?.map((x) => <option key={x.plate} value={x.plate} />)}</datalist>
              <Field label="Matrícula del TC"><Input value={v.tc} onChange={(e) => setV((x) => ({ ...x, tc: e.target.value.toUpperCase() }))} /></Field>
              <Field label="Nombre del piloto" required><Input value={v.driver} onChange={set('driver')} /></Field>
              <Field label="DPI" required hint="13 dígitos"><Input inputMode="numeric" value={v.dpi} onChange={set('dpi')} /></Field>
              <Field label="Capacidad nominal (TM, opcional)"><Input type="number" step="0.001" value={v.capn} onChange={set('capn')} /></Field>
            </div>
          </Section>

          <Section title="Información del pesaje">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Número de ticket" required><Input value={v.ticket} onChange={set('ticket')} className="num" /></Field>
              <Field label={`Peso bruto (${unit === 'kg' ? 'kg' : 'TM'})`} required><Input type="number" step={unit === 'kg' ? '1' : '0.001'} min="0" inputMode="decimal" value={v.gross} onChange={set('gross')} className="num text-right text-[18px]" /></Field>
              <Field label={`Tara (${unit === 'kg' ? 'kg' : 'TM'})`} required><Input type="number" step={unit === 'kg' ? '1' : '0.001'} min="0" inputMode="decimal" value={v.tare} onChange={set('tare')} className="num text-right text-[18px]" /></Field>
            </div>
            <div className={clsx('mt-4 flex flex-wrap items-baseline justify-between gap-2 rounded-xl px-4 py-3', netOk && !over ? 'bg-seasoft' : v.gross && v.tare ? 'bg-redsoft' : 'bg-panel')}>
              <span className="text-[14px] text-mute">Peso neto = bruto − tara</span>
              <span className={clsx('num text-[30px] font-bold', (!netOk || over) && v.gross && v.tare && 'text-red')}>{Number.isFinite(netKg) ? `${fmt0(netKg)} kg · ${fmt2(netKg / 1000)} TM` : '—'}</span>
              {v.gross && v.tare && !netOk && <span className="w-full text-[14px] text-red">El peso bruto debe ser mayor que la tara.</span>}
              {over && <span className="w-full text-[14px] text-red">Excede el saldo pendiente de {fmt2(pending)} TM.</span>}
            </div>

            <div className="mt-4">
              {mode === 'manual' ? (
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Fecha"><Input type="date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value, endDate: x.endDate === x.date ? e.target.value : x.endDate }))} /></Field>
                  <Field label="Hora de inicio" required><Input type="time" value={v.start} onChange={set('start')} /></Field>
                  <Field label="Hora final" required><Input type="time" value={v.end} onChange={set('end')} /></Field>
                  <Field label="Tiempo de ciclo"><div className={clsx('num flex min-h-[40px] items-center rounded-lg bg-panel px-3 font-semibold', cycleManual != null && cycleManual > (settings.data?.longCycle ?? 30) && 'text-red')}>{cycleManual == null ? '—' : minutes(cycleManual)}</div></Field>
                  {autoNext && <Notice tone="info" className="sm:col-span-4">La hora final es menor que la de inicio: se registra como del día siguiente ({date(v.endDate)}).</Notice>}
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Button type="button" size="lg" variant={visit ? 'secondary' : 'primary'} icon={<Play className="h-4 w-4" />} disabled={!!visit || !svc} onClick={startVisit}>{visit ? `Inicio ${time(visit.started_at, tz, true)}` : 'Registrar hora de inicio'}</Button>
                    <Button type="button" size="lg" variant={visit && !visit.ended_at ? 'primary' : 'secondary'} icon={<Square className="h-4 w-4" />} disabled={!visit || !!visit.ended_at} onClick={endVisit}>{visit?.ended_at ? `Final ${time(visit.ended_at, tz, true)}` : 'Registrar hora final'}</Button>
                    <div className="num flex min-h-[48px] items-center justify-center rounded-lg bg-panel font-semibold">Ciclo: {cycleServer == null ? '—' : minutes(cycleServer)}</div>
                  </div>
                  <p className="text-[13px] text-mute">La hora la registra el servidor al presionar cada botón; no puede editarse desde este equipo.</p>
                  {!!visits.data?.length && !visit && (
                    <div className="rounded-lg border border-line p-3 text-[14px]">
                      <b>Visitas abiertas en esta báscula</b>
                      <ul className="mt-2 grid gap-1.5">{visits.data.map((x) => (
                        <li key={x.id} className="flex flex-wrap items-center gap-2">
                          <span>{x.draft?.plate || 'Sin matrícula'} · inicio {dt(x.started_at, tz, true)}</span>
                          <Button type="button" size="sm" onClick={() => resume(x)}>Continuar</Button>
                          <Button type="button" size="sm" variant="ghost" onClick={async () => { await rpc('cancel_scale_visit', { p_visit: x.id, p_reason: 'Cancelada por el operador' }).catch((e) => toast(e.message, 'bad')); qc.invalidateQueries({ queryKey: ['open-visits', scaleId] }); }}>Cancelar</Button>
                        </li>))}</ul>
                    </div>
                  )}
                </div>
              )}
            </div>
            <Field label="Notas (opcional)" className="mt-4"><Input value={v.notes} onChange={set('notes')} /></Field>
          </Section>
          {err && <ErrorBox error={err} />}
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!svc || !line}>Registrar pesaje{v.ticket ? ` · ticket ${v.ticket}` : ''}</Button>
        </form>

        <div className="grid content-start gap-5">
          <Section title="Saldo disponible">
            {line && svc ? (
              <div>
                <div className="flex items-center gap-2 text-[14px] text-mute"><Dot color={line.product.color} />{line.product.name} · Bodega {cargo.holds.find((h) => h.id === holdId)?.hold_number} · {svc.vessel_name}</div>
                <div className="num mt-1 text-[38px] font-bold leading-tight">{fmt2(pending)} TM</div>
                <Meter value={Number(line.initial_tm) ? (Number(line.discharged_tm) / Number(line.initial_tm)) * 100 : 0} />
                <div className="mt-1 text-[14px] text-mute">{fmt1(line.discharged_tm)} de {fmt0(line.initial_tm)} TM descargadas · {pct(Number(line.initial_tm) ? (Number(line.discharged_tm) / Number(line.initial_tm)) * 100 : 0)}</div>
                <div className="mt-3 grid grid-cols-2 gap-3 text-[14px]"><div><div className="text-mute">Bodega</div><b>{fmt1(holdLines.reduce((a, c) => a + pendOf(c.id), 0))} TM</b></div><div><div className="text-mute">Buque</div><b>{fmt1(cargo.pending)} TM</b></div></div>
                <p className="mt-3 text-[13px] text-mute">Si otra báscula descarga este producto, ambas restan del mismo saldo dentro de una transacción con bloqueo: nunca queda negativo.</p>
              </div>
            ) : <p className="text-mute">Seleccione servicio, bodega y producto.</p>}
          </Section>
          <Section title="Últimos registros de esta báscula">
            {last.data?.length ? (
              <ol className="grid gap-1.5">
                {last.data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[14px] odd:bg-panel/60">
                    <span className="num w-11 text-mute">{time(r.ended_at, tz)}</span>
                    <span className="min-w-0 flex-1 truncate"><b>{r.truck_plate}</b> · {r.ticket_number}<span className="block text-[12.5px] text-mute">B{r.hold_number} {r.product_name} · ciclo <span className={Number(r.cycle_minutes) > (settings.data?.longCycle ?? 30) ? 'font-semibold text-red' : ''}>{minutes(r.cycle_minutes)}</span></span></span>
                    <span className="num font-semibold">{fmt2(r.net_tm)}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="text-mute">Sin registros todavía.</p>}
          </Section>
        </div>
      </div>
    </div>
  );
}
