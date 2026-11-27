import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, UserPlus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { callFunction, rpc, supabase, unwrap } from '@/lib/supabase';
import { useMembers, useScales, useTerminals, useUrlState, type Member } from '@/lib/hooks';
import { ACTIVE } from '@/lib/labels';
import { Badge, Button, Checkbox, DataTable, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, useToast, type Column } from '@/components/ui';
import { TempPasswordNotice } from '@/components/ReportLinks';

type Role = { code: string; name: string; description: string; scope: string; sort: number };
type Perm = { code: string; name: string; module: string };

export default function Users() {
  const { orgId } = useOrg();
  const { can, ctx, membership } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useUrlState({ tab: 'usuarios' });
  const members = useMembers(orgId);
  const terminals = useTerminals(orgId);
  const scales = useScales(orgId);
  const roles = useQuery({ queryKey: ['roles'], queryFn: async () => unwrap(await supabase.from('roles').select('*').order('sort')) as Role[] });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: async () => unwrap(await supabase.from('permissions').select('*').order('module')) as Perm[] });
  const rp = useQuery({ queryKey: ['role-perms'], queryFn: async () => unwrap(await supabase.from('role_permissions').select('*')) as { role_code: string; permission_code: string }[] });
  const tm = useQuery({ queryKey: ['terminal-members', orgId], queryFn: async () => unwrap(await supabase.from('terminal_members').select('terminal_id, user_id').eq('organization_id', orgId)) as { terminal_id: string; user_id: string }[] });
  const staffRoles = (roles.data ?? []).filter((r) => r.scope === 'staff' && (r.code !== 'master_admin' || membership?.role_code === 'master_admin'));
  const [create, setCreate] = useState({ open: false, full_name: '', email: '', role_code: 'scale_operator', position: '', delivery: 'temp_password', all_terminals: true, terminal_ids: [] as string[], scale_ids: [] as string[] });
  const [edit, setEdit] = useState<{ m: Member; role_code: string; status: string; all_terminals: boolean; terminal_ids: string[]; extra: string[]; position: string } | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roleName = (c: string) => roles.data?.find((r) => r.code === c)?.name ?? c;
  const inv = () => ['members', 'terminal-members', 'scale-users'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const doCreate = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await callFunction<{ temp_password: string | null; delivery: string }>('admin-users', { action: 'create_staff', organization_id: orgId, email: create.email.trim(), full_name: create.full_name.trim(), role_code: create.role_code, position: create.position || null, delivery: create.delivery, all_terminals: create.all_terminals, terminal_ids: create.terminal_ids, scale_ids: create.scale_ids, redirect_to: `${window.location.origin}/restablecer` });
      setCreated({ email: create.email.trim(), password: r.temp_password }); setCreate({ ...create, open: false, full_name: '', email: '', position: '' }); inv();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const doEdit = async () => {
    if (!edit) return;
    setErr(null); setBusy(true);
    try {
      const p: Record<string, unknown> = { position: edit.position, all_terminals: edit.all_terminals, terminal_ids: edit.terminal_ids };
      if (edit.m.user_id !== ctx?.user_id) { p.role_code = edit.role_code; if (can('permissions.manage')) p.extra_permissions = edit.extra; }
      await rpc('admin_update_member', { p_member: edit.m.id, p });
      if (edit.m.user_id !== ctx?.user_id && edit.status !== edit.m.status) await callFunction('admin-users', { action: 'set_status', organization_id: orgId, user_id: edit.m.user_id, scope: 'member', status: edit.status });
      setEdit(null); inv(); toast('Usuario actualizado');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const action = async (m: Member, a: 'reset_password' | 'revoke_sessions') => {
    try {
      const r = await callFunction<{ temp_password?: string }>('admin-users', { action: a, organization_id: orgId, user_id: m.user_id, delivery: 'temp_password' });
      if (r.temp_password) setCreated({ email: m.profile?.email ?? '', password: r.temp_password }); else toast('Sesiones cerradas');
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const cols: Column<Member>[] = [
    { key: 'n', header: 'Usuario', cell: (m) => <div><b>{m.profile?.full_name || '—'}</b><div className="text-[13px] text-mute">{m.profile?.email}{m.position ? ` · ${m.position}` : ''}</div></div> },
    { key: 'r', header: 'Rol', cell: (m) => <span>{roleName(m.role_code)}{m.extra_permissions.length > 0 && <span className="block text-[12px] text-mute">+{m.extra_permissions.length} permiso(s) adicional(es)</span>}</span> },
    { key: 't', header: 'Terminales', hideBelow: 'md', cell: (m) => (m.all_terminals || m.role_code === 'master_admin' ? 'Todas' : (tm.data ?? []).filter((x) => x.user_id === m.user_id).map((x) => terminals.data?.find((t) => t.id === x.terminal_id)?.name).join(', ') || 'Ninguna') },
    { key: 's', header: 'Estado', cell: (m) => <StatusBadge map={ACTIVE} value={m.status} /> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (m) => (
      <div className="flex flex-wrap justify-end gap-1">
        <Button size="sm" variant="ghost" onClick={() => { setErr(null); setEdit({ m, role_code: m.role_code, status: m.status, all_terminals: m.all_terminals, terminal_ids: (tm.data ?? []).filter((x) => x.user_id === m.user_id).map((x) => x.terminal_id), extra: m.extra_permissions, position: m.position ?? '' }); }}>Editar</Button>
        {m.user_id !== ctx?.user_id && <Button size="sm" variant="ghost" icon={<KeyRound className="h-4 w-4" />} onClick={() => action(m, 'reset_password')}>Restablecer</Button>}
        {m.user_id !== ctx?.user_id && <Button size="sm" variant="ghost" onClick={() => action(m, 'revoke_sessions')}>Cerrar sesiones</Button>}
      </div>
    ) },
  ];
  const staff = (roles.data ?? []).filter((r) => r.scope === 'staff');
  const modules = [...new Set((perms.data ?? []).map((p) => p.module))];
  return (
    <div>
      <PageHeader title="Usuarios y permisos" sub="Las contraseñas nunca se almacenan en texto plano ni se pueden consultar; solo se restablecen."
        actions={<Button variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => { setErr(null); setCreate({ ...create, open: true }); }}>Crear usuario</Button>} />
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={[{ id: 'usuarios', label: 'Usuarios internos', count: members.data?.length }, { id: 'roles', label: 'Roles y permisos' }]} />
      {created && <div className="mb-4">{created.password ? <TempPasswordNotice email={created.email} password={created.password} /> : <Badge tone="ok">Invitación enviada a {created.email}</Badge>}</div>}
      {f.tab === 'usuarios' ? <DataTable columns={cols} rows={members.data} rowKey={(m) => m.id} loading={members.isLoading} /> : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-[13.5px]">
            <thead className="bg-panel"><tr><th className="px-3 py-2 text-left">Permiso</th>{staff.map((r) => <th key={r.code} className="px-2 py-2 text-center font-semibold">{r.name}</th>)}</tr></thead>
            <tbody>
              {modules.map((mod) => [
                <tr key={mod}><td colSpan={staff.length + 1} className="bg-panel/50 px-3 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-mute">{mod}</td></tr>,
                ...(perms.data ?? []).filter((p) => p.module === mod).map((p) => (
                  <tr key={p.code} className="border-t border-line"><td className="px-3 py-1.5">{p.name}</td>{staff.map((r) => <td key={r.code} className="text-center">{rp.data?.some((x) => x.role_code === r.code && x.permission_code === p.code) ? <Check className="mx-auto h-4 w-4 text-ok" aria-label="Sí" /> : <span className="text-edge">·</span>}</td>)}</tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
      <Modal wide open={create.open} onClose={() => setCreate({ ...create, open: false })} title="Nuevo usuario interno" footer={<><Button onClick={() => setCreate({ ...create, open: false })}>Cancelar</Button><Button variant="primary" loading={busy} onClick={doCreate}>Crear usuario</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre completo" required><Input value={create.full_name} onChange={(e) => setCreate({ ...create, full_name: e.target.value })} /></Field>
          <Field label="Correo (usuario de acceso)" required><Input type="email" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></Field>
          <Field label="Rol"><Select value={create.role_code} onChange={(e) => setCreate({ ...create, role_code: e.target.value })}>{staffRoles.map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select></Field>
          <Field label="Cargo"><Input value={create.position} onChange={(e) => setCreate({ ...create, position: e.target.value })} /></Field>
          <Field label="Entrega de credenciales" className="sm:col-span-2"><Select value={create.delivery} onChange={(e) => setCreate({ ...create, delivery: e.target.value })}><option value="temp_password">Contraseña temporal (se muestra una vez; cambio obligatorio)</option><option value="invite">Enlace de activación por correo</option></Select></Field>
          <div className="sm:col-span-2"><Checkbox label="Acceso a todas las terminales" checked={create.all_terminals} onChange={(v) => setCreate({ ...create, all_terminals: v })} />
            {!create.all_terminals && <div className="ml-6 flex flex-wrap gap-x-5">{terminals.data?.map((t) => <Checkbox key={t.id} label={t.name} checked={create.terminal_ids.includes(t.id)} onChange={(on) => setCreate({ ...create, terminal_ids: on ? [...create.terminal_ids, t.id] : create.terminal_ids.filter((x) => x !== t.id) })} />)}</div>}
          </div>
          {['scale_operator', 'supervisor'].includes(create.role_code) && <div className="sm:col-span-2"><div className="lbl mb-1">Básculas autorizadas</div><div className="flex flex-wrap gap-x-5">{scales.data?.map((s) => <Checkbox key={s.id} label={s.name} checked={create.scale_ids.includes(s.id)} onChange={(on) => setCreate({ ...create, scale_ids: on ? [...create.scale_ids, s.id] : create.scale_ids.filter((x) => x !== s.id) })} />)}</div></div>}
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
      <Modal wide open={!!edit} onClose={() => setEdit(null)} title={`Editar ${edit?.m.profile?.full_name ?? ''}`} footer={<><Button onClick={() => setEdit(null)}>Cancelar</Button><Button variant="primary" loading={busy} onClick={doEdit}>Guardar</Button></>}>
        {edit && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Rol" hint={edit.m.user_id === ctx?.user_id ? 'No puede cambiar su propio rol.' : undefined}><Select value={edit.role_code} disabled={edit.m.user_id === ctx?.user_id} onChange={(e) => setEdit({ ...edit, role_code: e.target.value })}>{(edit.m.role_code === 'master_admin' ? staff : staffRoles).map((r) => <option key={r.code} value={r.code}>{r.name}</option>)}</Select></Field>
            <Field label="Estado" hint="Al desactivar, el acceso se revoca de inmediato."><Select value={edit.status} disabled={edit.m.user_id === ctx?.user_id} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">Activo</option><option value="inactive">Inactivo</option></Select></Field>
            <Field label="Cargo"><Input value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value })} /></Field>
            <div className="sm:col-span-2"><Checkbox label="Acceso a todas las terminales" checked={edit.all_terminals} onChange={(v) => setEdit({ ...edit, all_terminals: v })} />
              {!edit.all_terminals && <div className="ml-6 flex flex-wrap gap-x-5">{terminals.data?.map((t) => <Checkbox key={t.id} label={t.name} checked={edit.terminal_ids.includes(t.id)} onChange={(on) => setEdit({ ...edit, terminal_ids: on ? [...edit.terminal_ids, t.id] : edit.terminal_ids.filter((x) => x !== t.id) })} />)}</div>}
            </div>
            {can('permissions.manage') && edit.m.user_id !== ctx?.user_id && (
              <div className="sm:col-span-2"><div className="lbl mb-1">Permisos adicionales al rol (p. ej. cierre operativo para un supervisor)</div>
                <div className="grid gap-x-5 sm:grid-cols-2">{(perms.data ?? []).filter((p) => !rp.data?.some((x) => x.role_code === edit.role_code && x.permission_code === p.code)).map((p) => <Checkbox key={p.code} label={p.name} checked={edit.extra.includes(p.code)} onChange={(on) => setEdit({ ...edit, extra: on ? [...edit.extra, p.code] : edit.extra.filter((x) => x !== p.code) })} />)}</div>
              </div>
            )}
            {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
          </div>
        )}
      </Modal>
    </div>
  );
}
