// Datos de DEMOSTRACIÓN para el entorno LOCAL (supabase start). No usar en producción.
// Crea una empresa con usuarios, clientes, buques, básculas, servicios, pesajes históricos,
// tiempos perdidos, una corrección y un servicio finalizado con informe firmado.
// Uso: node scripts/seed-demo.mjs   (requiere `npx supabase start` y `npx supabase functions serve`)
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const st = JSON.parse((() => { const o = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return o.slice(o.indexOf('{')); })());
if (!/127\.0\.0\.1|localhost/.test(st.API_URL) && !process.argv.includes('--force')) { console.error('Solo para entorno local.'); process.exit(1); }
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(st.API_URL, st.SERVICE_ROLE_KEY, opts);
const PASSWORD = 'VesselDemo2026';
const TZ = 'America/Guatemala';
const ok = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };

async function user(email, name, kind = 'staff') {
  const found = (await admin.from('user_profiles').select('user_id').eq('email', email).maybeSingle()).data;
  if (found) return found.user_id;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  ok(await admin.from('user_profiles').insert({ user_id: data.user.id, full_name: name, email, kind }), 'perfil');
  return data.user.id;
}
async function login(email) {
  const c = createClient(st.API_URL, st.ANON_KEY, opts);
  ok(await c.auth.signInWithPassword({ email, password: PASSWORD }), `login ${email}`);
  return c;
}
async function fn(client, name, body) {
  const token = (await client.auth.getSession()).data.session.access_token;
  const r = await fetch(`${st.API_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: st.ANON_KEY }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${name}: ${j.error}`); return j;
}
const local = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
let seed = 20261127; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const rr = (a, b) => a + (b - a) * rnd(); const ri = (a, b) => Math.floor(rr(a, b + 1)); const pick = (a) => a[Math.floor(rnd() * a.length)];


/** PNG RGBA generado por código (firma ondulada y sello circular de demostración). */
function png(w, h, paint) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const px = paint(x, y); if (px) raw.set(px, y * (w * 4 + 1) + 1 + x * 4); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const signaturePng = () => png(360, 110, (x, y) => {
  const c = 55 + 28 * Math.sin(x / 22) * Math.exp(-x / 420) + 12 * Math.sin(x / 7.5);
  return Math.abs(y - c) < 2.2 && x > 14 && x < 340 ? [16, 42, 92, 255] : null;
});
const sealPng = () => png(220, 220, (x, y) => {
  const d = Math.hypot(x - 110, y - 110);
  return (d > 98 && d < 106) || (d > 82 && d < 86) || (Math.abs(y - 110) < 3 && d < 70) ? [178, 34, 34, 210] : null;
});

const existing = (await admin.from('organizations').select('id').eq('name', 'Estibadora del Pacífico, S.A.').maybeSingle()).data;
if (existing) { console.log('Los datos de demostración ya existen.'); process.exit(0); }

console.log('Usuarios y empresa…');
const platformId = await user('admin@vessel.local', 'Administrador de Plataforma');
await admin.from('platform_admins').upsert({ user_id: platformId });
const platform = await login('admin@vessel.local');
const org = ok(await platform.rpc('platform_create_organization', { p: { name: 'Estibadora del Pacífico, S.A.', legal_name: 'Estibadora del Pacífico, Sociedad Anónima', country: 'Guatemala', terminal_name: 'Terminal Puerto Quetzal', terminal_code: 'PQZ', port_name: 'Puerto Quetzal', timezone: TZ } }), 'empresa');
const ORG = org.organization_id, TERM = org.terminal_id;
const staff = [
  ['master@vessel.local', 'Ana Lucía Morales', 'master_admin', 'Gerente de Operaciones'], ['operaciones@vessel.local', 'Carlos Méndez', 'ops_admin', 'Jefe de Operaciones'],
  ['supervisor@vessel.local', 'Jorge Xitumul', 'supervisor', 'Supervisor de turno'], ['bascula1@vessel.local', 'Luis Ajú', 'scale_operator', 'Operador de báscula'],
  ['bascula2@vessel.local', 'María Coc', 'scale_operator', 'Operadora de báscula'], ['bascula3@vessel.local', 'Edwin Pérez', 'scale_operator', 'Operador de báscula'],
  ['analista@vessel.local', 'Rosa Chávez', 'analyst', 'Analista de productividad'], ['firmante@vessel.local', 'Ricardo Estrada', 'signer', 'Representante legal'],
];
const U = {};
for (const [email, name, role, position] of staff) { U[email] = await user(email, name); ok(await admin.from('organization_members').insert({ organization_id: ORG, user_id: U[email], role_code: role, position }), 'miembro'); }
const master = await login('master@vessel.local');
const ops = await login('operaciones@vessel.local');
const sup = await login('supervisor@vessel.local');

