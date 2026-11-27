import { useQuery } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { signedUrl, supabase, unwrap } from '@/lib/supabase';
import { dt, fileSize } from '@/lib/format';
import { Button, DataTable, EmptyState, PageHeader, useToast } from '@/components/ui';
import { NoAccess } from '@/pages/auth/AuthPages';

type Doc = { id: string; title: string; category: string; storage_path: string; size_bytes: number | null; created_at: string };

export default function PortalDocuments() {
  const { customerLink } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['portal-docs', customerLink?.customer_id], enabled: !!customerLink?.can_view_documents,
    queryFn: async () => unwrap(await supabase.from('customer_documents').select('id, title, category, storage_path, size_bytes, created_at').eq('customer_id', customerLink!.customer_id).order('created_at', { ascending: false })) as Doc[] });
  if (!customerLink?.can_view_documents) return <NoAccess inline />;
  const open = async (d: Doc) => { try { window.open(await signedUrl('customer-documents', d.storage_path, 120), '_blank', 'noopener'); } catch (e) { toast((e as Error).message, 'bad'); } };
  return (
    <div>
      <PageHeader title="Mis documentos" sub="Documentos que su proveedor compartió con usted." />
      <DataTable rows={q.data} rowKey={(d) => d.id} loading={q.isLoading} columns={[
        { key: 't', header: 'Documento', cell: (d) => <b>{d.title}</b> }, { key: 'c', header: 'Categoría', cell: (d) => d.category },
        { key: 'f', header: 'Fecha', cell: (d) => dt(d.created_at) }, { key: 's', header: 'Tamaño', align: 'right', cell: (d) => fileSize(d.size_bytes) },
        { key: 'a', header: <span className="sr-only">Abrir</span>, align: 'right', cell: (d) => <Button size="sm" variant="portal" onClick={() => open(d)}>Abrir</Button> },
      ]} empty={<EmptyState icon={<FolderOpen className="h-8 w-8" />} title="Sin documentos compartidos" />} />
    </div>
  );
}
