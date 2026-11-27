/**
 * Reportes, firma, portal y administración de usuarios a través de las Edge Functions.
 * Requiere: npx supabase start && node scripts/vendor-edge-deps.mjs on (solo sandbox)
 *           && npx supabase functions serve
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { addMember, admin, anon, createUser, localEnv, localStamp, ok, signIn, uniq } from './helpers';

const TZ = 'America/Guatemala';
const run = uniq();
const mail = (n: string) => `${n}.${run}@rep.test`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** PNG RGBA sólido mínimo (para firma y sello de prueba). */
function png(w: number, h: number, rgba: [number, number, number, number]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function fn(client: SupabaseClient | null, name: string, body: unknown) {
  const token = client ? (await client.auth.getSession()).data.session?.access_token : localEnv().ANON_KEY;
  const r = await fetch(`${localEnv().API_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: localEnv().ANON_KEY }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as Record<string, any> };
}

const S = {} as Record<string, any>;
const C = {} as Record<string, SupabaseClient>;

beforeAll(async () => {
  const a = admin();
  S.platform = await createUser(mail('platform'), 'Plataforma');
  ok(await a.from('platform_admins').insert({ user_id: S.platform }));
  C.platform = await signIn(mail('platform'));
  const org = ok(await C.platform.rpc('platform_create_organization', { p: { name: `Puerto Rep ${run}`, timezone: TZ } })) as any;
  S.org = org.organization_id; S.term = org.terminal_id;
  for (const [k, role] of [['master', 'master_admin'], ['signer', 'signer']] as const) {
    S[k] = await createUser(mail(k), k === 'signer' ? 'Ana Lucía Morales' : 'Master Rep');
    await addMember(S.org, S[k], role);
    C[k] = await signIn(mail(k));
  }
  const m = C.master;
  S.cust1 = (ok(await m.from('customers').insert({ organization_id: S.org, code: 'R1', trade_name: 'Cliente Uno' }).select('id').single()) as any).id;
  S.cust2 = (ok(await m.from('customers').insert({ organization_id: S.org, code: 'R2', trade_name: 'Cliente Dos' }).select('id').single()) as any).id;
  const vessel = (ok(await m.from('vessels').insert({ organization_id: S.org, name: 'MV Santa Lucía Star', imo_number: '9690127', holds_count: 2 }).select('id').single()) as any).id;
  S.prod = (ok(await m.from('products').insert({ organization_id: S.org, name: 'Carbón', color: '#3a3f45' }).select('id').single()) as any).id;
  S.scale = (ok(await m.from('scales').insert({ terminal_id: S.term, organization_id: S.org, code: 'B1', name: 'Báscula 1' }).select('id').single()) as any).id;
  S.service = ok(await m.rpc('create_service', { p: { terminal_id: S.term, customer_id: S.cust1, vessel_id: vessel, service_number: `OP-${run}`, scale_ids: [S.scale],
    holds: [{ hold_number: 1, cargo: [{ product_id: S.prod, initial_tm: 100 }] }] } }));
  const hold = (ok(await m.from('service_holds').select('id').eq('service_id', S.service).single()) as any).id;
  ok(await m.rpc('change_service_status', { p_service: S.service, p_status: 'in_operation' }));
  S.tickets = [];
  for (let i = 0; i < 3; i++) {
    const r = ok(await m.rpc('register_weigh_ticket', { p: { client_request_id: randomUUID(), scale_id: S.scale, service_id: S.service, service_hold_id: hold, product_id: S.prod,
      ticket_number: `R${run}-${i}`, truck_plate: `C-10${i}ABC`, driver_name: 'Piloto Prueba', driver_dpi: '1234567890101', gross: 45000, tare: 15000,
      started_local: localStamp(TZ, -60 + i * 10), ended_local: localStamp(TZ, -56 + i * 10) } })) as any;
    S.tickets.push(r.ticket_id);
  }
  // Usuarios del portal: uno por función admin-users (contraseña temporal), otro directo
  const r1 = await fn(C.master, 'admin-users', { action: 'create_customer', customer_id: S.cust1, email: mail('cu1'), full_name: 'Usuario Cliente Uno', delivery: 'temp_password' });
  expect(r1.status, JSON.stringify(r1.body)).toBe(200);
  S.cu1Temp = r1.body.temp_password; S.cu1 = r1.body.user_id;
  S.cu2 = await createUser(mail('cu2'), 'Usuario Cliente Dos', 'customer');
  ok(await a.from('customer_users').insert({ customer_id: S.cust2, user_id: S.cu2, organization_id: S.org }));
  C.cu2 = await signIn(mail('cu2'));
}, 180_000);

describe('Usuarios del cliente y contraseña temporal', () => {
  it('el cliente entra con la contraseña temporal y debe cambiarla antes de ver datos', async () => {
    expect(S.cu1Temp).toMatch(/^.{14}$/);
    const c = await signIn(mail('cu1'), S.cu1Temp);
    const ctx = ok(await c.rpc('my_context')) as any;
    expect(ctx.profile.must_change_password).toBe(true);
    expect((ok(await c.from('services').select('id')) as unknown[]).length).toBe(0);
    ok(await c.auth.updateUser({ password: 'Cliente-Nuevo-2026' }));
    ok(await c.rpc('confirm_password_changed'));
    C.cu1 = await signIn(mail('cu1'), 'Cliente-Nuevo-2026');
    expect((ok(await C.cu1.from('services').select('id')) as unknown[]).length).toBe(1);
    expect(((ok(await C.cu1.rpc('my_context')) as any).customer_links[0].customer_id)).toBe(S.cust1);
  });

  it('crea personal con contraseña temporal; un usuario sin permisos no puede crear cuentas', async () => {
    const r = await fn(C.master, 'admin-users', { action: 'create_staff', organization_id: S.org, email: mail('ops'), full_name: 'Operativo Rep', role_code: 'ops_admin', delivery: 'temp_password' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    C.ops = await signIn(mail('ops'), r.body.temp_password);
    const deny = await fn(C.ops, 'admin-users', { action: 'create_staff', organization_id: S.org, email: mail('x'), full_name: 'X', role_code: 'master_admin' });
    expect(deny.status).toBe(403);
    const deny2 = await fn(C.cu2, 'admin-users', { action: 'create_customer', customer_id: S.cust2, email: mail('y'), full_name: 'Y' });
    expect(deny2.status).toBe(403);
    const noAuth = await fn(null, 'admin-users', { action: 'create_staff', organization_id: S.org, email: mail('z'), full_name: 'Z', role_code: 'analyst' });
    expect(noAuth.status).toBe(401);
  });
});

describe('Cierre → PDF → firma → portal', () => {
  it('al finalizar se genera automáticamente un borrador único (idempotente)', async () => {
    const close = ok(await C.master.rpc('close_service', { p_service: S.service, p_note: 'Remanente a bordo verificado por calado', p_conclusions: 'Operación sin incidentes.' })) as any;
    S.job = close.job_id;
    const [g1, g2] = await Promise.all([fn(C.master, 'report-worker', { job_id: S.job }), fn(C.master, 'report-worker', { job_id: S.job })]);
    const done = [g1, g2].filter((x) => x.status === 200 && x.body.version_id);
    expect(done.length, JSON.stringify([g1.body, g2.body])).toBeGreaterThanOrEqual(1);
    const versions = ok(await C.master.from('report_versions').select('id, version, status, draft_path').eq('service_id', S.service)) as any[];
    expect(versions.length).toBe(1);
    expect(versions[0].status).toBe('pending_signature');
    S.v1 = versions[0];
    const again = await fn(C.master, 'report-worker', { job_id: S.job });
    expect(again.body.status).toBe('done');
    expect((ok(await C.master.from('report_versions').select('id').eq('service_id', S.service)) as any[]).length).toBe(1);
  });

  it('el cliente no ve borradores sin firmar', async () => {
    expect((ok(await C.cu1.from('report_versions').select('id')) as any[]).length).toBe(0);
    const url = await C.cu1.storage.from('reports').createSignedUrl(S.v1.draft_path, 60);
    expect(url.error).toBeTruthy();
  });

  it('solo un firmante autorizado configurado puede firmar', async () => {
    const sigPath = `${S.org}/signatures/${randomUUID()}.png`;
    ok(await C.master.storage.from('org-assets').upload(sigPath, png(120, 40, [11, 79, 113, 255]), { contentType: 'image/png' }));
    const sealPath = `${S.org}/seals/${randomUUID()}.png`;
    ok(await C.master.storage.from('org-assets').upload(sealPath, png(80, 80, [207, 59, 37, 200]), { contentType: 'image/png' }));
    ok(await C.master.from('authorized_signers').insert({ organization_id: S.org, user_id: S.signer, full_name: 'Ana Lucía Morales', position: 'Gerente de Operaciones', signature_path: sigPath }));
    ok(await C.master.from('company_seals').insert({ organization_id: S.org, name: 'Sello corporativo', image_path: sealPath, is_default: true }));
    const denied = await fn(C.master, 'report-sign', { version_id: S.v1.id });
    expect(denied.status).toBe(403);
    const denied2 = await fn(C.cu1, 'report-sign', { version_id: S.v1.id });
    expect(denied2.status).toBe(403);
  });

  it('firma: hash SHA-256 registrado = hash del archivo; publicación y notificación al cliente', async () => {
    const r = await fn(C.signer, 'report-sign', { version_id: S.v1.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = ok(await C.master.from('report_versions').select('*').eq('id', S.v1.id).single()) as any;
    expect(v.status).toBe('signed');
    expect(v.sha256).toBe(r.body.sha256);
    const file = ok(await C.master.storage.from('reports').download(v.storage_path)) as Blob;
    expect(sha(new Uint8Array(await file.arrayBuffer()))).toBe(v.sha256);
    const sig = ok(await C.master.from('digital_signatures').select('document_sha256, signature_type, signer_name').eq('report_version_id', v.id).single()) as any;
    expect(sig.document_sha256).toBe(v.sha256);
    expect(sig.signature_type).toBe('graphic');
    const notes = ok(await C.cu1.from('notifications').select('kind, title')) as any[];
    expect(notes.some((n) => n.kind === 'report_published')).toBe(true);
    S.v1 = v;
  });

  it('el cliente propietario descarga con URL firmada de corta duración; otro cliente no', async () => {
    const own = ok(await C.cu1.from('report_overview').select('id, status, verification_code')) as any[];
    expect(own.length).toBe(1);
    const signed = ok(await C.cu1.storage.from('reports').createSignedUrl(S.v1.storage_path, 60)) as any;
    const res = await fetch(signed.signedUrl);
    expect(res.status).toBe(200);
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(S.v1.sha256);
    expect((ok(await C.cu2.from('report_versions').select('id')) as any[]).length).toBe(0);
    const other = await C.cu2.storage.from('reports').createSignedUrl(S.v1.storage_path, 60);
    expect(other.error).toBeTruthy();
    const direct = await fetch(`${localEnv().API_URL}/storage/v1/object/public/reports/${S.v1.storage_path}`);
    expect(direct.status).not.toBe(200);
  });

  it('verificación pública por código e inmutabilidad del documento firmado', async () => {
    const vr = ok(await anon().rpc('verify_report', { p_code: S.v1.verification_code.toLowerCase() })) as any;
    expect(vr.found).toBe(true);
    expect(vr.sha256).toBe(S.v1.sha256);
    expect(vr.status).toBe('signed');
    const overwrite = await C.master.storage.from('reports').upload(S.v1.storage_path, new Uint8Array([1, 2, 3]), { upsert: true, contentType: 'application/pdf' });
    expect(overwrite.error).toBeTruthy();
    const tamper = await admin().from('report_versions').update({ sha256: 'a'.repeat(64) }).eq('id', S.v1.id);
    expect(tamper.error?.message).toMatch(/inmutable/);
  });

  it('una corrección posterior genera v2; al firmarla, v1 queda sustituida (sin borrarse)', async () => {
    const res = ok(await C.master.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: S.tickets[0], p_action: 'void', p_changes: {}, p_reason: 'Ticket duplicado detectado tras el cierre' })) as any;
    const job = res.result.job_id;
    expect(job).toBeTruthy();
    const gr = ok(await C.master.from('generated_reports').select('status').eq('service_id', S.service).single()) as any;
    expect(gr.status).toBe('revision_pending');
    const g = await fn(C.master, 'report-worker', { job_id: job });
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(g.body.version).toBe(2);
    const portalBefore = ok(await C.cu1.from('report_versions').select('version, status')) as any[];
    expect(portalBefore).toEqual([{ version: 1, status: 'signed' }]);
    const s = await fn(C.signer, 'report-sign', { version_id: g.body.version_id });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const all = ok(await C.cu1.from('report_versions').select('version, status, superseded_by, supersede_reason').order('version')) as any[];
    expect(all.map((x) => [x.version, x.status])).toEqual([[1, 'superseded'], [2, 'signed']]);
    expect(all[0].supersede_reason).toMatch(/sustituye/i);
    const v1 = ok(await anon().rpc('verify_report', { p_code: S.v1.verification_code })) as any;
    expect(v1.status).toBe('superseded');
    expect(v1.superseded_by_version).toBe(2);
    const notes = ok(await C.cu1.from('notifications').select('title')) as any[];
    expect(notes.filter((n) => /Nueva versión/.test(n.title)).length).toBe(1);
  });

  it('desactivar un usuario del portal bloquea su acceso de inmediato', async () => {
    const r = await fn(C.master, 'admin-users', { action: 'set_status', organization_id: S.org, user_id: S.cu1, scope: 'customer', status: 'inactive' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((ok(await C.cu1.from('report_versions').select('id')) as any[]).length).toBe(0);
    await expect(signIn(mail('cu1'), 'Cliente-Nuevo-2026')).rejects.toThrow();
  });
});
