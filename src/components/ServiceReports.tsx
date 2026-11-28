import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, PenTool, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { callFunction, rpc, supabase, unwrap } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { dt, fileSize } from '@/lib/format';
import { REPORT_STATUS, VERSION_STATUS } from '@/lib/labels';
import { exportServiceReport } from '@/lib/excel/exports';
import { Badge, Button, DataTable, EmptyState, ErrorBox, Field, Modal, Notice, Select, StatusBadge, Textarea, useToast, type Column } from '@/components/ui';
import { ReportButtons } from './ReportLinks';

type Version = { id: string; version: number; status: string; verification_code: string; sha256: string | null; size_bytes: number | null; generated_at: string; signed_at: string | null; signer_name: string | null; signer_position: string | null; storage_path: string | null; draft_path: string | null; superseded_at: string | null; supersede_reason: string | null; change_summary: string | null; published_at: string | null };
type Job = { id: string; status: string; attempts: number; last_error: string | null; created_at: string; data_revision: number };

export function ServiceReports({ service }: { service: { id: string; service_number: string; status: string; organization_id: string; timezone: string } }) {
  const { can, ctx } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const report = useQuery({ queryKey: ['gen-report', service.id], queryFn: async () => unwrap(await supabase.from('generated_reports').select('id, status, conclusions, current_version_id').eq('service_id', service.id).maybeSingle()) as { id: string; status: string; conclusions: string; current_version_id: string | null } | null });
  const versions = useQuery({ queryKey: ['versions', service.id], queryFn: async () => unwrap(await supabase.from('report_versions').select('*').eq('service_id', service.id).order('version', { ascending: false })) as Version[] });
  const jobs = useQuery({ queryKey: ['jobs', service.id], queryFn: async () => unwrap(await supabase.from('report_jobs').select('id, status, attempts, last_error, created_at, data_revision').eq('service_id', service.id).order('created_at', { ascending: false }).limit(5)) as Job[] });
  const signer = useQuery({ queryKey: ['me-signer', service.organization_id, ctx?.user_id], enabled: can('reports.sign'), queryFn: async () => unwrap(await supabase.from('authorized_signers').select('id, full_name, position, signature_path').eq('organization_id', service.organization_id).eq('user_id', ctx!.user_id).eq('status', 'active').maybeSingle()) as { id: string; full_name: string; position: string; signature_path: string | null } | null });
  const seals = useQuery({ queryKey: ['seals', service.organization_id], enabled: can('reports.sign'), queryFn: async () => unwrap(await supabase.from('company_seals').select('id, name, is_default').eq('organization_id', service.organization_id).eq('status', 'active')) as { id: string; name: string; is_default: boolean }[] });
  useRealtime('report_versions', `service_id=eq.${service.id}`, [['versions', service.id], ['gen-report', service.id], ['jobs', service.id]]);
  const refresh = () => ['versions', 'gen-report', 'jobs'].forEach((k) => qc.invalidateQueries({ queryKey: [k, service.id] }));
  const [busy, setBusy] = useState<string | null>(null);
  const [sign, setSign] = useState<Version | null>(null);
  const [seal, setSeal] = useState('');
  const [concl, setConcl] = useState('');
  useEffect(() => setConcl(report.data?.conclusions ?? ''), [report.data?.conclusions]);
  useEffect(() => setSeal(seals.data?.find((s) => s.is_default)?.id ?? ''), [seals.data]);

  const pendingJob = jobs.data?.find((j) => j.status === 'queued' || j.status === 'processing' || (j.status === 'failed' && j.attempts < 5));
  const process = async (jobId?: string) => {
    setBusy('gen');
    try {
      const id = jobId ?? await rpc<string>('retry_report_job', { p_service: service.id });
      const r = await callFunction<{ status: string; version?: number }>('report-worker', { job_id: id });
      toast(r.version ? `Versión ${r.version} generada: pendiente de firma` : `Estado del trabajo: ${r.status}`, r.version ? 'ok' : 'info');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(null); refresh(); }
  };
  const doSign = async () => {
    if (!sign) return;
    setBusy('sign');
    try {
      const r = await callFunction<{ version: number; sha256: string }>('report-sign', { version_id: sign.id, seal_id: seal || undefined });
      toast(`Versión ${r.version} firmada y publicada en el portal del cliente`);
      setSign(null);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(null); refresh(); }
  };
  const saveConclusions = async () => {
    if (!report.data) return;
    unwrap(await supabase.from('generated_reports').update({ conclusions: concl }).eq('id', report.data.id));
    toast('Conclusiones guardadas; se usarán en la próxima versión generada');
  };

  const cols: Column<Version>[] = [
    { key: 'v', header: 'Versión', cell: (v) => <b className="num">v{v.version}</b> },
    { key: 's', header: 'Estado', cell: (v) => <StatusBadge map={VERSION_STATUS} value={v.status} /> },
    { key: 'g', header: 'Generada', hideBelow: 'md', cell: (v) => dt(v.generated_at, service.timezone) },
    { key: 'f', header: 'Firma', cell: (v) => (v.signed_at ? <span className="text-[13.5px]">{v.signer_name}<span className="block text-mute">{dt(v.signed_at, service.timezone)}</span></span> : '—') },
    { key: 'c', header: 'Verificación', hideBelow: 'lg', cell: (v) => <span className="text-[12.5px]"><code className="num">{v.verification_code}</code>{v.sha256 && <span className="block truncate text-mute" title={v.sha256}>SHA-256 {v.sha256.slice(0, 16)}…</span>}</span> },
    { key: 'z', header: 'Tamaño', hideBelow: 'lg', align: 'right', cell: (v) => fileSize(v.size_bytes) },
    { key: 'a', header: <span className="sr-only">Acciones</span>, align: 'right', cell: (v) => (
      <div className="flex flex-wrap justify-end gap-1">
        <ReportButtons compact path={v.storage_path ?? v.draft_path} filename={`Informe-${service.service_number}-v${v.version}.pdf`} />
        {v.status === 'pending_signature' && signer.data && <Button size="sm" variant="primary" icon={<PenTool className="h-4 w-4" />} onClick={() => setSign(v)}>Firmar</Button>}
      </div>
    ) },
  ];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {report.data ? <StatusBadge map={REPORT_STATUS} value={report.data.status} /> : <Badge>Sin informe</Badge>}
        {service.status !== 'finalized' && <span className="text-[14px] text-mute">El informe final se genera automáticamente al finalizar el servicio.</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button icon={<FileSpreadsheet className="h-4 w-4" />} onClick={() => exportServiceReport(service.id).catch((e) => toast(String(e.message), 'bad'))}>Excel del servicio</Button>
          {service.status === 'finalized' && can('reports.generate') && (pendingJob || ['failed', 'generating', 'revision_pending'].includes(report.data?.status ?? '') || !report.data) && <Button icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'gen'} onClick={() => process(pendingJob?.id)}>{pendingJob ? 'Procesar generación pendiente' : 'Regenerar borrador'}</Button>}
        </div>
      </div>
      {pendingJob && <Notice tone={pendingJob.status === 'failed' ? 'warn' : 'info'}>{pendingJob.status === 'failed' ? `La generación falló (intento ${pendingJob.attempts} de 5): ${pendingJob.last_error}. Puede reintentar.` : 'Hay una generación de informe en cola o en proceso. Si no avanza, use «Procesar generación pendiente».'}</Notice>}
      {can('reports.sign') && !signer.data && signer.isFetched && <Notice tone="warn">Su usuario tiene permiso de firma pero no está configurado como firmante autorizado (Firma y sello).</Notice>}
      <ErrorBox error={versions.error} />
      <DataTable columns={cols} rows={versions.data} rowKey={(v) => v.id} loading={versions.isLoading} rowClassName={(v) => (['superseded', 'discarded'].includes(v.status) ? 'opacity-70' : undefined)}
        empty={<EmptyState icon={<ShieldCheck className="h-8 w-8" />} title="Aún no hay versiones">Al finalizar el servicio se genera un borrador; un firmante autorizado lo firma y se publica en el portal del cliente.</EmptyState>} />
      {versions.data?.some((v) => v.supersede_reason) && (
        <ul className="grid gap-1 text-[13.5px] text-mute">{versions.data.filter((v) => v.supersede_reason).map((v) => <li key={v.id}>v{v.version}: {v.supersede_reason}</li>)}</ul>
      )}
      {report.data && can('reports.generate') && (
        <Field label="Conclusiones del informe (sección 8)" hint="Se incorporan al generar la próxima versión.">
          <Textarea rows={4} value={concl} onChange={(e) => setConcl(e.target.value)} />
          <div><Button size="sm" onClick={saveConclusions}>Guardar conclusiones</Button></div>
        </Field>
      )}
      <Modal open={!!sign} onClose={() => setSign(null)} title={`Firmar versión ${sign?.version ?? ''}`}
        footer={<><Button onClick={() => setSign(null)}>Cancelar</Button><Button variant="primary" loading={busy === 'sign'} icon={<PenTool className="h-4 w-4" />} onClick={doSign}>Firmar y publicar</Button></>}>
        <div className="grid gap-4 text-[14px]">
          <p>Revise el borrador antes de firmar. Al firmar se incorporan su firma gráfica y el sello, se registra la fecha y hora, se calcula el hash SHA-256 del PDF y el documento queda inmutable y publicado en el portal del cliente.</p>
          {sign?.draft_path && <ReportButtons path={sign.draft_path} filename={`Borrador-${service.service_number}-v${sign.version}.pdf`} />}
          <div className="rounded-lg bg-panel p-3"><div className="text-mute">Firmante</div><b>{signer.data?.full_name}</b> · {signer.data?.position}{!signer.data?.signature_path && <div className="mt-1 text-warn">Sin imagen de firma configurada: se imprimirá solo nombre y cargo.</div>}</div>
          <Field label="Sello"><Select value={seal} onChange={(e) => setSeal(e.target.value)}><option value="">Sin sello</option>{seals.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Notice tone="warn">Es una firma gráfica con sello y hash de integridad; no es una firma electrónica certificada. Si requiere validez jurídica formal, integre un proveedor certificado.</Notice>
        </div>
      </Modal>
    </div>
  );
}
