// Agrega a una demo EXISTENTE dos servicios que muestran el modelo por servicio:
//  · granel con BL, lista de camiones y básculas del servicio (ciclo entre pasadas);
//  · carga en sacos con boletas por camión (lotes), sacos dañados y peso de sacos con temperatura.
// Solo para entornos de demostración. No crea usuarios ni empresas.
export async function extendDemo({ createClient, url, anonKey, serviceKey, password, domain = 'vesselcontrol.example', numbers = ['SD-2026-0146', 'SD-2026-0145'], log = console.log }) {
  const TZ = 'America/Guatemala';
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(url, serviceKey, opts);
  const ok = (r, what) => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data; };
  const login = async (email) => { const c = createClient(url, anonKey, opts); ok(await c.auth.signInWithPassword({ email, password }), `login ${email}`); return c; };
  const local = (ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  let seed = 20261128; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rr = (a, b) => a + (b - a) * rnd(); const ri = (a, b) => Math.floor(rr(a, b + 1));

  const org = ok(await admin.from('organizations').select('id').order('created_at').limit(1).single(), 'empresa');
  const term = ok(await admin.from('terminals').select('id').eq('organization_id', org.id).order('created_at').limit(1).single(), 'terminal');
  const exists = ok(await admin.from('services').select('service_number').eq('organization_id', org.id).in('service_number', numbers), 'servicios');
  if (exists.length) return { status: 'exists', services: exists.map((s) => s.service_number) };
  const C = Object.fromEntries(ok(await admin.from('customers').select('id, code').eq('organization_id', org.id), 'clientes').map((c) => [c.code, c.id]));
  const S = Object.fromEntries(ok(await admin.from('scales').select('id, code').eq('terminal_id', term.id), 'básculas').map((s) => [s.code, s.id]));
  const uid = async (email) => ok(await admin.from('user_profiles').select('user_id').eq('email', email).single(), email).user_id;
  const ops = await login(`operaciones@${domain}`);
  const CL = { 'BAS-01': await login(`bascula1@${domain}`), 'BAS-03': await login(`bascula3@${domain}`) };
  const L = 'BCDFGHJKLMNPRSTVWXYZ';
  const NAMES = ['Josué Ixcot Pérez', 'Rubén Cotí Lux', 'Carlos Sicán Toj', 'Gerson Batz Ajú', 'Luis Mejía Ordóñez', 'Pablo Tuyuc Simón', 'Ángel Xoy Chávez', 'Rolando Pirir Coc', 'Dimas Tun Ical', 'Esteban Yat Cuc', 'Mynor Chiquín Pop', 'Abner Sut Tzoc'];
  const fleet = NAMES.map((n) => ({ plate: `C-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, tc: `TC-${ri(100, 999)}${L[ri(0, 19)]}${L[ri(0, 19)]}${L[ri(0, 19)]}`, driver: n, cap: [30, 32, 34][ri(0, 2)], tare: ri(13800, 16200) }));
  const trucks = fleet.map((t) => ({ plate: t.plate, tractor_plate: t.tc, driver_name: t.driver }));

  // ---------------------------------------------------------------- granel con BL
  log('Servicio a granel con BL…');
  const bulk = ok(await ops.rpc('create_service', { p: {
    terminal_id: term.id, customer_id: C['C-001'], service_number: numbers[0], cargo_type: 'bulk', operation_kind: 'discharge', holds_count: 4,
    vessel: { name: 'MV Pacific Grain', imo_number: '9721843', flag: 'Panamá' }, responsible_name: 'Carlos Méndez',
    products: [
      { product_name: 'Maíz amarillo', uses_bl: true, holds: [{ hold_number: 1, planned_tm: 3500 }, { hold_number: 2, planned_tm: 3500 }], bls: [{ bl_number: 'HLCU-440211', planned_tm: 4000 }, { bl_number: 'HLCU-440212', planned_tm: 3000 }] },
      { product_name: 'Trigo', holds: [{ hold_number: 3, planned_tm: 2800 }, { hold_number: 4, planned_tm: 3200 }] }],
    points: [{ scale_id: S['BAS-01'] }, { scale_id: S['BAS-03'] }], trucks } }), numbers[0]);
  ok(await ops.rpc('change_service_status', { p_service: bulk, p_status: 'in_operation' }), 'estado');
  const cargo = ok(await admin.from('service_hold_cargo').select('id, service_hold_id, product_id, initial_tm').eq('service_id', bulk), 'carga');
  const bls = ok(await admin.from('service_bls').select('id, product_id, planned_tm').eq('service_id', bulk).order('sort'), 'bl');
  const pend = Object.fromEntries(cargo.map((c) => [c.id, Number(c.initial_tm) * 0.4]));
  const blLeft = Object.fromEntries(bls.map((b) => [b.id, Number(b.planned_tm) * 0.4]));
  const start = Date.now() - 14 * 3600e3; const passes = [];
  for (const t of fleet) { const base = rr(40, 60); for (let at = start + rr(0, 45) * 60e3; at < Date.now() - 15 * 60e3; at += (base + rr(-6, 9) + (rnd() < 0.07 ? rr(25, 50) : 0)) * 60e3) passes.push({ at, t }); }
  passes.sort((a, b) => a.at - b.at);
  const seq = { 'BAS-01': ri(5100, 5400), 'BAS-03': ri(3100, 3400) };
  let n = 0;
  for (const { at, t } of passes) {
    const opts2 = cargo.filter((c) => pend[c.id] > 40); if (!opts2.length) break;
    const c = opts2[Math.floor(rnd() * opts2.length)];
    const own = bls.filter((b) => b.product_id === c.product_id); const bl = own.find((b) => blLeft[b.id] > 0) ?? own.at(-1);
    const code = rnd() < 0.55 ? 'BAS-01' : 'BAS-03'; seq[code]++;
    const net = Math.round(t.cap * 1000 * rr(0.86, 0.97)); const tare = t.tare + ri(-100, 100);
    const r = await CL[code].rpc('register_weigh_ticket', { p: { client_request_id: crypto.randomUUID(), scale_id: S[code], service_id: bulk, service_hold_id: c.service_hold_id, product_id: c.product_id,
      bl_id: bl?.id ?? null, ticket_number: `${code.replace('-', '')}-${String(seq[code]).padStart(6, '0')}`, truck_plate: t.plate, gross: tare + net, tare, weight_unit: 'kg', weighed_local: local(at) } });
    if (!r.error) { pend[c.id] -= net / 1000; if (bl) blLeft[bl.id] -= net / 1000; n++; }
  }
  log(`  ${numbers[0]}: ${n} boletas`);

  // ---------------------------------------------------------------- carga en sacos
  log('Servicio de carga en sacos…');
  const bags = ok(await ops.rpc('create_service', { p: {
    terminal_id: term.id, customer_id: C['C-002'], service_number: numbers[1], cargo_type: 'bags', operation_kind: 'load', holds_count: 5,
    vessel: { name: 'MV Golden Harvest', imo_number: '9734561', flag: 'Malta' }, responsible_name: 'Carlos Méndez', operator_ids: [await uid(`bascula3@${domain}`)],
    products: [
      { product_name: 'Azúcar blanca refinada', bag_weight_kg: 50, bag_tare_kg: 0.16, uses_bl: true, holds: [[1, 5100], [2, 7550], [3, 7550]].map(([h, tm]) => ({ hold_number: h, planned_tm: tm })), bls: [{ bl_number: 'MAEU-778201', planned_tm: 12000 }, { bl_number: 'MAEU-778202', planned_tm: 8200 }] },
      { product_name: 'Arroz en sacos', bag_weight_kg: 50, bag_tare_kg: 0.12, uses_bl: true, holds: [[4, 2800], [5, 3300]].map(([h, tm]) => ({ hold_number: h, planned_tm: tm })), bls: [{ bl_number: 'MAEU-778215', planned_tm: 6100 }] }],
    trucks } }), numbers[1]);
  ok(await ops.rpc('change_service_status', { p_service: bags, p_status: 'in_operation' }), 'estado');
  const svc = ok(await admin.from('services').select('shift_plan_id').eq('id', bags).single(), 'servicio');
  const shifts = ok(await admin.from('shifts').select('id, start_time').eq('plan_id', svc.shift_plan_id).eq('status', 'active').order('sort'), 'turnos');
  const bc = ok(await admin.from('service_hold_cargo').select('service_hold_id, product_id').eq('service_id', bags), 'carga');
  const bb = ok(await admin.from('service_bls').select('id, product_id, planned_tm').eq('service_id', bags).order('sort'), 'bl');
  const left = Object.fromEntries(bb.map((b) => [b.id, Number(b.planned_tm) * 20]));
  const op3 = CL['BAS-03'];
  const today = local(Date.now()).slice(0, 10);
  let m = 0, ticket = ri(1601000, 1601900), lot = 101;
  for (let d = 2; d >= 1; d--) {
    const day = new Date(Date.parse(`${today}T12:00:00Z`) - d * 86400e3).toISOString().slice(0, 10);
    for (const sh of shifts) {
      const t0 = Date.parse(`${day}T${sh.start_time.slice(0, 5)}:00Z`) + 6 * 3600e3;
      for (let k = 0; k < 12; k++) {
        const at = t0 + (15 + k * 35 + ri(0, 10)) * 60e3; if (at > Date.now() - 10 * 60e3) break;
        const c = bc[(k + d) % bc.length]; const nb = ri(560, 700);
        const bl = bb.find((b) => b.product_id === c.product_id && left[b.id] > nb) ?? bb.filter((b) => b.product_id === c.product_id).at(-1);
        if (bl) left[bl.id] -= nb;
        const t = fleet[k % fleet.length]; ticket += ri(1, 3); if (k % 4 === 0) lot++;
        const lots = rnd() < 0.25 ? [{ lot: `L-${lot}`, bags: nb - 120 }, { lot: `L-${lot + 1}`, bags: 120 }] : [{ lot: `L-${lot}`, bags: nb }];
        const r = await op3.rpc('register_bag_tally', { p: { client_request_id: crypto.randomUUID(), service_id: bags, ticket_number: String(ticket), truck_plate: t.plate, tractor_plate: t.tc,
          service_hold_id: c.service_hold_id, product_id: c.product_id, bl_id: bl?.id ?? null, tallied_local: local(at), lots } });
        if (!r.error) m++;
        for (let j = 0; j < 3; j++) {
          await op3.rpc('register_bag_sample', { p: { client_request_id: crypto.randomUUID(), service_id: bags, product_id: c.product_id, ticket_number: String(ticket),
            gross_kg: Number((50.18 + rr(0, 0.14)).toFixed(2)), temperature_c: Number(rr(30.5, 35).toFixed(1)), sampled_local: local(at + (j + 1) * 3 * 60e3) } });
        }
      }
      await op3.rpc('set_bag_damages', { p: { service_id: bags, shift_id: sh.id, shift_date: day, dirty: ri(0, 2), broken: ri(0, 3), wet: ri(0, 1), to_sea: rnd() < 0.2 ? 1 : 0 } });
    }
  }
  log(`  ${numbers[1]}: ${m} boletas de sacos`);
  return { status: 'created', services: numbers };
}
