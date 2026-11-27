import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Pencil, Plus, RotateCcw, Scale as ScaleIcon, Trash2, Weight } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { callFunction, rpc, supabase, unwrap } from '@/lib/supabase';
import { useMembers, useProducts, useRealtime, useScales, useUrlState } from '@/lib/hooks';
import { useServiceCargo } from '@/lib/service-data';
import { dt, fmt0, fmt1, fmt3, localInput, localToIso, pct } from '@/lib/format';
import { FIELD_LABEL, SERVICE_FLOW, SERVICE_STATUS } from '@/lib/labels';
import { ShipView } from '@/components/ShipView';
import { HoldDrawer } from '@/components/HoldDrawer';
import { BlTab, ShiftsTab, TrucksTab } from '@/components/ServiceExtras';
import { CyclesTable } from '@/components/CyclesTable';
import { DowntimeList, DowntimeSummary } from '@/components/DowntimePanel';
import { ProductivityPanel } from '@/components/ProductivityPanel';
import { ServiceReports } from '@/components/ServiceReports';
import { Badge, Button, Checkbox, DataTable, DL, Dot, EmptyState, ErrorBox, Field, Input, Kpi, Meter, Modal, Notice, PageHeader, ReasonDialog, Section, Select, Spinner, StatusBadge, Tabs, Textarea, useToast } from '@/components/ui';

type Svc = { id: string; organization_id: string; terminal_id: string; customer_id: string; vessel_id: string; service_number: string; status: string; planned_start: string | null; estimated_end: string | null; actual_start: string | null; finalized_at: string | null;
  responsible_name: string | null; responsible_user_id: string | null; observations: string | null; created_at: string; data_revision: number; customer_name: string; vessel_name: string; imo_number: string | null; terminal_name: string; timezone: string; report_status: string | null; cargo_type: 'bulk' | 'bags'; operation_kind: 'discharge' | 'load'; shift_plan_id: string | null };