console.log('Catálogos…');
const P = Object.fromEntries((ok(await master.from('products').insert([
  { organization_id: ORG, name: 'Fertilizante', color: '#4c9a4f' }, { organization_id: ORG, name: 'Urea', color: '#b4c5d4' }, { organization_id: ORG, name: 'Carbón', color: '#3a3f45' },
  { organization_id: ORG, name: 'Maíz', color: '#f0b400' }, { organization_id: ORG, name: 'Trigo', color: '#b9834a' }, { organization_id: ORG, name: 'Soya', color: '#8d9a3a' }]).select('id, name'), 'productos')).map((p) => [p.name, p.id]));
const V = Object.fromEntries((ok(await master.from('vessels').insert([
  { organization_id: ORG, name: 'MV Ocean Kestrel', imo_number: '9785412', holds_count: 5, capacity_tm: 32000, flag: 'Panamá' },
  { organization_id: ORG, name: 'MV Río Sumpul', holds_count: 4, capacity_tm: 22000 },
  { organization_id: ORG, name: 'MV Santa Lucía Star', imo_number: '9690127', holds_count: 5, capacity_tm: 33000, flag: 'Liberia' },
  { organization_id: ORG, name: 'MV Caribe Dawn', imo_number: '9612233', holds_count: 3, capacity_tm: 15000 }]).select('id, name'), 'buques')).map((v) => [v.name, v.id]));
const C = Object.fromEntries((ok(await master.from('customers').insert([
  { organization_id: ORG, code: 'C-001', trade_name: 'Fertilizantes del Sur', legal_name: 'Fertilizantes del Sur, S.A.', tax_id: '4589632-1', country: 'Guatemala', main_contact: 'Marta Girón', email: 'compras@fertisur.example', phone: '+502 2200 0000' },
  { organization_id: ORG, code: 'C-002', trade_name: 'Molinos de Centroamérica', legal_name: 'Molinos de Centroamérica, S.A.', tax_id: '7845123-6', country: 'Guatemala', main_contact: 'Pedro Lima' },
  { organization_id: ORG, code: 'C-003', trade_name: 'Energía Térmica del Pacífico', legal_name: 'Energía Térmica del Pacífico, S.A.', country: 'Guatemala' }]).select('id, code'), 'clientes')).map((c) => [c.code, c.id]));
const S = Object.fromEntries((ok(await master.from('scales').insert([
  { terminal_id: TERM, organization_id: ORG, code: 'BAS-01', name: 'Báscula 1', location: 'Portón de salida norte', status: 'active' },
  { terminal_id: TERM, organization_id: ORG, code: 'BAS-02', name: 'Báscula 2', location: 'Portón de salida norte', status: 'active' },
  { terminal_id: TERM, organization_id: ORG, code: 'BAS-03', name: 'Báscula 3', location: 'Patio de granel sur', status: 'active' },
  { terminal_id: TERM, organization_id: ORG, code: 'BAS-04', name: 'Báscula 4', location: 'Patio de granel sur', status: 'maintenance' }]).select('id, code'), 'básculas')).map((s) => [s.code, s.id]));
ok(await master.from('scale_users').insert([
  { scale_id: S['BAS-01'], user_id: U['bascula1@vessel.local'], organization_id: ORG, terminal_id: TERM }, { scale_id: S['BAS-02'], user_id: U['bascula2@vessel.local'], organization_id: ORG, terminal_id: TERM },
  { scale_id: S['BAS-03'], user_id: U['bascula3@vessel.local'], organization_id: ORG, terminal_id: TERM }, { scale_id: S['BAS-01'], user_id: U['supervisor@vessel.local'], organization_id: ORG, terminal_id: TERM }]), 'operadores');

const NAMES = ['Juan Carlos Pérez López', 'Mario Ajú Xicay', 'Edgar Coy Pop', 'Byron Morales Díaz', 'Selvin Ramírez Cruz', 'Óscar Tzul Chávez', 'Erick Barrios Monzón', 'Wilson Hernández Ruiz', 'Henry Cifuentes Sosa', 'Julio Cac Ixcoy', 'Marvin Orellana Paz', 'Kevin Godínez Ortiz', 'Rony Velásquez Mejía', 'Hugo Caal Choc', 'Elmer Recinos Soto', 'Walter Lux Tum', 'Fredy Alvarado Cano', 'Alex Pineda Rosales'];
const L = 'BCDFGHJKLMNPRSTVWXYZ';
const TRUCKS = NAMES.map((n) => ({ plate: `C-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, tc: `TC-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, driver: n, dpi: `${ri(1000, 3999)}${ri(10000, 99999)}0101`, cap: pick([30, 32, 34, 36]), tare: ri(13600, 16400) }));

