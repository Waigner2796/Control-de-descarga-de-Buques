import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useTerminals, useUrlState } from '@/lib/hooks';
import { DEFAULT_TZ, addDays, dt, localDayStartIso } from '@/lib/format';
import { AUDIT_ACTION, AUDIT_TABLE } from '@/lib/labels';
import { Button, DataTable, FilterBar, Input, Modal, PageHeader, Pagination, SearchInput, Select, type Column } from '@/components/ui';

type Log = { id: number; table_name: string; record_id: string | null; action: string; actor_name: string | null; reason: string | null; changed_fields: string[] | null; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null; created_at: string };

export default function Audit() {
  const { orgId } = useOrg();
  const terminals = useTerminals(orgId);
  const tz = terminals.data?.[0]?.timezone ?? DEFAULT_TZ;
  const [f, setF] = useUrlState({ table: '', action: '', actor: '', from: '', to: '', page: '1', size: '50' });
  const page = Number(f.page) || 1, size = Number(f.size) || 50;
  const q = useQuery({
    queryKey: ['audit', orgId, f], placeholderData: keepPreviousData,
    queryFn: async () => {
      let qq = supabase.from('audit_logs').select('id, table_name, record_id, action, actor_name, reason, changed_fields, old_data, new_data, created_at', { count: 'exact' }).eq('organization_id', orgId);
      if (f.table) qq = qq.eq('table_name', f.table);
      if (f.action) qq = qq.eq('action', f.action);
      if (f.actor) qq = qq.ilike('actor_name', `%${f.actor.replace(/[%_]/g, '')}%`);
      if (f.from) qq = qq.gte('created_at', localDayStartIso(f.from, tz));
      if (f.to) qq = qq.lt('created_at', localDayStartIso(addDays(f.to, 1), tz));
      const r = await qq.order('created_at', { ascending: false }).order('id', { ascending: false }).range((page - 1) * size, page * size - 1);
      return { rows: unwrap(r) as Log[], count: r.count ?? 0 };
    },
  });
  const [sel, setSel] = useState<Log | null>(null);
  const cols: Column<Log>[] = [
    { key: 'd', header: 'Fecha y hora', cell: (l) => <span className="num whitespace-nowrap">{dt(l.created_at, tz, true)}</span> },
    { key: 'u', header: 'Usuario', cell: (l) => l.actor_name ?? 'sistema' },
    { key: 'a', header: 'Acción', cell: (l) => AUDIT_ACTION[l.action] ?? l.action },
    { key: 't', header: 'Registro', cell: (l) => AUDIT_TABLE[l.table_name] ?? l.table_name },
    { key: 'c', header: 'Campos', hideBelow: 'md', cell: (l) => <span className="text-[13px] text-mute">{(l.changed_fields ?? []).slice(0, 5).join(', ')}{(l.changed_fields?.length ?? 0) > 5 ? '…' : ''}</span> },
    { key: 'r', header: 'Motivo', wrap: true, cell: (l) => <span className="text-[13.5px]">{l.reason ?? '—'}</span> },
    { key: 'x', header: <span className="sr-only">Detalle</span>, align: 'right', cell: (l) => <Button size="sm" variant="ghost" onClick={() => setSel(l)}>Detalle</Button> },
  ];
  return (
    <div>
      <PageHeader title="Historial y auditoría" sub="Registro inmutable de cambios: quién, cuándo, qué cambió (valor anterior y nuevo) y por qué." />
      <FilterBar>
        <Select aria-label="Registro" value={f.table} onChange={(e) => setF({ table: e.target.value })}><option value="">Todos los registros</option>{Object.entries(AUDIT_TABLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label="Acción" value={f.action} onChange={(e) => setF({ action: e.target.value })}><option value="">Todas las acciones</option>{Object.entries(AUDIT_ACTION).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <SearchInput value={f.actor} onChange={(v) => setF({ actor: v })} placeholder="Usuario" />
        <Input type="date" aria-label="Desde" value={f.from} onChange={(e) => setF({ from: e.target.value })} />
        <Input type="date" aria-label="Hasta" value={f.to} onChange={(e) => setF({ to: e.target.value })} />
      </FilterBar>
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(l) => String(l.id)} loading={q.isFetching} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} sizes={[25, 50, 100]} />
      <Modal wide open={!!sel} onClose={() => setSel(null)} title={sel ? `${AUDIT_ACTION[sel.action] ?? sel.action} · ${AUDIT_TABLE[sel.table_name] ?? sel.table_name}` : ''}>
        {sel && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="text-left text-mute"><tr><th className="py-1 pr-3">Campo</th><th className="py-1 pr-3">Anterior</th><th className="py-1">Nuevo</th></tr></thead>
              <tbody>{[...new Set([...Object.keys(sel.old_data ?? {}), ...Object.keys(sel.new_data ?? {})])].filter((k) => !sel.changed_fields || sel.changed_fields.includes(k) || sel.action !== 'UPDATE').map((k) => (
                <tr key={k} className="border-t border-line align-top"><td className="py-1 pr-3 font-medium">{k}</td><td className="max-w-[260px] break-words py-1 pr-3 text-mute">{JSON.stringify(sel.old_data?.[k] ?? null)}</td><td className="max-w-[260px] break-words py-1">{JSON.stringify(sel.new_data?.[k] ?? null)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