export default function ServiceDetail() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useUrlState({ tab: 'resumen' });
  const s = useQuery({ queryKey: ['service', id], queryFn: async () => unwrap(await supabase.from('service_overview').select('*').eq('id', id!).maybeSingle()) as Svc | null });
  const closure = useQuery({ queryKey: ['svc-closure', id], queryFn: async () => unwrap(await supabase.from('services').select('closure_note').eq('id', id!).maybeSingle()) as { closure_note: string | null } | null });
  const cargo = useServiceCargo(id);
  useRealtime('services', `id=eq.${id}`, [['service', id]]);
  const [holdId, setHoldId] = useState<string | null>(null);
  const [dlg, setDlg] = useState<null | 'close' | 'reopen' | 'edit' | { to: string }>(null);
  if (s.isLoading) return <Spinner />;
  if (!s.data) return <EmptyState title="Servicio no encontrado">Puede que no exista o que no tenga acceso.</EmptyState>;
  const svc = s.data;
  const tz = svc.timezone;
  const next = SERVICE_FLOW[svc.status] ?? [];
  const refresh = () => { ['service', 'services', 'services-lite', 'dashboard-active', 'gen-report', 'versions', 'jobs'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const change = async (to: string, reason?: string) => {
    await rpc('change_service_status', { p_service: svc.id, p_status: to, p_reason: reason ?? null });
    toast(`Estado: ${SERVICE_STATUS[to].label}`); refresh();
  };
  const holdRow = cargo.holds.find((h) => h.id === holdId) ?? null;
  const load = svc.operation_kind === 'load';
  const bagsSvc = svc.cargo_type === 'bags';
  const sref = { id: svc.id, status: svc.status, timezone: tz, cargo_type: svc.cargo_type, operation_kind: svc.operation_kind };
  const locked = ['finalized', 'cancelled'].includes(svc.status);

  return (
    <div>
      <Link to="/app/servicios" className="mb-3 inline-flex items-center gap-1.5 text-[14px] font-semibold text-mute hover:text-ink"><ArrowLeft className="h-4 w-4" />Servicios</Link>
      <PageHeader
        title={<span className="num">{svc.service_number}</span>}
        sub={<span className="flex flex-wrap items-center gap-2"><StatusBadge map={SERVICE_STATUS} value={svc.status} /><b className="text-ink">{svc.vessel_name}</b>· <Link className="hover:underline" to={`/app/clientes/${svc.customer_id}`}>{svc.customer_name}</Link> · {svc.terminal_name}</span>}
        actions={<>
          {svc.status === 'in_operation' && can('weighing.register') && <Link to={`/app/pesaje?servicio=${svc.id}`}><Button variant="primary" icon={<Weight className="h-4 w-4" />}>{bagsSvc ? 'Registrar sacos' : 'Registrar pesaje'}</Button></Link>}
          {can('services.status') && next.filter((x) => x !== 'cancelled' || can('services.manage')).map((x) => (
            <Button key={x} variant={x === 'cancelled' ? 'ghost' : 'secondary'} onClick={() => (x === 'suspended' || x === 'cancelled' ? setDlg({ to: x }) : change(x).catch((e) => toast(e.message, 'bad')))}>
              {x === 'in_operation' ? (svc.status === 'suspended' || svc.status === 'closing' ? 'Reanudar operación' : 'Iniciar operación') : x === 'closing' ? 'Pasar a cierre' : x === 'suspended' ? 'Suspender' : x === 'cancelled' ? 'Cancelar servicio' : SERVICE_STATUS[x].label}
            </Button>
          ))}
          {can('services.close') && ['in_operation', 'suspended', 'closing'].includes(svc.status) && <Button variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => setDlg('close')}>Finalizar operación</Button>}
          {can('services.reopen') && svc.status === 'finalized' && <Button icon={<RotateCcw className="h-4 w-4" />} onClick={() => setDlg('reopen')}>Reabrir</Button>}
          {can('services.manage') && !locked && <Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => setDlg('edit')}>Editar</Button>}
        </>} />
      {locked && <Notice tone="info" className="mb-4">Servicio {SERVICE_STATUS[svc.status].label.toLowerCase()}: no admite nuevos pesajes{svc.status === 'finalized' ? ' sin una reapertura autorizada y auditada. Las correcciones generan una nueva versión del informe.' : '.'}</Notice>}
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={[
        { id: 'resumen', label: 'Resumen' }, { id: 'bodegas', label: 'Bodegas y carga' },
        ...(cargo.bls.length || can('services.manage') ? [{ id: 'bl', label: 'BL', count: cargo.bls.length }] : []),
        ...(!bagsSvc && (can('weighing.view_all') || can('weighing.register')) ? [{ id: 'ciclos', label: 'Pesajes y ciclos' }] : []),
        ...(!bagsSvc && can('services.view') ? [{ id: 'camiones', label: 'Camiones' }] : []),
        { id: 'turnos', label: bagsSvc ? 'Turnos y sacos' : 'Por turno' },
        { id: 'tiempos', label: 'Tiempos perdidos' },
        ...(can('productivity.view') ? [{ id: 'productividad', label: 'Productividad' }] : []),
        ...(can('reports.view') ? [{ id: 'reportes', label: 'Informe final' }] : []),
        { id: 'historial', label: 'Historial' },
      ]} />
      {f.tab === 'resumen' && (
        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label={load ? 'A cargar' : 'Tonelaje inicial'} value={`${fmt0(cargo.initial)} TM`} sub={bagsSvc ? `${fmt0(cargo.cargo.reduce((a, c) => a + (Number(c.initial_tm) * 1000) / (cargo.bagOf(c.product_id) || 1), 0))} sacos` : undefined} />
            <Kpi label={load ? 'Cargado' : 'Descargado'} value={`${fmt1(cargo.discharged)} TM`} sub={pct(cargo.initial ? (cargo.discharged / cargo.initial) * 100 : 0)} />
            <Kpi label="Pendiente" value={`${fmt1(cargo.pending)} TM`} tone="red" />
            <Kpi label="Bodegas" value={cargo.holds.length} sub={`${cargo.cargo.length} líneas de carga`} />
          </div>
          <Section title={svc.vessel_name}>
            {cargo.ship.length ? <ShipView holds={cargo.ship} selected={holdId} onSelect={setHoldId} vesselName={svc.vessel_name} kind={svc.operation_kind} /> : <p className="text-mute">Configure las bodegas del servicio.</p>}
          </Section>
          <Section title="Información del servicio">
            <DL cols={3} items={[['Cliente', svc.customer_name], ['Buque', `${svc.vessel_name}${svc.imo_number ? ` · IMO ${svc.imo_number}` : ''}`], ['Terminal', svc.terminal_name],
              ['Inicio programado', dt(svc.planned_start, tz)], ['Inicio real', dt(svc.actual_start, tz)], ['Fin estimado', dt(svc.estimated_end, tz)],
              ['Finalizado', dt(svc.finalized_at, tz)], ['Responsable', svc.responsible_name], ['Revisión de datos', svc.data_revision],
              ['Observaciones', svc.observations], ['Nota de cierre', closure.data?.closure_note]]} />
          </Section>
          <ServiceScales service={svc} locked={locked} />
        </div>
      )}
      {f.tab === 'bodegas' && <CargoTab service={svc} cargo={cargo} locked={locked} />}
      {f.tab === 'bl' && <BlTab svc={sref} />}
      {f.tab === 'camiones' && <TrucksTab svc={sref} />}
      {f.tab === 'turnos' && <ShiftsTab svc={sref} holds={cargo.holds.map((h) => h.hold_number)} />}
      {f.tab === 'ciclos' && <CyclesTable orgId={orgId} serviceId={svc.id} tz={tz} />}
      {f.tab === 'tiempos' && <div className="grid gap-5"><DowntimeList orgId={orgId} tz={tz} service={{ id: svc.id, service_number: svc.service_number, status: svc.status, vessel_name: svc.vessel_name, customer_name: svc.customer_name, terminal_id: svc.terminal_id, timezone: tz, customer_id: svc.customer_id, vessel_id: svc.vessel_id }} /><DowntimeSummary orgId={orgId} serviceId={svc.id} tz={tz} /></div>}
      {f.tab === 'productividad' && <ProductivityPanel serviceId={svc.id} tz={tz} />}
      {f.tab === 'reportes' && <ServiceReports service={{ id: svc.id, service_number: svc.service_number, status: svc.status, organization_id: svc.organization_id, timezone: tz }} />}
      {f.tab === 'historial' && <ServiceHistory serviceId={svc.id} tz={tz} />}

      {holdRow && <HoldDrawer serviceId={svc.id} hold={holdRow} cargo={cargo.cargo} tz={tz} open onClose={() => setHoldId(null)} canWeigh={svc.status === 'in_operation' && can('weighing.register')} />}
      <CloseDialog open={dlg === 'close'} onClose={() => setDlg(null)} service={svc} pending={cargo.pending} onDone={refresh} />
      <ReasonDialog open={dlg === 'reopen'} onClose={() => setDlg(null)} title="Reabrir servicio finalizado" confirmLabel="Reabrir"
        description="El servicio volverá a «En operación» y admitirá pesajes. Al finalizar de nuevo se generará una nueva versión del informe; la versión firmada actual quedará sustituida al firmar la nueva."
        onConfirm={async (r) => { await rpc('reopen_service', { p_service: svc.id, p_reason: r }); toast('Servicio reabierto'); refresh(); }} />
      <ReasonDialog open={typeof dlg === 'object' && dlg !== null} onClose={() => setDlg(null)} danger={typeof dlg === 'object' && dlg?.to === 'cancelled'}
        title={typeof dlg === 'object' && dlg?.to === 'cancelled' ? 'Cancelar servicio' : 'Suspender operación'} confirmLabel="Confirmar"
        onConfirm={async (r) => { if (typeof dlg === 'object' && dlg) await change(dlg.to, r); }} />
      {dlg === 'edit' && <EditService service={svc} onClose={() => setDlg(null)} onSaved={refresh} />}
    </div>
  );
}

