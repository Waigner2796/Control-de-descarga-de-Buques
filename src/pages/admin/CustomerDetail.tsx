import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FileSpreadsheet, KeyRound, Pencil, Plus, Trash2, Upload, UserPlus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { callFunction, signedUrl, supabase, unwrap } from '@/lib/supabase';
import { useAssetUrl } from '@/lib/assets';
import { useUrlState } from '@/lib/hooks';
import { date, dt, fileSize, fmt0, fmt1 } from '@/lib/format';
import { ACTIVE, SERVICE_STATUS, VERSION_STATUS } from '@/lib/labels';
import { exportCustomerConsolidated } from '@/lib/excel/exports';
import { Badge, Button, Checkbox, DataTable, DL, EmptyState, ErrorBox, Field, Input, Kpi, Modal, PageHeader, Pagination, Section, Select, Spinner, StatusBadge, Tabs, useToast, type Column } from '@/components/ui';
import { ReportButtons, TempPasswordNotice } from '@/components/ReportLinks';
import { CustomerForm, type CustomerRow } from './CustomerForm';

type Portfolio = { services_total: number; services_active: number; services_finalized: number; last_operation_at: string | null; discharged_tm: number };

export default function CustomerDetail() {
  const { id } = useParams();
  const { orgId } = useOrg();
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useUrlState({ tab: 'resumen' });
  const [edit, setEdit] = useState(false);
  const c = useQuery({ queryKey: ['customer', id], queryFn: async () => unwrap(await supabase.from('customers').select('*').eq('id', id!).maybeSingle()) as CustomerRow | null });
  const p = useQuery({ queryKey: ['customer-portfolio', id], queryFn: async () => unwrap(await supabase.from('customer_portfolio').select('services_total, services_active, services_finalized, last_operation_at, discharged_tm').eq('id', id!).maybeSingle()) as Portfolio | null });
  const logo = useAssetUrl('org-assets', c.data?.logo_path);
  if (c.isLoading) return <Spinner />;
  if (!c.data) return <EmptyState title="Cliente no encontrado">Puede que no exista o que no tenga acceso a él.</EmptyState>;
  const cu = c.data;
  return (
    <div>
      <Link to="/app/clientes" className="mb-3 inline-flex items-center gap-1.5 text-[14px] font-semibold text-mute hover:text-ink"><ArrowLeft className="h-4 w-4" />Cartera de clientes</Link>
      <PageHeader title={<span className="flex items-center gap-3">{logo && <img src={logo} alt="" className="h-10 w-auto max-w-[120px] rounded object-contain" />}{cu.trade_name}</span>}
        sub={<span className="flex flex-wrap items-center gap-2"><span className="num">{cu.code}</span>{cu.legal_name && <>· {cu.legal_name}</>}<StatusBadge map={ACTIVE} value={cu.status} /></span>}
        actions={<>
          <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => exportCustomerConsolidated(cu.id, cu.trade_name)}>Reporte consolidado</Button>
          {can('customers.manage') && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>Editar</Button>}
        </>} />
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={[
        { id: 'resumen', label: 'Resumen' }, { id: 'operaciones', label: 'Operaciones', count: p.data?.services_total },
        { id: 'reportes', label: 'Reportes' }, { id: 'documentos', label: 'Documentos' },
        ...(can('portal_users.manage') ? [{ id: 'usuarios', label: 'Usuarios del portal' }] : []),
      ]} />
      {f.tab === 'resumen' && <Summary c={cu} p={p.data} />}
      {f.tab === 'operaciones' && <Operations customerId={cu.id} onOpen={(sid) => nav(`/app/servicios/${sid}`)} />}
      {f.tab === 'reportes' && <Reports customerId={cu.id} />}
      {f.tab === 'documentos' && <Documents orgId={orgId} customerId={cu.id} />}
      {f.tab === 'usuarios' && can('portal_users.manage') && <PortalUsers orgId={orgId} customerId={cu.id} />}
      <CustomerForm open={edit} onClose={() => setEdit(false)} orgId={orgId} customer={cu} />
    </div>
  );
}

