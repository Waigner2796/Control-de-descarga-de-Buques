import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Building2, Eye, Pencil, Plus } from 'lucide-react';
import { useAuth, useOrg } from '@/lib/auth';
import { supabase, unwrap } from '@/lib/supabase';
import { useUrlState } from '@/lib/hooks';
import { date, fmt0 } from '@/lib/format';
import { ACTIVE } from '@/lib/labels';
import { Button, DataTable, EmptyState, ErrorBox, FilterBar, PageHeader, Pagination, SearchInput, Select, StatusBadge, type Column } from '@/components/ui';
import { CustomerForm, type CustomerRow } from './CustomerForm';

type Row = { id: string; code: string; trade_name: string; legal_name: string | null; status: string; services_total: number; services_active: number; services_finalized: number; last_operation_at: string | null; discharged_tm: number };

export default function Customers() {
  const { orgId } = useOrg();
  const { can } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useUrlState({ q: '', status: '', sort: 'trade_name', dir: 'asc', page: '1', size: '25' });
  const page = Number(f.page) || 1, size = Number(f.size) || 25;
  const [form, setForm] = useState<{ open: boolean; row?: CustomerRow | null }>({ open: false });

  const q = useQuery({
    queryKey: ['customers', orgId, f], placeholderData: keepPreviousData,
    queryFn: async () => {
      let query = supabase.from('customer_portfolio').select('id, code, trade_name, legal_name, status, services_total, services_active, services_finalized, last_operation_at, discharged_tm', { count: 'exact' })
        .eq('organization_id', orgId);
      if (f.q) query = query.or(`trade_name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,code.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,legal_name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%`);
      if (f.status) query = query.eq('status', f.status);
      query = query.order(f.sort, { ascending: f.dir === 'asc', nullsFirst: false }).order('id').range((page - 1) * size, page * size - 1);
      const r = await query;
      return { rows: unwrap(r) as Row[], count: r.count ?? 0 };
    },
  });
  const onSort = (k: string) => setF({ sort: k, dir: f.sort === k && f.dir === 'asc' ? 'desc' : 'asc' });
  const edit = async (id: string) => setForm({ open: true, row: unwrap(await supabase.from('customers').select('*').eq('id', id).single()) as CustomerRow });

  const cols: Column<Row>[] = [
    { key: 'code', header: 'Código', sortKey: 'code', cell: (r) => <span className="num font-semibold">{r.code}</span> },
    { key: 'name', header: 'Cliente', sortKey: 'trade_name', cell: (r) => <div className="min-w-[180px]"><b>{r.trade_name}</b>{r.legal_name && <div className="text-[13px] text-mute">{r.legal_name}</div>}</div> },
    { key: 'total', header: 'Operaciones', sortKey: 'services_total', align: 'right', cell: (r) => fmt0(r.services_total) },
    { key: 'active', header: 'Activas', sortKey: 'services_active', align: 'right', cell: (r) => (r.services_active ? <b className="text-ok">{fmt0(r.services_active)}</b> : '0') },
    { key: 'fin', header: 'Finalizadas', sortKey: 'services_finalized', align: 'right', hideBelow: 'md', cell: (r) => fmt0(r.services_finalized) },
    { key: 'last', header: 'Última operación', sortKey: 'last_operation_at', hideBelow: 'md', cell: (r) => date(r.last_operation_at) },
    { key: 'tm', header: 'Tonelaje movilizado', sortKey: 'discharged_tm', align: 'right', cell: (r) => `${fmt0(r.discharged_tm)} TM` },
    { key: 'status', header: 'Estado', sortKey: 'status', cell: (r) => <StatusBadge map={ACTIVE} value={r.status} /> },
    { key: 'act', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (r) => (
      <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="ghost" icon={<Eye className="h-4 w-4" />} onClick={() => nav(`/app/clientes/${r.id}`)}>Expediente</Button>
        {can('customers.manage') && <Button size="sm" variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => edit(r.id)} aria-label={`Editar ${r.trade_name}`} />}
      </div>
    ) },
  ];

  return (
    <div>
      <PageHeader title="Cartera de clientes" sub="Expedientes, operaciones y tonelaje movilizado por cliente."
        actions={can('customers.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true, row: null })}>Nuevo cliente</Button>} />
      <FilterBar>
        <SearchInput value={f.q} onChange={(q2) => setF({ q: q2 })} placeholder="Buscar por nombre, código o razón social" className="lg:min-w-[320px]" />
        <Select aria-label="Estado" value={f.status} onChange={(e) => setF({ status: e.target.value })}><option value="">Todos los estados</option><option value="active">Activos</option><option value="inactive">Inactivos</option></Select>
      </FilterBar>
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      <DataTable columns={cols} rows={q.data?.rows} rowKey={(r) => r.id} loading={q.isFetching} sort={{ key: f.sort, asc: f.dir === 'asc' }} onSort={onSort}
        onRowClick={(r) => nav(`/app/clientes/${r.id}`)}
        empty={f.q || f.status ? undefined : <EmptyState icon={<Building2 className="h-8 w-8" />} title="Aún no hay clientes" action={can('customers.manage') && <Button variant="primary" onClick={() => setForm({ open: true })}>Crear el primer cliente</Button>}>Cada cliente tiene un expediente con sus operaciones, reportes, documentos y usuarios del portal.</EmptyState>} />
      <Pagination page={page} pageSize={size} total={q.data?.count ?? 0} onPage={(p) => setF({ page: String(p) }, false)} onPageSize={(s) => setF({ size: String(s) })} />
      <CustomerForm open={form.open} onClose={() => setForm({ open: false })} orgId={orgId} customer={form.row} onSaved={(id) => !form.row && nav(`/app/clientes/${id}`)} />
    </div>
  );
}
