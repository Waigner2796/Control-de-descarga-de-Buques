import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useTerminals, useUrlState, type Terminal } from '@/lib/hooks';
import { SCOPE, TIME_MODE } from '@/lib/labels';
import { Badge, Button, Checkbox, DataTable, ErrorBox, Field, Input, Modal, PageHeader, Section, Select, Tabs, useToast, type Column } from '@/components/ui';

const TZS = ['America/Guatemala', 'America/El_Salvador', 'America/Tegucigalpa', 'America/Managua', 'America/Costa_Rica', 'America/Panama', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Guayaquil', 'America/Santo_Domingo', 'America/New_York', 'Europe/Madrid', 'UTC'];

export default function Settings() {
  const { can } = useAuth();
  const [f, setF] = useUrlState({ tab: can('org.manage') ? 'empresa' : can('downtime.manage') ? 'eventos' : 'terminales' });
  const tabs = [
    ...(can('org.manage') ? [{ id: 'empresa', label: 'Empresa' }] : []),
    ...(can('org.manage') || can('scales.manage') ? [{ id: 'terminales', label: 'Terminales y horas' }] : []),
    ...(can('org.manage') ? [{ id: 'turnos', label: 'Turnos' }, { id: 'umbrales', label: 'Umbrales y preferencias' }] : []),
    ...(can('downtime.manage') ? [{ id: 'eventos', label: 'Catálogo de tiempos perdidos' }] : []),
  ];
  return (
    <div>
      <PageHeader title="Configuración" sub="Empresa, terminales, modalidad de captura de horas, turnos, umbrales y catálogos." />
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={tabs} />
      {f.tab === 'empresa' && <OrgTab />}
      {f.tab === 'terminales' && <TerminalsTab />}
      {f.tab === 'turnos' && <ShiftsTab />}
      {f.tab === 'umbrales' && <ThresholdsTab />}
      {f.tab === 'eventos' && <DowntimeCatalog />}
    </div>
  );
}

function OrgTab() {
  const { orgId } = useOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['org-full', orgId], queryFn: async () => unwrap(await supabase.from('organizations').select('name, legal_name, tax_id, country, address, phone, email, website').eq('id', orgId).single()) as Record<string, string | null> });
  const [v, setV] = useState<Record<string, string>>({});
  useEffect(() => { if (q.data) setV(Object.fromEntries(Object.entries(q.data).map(([k, x]) => [k, x ?? '']))); }, [q.data]);
  const save = async () => { try { unwrap(await supabase.from('organizations').update(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]))).eq('id', orgId)); qc.invalidateQueries({ queryKey: ['my_context'] }); toast('Datos de la empresa guardados'); } catch (e) { toast((e as Error).message, 'bad'); } };
  const L: Record<string, string> = { name: 'Nombre comercial', legal_name: 'Razón social', tax_id: 'NIT', country: 'País', address: 'Dirección', phone: 'Teléfono', email: 'Correo', website: 'Sitio web' };
  return (
    <Section title="Datos de la empresa prestadora del servicio">
      <div className="grid gap-4 md:grid-cols-2">{Object.keys(L).map((k) => <Field key={k} label={L[k]}><Input value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}</div>
      <Button className="mt-4" variant="primary" onClick={save}>Guardar</Button>
    </Section>
  );
}

