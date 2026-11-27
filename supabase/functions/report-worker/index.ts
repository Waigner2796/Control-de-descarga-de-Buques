/**
 * report-worker · Genera la versión BORRADOR (pendiente de firma) del informe final.
 * Idempotente: los trabajos se reclaman con bloqueo (FOR UPDATE SKIP LOCKED) y cada
 * revisión de datos del servicio tiene un único trabajo; reintentos no duplican versiones.
 * Lo invoca el frontend tras finalizar/corregir y puede invocarlo un cron con service_role.
 * Cuerpo: { job_id?: uuid }  (sin job_id procesa el siguiente trabajo pendiente)
 */
import * as PDFLib from 'pdf-lib';
import { buildReportPdf, newVerificationCode } from '../_shared/report-pdf.ts';
import { download, handle, HttpError, isServiceRole, json, requirePermission, requireUser, serviceClient } from '../_shared/http.ts';

Deno.serve(handle(async (req) => {
  const body = await req.json().catch(() => ({}));
  const svc = serviceClient();
  const jobId: string | null = body.job_id ?? null;

  if (!isServiceRole(req)) {
    await requireUser(req);
    if (!jobId) throw new HttpError(400, 'Indique el trabajo a procesar');
    const { data: j } = await svc.from('report_jobs').select('organization_id').eq('id', jobId).maybeSingle();
    if (!j) throw new HttpError(404, 'Trabajo inexistente');
    // Cualquier miembro con acceso a servicios puede disparar el procesamiento: el contenido
    // lo determina el estado de la base de datos, no quien lo invoca.
    await requirePermission(req, j.organization_id, 'services.view');
  }

  const { data: claimed, error: ce } = await svc.rpc('worker_claim_report_job', { p_job: jobId });
  if (ce) throw new HttpError(500, ce.message);
  const job = (claimed as Record<string, string>[] | null)?.[0];
  if (!job) {
    const { data: cur } = jobId ? await svc.from('report_jobs').select('status, result_version_id, last_error').eq('id', jobId).maybeSingle() : { data: null };
    return json(req, { status: cur?.status ?? 'idle', version_id: cur?.result_version_id ?? null, error: cur?.last_error ?? null });
  }

  try {
    const { data: payload, error: pe } = await svc.rpc('worker_report_payload', { p_service: job.service_id });
    if (pe) throw new Error(pe.message);
    const p = payload as Record<string, any>;
    const { data: last } = await svc.from('report_versions').select('version').eq('report_id', job.report_id).order('version', { ascending: false }).limit(1);
    const version = (last?.[0]?.version ?? 0) + 1;
    const code = newVerificationCode();
    const prev = p.previous_version as { version: number } | null;
    const changeSummary = prev ? `Esta versión ${version} sustituye a la versión ${prev.version} por correcciones o reapertura autorizada (revisión de datos ${job.data_revision}).` : null;
    const [orgLogo, customerLogo] = await Promise.all([download('org-assets', p.organization?.logo_path), download('org-assets', p.customer?.logo_path)]);
    const pdf = await buildReportPdf(PDFLib, p, { orgLogo, customerLogo }, {
      mode: 'draft', version, verificationCode: code, changeSummary, verifyUrl: Deno.env.get('PUBLIC_VERIFY_URL') ?? undefined,
    });
    const path = `${job.organization_id}/${p.service.customer_id}/${job.service_id}/${job.report_id}/v${version}-borrador-${code}.pdf`;
    const { error: ue } = await svc.storage.from('reports').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
    if (ue) throw new Error(`Storage: ${ue.message}`);
    const { data: vid, error: re } = await svc.rpc('worker_record_draft', { p_job: job.id, p_draft_path: path, p_verification_code: code, p_change_summary: changeSummary });
    if (re) throw new Error(re.message);
    return json(req, { status: 'done', version_id: vid, version });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await svc.rpc('worker_fail_report_job', { p_job: job.id, p_error: msg });
    throw new HttpError(500, `No se pudo generar el informe: ${msg}`);
  }
}));
