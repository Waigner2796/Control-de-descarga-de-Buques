import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown, FileSpreadsheet, History, Pencil, Plus, XCircle } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { rpc, supabase, unwrap, uuid } from '@/lib/supabase';
import { useRealtime, useServicesLite, useUrlState, type ServiceLite } from '@/lib/hooks';
import { DOWNTIME_COLS, fetchAll, type DowntimeRow } from '@/lib/queries';
import { addDays, date, diffMinutes, fmt1, fmt2, hours, localDayStartIso, localInput, minutes, time } from '@/lib/format';
import { ACTIVE, SCOPE } from '@/lib/labels';
import { exportDowntime } from '@/lib/excel/exports';
import { tablePdf } from '@/lib/pdf-table';
import { ChartFrame, Columns, HBars } from '@/components/charts';
import { Badge, Button, DataTable, ErrorBox, Field, FilterBar, Input, Kpi, Modal, Notice, Pagination, Section, Select, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { CorrectionDialog, RecordHistory } from './CorrectionDialog';

type Cause = { id: string; name: string; default_scope: string; category: { id: string; name: string; color: string } };
type Summary = { total_minutes: number; total_hours: number; events: number; top_cause: string | null; by_scope: Record<string, number>;
  pareto: { cause: string; category: string; color: string; minutes: number; events: number; pct: number; cum_pct: number }[];
  by_day: { date: string; minutes: number; events: number }[]; by_shift: { shift: string; minutes: number; events: number }[];
  by_hold: { hold_number: number; minutes: number; events: number }[]; by_scale: { scale: string; minutes: number; events: number }[] };

export function DowntimeForm({ open, onClose, orgId, service: fixed }: { open: boolean; onClose: () => void; orgId: string; service?: ServiceLite | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { ctx } = useAuth();
  const services = useServicesLite(fixed ? null : orgId, ['preparing', 'in_operation', 'suspended', 'closing']);
  const [svcId, setSvcId] = useState(fixed?.id ?? '');
  const svc = fixed ?? services.data?.find((s) => s.id === svcId) ?? null;
  const tz = svc?.timezone ?? 'America/Guatemala';
  const causes = useQuery({ queryKey: ['causes', orgId], queryFn: async () => unwrap(await supabase.from('downtime_causes').select('id, name, default_scope, category:downtime_categories(id, name, color)').eq('organization_id', orgId).eq('status', 'active').order('sort')) as unknown as Cause[] });
  const holds = useQuery({ queryKey: ['holds-of', svc?.id], enabled: !!svc, queryFn: async () => unwrap(await supabase.from('service_holds').select('id, hold_number').eq('service_id', svc!.id).order('hold_number')) as { id: string; hold_number: number }[] });
  const scales = useQuery({ queryKey: ['svc-scales', svc?.id], enabled: !!svc, queryFn: async () => unwrap(await supabase.from('service_scales').select('scale_id, scale:scales(name)').eq('service_id', svc!.id)) as unknown as { scale_id: string; scale: { name: string } }[] });
  const [v, setV] = useState({ date: '', start: '', endDate: '', end: '', cause: '', scope: 'operation', hold: '', scale: '', obs: '' });
  const [autoNext, setAutoNext] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reqId, setReqId] = useState(uuid());
  useEffect(() => { if (open) { const now = localInput(new Date(), tz); setV({ date: now.slice(0, 10), start: '', endDate: now.slice(0, 10), end: '', cause: '', scope: 'operation', hold: '', scale: '', obs: '' }); setErr(null); setReqId(uuid()); setAutoNext(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Si la hora final es menor que la de inicio en el mismo día, se propone el día siguiente (cruce de medianoche) y se avisa.
  useEffect(() => {
    if (!v.start || !v.end || !v.date) return;
    if (v.endDate === v.date && v.end < v.start) { setV((x) => ({ ...x, endDate: addDays(x.date, 1) })); setAutoNext(true); }
    else if (autoNext && v.endDate === addDays(v.date, 1) && v.end >= v.start) { setV((x) => ({ ...x, endDate: x.date })); setAutoNext(false); }
  }, [v.start, v.end, v.date]); // eslint-disable-line react-hooks/exhaustive-deps
  const cause = causes.data?.find((c) => c.id === v.cause);
  const startL = v.date && v.start ? `${v.date}T${v.start}` : '';
  const endL = v.endDate && v.end ? `${v.endDate}T${v.end}` : '';
  const dur = diffMinutes(startL, endL);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setErr(null);
    if (!svc) return setErr('Seleccione el servicio.');
    if (!cause) return setErr('Seleccione el evento.');
    if (dur == null) return setErr('Indique la fecha y las horas de inicio y final.');
    if (dur <= 0) return setErr('La hora final debe ser posterior a la de inicio.');
    setBusy(true);
    try {
      const r = await rpc<{ duration_minutes: number }>('register_downtime', { p: { client_request_id: reqId, service_id: svc.id, cause_id: cause.id, started_local: startL, ended_local: endL, scope: v.scope, service_hold_id: v.scope === 'hold' ? v.hold : null, scale_id: v.scope === 'scale' ? v.scale : null, observations: v.obs } });
      toast(`Tiempo perdido registrado: ${minutes(r.duration_minutes)}`);
      ['downtime', 'downtime-summary', 'service-kpis', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const grouped = useMemo(() => {
    const m = new Map<string, Cause[]>();
    (causes.data ?? []).forEach((c) => m.set(c.category.name, [...(m.get(c.category.name) ?? []), c]));
    return [...m.entries()];
  }, [causes.data]);
  return (
    <Modal open={open} onClose={onClose} wide title="Registrar tiempo perdido"
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>Registrar</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {!fixed && <Field label="Servicio" required className="sm:col-span-2"><Select value={svcId} onChange={(e) => setSvcId(e.target.value)}><option value="">Seleccione…</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name} · {s.customer_name}</option>)}</Select></Field>}
        {svc && <div className="sm:col-span-2 grid grid-cols-3 gap-3 rounded-lg bg-panel px-3 py-2 text-[14px]"><span><span className="block text-[12px] text-mute">Cliente</span>{svc.customer_name}</span><span><span className="block text-[12px] text-mute">Servicio</span>{svc.service_number}</span><span><span className="block text-[12px] text-mute">Buque</span>{svc.vessel_name}</span></div>}
        <Field label="Evento" required>
          <Select value={v.cause} onChange={(e) => { const c = causes.data?.find((x) => x.id === e.target.value); setV((x) => ({ ...x, cause: e.target.value, scope: c?.default_scope ?? x.scope })); }}>
            <option value="">Seleccione…</option>
            {grouped.map(([cat, list]) => <optgroup key={cat} label={cat}>{list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
          </Select>
        </Field>
        <Field label="Categoría"><div className="flex min-h-[40px] items-center gap-2 rounded-lg bg-panel px-3 text-[14px]">{cause ? <><i className="h-2.5 w-2.5 rounded-full" style={{ background: cause.category.color }} />{cause.category.name}</> : <span className="text-mute">Según el evento</span>}</div></Field>
        <Field label="Fecha de inicio" required><Input type="date" value={v.date} onChange={(e) => setV((x) => ({ ...x, date: e.target.value, endDate: x.endDate === x.date ? e.target.value : x.endDate }))} /></Field>
        <Field label="Hora de inicio" required><Input type="time" value={v.start} onChange={set('start')} /></Field>
        <Field label="Fecha final" required><Input type="date" value={v.endDate} onChange={(e) => { setAutoNext(false); setV((x) => ({ ...x, endDate: e.target.value })); }} /></Field>
        <Field label="Hora final" required><Input type="time" value={v.end} onChange={set('end')} /></Field>
        {autoNext && <Notice tone="info" className="sm:col-span-2">La hora final es menor que la de inicio: se registró como del día siguiente ({date(v.endDate)}). Cambie la fecha final si no corresponde.</Notice>}
        <div className="sm:col-span-2 flex items-center gap-3 rounded-lg border border-line px-3 py-2"><span className="text-[13px] text-mute">Duración</span><b className={`num text-[20px] ${dur != null && dur <= 0 ? 'text-red' : ''}`}>{dur == null ? '—' : dur <= 0 ? 'Inválida' : `${minutes(dur)} · ${fmt2(dur / 60)} h`}</b></div>
        <Field label="Alcance" hint="Un evento de bodega o báscula no se considera parada de toda la operación."><Select value={v.scope} onChange={set('scope')}>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        {v.scope === 'hold' && <Field label="Bodega afectada" required><Select value={v.hold} onChange={set('hold')}><option value="">Seleccione…</option>{holds.data?.map((h) => <option key={h.id} value={h.id}>Bodega {h.hold_number}</option>)}</Select></Field>}
        {v.scope === 'scale' && <Field label="Báscula relacionada" required><Select value={v.scale} onChange={set('scale')}><option value="">Seleccione…</option>{scales.data?.map((s) => <option key={s.scale_id} value={s.scale_id}>{s.scale.name}</option>)}</Select></Field>}
        <Field label="Observaciones" className="sm:col-span-2"><Textarea value={v.obs} onChange={set('obs')} /></Field>
        <p className="sm:col-span-2 text-[13px] text-mute">Responsable del registro: <b>{ctx?.profile?.full_name || ctx?.profile?.email}</b></p>
        {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
      </div>
    </Modal>
  );
}

export function DowntimeSummary({ orgId, serviceId, tz, from, to }: { orgId: string; serviceId?: string; tz: string; from?: string; to?: string }) {
  const fromIso = from ? localDayStartIso(from, tz) : null;
  const toIso = to ? localDayStartIso(addDays(to, 1), tz) : null;
  const q = useQuery({ queryKey: ['downtime-summary', orgId, serviceId, fromIso, toIso], queryFn: () => rpc<Summary>('downtime_summary', { p: { service_id: serviceId ?? null, from: fromIso, to: toIso } }) });
  const s = q.data;
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi loading={q.isLoading} label="Horas perdidas" value={`${fmt1(s?.total_hours)} h`} tone="red" />
        <Kpi loading={q.isLoading} label="Eventos" value={s?.events ?? 0} />
        <Kpi loading={q.isLoading} label="Principal causa" value={<span className="text-[19px]">{s?.top_cause ?? '—'}</span>} />
        <Kpi loading={q.isLoading} label="Parada de toda la operación" value={hours(s?.by_scope?.operation)} sub={`Bodegas ${hours(s?.by_scope?.hold)} · Básculas ${hours(s?.by_scope?.scale)}`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Pareto de causas">
          <HBars rows={(s?.pareto ?? []).map((p) => ({ key: p.cause, label: <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.cause}</span>, value: Number(p.minutes), text: hours(p.minutes), extra: `${fmt1(p.pct)} % · acum. ${fmt1(p.cum_pct)} %`, color: p.color }))} />
          <p className="mt-3 text-[13px] text-mute">Ordenado de mayor a menor; el porcentaje acumulado identifica las causas que concentran la mayor parte del tiempo perdido.</p>
        </Section>
        <Section title="Tiempo perdido por día">
          <ChartFrame height={220} empty={!s?.by_day.length}><Columns data={(s?.by_day ?? []).map((d) => ({ dia: date(d.date), horas: Number(d.minutes) / 60 }))} x="dia" series={[{ key: 'horas', name: 'Horas', color: 'var(--s2)' }]} unit="h" fmt={fmt2} /></ChartFrame>
        </Section>
        <Section title="Por turno"><HBars rows={(s?.by_shift ?? []).map((x) => ({ key: x.shift, label: x.shift, value: Number(x.minutes), text: hours(x.minutes), extra: `${x.events} ev.` }))} /></Section>
        <Section title="Por bodega y báscula">
          <HBars rows={[...(s?.by_hold ?? []).map((x) => ({ key: `h${x.hold_number}`, label: `Bodega ${x.hold_number}`, value: Number(x.minutes), text: hours(x.minutes), extra: `${x.events} ev.` })),
            ...(s?.by_scale ?? []).map((x) => ({ key: `s${x.scale}`, label: x.scale, value: Number(x.minutes), text: hours(x.minutes), extra: `${x.events} ev.`, color: 'var(--s3)' }))]} empty="Sin eventos limitados a una bodega o báscula." />
        </Section>
      </div>
    </div>
  );
}

export function DowntimeList({ orgId, service, tz }: { orgId: string; service?: ServiceLite | null; tz: string }) {
  const { can, membership } = useAuth();
  const toast = useToast();
  const [f, setF] = useUrlState({ dsvc: '', dcause: '', dscope: '', dfrom: '', dto: '', dst: 'valid', dpage: '1', dsize: '25' });
  const page = Number(f.dpage) || 1, size = Number(f.dsize) || 25;
  const services = useServicesLite(service ? null : orgId);
  const causes = useQuery({ queryKey: ['causes', orgId, 'all'], queryFn: async () => unwrap(await supabase.from('downtime_causes').select('id, name').eq('organization_id', orgId).order('name')) as { id: string; name: string }[] });
  const svcId = service?.id ?? f.dsvc;
  const build = () => {
    let q = supabase.from('downtime_overview').select(DOWNTIME_COLS, { count: 'exact' }).eq('organization_id', orgId);
    if (svcId) q = q.eq('service_id', svcId);
    if (f.dcause) q = q.eq('cause_id', f.dcause);
    if (f.dscope) q = q.eq('scope', f.dscope);
    if (f.dst) q = q.eq('status', f.dst);
    if (f.dfrom) q = q.gte('started_at', localDayStartIso(f.dfrom, tz));
    if (f.dto) q = q.lt('started_at', localDayStartIso(addDays(f.dto, 1), tz));
    return q;
  };
  const q = useQuery({
    queryKey: ['downtime', orgId, svcId, f], placeholderData: keepPreviousData,
    queryFn: async () => { const r = await build().order('started_at', { ascending: false }).range((page - 1) * size, page * size - 1); return { rows: unwrap(r) as DowntimeRow[], count: r.count ?? 0 }; },
  });
  useRealtime('downtime_events', svcId ? `service_id=eq.${svcId}` : `organization_id=eq.${orgId}`, [['downtime'], ['downtime-summary']]);
  const [corr, setCorr] = useState<{ row: DowntimeRow; mode: 'update' | 'void' } | null>(null);
  const [hist, setHist] = useState<DowntimeRow | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const all = () => fetchAll<DowntimeRow>(build, [{ col: 'started_at', asc: true }]);
  const doExcel = async () => { setBusy('x'); try { await exportDowntime(await all(), tz, service?.service_number); } catch (e) { toast(String((e as Error).message), 'bad'); } setBusy(null); };
  const doPdf = async () => {
    setBusy('p');
    try {
      const rows = await all();
      await tablePdf({ title: `Tiempos perdidos${service ? ` · ${service.service_number}` : ''}`, org: membership?.organization_name, subtitle: `${rows.length} eventos`,
        headers: ['Servicio', 'Fecha', 'Inicio', 'Final', 'Evento', 'Categoría', 'Alcance', 'Duración (min)', 'Observaciones', 'Registró'], widths: [58, 50, 82, 82, 104, 60, 58, 64, 136, 78], align: ['l', 'l', 'l', 'l', 'l', 'l', 'l', 'r', 'l', 'l'],
        rows: rows.map((d) => [d.service_number, date(d.started_at, tz), `${date(d.started_at, tz)} ${time(d.started_at, tz)}`, `${date(d.ended_at, tz)} ${time(d.ended_at, tz)}`, d.cause_name, d.category_name,
          d.scope === 'hold' ? `Bodega ${d.hold_number}` : d.scope === 'scale' ? d.scale_name ?? '' : 'Operación', fmt1(d.duration_minutes), d.observations ?? '', d.reported_by_name ?? '']),
        totals: ['Total', '', '', '', '', '', '', fmt1(rows.reduce((a, d) => a + Number(d.duration_minutes), 0)), '', ''] });
    } catch (e) { toast(String((e as Error).message), 'bad'); }
    setBusy(null);
  };
  const cols: Column<DowntimeRow>[] = [
    ...(!service ? [{ key: 'svc', header: 'Servicio', cell: (d: DowntimeRow) => <span className="num font-semibold">{d.service_number}</span> }] : []),
    { key: 'date', header: 'Fecha', cell: (d) => date(d.started_at, tz) },
    { key: 'ini', header: 'Inicio', cell: (d) => <span className="num">{time(d.started_at, tz)}</span> },
    { key: 'fin', header: 'Final', cell: (d) => <span className="num">{date(d.ended_at, tz) !== date(d.started_at, tz) ? <Badge tone="info" className="mr-1">+1 día</Badge> : null}{time(d.ended_at, tz)}</span> },
    { key: 'ev', header: 'Evento', cell: (d) => <span className="inline-flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: d.category_color }} /><span>{d.cause_name}<span className="block text-[12px] text-mute">{d.category_name}</span></span></span> },
    { key: 'sc', header: 'Alcance', cell: (d) => (d.scope === 'hold' ? `Bodega ${d.hold_number}` : d.scope === 'scale' ? d.scale_name : 'Operación') },
    { key: 'dur', header: 'Duración', align: 'right', cell: (d) => <b>{minutes(d.duration_minutes)}</b> },
    { key: 'obs', header: 'Observaciones', hideBelow: 'lg', wrap: true, cell: (d) => <span className="text-[13.5px]">{d.observations ?? '—'}</span> },
    { key: 'by', header: 'Registró', hideBelow: 'lg', cell: (d) => <span className="text-[13px]">{d.reported_by_name}</span> },
    { key: 'st', header: 'Estado', cell: (d) => <StatusBadge map={ACTIVE} value={d.status} /> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (d) => (
      <div className="flex justify-end gap-0.5">
        <Button size="sm" variant="ghost" aria-label="Historial" icon={<History className="h-4 w-4" />} onClick={() => setHist(d)} />
        {(can('corrections.request') || can('corrections.approve')) && d.status === 'valid' && <>
          <Button size="sm" variant="ghost" aria-label="Corregir" icon={<Pencil className="h-4 w-4" />} onClick={() => setCorr({ row: d, mode: 'update' })} />
          <Button size="sm" variant="ghost" aria-label="Anular" icon={<XCircle className="h-4 w-4 text-red" />} onClick={() => setCorr({ row: d, mode: 'void' })} />
        </>}
      </div>
    ) },
  ];
  const canRegister = can('downtime.register') && (!service || ['preparing', 'in_operation', 'suspended', 'closing'].includes(service.status));
  return (
    <div>
      <FilterBar>
        {!service && <Select aria-label="Servicio" value={f.dsvc} onChange={(e) => setF({ dsvc: e.target.value })}><option value="">Todos los servicios</option>{services.data?.map((s) => <option key={s.id} value={s.id}>{s.service_number} · {s.vessel_name}</option>)}</Select>}
        <Select aria-label="Evento" value={f.dcause} onChange={(e) => setF({ dcause: e.target.value })}><option value="">Todos los eventos</option>{causes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select aria-label="Alcance" value={f.dscope} onChange={(e) => setF({ dscope: e.target.value })}><option value="">Todos los alcances</option>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Input type="date" aria-label="Desde" value={f.dfrom} onChange={(e) => setF({ dfrom: e.target.value })} />
        <Input type="date" aria-label="Hasta" value={f.dto} onChange={(e) => setF({ dto: e.target.value })} />
        <Select aria-label="Estado" value={f.dst} onChange={(e) => setF({ dst: e.target.value })}><option value="valid">Válidos</option><option value="voided">Anulados</option><option value="">Todos</option></Select>
        <Button icon={<FileSpreadsheet className="h-4 w-4" />} loading={busy === 'x'} onClick={doExcel}>Excel</Button>
        <Button icon={<FileDown className="h-4 w-4" />} loading={busy === 'p'} onClick={doPdf}>PDF</Button>
        {canRegister && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Registrar tiempo perdido</Button>}
      </FilterBar>
      <ErrorBox error={q.error} />
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(d) => d.id} loading={q.isFetching} rowClassName={(d) => (d.status === 'voided' ? 'opacity-60' : undefined)} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ dpage: String(p) }, false)} onPageSize={(s) => setF({ dsize: String(s) })} />
      <DowntimeForm open={open} onClose={() => setOpen(false)} orgId={orgId} service={service} />
      {corr && <CorrectionDialog target={{ type: 'downtime_event', row: corr.row }} mode={corr.mode} tz={tz} onClose={() => setCorr(null)} />}
      <Modal open={!!hist} onClose={() => setHist(null)} title="Historial del evento">{hist && <RecordHistory targetId={hist.id} tz={tz} />}</Modal>
    </div>
  );
}