function Summary({ c, p }: { c: CustomerRow; p: Portfolio | null | undefined }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const contacts = useQuery({ queryKey: ['contacts', c.id], queryFn: async () => unwrap(await supabase.from('customer_contacts').select('*').eq('customer_id', c.id).order('is_primary', { ascending: false })) as { id: string; full_name: string; position: string | null; email: string | null; phone: string | null; is_primary: boolean }[] });
  const [nc, setNc] = useState({ full_name: '', position: '', email: '', phone: '' });
  const add = async () => {
    if (nc.full_name.trim().length < 2) return;
    unwrap(await supabase.from('customer_contacts').insert({ ...nc, customer_id: c.id, organization_id: c.organization_id }));
    setNc({ full_name: '', position: '', email: '', phone: '' }); qc.invalidateQueries({ queryKey: ['contacts', c.id] });
  };
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Total de servicios" value={fmt0(p?.services_total)} />
        <Kpi label="Servicios activos" value={fmt0(p?.services_active)} tone="ok" />
        <Kpi label="Servicios finalizados" value={fmt0(p?.services_finalized)} />
        <Kpi label="Tonelaje total operado" value={`${fmt0(p?.discharged_tm)} TM`} />
        <Kpi label="Última operación" value={date(p?.last_operation_at)} />
      </div>
      <Section title="Información general">
        <DL cols={3} items={[['Nombre comercial', c.trade_name], ['Razón social', c.legal_name], ['NIT / identificación fiscal', c.tax_id], ['País', c.country], ['Dirección', c.address],
          ['Contacto principal', c.main_contact], ['Representante', c.representative], ['Correo electrónico', c.email], ['Teléfono', c.phone], ['Fecha de creación', dt(c.created_at)], ['Observaciones', c.notes]]} />
      </Section>
      <Section title="Contactos">
        {contacts.data?.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {contacts.data.map((x) => (
              <li key={x.id} className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-[14px]">
                <span><b>{x.full_name}</b>{x.is_primary && <Badge tone="info" className="ml-2">Principal</Badge>}<span className="block text-mute">{[x.position, x.email, x.phone].filter(Boolean).join(' · ')}</span></span>
                {can('customers.manage') && <button className="press rounded p-1 text-mute hover:text-red" aria-label="Quitar contacto" onClick={async () => { unwrap(await supabase.from('customer_contacts').delete().eq('id', x.id)); qc.invalidateQueries({ queryKey: ['contacts', c.id] }); }}><Trash2 className="h-4 w-4" /></button>}
              </li>
            ))}
          </ul>
        ) : <p className="text-[14px] text-mute">Sin contactos adicionales registrados.</p>}
        {can('customers.manage') && (
          <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto] sm:items-end">
            <Field label="Nombre"><Input value={nc.full_name} onChange={(e) => setNc({ ...nc, full_name: e.target.value })} /></Field>
            <Field label="Cargo"><Input value={nc.position} onChange={(e) => setNc({ ...nc, position: e.target.value })} /></Field>
            <Field label="Correo"><Input type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} /></Field>
            <Field label="Teléfono"><Input value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} /></Field>
            <Button icon={<Plus className="h-4 w-4" />} onClick={add}>Agregar</Button>
          </div>
        )}
      </Section>
    </div>
  );
}

