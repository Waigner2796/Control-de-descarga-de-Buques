import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useOrg } from '@/lib/auth';
import { rpc } from '@/lib/supabase';
import { useCustomersLite, useMembers, useProducts, useScales, useTerminals, useVessels } from '@/lib/hooks';
import { fmt0, localToIso } from '@/lib/format';
import { Button, Checkbox, Dot, ErrorBox, Field, Input, Notice, PageHeader, Section, Select, Textarea, useToast } from '@/components/ui';

type CargoDraft = { product_id: string; initial_tm: string };
type HoldDraft = { key: string; hold_number: number; capacity_tm: string; cargo: CargoDraft[] };
const k = () => Math.random().toString(36).slice(2);

export default function ServiceNew() {
  const { orgId } = useOrg();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const terminals = useTerminals(orgId);
  const customers = useCustomersLite(orgId);
  const vessels = useVessels(orgId);
  const products = useProducts(orgId);
  const scales = useScales(orgId);
  const members = useMembers(orgId);
  const [v, setV] = useState({ service_number: '', terminal_id: '', customer_id: '', vessel_id: '', status: 'scheduled', planned_start: '', estimated_end: '', responsible_user_id: '', responsible_name: '', observations: '' });
  const [scaleIds, setScaleIds] = useState<string[]>([]);
  const [holds, setHolds] = useState<HoldDraft[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const vessel = vessels.data?.find((x) => x.id === v.vessel_id);
  const tz = terminals.data?.find((t) => t.id === v.terminal_id)?.timezone ?? 'America/Guatemala';

  useEffect(() => { if (!v.terminal_id && terminals.data?.length === 1) setV((x) => ({ ...x, terminal_id: terminals.data![0].id })); }, [terminals.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!vessel) return;
    setHolds(Array.from({ length: vessel.holds_count }, (_, i) => ({ key: k(), hold_number: i + 1, capacity_tm: '', cargo: [{ product_id: '', initial_tm: '' }] })));
  }, [vessel?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const termScales = (scales.data ?? []).filter((s) => s.terminal_id === v.terminal_id && s.status === 'active');
  const total = useMemo(() => holds.reduce((a, h) => a + h.cargo.reduce((b, c) => b + (Number(c.initial_tm) || 0), 0), 0), [holds]);
  const set = (key: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [key]: e.target.value }));
  const updHold = (key: string, patch: Partial<HoldDraft>) => setHolds((hs) => hs.map((h) => (h.key === key ? { ...h, ...patch } : h)));

  const submit = async () => {
    setErr(null);
    if (!v.service_number.trim()) return setErr('Ingrese el número de servicio de su empresa.');
    if (!v.terminal_id || !v.customer_id || !v.vessel_id) return setErr('Seleccione terminal, cliente y buque.');
    const holdsPayload = holds.map((h) => ({
      hold_number: h.hold_number, capacity_tm: h.capacity_tm || null,
      cargo: h.cargo.filter((c) => c.product_id && Number(c.initial_tm) > 0).map((c) => ({ product_id: c.product_id, initial_tm: Number(c.initial_tm) })),
    })).filter((h) => h.cargo.length);
    for (const h of holds) {
      const ids = h.cargo.map((c) => c.product_id).filter(Boolean);
      if (new Set(ids).size !== ids.length) return setErr(`La bodega ${h.hold_number} tiene un producto repetido.`);
      if (h.cargo.some((c) => c.product_id && !(Number(c.initial_tm) > 0))) return setErr(`Indique el tonelaje de cada producto en la bodega ${h.hold_number}.`);
    }
    if (!holdsPayload.length) return setErr('Configure al menos una bodega con producto y tonelaje.');
    setBusy(true);
    try {
      const id = await rpc<string>('create_service', { p: {
        ...v, service_number: v.service_number.trim(),
        planned_start: localToIso(v.planned_start, tz), estimated_end: localToIso(v.estimated_end, tz),
        responsible_user_id: v.responsible_user_id || null,
        responsible_name: v.responsible_name || members.data?.find((m) => m.user_id === v.responsible_user_id)?.profile?.full_name || null,
        scale_ids: scaleIds, holds: holdsPayload,
      } });
      qc.invalidateQueries({ queryKey: ['services'] }); qc.invalidateQueries({ queryKey: ['services-lite'] });
      toast(`Servicio ${v.service_number.trim()} creado`);
      nav(`/app/servicios/${id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-5xl">
      <PageHeader title="Nuevo servicio de descarga" sub="El número de servicio lo define su empresa; el sistema valida que no se repita." />
      <div className="grid gap-5">
        <Section title="Servicio">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Número de servicio" required hint="Ej.: SV-2026-001, 4587-26, OP-1258"><Input value={v.service_number} onChange={set('service_number')} className="num text-[17px] font-semibold" autoFocus /></Field>
            <Field label="Terminal" required><Select value={v.terminal_id} onChange={set('terminal_id')}><option value="">Seleccione…</option>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <Field label="Estado inicial"><Select value={v.status} onChange={set('status')}><option value="scheduled">Programado</option><option value="preparing">En preparación</option></Select></Field>
            <Field label="Cliente" required><Select value={v.customer_id} onChange={set('customer_id')}><option value="">Seleccione…</option>{customers.data?.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.trade_name} ({c.code})</option>)}</Select></Field>
            <Field label="Buque" required hint={vessels.data?.length === 0 ? 'Registre buques en «Buques y productos».' : undefined}><Select value={v.vessel_id} onChange={set('vessel_id')}><option value="">Seleccione…</option>{vessels.data?.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.name}{x.imo_number ? ` · IMO ${x.imo_number}` : ''}</option>)}</Select></Field>
            <Field label="Responsable de operación"><Select value={v.responsible_user_id} onChange={set('responsible_user_id')}><option value="">Sin asignar</option>{members.data?.filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name || m.profile?.email}</option>)}</Select></Field>
            <Field label={`Fecha de inicio (hora de la terminal)`}><Input type="datetime-local" value={v.planned_start} onChange={set('planned_start')} /></Field>
            <Field label="Fecha estimada de finalización"><Input type="datetime-local" value={v.estimated_end} onChange={set('estimated_end')} /></Field>
            <Field label="Observaciones (visibles para el cliente)" className="md:col-span-3"><Textarea value={v.observations} onChange={set('observations')} /></Field>
          </div>
        </Section>

        <Section title="Básculas de la operación">
          {!v.terminal_id ? <p className="text-[14px] text-mute">Seleccione la terminal para ver sus básculas.</p> : termScales.length === 0 ? <Notice tone="warn">La terminal no tiene básculas activas. Regístrelas en «Básculas».</Notice> : (
            <div className="flex flex-wrap gap-x-6">
              {termScales.map((s) => <Checkbox key={s.id} label={`${s.name} (${s.code})`} hint={s.location ?? undefined} checked={scaleIds.includes(s.id)} onChange={(c) => setScaleIds((x) => (c ? [...x, s.id] : x.filter((y) => y !== s.id)))} />)}
            </div>
          )}
        </Section>

        <Section title="Bodegas, productos y tonelajes" actions={<span className="num text-[15px] font-semibold">Total: {fmt0(total)} TM</span>}>
          {!vessel ? <p className="text-[14px] text-mute">Seleccione el buque para configurar sus bodegas.</p> : (
            <div className="grid gap-3">
              {holds.map((h) => (
                <div key={h.key} className="rounded-xl border border-line p-3.5">
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <b className="font-cond text-[17px]">Bodega {h.hold_number}</b>
                    <label className="flex items-center gap-2 text-[13px] text-mute">Capacidad (TM)<Input type="number" min="0" step="0.001" className="min-h-[34px] w-28 py-1" value={h.capacity_tm} onChange={(e) => updHold(h.key, { capacity_tm: e.target.value })} /></label>
                    <button className="press ml-auto rounded-lg p-1.5 text-mute hover:bg-panel hover:text-red" aria-label={`Quitar bodega ${h.hold_number}`} onClick={() => setHolds((hs) => hs.filter((x) => x.key !== h.key))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                  <div className="grid gap-2">
                    {h.cargo.map((c, i) => {
                      const prod = products.data?.find((p) => p.id === c.product_id);
                      return (
                        <div key={i} className="grid grid-cols-[1fr_150px_auto] items-center gap-2">
                          <div className="flex items-center gap-2">{prod && <Dot color={prod.color} />}
                            <Select aria-label="Producto" value={c.product_id} onChange={(e) => updHold(h.key, { cargo: h.cargo.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)) })}>
                              <option value="">Producto…</option>{products.data?.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </Select>
                          </div>
                          <Input aria-label="Tonelaje inicial (TM)" type="number" min="0" step="0.001" placeholder="TM" className="num text-right" value={c.initial_tm} onChange={(e) => updHold(h.key, { cargo: h.cargo.map((x, j) => (j === i ? { ...x, initial_tm: e.target.value } : x)) })} />
                          <button className="press rounded-lg p-1.5 text-mute hover:text-red disabled:opacity-30" disabled={h.cargo.length === 1} aria-label="Quitar producto" onClick={() => updHold(h.key, { cargo: h.cargo.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></button>
                        </div>
                      );
                    })}
                    <button className="justify-self-start text-[13.5px] font-semibold text-sea hover:underline" onClick={() => updHold(h.key, { cargo: [...h.cargo, { product_id: '', initial_tm: '' }] })}>+ Otro producto en esta bodega</button>
                  </div>
                </div>
              ))}
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => setHolds((hs) => [...hs, { key: k(), hold_number: (hs.at(-1)?.hold_number ?? 0) + 1, capacity_tm: '', cargo: [{ product_id: '', initial_tm: '' }] }])}>Agregar bodega</Button>
            </div>
          )}
        </Section>
        {err && <ErrorBox error={err} />}
        <div className="flex justify-end gap-2"><Button onClick={() => nav('/app/servicios')}>Cancelar</Button><Button variant="primary" size="lg" loading={busy} onClick={submit}>Crear servicio</Button></div>
      </div>
    </div>
  );
}
