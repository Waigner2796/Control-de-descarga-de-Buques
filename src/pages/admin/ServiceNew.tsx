import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ClipboardPaste, Plus, Trash2 } from 'lucide-react';
import { useOrg } from '@/lib/auth';
import { rpc } from '@/lib/supabase';
import { useCustomersLite, useMembers, useProducts, useScales, useTerminals, useVessels } from '@/lib/hooks';
import { useShiftPlans } from '@/lib/shifts';
import { fmt0, fmt3, localToIso, parseNum } from '@/lib/format';
import { Button, Checkbox, ErrorBox, Field, Input, Modal, Notice, PageHeader, Section, Select, Textarea, useToast } from '@/components/ui';
import { ShipView, type ShipHold } from '@/components/ShipView';

type BlDraft = { key: string; number: string; qty: string };
type ProdDraft = { key: string; name: string; bag: string; tare: string; usesBl: boolean; bls: BlDraft[]; holds: Record<number, string> };
type PointDraft = { key: string; name: string; operators: string[] };
type TruckDraft = { key: string; plate: string; driver: string; tc: string; dpi: string };
const k = () => Math.random().toString(36).slice(2);
const newProd = (): ProdDraft => ({ key: k(), name: '', bag: '50', tare: '', usesBl: false, bls: [{ key: k(), number: '', qty: '' }], holds: {} });
const COLORS = ['#257de0', '#f47230', '#00b894', '#f2a600', '#ee7fac', '#008a17'];
const segBtn = (on: boolean) => clsx('press min-h-[42px] rounded-lg border px-4 text-[14px] font-semibold', on ? 'border-sea bg-seasoft' : 'border-edge hover:bg-panel');

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
  const plans = useShiftPlans(orgId);
  const [v, setV] = useState({ service_number: '', terminal_id: '', customer_id: '', status: 'scheduled', planned_start: '', estimated_end: '', responsible_user_id: '', observations: '', shift_plan_id: '' });
  const [kind, setKind] = useState<'discharge' | 'load'>('discharge');
  const [type, setType] = useState<'bulk' | 'bags'>('bulk');
  const [unitBags, setUnitBags] = useState(true);
  const [ves, setVes] = useState({ name: '', imo: '', flag: '' });
  const [holds, setHolds] = useState(5);
  const [prods, setProds] = useState<ProdDraft[]>([newProd()]);
  const [points, setPoints] = useState<PointDraft[]>([{ key: k(), name: '', operators: [] }]);
  const [bagOps, setBagOps] = useState<string[]>([]);
  const [trucks, setTrucks] = useState<TruckDraft[]>([]);
  const [paste, setPaste] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bags = type === 'bags';
  const tz = terminals.data?.find((t) => t.id === v.terminal_id)?.timezone ?? 'America/Guatemala';
  const set = (key: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [key]: e.target.value }));
  const updProd = (key: string, patch: Partial<ProdDraft>) => setProds((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  useEffect(() => { if (!v.terminal_id && terminals.data?.length === 1) setV((x) => ({ ...x, terminal_id: terminals.data![0].id })); }, [terminals.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const termPlans = (plans.data ?? []).filter((p) => p.terminal_id === v.terminal_id && p.status === 'active');
  useEffect(() => { if (termPlans.length && !termPlans.some((p) => p.id === v.shift_plan_id)) setV((x) => ({ ...x, shift_plan_id: (termPlans.find((p) => p.is_default) ?? termPlans[0]).id })); }, [termPlans.length, v.terminal_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const known = vessels.data?.find((x) => x.name.trim().toLowerCase() === ves.name.trim().toLowerCase());
  useEffect(() => { if (known) { setVes((x) => ({ ...x, imo: x.imo || known.imo_number || '', flag: x.flag || known.flag || '' })); if (known.holds_count >= 1 && known.holds_count <= 6) setHolds(known.holds_count); } }, [known?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Conversión de las cantidades escritas a TM (en sacos: unidades × peso del saco).
  const toTm = (q: string, p: ProdDraft) => { const n = parseNum(q); if (!Number.isFinite(n)) return 0; return bags && unitBags ? (n * (parseNum(p.bag) || 0)) / 1000 : n; };
  const unitLabel = bags && unitBags ? 'sacos' : 'TM';
  const prodTotals = prods.map((p) => {
    const holdTm = Array.from({ length: holds }, (_, i) => toTm(p.holds[i + 1] ?? '', p)).reduce((a, b) => a + b, 0);
    const blTm = p.usesBl ? p.bls.reduce((a, b) => a + toTm(b.qty, p), 0) : null;
    return { holdTm, blTm, mismatch: blTm != null && Math.abs(blTm - holdTm) > 0.01 };
  });
  const totalTm = prodTotals.reduce((a, t) => a + t.holdTm, 0);
  const totalBags = bags ? prods.reduce((a, p, i) => a + (parseNum(p.bag) > 0 ? (prodTotals[i].holdTm * 1000) / parseNum(p.bag) : 0), 0) : 0;
  const colorOf = (name: string, i: number) => products.data?.find((x) => x.name.toLowerCase() === name.trim().toLowerCase())?.color ?? COLORS[i % COLORS.length];
  const preview: ShipHold[] = useMemo(() => Array.from({ length: holds }, (_, i) => ({
    id: `h${i + 1}`, hold_number: i + 1,
    products: prods.map((p, j) => ({ cargo_id: `${p.key}-${i}`, name: p.name || `Producto ${j + 1}`, color: colorOf(p.name, j), initial_tm: toTm(p.holds[i + 1] ?? '', p), pending_tm: toTm(p.holds[i + 1] ?? '', p), bag_weight_kg: bags ? parseNum(p.bag) || null : null }))
      .filter((x) => x.initial_tm > 0),
  })), [holds, prods, bags, unitBags, products.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const termScales = (scales.data ?? []).filter((s) => s.terminal_id === v.terminal_id);
  const operators = (members.data ?? []).filter((m) => m.status === 'active' && m.role_code === 'scale_operator');
  const opName = (id: string) => { const m = members.data?.find((x) => x.user_id === id); return m?.profile?.full_name || m?.profile?.email || 'Usuario'; };

  const applyPaste = () => {
    const rows = (paste ?? '').split(/\r?\n/).map((l) => l.split(/\t|;|,/).map((c) => c.trim())).filter((c) => c[0]);
    const parsed = rows.filter((c) => !/placa|plate/i.test(c[0])).map((c) => ({ key: k(), plate: c[0].toUpperCase().replace(/\s+/g, ''), driver: c[1] ?? '', tc: (c[2] ?? '').toUpperCase(), dpi: c[3] ?? '' }));
    setTrucks((t) => { const seen = new Set(t.map((x) => x.plate)); return [...t, ...parsed.filter((x) => !seen.has(x.plate) && seen.add(x.plate))]; });
    toast(`${parsed.length} camiones agregados a la lista`); setPaste(null);
  };

  const submit = async () => {
    setErr(null);
    if (!v.service_number.trim()) return setErr('Ingrese el número de servicio de su empresa.');
    if (!v.terminal_id || !v.customer_id) return setErr('Seleccione terminal y cliente.');
    if (ves.name.trim().length < 2) return setErr('Escriba el nombre del buque.');
    if (ves.imo && !/^\d{7}$/.test(ves.imo.replace(/\D/g, ''))) return setErr('El número IMO debe tener 7 dígitos.');
    for (const [i, p] of prods.entries()) {
      const label = p.name.trim() || `producto ${i + 1}`;
      if (p.name.trim().length < 2) return setErr(`Escriba el nombre del ${label}.`);
      if (bags && !(parseNum(p.bag) > 0)) return setErr(`Indique el peso por saco de ${label}.`);
      if (!(prodTotals[i].holdTm > 0)) return setErr(`Indique en qué bodegas viene ${label} y cuánto.`);
      if (p.usesBl && p.bls.some((b) => !b.number.trim() || !(toTm(b.qty, p) > 0))) return setErr(`Complete número y cantidad de cada BL de ${label}.`);
      if (prodTotals[i].mismatch) return setErr(`En ${label}, la suma de los BL no coincide con la suma por bodegas.`);
    }
    if (new Set(prods.map((p) => p.name.trim().toLowerCase())).size !== prods.length) return setErr('Hay un producto repetido.');
    if (!bags && points.some((p) => !p.name.trim())) return setErr('Escriba el nombre de cada báscula o punto de descarga (o quítelo).');
    if (trucks.some((t) => t.plate.length < 2 || t.driver.trim().length < 2)) return setErr('Cada camión necesita placa y piloto.');
    setBusy(true);
    try {
      const imo = ves.imo.replace(/\D/g, '');
      const id = await rpc<string>('create_service', { p: {
        terminal_id: v.terminal_id, customer_id: v.customer_id, service_number: v.service_number.trim(), status: v.status,
        planned_start: localToIso(v.planned_start, tz), estimated_end: localToIso(v.estimated_end, tz),
        responsible_user_id: v.responsible_user_id || null, responsible_name: v.responsible_user_id ? opName(v.responsible_user_id) : null, observations: v.observations || null,
        cargo_type: type, operation_kind: kind, shift_plan_id: v.shift_plan_id || null, holds_count: holds,
        ...(known && (!imo || imo === known.imo_number) ? { vessel_id: known.id } : { vessel: { name: ves.name.trim(), imo_number: imo || null, flag: ves.flag.trim() || null } }),
        products: prods.map((p) => {
          const cat = products.data?.find((x) => x.name.toLowerCase() === p.name.trim().toLowerCase());
          return { ...(cat ? { product_id: cat.id } : { product_name: p.name.trim() }), bag_weight_kg: bags ? parseNum(p.bag) : null, bag_tare_kg: bags && p.tare !== '' ? parseNum(p.tare) : null,
            uses_bl: p.usesBl, holds: Array.from({ length: holds }, (_, i) => ({ hold_number: i + 1, planned_tm: Number(toTm(p.holds[i + 1] ?? '', p).toFixed(3)) })).filter((h) => h.planned_tm > 0),
            bls: p.usesBl ? p.bls.map((b) => ({ bl_number: b.number.trim(), planned_tm: Number(toTm(b.qty, p).toFixed(3)) })) : [] };
        }),
        points: bags ? [] : points.map((pt) => { const s = termScales.find((x) => x.name.toLowerCase() === pt.name.trim().toLowerCase()); return { ...(s ? { scale_id: s.id } : { name: pt.name.trim() }), operator_ids: pt.operators }; }),
        operator_ids: bags ? bagOps : [],
        trucks: trucks.map((t) => ({ plate: t.plate, driver_name: t.driver.trim(), tractor_plate: t.tc || null, driver_dpi: t.dpi || null })),
      } });
      ['services', 'services-lite', 'scales', 'vessels', 'products'].forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
      toast(`Servicio ${v.service_number.trim()} creado`);
      nav(`/app/servicios/${id}`);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="max-w-6xl">
      <PageHeader title="Nuevo servicio" sub="Todo lo del servicio se define aquí: buque, bodegas, productos, BL, básculas o puntos de descarga y camiones." />
      <div className="grid gap-5">
        <Section title="Servicio">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Número de servicio" required hint="Lo define su empresa; no se repite."><Input value={v.service_number} onChange={set('service_number')} className="num text-[17px] font-semibold" autoFocus /></Field>
            <Field label="Operación"><div className="flex gap-2"><button type="button" className={segBtn(kind === 'discharge')} aria-pressed={kind === 'discharge'} onClick={() => setKind('discharge')}>Descarga</button><button type="button" className={segBtn(kind === 'load')} aria-pressed={kind === 'load'} onClick={() => setKind('load')}>Carga</button></div></Field>
            <Field label="Estado inicial"><Select value={v.status} onChange={set('status')}><option value="scheduled">Programado</option><option value="preparing">En preparación</option></Select></Field>
            <Field label="Terminal" required><Select value={v.terminal_id} onChange={set('terminal_id')}><option value="">Seleccione…</option>{terminals.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            <Field label="Cliente" required><Select value={v.customer_id} onChange={set('customer_id')}><option value="">Seleccione…</option>{customers.data?.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.trade_name} ({c.code})</option>)}</Select></Field>
            <Field label="Esquema de turnos" hint="Se configura en Configuración › Turnos."><Select value={v.shift_plan_id} onChange={set('shift_plan_id')}>{termPlans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? ' (predeterminado)' : ''}</option>)}</Select></Field>
            <Field label="Responsable de operación"><Select value={v.responsible_user_id} onChange={set('responsible_user_id')}><option value="">Sin asignar</option>{members.data?.filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{m.profile?.full_name || m.profile?.email}</option>)}</Select></Field>
            <Field label="Inicio (hora de la terminal)"><Input type="datetime-local" value={v.planned_start} onChange={set('planned_start')} /></Field>
            <Field label="Finalización estimada"><Input type="datetime-local" value={v.estimated_end} onChange={set('estimated_end')} /></Field>
            <Field label="Observaciones (visibles para el cliente)" className="md:col-span-3"><Textarea value={v.observations} onChange={set('observations')} /></Field>
          </div>
        </Section>

        <Section title="Buque">
          <div className="grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
            <Field label="Nombre del buque" required hint={known ? 'Buque ya registrado: se reutiliza.' : vessels.data?.length ? 'Escriba uno nuevo o elija de la lista.' : undefined}><Input list="vessel-names" value={ves.name} onChange={(e) => setVes((x) => ({ ...x, name: e.target.value }))} placeholder="M/V Autumn Sea" /></Field>
            <datalist id="vessel-names">{vessels.data?.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.name} />)}</datalist>
            <Field label="Número IMO (opcional)"><Input inputMode="numeric" value={ves.imo} onChange={(e) => setVes((x) => ({ ...x, imo: e.target.value }))} /></Field>
            <Field label="Bandera (opcional)"><Input value={ves.flag} onChange={(e) => setVes((x) => ({ ...x, flag: e.target.value }))} /></Field>
          </div>
          <div className="mt-4"><div className="lbl mb-1.5">Número de bodegas</div><div className="flex flex-wrap gap-2">{[1, 2, 3, 4, 5, 6].map((n) => <button type="button" key={n} aria-pressed={holds === n} onClick={() => setHolds(n)} className={clsx(segBtn(holds === n), 'num w-12 px-0')}>{n}</button>)}</div></div>
        </Section>

        <Section title="Carga" actions={<span className="num text-[15px] font-semibold">{fmt3(totalTm)} TM{bags ? ` · ${fmt0(totalBags)} sacos` : ''}</span>}>
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Presentación"><div className="flex gap-2"><button type="button" className={segBtn(!bags)} aria-pressed={!bags} onClick={() => setType('bulk')}>A granel</button><button type="button" className={segBtn(bags)} aria-pressed={bags} onClick={() => setType('bags')}>En sacos</button></div></Field>
            {bags && <Field label="Cantidades en"><div className="flex gap-2"><button type="button" className={segBtn(unitBags)} aria-pressed={unitBags} onClick={() => setUnitBags(true)}>Sacos</button><button type="button" className={segBtn(!unitBags)} aria-pressed={!unitBags} onClick={() => setUnitBags(false)}>TM</button></div></Field>}
          </div>
          {bags && <Notice className="mt-3">Servicio en sacos: se registra el conteo de sacos por bodega y turno, los sacos dañados y el peso de cada saco con su temperatura. No usa básculas ni boletas de camión.</Notice>}
          <div className="mt-4 grid gap-3">
            {prods.map((p, i) => {
              const t = prodTotals[i];
              return (
                <div key={p.key} className="rounded-xl border border-line p-3.5">
                  <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
                    <Field label={`Producto ${i + 1}`} required><Input list="product-names" value={p.name} onChange={(e) => updProd(p.key, { name: e.target.value })} placeholder={bags ? 'Azúcar blanca refinada' : 'Maíz amarillo'} /></Field>
                    {bags ? <Field label="Peso por saco (kg)" required><Input type="number" min="0" step="0.01" value={p.bag} onChange={(e) => updProd(p.key, { bag: e.target.value })} className="num text-right" /></Field> : <div />}
                    {bags ? <Field label="Tara del saco (kg)" hint="General de la presentación"><Input type="number" min="0" step="0.001" value={p.tare} onChange={(e) => updProd(p.key, { tare: e.target.value })} className="num text-right" /></Field> : <div />}
                    <button type="button" className="press justify-self-end rounded-lg p-2 text-mute hover:bg-panel hover:text-red disabled:opacity-30" disabled={prods.length === 1} aria-label={`Quitar producto ${i + 1}`} onClick={() => setProds((ps) => ps.filter((x) => x.key !== p.key))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                  <div className="mt-3"><div className="lbl mb-1.5">Cantidad por bodega ({unitLabel})</div>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{Array.from({ length: holds }, (_, h) => (
                      <label key={h} className="grid gap-1 text-[12.5px] text-mute">Bodega {h + 1}<Input type="number" min="0" step={unitLabel === 'TM' ? '0.001' : '1'} className="num text-right" value={p.holds[h + 1] ?? ''} onChange={(e) => updProd(p.key, { holds: { ...p.holds, [h + 1]: e.target.value } })} /></label>
                    ))}</div>
                  </div>
                  <div className="mt-3"><Checkbox label="Viene por BL (conocimiento de embarque)" checked={p.usesBl} onChange={(c) => updProd(p.key, { usesBl: c })} /></div>
                  {p.usesBl && (
                    <div className="mt-2 grid gap-2">
                      {p.bls.map((b, j) => (
                        <div key={b.key} className="grid grid-cols-[1fr_160px_auto] items-center gap-2">
                          <Input aria-label="Número de BL" placeholder="Número de BL" value={b.number} onChange={(e) => updProd(p.key, { bls: p.bls.map((x, y) => (y === j ? { ...x, number: e.target.value } : x)) })} />
                          <Input aria-label={`Cantidad del BL (${unitLabel})`} placeholder={unitLabel} type="number" min="0" className="num text-right" value={b.qty} onChange={(e) => updProd(p.key, { bls: p.bls.map((x, y) => (y === j ? { ...x, qty: e.target.value } : x)) })} />
                          <button type="button" className="press rounded-lg p-1.5 text-mute hover:text-red disabled:opacity-30" disabled={p.bls.length === 1} aria-label="Quitar BL" onClick={() => updProd(p.key, { bls: p.bls.filter((_, y) => y !== j) })}><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ))}
                      <button type="button" className="justify-self-start text-[13.5px] font-semibold text-sea hover:underline" onClick={() => updProd(p.key, { bls: [...p.bls, { key: k(), number: '', qty: '' }] })}>+ Otro BL</button>
                    </div>
                  )}
                  <p className={clsx('num mt-2 text-[13px]', t.mismatch ? 'font-semibold text-red' : 'text-mute')}>
                    Por bodegas: {fmt3(t.holdTm)} TM{t.blTm != null && ` · BL: ${fmt3(t.blTm)} TM`}{t.mismatch && ' · no coinciden'}{bags && parseNum(p.bag) > 0 && ` · ${fmt0((t.holdTm * 1000) / parseNum(p.bag))} sacos`}
                  </p>
                </div>
              );
            })}
            <datalist id="product-names">{products.data?.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.name} />)}</datalist>
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setProds((ps) => [...ps, newProd()])} className="justify-self-start">Agregar producto</Button>
          </div>
          {totalTm > 0 && <div className="mt-4"><ShipView holds={preview} vesselName={ves.name} kind={kind} /></div>}
        </Section>

        {bags ? (
          <Section title="Operadores que registran sacos">
            {operators.length ? <div className="flex flex-wrap gap-x-6">{operators.map((m) => <Checkbox key={m.user_id} label={opName(m.user_id)} checked={bagOps.includes(m.user_id)} onChange={(c) => setBagOps((x) => (c ? [...x, m.user_id] : x.filter((y) => y !== m.user_id)))} />)}</div>
              : <p className="text-[14px] text-mute">No hay usuarios con rol «Operador de báscula». Los supervisores y administradores también pueden registrar.</p>}
          </Section>
        ) : (
          <Section title="Básculas o puntos de descarga">
            {!v.terminal_id ? <p className="text-[14px] text-mute">Seleccione la terminal.</p> : (
              <div className="grid gap-3">
                {points.map((pt, i) => (
                  <div key={pt.key} className="rounded-xl border border-line p-3">
                    <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                      <Field label={`Báscula o punto ${i + 1}`} hint={termScales.some((s) => s.name.toLowerCase() === pt.name.trim().toLowerCase()) ? 'Ya existe en la terminal: se reutiliza.' : pt.name.trim() ? 'Nuevo: se creará en la terminal.' : 'Ej.: Báscula portón norte, Bodega fiscal 2'}>
                        <Input list="scale-names" value={pt.name} onChange={(e) => setPoints((ps) => ps.map((x) => (x.key === pt.key ? { ...x, name: e.target.value } : x)))} />
                      </Field>
                      <button type="button" className="press justify-self-end rounded-lg p-2 text-mute hover:bg-panel hover:text-red" aria-label={`Quitar punto ${i + 1}`} onClick={() => setPoints((ps) => ps.filter((x) => x.key !== pt.key))}><Trash2 className="h-4 w-4" /></button>
                    </div>
                    {operators.length > 0 && <div className="mt-2"><div className="lbl mb-1">Operadores</div><div className="flex flex-wrap gap-x-5">{operators.map((m) => <Checkbox key={m.user_id} label={opName(m.user_id)} checked={pt.operators.includes(m.user_id)} onChange={(c) => setPoints((ps) => ps.map((x) => (x.key === pt.key ? { ...x, operators: c ? [...x.operators, m.user_id] : x.operators.filter((y) => y !== m.user_id) } : x)))} />)}</div></div>}
                  </div>
                ))}
                <datalist id="scale-names">{termScales.map((s) => <option key={s.id} value={s.name} />)}</datalist>
                <Button icon={<Plus className="h-4 w-4" />} className="justify-self-start" onClick={() => setPoints((ps) => [...ps, { key: k(), name: '', operators: [] }])}>Agregar báscula o punto</Button>
              </div>
            )}
          </Section>
        )}

        {!bags && (
          <Section title={`Camiones y pilotos del servicio (${trucks.length})`} actions={<Button size="sm" icon={<ClipboardPaste className="h-4 w-4" />} onClick={() => setPaste('')}>Pegar desde Excel</Button>}>
            <p className="mb-3 text-[13.5px] text-mute">Solo para este servicio; no aparecen en otros. En báscula se elige la placa y el piloto se completa solo. Si llega un camión nuevo, el operador lo agrega al registrar.</p>
            {trucks.length > 0 && (
              <div className="grid gap-2">
                {trucks.map((t) => (
                  <div key={t.key} className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[140px_1fr_120px_160px_auto]">
                    <Input aria-label="Placa" placeholder="Placa" value={t.plate} onChange={(e) => setTrucks((x) => x.map((y) => (y.key === t.key ? { ...y, plate: e.target.value.toUpperCase().replace(/\s+/g, '') } : y)))} className="num font-semibold" />
                    <Input aria-label="Piloto" placeholder="Piloto" value={t.driver} onChange={(e) => setTrucks((x) => x.map((y) => (y.key === t.key ? { ...y, driver: e.target.value } : y)))} />
                    <Input aria-label="Placa TC" placeholder="TC (opcional)" value={t.tc} onChange={(e) => setTrucks((x) => x.map((y) => (y.key === t.key ? { ...y, tc: e.target.value.toUpperCase() } : y)))} />
                    <Input aria-label="DPI" placeholder="DPI (opcional)" inputMode="numeric" value={t.dpi} onChange={(e) => setTrucks((x) => x.map((y) => (y.key === t.key ? { ...y, dpi: e.target.value } : y)))} />
                    <button type="button" className="press justify-self-end rounded-lg p-1.5 text-mute hover:text-red" aria-label={`Quitar camión ${t.plate}`} onClick={() => setTrucks((x) => x.filter((y) => y.key !== t.key))}><Trash2 className="h-4 w-4" /></button>
                  </div>
                ))}
              </div>
            )}
            <Button icon={<Plus className="h-4 w-4" />} className="mt-3" onClick={() => setTrucks((x) => [...x, { key: k(), plate: '', driver: '', tc: '', dpi: '' }])}>Agregar camión</Button>
          </Section>
        )}
        {err && <ErrorBox error={err} />}
        <div className="flex justify-end gap-2"><Button onClick={() => nav('/app/servicios')}>Cancelar</Button><Button variant="primary" size="lg" loading={busy} onClick={submit}>Crear servicio</Button></div>
      </div>
      <Modal open={paste != null} onClose={() => setPaste(null)} title="Pegar lista de camiones"
        footer={<><Button onClick={() => setPaste(null)}>Cancelar</Button><Button variant="primary" onClick={applyPaste} disabled={!paste?.trim()}>Agregar a la lista</Button></>}>
        <p className="mb-2 text-[14px] text-mute">Copie desde Excel las columnas <b>Placa, Piloto</b> y, si las tiene, <b>Placa TC, DPI</b>. Una fila por camión.</p>
        <Textarea rows={10} value={paste ?? ''} onChange={(e) => setPaste(e.target.value)} placeholder={'C-123BCD\tJuan Pérez\nC-456FGH\tMario Ajú\tTC-789JKL\t2456789010101'} className="num" />
      </Modal>
    </div>
  );
}
