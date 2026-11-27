import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { callFunction, rpc, supabase, unwrap } from '@/lib/supabase';
import { dt, fmt2, localInput } from '@/lib/format';
import { FIELD_LABEL, SCOPE } from '@/lib/labels';
import type { CycleRow, DowntimeRow } from '@/lib/queries';
import { Button, ErrorBox, Field, Input, Modal, Notice, Select, Textarea, useToast } from '@/components/ui';

type Target = { type: 'weigh_ticket'; row: CycleRow } | { type: 'downtime_event'; row: DowntimeRow };

/** Corrección auditada: motivo obligatorio; aplica directo si el usuario tiene autorización, si no queda pendiente. */
export function CorrectionDialog({ target, tz, onClose, mode = 'update' }: { target: Target | null; tz: string; onClose: () => void; mode?: 'update' | 'void' }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const serviceId = target?.row.service_id;
  const holds = useQuery({ queryKey: ['corr-holds', serviceId], enabled: !!serviceId, queryFn: async () => unwrap(await supabase.from('service_hold_cargo').select('service_hold_id, product_id, hold:service_holds(hold_number), product:products(name)').eq('service_id', serviceId!)) as unknown as { service_hold_id: string; product_id: string; hold: { hold_number: number }; product: { name: string } }[] });
  const scales = useQuery({ queryKey: ['corr-scales', serviceId], enabled: !!serviceId, queryFn: async () => unwrap(await supabase.from('service_scales').select('scale_id, scale:scales(name, code)').eq('service_id', serviceId!)) as unknown as { scale_id: string; scale: { name: string; code: string } }[] });
  const causes = useQuery({ queryKey: ['causes-all'], enabled: target?.type === 'downtime_event', queryFn: async () => unwrap(await supabase.from('downtime_causes').select('id, name').eq('status', 'active').order('name')) as { id: string; name: string }[] });

  const initial = useMemo((): Record<string, string> => {
    if (!target) return {};
    if (target.type === 'weigh_ticket') {
      const r = target.row;
      return { truck_plate: r.truck_plate, tractor_plate: r.tractor_plate ?? '', driver_name: r.driver_name, driver_dpi: r.driver_dpi, gross_kg: String(Number(r.gross_kg)), tare_kg: String(Number(r.tare_kg)),
        service_hold_id: r.service_hold_id, product_id: r.product_id, scale_id: r.scale_id, started_local: localInput(r.started_at, tz), ended_local: localInput(r.ended_at, tz), ticket_number: r.ticket_number, notes: r.notes ?? '' };
    }
    const d = target.row;
    return { cause_id: d.cause_id, started_local: localInput(d.started_at, tz), ended_local: localInput(d.ended_at, tz), scope: d.scope, service_hold_id: d.service_hold_id ?? '', scale_id: d.scale_id ?? '', observations: d.observations ?? '' };
  }, [target, tz]);
  useEffect(() => { setV(initial); setReason(''); setErr(null); }, [initial]);

  const changes = useMemo(() => Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== initial[k]).map(([k, x]) => [k, x === '' ? null : x])), [v, initial]);
  const net = target?.type === 'weigh_ticket' ? (Number(v.gross_kg) - Number(v.tare_kg)) / 1000 : 0;
  const direct = !!target && can('corrections.approve');

  const submit = async () => {
    if (!target) return;
    setErr(null);
    if (reason.trim().length < 8) return setErr('Escriba el motivo de la corrección (mínimo 8 caracteres).');
    if (mode === 'update' && !Object.keys(changes).length) return setErr('No hay cambios respecto al registro actual.');
    setBusy(true);
    try {
      const r = await rpc<{ status: string; result?: { job_id?: string } }>('request_correction', {
        p_target_type: target.type, p_target_id: target.row.id, p_action: mode, p_changes: mode === 'void' ? {} : changes, p_reason: reason.trim(), p_expected_revision: target.row.revision,
      });
      if (r.result?.job_id) callFunction('report-worker', { job_id: r.result.job_id }).catch(() => undefined);
      toast(r.status === 'applied' ? (r.result?.job_id ? 'Corrección aplicada. Se generará una nueva versión del informe final.' : 'Corrección aplicada y tonelaje recalculado') : 'Solicitud enviada a aprobación', r.status === 'applied' ? 'ok' : 'info');
      ['cycles', 'service-cargo', 'service-kpis', 'downtime', 'downtime-summary', 'corrections', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (!target) return null;
  const set = (k: string) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const title = mode === 'void' ? (target.type === 'weigh_ticket' ? `Anular ticket ${target.row.ticket_number}` : 'Anular tiempo perdido') : (target.type === 'weigh_ticket' ? `Corregir ticket ${target.row.ticket_number}` : `Corregir evento: ${target.row.cause_name}`);
  return (
    <Modal open onClose={onClose} wide title={title}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant={mode === 'void' ? 'danger' : 'primary'} loading={busy} onClick={submit}>{direct ? (mode === 'void' ? 'Anular registro' : 'Aplicar corrección') : 'Enviar a aprobación'}</Button></>}>
      <div className="grid gap-4">
        <Notice tone={direct ? 'info' : 'warn'}>
          {direct ? 'Tiene autorización: el cambio se aplica de inmediato.' : 'Su solicitud quedará pendiente hasta que un supervisor la apruebe.'} Se conserva el registro original, el valor anterior y el nuevo, su usuario y la hora. {target.type === 'weigh_ticket' && 'Si cambia el neto, la bodega o el producto, se generan movimientos compensatorios en el saldo.'}
        </Notice>
        {mode === 'update' && target.type === 'weigh_ticket' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Número de ticket"><Input value={v.ticket_number ?? ''} onChange={set('ticket_number')} /></Field>
            <Field label="Matrícula del camión"><Input value={v.truck_plate ?? ''} onChange={(e) => setV((x) => ({ ...x, truck_plate: e.target.value.toUpperCase() }))} /></Field>
            <Field label="Matrícula TC"><Input value={v.tractor_plate ?? ''} onChange={(e) => setV((x) => ({ ...x, tractor_plate: e.target.value.toUpperCase() }))} /></Field>
            <Field label="Piloto"><Input value={v.driver_name ?? ''} onChange={set('driver_name')} /></Field>
            <Field label="DPI"><Input value={v.driver_dpi ?? ''} inputMode="numeric" onChange={set('driver_dpi')} /></Field>
            <Field label="Báscula"><Select value={v.scale_id} onChange={set('scale_id')}>{scales.data?.map((s) => <option key={s.scale_id} value={s.scale_id}>{s.scale.name}</option>)}</Select></Field>
            <Field label="Bodega y producto" className="sm:col-span-2">
              <Select value={`${v.service_hold_id}|${v.product_id}`} onChange={(e) => { const [h, p] = e.target.value.split('|'); setV((x) => ({ ...x, service_hold_id: h, product_id: p })); }}>
                {holds.data?.sort((a, b) => a.hold.hold_number - b.hold.hold_number).map((h) => <option key={`${h.service_hold_id}|${h.product_id}`} value={`${h.service_hold_id}|${h.product_id}`}>Bodega {h.hold.hold_number} · {h.product.name}</option>)}
              </Select>
            </Field>
            <div />
            <Field label="Peso bruto (kg)"><Input type="number" className="num text-right" value={v.gross_kg ?? ''} onChange={set('gross_kg')} /></Field>
            <Field label="Tara (kg)"><Input type="number" className="num text-right" value={v.tare_kg ?? ''} onChange={set('tare_kg')} /></Field>
            <Field label="Peso neto"><div className={`num flex min-h-[40px] items-center rounded-lg bg-panel px-3 font-bold ${net > 0 ? '' : 'text-red'}`}>{net > 0 ? `${fmt2(net)} TM` : 'Bruto ≤ tara'}</div></Field>
            <Field label="Hora de inicio"><Input type="datetime-local" value={v.started_local ?? ''} onChange={set('started_local')} /></Field>
            <Field label="Hora final"><Input type="datetime-local" value={v.ended_local ?? ''} onChange={set('ended_local')} /></Field>
            <Field label="Notas"><Input value={v.notes ?? ''} onChange={set('notes')} /></Field>
          </div>
        )}
        {mode === 'update' && target.type === 'downtime_event' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Evento"><Select value={v.cause_id} onChange={set('cause_id')}>{causes.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="Alcance"><Select value={v.scope} onChange={set('scope')}>{Object.entries(SCOPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
            {v.scope === 'hold' && <Field label="Bodega"><Select value={v.service_hold_id} onChange={set('service_hold_id')}><option value="">Seleccione…</option>{[...new Map((holds.data ?? []).map((h) => [h.service_hold_id, h.hold.hold_number])).entries()].map(([id, n]) => <option key={id} value={id}>Bodega {n}</option>)}</Select></Field>}
            {v.scope === 'scale' && <Field label="Báscula"><Select value={v.scale_id} onChange={set('scale_id')}><option value="">Seleccione…</option>{scales.data?.map((s) => <option key={s.scale_id} value={s.scale_id}>{s.scale.name}</option>)}</Select></Field>}
            <Field label="Inicio"><Input type="datetime-local" value={v.started_local ?? ''} onChange={set('started_local')} /></Field>
            <Field label="Final"><Input type="datetime-local" value={v.ended_local ?? ''} onChange={set('ended_local')} /></Field>
            <Field label="Observaciones" className="sm:col-span-2"><Textarea value={v.observations ?? ''} onChange={set('observations')} /></Field>
          </div>
        )}
        {mode === 'update' && Object.keys(changes).length > 0 && (
          <div className="rounded-lg bg-panel p-3 text-[13.5px]">
            <div className="mb-1 font-semibold">Cambios</div>
            {Object.entries(changes).map(([k, x]) => <div key={k}><span className="text-mute">{FIELD_LABEL[k] ?? k}:</span> {initial[k] || '—'} → <b>{x ?? '—'}</b></div>)}
          </div>
        )}
        {mode === 'void' && target.type === 'weigh_ticket' && <p className="text-[14px]">El ticket {target.row.ticket_number} ({fmt2(target.row.net_tm)} TM, {dt(target.row.ended_at, tz)}) quedará anulado y su neto se devolverá al saldo de la bodega. El registro no se elimina.</p>}
        <Field label="Motivo de la corrección" required hint="Queda en el historial y la auditoría.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: tara repesada, matrícula mal digitada…" />
        </Field>
        {err && <ErrorBox error={err} />}
      </div>
    </Modal>
  );
}

/** Historial de modificaciones de un registro (valor anterior y nuevo). */
export function RecordHistory({ targetId, tz }: { targetId: string; tz: string }) {
  const q = useQuery({ queryKey: ['history', targetId], queryFn: async () => unwrap(await supabase.from('correction_history').select('id, field, old_value, new_value, reason, applied_by_name, applied_at, revision_to').eq('target_id', targetId).order('applied_at', { ascending: false })) as { id: number; field: string; old_value: string | null; new_value: string | null; reason: string; applied_by_name: string | null; applied_at: string; revision_to: number }[] });
  if (!q.data?.length) return <p className="text-[14px] text-mute">Sin modificaciones: es el registro original.</p>;
  return (
    <ol className="grid gap-2">
      {q.data.map((h) => (
        <li key={h.id} className="rounded-lg border border-line px-3 py-2 text-[13.5px]">
          <div><b>{FIELD_LABEL[h.field] ?? h.field}</b>: <span className="text-mute line-through">{h.old_value ?? '—'}</span> → <b>{h.new_value ?? '—'}</b></div>
          <div className="text-mute">{h.reason} · {h.applied_by_name} · {dt(h.applied_at, tz)} · revisión {h.revision_to}</div>
        </li>
      ))}
    </ol>
  );
}