function TerminalsTab() {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const terminals = useTerminals(orgId);
  const ts = useQuery({ queryKey: ['terminal-settings', orgId], queryFn: async () => unwrap(await supabase.from('terminal_settings').select('terminal_id, time_capture_mode').eq('organization_id', orgId)) as { terminal_id: string; time_capture_mode: string }[] });
  const E = { code: '', name: '', port_name: '', address: '', timezone: 'America/Guatemala', status: 'active' };
  const [form, setForm] = useState<{ open: boolean; row?: Terminal; v: typeof E }>({ open: false, v: E });
  const [err, setErr] = useState<string | null>(null);
  const setMode = async (tid: string, mode: string) => {
    try {
      if (ts.data?.some((x) => x.terminal_id === tid)) unwrap(await supabase.from('terminal_settings').update({ time_capture_mode: mode }).eq('terminal_id', tid));
      else unwrap(await supabase.from('terminal_settings').insert({ terminal_id: tid, organization_id: orgId, time_capture_mode: mode }));
      qc.invalidateQueries({ queryKey: ['terminal-settings'] }); qc.invalidateQueries({ queryKey: ['scale-mode'] }); toast(`Modalidad: ${TIME_MODE[mode]}`);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const save = async () => {
    setErr(null);
    try {
      const p = { code: form.v.code.trim(), name: form.v.name.trim(), port_name: form.v.port_name || null, address: form.v.address || null, timezone: form.v.timezone, status: form.v.status };
      if (form.row) unwrap(await supabase.from('terminals').update(p).eq('id', form.row.id));
      else unwrap(await supabase.from('terminals').insert({ ...p, organization_id: orgId }));
      qc.invalidateQueries({ queryKey: ['terminals'] }); qc.invalidateQueries({ queryKey: ['terminal-settings'] }); setForm({ open: false, v: E });
    } catch (e) { setErr((e as Error).message); }
  };
  const cols: Column<Terminal>[] = [
    { key: 'c', header: 'Código', cell: (t) => <b className="num">{t.code}</b> },
    { key: 'n', header: 'Terminal', cell: (t) => <div>{t.name}<div className="text-[13px] text-mute">{t.port_name}</div></div> },
    { key: 'z', header: 'Zona horaria', cell: (t) => <span className="num text-[13.5px]">{t.timezone}</span> },
    { key: 'm', header: 'Captura de horas en báscula', cell: (t) => (
      <Select aria-label="Modalidad" className="min-h-[36px] py-1" value={ts.data?.find((x) => x.terminal_id === t.id)?.time_capture_mode ?? 'manual'} onChange={(e) => setMode(t.id, e.target.value)}>
        <option value="manual">{TIME_MODE.manual}</option><option value="server_now">{TIME_MODE.server_now}</option>
      </Select>
    ) },
    { key: 's', header: 'Estado', cell: (t) => (t.status === 'active' ? <Badge tone="ok">Activa</Badge> : <Badge>Inactiva</Badge>) },
    { key: 'a', header: <span className="sr-only">Editar</span>, align: 'right', cell: (t) => can('org.manage') && <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, row: t, v: { code: t.code, name: t.name, port_name: t.port_name ?? '', address: t.address ?? '', timezone: t.timezone, status: t.status } })}>Editar</Button> },
  ];
  return (
    <div>
      <p className="mb-3 max-w-[80ch] text-[14px] text-mute">Las fechas se guardan en UTC y se presentan en la hora local de cada terminal. La modalidad de captura de horas aplica a todas las básculas de la terminal salvo que una báscula defina la suya.</p>
      {can('org.manage') && <div className="mb-3 flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(null); setForm({ open: true, v: E }); }}>Nueva terminal</Button></div>}
      <DataTable columns={cols} rows={terminals.data} rowKey={(t) => t.id} loading={terminals.isLoading} />
      <Modal open={form.open} onClose={() => setForm({ ...form, open: false })} title={form.row ? 'Editar terminal' : 'Nueva terminal'} footer={<><Button onClick={() => setForm({ ...form, open: false })}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Código"><Input value={form.v.code} onChange={(e) => setForm({ ...form, v: { ...form.v, code: e.target.value } })} /></Field>
          <Field label="Nombre"><Input value={form.v.name} onChange={(e) => setForm({ ...form, v: { ...form.v, name: e.target.value } })} /></Field>
          <Field label="Puerto"><Input value={form.v.port_name} onChange={(e) => setForm({ ...form, v: { ...form.v, port_name: e.target.value } })} /></Field>
          <Field label="Zona horaria"><Select value={form.v.timezone} onChange={(e) => setForm({ ...form, v: { ...form.v, timezone: e.target.value } })}>{TZS.map((z) => <option key={z}>{z}</option>)}</Select></Field>
          <Field label="Dirección" className="sm:col-span-2"><Input value={form.v.address} onChange={(e) => setForm({ ...form, v: { ...form.v, address: e.target.value } })} /></Field>
          <Field label="Estado"><Select value={form.v.status} onChange={(e) => setForm({ ...form, v: { ...form.v, status: e.target.value } })}><option value="active">Activa</option><option value="inactive">Inactiva</option></Select></Field>
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
    </div>
  );
}

function ShiftsTab() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const terminals = useTerminals(orgId);
  const q = useQuery({ queryKey: ['shifts', orgId], queryFn: async () => unwrap(await supabase.from('shifts').select('*').eq('organization_id', orgId).order('sort')) as { id: string; terminal_id: string; name: string; start_time: string; end_time: string; sort: number; status: string }[] });
  const [n, setN] = useState({ terminal_id: '', name: '', start_time: '06:00', end_time: '14:00' });
  const add = async () => { try { unwrap(await supabase.from('shifts').insert({ ...n, terminal_id: n.terminal_id || terminals.data?.[0]?.id, organization_id: orgId, sort: (q.data?.length ?? 0) + 1 })); qc.invalidateQueries({ queryKey: ['shifts'] }); setN({ ...n, name: '' }); } catch (e) { toast((e as Error).message, 'bad'); } };
  const upd = async (id: string, p: Record<string, unknown>) => { try { unwrap(await supabase.from('shifts').update(p).eq('id', id)); qc.invalidateQueries({ queryKey: ['shifts'] }); } catch (e) { toast((e as Error).message, 'bad'); } };
  return (
    <div className="grid gap-4">
      {terminals.data?.map((t) => (
        <Section key={t.id} title={t.name}>
          <div className="grid gap-2">
            {(q.data ?? []).filter((s) => s.terminal_id === t.id).map((s) => (
              <div key={s.id} className="grid grid-cols-[1fr_120px_120px_auto] items-center gap-2">
                <Input defaultValue={s.name} onBlur={(e) => e.target.value !== s.name && upd(s.id, { name: e.target.value })} aria-label="Nombre del turno" />
                <Input type="time" defaultValue={s.start_time.slice(0, 5)} onBlur={(e) => upd(s.id, { start_time: e.target.value })} aria-label="Inicio" />
                <Input type="time" defaultValue={s.end_time.slice(0, 5)} onBlur={(e) => upd(s.id, { end_time: e.target.value })} aria-label="Fin" />
                <Checkbox label="Activo" checked={s.status === 'active'} onChange={(v) => upd(s.id, { status: v ? 'active' : 'inactive' })} />
              </div>
            ))}
          </div>
        </Section>
      ))}
      <Section title="Agregar turno">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_120px_auto] sm:items-end">
          <Field label="Terminal"><Select value={n.terminal_id} onChange={(e) => setN({ ...n, terminal_id: e.target.value })}>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Nombre"><Input value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} /></Field>
          <Field label="Inicio"><Input type="time" value={n.start_time} onChange={(e) => setN({ ...n, start_time: e.target.value })} /></Field>
          <Field label="Fin"><Input type="time" value={n.end_time} onChange={(e) => setN({ ...n, end_time: e.target.value })} /></Field>
          <Button onClick={add}>Agregar</Button>
        </div>
        <p className="mt-2 text-[13px] text-mute">Un turno puede cruzar la medianoche (p. ej. 22:00 a 06:00).</p>
      </Section>
    </div>
  );
}