async function makeService(number, customer, vessel, holds, scales, status) {
  const id = ok(await ops.rpc('create_service', { p: { terminal_id: TERM, customer_id: customer, vessel_id: vessel, service_number: number, responsible_user_id: U['operaciones@vessel.local'], responsible_name: 'Carlos Méndez', scale_ids: scales,
    holds: holds.map((cargo, i) => ({ hold_number: i + 1, cargo: cargo.map(([p, tm]) => ({ product_id: P[p], initial_tm: tm })) })) } }), number);
  if (status !== 'scheduled') ok(await ops.rpc('change_service_status', { p_service: id, p_status: status }), 'estado');
  return id;
}
const tickets = { 'BAS-01': 4120, 'BAS-02': 3875, 'BAS-03': 2960 };
async function history(serviceId, scaleCodes, hours, clients, fraction = 1) {
  const cargo = ok(await master.from('service_hold_cargo').select('id, service_hold_id, product_id, initial_tm, discharged_tm').eq('service_id', serviceId), 'carga');
  const pend = Object.fromEntries(cargo.map((c) => [c.id, Number(c.initial_tm) * fraction]));
  const start = Date.now() - hours * 3600e3;
  let n = 0;
  for (const code of scaleCodes) {
    let t = start + rr(2, 10) * 60e3;
    while (t < Date.now() - 20 * 60e3) {
      const opts2 = cargo.filter((c) => pend[c.id] > 35);
      if (!opts2.length) break;
      const c = opts2[Math.floor(rnd() * opts2.length)];
      const tr = pick(TRUCKS);
      const net = Math.round(tr.cap * 1000 * rr(0.85, 0.97));
      const tare = tr.tare + ri(-120, 120);
      const cycle = rr(2, 5.5) + (rnd() < 0.06 ? rr(25, 45) : 0);
      tickets[code]++;
      const r = await clients[code].rpc('register_weigh_ticket', { p: { client_request_id: randomUUID(), scale_id: S[code], service_id: serviceId, service_hold_id: c.service_hold_id, product_id: c.product_id,
        ticket_number: `T${code.slice(-1)}-${String(tickets[code]).padStart(6, '0')}`, truck_plate: tr.plate, tractor_plate: tr.tc, driver_name: tr.driver, driver_dpi: tr.dpi, nominal_capacity_tm: tr.cap,
        gross: tare + net, tare, weight_unit: 'kg', started_local: local(t), ended_local: local(t + cycle * 60e3) } });
      if (!r.error) { pend[c.id] -= net / 1000; n++; }
      t += (cycle + rr(3, 9) + (rnd() < 0.1 ? rr(15, 40) : 0)) * 60e3;
    }
  }
  return n;
}

console.log('Servicios y pesajes (puede tardar ~1 min)…');
const ops1 = await login('bascula1@vessel.local'), ops2 = await login('bascula2@vessel.local'), ops3 = await login('bascula3@vessel.local');
const CL = { 'BAS-01': ops1, 'BAS-02': ops2, 'BAS-03': ops3 };
const finalized = await makeService('SD-2026-0139', C['C-001'], V['MV Caribe Dawn'], [[['Urea', 900]], [['Fertilizante', 850]], [['Fertilizante', 700]]], [S['BAS-01'], S['BAS-02']], 'in_operation');
await history(finalized, ['BAS-01', 'BAS-02'], 52, CL, 0.985);
const kestrel = await makeService('SD-2026-0142', C['C-001'], V['MV Ocean Kestrel'], [[['Fertilizante', 3000], ['Urea', 2000]], [['Carbón', 5000]], [['Maíz', 4500], ['Trigo', 2500]], [['Maíz', 5500]], [['Trigo', 4000]]], [S['BAS-01'], S['BAS-02'], S['BAS-03']], 'in_operation');
console.log('  SD-2026-0142:', await history(kestrel, ['BAS-01', 'BAS-02', 'BAS-03'], 30, CL, 0.62), 'pesajes');
const sumpul = await makeService('SD-2026-0143', C['C-002'], V['MV Río Sumpul'], [[['Soya', 4200]], [['Soya', 3800], ['Maíz', 1000]], [['Maíz', 4600]], [['Trigo', 3900]]], [S['BAS-01'], S['BAS-03']], 'in_operation');
console.log('  SD-2026-0143:', await history(sumpul, ['BAS-01', 'BAS-03'], 11, CL, 0.4), 'pesajes');
await makeService('SD-2026-0144', C['C-003'], V['MV Santa Lucía Star'], [6200, 6400, 6400, 6400, 6100].map((t) => [['Carbón', t]]), [S['BAS-01'], S['BAS-02']], 'scheduled');

