import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useTerminals, useUrlState, type Terminal } from '@/lib/hooks';
import { SCOPE, TIME_MODE } from '@/lib/labels';
import { Badge, Button, Checkbox, DataTable, ErrorBox, Field, Input, Modal, PageHeader, Section, Select, Tabs, Textarea, useToast, type Column } from '@/components/ui';
import { useAssetUrl, uploadImage } from '@/lib/assets';
import { useShiftPlans } from '@/lib/shifts';

const TZS = ['America/Guatemala', 'America/El_Salvador', 'America/Tegucigalpa', 'America/Managua', 'America/Costa_Rica', 'America/Panama', 'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Guayaquil', 'America/Santo_Domingo', 'America/New_York', 'Europe/Madrid', 'UTC'];

export default function Settings() {
  const { can } = useAuth();
  const [f, setF] = useUrlState({ tab: can('org.manage') ? 'empresa' : can('downtime.manage') ? 'eventos' : 'terminales' });
  const tabs = [
    ...(can('org.manage') ? [{ id: 'empresa', label: 'Organización y marca' }] : []),
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
  const q = useQuery({ queryKey: ['org-full', orgId], queryFn: async () => unwrap(await supabase.from('organizations').select('name, legal_name, tax_id, country, address, phone, email, website, logo_path').eq('id', orgId).single()) as Record<string, string | null> });
  const os = useQuery({ queryKey: ['org-brand', orgId], queryFn: async () => unwrap(await supabase.from('organization_settings').select('brand_colors, report_disclaimer').eq('organization_id', orgId).single()) as { brand_colors: string[]; report_disclaimer: string | null } });
  const [v, setV] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<string[]>(['#0b4f71', '#1874a8']);
  const [disclaimer, setDisclaimer] = useState('');
  const [busy, setBusy] = useState(false);
  const logo = useAssetUrl('org-assets', q.data?.logo_path);
  useEffect(() => { if (q.data) setV(Object.fromEntries(Object.entries(q.data).filter(([k]) => k !== 'logo_path').map(([k, x]) => [k, x ?? '']))); }, [q.data]);
  useEffect(() => { if (os.data) { setColors(os.data.brand_colors?.length ? os.data.brand_colors : ['#0b4f71']); setDisclaimer(os.data.report_disclaimer ?? ''); } }, [os.data]);
  const hexOk = (c: string) => /^#[0-9a-f]{6}$/i.test(c);
  const save = async () => {
    if (!v.name?.trim()) return toast('Escriba el nombre de la organización', 'bad');
    if (!colors.every(hexOk)) return toast('Cada color debe tener el formato #RRGGBB', 'bad');
    setBusy(true);
    try {
      unwrap(await supabase.from('organizations').update(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]))).eq('id', orgId));
      unwrap(await supabase.from('organization_settings').update({ brand_colors: colors.map((c) => c.toLowerCase()), report_disclaimer: disclaimer.trim() || null }).eq('organization_id', orgId));
      ['my_context', 'org-full', 'org-brand'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast('Datos de la organización guardados');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const onLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      const path = await uploadImage('org-assets', `${orgId}/branding`, file);
      unwrap(await supabase.from('organizations').update({ logo_path: path }).eq('id', orgId));
      qc.invalidateQueries({ queryKey: ['org-full'] }); toast('Logotipo actualizado');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const L: Record<string, string> = { name: 'Nombre de la organización', legal_name: 'Razón social', tax_id: 'NIT', country: 'País', address: 'Dirección', phone: 'Teléfono', email: 'Correo', website: 'Sitio web' };
  return (
    <div className="grid gap-5">
      <Section title="Datos de la organización">
        <div className="grid gap-4 md:grid-cols-2">{Object.keys(L).map((k) => <Field key={k} label={L[k]} required={k === 'name'}><Input value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}</div>
      </Section>
      <Section title="Marca para reportes">
        <div className="grid gap-5 md:grid-cols-[220px_1fr]">
          <div>
            <div className="lbl mb-1.5">Logotipo</div>
            <div className="grid h-[110px] place-items-center rounded-xl border border-dashed border-edge bg-panel p-3">{logo ? <img src={logo} alt="Logotipo de la organización" className="max-h-full max-w-full object-contain" /> : <span className="text-[13px] text-mute">Sin logotipo</span>}</div>
            <label className="press mt-2 inline-flex cursor-pointer items-center rounded-lg border border-edge px-3 py-1.5 text-[13.5px] font-semibold hover:bg-panel">Subir PNG o JPG<input type="file" accept="image/png,image/jpeg" className="sr-only" onChange={(e) => onLogo(e.target.files?.[0])} /></label>
            <p className="mt-1 text-[12.5px] text-mute">Aparece arriba a la izquierda en cada página del PDF.</p>
          </div>
          <div className="grid content-start gap-4">
            <div>
              <div className="lbl mb-1.5">Paleta de colores (2 o 3)</div>
              <div className="flex flex-wrap gap-3">
                {colors.map((c, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-line p-2">
                    <input type="color" aria-label={`Color ${i + 1}`} value={hexOk(c) ? c : '#000000'} onChange={(e) => setColors((x) => x.map((y, j) => (j === i ? e.target.value : y)))} className="h-9 w-10 cursor-pointer rounded border-0 bg-transparent p-0" />
                    <Input aria-label={`Código del color ${i + 1}`} value={c} onChange={(e) => setColors((x) => x.map((y, j) => (j === i ? e.target.value.trim() : y)))} className={`num w-[108px] ${hexOk(c) ? '' : 'border-red'}`} />
                    {colors.length > 2 && <button type="button" className="text-[13px] font-semibold text-mute hover:text-red" onClick={() => setColors((x) => x.filter((_, j) => j !== i))}>Quitar</button>}
                  </div>
                ))}
                {colors.length < 3 && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setColors((x) => [...x, '#f2a600'])}>Agregar color</Button>}
              </div>
              <p className="mt-1 text-[12.5px] text-mute">Color 1: títulos y encabezados de tablas · Color 2: acentos y gráficos · Color 3: resaltados.</p>
            </div>
            <div className="flex h-12 overflow-hidden rounded-lg border border-line" aria-hidden>{colors.filter(hexOk).map((c, i) => <div key={i} className="flex-1" style={{ background: c }} />)}</div>
            <Field label="Descargo de responsabilidad (disclaimer) del PDF" hint="Se imprime al final del informe. Déjelo vacío si no lo usa."><Textarea rows={4} maxLength={3000} value={disclaimer} onChange={(e) => setDisclaimer(e.target.value)} /></Field>
          </div>
        </div>
      </Section>
      <Button className="justify-self-start" variant="primary" loading={busy} onClick={save}>Guardar</Button>
    </div>
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
  const plans = useShiftPlans(orgId);
  const q = useQuery({ queryKey: ['shifts', orgId], queryFn: async () => unwrap(await supabase.from('shifts').select('*').eq('organization_id', orgId).order('sort')) as { id: string; terminal_id: string; plan_id: string; name: string; start_time: string; end_time: string; sort: number; status: string }[] });
  const [newPlan, setNewPlan] = useState({ terminal_id: '', name: '' });
  const [n, setN] = useState<Record<string, { name: string; start_time: string; end_time: string }>>({});
  const inv = () => { qc.invalidateQueries({ queryKey: ['shifts'] }); qc.invalidateQueries({ queryKey: ['shift-plans'] }); qc.invalidateQueries({ queryKey: ['plan-shifts'] }); };
  const run = async (f: () => Promise<unknown>, ok?: string) => { try { await f(); inv(); if (ok) toast(ok); } catch (e) { toast((e as Error).message, 'bad'); } };
  const upd = (id: string, p: Record<string, unknown>) => run(async () => unwrap(await supabase.from('shifts').update(p).eq('id', id)));
  const addShift = (plan: { id: string; terminal_id: string }) => {
    const x = n[plan.id] ?? { name: '', start_time: '06:00', end_time: '14:00' };
    if (!x.name.trim()) return toast('Escriba el nombre del turno', 'bad');
    run(async () => unwrap(await supabase.from('shifts').insert({ ...x, name: x.name.trim(), plan_id: plan.id, terminal_id: plan.terminal_id, organization_id: orgId, sort: (q.data?.filter((s) => s.plan_id === plan.id).length ?? 0) + 1 })), 'Turno agregado')
      .then(() => setN((m) => ({ ...m, [plan.id]: { name: '', start_time: x.end_time, end_time: x.start_time } })));
  };
  const makeDefault = (plan: { id: string; terminal_id: string }) => run(async () => {
    unwrap(await supabase.from('shift_plans').update({ is_default: false }).eq('terminal_id', plan.terminal_id).eq('is_default', true));
    unwrap(await supabase.from('shift_plans').update({ is_default: true }).eq('id', plan.id));
  }, 'Esquema predeterminado actualizado');
  const createPlan = () => {
    const tid = newPlan.terminal_id || terminals.data?.[0]?.id;
    if (!tid || newPlan.name.trim().length < 2) return toast('Escriba el nombre del esquema', 'bad');
    run(async () => unwrap(await supabase.from('shift_plans').insert({ terminal_id: tid, organization_id: orgId, name: newPlan.name.trim() })), 'Esquema creado').then(() => setNewPlan({ terminal_id: '', name: '' }));
  };
  return (
    <div className="grid gap-4">
      <p className="text-[14px] text-mute">Un esquema agrupa los turnos de trabajo (p. ej. 07:00 · 14:30 · 21:30). Al crear un servicio se elige el esquema; con él se arma el avance por turno del reporte.</p>
      {terminals.data?.map((t) => (plans.data ?? []).filter((p) => p.terminal_id === t.id).map((plan) => {
        const x = n[plan.id] ?? { name: '', start_time: '06:00', end_time: '14:00' };
        return (
          <Section key={plan.id} title={<span className="flex flex-wrap items-center gap-2">{plan.name}{plan.is_default && <Badge tone="info">Predeterminado</Badge>}{plan.status !== 'active' && <Badge tone="mute">Inactivo</Badge>}<span className="text-[13px] font-normal text-mute">{t.name}</span></span>}
            actions={<div className="flex gap-2">{!plan.is_default && plan.status === 'active' && <Button size="sm" onClick={() => makeDefault(plan)}>Usar como predeterminado</Button>}
              {!plan.is_default && <Button size="sm" variant="ghost" onClick={() => run(async () => unwrap(await supabase.from('shift_plans').update({ status: plan.status === 'active' ? 'inactive' : 'active' }).eq('id', plan.id)))}>{plan.status === 'active' ? 'Desactivar' : 'Activar'}</Button>}</div>}>
            <div className="grid gap-2">
              {(q.data ?? []).filter((s) => s.plan_id === plan.id).map((s) => (
                <div key={s.id} className="grid grid-cols-[1fr_110px_110px_auto] items-center gap-2">
                  <Input defaultValue={s.name} onBlur={(e) => e.target.value !== s.name && upd(s.id, { name: e.target.value })} aria-label="Nombre del turno" />
                  <Input type="time" defaultValue={s.start_time.slice(0, 5)} onBlur={(e) => upd(s.id, { start_time: e.target.value })} aria-label="Inicio" />
                  <Input type="time" defaultValue={s.end_time.slice(0, 5)} onBlur={(e) => upd(s.id, { end_time: e.target.value })} aria-label="Fin" />
                  <Checkbox label="Activo" checked={s.status === 'active'} onChange={(on) => upd(s.id, { status: on ? 'active' : 'inactive' })} />
                </div>
              ))}
              <div className="mt-1 grid grid-cols-[1fr_110px_110px_auto] items-center gap-2 border-t border-line pt-3">
                <Input placeholder="Nuevo turno (p. ej. Turno 3)" value={x.name} onChange={(e) => setN((m) => ({ ...m, [plan.id]: { ...x, name: e.target.value } }))} aria-label="Nombre del nuevo turno" />
                <Input type="time" value={x.start_time} onChange={(e) => setN((m) => ({ ...m, [plan.id]: { ...x, start_time: e.target.value } }))} aria-label="Inicio del nuevo turno" />
                <Input type="time" value={x.end_time} onChange={(e) => setN((m) => ({ ...m, [plan.id]: { ...x, end_time: e.target.value } }))} aria-label="Fin del nuevo turno" />
                <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => addShift(plan)}>Agregar</Button>
              </div>
            </div>
          </Section>
        );
      }))}
      <Section title="Nuevo esquema de turnos">
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Terminal"><Select value={newPlan.terminal_id} onChange={(e) => setNewPlan({ ...newPlan, terminal_id: e.target.value })}>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Nombre"><Input value={newPlan.name} onChange={(e) => setNewPlan({ ...newPlan, name: e.target.value })} placeholder="3 turnos (07:00 / 14:30 / 21:30)" /></Field>
          <Button onClick={createPlan}>Crear esquema</Button>
        </div>
        <p className="mt-2 text-[13px] text-mute">Un turno puede cruzar la medianoche (p. ej. 21:30 a 07:00).</p>
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
    long_cycle_minutes: ['Ciclo largo (min)', 'Resalta en rojo los ciclos mayores.'], max_cycle_hours: ['Intervalo máximo entre pasadas (h)', 'Si un camión tarda más en volver, esa pasada no cuenta como ciclo.'],
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