function ThresholdsTab() {
  const { orgId } = useOrg();
  const toast = useToast();
  const th = useQuery({ queryKey: ['thresholds', orgId], queryFn: async () => unwrap(await supabase.from('operational_thresholds').select('*').eq('organization_id', orgId).single()) as Record<string, number> });
  const os = useQuery({ queryKey: ['org-settings', orgId], queryFn: async () => unwrap(await supabase.from('organization_settings').select('*').eq('organization_id', orgId).single()) as Record<string, string | boolean> });
  const [t, setT] = useState<Record<string, string>>({});
  const [o, setO] = useState<Record<string, string | boolean>>({});
  useEffect(() => { if (th.data) setT(Object.fromEntries(['long_cycle_minutes', 'max_cycle_hours', 'max_downtime_hours', 'max_net_kg', 'reconciliation_tolerance_tm'].map((k) => [k, String(th.data[k])]))); }, [th.data]);
  useEffect(() => { if (os.data) setO({ weight_input_unit: os.data.weight_input_unit, dpi_exposure_in_reports: os.data.dpi_exposure_in_reports, report_footer: os.data.report_footer, notify_customers_email: os.data.notify_customers_email }); }, [os.data]);
  const save = async () => {
    try {
      unwrap(await supabase.from('operational_thresholds').update(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Number(v)]))).eq('organization_id', orgId));
      unwrap(await supabase.from('organization_settings').update(o).eq('organization_id', orgId));
      toast('Configuración guardada');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const L: Record<string, [string, string]> = {
    long_cycle_minutes: ['Ciclo largo (min)', 'Resalta en rojo los ciclos mayores.'], max_cycle_hours: ['Ciclo máximo (h)', 'Rechaza ciclos mayores.'],
    max_downtime_hours: ['Duración máxima de un tiempo perdido (h)', 'Rechaza eventos mayores.'], max_net_kg: ['Neto máximo por camión (kg)', 'Evita errores de digitación.'],
    reconciliation_tolerance_tm: ['Tolerancia de conciliación (TM)', 'Pendiente permitido al cerrar sin nota.'],
  };
  return (
    <div className="grid gap-5">
      <Section title="Umbrales operativos"><div className="grid gap-4 md:grid-cols-3">{Object.keys(L).map((k) => <Field key={k} label={L[k][0]} hint={L[k][1]}><Input type="number" value={t[k] ?? ''} onChange={(e) => setT({ ...t, [k]: e.target.value })} className="num" /></Field>)}</div></Section>
      <Section title="Preferencias">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Unidad de captura de pesos" hint="Internamente todo se calcula en toneladas métricas (1 TM = 1,000 kg)."><Select value={String(o.weight_input_unit ?? 'kg')} onChange={(e) => setO({ ...o, weight_input_unit: e.target.value })}><option value="kg">Kilogramos</option><option value="tm">Toneladas métricas</option></Select></Field>
          <Field label="DPI de pilotos en el informe PDF"><Select value={String(o.dpi_exposure_in_reports ?? 'masked')} onChange={(e) => setO({ ...o, dpi_exposure_in_reports: e.target.value })}><option value="masked">Parcial (últimos 4 dígitos)</option><option value="full">Completo</option><option value="hidden">Oculto</option></Select></Field>
          <Field label="Pie de página de reportes" className="md:col-span-2"><Input value={String(o.report_footer ?? '')} onChange={(e) => setO({ ...o, report_footer: e.target.value })} /></Field>
          <Checkbox label="Notificar por correo a los clientes cuando se publique un informe" hint="Requiere proveedor de correo configurado en las Edge Functions." checked={!!o.notify_customers_email} onChange={(v) => setO({ ...o, notify_customers_email: v })} />
        </div>
      </Section>
      <div><Button variant="primary" onClick={save}>Guardar</Button></div>
    </div>
  );
}

