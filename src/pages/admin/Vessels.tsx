import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Anchor, Plus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useProducts, useUrlState, useVessels, type Product, type Vessel } from '@/lib/hooks';
import { fmt0 } from '@/lib/format';
import { ACTIVE } from '@/lib/labels';
import { Button, DataTable, Dot, EmptyState, ErrorBox, Field, Input, Modal, PageHeader, Select, StatusBadge, Tabs, Textarea, useToast, type Column } from '@/components/ui';

export default function Vessels() {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const [f, setF] = useUrlState({ tab: 'buques' });
  return (
    <div>
      <PageHeader title="Buques y productos" sub="Catálogos reutilizables: un mismo buque participa en múltiples servicios, cada uno con su propia configuración de bodegas." />
      <Tabs value={f.tab} onChange={(t) => setF({ tab: t })} tabs={[{ id: 'buques', label: 'Buques' }, { id: 'productos', label: 'Productos' }]} />
      {f.tab === 'buques' ? <VesselsTab orgId={orgId} manage={can('vessels.manage')} /> : <ProductsTab orgId={orgId} manage={can('vessels.manage')} />}
    </div>
  );
}

function VesselsTab({ orgId, manage }: { orgId: string; manage: boolean }) {
  const q = useVessels(orgId);
  const qc = useQueryClient();
  const toast = useToast();
  const E = { name: '', imo_number: '', vessel_type: 'Granelero', flag: '', capacity_tm: '', holds_count: '5', notes: '', status: 'active' };
  const [form, setForm] = useState<{ open: boolean; row?: Vessel; v: typeof E }>({ open: false, v: E });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    const v = form.v;
    if (v.imo_number && !/^\d{7}$/.test(v.imo_number)) return setErr('El número IMO tiene 7 dígitos.');
    const payload = { name: v.name.trim(), imo_number: v.imo_number || null, vessel_type: v.vessel_type, flag: v.flag || null, capacity_tm: v.capacity_tm ? Number(v.capacity_tm) : null, holds_count: Number(v.holds_count) || 1, notes: v.notes || null, status: v.status };
    try {
      if (form.row) unwrap(await supabase.from('vessels').update(payload).eq('id', form.row.id));
      else unwrap(await supabase.from('vessels').insert({ ...payload, organization_id: orgId }));
      qc.invalidateQueries({ queryKey: ['vessels', orgId] }); setForm({ open: false, v: E }); toast('Buque guardado');
    } catch (e) { const m = (e as Error).message; setErr(/Ya existe/.test(m) ? 'Ya existe un buque con ese número IMO.' : m); }
  };
  const cols: Column<Vessel>[] = [
    { key: 'n', header: 'Buque', cell: (v) => <b>{v.name}</b> },
    { key: 'i', header: 'IMO', cell: (v) => <span className="num">{v.imo_number ?? '—'}</span> },
    { key: 't', header: 'Tipo', cell: (v) => v.vessel_type },
    { key: 'c', header: 'Capacidad', align: 'right', cell: (v) => (v.capacity_tm ? `${fmt0(v.capacity_tm)} TM` : '—') },
    { key: 'h', header: 'Bodegas', align: 'right', cell: (v) => v.holds_count },
    { key: 'o', header: 'Observaciones', hideBelow: 'lg', wrap: true, cell: (v) => <span className="text-[13.5px]">{v.notes ?? '—'}</span> },
    { key: 's', header: 'Estado', cell: (v) => <StatusBadge map={ACTIVE} value={v.status} /> },
    { key: 'a', header: <span className="sr-only">Editar</span>, align: 'right', cell: (v) => manage && <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, row: v, v: { name: v.name, imo_number: v.imo_number ?? '', vessel_type: v.vessel_type, flag: v.flag ?? '', capacity_tm: v.capacity_tm ? String(v.capacity_tm) : '', holds_count: String(v.holds_count), notes: v.notes ?? '', status: v.status } })}>Editar</Button> },
  ];
  const set = (k: keyof typeof E) => (e: { target: { value: string } }) => setForm((x) => ({ ...x, v: { ...x.v, [k]: e.target.value } }));
  return (
    <div>
      {manage && <div className="mb-3 flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(null); setForm({ open: true, v: E }); }}>Nuevo buque</Button></div>}
      <DataTable columns={cols} rows={q.data} rowKey={(v) => v.id} loading={q.isLoading} empty={<EmptyState icon={<Anchor className="h-8 w-8" />} title="Sin buques registrados">Registre el buque con su número IMO y cantidad de bodegas.</EmptyState>} />
      <Modal open={form.open} onClose={() => setForm({ ...form, open: false })} title={form.row ? 'Editar buque' : 'Nuevo buque'} footer={<><Button onClick={() => setForm({ ...form, open: false })}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre del buque" required className="sm:col-span-2"><Input value={form.v.name} onChange={set('name')} placeholder="MV Ocean Kestrel" /></Field>
          <Field label="Número IMO"><Input inputMode="numeric" value={form.v.imo_number} onChange={set('imo_number')} className="num" /></Field>
          <Field label="Tipo de buque"><Input value={form.v.vessel_type} onChange={set('vessel_type')} /></Field>
          <Field label="Capacidad (TM)"><Input type="number" value={form.v.capacity_tm} onChange={set('capacity_tm')} /></Field>
          <Field label="Número de bodegas"><Input type="number" min="1" max="30" value={form.v.holds_count} onChange={set('holds_count')} /></Field>
          <Field label="Bandera"><Input value={form.v.flag} onChange={set('flag')} /></Field>
          <Field label="Estado"><Select value={form.v.status} onChange={set('status')}><option value="active">Activo</option><option value="inactive">Inactivo</option></Select></Field>
          <Field label="Observaciones" className="sm:col-span-2"><Textarea value={form.v.notes} onChange={set('notes')} /></Field>
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
    </div>
  );
}

function ProductsTab({ orgId, manage }: { orgId: string; manage: boolean }) {
  const q = useProducts(orgId);
  const qc = useQueryClient();
  const E = { code: '', name: '', color: '#4c9a4f', description: '', status: 'active' };
  const [form, setForm] = useState<{ open: boolean; row?: Product; v: typeof E }>({ open: false, v: E });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      const payload = { code: form.v.code || null, name: form.v.name.trim(), color: form.v.color, description: form.v.description || null, status: form.v.status };
      if (form.row) unwrap(await supabase.from('products').update(payload).eq('id', form.row.id));
      else unwrap(await supabase.from('products').insert({ ...payload, organization_id: orgId }));
      qc.invalidateQueries({ queryKey: ['products', orgId] }); setForm({ open: false, v: E });
    } catch (e) { const m = (e as Error).message; setErr(/Ya existe/.test(m) ? 'Ya existe un producto con ese nombre.' : m); }
  };
  const cols: Column<Product>[] = [
    { key: 'n', header: 'Producto', cell: (p) => <span className="inline-flex items-center gap-2"><Dot color={p.color} /><b>{p.name}</b></span> },
    { key: 'c', header: 'Código', cell: (p) => p.code ?? '—' },
    { key: 'd', header: 'Descripción', cell: (p) => p.description ?? '—' },
    { key: 's', header: 'Estado', cell: (p) => <StatusBadge map={ACTIVE} value={p.status} /> },
    { key: 'a', header: <span className="sr-only">Editar</span>, align: 'right', cell: (p) => manage && <Button size="sm" variant="ghost" onClick={() => setForm({ open: true, row: p, v: { code: p.code ?? '', name: p.name, color: p.color, description: p.description ?? '', status: p.status } })}>Editar</Button> },
  ];
  return (
    <div>
      {manage && <div className="mb-3 flex justify-end"><Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => { setErr(null); setForm({ open: true, v: E }); }}>Nuevo producto</Button></div>}
      <DataTable columns={cols} rows={q.data} rowKey={(p) => p.id} loading={q.isLoading} empty={<EmptyState title="Sin productos">Registre los graneles que se descargan (fertilizante, urea, maíz, trigo…) y su color en la ilustración del buque.</EmptyState>} />
      <Modal open={form.open} onClose={() => setForm({ ...form, open: false })} title={form.row ? 'Editar producto' : 'Nuevo producto'} footer={<><Button onClick={() => setForm({ ...form, open: false })}>Cancelar</Button><Button variant="primary" onClick={save}>Guardar</Button></>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nombre" required><Input value={form.v.name} onChange={(e) => setForm({ ...form, v: { ...form.v, name: e.target.value } })} /></Field>
          <Field label="Código"><Input value={form.v.code} onChange={(e) => setForm({ ...form, v: { ...form.v, code: e.target.value } })} /></Field>
          <Field label="Color en el buque"><div className="flex items-center gap-2"><input type="color" value={form.v.color} onChange={(e) => setForm({ ...form, v: { ...form.v, color: e.target.value } })} className="h-10 w-14 rounded border border-edge" /><Input className="num" value={form.v.color} onChange={(e) => setForm({ ...form, v: { ...form.v, color: e.target.value } })} /></div></Field>
          <Field label="Estado"><Select value={form.v.status} onChange={(e) => setForm({ ...form, v: { ...form.v, status: e.target.value } })}><option value="active">Activo</option><option value="inactive">Inactivo</option></Select></Field>
          <Field label="Descripción" className="sm:col-span-2"><Input value={form.v.description} onChange={(e) => setForm({ ...form, v: { ...form.v, description: e.target.value } })} /></Field>
          {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        </div>
      </Modal>
    </div>
  );
}