console.log('Tiempos perdidos y correcciones…');
const causes = Object.fromEntries((ok(await sup.from('downtime_causes').select('id, name').eq('organization_id', ORG), 'causas')).map((c) => [c.name, c.id]));
const kHolds = ok(await sup.from('service_holds').select('id, hold_number').eq('service_id', kestrel), 'bodegas');
const ev = [['Falta de camiones', -27, 55, 'operation'], ['Falla de grab', -22, 40, 'hold', kHolds[2].id], ['Condiciones climáticas', -16, 75, 'operation'], ['Cambio de bodega', -12, 25, 'hold', kHolds[0].id], ['Mantenimiento', -9, 30, 'scale', null, S['BAS-03']], ['Falta de camiones', -5, 35, 'operation'], ['Espera de autorización', -3, 20, 'operation']];
for (const [cause, h, mins, scope, hold, scale] of ev) {
  const t = Date.now() + h * 3600e3;
  ok(await sup.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: kestrel, cause_id: causes[cause], started_local: local(t), ended_local: local(t + mins * 60e3), scope, service_hold_id: hold ?? null, scale_id: scale ?? null, observations: cause === 'Condiciones climáticas' ? 'Lluvia intensa; grúas detenidas por seguridad.' : null } }), 'tiempo perdido');
}
const someTickets = ok(await master.from('weigh_tickets').select('id, revision, tare_kg').eq('service_id', kestrel).eq('status', 'valid').order('registered_at', { ascending: false }).limit(3), 'tickets');
ok(await sup.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: someTickets[0].id, p_action: 'update', p_changes: { tare_kg: Number(someTickets[0].tare_kg) + 220 }, p_reason: 'Tara repesada: el camión entró con lona húmeda' }), 'corrección');
ok(await sup.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: someTickets[1].id, p_action: 'void', p_changes: {}, p_reason: 'Ticket duplicado por reimpresión en la báscula' }), 'anulación');
const own = ok(await ops1.from('weigh_tickets').select('id').eq('service_id', kestrel).eq('scale_id', S['BAS-01']).eq('status', 'valid').order('registered_at', { ascending: false }).range(5, 5).single(), 'ticket propio');
ok(await ops1.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: own.id, p_action: 'update', p_changes: { truck_plate: 'C-512KLM' }, p_reason: 'Matrícula mal digitada en báscula' }), 'solicitud');

console.log('Cierre, informe y firma…');
const sigPng = signaturePng();
const sp = `${ORG}/signatures/${randomUUID()}.png`; ok(await master.storage.from('org-assets').upload(sp, sigPng, { contentType: 'image/png' }), 'firma');
const sealPath = `${ORG}/seals/${randomUUID()}.png`; ok(await master.storage.from('org-assets').upload(sealPath, sealPng(), { contentType: 'image/png' }), 'sello');
ok(await master.from('company_seals').insert({ organization_id: ORG, name: 'Sello corporativo', image_path: sealPath, is_default: true }), 'sello');
ok(await master.from('authorized_signers').insert([{ organization_id: ORG, user_id: U['master@vessel.local'], full_name: 'Ana Lucía Morales', position: 'Gerente de Operaciones', signature_path: sp },
  { organization_id: ORG, user_id: U['firmante@vessel.local'], full_name: 'Ricardo Estrada', position: 'Representante legal' }]), 'firmantes');
const closed = ok(await ops.rpc('close_service', { p_service: finalized, p_note: 'Remanente a bordo de 36 TM verificado con inspección de calado final.', p_conclusions: 'La operación se completó sin incidentes de seguridad. El ritmo promedio fue estable en ambas básculas.' }), 'cierre');
const draft = await fn(master, 'report-worker', { job_id: closed.job_id });
await fn(master, 'report-sign', { version_id: draft.version_id });

console.log('Usuarios del portal…');
for (const [email, name, cust] of [['cliente@fertisur.local', 'Marta Girón', 'C-001'], ['cliente@molinos.local', 'Pedro Lima', 'C-002']]) {
  const id = await user(email, name, 'customer');
  const cu = ok(await admin.from('customer_users').insert({ customer_id: C[cust], user_id: id, organization_id: ORG }).select('id').single(), 'cliente');
  ok(await admin.from('customer_portal_permissions').insert({ customer_user_id: cu.id, organization_id: ORG, customer_id: C[cust] }), 'permisos');
}
ok(await master.from('scale_settings').insert({ scale_id: S['BAS-02'], organization_id: ORG, terminal_id: TERM, time_capture_mode: 'server_now' }), 'modo báscula 2');
console.log(`\nListo. Contraseña de todos los usuarios de demostración: ${PASSWORD}`);
console.log('admin@vessel.local (plataforma) · master@vessel.local · operaciones@ · supervisor@ · bascula1@ · bascula2@ (hora del servidor) · analista@ · firmante@ · cliente@fertisur.local · cliente@molinos.local');
