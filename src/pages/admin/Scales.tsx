import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Scale as ScaleIcon } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useMembers, useScales, useTerminals, type Scale } from '@/lib/hooks';
import { TIME_MODE } from '@/lib/labels';
import { Badge, Button, Checkbox, DataTable, EmptyState, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, useToast, type Column } from '@/components/ui';

const SCALE_ST = { active: { label: 'Activa', tone: 'ok' as const }, maintenance: { label: 'Mantenimiento', tone: 'warn' as const }, inactive: { label: 'Inactiva', tone: 'mute' as const } };

export default function Scales() {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('scales.manage');
  const scales = useScales(orgId);
  const terminals = useTerminals(orgId);
  const members = useMembers(orgId);
  const settings = useQuery({ queryKey: ['scale-settings', orgId], queryFn: async () => unwrap(await supabase.from('scale_settings').select('scale_id, time_capture_mode').eq('organization_id', orgId)) as { scale_id: string; time_capture_mode: string | null }[] });
  const tset = useQuery({ queryKey: ['terminal-settings', orgId], queryFn: async () => unwrap(await supabase.from('terminal_settings').select('terminal_id, time_capture_mode').eq('organization_id', orgId)) as { terminal_id: string; time_capture_mode: string }[] });
  const users = useQuery({ queryKey: ['scale-users', orgId], queryFn: async () => unwrap(await supabase.from('scale_users').select('scale_id, user_id').eq('organization_id', orgId)) as { scale_id: string; user_id: string }[] });
  const E = { terminal_id: '', code: '', name: '', location: '', status: 'active', mode: '', users: [] as string[] };
  const [form, setForm] = useState<{ open: boolean; row?: Scale; v: typeof E }>({ open: false, v: E });
  const [err, setErr] = useState<string | null>(null);
  const inv = () => ['scales', 'scale-settings', 'scale-users', 'scale-mode'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const modeOf = (s: Scale) => settings.data?.find((x) => x.scale_id === s.id)?.time_capture_mode ?? null;
  const termMode = (tid: string) => tset.data?.find((x) => x.terminal_id === tid)?.time_capture_mode ?? 'manual';
  const open = (s?: Scale) => { setErr(null); setForm({ open: true, row: s, v: s ? { terminal_id: s.terminal_id, code: s.code, name: s.name, location: s.location ?? '', status: s.status, mode: modeOf(s) ?? '', users: (users.data ?? []).filter((u) => u.scale_id === s.id).map((u) => u.user_id) } : { ...E, terminal_id: terminals.data?.[0]?.id ?? '' } }); };
  const save = async () => {
    setErr(null);
    const v = form.v;
    try {
      if (!v.terminal_id || !v.code.trim() || !v.name.trim()) throw new Error('Terminal, código y nombre son obligatorios.');
      let id = form.row?.id;
      const payload = { code: v.code.trim(), name: v.name.trim(), location: v.location || null, status: v.status };
      if (id) unwrap(await supabase.from('scales').update(payload).eq('id', id));
      else id = (unwrap(await supabase.from('scales').insert({ ...payload, terminal_id: v.terminal_id, organization_id: orgId }).select('id').single()) as { id: string }).id;
      const existing = settings.data?.find((x) => x.scale_id === id);
      if (existing) unwrap(await supabase.from('scale_settings').update({ time_capture_mode: v.mode || null }).eq('scale_id', id!));
      else unwrap(await supabase.from('scale_settings').insert({ scale_id: id, time_capture_mode: v.mode || null, organization_id: orgId, terminal_id: v.terminal_id }));
      const cur = (users.data ?? []).filter((u) => u.scale_id === id).map((u) => u.user_id);
      for (const u of cur.filter((x) => !v.users.includes(x))) unwrap(await supabase.from('scale_users').delete().eq('scale_id', id!).eq('user_id', u));
      const add = v.users.filter((x) => !cur.includes(x));
      if (add.length) unwrap(await supabase.from('scale_users').insert(add.map((u) => ({ scale_id: id, user_id: u, organization_id: orgId, terminal_id: v.terminal_id }))));
      inv(); setForm({ open: false, v: E }); toast('Báscula guardada');
    } catch (e) { const m = (e as Error).message; setErr(/Ya existe/.test(m) ? 'Ya existe una báscula con ese código en la terminal.' : m); }
  };
  const cols: Column<Scale>[] = [
    { key: 'c', header: 'Código', cell: (s) => <b className="num">{s.code}</b> },
    { key: 'n', header: 'Nombre', cell: (s) => s.name },
    { key: 'l', header: 'Ubicación', hideBelow: 'md', cell: (s) => s.location ?? '—' },
    { key: 't', header: 'Terminal', hideBelow: 'md', cell: (s) => terminals.data?.find((t) => t.id === s.terminal_id)?.name },
    { key: 'm', header: 'Captura de horas', cell: (s) => <span className="text-[13.5px]">{TIME_MODE[modeOf(s) ?? termMode(s.terminal_id)]}{!modeOf(s) && <span className="block text-[12px] text-mute">según la terminal</span>}</span> },
    { key: 'u', header: 'Usuarios autorizados', cell: (s) => <div className="flex flex-wrap gap-1">{(users.data ?? []).filter((u) => u.scale_id === s.id).map((u) => <Badge key={u.user_id}>{members.data?.find((m) => m.user_id === u.user_id)?.profile?.full_name ?? '—'}</Badge>)}</div> },
    { key: 's', header: 'Estado', cell: (s) => <StatusBadge map={SCALE_ST} value={s.status} /> },
    { key: 'a', header: <span className="sr-only">Editar</span>, align: 'right', cell: (s) => manage && <Button size="sm" variant="ghost" onClick={() => open(s)}>Editar</Button> },
  ];
  const set = (k: 'terminal_id' | 'code' | 'name' | 'location' | 'status' | 'mode') => (e: { target: { value: string } }) => setForm((x) => ({ ...x, v: { ...x.v, [k]: e.target.value } }));
  return (
    <div>
      <PageHeader title="Básculas" sub="Captura de pesos exclusivamente manual. La modalidad de horas (manual u hora del servidor) se define por terminal o por báscula."
        actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => open()}>Nueva báscula</Button>} />
      <DataTable columns={cols} rows={scales.data} rowKey={(s) => s.id} loading={scales.isLoading} empty={<EmptyState icon={<ScaleIcon className="h-8 w-8" />} title="Sin básculas">Registre las básculas de cada terminal y los operadores autorizados en cada una.</EmptyState>} />
      <Modal wide open={form.open} onClose={() => setForm({ ...form, open: false })} title={form.row ? `Editar ${form.row.name}` : 'Nueva báscula'} footer={<><Button onClick={() => setForm({ ...form, open: false })}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Terminal" required><Select value={form.v.terminal_id} onChange={set('terminal_id')} disabled={!!form.row}>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="Código" required><Input value={form.v.code} onChange={set('code')} placeholder="BAS-01" /></Field>
          <Field label="Nombre" required><Input value={form.v.name} onChange={set('name')} placeholder="Báscula 1" /></Field>
          <Field label="Ubicación"><Input value={form.v.location} onChange={set('location')} /></Field>
          <Field label="Estado"><Select value={form.v.status} onChange={set('status')}><option value="active">Activa</option><option value="maintenance">Mantenimiento</option><option value="inactive">Inactiva</option></Select></Field>
          <Field label="Modalidad de captura de horas" hint="Solo hora de inicio y hora final.">
            <Select value={form.v.mode} onChange={set('mode')}><option value="">Según la terminal ({TIME_MODE[termMode(form.v.terminal_id)]})</option><option value="manual">Captura manual (el operador escribe las horas)</option><option value="server_now">Hora actual del servidor (botones)</option></Select>
          </Field>
          <div className="sm:col-span-2">
            <div className="lbl mb-1">Usuarios autorizados</div>
            <div className="grid gap-x-6 sm:grid-cols-2">
              {members.data?.filter((m) => m.status === 'active' && ['scale_operator', 'supervisor', 'master_admin'].includes(m.role_code)).map((m) => (
                <Checkbox key={m.user_id} label={m.profile?.full_name ?? m.user_id} hint={m.role_code === 'scale_operator' ? 'Operador de báscula' : m.role_code === 'supervisor' ? 'Supervisor' : 'Administrador Master'} checked={form.v.users.includes(m.user_id)}
                  onChange={(on) => setForm((x) => ({ ...x, v: { ...x.v, users: on ? [...x.v.users, m.user_id] : x.v.users.filter((u) => u !== m.user_id) } }))} />
              ))}
            </div>
          </div>
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
    </div>
  );
}
