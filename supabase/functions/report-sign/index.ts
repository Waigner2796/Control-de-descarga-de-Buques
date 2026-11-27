/**
 * report-sign · Firma y sella la versión pendiente del informe final.
 * 1. Verifica identidad (JWT validado contra Auth), permiso reports.sign y que el
 *    usuario sea un firmante autorizado activo de la empresa.
 * 2. Regenera el PDF con firma gráfica, sello, fecha/hora de emisión y código.
 * 3. Calcula SHA-256, guarda el archivo inmutable (sin sobrescritura) en Storage privado.
 * 4. Registra firma, sustituye la versión anterior, publica en el portal y notifica.
 * Cuerpo: { version_id: uuid, seal_id?: uuid }
 */
import * as PDFLib from 'pdf-lib';
import { buildReportPdf, sha256Hex } from '../_shared/report-pdf.ts';
import { download, handle, HttpError, json, requirePermission, requireUser, serviceClient } from '../_shared/http.ts';

async function sendEmails(to: string[], subject: string, html: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('NOTIFY_FROM_EMAIL');
  if (!key || !from || !to.length) return { sent: 0, skipped: true };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html }),
  });
  return { sent: r.ok ? to.length : 0, skipped: false };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));
  const svc = serviceClient();
  const versionId = String(body.version_id ?? '');

  const { data: v } = await svc.from('report_versions').select('*').eq('id', versionId).maybeSingle();
  if (!v) throw new HttpError(404, 'Versión inexistente');
  await requirePermission(req, v.organization_id, 'reports.sign');
  if (v.status !== 'pending_signature') throw new HttpError(409, 'La versión no está pendiente de firma');

  const { data: signer } = await svc.from('authorized_signers').select('*').eq('organization_id', v.organization_id).eq('user_id', user.id).eq('status', 'active').maybeSingle();
  if (!signer) throw new HttpError(403, 'Su usuario no está configurado como firmante autorizado');

  let sealQ = svc.from('company_seals').select('*').eq('organization_id', v.organization_id).eq('status', 'active');
  sealQ = body.seal_id ? sealQ.eq('id', body.seal_id) : sealQ.eq('is_default', true);
  const { data: seal } = await sealQ.maybeSingle();

  const { data: payload, error: pe } = await svc.rpc('worker_report_payload', { p_service: v.service_id });
  if (pe) throw new HttpError(500, pe.message);
  const p = payload as Record<string, any>;
  if (Number(p.service?.data_revision) !== Number(v.data_revision)) {
    throw new HttpError(409, 'Los datos del servicio cambiaron después de generar esta versión; espere la nueva versión');
  }

  const [orgLogo, customerLogo, signature, sealImg] = await Promise.all([
    download('org-assets', p.organization?.logo_path), download('org-assets', p.customer?.logo_path),
    download('org-assets', signer.signature_path), download('org-assets', seal?.image_path)]);
  const issuedAt = new Date();
  const pdf = await buildReportPdf(PDFLib, p, { orgLogo, customerLogo, signature, seal: sealImg }, {
    mode: 'signed', version: v.version, verificationCode: v.verification_code, issuedAt,
    signer: { name: signer.full_name, position: signer.position }, sealName: seal?.name ?? null,
    changeSummary: v.change_summary, verifyUrl: Deno.env.get('PUBLIC_VERIFY_URL') ?? undefined,
  });
  const sha256 = await sha256Hex(pdf);
  const path = `${v.organization_id}/${v.customer_id}/${v.service_id}/${v.report_id}/v${v.version}-firmado-${v.verification_code}-${issuedAt.getTime()}.pdf`;
  const { error: ue } = await svc.storage.from('reports').upload(path, pdf, { contentType: 'application/pdf', upsert: false });
  if (ue) throw new HttpError(409, `No se pudo guardar el documento: ${ue.message}`);

  const evidence = {
    method: 'report-sign', auth_user_id: user.id, auth_email: user.email,
    session_id: (() => { try { return JSON.parse(atob((req.headers.get('Authorization') ?? '').split('.')[1] ?? '')).session_id ?? null; } catch { return null; } })(),
    ip: req.headers.get('x-forwarded-for') ?? null, user_agent: req.headers.get('user-agent') ?? null,
    signature_image: !!signature, seal_image: !!sealImg, legal_note: 'Firma gráfica con hash SHA-256; no es firma electrónica certificada',
  };
  const { data: res, error: se } = await svc.rpc('worker_sign_version', {
    p_version: v.id, p_user: user.id, p_signer: signer.id, p_seal: seal?.id ?? null, p_storage_path: path,
    p_sha256: sha256, p_size: pdf.length, p_issued_at: issuedAt.toISOString(), p_evidence: evidence,
  });
  if (se) throw new HttpError(400, se.message);

  // Notificación por correo (opcional, si hay proveedor configurado y la empresa lo permite).
  const { data: settings } = await svc.from('organization_settings').select('notify_customers_email').eq('organization_id', v.organization_id).maybeSingle();
  let email = { sent: 0, skipped: true };
  const recipients = ((res as { recipients?: string[] })?.recipients ?? []);
  if (settings?.notify_customers_email !== false && recipients.length) {
    const { data: profiles } = await svc.from('user_profiles').select('email').in('user_id', recipients);
    const portal = Deno.env.get('PUBLIC_APP_URL') ?? '';
    email = await sendEmails((profiles ?? []).map((x) => x.email).filter(Boolean) as string[],
      `Informe final disponible · Servicio ${p.service.service_number}`,
      `<p>El informe final del servicio <b>${escapeHtml(String(p.service.service_number))}</b> (${escapeHtml(String(p.vessel?.name ?? ''))}), versión ${v.version}, está disponible en su portal.</p>` +
      (portal ? `<p><a href="${escapeHtml(portal)}/portal/reportes">Abrir el portal</a></p>` : '') +
      `<p>Código de verificación: ${escapeHtml(v.verification_code)}</p>`);
  }
  return json(req, { status: 'signed', version: v.version, sha256, storage_path: path, email });
}));