function CloseDialog({ open, onClose, service, pending, onDone }: { open: boolean; onClose: () => void; service: Svc; pending: number; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [concl, setConcl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setNote(''); setConcl(''); setErr(null); } }, [open]);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await rpc<{ job_id: string | null }>('close_service', { p_service: service.id, p_note: note || null, p_conclusions: concl || null });
      toast('Servicio finalizado. Generando el informe final…', 'info');
      onClose(); onDone();
      if (r.job_id) {
        callFunction<{ version?: number }>('report-worker', { job_id: r.job_id })
          .then((x) => { toast(x.version ? `Informe v${x.version} generado: pendiente de firma` : 'Informe en proceso'); onDone(); })
          .catch((e) => toast(`El informe quedó en cola: ${e.message}`, 'bad'));
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Finalizar ${service.service_number}`}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Finalizar y generar informe</Button></>}>
      <div className="grid gap-4 text-[14px]">
        <p>Se validará que no existan correcciones pendientes, se conciliará el tonelaje (saldo = movimientos = pesajes) y se generará automáticamente el informe final en PDF para su firma.</p>
        {pending > 0.0005 ? <Notice tone="warn">Quedan <b>{fmt3(pending)} TM</b> pendientes según el tonelaje inicial. Registre una nota de conciliación (p. ej. remanente a bordo, diferencia de manifiesto).</Notice> : <Notice tone="ok">Todo el tonelaje inicial fue descargado.</Notice>}
        <Field label="Nota de cierre / conciliación" hint="Aparece en la sección 8 del informe."><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="Conclusiones del informe"><Textarea value={concl} onChange={(e) => setConcl(e.target.value)} placeholder="Opcional; puede editarse antes de firmar." /></Field>
        {err && <ErrorBox error={err} />}
      </div>
    </Modal>
  );
}

function EditService({ service, onClose, onSaved }: { service: Svc; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useOrg();
  const members = useMembers(orgId);
  const toast = useToast();
  const tz = service.timezone;
  const [v, setV] = useState({ service_number: service.service_number, planned_start: service.planned_start ? localInput(service.planned_start, tz) : '', estimated_end: service.estimated_end ? localInput(service.estimated_end, tz) : '', responsible_user_id: service.responsible_user_id ?? '', responsible_name: service.responsible_name ?? '', observations: service.observations ?? '' });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      unwrap(await supabase.from('services').update({ service_number: v.service_number.trim(), planned_start: localToIso(v.planned_start, tz), estimated_end: localToIso(v.estimated_end, tz), responsible_user_id: v.responsible_user_id || null,
        responsible_name: members.data?.find((m) => m.user_id === v.responsible_user_id)?.profile?.full_name ?? (v.responsible_name || null), observations: v.observations || null }).eq('id', service.id));
      toast('Servicio actualizado'); onSaved(); onClose();
    } catch (e) { const m = (e as Error).message; setErr(/Ya existe/.test(m) ? 'Ese número de servicio ya existe en la empresa.' : m); }
  };
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Modal open onClose={onClose} title="Editar servicio" footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
      <div className="grid gap-4">
        <Field label="Número de servicio"><Input value={v.service_number} onChange={set('service_number')} className="num" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Inicio programado"><Input type="datetime-local" value={v.planned_start} onChange={set('planned_start')} /></Field>
          <Field label="Fin estimado"><Input type="datetime-local" value={v.estimated_end} onChange={set('estimated_end')} /></Field>
        </div>
        <Field label="Responsable"><Select value={v.responsible_user_id} onChange={set('responsible_user_id')}><option value="">Sin asignar</option>{members.data?.map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name}</option>)}</Select></Field>
        <Field label="Observaciones (visibles para el cliente)"><Textarea value={v.observations} onChange={set('observations')} /></Field>
        {err && <ErrorBox error={err} />}
      </div>
    </Modal>
  );
}

function ServiceScales({ service, locked }: { service: Svc; locked: boolean }) {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const scales = useScales(orgId);
  const assigned = useQuery({ queryKey: ['svc-scales', service.id], queryFn: async () => unwrap(await supabase.from('service_scales').select('scale_id').eq('service_id', service.id)) as { scale_id: string }[] });
  const ids = new Set((assigned.data ?? []).map((x) => x.scale_id));
  const toggle = async (sid: string, on: boolean) => {
    if (on) unwrap(await supabase.from('service_scales').insert({ service_id: service.id, scale_id: sid, organization_id: service.organization_id, terminal_id: service.terminal_id }));
    else unwrap(await supabase.from('service_scales').delete().eq('service_id', service.id).eq('scale_id', sid));
    qc.invalidateQueries({ queryKey: ['svc-scales', service.id] });
  };
  const list = (scales.data ?? []).filter((x) => x.terminal_id === service.terminal_id);
  return (
    <Section title={<span className="inline-flex items-center gap-2"><ScaleIcon className="h-5 w-5" />Básculas de la operación</span>}>
      <div className="flex flex-wrap gap-x-6">
        {list.map((x) => (can('services.manage') && !locked
          ? <Checkbox key={x.id} label={`${x.name} (${x.code})`} hint={x.status !== 'active' ? 'Fuera de servicio' : x.location ?? undefined} checked={ids.has(x.id)} onChange={(on) => toggle(x.id, on).catch(() => undefined)} />
          : ids.has(x.id) && <Badge key={x.id} tone="info" className="my-1 mr-2">{x.name}</Badge>))}
        {!list.length && <p className="text-mute">La terminal no tiene básculas registradas.</p>}
      </div>
    </Section>
  );
}

function CargoTab({ service, cargo, locked }: { service: Svc; cargo: ReturnType<typeof useServiceCargo>; locked: boolean }) {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const products = useProducts(orgId);
  const [adj, setAdj] = useState<{ id: string; name: string; initial: number; discharged: number } | null>(null);
  const [adjVal, setAdjVal] = useState('');
  const [add, setAdd] = useState<{ hold: string; product: string; tm: string }>({ hold: '', product: '', tm: '' });
  const [newHold, setNewHold] = useState('');
  const inv = () => { cargo.refetch(); qc.invalidateQueries({ queryKey: ['service', service.id] }); };
  const manage = can('services.manage') && !locked;
  const addLine = async () => {
    if (!add.hold || !add.product || !(Number(add.tm) > 0)) return toast('Seleccione bodega, producto y tonelaje.', 'bad');
    try { unwrap(await supabase.from('service_hold_cargo').insert({ service_id: service.id, service_hold_id: add.hold, product_id: add.product, initial_tm: Number(add.tm), organization_id: service.organization_id, terminal_id: service.terminal_id })); setAdd({ hold: '', product: '', tm: '' }); inv(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  const addHold = async () => {
    const n = Number(newHold); if (!(n >= 1)) return;
    try { unwrap(await supabase.from('service_holds').insert({ service_id: service.id, vessel_id: service.vessel_id, hold_number: n, organization_id: service.organization_id, terminal_id: service.terminal_id })); setNewHold(''); inv(); }
    catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="grid gap-4">
      {cargo.holds.map((h) => {
        const lines = cargo.cargo.filter((c) => c.service_hold_id === h.id);
        return (
          <Section key={h.id} title={`Bodega ${h.hold_number}`} actions={<span className="text-[13px] text-mute">{h.vessel?.name}{h.capacity_tm ? ` · capacidad ${fmt0(h.capacity_tm)} TM` : ''}</span>}>
            <DataTable rows={lines} rowKey={(c) => c.id} columns={[
              { key: 'p', header: 'Producto', cell: (c) => <span className="inline-flex items-center gap-2"><Dot color={c.product.color} />{c.product.name}</span> },
              { key: 'i', header: 'Inicial (TM)', align: 'right', cell: (c) => fmt3(c.initial_tm) },
              { key: 'd', header: 'Descargado (TM)', align: 'right', cell: (c) => fmt3(c.discharged_tm) },
              { key: 'pe', header: 'Pendiente (TM)', align: 'right', cell: (c) => <b className="text-red">{fmt3(Number(c.initial_tm) - Number(c.discharged_tm))}</b> },
              { key: 'av', header: 'Avance', cell: (c) => <div className="min-w-[110px]"><span className="num text-[13px]">{pct(Number(c.initial_tm) ? (Number(c.discharged_tm) / Number(c.initial_tm)) * 100 : 0)}</span><Meter value={Number(c.initial_tm) ? (Number(c.discharged_tm) / Number(c.initial_tm)) * 100 : 0} /></div> },
              { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (c) => (
                <div className="flex justify-end gap-1">
                  {!locked && (can('cargo.adjust') || (manage && Number(c.discharged_tm) === 0)) && <Button size="sm" variant="ghost" onClick={() => { setAdj({ id: c.id, name: `Bodega ${h.hold_number} · ${c.product.name}`, initial: Number(c.initial_tm), discharged: Number(c.discharged_tm) }); setAdjVal(String(Number(c.initial_tm))); }}>Ajustar tonelaje</Button>}
                  {manage && Number(c.discharged_tm) === 0 && <Button size="sm" variant="ghost" aria-label="Quitar" icon={<Trash2 className="h-4 w-4" />} onClick={async () => { try { unwrap(await supabase.from('service_hold_cargo').delete().eq('id', c.id)); inv(); } catch (e) { toast((e as Error).message, 'bad'); } }} />}
                </div>
              ) },
            ]} />
          </Section>
        );
      })}
      {manage && (
        <Section title="Agregar configuración">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_160px_auto] md:items-end">
            <Field label="Bodega"><Select value={add.hold} onChange={(e) => setAdd({ ...add, hold: e.target.value })}><option value="">Seleccione…</option>{cargo.holds.map((h) => <option key={h.id} value={h.id}>Bodega {h.hold_number}</option>)}</Select></Field>
            <Field label="Producto"><Select value={add.product} onChange={(e) => setAdd({ ...add, product: e.target.value })}><option value="">Seleccione…</option>{products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Tonelaje (TM)"><Input type="number" className="num text-right" value={add.tm} onChange={(e) => setAdd({ ...add, tm: e.target.value })} /></Field>
            <Button icon={<Plus className="h-4 w-4" />} onClick={addLine}>Agregar producto</Button>
          </div>
          <div className="mt-3 flex items-end gap-3"><Field label="Nueva bodega N.º"><Input type="number" min="1" className="w-28" value={newHold} onChange={(e) => setNewHold(e.target.value)} /></Field><Button onClick={addHold}>Agregar bodega</Button></div>
        </Section>
      )}
      <AdjustDialog adj={adj} value={adjVal} setValue={setAdjVal} onClose={() => setAdj(null)} onDone={inv} />
    </div>
  );
}

function AdjustDialog({ adj, value, setValue, onClose, onDone }: { adj: { id: string; name: string; initial: number; discharged: number } | null; value: string; setValue: (v: string) => void; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  if (!adj) return null;
  return (
    <ReasonDialog open onClose={onClose} title={`Ajustar tonelaje · ${adj.name}`} confirmLabel="Guardar ajuste"
      description={<p>Tonelaje actual {fmt3(adj.initial)} TM · descargado {fmt3(adj.discharged)} TM. El saldo descargado no cambia; queda registrado el valor anterior, el nuevo y el motivo.</p>}
      extra={<Field label="Nuevo tonelaje inicial (TM)"><Input type="number" className="num text-right" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
      onConfirm={async (reason) => {
        if (adj.discharged === 0) {
          await rpc('adjust_cargo_initial', { p_cargo: adj.id, p_new_initial: Number(value), p_reason: reason }).catch(async (e) => {
            if (!/Permiso insuficiente/.test(e.message)) throw e;
            unwrap(await supabase.from('service_hold_cargo').update({ initial_tm: Number(value), notes: reason }).eq('id', adj.id));
          });
        } else await rpc('adjust_cargo_initial', { p_cargo: adj.id, p_new_initial: Number(value), p_reason: reason });
        toast('Tonelaje ajustado'); onDone();
      }} />
  );
}

function ServiceHistory({ serviceId, tz }: { serviceId: string; tz: string }) {
  const { can } = useAuth();
  const corr = useQuery({ queryKey: ['svc-corr-history', serviceId], queryFn: async () => unwrap(await supabase.from('correction_history').select('id, target_type, field, old_value, new_value, reason, applied_by_name, applied_at').eq('service_id', serviceId).order('applied_at', { ascending: false }).limit(200)) as { id: number; target_type: string; field: string; old_value: string | null; new_value: string | null; reason: string; applied_by_name: string | null; applied_at: string }[] });
  const adj = useQuery({ queryKey: ['svc-adj', serviceId], queryFn: async () => unwrap(await supabase.from('cargo_adjustments').select('id, previous_initial_tm, new_initial_tm, reason, created_at').eq('service_id', serviceId).order('created_at', { ascending: false })) as { id: string; previous_initial_tm: number; new_initial_tm: number; reason: string; created_at: string }[] });
  const audit = useQuery({ queryKey: ['svc-audit', serviceId], enabled: can('audit.view'), queryFn: async () => unwrap(await supabase.from('audit_logs').select('id, action, changed_fields, old_data, new_data, reason, actor_name, created_at').eq('table_name', 'services').eq('record_id', serviceId).order('created_at', { ascending: false }).limit(100)) as { id: number; action: string; changed_fields: string[] | null; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null; reason: string | null; actor_name: string | null; created_at: string }[] });
  return (
    <div className="grid gap-5">
      {can('audit.view') && (
        <Section title="Cambios de estado y del servicio">
          <ol className="grid gap-2">
            {(audit.data ?? []).map((a) => (
              <li key={a.id} className="rounded-lg border border-line px-3 py-2 text-[14px]">
                <b>{a.action === 'INSERT' ? 'Creación del servicio' : (a.changed_fields ?? []).includes('status') ? `Estado: ${SERVICE_STATUS[String(a.old_data?.status)]?.label} → ${SERVICE_STATUS[String(a.new_data?.status)]?.label}` : `Modificación: ${(a.changed_fields ?? []).join(', ')}`}</b>
                <div className="text-[13px] text-mute">{a.actor_name ?? 'sistema'} · {dt(a.created_at, tz)}{a.reason ? ` · ${a.reason}` : ''}</div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title="Correcciones aplicadas">
        {corr.data?.length ? (
          <ol className="grid gap-2">{corr.data.map((h) => (
            <li key={h.id} className="rounded-lg border border-line px-3 py-2 text-[14px]">
              <b>{h.target_type === 'weigh_ticket' ? 'Pesaje' : 'Tiempo perdido'} · {FIELD_LABEL[h.field] ?? h.field}</b>: <span className="text-mute line-through">{h.old_value ?? '—'}</span> → <b>{h.new_value ?? '—'}</b>
              <div className="text-[13px] text-mute">{h.reason} · {h.applied_by_name} · {dt(h.applied_at, tz)}</div>
            </li>))}</ol>
        ) : <p className="text-mute">Sin correcciones.</p>}
      </Section>
      <Section title="Ajustes de tonelaje">
        {adj.data?.length ? <ol className="grid gap-2">{adj.data.map((a) => <li key={a.id} className="text-[14px]">{fmt3(a.previous_initial_tm)} → <b>{fmt3(a.new_initial_tm)} TM</b> · {a.reason} · <span className="text-mute">{dt(a.created_at, tz)}</span></li>)}</ol> : <p className="text-mute">Sin ajustes.</p>}
      </Section>
    </div>
  );
}