type SvcRow = { id: string; service_number: string; vessel_name: string; products: string; initial_tm: number; discharged_tm: number; pending_tm: number; actual_start: string | null; planned_start: string | null; finalized_at: string | null; status: string; timezone: string; report_status: string | null; current_version_id: string | null };
function Operations({ customerId, onOpen }: { customerId: string; onOpen: (id: string) => void }) {
  const [f, setF] = useUrlState({ status: '', opage: '1', osize: '25', osort: 'created_at', odir: 'desc' });
  const page = Number(f.opage) || 1, size = Number(f.osize) || 25;
  const q = useQuery({
    queryKey: ['customer-services', customerId, f], placeholderData: keepPreviousData,
    queryFn: async () => {
      let qq = supabase.from('service_overview').select('id, service_number, vessel_name, products, initial_tm, discharged_tm, pending_tm, actual_start, planned_start, finalized_at, status, timezone, report_status, current_version_id', { count: 'exact' }).eq('customer_id', customerId);
      if (f.status) qq = qq.eq('status', f.status);
      const r = await qq.order(f.osort, { ascending: f.odir === 'asc', nullsFirst: false }).order('id').range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as SvcRow[], count: r.count ?? 0 };
    },
  });
  const versions = useQuery({
    queryKey: ['customer-current-versions', customerId, q.data?.rows.map((r) => r.current_version_id).join()],
    enabled: !!q.data?.rows.some((r) => r.current_version_id),
    queryFn: async () => unwrap(await supabase.from('report_versions').select('id, storage_path, version').in('id', q.data!.rows.map((r) => r.current_version_id).filter(Boolean) as string[])) as { id: string; storage_path: string; version: number }[],
  });
  const cols: Column<SvcRow>[] = [
    { key: 'n', header: 'Servicio', sortKey: 'service_number', cell: (r) => <b className="num">{r.service_number}</b> },
    { key: 'v', header: 'Buque', sortKey: 'vessel_name', cell: (r) => r.vessel_name },
    { key: 'p', header: 'Producto', hideBelow: 'lg', cell: (r) => <span className="text-[13.5px]">{r.products || '—'}</span> },
    { key: 'i', header: 'Manifiesto (TM)', sortKey: 'initial_tm', align: 'right', cell: (r) => fmt1(r.initial_tm) },
    { key: 'd', header: 'Descargado (TM)', sortKey: 'discharged_tm', align: 'right', cell: (r) => fmt1(r.discharged_tm) },
    { key: 'pe', header: 'Pendiente (TM)', sortKey: 'pending_tm', align: 'right', cell: (r) => <span className={r.pending_tm > 0 ? 'text-red' : ''}>{fmt1(r.pending_tm)}</span> },
    { key: 's', header: 'Inicio', sortKey: 'actual_start', hideBelow: 'md', cell: (r) => date(r.actual_start ?? r.planned_start, r.timezone) },
    { key: 'e', header: 'Finalización', sortKey: 'finalized_at', hideBelow: 'md', cell: (r) => date(r.finalized_at, r.timezone) },
    { key: 'st', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge map={SERVICE_STATUS} value={r.status} /> },
    { key: 'r', header: 'Reporte PDF', align: 'right', cell: (r) => { const v = versions.data?.find((x) => x.id === r.current_version_id); return <div onClick={(e) => e.stopPropagation()}>{v ? <ReportButtons compact path={v.storage_path} filename={`Informe-${r.service_number}-v${v.version}.pdf`} /> : <span className="text-[13px] text-mute">{r.status === 'finalized' ? 'En proceso' : '—'}</span>}</div>; } },
  ];
  return (
    <div>
      <div className="mb-3 max-w-xs"><Select aria-label="Estado" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Todos los estados</option>{Object.entries(SERVICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select></div>
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} onRowClick={(r) => onOpen(r.id)} sort={{ key: f.osort, asc: f.odir === 'asc' }} onSort={(k) => setF({ osort: k, odir: f.osort === k && f.odir === 'asc' ? 'desc' : 'asc' })} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ opage: String(p) }, false)} onPageSize={(s) => setF({ osize: String(s) })} />
    </div>
  );
}

type RepRow = { id: string; service_number: string; vessel_name: string; version: number; status: string; signed_at: string | null; generated_at: string; storage_path: string | null; draft_path: string | null; verification_code: string; service_id: string };
function Reports({ customerId }: { customerId: string }) {
  const q = useQuery({ queryKey: ['customer-reports', customerId], queryFn: async () => unwrap(await supabase.from('report_overview').select('id, service_number, vessel_name, version, status, signed_at, generated_at, storage_path, draft_path, verification_code, service_id').eq('customer_id', customerId).order('generated_at', { ascending: false })) as RepRow[] });
  const cols: Column<RepRow>[] = [
    { key: 's', header: 'Servicio', cell: (r) => <Link to={`/app/servicios/${r.service_id}`} className="num font-semibold hover:underline">{r.service_number}</Link> },
    { key: 'v', header: 'Buque', cell: (r) => r.vessel_name },
    { key: 've', header: 'Versión', align: 'right', cell: (r) => `v${r.version}` },
    { key: 'st', header: 'Estado', cell: (r) => <StatusBadge map={VERSION_STATUS} value={r.status} /> },
    { key: 'd', header: 'Firmado', hideBelow: 'md', cell: (r) => dt(r.signed_at) },
    { key: 'c', header: 'Código', hideBelow: 'lg', cell: (r) => <code className="num text-[12.5px]">{r.verification_code}</code> },
    { key: 'a', header: <span className="sr-only">PDF</span>, align: 'right', cell: (r) => <ReportButtons compact path={r.storage_path ?? r.draft_path} filename={`Informe-${r.service_number}-v${r.version}.pdf`} /> },
  ];
  return <DataTable columns={cols} rows={q.data} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title="Sin reportes generados">Los informes finales se generan automáticamente al finalizar cada servicio.</EmptyState>} />;
}

