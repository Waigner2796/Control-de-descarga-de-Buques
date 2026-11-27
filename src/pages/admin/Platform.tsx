import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { callFunction, rpc, supabase, unwrap } from '@/lib/supabase';
import { dt } from '@/lib/format';
import { Badge, Button, DataTable, ErrorBox, Field, Input, Modal, PageHeader, Select } from '@/components/ui';
import { TempPasswordNotice } from '@/components/ReportLinks';
import { NoAccess } from '@/pages/auth/AuthPages';

/** Alta de empresas (tenants) por el administrador de la plataforma. */
export default function Platform() {
  const { ctx, refresh } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['platform-orgs'], enabled: !!ctx?.is_platform_admin, queryFn: async () => unwrap(await supabase.from('organizations').select('id, name, country, status, created_at').order('created_at', { ascending: false })) as { id: string; name: string; country: string | null; status: string; created_at: string }[] });
  const [v, setV] = useState({ open: false, name: '', legal_name: '', country: 'Guatemala', terminal_name: 'Terminal principal', timezone: 'America/Guatemala', admin_email: '', admin_name: '' });
  const [res, setRes] = useState<{ email: string; password: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!ctx?.is_platform_admin) return <NoAccess inline />;
  const create = async () => {
    setErr(null); setBusy(true);
    try {
      const o = await rpc<{ organization_id: string }>('platform_create_organization', { p: { name: v.name, legal_name: v.legal_name, country: v.country, terminal_name: v.terminal_name, timezone: v.timezone } });
      if (v.admin_email) {
        const r = await callFunction<{ temp_password: string | null }>('admin-users', { action: 'create_staff', organization_id: o.organization_id, email: v.admin_email, full_name: v.admin_name, role_code: 'master_admin', delivery: 'temp_password' });
        setRes({ email: v.admin_email, password: r.temp_password });
      }
      setV({ ...v, open: false, name: '', legal_name: '', admin_email: '', admin_name: '' }); qc.invalidateQueries({ queryKey: ['platform-orgs'] }); refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div>
      <PageHeader title="Empresas" sub="Cada empresa (tenant) comparte la base de datos con aislamiento total de información." actions={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setV({ ...v, open: true })}>Nueva empresa</Button>} />
      {res && <div className="mb-4">{res.password ? <TempPasswordNotice email={res.email} password={res.password} /> : <Badge tone="ok">El usuario ya existía y fue vinculado como Administrador Master.</Badge>}</div>}
      <DataTable rows={q.data} rowKey={(o) => o.id} loading={q.isLoading} columns={[
        { key: 'n', header: 'Empresa', cell: (o) => <b>{o.name}</b> }, { key: 'c', header: 'País', cell: (o) => o.country ?? '—' },
        { key: 's', header: 'Estado', cell: (o) => <Badge tone={o.status === 'active' ? 'ok' : 'mute'}>{o.status === 'active' ? 'Activa' : 'Inactiva'}</Badge> }, { key: 'd', header: 'Creada', cell: (o) => dt(o.created_at) },
      ]} />
      <Modal wide open={v.open} onClose={() => setV({ ...v, open: false })} title="Nueva empresa" footer={<><Button onClick={() => setV({ ...v, open: false })}>Cancelar</Button><Button variant="primary" loading={busy} onClick={create}>Crear empresa</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre comercial" required><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
          <Field label="Razón social"><Input value={v.legal_name} onChange={(e) => setV({ ...v, legal_name: e.target.value })} /></Field>
          <Field label="País"><Input value={v.country} onChange={(e) => setV({ ...v, country: e.target.value })} /></Field>
          <Field label="Primera terminal"><Input value={v.terminal_name} onChange={(e) => setV({ ...v, terminal_name: e.target.value })} /></Field>
          <Field label="Zona horaria"><Select value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>{['America/Guatemala', 'America/El_Salvador', 'America/Tegucigalpa', 'America/Costa_Rica', 'America/Panama', 'America/Mexico_City', 'America/Bogota', 'UTC'].map((z) => <option key={z}>{z}</option>)}</Select></Field>
          <div />
          <Field label="Correo del Administrador Master"><Input type="email" value={v.admin_email} onChange={(e) => setV({ ...v, admin_email: e.target.value })} /></Field>
          <Field label="Nombre del Administrador Master"><Input value={v.admin_name} onChange={(e) => setV({ ...v, admin_name: e.target.value })} /></Field>
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
    </div>
  );
}
