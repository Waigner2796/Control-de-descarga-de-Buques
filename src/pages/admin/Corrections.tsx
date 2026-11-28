import { useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { rpc, supabase, unwrap } from '@/lib/supabase';
import { useRealtime, useUrlState } from '@/lib/hooks';
import { dt } from '@/lib/format';
import { CORRECTION_STATUS, FIELD_LABEL } from '@/lib/labels';
import { Button, DataTable, EmptyState, FilterBar, PageHeader, Pagination, ReasonDialog, Select, StatusBadge, useToast, type Column } from '@/components/ui';
import { callFunction } from '@/lib/supabase';

type Req = { id: string; service_id: string; target_type: string; target_id: string; action: string; changes: Record<string, unknown>; previous_values: Record<string, unknown>; reason: string; status: string;
  requested_by: string; requested_by_name: string | null; requested_at: string; reviewed_by_name: string | null; reviewed_at: string | null; review_note: string | null; service: { service_number: string } | null };

export default function Corrections() {
  const { orgId } = useOrg();
  const { can, ctx } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useUrlState({ st: 'pending', page: '1', size: '25' });
  const page = Number(f.page) || 1, size = Number(f.size) || 25;
  const q = useQuery({
    queryKey: ['corrections', orgId, f], placeholderData: keepPreviousData,
    queryFn: async () => {
      let qq = supabase.from('correction_requests').select('*, service:services(service_number)', { count: 'exact' }).eq('organization_id', orgId);
      if (f.st) qq = qq.eq('status', f.st);
      const r = await qq.order('requested_at', { ascending: false }).range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as unknown as Req[], count: r.count ?? 0 };
    },
  });
  useRealtime('correction_requests', `organization_id=eq.${orgId}`, [['corrections', orgId], ['corrections-pending-count']]);
  const [reject, setReject] = useState<Req | null>(null);
  const approve = async (r: Req) => {
    try {
      const res = await rpc<{ result?: { job_id?: string } }>('review_correction', { p_request: r.id, p_approve: true, p_note: null });
      if (res.result?.job_id) callFunction('report-worker', { job_id: res.result.job_id }).catch(() => undefined);
      toast('Corrección aplicada; el tonelaje y la productividad se recalcularon'); qc.invalidateQueries();
    } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const fmtV = (v: unknown) => (v == null || v === '' ? '—' : String(v));
  const cols: Column<Req>[] = [
    { key: 'd', header: 'Solicitada', cell: (r) => <span className="text-[13.5px]">{dt(r.requested_at)}<span className="block text-mute">{r.requested_by_name}</span></span> },
    { key: 's', header: 'Servicio', cell: (r) => <span className="num font-semibold">{r.service?.service_number}</span> },
    { key: 't', header: 'Registro', cell: (r) => (r.target_type === 'weigh_ticket' ? 'Pesaje' : 'Tiempo perdido') },
    { key: 'c', header: 'Cambio', wrap: true, cell: (r) => r.action === 'void' ? <b className="text-red">Anular registro</b> : (
      <ul className="text-[13.5px]">{Object.entries(r.changes).map(([k, v]) => <li key={k}><span className="text-mute">{FIELD_LABEL[k] ?? k}:</span> {fmtV(r.previous_values?.[k])} → <b>{fmtV(v)}</b></li>)}</ul>
    ) },
    { key: 'm', header: 'Motivo', wrap: true, cell: (r) => <span className="text-[13.5px]">{r.reason}</span> },
    { key: 'st', header: 'Estado', cell: (r) => <div><StatusBadge map={CORRECTION_STATUS} value={r.status} />{r.reviewed_by_name && <span className="mt-0.5 block text-[12.5px] text-mute">{r.reviewed_by_name}{r.review_note ? ` · ${r.review_note}` : ''}</span>}</div> },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (r) => r.status === 'pending' && (
      <div className="flex justify-end gap-1">
        {can('corrections.approve') && r.requested_by !== ctx?.user_id && <>
          <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} onClick={() => approve(r)}>Aprobar</Button>
          <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => setReject(r)}>Rechazar</Button>
        </>}
        {r.requested_by === ctx?.user_id && <Button size="sm" variant="ghost" onClick={async () => { await rpc('cancel_correction', { p_request: r.id }).catch((e) => toast(e.message, 'bad')); qc.invalidateQueries({ queryKey: ['corrections'] }); }}>Cancelar</Button>}
      </div>
    ) },
  ];
  return (
    <div>
      <PageHeader title="Correcciones" sub="Solicitudes y aprobaciones de correcciones a pesajes y tiempos perdidos. Nada se elimina: se conserva el original, el cambio, el motivo y quién lo autorizó." />
      <FilterBar>
        <Select aria-label="Estado" value={f.st} onChange={(e) => setF({ st: e.target.value })}><option value="">Todas</option>{Object.entries(CORRECTION_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
      </FilterBar>
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} empty={<EmptyState title={f.st === 'pending' ? 'No hay correcciones pendientes' : 'Sin solicitudes'}>Las correcciones se solicitan desde la tabla de ciclos o de tiempos perdidos con el botón de lápiz.</EmptyState>} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} />
      <ReasonDialog open={!!reject} onClose={() => setReject(null)} title="Rechazar corrección" danger confirmLabel="Rechazar" minLength={4}
        onConfirm={async (note) => { await rpc('review_correction', { p_request: reject!.id, p_approve: false, p_note: note }); toast('Solicitud rechazada'); qc.invalidateQueries({ queryKey: ['corrections'] }); }} />
    </div>
  );
}
