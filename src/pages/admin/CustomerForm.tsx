import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, unwrap } from '@/lib/supabase';
import { uploadImage } from '@/lib/assets';
import { Button, ErrorBox, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';

export type CustomerRow = {
  id: string; organization_id: string; code: string; trade_name: string; legal_name: string | null; tax_id: string | null; country: string | null; address: string | null;
  main_contact: string | null; representative: string | null; email: string | null; phone: string | null; status: string; notes: string | null; logo_path: string | null; created_at: string;
};
const EMPTY = { code: '', trade_name: '', legal_name: '', tax_id: '', country: 'Guatemala', address: '', main_contact: '', representative: '', email: '', phone: '', status: 'active', notes: '' };

export function CustomerForm({ open, onClose, orgId, customer, onSaved }: { open: boolean; onClose: () => void; orgId: string; customer?: CustomerRow | null; onSaved?: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<Record<string, string>>(EMPTY);
  const [logo, setLogo] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setErr(null); setLogo(null);
    setV(customer ? Object.fromEntries(Object.keys(EMPTY).map((k) => [k, String((customer as Record<string, unknown>)[k] ?? '')])) : EMPTY);
  }, [open, customer]);
  const set = (k: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    setErr(null);
    if (!v.code.trim() || v.trade_name.trim().length < 2) { setErr('Código y nombre comercial son obligatorios.'); return; }
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) { setErr('Correo electrónico inválido.'); return; }
    setBusy(true);
    try {
      const payload = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim() === '' ? null : x.trim()]));
      let id = customer?.id;
      if (id) unwrap(await supabase.from('customers').update(payload).eq('id', id));
      else id = (unwrap(await supabase.from('customers').insert({ ...payload, organization_id: orgId }).select('id').single()) as { id: string }).id;
      if (logo) {
        const path = await uploadImage('org-assets', `${orgId}/customers/${id}`, logo);
        unwrap(await supabase.from('customers').update({ logo_path: path }).eq('id', id!));
      }
      qc.invalidateQueries({ queryKey: ['customers'] }); qc.invalidateQueries({ queryKey: ['customer', id] }); qc.invalidateQueries({ queryKey: ['customers-lite'] });
      toast(customer ? 'Cliente actualizado' : 'Cliente creado');
      onSaved?.(id!); onClose();
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setErr(/Ya existe/.test(m) ? `El código «${v.code}» ya existe en la cartera.` : m);
    } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} wide title={customer ? `Editar ${customer.trade_name}` : 'Nuevo cliente'}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={save}>{customer ? 'Guardar cambios' : 'Crear cliente'}</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Código de cliente" required><Input value={v.code} onChange={set('code')} placeholder="C-001" /></Field>
        <Field label="Estado"><Select value={v.status} onChange={set('status')}><option value="active">Activo</option><option value="inactive">Inactivo</option></Select></Field>
        <Field label="Nombre comercial" required><Input value={v.trade_name} onChange={set('trade_name')} /></Field>
        <Field label="Razón social"><Input value={v.legal_name} onChange={set('legal_name')} /></Field>
        <Field label="NIT o identificación fiscal"><Input value={v.tax_id} onChange={set('tax_id')} /></Field>
        <Field label="País"><Input value={v.country} onChange={set('country')} /></Field>
        <Field label="Dirección" className="sm:col-span-2"><Input value={v.address} onChange={set('address')} /></Field>
        <Field label="Contacto principal"><Input value={v.main_contact} onChange={set('main_contact')} /></Field>
        <Field label="Representante"><Input value={v.representative} onChange={set('representative')} /></Field>
        <Field label="Correo electrónico"><Input type="email" value={v.email} onChange={set('email')} /></Field>
        <Field label="Teléfono"><Input type="tel" value={v.phone} onChange={set('phone')} /></Field>
        <Field label="Logotipo (opcional)" hint="PNG o JPG, máximo 5 MB. Puede aparecer en el informe final." className="sm:col-span-2">
          <input type="file" accept="image/png,image/jpeg" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} className="text-[14px]" />
        </Field>
        <Field label="Observaciones" className="sm:col-span-2"><Textarea value={v.notes} onChange={set('notes')} /></Field>
      </div>
      {err && <div className="mt-4"><ErrorBox error={err} /></div>}
    </Modal>
  );
}