function DowntimeCatalog() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const cats = useQuery({ queryKey: ['dt-cats', orgId], queryFn: async () => unwrap(await supabase.from('downtime_categories').select('*').eq('organization_id', orgId).order('sort')) as { id: string; name: string; color: string; status: string }[] });
  const causes = useQuery({ queryKey: ['dt-causes', orgId], queryFn: async () => unwrap(await supabase.from('downtime_causes').select('*').eq('organization_id', orgId).order('sort')) as { id: string; name: string; category_id: string; default_scope: string; status: string }[] });
  const [nc, setNc] = useState({ name: '', color: '#5a6a79' });
  const [ne, setNe] = useState({ name: '', category_id: '', default_scope: 'operation' });
  const inv = () => { ['dt-cats', 'dt-causes', 'causes'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); };
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); inv(); } catch (e) { toast((e as Error).message, 'bad'); } };
  return (
    <div className="grid gap-5">
      <Section title="Categorías">
        <div className="flex flex-wrap gap-2">{cats.data?.map((c) => <span key={c.id} className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-[14px]"><i className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />{c.name}<button className="text-[12px] text-mute hover:underline" onClick={() => run(async () => unwrap(await supabase.from('downtime_categories').update({ status: c.status === 'active' ? 'inactive' : 'active' }).eq('id', c.id)))}>{c.status === 'active' ? 'desactivar' : 'activar'}</button></span>)}</div>
        <div className="mt-3 flex flex-wrap items-end gap-2"><Field label="Nueva categoría"><Input value={nc.name} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></Field><input type="color" aria-label="Color" value={nc.color} onChange={(e) => setNc({ ...nc, color: e.target.value })} className="h-10 w-12 rounded border border-edge" /><Button icon={<Plus className="h-4 w-4" />} onClick={() => run(async () => { unwrap(await supabase.from('downtime_categories').insert({ ...nc, organization_id: orgId, sort: (cats.data?.length ?? 0) + 1 })); setNc({ name: '', color: '#5a6a79' }); })}>Agregar</Button></div>
      </Section>
      <Section title="Eventos (causas de tiempo perdido)">
        <DataTable rows={causes.data} rowKey={(c) => c.id} columns={[
          { key: 'n', header: 'Evento', cell: (c) => <Input defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && run(async () => unwrap(await supabase.from('downtime_causes').update({ name: e.target.value }).eq('id', c.id)))} aria-label="Nombre" /> },
          { key: 'c', header: 'Categoría', cell: (c) => <Select value={c.category_id} onChange={(e) => run(async () => unwrap(await supabase.from('downtime_causes').update({ category_id: e.target.value }).eq('id', c.id)))}>{cats.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select> },
          { key: 's', header: 'Alcance sugerido', cell: (c) => <Select value={c.default_scope} onChange={(e) => run(async () => unwrap(await supabase.from('downtime_causes').update({ default_scope: e.target.value }).eq('id', c.id)))}>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select> },
          { key: 'a', header: 'Activo', cell: (c) => <Checkbox label="" checked={c.status === 'active'} onChange={(v) => run(async () => unwrap(await supabase.from('downtime_causes').update({ status: v ? 'active' : 'inactive' }).eq('id', c.id)))} /> },
        ]} />
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
          <Field label="Nuevo evento"><Input value={ne.name} onChange={(e) => setNe({ ...ne, name: e.target.value })} /></Field>
          <Field label="Categoría"><Select value={ne.category_id} onChange={(e) => setNe({ ...ne, category_id: e.target.value })}><option value="">Seleccione…</option>{cats.data?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
          <Field label="Alcance sugerido"><Select value={ne.default_scope} onChange={(e) => setNe({ ...ne, default_scope: e.target.value })}>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => run(async () => { if (!ne.category_id) throw new Error('Seleccione la categoría'); unwrap(await supabase.from('downtime_causes').insert({ ...ne, organization_id: orgId, sort: (causes.data?.length ?? 0) + 1 })); setNe({ ...ne, name: '' }); })}>Agregar</Button>
        </div>
      </Section>
    </div>
  );
}
