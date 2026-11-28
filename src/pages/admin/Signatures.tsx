import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { uploadImage, useAssetUrl } from '@/lib/assets';
import { useMembers } from '@/lib/hooks';
import { Badge, Button, Checkbox, DataTable, EmptyState, ErrorBox, Field, Input, Modal, Notice, PageHeader, Section, Select, Textarea, useToast, type Column } from '@/components/ui';

type Signer = { id: string; user_id: string | null; full_name: string; position: string; signature_path: string | null; status: string };
type Seal = { id: string; name: string; image_path: string | null; is_default: boolean; status: string };

function Thumb({ path }: { path: string | null }) {
  const url = useAssetUrl('org-assets', path);
  return url ? <img src={url} alt="" className="h-12 w-auto max-w-[160px] rounded border border-line bg-white object-contain p-1" /> : <span className="text-[13px] text-mute">Sin imagen</span>;
}

export default function Signatures() {
  const { orgId, membership } = useOrg();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can('signatures.manage');
  const members = useMembers(orgId);
  const signers = useQuery({ queryKey: ['signers', orgId], queryFn: async () => unwrap(await supabase.from('authorized_signers').select('*').eq('organization_id', orgId).order('full_name')) as Signer[] });
  const seals = useQuery({ queryKey: ['seals-all', orgId], queryFn: async () => unwrap(await supabase.from('company_seals').select('*').eq('organization_id', orgId).order('created_at')) as Seal[] });
  const org = useQuery({ queryKey: ['org', orgId], queryFn: async () => unwrap(await supabase.from('organizations').select('id, name, logo_path').eq('id', orgId).single()) as { id: string; name: string; logo_path: string | null } });
  const tpl = useQuery({ queryKey: ['template', orgId], queryFn: async () => unwrap(await supabase.from('report_templates').select('*').eq('organization_id', orgId).eq('kind', 'final_service').maybeSingle()) as { id: string; title: string; primary_color: string; show_customer_logo: boolean; conclusions_default: string; footer_text: string } | null });
  const [sg, setSg] = useState<{ open: boolean; row?: Signer; user_id: string; full_name: string; position: string; file: File | null }>({ open: false, user_id: '', full_name: '', position: '', file: null });
  const [sl, setSl] = useState<{ open: boolean; name: string; file: File | null; def: boolean }>({ open: false, name: '', file: null, def: true });
  const [t, setT] = useState({ title: '', primary_color: '#0b4f71', show_customer_logo: true, conclusions_default: '', footer_text: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (tpl.data) setT({ title: tpl.data.title, primary_color: tpl.data.primary_color, show_customer_logo: tpl.data.show_customer_logo, conclusions_default: tpl.data.conclusions_default, footer_text: tpl.data.footer_text }); }, [tpl.data]);
  const inv = () => ['signers', 'seals-all', 'org', 'template', 'seals'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const saveSigner = async () => {
    setErr(null);
    try {
      if (!sg.full_name.trim() || !sg.position.trim()) throw new Error('Nombre y cargo son obligatorios.');
      const sigPath = sg.file ? await uploadImage('org-assets', `${orgId}/signatures`, sg.file) : sg.row?.signature_path ?? null;
      const payload = { user_id: sg.user_id || null, full_name: sg.full_name.trim(), position: sg.position.trim(), signature_path: sigPath };
      if (sg.row) unwrap(await supabase.from('authorized_signers').update(payload).eq('id', sg.row.id));
      else unwrap(await supabase.from('authorized_signers').insert({ ...payload, organization_id: orgId }));
      setSg({ open: false, user_id: '', full_name: '', position: '', file: null }); inv(); toast('Firmante guardado');
    } catch (e) { setErr((e as Error).message); }
  };
  const saveSeal = async () => {
    setErr(null);
    try {
      if (!sl.name.trim() || !sl.file) throw new Error('Indique nombre e imagen del sello.');
      const path = await uploadImage('org-assets', `${orgId}/seals`, sl.file);
      if (sl.def) for (const s of seals.data ?? []) if (s.is_default) unwrap(await supabase.from('company_seals').update({ is_default: false }).eq('id', s.id));
      unwrap(await supabase.from('company_seals').insert({ organization_id: orgId, name: sl.name.trim(), image_path: path, is_default: sl.def }));
      setSl({ open: false, name: '', file: null, def: true }); inv(); toast('Sello guardado');
    } catch (e) { setErr((e as Error).message); }
  };
  const setDefault = async (s: Seal) => { for (const x of seals.data ?? []) if (x.is_default) unwrap(await supabase.from('company_seals').update({ is_default: false }).eq('id', x.id)); unwrap(await supabase.from('company_seals').update({ is_default: true }).eq('id', s.id)); inv(); };
  const uploadLogo = async (f: File) => { try { const p = await uploadImage('org-assets', `${orgId}/branding`, f); unwrap(await supabase.from('organizations').update({ logo_path: p }).eq('id', orgId)); inv(); toast('Logotipo actualizado'); } catch (e) { toast((e as Error).message, 'bad'); } };
  const saveTpl = async () => { try { if (tpl.data) unwrap(await supabase.from('report_templates').update(t).eq('id', tpl.data.id)); else unwrap(await supabase.from('report_templates').insert({ ...t, organization_id: orgId, kind: 'final_service' })); inv(); toast('Plantilla guardada'); } catch (e) { toast((e as Error).message, 'bad'); } };

  const sCols: Column<Signer>[] = [
    { key: 'n', header: 'Firmante', cell: (s) => <div><b>{s.full_name}</b><div className="text-[13px] text-mute">{s.position}</div></div> },
    { key: 'u', header: 'Usuario vinculado', cell: (s) => members.data?.find((m) => m.user_id === s.user_id)?.profile?.email ?? <span className="text-warn">Sin usuario: no puede firmar</span> },
    { key: 'i', header: 'Firma', cell: (s) => <Thumb path={s.signature_path} /> },
    { key: 'st', header: 'Estado', cell: (s) => (s.status === 'active' ? <Badge tone="ok">Activo</Badge> : <Badge>Inactivo</Badge>) },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (s) => manage && <div className="flex justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => setSg({ open: true, row: s, user_id: s.user_id ?? '', full_name: s.full_name, position: s.position, file: null })}>Editar</Button>
      <Button size="sm" variant="ghost" onClick={async () => { unwrap(await supabase.from('authorized_signers').update({ status: s.status === 'active' ? 'inactive' : 'active' }).eq('id', s.id)); inv(); }}>{s.status === 'active' ? 'Desactivar' : 'Activar'}</Button>
    </div> },
  ];
  return (
    <div className="grid gap-5">
      <PageHeader title="Firma y sello digital" sub="Firmantes autorizados, sellos, logotipo y plantilla del informe final." />
      <Notice tone="warn">La firma configurada aquí es una <b>firma gráfica</b> (imagen) que se inserta en el PDF junto al sello; la integridad se garantiza con el hash SHA-256 y el código de verificación. No es una firma electrónica criptográfica con certificado. Si necesita validez jurídica formal, debe integrarse un proveedor de firma electrónica certificado conforme a la legislación aplicable.</Notice>
      <Section title="Firmantes autorizados" actions={manage && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(null); setSg({ open: true, user_id: '', full_name: '', position: '', file: null }); }}>Agregar firmante</Button>}>
        <DataTable columns={sCols} rows={signers.data} rowKey={(s) => s.id} loading={signers.isLoading} empty={<EmptyState title="Sin firmantes">Vincule un usuario con rol de firmante (o con permiso de firma) y cargue su firma.</EmptyState>} />
      </Section>
      <Section title="Sellos de la empresa" actions={manage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(null); setSl({ open: true, name: '', file: null, def: true }); }}>Agregar sello</Button>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(seals.data ?? []).map((s) => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border border-line p-3">
              <Thumb path={s.image_path} />
              <div className="min-w-0 flex-1"><b className="block truncate">{s.name}</b>{s.is_default ? <Badge tone="info">Predeterminado</Badge> : manage && <button className="text-[13px] font-semibold text-sea hover:underline" onClick={() => setDefault(s)}>Usar por defecto</button>}</div>
            </div>
          ))}
          {!seals.data?.length && <p className="text-[14px] text-mute">Sin sellos configurados.</p>}
        </div>
      </Section>
      {can('org.manage') && (
        <Section title="Logotipo de la empresa">
          <div className="flex flex-wrap items-center gap-4"><Thumb path={org.data?.logo_path ?? null} /><input type="file" accept="image/png,image/jpeg" className="text-[14px]" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} /></div>
        </Section>
      )}
      {manage && (
        <Section title="Plantilla del informe final">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Título"><Input value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} /></Field>
            <Field label="Color principal"><div className="flex items-center gap-2"><input type="color" value={t.primary_color} onChange={(e) => setT({ ...t, primary_color: e.target.value })} className="h-10 w-14 rounded border border-edge" /><Input value={t.primary_color} onChange={(e) => setT({ ...t, primary_color: e.target.value })} className="num" /></div></Field>
            <Field label="Pie de página"><Input value={t.footer_text} onChange={(e) => setT({ ...t, footer_text: e.target.value })} placeholder={`${membership.organization_name} · Generado con Vessel Control`} /></Field>
            <Checkbox label="Mostrar el logotipo del cliente en la portada" checked={t.show_customer_logo} onChange={(v) => setT({ ...t, show_customer_logo: v })} />
            <Field label="Conclusiones predeterminadas" className="md:col-span-2"><Textarea value={t.conclusions_default} onChange={(e) => setT({ ...t, conclusions_default: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" variant="primary" onClick={saveTpl}>Guardar plantilla</Button>
        </Section>
      )}
      <Modal open={sg.open} onClose={() => setSg({ ...sg, open: false })} title={sg.row ? 'Editar firmante' : 'Nuevo firmante autorizado'} footer={<><Button onClick={() => setSg({ ...sg, open: false })}>Cancelar</Button><Button variant="primary" onClick={saveSigner}>Guardar</Button></>}>
        <div className="grid gap-4">
          <Field label="Usuario que firmará" hint="La identidad del firmante se valida con su sesión al firmar."><Select value={sg.user_id} onChange={(e) => { const m = members.data?.find((x) => x.user_id === e.target.value); setSg({ ...sg, user_id: e.target.value, full_name: sg.full_name || m?.profile?.full_name || '', position: sg.position || m?.position || '' }); }}><option value="">Seleccione…</option>{members.data?.filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name} · {m.profile?.email}</option>)}</Select></Field>
          <Field label="Nombre del firmante"><Input value={sg.full_name} onChange={(e) => setSg({ ...sg, full_name: e.target.value })} /></Field>
          <Field label="Cargo"><Input value={sg.position} onChange={(e) => setSg({ ...sg, position: e.target.value })} /></Field>
          <Field label="Imagen de firma (PNG con fondo transparente recomendado)"><input type="file" accept="image/png,image/jpeg" className="text-[14px]" onChange={(e) => setSg({ ...sg, file: e.target.files?.[0] ?? null })} /></Field>
          {err && <ErrorBox error={err} />}
        </div>
      </Modal>
      <Modal open={sl.open} onClose={() => setSl({ ...sl, open: false })} title="Nuevo sello" footer={<><Button onClick={() => setSl({ ...sl, open: false })}>Cancelar</Button><Button variant="primary" onClick={saveSeal}>Guardar</Button></>}>
        <div className="grid gap-4">
          <Field label="Nombre"><Input value={sl.name} onChange={(e) => setSl({ ...sl, name: e.target.value })} placeholder="Sello corporativo" /></Field>
          <Field label="Imagen del sello"><input type="file" accept="image/png,image/jpeg" className="text-[14px]" onChange={(e) => setSl({ ...sl, file: e.target.files?.[0] ?? null })} /></Field>
          <Checkbox label="Usar como sello predeterminado" checked={sl.def} onChange={(v) => setSl({ ...sl, def: v })} />
          {err && <ErrorBox error={err} />}
        </div>
      </Modal>
    </div>
  );
}