type Doc = { id: string; title: string; category: string; storage_path: string; mime_type: string | null; size_bytes: number | null; visible_to_customer: boolean; status: string; created_at: string };
function Documents({ orgId, customerId }: { orgId: string; customerId: string }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customer-docs', customerId], queryFn: async () => unwrap(await supabase.from('customer_documents').select('*').eq('customer_id', customerId).order('created_at', { ascending: false })) as Doc[] });
  const [up, setUp] = useState<{ file: File | null; title: string; category: string; visible: boolean }>({ file: null, title: '', category: 'Contrato', visible: false });
  const [busy, setBusy] = useState(false);
  const upload = async () => {
    if (!up.file || up.title.trim().length < 2) { toast('Seleccione un archivo y escriba un título.', 'bad'); return; }
    if (up.file.size > 25 * 1024 * 1024) { toast('El archivo supera 25 MB.', 'bad'); return; }
    setBusy(true);
    try {
      const safe = up.file.name.normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-80);
      const path = `${orgId}/${customerId}/${crypto.randomUUID()}-${safe}`;
      const { error } = await supabase.storage.from('customer-documents').upload(path, up.file, { contentType: up.file.type || 'application/octet-stream' });
      if (error) throw new Error(error.message);
      unwrap(await supabase.from('customer_documents').insert({ organization_id: orgId, customer_id: customerId, title: up.title.trim(), category: up.category, storage_path: path, mime_type: up.file.type, size_bytes: up.file.size, visible_to_customer: up.visible }));
      setUp({ file: null, title: '', category: 'Contrato', visible: false }); qc.invalidateQueries({ queryKey: ['customer-docs', customerId] }); toast('Documento cargado');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(false); }
  };
  const patch = async (id: string, v: Partial<Doc>) => { unwrap(await supabase.from('customer_documents').update(v).eq('id', id)); qc.invalidateQueries({ queryKey: ['customer-docs', customerId] }); };
  const open = async (d: Doc) => { try { window.open(await signedUrl('customer-documents', d.storage_path, 120), '_blank', 'noopener'); } catch (e) { toast(String((e as Error).message), 'bad'); } };
  const cols: Column<Doc>[] = [
    { key: 't', header: 'Documento', cell: (d) => <button className="text-left font-semibold hover:underline" onClick={() => open(d)}>{d.title}</button> },
    { key: 'c', header: 'Categoría', cell: (d) => d.category },
    { key: 's', header: 'Tamaño', align: 'right', hideBelow: 'md', cell: (d) => fileSize(d.size_bytes) },
    { key: 'd', header: 'Fecha', hideBelow: 'md', cell: (d) => dt(d.created_at) },
    { key: 'v', header: 'Visible en portal', cell: (d) => can('customers.manage') ? <Checkbox label={d.visible_to_customer ? 'Sí' : 'No'} checked={d.visible_to_customer} onChange={(v) => patch(d.id, { visible_to_customer: v })} /> : (d.visible_to_customer ? 'Sí' : 'No') },
    { key: 'st', header: 'Estado', cell: (d) => d.status === 'active' ? <Badge tone="ok">Vigente</Badge> : <Badge>Archivado</Badge> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (d) => can('customers.manage') && <Button size="sm" variant="ghost" onClick={() => patch(d.id, { status: d.status === 'active' ? 'archived' : 'active' })}>{d.status === 'active' ? 'Archivar' : 'Restaurar'}</Button> },
  ];
  return (
    <div className="grid gap-4">
      {can('customers.manage') && (
        <Section title="Adjuntar documento">
          <div className="grid gap-3 md:grid-cols-[1.2fr_1fr_0.8fr_auto_auto] md:items-end">
            <Field label="Título"><Input value={up.title} onChange={(e) => setUp({ ...up, title: e.target.value })} placeholder="Contrato de servicio 2026" /></Field>
            <Field label="Archivo"><input type="file" className="text-[14px]" onChange={(e) => setUp({ ...up, file: e.target.files?.[0] ?? null, title: up.title || (e.target.files?.[0]?.name ?? '').replace(/\.[^.]+$/, '') })} /></Field>
            <Field label="Categoría"><Select value={up.category} onChange={(e) => setUp({ ...up, category: e.target.value })}>{['Contrato', 'Cotización', 'Certificado', 'Correspondencia', 'Otro'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
            <Checkbox label="Visible para el cliente" checked={up.visible} onChange={(v) => setUp({ ...up, visible: v })} />
            <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={busy} onClick={upload}>Cargar</Button>
          </div>
        </Section>
      )}
      <DataTable columns={cols} rows={q.data} rowKey={(d) => d.id} loading={q.isLoading} empty={<EmptyState title="Sin documentos">Adjunte contratos, certificados u otros archivos del cliente. Los marcados como visibles aparecen en su portal.</EmptyState>} />
    </div>
  );
}

type PU = { id: string; user_id: string; status: string; created_at: string; profile?: { full_name: string; email: string; must_change_password: boolean }; perms?: { can_view_reports: boolean; can_download_reports: boolean; can_view_documents: boolean; can_view_productivity: boolean } };
function PortalUsers({ orgId, customerId }: { orgId: string; customerId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['portal-users', customerId],
    queryFn: async () => {
      const cu = unwrap(await supabase.from('customer_users').select('id, user_id, status, created_at').eq('customer_id', customerId)) as PU[];
      if (!cu.length) return cu;
      const [prof, perms] = await Promise.all([
        supabase.from('user_profiles').select('user_id, full_name, email, must_change_password').in('user_id', cu.map((x) => x.user_id)),
        supabase.from('customer_portal_permissions').select('*').in('customer_user_id', cu.map((x) => x.id)),
      ]);
      return cu.map((x) => ({ ...x, profile: (prof.data ?? []).find((p) => p.user_id === x.user_id), perms: (perms.data ?? []).find((p) => p.customer_user_id === x.id) }));
    },
  });
  const [form, setForm] = useState({ open: false, full_name: '', email: '', delivery: 'temp_password', reports: true, download: true, documents: true, productivity: true });
  const [created, setCreated] = useState<{ email: string; password: string | null; delivery: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await callFunction<{ temp_password: string | null; delivery: string }>('admin-users', {
        action: 'create_customer', customer_id: customerId, email: form.email.trim(), full_name: form.full_name.trim(), delivery: form.delivery,
        redirect_to: `${window.location.origin}/restablecer`,
        permissions: { can_view_reports: form.reports, can_download_reports: form.download, can_view_documents: form.documents, can_view_productivity: form.productivity },
      });
      setCreated({ email: form.email.trim(), password: r.temp_password, delivery: r.delivery });
      setForm({ ...form, open: false, full_name: '', email: '' });
      qc.invalidateQueries({ queryKey: ['portal-users', customerId] });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const act = async (u: PU, action: 'set_status' | 'reset_password' | 'revoke_sessions') => {
    try {
      const r = await callFunction<{ temp_password?: string }>('admin-users', { action, organization_id: orgId, user_id: u.user_id, scope: 'customer', status: u.status === 'active' ? 'inactive' : 'active', delivery: 'temp_password' });
      if (action === 'reset_password' && r.temp_password) setCreated({ email: u.profile?.email ?? '', password: r.temp_password, delivery: 'temp_password' });
      else toast(action === 'set_status' ? (u.status === 'active' ? 'Usuario desactivado; su acceso se revocó de inmediato' : 'Usuario reactivado') : 'Sesiones cerradas');
      qc.invalidateQueries({ queryKey: ['portal-users', customerId] });
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); }
  };
  const setPerm = async (u: PU, k: string, v: boolean) => {
    unwrap(await supabase.from('customer_portal_permissions').update({ [k]: v }).eq('customer_user_id', u.id));
    qc.invalidateQueries({ queryKey: ['portal-users', customerId] });
  };
  const cols: Column<PU>[] = [
    { key: 'n', header: 'Usuario', cell: (u) => <div><b>{u.profile?.full_name || '—'}</b><div className="text-[13px] text-mute">{u.profile?.email}</div></div> },
    { key: 'st', header: 'Estado', cell: (u) => <div className="flex flex-wrap gap-1"><StatusBadge map={ACTIVE} value={u.status} />{u.profile?.must_change_password && <Badge tone="warn">Contraseña temporal</Badge>}</div> },
    { key: 'p', header: 'Permisos del portal', wrap: true, cell: (u) => (
      <div className="flex flex-wrap gap-x-4">
        {([['can_view_reports', 'Ver reportes'], ['can_download_reports', 'Descargar PDF'], ['can_view_documents', 'Documentos'], ['can_view_productivity', 'Productividad']] as const).map(([k, l]) => (
          <Checkbox key={k} label={l} checked={!!u.perms?.[k]} onChange={(v) => setPerm(u, k, v)} />
        ))}
      </div>
    ) },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (u) => (
      <div className="flex flex-wrap justify-end gap-1">
        <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />} onClick={() => act(u, 'reset_password')}>Restablecer</Button>
        <Button size="sm" variant={u.status === 'active' ? 'ghost' : 'secondary'} onClick={() => act(u, 'set_status')}>{u.status === 'active' ? 'Desactivar' : 'Activar'}</Button>
      </div>
    ) },
  ];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[70ch] text-[14px] text-mute">Los usuarios del portal solo ven los servicios, reportes y documentos de este cliente. Las contraseñas nunca se almacenan ni se pueden consultar; solo se restablecen.</p>
        <Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => { setErr(null); setForm({ ...form, open: true }); }}>Crear usuario</Button>
      </div>
      {created && (created.password ? <TempPasswordNotice email={created.email} password={created.password} /> : <Badge tone="ok">Se envió una invitación de activación a {created.email}</Badge>)}
      <DataTable columns={cols} rows={q.data} rowKey={(u) => u.id} loading={q.isLoading} empty={<EmptyState title="Sin usuarios del portal">Cree una cuenta para que el cliente consulte sus servicios y descargue sus informes firmados.</EmptyState>} />
      <Modal open={form.open} onClose={() => setForm({ ...form, open: false })} title="Nuevo usuario del portal"
        footer={<><Button onClick={() => setForm({ ...form, open: false })}>Cancelar</Button><Button variant="primary" loading={busy} onClick={create}>Crear usuario</Button></>}>
        <div className="grid gap-4">
          <Field label="Nombre completo" required><Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Correo electrónico (usuario de acceso)" required><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Entrega de credenciales">
            <Select value={form.delivery} onChange={(e) => setForm({ ...form, delivery: e.target.value })}>
              <option value="temp_password">Contraseña temporal (se muestra una vez)</option>
              <option value="invite">Enlace de activación por correo</option>
            </Select>
          </Field>
          <Field label="Rol"><Input value="Cliente" disabled /></Field>
          <div>
            <div className="lbl mb-1">Permisos</div>
            <Checkbox label="Ver reportes" checked={form.reports} onChange={(v) => setForm({ ...form, reports: v })} />
            <Checkbox label="Descargar PDF" checked={form.download} onChange={(v) => setForm({ ...form, download: v })} />
            <Checkbox label="Ver documentos autorizados" checked={form.documents} onChange={(v) => setForm({ ...form, documents: v })} />
            <Checkbox label="Ver resumen de productividad" checked={form.productivity} onChange={(v) => setForm({ ...form, productivity: v })} />
          </div>
          {err && <ErrorBox error={err} />}
        </div>
      </Modal>
    </div>
  );
}

