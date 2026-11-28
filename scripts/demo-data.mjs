// Datos de DEMOSTRACIÓN de Vessel Control (empresa, usuarios, catálogos, servicios, pesajes
// históricos, tiempos perdidos, correcciones y un servicio finalizado con informe firmado).
// Módulo compartido: lo usan scripts/seed-demo.mjs (Node, entorno local) y
// scripts/edge/seed-demo-edge.ts (Edge Function temporal para entornos de demostración).
// Requiere fetch, crypto y CompressionStream nativos (Node 22+ o Deno).

/** PNG RGBA generado por código (firma ondulada y sello circular de demostración). */
async function png(w, h, paint) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
  const chunk = (t, d) => { const td = cat(new TextEncoder().encode(t), d); return cat(u32(d.length), td, u32(crc(td))); };
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const px = paint(x, y); if (px) raw.set(px, y * (w * 4 + 1) + 1 + x * 4); }
  const ih = new Uint8Array(13); const dv = new DataView(ih.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ih[8] = 8; ih[9] = 6;
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  return cat(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', z), chunk('IEND', new Uint8Array(0)));
}
const signaturePng = () => png(360, 110, (x, y) => {
  const c = 55 + 28 * Math.sin(x / 22) * Math.exp(-x / 420) + 12 * Math.sin(x / 7.5);
  return Math.abs(y - c) < 2.2 && x > 14 && x < 340 ? [16, 42, 92, 255] : null;
});
const sealPng = () => png(220, 220, (x, y) => {
  const d = Math.hypot(x - 110, y - 110);
  return (d > 98 && d < 106) || (d > 82 && d < 86) || (Math.abs(y - 110) < 3 && d < 70) ? [178, 34, 34, 210] : null;
});

/**
 * @param {{ createClient: Function, url: string, anonKey: string, serviceKey: string, password: string, domain: string, log?: (m: string) => void }} cfg
 */
export async function seedDemo({ createClient, url, anonKey, serviceKey, password, domain, log = console.log }) {
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, serviceKey, opts);
  const TZ = 'America/Guatemala';
  const ok = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  async function user(email, name, kind = 'staff') {
    const found = (await admin.from('user_profiles').select('user_id').eq('email', email).maybeSingle()).data;
    if (found) return found.user_id;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    ok(await admin.from('user_profiles').insert({ user_id: data.user.id, full_name: name, email, kind }), 'perfil');
    return data.user.id;
  }
  async function login(email) {
    const c = createClient(url, anonKey, opts);
    ok(await c.auth.signInWithPassword({ email, password }), `login ${email}`);
    return c;
  }
  async function fn(client, name, body) {
    const token = (await client.auth.getSession()).data.session.access_token;
    const r = await fetch(`${url}/functions/v1/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: anonKey }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(`${name}: ${j.error}`); return j;
  }
  const local = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  let seed = 20261127; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rr = (a, b) => a + (b - a) * rnd(); const ri = (a, b) => Math.floor(rr(a, b + 1)); const pick = (a) => a[Math.floor(rnd() * a.length)];

  const existing = (await admin.from('organizations').select('id').eq('name', 'Estibadora del Pacífico, S.A.').maybeSingle()).data;
  if (existing) { log('Los datos de demostración ya existen.'); return { status: 'exists' }; }

  log('Usuarios y empresa…');
  const platformId = await user(`admin@${domain}`, 'Administrador de Plataforma');
  await admin.from('platform_admins').upsert({ user_id: platformId });
  const platform = await login(`admin@${domain}`);
  const org = ok(await platform.rpc('platform_create_organization', { p: { name: 'Estibadora del Pacífico, S.A.', legal_name: 'Estibadora del Pacífico, Sociedad Anónima', country: 'Guatemala', terminal_name: 'Terminal Puerto Quetzal', terminal_code: 'PQZ', port_name: 'Puerto Quetzal', timezone: TZ } }), 'empresa');
  const ORG = org.organization_id, TERM = org.terminal_id;
  const staff = [
    [`master@${domain}`, 'Ana Lucía Morales', 'master_admin', 'Gerente de Operaciones'], [`operaciones@${domain}`, 'Carlos Méndez', 'ops_admin', 'Jefe de Operaciones'],
    [`supervisor@${domain}`, 'Jorge Xitumul', 'supervisor', 'Supervisor de turno'], [`bascula1@${domain}`, 'Luis Ajú', 'scale_operator', 'Operador de báscula'],
    [`bascula2@${domain}`, 'María Coc', 'scale_operator', 'Operadora de báscula'], [`bascula3@${domain}`, 'Edwin Pérez', 'scale_operator', 'Operador de báscula'],
    [`analista@${domain}`, 'Rosa Chávez', 'analyst', 'Analista de productividad'], [`firmante@${domain}`, 'Ricardo Estrada', 'signer', 'Representante legal'],
  ];
  const U = {};
  for (const [email, name, role, position] of staff) { U[email] = await user(email, name); ok(await admin.from('organization_members').insert({ organization_id: ORG, user_id: U[email], role_code: role, position }), 'miembro'); }
  const master = await login(`master@${domain}`);
  const ops = await login(`operaciones@${domain}`);
  const sup = await login(`supervisor@${domain}`);

  log('Catálogos…');
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
    { scale_id: S['BAS-01'], user_id: U[`bascula1@${domain}`], organization_id: ORG, terminal_id: TERM }, { scale_id: S['BAS-02'], user_id: U[`bascula2@${domain}`], organization_id: ORG, terminal_id: TERM },
    { scale_id: S['BAS-03'], user_id: U[`bascula3@${domain}`], organization_id: ORG, terminal_id: TERM }, { scale_id: S['BAS-01'], user_id: U[`supervisor@${domain}`], organization_id: ORG, terminal_id: TERM }]), 'operadores');

  const NAMES = ['Juan Carlos Pérez López', 'Mario Ajú Xicay', 'Edgar Coy Pop', 'Byron Morales Díaz', 'Selvin Ramírez Cruz', 'Óscar Tzul Chávez', 'Erick Barrios Monzón', 'Wilson Hernández Ruiz', 'Henry Cifuentes Sosa', 'Julio Cac Ixcoy', 'Marvin Orellana Paz', 'Kevin Godínez Ortiz', 'Rony Velásquez Mejía', 'Hugo Caal Choc', 'Elmer Recinos Soto', 'Walter Lux Tum', 'Fredy Alvarado Cano', 'Alex Pineda Rosales'];
  const L = 'BCDFGHJKLMNPRSTVWXYZ';
  const TRUCKS = NAMES.map((n) => ({ plate: `C-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, tc: `TC-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, driver: n, dpi: `${ri(1000, 3999)}${ri(10000, 99999)}0101`, cap: pick([30, 32, 34, 36]), tare: ri(13600, 16400) }));

  const META = Object.fromEntries(TRUCKS.map((t) => [t.plate, t]));
  // products: [{ name, bag?, holds: [[bodega, TM]], bls?: [[número, TM]] }]; points: [{ scale_id } | { name, operator_ids }]
  async function makeService(number, customer, vessel, products, points, status, { bags = false, fleet = TRUCKS.slice(0, 12), operators = [], kind = 'discharge' } = {}) {
    const holdsCount = Math.max(...products.flatMap((p) => p.holds.map(([h]) => h)));
    const id = ok(await ops.rpc('create_service', { p: {
      terminal_id: TERM, customer_id: customer, ...(typeof vessel === 'string' ? { vessel_id: vessel } : { vessel }), service_number: number,
      responsible_user_id: U[`operaciones@${domain}`], responsible_name: 'Carlos Méndez', cargo_type: bags ? 'bags' : 'bulk', holds_count: holdsCount,
      operation_kind: kind, operator_ids: operators,
      products: products.map((p) => ({ ...(P[p.name] ? { product_id: P[p.name] } : { product_name: p.name }), bag_weight_kg: p.bag ?? null, bag_tare_kg: p.tare ?? null, uses_bl: !!p.bls,
        holds: p.holds.map(([h, tm]) => ({ hold_number: h, planned_tm: tm })), bls: (p.bls ?? []).map(([n, tm]) => ({ bl_number: n, planned_tm: tm })) })),
      points, trucks: fleet.map((t) => ({ plate: t.plate, tractor_plate: t.tc, driver_name: t.driver, driver_dpi: t.dpi })) } }), number);
    if (status !== 'scheduled') ok(await ops.rpc('change_service_status', { p_service: id, p_status: status }), 'estado');
    return id;
  }
  const seq = {};
  // Cada camión de la lista del servicio hace viajes redondos: su ciclo es el tiempo entre dos pasadas por báscula.
  async function history(serviceId, hours, clientFor, fraction = 1) {
    const cargo = ok(await master.from('service_hold_cargo').select('id, service_hold_id, product_id, initial_tm').eq('service_id', serviceId), 'carga');
    const bls = ok(await master.from('service_bls').select('id, product_id, planned_tm, sort').eq('service_id', serviceId).order('sort'), 'bl');
    const pts = ok(await master.from('service_scales').select('scale_id, scale:scales(code)').eq('service_id', serviceId), 'puntos');
    const fleet = ok(await master.from('service_trucks').select('plate').eq('service_id', serviceId), 'camiones');
    const pend = Object.fromEntries(cargo.map((c) => [c.id, Number(c.initial_tm) * fraction]));
    const blLeft = Object.fromEntries(bls.map((b) => [b.id, Number(b.planned_tm) * fraction]));
    const start = Date.now() - hours * 3600e3;
    const passes = [];
    for (const { plate } of fleet) {
      const base = rr(38, 62);
      for (let t = start + rr(0, 50) * 60e3; t < Date.now() - 15 * 60e3; t += (base + rr(-6, 9) + (rnd() < 0.07 ? rr(25, 60) : 0)) * 60e3) passes.push({ t, plate });
    }
    passes.sort((a, b) => a.t - b.t);
    let n = 0;
    for (const { t, plate } of passes) {
      const opts2 = cargo.filter((c) => pend[c.id] > 40);
      if (!opts2.length) break;
      const c = opts2[Math.floor(rnd() * opts2.length)];
      const own = bls.filter((b) => b.product_id === c.product_id);
      const bl = own.find((b) => blLeft[b.id] > 0) ?? own.at(-1);
      const pt = pick(pts);
      const tr = META[plate];
      const net = Math.round(tr.cap * 1000 * rr(0.85, 0.97));
      const tare = tr.tare + ri(-120, 120);
      seq[pt.scale_id] = (seq[pt.scale_id] ?? ri(2000, 4000)) + 1;
      const r = await clientFor(pt.scale.code).rpc('register_weigh_ticket', { p: { client_request_id: crypto.randomUUID(), scale_id: pt.scale_id, service_id: serviceId,
        service_hold_id: c.service_hold_id, product_id: c.product_id, bl_id: bl?.id ?? null,
        ticket_number: `${pt.scale.code.replace(/\W/g, '')}-${String(seq[pt.scale_id]).padStart(6, '0')}`, truck_plate: plate, gross: tare + net, tare, weight_unit: 'kg', weighed_local: local(t) } });
      if (!r.error) { pend[c.id] -= net / 1000; if (bl) blLeft[bl.id] -= net / 1000; n++; }
    }
    for (const b of bls) if (blLeft[b.id] <= 0) ok(await ops.rpc('set_bl_status', { p_bl: b.id, p_status: 'completed' }), 'BL terminado');
    return n;
  }

  // Sacos: boletas por camión (placa, TC, boleta, lote y sacos), sacos dañados por turno y peso de sacos con temperatura.
  async function bagHistory(serviceId, client, days = 2) {
    const svc = ok(await master.from('services').select('shift_plan_id').eq('id', serviceId).single(), 'servicio');
    const shifts = ok(await master.from('shifts').select('id, start_time, end_time').eq('plan_id', svc.shift_plan_id).eq('status', 'active').order('sort'), 'turnos');
    const cargo = ok(await master.from('service_hold_cargo').select('service_hold_id, product_id, initial_tm').eq('service_id', serviceId), 'carga');
    const bls = ok(await master.from('service_bls').select('id, product_id, planned_tm').eq('service_id', serviceId).order('sort'), 'bl');
    const left = Object.fromEntries(bls.map((b) => [b.id, Number(b.planned_tm) * 1000 / 50]));
    const fleet = TRUCKS.slice(8, 18);
    const today = local(Date.now()).slice(0, 10);
    let n = 0, ticket = ri(1601000, 1601900), lot = 101;
    for (let d = days; d >= 1; d--) {
      const day = new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400e3).toISOString().slice(0, 10);
      for (const sh of shifts) {
        // Inicio del turno en hora local de Guatemala (UTC−6) → instante UTC.
        const t0 = Date.parse(`${day}T${sh.start_time.slice(0, 5)}:00Z`) + 6 * 3600e3;
        for (let k = 0; k < 12; k++) {
          const at = t0 + (15 + k * 35 + ri(0, 10)) * 60e3;
          if (at > Date.now() - 10 * 60e3) break;
          const c = cargo[(k + d) % cargo.length];
          const bags = ri(560, 700);
          const bl = bls.find((b) => b.product_id === c.product_id && left[b.id] > bags) ?? bls.filter((b) => b.product_id === c.product_id).at(-1);
          if (bl) left[bl.id] -= bags;
          const tr = fleet[k % fleet.length];
          ticket += ri(1, 3);
          if (k % 4 === 0) lot++;
          const lots = rnd() < 0.25 ? [{ lot: `L-${lot}`, bags: bags - 120 }, { lot: `L-${lot + 1}`, bags: 120 }] : [{ lot: `L-${lot}`, bags }];
          const r = await client.rpc('register_bag_tally', { p: { client_request_id: crypto.randomUUID(), service_id: serviceId, ticket_number: String(ticket), truck_plate: tr.plate, tractor_plate: tr.tc,
            service_hold_id: c.service_hold_id, product_id: c.product_id, bl_id: bl?.id ?? null, tallied_local: local(at), lots } });
          if (!r.error) n++;
          for (let j = 0; j < 3; j++) {
            await client.rpc('register_bag_sample', { p: { client_request_id: crypto.randomUUID(), service_id: serviceId, product_id: c.product_id, ticket_number: String(ticket),
              gross_kg: Number((50.18 + rr(0, 0.14)).toFixed(2)), temperature_c: Number(rr(30.5, 35).toFixed(1)), sampled_local: local(at + (j + 1) * 3 * 60e3) } });
          }
        }
        await client.rpc('set_bag_damages', { p: { service_id: serviceId, shift_id: sh.id, shift_date: day, dirty: ri(0, 2), broken: ri(0, 3), wet: ri(0, 1), to_sea: rnd() < 0.2 ? 1 : 0 } });
      }
    }
    return n;
  }

  log('Servicios y pesajes (puede tardar ~1 min)…');
  const ops1 = await login(`bascula1@${domain}`), ops2 = await login(`bascula2@${domain}`), ops3 = await login(`bascula3@${domain}`);
  const CL = { 'BAS-01': ops1, 'BAS-02': ops2, 'BAS-03': ops3 };
  const clientFor = (code) => CL[code] ?? ops3;
  const pt = (...codes) => codes.map((c) => ({ scale_id: S[c] }));
  const finalized = await makeService('SD-2026-0139', C['C-001'], V['MV Caribe Dawn'],
    [{ name: 'Urea', holds: [[1, 900]] }, { name: 'Fertilizante', holds: [[2, 850], [3, 700]] }], pt('BAS-01', 'BAS-02'), 'in_operation', { fleet: TRUCKS.slice(0, 5) });
  await history(finalized, 20, clientFor, 0.985);
  const kestrel = await makeService('SD-2026-0142', C['C-001'], V['MV Ocean Kestrel'],
    [{ name: 'Fertilizante', holds: [[1, 3000]] }, { name: 'Urea', holds: [[1, 2000]] }, { name: 'Carbón', holds: [[2, 5000]] },
     { name: 'Maíz', holds: [[3, 4500], [4, 5500]] }, { name: 'Trigo', holds: [[3, 2500], [5, 4000]] }], pt('BAS-01', 'BAS-02', 'BAS-03'), 'in_operation', { fleet: TRUCKS.slice(0, 14) });
  log('  SD-2026-0142:', await history(kestrel, 30, clientFor, 0.45), 'pesajes');
  const sumpul = await makeService('SD-2026-0143', C['C-002'], V['MV Río Sumpul'],
    [{ name: 'Soya', holds: [[1, 4200], [2, 3800]], bls: [['COSU-551020', 5000], ['COSU-551021', 3000]] },
     { name: 'Maíz', holds: [[2, 1000], [3, 4600]] }, { name: 'Trigo', holds: [[4, 3900]] }], pt('BAS-01', 'BAS-03'), 'in_operation', { fleet: TRUCKS.slice(4, 14) });
  log('  SD-2026-0143:', await history(sumpul, 11, clientFor, 0.4), 'pesajes');
  const harvest = await makeService('SD-2026-0145', C['C-002'], { name: 'MV Golden Harvest', imo_number: '9734561', flag: 'Malta' },
    [{ name: 'Azúcar blanca refinada', bag: 50, tare: 0.16, holds: [[1, 5100], [2, 7550], [3, 7550]], bls: [['MAEU-778201', 12000], ['MAEU-778202', 8200]] },
     { name: 'Arroz en sacos', bag: 50, tare: 0.12, holds: [[4, 2800], [5, 3300]], bls: [['MAEU-778215', 6100]] }],
    [], 'in_operation', { bags: true, fleet: TRUCKS.slice(8, 18), operators: [U[`bascula3@${domain}`]], kind: 'load' });
  log('  SD-2026-0145:', await bagHistory(harvest, ops3), 'boletas de sacos');
  await makeService('SD-2026-0144', C['C-003'], V['MV Santa Lucía Star'],
    [{ name: 'Carbón', holds: [6200, 6400, 6400, 6400, 6100].map((t, i) => [i + 1, t]) }], pt('BAS-01', 'BAS-02'), 'scheduled', { fleet: TRUCKS.slice(10, 18) });

  log('Tiempos perdidos y correcciones…');
  const causes = Object.fromEntries((ok(await sup.from('downtime_causes').select('id, name').eq('organization_id', ORG), 'causas')).map((c) => [c.name, c.id]));
  const kHolds = ok(await sup.from('service_holds').select('id, hold_number').eq('service_id', kestrel), 'bodegas');
  const ev = [['Falta de camiones', -27, 55, 'operation'], ['Falla de grab', -22, 40, 'hold', kHolds[2].id], ['Condiciones climáticas', -16, 75, 'operation'], ['Cambio de bodega', -12, 25, 'hold', kHolds[0].id], ['Mantenimiento', -9, 30, 'scale', null, S['BAS-03']], ['Falta de camiones', -5, 35, 'operation'], ['Espera de autorización', -3, 20, 'operation'], ['Otros', -7, 15, 'operation']];
  for (const [cause, h, mins, scope, hold, scale] of ev) {
    const t = Date.now() + h * 3600e3;
    ok(await sup.rpc('register_downtime', { p: { client_request_id: crypto.randomUUID(), service_id: kestrel, cause_id: causes[cause], started_local: local(t), ended_local: local(t + mins * 60e3), scope, service_hold_id: hold ?? null, scale_id: scale ?? null, observations: cause === 'Condiciones climáticas' ? 'Lluvia intensa; grúas detenidas por seguridad.' : cause === 'Otros' ? 'Simulacro de evacuación programado por la portuaria.' : null } }), 'tiempo perdido');
  }
  const someTickets = ok(await master.from('weigh_tickets').select('id, revision, tare_kg').eq('service_id', kestrel).eq('status', 'valid').order('registered_at', { ascending: false }).limit(3), 'tickets');
  ok(await sup.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: someTickets[0].id, p_action: 'update', p_changes: { tare_kg: Number(someTickets[0].tare_kg) + 220 }, p_reason: 'Tara repesada: el camión entró con lona húmeda' }), 'corrección');
  ok(await sup.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: someTickets[1].id, p_action: 'void', p_changes: {}, p_reason: 'Ticket duplicado por reimpresión en la báscula' }), 'anulación');
  const own = ok(await ops1.from('weigh_tickets').select('id').eq('service_id', kestrel).eq('scale_id', S['BAS-01']).eq('status', 'valid').order('registered_at', { ascending: false }).range(5, 5).single(), 'ticket propio');
  ok(await ops1.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: own.id, p_action: 'update', p_changes: { truck_plate: 'C-512KLM' }, p_reason: 'Matrícula mal digitada en báscula' }), 'solicitud');

  log('Cierre, informe y firma…');
  const sigPng = await signaturePng();
  const sp = `${ORG}/signatures/${crypto.randomUUID()}.png`; ok(await master.storage.from('org-assets').upload(sp, sigPng, { contentType: 'image/png' }), 'firma');
  const sealPath = `${ORG}/seals/${crypto.randomUUID()}.png`; ok(await master.storage.from('org-assets').upload(sealPath, await sealPng(), { contentType: 'image/png' }), 'sello');
  ok(await master.from('company_seals').insert({ organization_id: ORG, name: 'Sello corporativo', image_path: sealPath, is_default: true }), 'sello');
  ok(await master.from('authorized_signers').insert([{ organization_id: ORG, user_id: U[`master@${domain}`], full_name: 'Ana Lucía Morales', position: 'Gerente de Operaciones', signature_path: sp },
    { organization_id: ORG, user_id: U[`firmante@${domain}`], full_name: 'Ricardo Estrada', position: 'Representante legal' }]), 'firmantes');
  const closed = ok(await ops.rpc('close_service', { p_service: finalized, p_note: 'Remanente a bordo de 36 TM verificado con inspección de calado final.', p_conclusions: 'La operación se completó sin incidentes de seguridad. El ritmo promedio fue estable en ambas básculas.' }), 'cierre');
  const draft = await fn(master, 'report-worker', { job_id: closed.job_id });
  await fn(master, 'report-sign', { version_id: draft.version_id });

  log('Usuarios del portal…');
  for (const [email, name, cust] of [[`cliente.fertisur@${domain}`, 'Marta Girón', 'C-001'], [`cliente.molinos@${domain}`, 'Pedro Lima', 'C-002']]) {
    const id = await user(email, name, 'customer');
    const cu = ok(await admin.from('customer_users').insert({ customer_id: C[cust], user_id: id, organization_id: ORG }).select('id').single(), 'cliente');
    ok(await admin.from('customer_portal_permissions').insert({ customer_user_id: cu.id, organization_id: ORG, customer_id: C[cust] }), 'permisos');
  }
  ok(await master.from('scale_settings').insert({ scale_id: S['BAS-02'], organization_id: ORG, terminal_id: TERM, time_capture_mode: 'server_now' }), 'modo báscula 2');
  log('Datos de demostración listos.');
  return { status: 'created', organization_id: ORG };
}
