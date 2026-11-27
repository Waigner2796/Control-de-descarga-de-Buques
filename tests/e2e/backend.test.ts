/**
 * Pruebas obligatorias de backend (sección 21) contra el stack Supabase local real:
 * GoTrue (Auth) + PostgREST + RLS + funciones transaccionales.
 * Ejecutar con: npx supabase start && npm run test:e2e
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { addMember, admin, anon, createUser, localStamp, ok, PASSWORD, signIn, uniq } from './helpers';

const TZ = 'America/Guatemala';
const run = uniq();
const mail = (n: string) => `${n}.${run}@vc.test`;

type World = {
  orgA: string; orgB: string; termA: string; termB: string;
  custA1: string; custA2: string; custB1: string;
  vessel: string; prodFert: string; prodUrea: string; prodMaiz: string;
  scale1: string; scale2: string; scale3: string;
  service: string; hold1: string; hold2: string; cargoFert: string; cargoUrea: string; cargoMaiz: string;
  serviceB: string;
  c: Record<string, SupabaseClient>;
  uid: Record<string, string>;
};
const W = {} as World;

let ticketSeq = 1000;
const nextTicket = () => `T-${run}-${ticketSeq++}`;

function ticketPayload(o: Partial<Record<string, unknown>> = {}) {
  return {
    client_request_id: randomUUID(), scale_id: W.scale1, service_id: W.service, service_hold_id: W.hold1, product_id: W.prodFert,
    ticket_number: nextTicket(), truck_plate: 'C-123BCD', tractor_plate: 'TC-456FGH', driver_name: 'Juan Pérez López',
    driver_dpi: '2456 78901 0101', nominal_capacity_tm: 32, gross: 46000, tare: 15000, weight_unit: 'kg',
    weighed_local: localStamp(TZ, -27), ...o,
  };
}

async function cargo(id: string) {
  return ok(await admin().from('service_hold_cargo').select('initial_tm, discharged_tm').eq('id', id).single()) as { initial_tm: number; discharged_tm: number };
}
async function ledgerSum(id: string) {
  const rows = ok(await admin().from('cargo_movements').select('quantity_tm').eq('cargo_id', id)) as { quantity_tm: number }[];
  return rows.reduce((a, r) => a + Number(r.quantity_tm), 0);
}
async function validTicketSum(id: string) {
  const rows = ok(await admin().from('weigh_tickets').select('net_tm').eq('cargo_id', id).eq('status', 'valid')) as { net_tm: number }[];
  return rows.reduce((a, r) => a + Number(r.net_tm), 0);
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

beforeAll(async () => {
  const a = admin();
  W.uid = {}; W.c = {};
  // Administrador de plataforma → crea dos empresas
  W.uid.platform = await createUser(mail('platform'), 'Admin Plataforma');
  ok(await a.from('platform_admins').insert({ user_id: W.uid.platform }));
  W.c.platform = await signIn(mail('platform'));
  const A = ok(await W.c.platform.rpc('platform_create_organization', { p: { name: `Estibadora A ${run}`, terminal_name: 'Terminal Quetzal', timezone: TZ } })) as { organization_id: string; terminal_id: string };
  const B = ok(await W.c.platform.rpc('platform_create_organization', { p: { name: `Logística B ${run}`, terminal_name: 'Terminal Barrios', timezone: TZ } })) as { organization_id: string; terminal_id: string };
  W.orgA = A.organization_id; W.termA = A.terminal_id; W.orgB = B.organization_id; W.termB = B.terminal_id;

  // Usuarios internos
  const staff: [string, string, string][] = [
    ['masterA', 'master_admin', W.orgA], ['opsA', 'ops_admin', W.orgA], ['supA', 'supervisor', W.orgA],
    ['op1', 'scale_operator', W.orgA], ['op2', 'scale_operator', W.orgA], ['analystA', 'analyst', W.orgA],
    ['signerA', 'signer', W.orgA], ['masterB', 'master_admin', W.orgB],
  ];
  for (const [k, role, org] of staff) {
    W.uid[k] = await createUser(mail(k), `Usuario ${k}`);
    await addMember(org, W.uid[k], role);
  }
  for (const k of ['masterA', 'opsA', 'supA', 'op1', 'op2', 'analystA', 'signerA', 'masterB']) W.c[k] = await signIn(mail(k));

  // Catálogos de A (creados por usuarios con permisos, a través de RLS)
  const m = W.c.masterA;
  W.custA1 = (ok(await m.from('customers').insert({ organization_id: W.orgA, code: 'C-001', trade_name: 'Fertilizantes del Sur' }).select('id').single()) as { id: string }).id;
  W.custA2 = (ok(await W.c.opsA.from('customers').insert({ organization_id: W.orgA, code: 'C-002', trade_name: 'Molinos de Centroamérica' }).select('id').single()) as { id: string }).id;
  W.custB1 = (ok(await W.c.masterB.from('customers').insert({ organization_id: W.orgB, code: 'C-001', trade_name: 'Energía del Pacífico' }).select('id').single()) as { id: string }).id;
  W.vessel = (ok(await m.from('vessels').insert({ organization_id: W.orgA, name: 'MV Ocean Kestrel', imo_number: '9785412', holds_count: 5 }).select('id').single()) as { id: string }).id;
  const prods = ok(await m.from('products').insert([
    { organization_id: W.orgA, name: 'Fertilizante', color: '#4c9a4f' },
    { organization_id: W.orgA, name: 'Urea', color: '#b4c5d4' },
    { organization_id: W.orgA, name: 'Maíz', color: '#f0b400' }]).select('id, name')) as { id: string; name: string }[];
  W.prodFert = prods.find((p) => p.name === 'Fertilizante')!.id; W.prodUrea = prods.find((p) => p.name === 'Urea')!.id; W.prodMaiz = prods.find((p) => p.name === 'Maíz')!.id;
  const scales = ok(await m.from('scales').insert([
    { terminal_id: W.termA, organization_id: W.orgA, code: 'BAS-01', name: 'Báscula 1' },
    { terminal_id: W.termA, organization_id: W.orgA, code: 'BAS-02', name: 'Báscula 2' },
    { terminal_id: W.termA, organization_id: W.orgA, code: 'BAS-03', name: 'Báscula 3' }]).select('id, code')) as { id: string; code: string }[];
  W.scale1 = scales.find((s) => s.code === 'BAS-01')!.id; W.scale2 = scales.find((s) => s.code === 'BAS-02')!.id; W.scale3 = scales.find((s) => s.code === 'BAS-03')!.id;
  ok(await m.from('scale_users').insert([
    { scale_id: W.scale1, user_id: W.uid.op1, organization_id: W.orgA, terminal_id: W.termA },
    { scale_id: W.scale2, user_id: W.uid.op2, organization_id: W.orgA, terminal_id: W.termA }]));
  // Báscula 2 en modalidad "hora actual del servidor"
  ok(await m.from('scale_settings').insert({ scale_id: W.scale2, organization_id: W.orgA, terminal_id: W.termA, time_capture_mode: 'server_now' }));

  // Servicio con número MANUAL, bodega 1 con dos productos
  W.service = ok(await W.c.opsA.rpc('create_service', { p: {
    terminal_id: W.termA, customer_id: W.custA1, vessel_id: W.vessel, service_number: `SV-2026-${run}`,
    responsible_name: 'Carlos Méndez', scale_ids: [W.scale1, W.scale2],
    holds: [{ hold_number: 1, cargo: [{ product_id: W.prodFert, initial_tm: 3000 }, { product_id: W.prodUrea, initial_tm: 2000 }] },
            { hold_number: 2, cargo: [{ product_id: W.prodMaiz, initial_tm: 5000 }] }] } })) as string;
  const holds = ok(await m.from('service_holds').select('id, hold_number').eq('service_id', W.service)) as { id: string; hold_number: number }[];
  W.hold1 = holds.find((h) => h.hold_number === 1)!.id; W.hold2 = holds.find((h) => h.hold_number === 2)!.id;
  const cg = ok(await m.from('service_hold_cargo').select('id, product_id').eq('service_id', W.service)) as { id: string; product_id: string }[];
  W.cargoFert = cg.find((c) => c.product_id === W.prodFert)!.id; W.cargoUrea = cg.find((c) => c.product_id === W.prodUrea)!.id; W.cargoMaiz = cg.find((c) => c.product_id === W.prodMaiz)!.id;
  ok(await W.c.opsA.rpc('change_service_status', { p_service: W.service, p_status: 'in_operation' }));

  // Servicio de la empresa B
  const vB = (ok(await W.c.masterB.from('vessels').insert({ organization_id: W.orgB, name: 'MV Atlantic', holds_count: 2 }).select('id').single()) as { id: string }).id;
  W.serviceB = ok(await W.c.masterB.rpc('create_service', { p: { terminal_id: W.termB, customer_id: W.custB1, vessel_id: vB, service_number: `SV-2026-${run}`,
    holds_count: 2, products: [{ product_name: 'Carbón', holds: [{ hold_number: 1, planned_tm: 1000 }] }] } })) as string;

  // Usuarios del portal
  for (const [k, cust] of [['cuA1', W.custA1], ['cuA2', W.custA2], ['cuB1', W.custB1]] as const) {
    W.uid[k] = await createUser(mail(k), `Cliente ${k}`, 'customer');
    ok(await a.from('customer_users').insert({ customer_id: cust, user_id: W.uid[k], organization_id: W.orgA }));
    W.c[k] = await signIn(mail(k));
  }
}, 120_000);

describe('Multiempresa, servicios y números manuales', () => {
  it('el número de servicio es manual y único por empresa (otra empresa puede repetirlo)', async () => {
    const svc = ok(await W.c.masterA.from('services').select('service_number').eq('id', W.service).single()) as { service_number: string };
    expect(svc.service_number).toBe(`SV-2026-${run}`);
    const dup = await W.c.opsA.rpc('create_service', { p: { terminal_id: W.termA, customer_id: W.custA2, vessel_id: W.vessel, service_number: `sv-2026-${run}` } });
    expect(dup.error?.message).toMatch(/ya existe/);
    const svcB = ok(await W.c.masterB.from('services').select('service_number').eq('id', W.serviceB).single()) as { service_number: string };
    expect(svcB.service_number).toBe(`SV-2026-${run}`);
  });

  it('organization_id no se puede falsificar: el hijo hereda del padre', async () => {
    const h = ok(await W.c.masterA.from('service_holds').select('organization_id, terminal_id').eq('id', W.hold1).single()) as { organization_id: string; terminal_id: string };
    expect(h.organization_id).toBe(W.orgA);
    expect(h.terminal_id).toBe(W.termA);
  });

  it('una bodega admite varios productos con saldos independientes', async () => {
    const rows = ok(await W.c.masterA.from('service_hold_cargo').select('id').eq('service_hold_id', W.hold1)) as unknown[];
    expect(rows.length).toBe(2);
  });
});

describe('Aislamiento (RLS) entre clientes y empresas', () => {
  it('el cliente A1 ve su servicio; el cliente A2 no, ni modificando el UUID', async () => {
    const own = ok(await W.c.cuA1.from('services').select('id').eq('id', W.service)) as unknown[];
    expect(own.length).toBe(1);
    const other = ok(await W.c.cuA2.from('services').select('id').eq('id', W.service)) as unknown[];
    expect(other.length).toBe(0);
    const ov = ok(await W.c.cuA2.from('service_overview').select('id')) as unknown[];
    expect(ov.length).toBe(0);
    const k = await W.c.cuA2.rpc('service_kpis', { p_service: W.service });
    expect(k.error?.message).toMatch(/sin acceso/);
  });

  it('un cliente no ve pesajes individuales, tiempos perdidos ni auditoría', async () => {
    for (const t of ['weigh_tickets', 'downtime_events', 'audit_logs', 'cargo_movements', 'organization_members', 'drivers']) {
      const rows = ok(await W.c.cuA1.from(t).select('*').limit(5)) as unknown[];
      expect(rows.length, t).toBe(0);
    }
  });

  it('la empresa B no ve datos de la empresa A (ni por id)', async () => {
    for (const [t, id] of [['services', W.service], ['customers', W.custA1], ['vessels', W.vessel], ['scales', W.scale1]] as const) {
      const rows = ok(await W.c.masterB.from(t).select('id').eq('id', id)) as unknown[];
      expect(rows.length, t).toBe(0);
    }
    const rpc = await W.c.masterB.rpc('service_kpis', { p_service: W.service });
    expect(rpc.error).toBeTruthy();
    const reg = await W.c.masterB.rpc('register_weigh_ticket', { p: ticketPayload() });
    expect(reg.error?.message).toMatch(/autorizado/);
  });

  it('anon no puede leer ninguna tabla', async () => {
    for (const t of ['services', 'customers', 'weigh_tickets', 'organizations', 'report_versions']) {
      const r = await anon().from(t).select('*').limit(1);
      expect(r.data ?? [], t).toHaveLength(0);
    }
  });

  it('anon no puede invocar RPC; solo la verificación pública de informes', async () => {
    for (const [f, args] of [['register_weigh_ticket', { p: {} }], ['my_context', {}], ['service_kpis', { p_service: W.service }], ['platform_create_organization', { p: { name: 'x' } }]] as const) {
      const r = await anon().rpc(f, args);
      expect(r.error?.code, f).toBe('42501');
    }
    const v = await anon().rpc('verify_report', { p_code: 'VC-NADA' });
    expect(v.error).toBeNull();
  });

  it('un cliente no puede escribir en servicios, cargas ni pesajes', async () => {
    const u = await W.c.cuA1.from('services').update({ observations: 'hack' }).eq('id', W.service).select();
    expect(u.error || (u.data ?? []).length === 0).toBeTruthy();
    const r = await W.c.cuA1.rpc('register_weigh_ticket', { p: ticketPayload() });
    expect(r.error).toBeTruthy();
    const c = await W.c.cuA1.from('service_hold_cargo').update({ initial_tm: 1 }).eq('id', W.cargoFert).select();
    expect(c.error || (c.data ?? []).length === 0).toBeTruthy();
  });
});

describe('Pesajes manuales, modalidades de hora y saldos', () => {
  it('registra un pesaje manual: neto = bruto − tara y descuenta del producto y bodega', async () => {
    const before = await cargo(W.cargoFert);
    const res = ok(await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ gross: 46250, tare: 15230 }) })) as { net_tm: number; duplicate: boolean };
    expect(res.duplicate).toBe(false);
    expect(Number(res.net_tm)).toBe(31.02);
    const after = await cargo(W.cargoFert);
    expect(r3(Number(after.discharged_tm) - Number(before.discharged_tm))).toBe(31.02);
    const urea = await cargo(W.cargoUrea);
    expect(Number(urea.discharged_tm)).toBe(0);
  });

  it('rechaza pesos inválidos: negativos, bruto < tara', async () => {
    const e1 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ gross: -5, tare: 100 }) });
    expect(e1.error?.message).toMatch(/mayores que cero/);
    const e2 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ gross: 10000, tare: 15000 }) });
    expect(e2.error?.message).toMatch(/bruto debe ser mayor/);
  });

  it('modalidad manual: exige una sola hora y no admite horas futuras', async () => {
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ weighed_local: localStamp(TZ, 60) }) });
    expect(e.error?.message).toMatch(/futuro/);
    const e2 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ weighed_local: null }) });
    expect(e2.error?.message).toMatch(/hora del pesaje/);
  });

  it('el operador solo registra en sus básculas autorizadas; analista y cliente no registran', async () => {
    const e1 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ scale_id: W.scale2 }) });
    expect(e1.error?.message).toMatch(/autorizado/);
    const e2 = await W.c.analystA.rpc('register_weigh_ticket', { p: ticketPayload() });
    expect(e2.error?.message).toMatch(/autorizado/);
    const e3 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ scale_id: W.scale3 }) });
    expect(e3.error?.message).toMatch(/autorizado/);
  });

  it('modalidad "hora del servidor": la hora la fija el servidor, no el navegador', async () => {
    const t0 = Date.now();
    const res = ok(await W.c.op2.rpc('register_weigh_ticket', { p: ticketPayload({
      scale_id: W.scale2, service_hold_id: W.hold2, product_id: W.prodMaiz, weighed_local: '2020-01-01T00:00' }) })) as { ticket_id: string; weighed_at: string };
    expect(Math.abs(new Date(res.weighed_at).getTime() - t0)).toBeLessThan(60_000);
    const t = ok(await W.c.masterA.from('weigh_tickets').select('time_capture_mode').eq('id', res.ticket_id).single()) as { time_capture_mode: string };
    expect(t.time_capture_mode).toBe('server_now');
  });

  it('no permite exceder el saldo pendiente (nunca saldos negativos)', async () => {
    const c = await cargo(W.cargoUrea);
    const pending = Number(c.initial_tm) - Number(c.discharged_tm);
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ product_id: W.prodUrea, gross: 15000 + (pending + 1) * 1000, tare: 15000 }) });
    expect(e.error).toBeTruthy();
  });

  it('el saldo acumulado no se puede modificar directamente', async () => {
    const r = await W.c.masterA.from('service_hold_cargo').update({ discharged_tm: 0 }).eq('id', W.cargoFert).select();
    expect(r.error).toBeTruthy();
    const r2 = await W.c.masterA.from('weigh_tickets').update({ gross_kg: 1 }).eq('service_id', W.service).select();
    expect(r2.error).toBeTruthy();
    const r3_ = await W.c.masterA.from('weigh_tickets').delete().eq('service_id', W.service).select();
    expect(r3_.error).toBeTruthy();
  });
});

describe('Concurrencia e idempotencia', () => {
  it('reintentos con el mismo client_request_id crean un único ticket y un único descuento', async () => {
    const before = await cargo(W.cargoMaiz);
    const p = ticketPayload({ service_hold_id: W.hold2, product_id: W.prodMaiz, gross: 45000, tare: 15000 });
    const results = await Promise.all(Array.from({ length: 6 }, () => W.c.op1.rpc('register_weigh_ticket', { p })));
    results.forEach((r) => expect(r.error).toBeNull());
    const ids = new Set(results.map((r) => (r.data as { ticket_id: string }).ticket_id));
    expect(ids.size).toBe(1);
    const after = await cargo(W.cargoMaiz);
    expect(r3(Number(after.discharged_tm) - Number(before.discharged_tm))).toBe(30);
  });

  it('registros simultáneos desde dos básculas sobre el mismo saldo no sobre-descuentan', async () => {
    // Deja la urea con un saldo de exactamente 100 TM y lanza 6 pesajes concurrentes de 30 TM
    const c0 = await cargo(W.cargoUrea);
    const pending0 = r3(Number(c0.initial_tm) - Number(c0.discharged_tm));
    ok(await W.c.opsA.rpc('adjust_cargo_initial', { p_cargo: W.cargoUrea, p_new_initial: r3(Number(c0.initial_tm) - pending0 + 100), p_reason: 'Prueba de concurrencia: ajuste de manifiesto' }));
    ok(await W.c.masterA.from('scale_users').insert({ scale_id: W.scale1, user_id: W.uid.op2, organization_id: W.orgA, terminal_id: W.termA }));
    const clients = [W.c.op1, W.c.op2, W.c.op1, W.c.op2, W.c.op1, W.c.op2];
    const res = await Promise.all(clients.map((cl) => cl.rpc('register_weigh_ticket', { p: ticketPayload({ product_id: W.prodUrea, gross: 45000, tare: 15000 }) })));
    const okCount = res.filter((r) => !r.error).length;
    expect(okCount).toBe(3);
    const c1 = await cargo(W.cargoUrea);
    expect(r3(Number(c1.initial_tm) - Number(c1.discharged_tm))).toBe(10);
    expect(r3(await ledgerSum(W.cargoUrea))).toBe(r3(Number(c1.discharged_tm)));
    expect(r3(await validTicketSum(W.cargoUrea))).toBe(r3(Number(c1.discharged_tm)));
  });
});

describe('Ciclos con paginación del lado del servidor', () => {
  it('pagina, cuenta, filtra y ordena en el servidor', async () => {
    const batch = Array.from({ length: 30 }, (_, i) => ticketPayload({ service_hold_id: W.hold2, product_id: W.prodMaiz, gross: 40000, tare: 15000,
      truck_plate: i % 2 ? 'C-777XYZ' : 'C-555ABC', weighed_local: localStamp(TZ, -297 + i * 5) }));
    for (const p of batch) ok(await W.c.op1.rpc('register_weigh_ticket', { p }));
    const page1 = await W.c.supA.from('operational_cycles').select('id, truck_plate, cycle_minutes', { count: 'exact' })
      .eq('service_id', W.service).order('weighed_at', { ascending: false }).range(0, 24);
    expect(page1.error).toBeNull();
    expect(page1.data!.length).toBe(25);
    expect(page1.count!).toBeGreaterThanOrEqual(33);
    const page2 = await W.c.supA.from('operational_cycles').select('id', { count: 'exact' }).eq('service_id', W.service)
      .order('weighed_at', { ascending: false }).range(25, 49);
    expect(page2.data!.length).toBe(page1.count! - 25);
    const filtered = await W.c.supA.from('operational_cycles').select('id', { count: 'exact', head: true }).eq('service_id', W.service).ilike('truck_plate', '%777%');
    expect(filtered.count).toBe(15);
    expect(page1.data!.every((r) => Number(r.cycle_minutes) >= 0)).toBe(true);
    // Ciclo = tiempo entre dos pasadas consecutivas del mismo camión (cada 10 min en este lote).
    const passes = ok(await W.c.supA.from('operational_cycles').select('cycle_minutes').eq('service_id', W.service).eq('truck_plate', 'C-777XYZ').order('weighed_at')) as { cycle_minutes: number | null }[];
    expect(passes[0].cycle_minutes).toBeNull();
    expect(passes.slice(1).every((r) => Number(r.cycle_minutes) === 10)).toBe(true);
  });

  it('el operador solo ve los ciclos de sus básculas', async () => {
    const rows = ok(await W.c.op2.from('operational_cycles').select('scale_id').eq('service_id', W.service)) as { scale_id: string }[];
    expect(rows.every((r) => [W.scale1, W.scale2].includes(r.scale_id))).toBe(true);
    const sup = await W.c.supA.from('weigh_tickets').select('id', { count: 'exact', head: true }).eq('service_id', W.service);
    expect(sup.count!).toBeGreaterThan(rows.length - 1);
  });
});

describe('Servicio definido al crearlo: buque, BL, sacos, camiones y puntos de descarga', () => {
  const S = {} as { id: string; hold1: string; hold2: string; blA: string; blB: string; point: string; truck1: string; prod: string };
  const pay = (o: Partial<Record<string, unknown>> = {}) => ({
    client_request_id: randomUUID(), scale_id: S.point, service_id: S.id, service_hold_id: S.hold1, bl_id: S.blA,
    ticket_number: nextTicket(), service_truck_id: S.truck1, gross: 45000, tare: 15000, weight_unit: 'kg', weighed_local: localStamp(TZ, -5), ...o,
  });
  const base = () => ({
    terminal_id: W.termA, customer_id: W.custA1, service_number: `BL-${run}`, cargo_type: 'bulk',
    vessel: { name: `MV Bahía Serena ${run}`, flag: 'Panamá' }, holds_count: 3,
    products: [{ product_name: `Arroz ${run}`, uses_bl: true,
                 holds: [{ hold_number: 1, planned_tm: 600 }, { hold_number: 2, planned_tm: 400 }],
                 bls: [{ bl_number: `BLA-${run}`, planned_tm: 700 }, { bl_number: `BLB-${run}`, planned_tm: 300 }] }],
    points: [{ name: `Punto Muelle 4 ${run}`, operator_ids: [W.uid.op1] }],
    trucks: [{ plate: 'c-100 aaa', driver_name: 'Pedro Ruiz' }, { plate: 'C-200BBB', driver_name: 'Luis Gómez', driver_dpi: '1234 56789 0123' }],
  });

  it('valida bodegas (1 a 6), peso del saco y que la suma de los BL cuadre', async () => {
    const e1 = await W.c.opsA.rpc('create_service', { p: { ...base(), service_number: `X1-${run}`, holds_count: 7 } });
    expect(e1.error?.message).toMatch(/1 a 6 bodegas/);
    const e2 = await W.c.opsA.rpc('create_service', { p: { ...base(), service_number: `X2-${run}`, cargo_type: 'bags', products: [{ ...base().products[0], bag_weight_kg: null }] } });
    expect(e2.error?.message).toMatch(/peso por saco/);
    const e3 = await W.c.opsA.rpc('create_service', { p: { ...base(), service_number: `X3-${run}`, products: [{ ...base().products[0], bls: [{ bl_number: 'BL1', planned_tm: 900 }] }] } });
    expect(e3.error?.message).toMatch(/suma de los BL/);
    const none = ok(await W.c.opsA.from('services').select('id').in('service_number', [`X1-${run}`, `X2-${run}`, `X3-${run}`])) as unknown[];
    expect(none.length).toBe(0);
  });

  it('crea el servicio con buque nuevo, bodegas, BL, punto de descarga y su lista de camiones', async () => {
    S.id = ok(await W.c.opsA.rpc('create_service', { p: base() })) as string;
    const svc = ok(await W.c.opsA.from('services').select('cargo_type, vessel:vessels(name, holds_count)').eq('id', S.id).single()) as any;
    expect(svc.cargo_type).toBe('bulk');
    expect(svc.vessel.name).toBe(`MV Bahía Serena ${run}`);
    const holds = ok(await W.c.opsA.from('service_holds').select('id, hold_number').eq('service_id', S.id).order('hold_number')) as { id: string; hold_number: number }[];
    expect(holds.map((h) => h.hold_number)).toEqual([1, 2, 3]);
    S.hold1 = holds[0].id; S.hold2 = holds[1].id;
    const bls = ok(await W.c.opsA.from('service_bls').select('id, bl_number, planned_tm, product_id').eq('service_id', S.id).order('sort')) as { id: string; bl_number: string; planned_tm: number; product_id: string }[];
    expect(bls.map((b) => Number(b.planned_tm))).toEqual([700, 300]);
    S.blA = bls[0].id; S.blB = bls[1].id; S.prod = bls[0].product_id;
    const sp = ok(await W.c.opsA.from('service_products').select('bag_weight_kg, uses_bl').eq('service_id', S.id).single()) as { bag_weight_kg: number | null; uses_bl: boolean };
    expect(sp.bag_weight_kg).toBeNull(); expect(sp.uses_bl).toBe(true);
    const pts = ok(await W.c.opsA.from('service_scales').select('scale:scales(id, name, code)').eq('service_id', S.id)) as any[];
    expect(pts[0].scale.name).toBe(`Punto Muelle 4 ${run}`);
    S.point = pts[0].scale.id;
    const trucks = ok(await W.c.opsA.from('service_trucks').select('id, plate, driver_name, driver_dpi').eq('service_id', S.id).order('plate')) as { id: string; plate: string; driver_dpi: string | null }[];
    expect(trucks.map((t) => t.plate)).toEqual(['C-100AAA', 'C-200BBB']);
    expect(trucks[1].driver_dpi).toBe('1234567890123');
    S.truck1 = trucks[0].id;
    ok(await W.c.opsA.rpc('change_service_status', { p_service: S.id, p_status: 'in_operation' }));
  });

  it('los camiones son del servicio: no aparecen en otros servicios ni en el portal', async () => {
    const other = ok(await W.c.supA.from('service_trucks').select('plate').eq('service_id', W.service)) as { plate: string }[];
    expect(other.some((t) => t.plate === 'C-200BBB')).toBe(false);
    const portal = ok(await W.c.cuA1.from('service_trucks').select('id').eq('service_id', S.id)) as unknown[];
    expect(portal.length).toBe(0);
    const portalBl = ok(await W.c.cuA1.from('service_bls').select('id').eq('service_id', S.id)) as unknown[];
    expect(portalBl.length).toBe(2);
    const e = await W.c.analystA.rpc('upsert_service_trucks', { p_service: S.id, p_rows: [{ plate: 'C-300CCC', driver_name: 'Ana López' }] });
    expect(e.error).toBeTruthy();
  });

  it('el pesaje usa el BL activo: producto y acumulado del BL', async () => {
    const missing = await W.c.op1.rpc('register_weigh_ticket', { p: pay({ bl_id: null, product_id: S.prod }) });
    expect(missing.error?.message).toMatch(/Seleccione el BL/);
    const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: pay() })) as { net_tm: number; units: number | null; bl_discharged_tm: number };
    expect(Number(r.net_tm)).toBe(30);
    expect(r.units).toBeNull();
    expect(Number(r.bl_discharged_tm)).toBe(30);
    const row = ok(await W.c.op1.from('operational_cycles').select('bl_number, product_id, driver_name').eq('service_id', S.id).single()) as any;
    expect(row.bl_number).toBe(`BLA-${run}`); expect(row.product_id).toBe(S.prod); expect(row.driver_name).toBe('Pedro Ruiz');
  });

  it('una placa nueva en báscula se agrega a la lista del servicio', async () => {
    const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: pay({ service_truck_id: null, truck_plate: 'C-400DDD', driver_name: 'Mario Paz' }) })) as { new_truck: boolean };
    expect(r.new_truck).toBe(true);
    const t = ok(await W.c.op1.from('service_trucks').select('driver_name').eq('service_id', S.id).eq('plate', 'C-400DDD').single()) as { driver_name: string };
    expect(t.driver_name).toBe('Mario Paz');
  });

  it('terminar un BL impide seguir registrándolo hasta reabrirlo; el operador elige el siguiente', async () => {
    ok(await W.c.op1.rpc('set_bl_status', { p_bl: S.blA, p_status: 'completed' }));
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: pay() });
    expect(e.error?.message).toMatch(/terminado/);
    ok(await W.c.op1.rpc('register_weigh_ticket', { p: pay({ bl_id: S.blB, service_hold_id: S.hold2 }) }));
    ok(await W.c.op1.rpc('set_bl_status', { p_bl: S.blA, p_status: 'open' }));
    const k = ok(await W.c.supA.rpc('service_kpis', { p_service: S.id })) as any;
    expect(k.cargo_type).toBe('bulk'); expect(k.operation_kind).toBe('discharge');
    expect(k.by_bl.map((b: any) => Number(b.discharged_tm))).toEqual([60, 30]);
    expect(k.shift_periods.length).toBeGreaterThan(0);
  });

  it('el ciclo se mide entre pasadas del mismo camión y se recalcula al anular', async () => {
    const plate = 'C-200BBB';
    const t = [] as string[];
    for (const m of [-90, -60, -20]) {
      const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: pay({ service_truck_id: null, truck_plate: plate, weighed_local: localStamp(TZ, m), gross: 20000 }) })) as { ticket_id: string };
      t.push(r.ticket_id);
    }
    const cyc = async () => (ok(await W.c.supA.from('operational_cycles').select('id, cycle_minutes').eq('service_id', S.id).eq('truck_plate', plate).eq('status', 'valid').order('weighed_at')) as { id: string; cycle_minutes: number | null }[]).map((r) => r.cycle_minutes === null ? null : Number(r.cycle_minutes));
    expect(await cyc()).toEqual([null, 30, 40]);
    ok(await W.c.supA.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: t[1], p_action: 'void', p_changes: {}, p_reason: 'Boleta duplicada en prueba' }));
    expect(await cyc()).toEqual([null, 70]);
  });

  it('corregir el BL de un pesaje traslada el acumulado entre BL', async () => {
    const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: pay() })) as { ticket_id: string };
    const bl = async (id: string) => Number((ok(await admin().from('service_bls').select('discharged_tm').eq('id', id).single()) as { discharged_tm: number }).discharged_tm);
    const a0 = await bl(S.blA), b0 = await bl(S.blB);
    ok(await W.c.supA.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: r.ticket_id, p_action: 'update', p_changes: { bl_id: S.blB }, p_reason: 'BL equivocado en báscula' }));
    expect(r3(a0 - (await bl(S.blA)))).toBe(30);
    expect(r3((await bl(S.blB)) - b0)).toBe(30);
    for (const id of [S.blA, S.blB]) {
      const rows = ok(await admin().from('weigh_tickets').select('net_tm').eq('bl_id', id).eq('status', 'valid')) as { net_tm: number }[];
      expect(r3(rows.reduce((x, y) => x + Number(y.net_tm), 0))).toBe(r3(await bl(id)));
    }
  });

  it('el acumulado del BL no se modifica directamente', async () => {
    const e = await W.c.masterA.from('service_bls').update({ discharged_tm: 0 }).eq('id', S.blA).select();
    expect(e.error).toBeTruthy();
    const b = await admin().from('service_bls').update({ discharged_tm: 1 }).eq('id', S.blA).select();
    expect(b.error?.message).toMatch(/solo cambia/);
  });
});

describe('Servicio en sacos: conteo por bodega y turno, sacos dañados y peso de cada saco', () => {
  const B = {} as { id: string; hold1: string; hold2: string; bl: string; prod: string; shift: string; day: string; sp: string };
  beforeAll(async () => {
    B.id = ok(await W.c.opsA.rpc('create_service', { p: {
      terminal_id: W.termA, customer_id: W.custA1, service_number: `SACOS-${run}`, cargo_type: 'bags', operation_kind: 'load',
      vessel: { name: `MV Autumn Sea ${run}` }, holds_count: 2, operator_ids: [W.uid.op2],
      products: [{ product_name: `Azúcar blanca ${run}`, bag_weight_kg: 50, bag_tare_kg: 0.16, uses_bl: true,
                   holds: [{ hold_number: 1, planned_tm: 100 }, { hold_number: 2, planned_tm: 50 }], bls: [{ bl_number: `SUG-${run}`, planned_tm: 150 }] }] } })) as string;
    const holds = ok(await W.c.opsA.from('service_holds').select('id, hold_number').eq('service_id', B.id).order('hold_number')) as { id: string }[];
    B.hold1 = holds[0].id; B.hold2 = holds[1].id;
    const bl = ok(await W.c.opsA.from('service_bls').select('id, product_id').eq('service_id', B.id).single()) as { id: string; product_id: string };
    B.bl = bl.id; B.prod = bl.product_id;
    const svc = ok(await W.c.opsA.from('services').select('shift_plan_id, operation_kind').eq('id', B.id).single()) as { shift_plan_id: string; operation_kind: string };
    expect(svc.operation_kind).toBe('load');
    const sh = ok(await W.c.opsA.from('shifts').select('id, name').eq('plan_id', svc.shift_plan_id).order('sort')) as { id: string }[];
    B.shift = sh[0].id; B.day = localStamp(TZ, -24 * 60).slice(0, 10);
    ok(await W.c.opsA.rpc('change_service_status', { p_service: B.id, p_status: 'in_operation' }));
  });

  it('un servicio en sacos no registra boletas de camión', async () => {
    ok(await W.c.masterA.rpc('add_service_point', { p_service: B.id, p: { scale_id: W.scale1 } }));
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ service_id: B.id, service_hold_id: B.hold1, product_id: B.prod, bl_id: B.bl }) });
    expect(e.error?.message).toMatch(/sacos/);
  });

  it('el conteo por turno descuenta sacos (y TM) por bodega y BL; no excede lo pendiente', async () => {
    const r = ok(await W.c.op2.rpc('register_bag_tally', { p: { client_request_id: randomUUID(), service_id: B.id, shift_id: B.shift, shift_date: B.day,
      rows: [{ service_hold_id: B.hold1, bl_id: B.bl, bags: 600 }, { service_hold_id: B.hold2, bl_id: B.bl, bags: 200 }] } })) as { bags: number };
    expect(r.bags).toBe(800);
    const c = ok(await admin().from('service_hold_cargo').select('discharged_tm').eq('service_id', B.id).order('initial_tm', { ascending: false })) as { discharged_tm: number }[];
    expect(c.map((x) => Number(x.discharged_tm))).toEqual([30, 10]);
    const bl = ok(await admin().from('service_bls').select('discharged_tm').eq('id', B.bl).single()) as { discharged_tm: number };
    expect(Number(bl.discharged_tm)).toBe(40);
    const over = await W.c.op2.rpc('register_bag_tally', { p: { client_request_id: randomUUID(), service_id: B.id, shift_id: B.shift, shift_date: B.day,
      rows: [{ service_hold_id: B.hold2, bl_id: B.bl, bags: 900 }] } });
    expect(over.error?.message).toMatch(/exceden/);
    const noBl = await W.c.op2.rpc('register_bag_tally', { p: { client_request_id: randomUUID(), service_id: B.id, shift_id: B.shift, shift_date: B.day,
      rows: [{ service_hold_id: B.hold2, product_id: B.prod, bags: 10 }] } });
    expect(noBl.error?.message).toMatch(/BL/);
    const intruder = await W.c.analystA.rpc('register_bag_tally', { p: { client_request_id: randomUUID(), service_id: B.id, shift_id: B.shift, shift_date: B.day,
      rows: [{ service_hold_id: B.hold1, bl_id: B.bl, bags: 1 }] } });
    expect(intruder.error?.message).toMatch(/autorizado/);
  });

  it('sacos dañados por turno y avance por turno con acumulado', async () => {
    ok(await W.c.op2.rpc('set_bag_damages', { p: { service_id: B.id, shift_id: B.shift, shift_date: B.day, dirty: 1, broken: 2, wet: 0, to_sea: 1 } }));
    ok(await W.c.op2.rpc('set_bag_damages', { p: { service_id: B.id, shift_id: B.shift, shift_date: B.day, dirty: 0, broken: 3, wet: 0, to_sea: 1 } }));
    const k = ok(await W.c.supA.rpc('service_kpis', { p_service: B.id })) as any;
    expect(k.operation_kind).toBe('load');
    expect(k.bags_in_range).toBe(800); expect(Number(k.damaged_bags)).toBe(4);
    expect(k.shift_periods.length).toBe(1);
    const p = k.shift_periods[0];
    expect(p.bags).toBe(800); expect(p.cum_bags).toBe(800); expect(p.damaged.total).toBe(4);
    expect(p.holds.map((h: any) => h.bags)).toEqual([600, 200]);
  });

  it('peso de cada saco: tara general, neto automático, temperatura obligatoria y promedio', async () => {
    const noTemp = await W.c.op2.rpc('register_bag_sample', { p: { client_request_id: randomUUID(), service_id: B.id, product_id: B.prod, ticket_number: '1601930', gross_kg: 50.35 } });
    expect(noTemp.error?.message).toMatch(/temperatura/);
    for (const [g, t] of [[50.35, 33.3], [50.37, 32.1], [50.40, 34.0]]) {
      ok(await W.c.op2.rpc('register_bag_sample', { p: { client_request_id: randomUUID(), service_id: B.id, product_id: B.prod, ticket_number: '1601930', gross_kg: g, temperature_c: t } }));
    }
    const rows = ok(await W.c.op2.from('bag_samples').select('net_kg, tare_kg').eq('service_id', B.id)) as { net_kg: number; tare_kg: number }[];
    expect(rows.map((r) => Number(r.net_kg)).sort()).toEqual([50.19, 50.21, 50.24]);
    expect(rows.every((r) => Number(r.tare_kg) === 0.16)).toBe(true);
    const k = ok(await W.c.supA.rpc('service_kpis', { p_service: B.id })) as any;
    expect(k.bag_samples.count).toBe(3);
    expect(Number(k.bag_samples.avg_net_kg)).toBe(50.213);
    expect(Number(k.bag_samples.avg_temp_c)).toBe(33.13);
  });

  it('anular un conteo revierte saldos y BL', async () => {
    const t = ok(await admin().from('bag_tallies').select('id').eq('service_id', B.id).eq('service_hold_id', B.hold2).single()) as { id: string };
    const e = await W.c.op2.rpc('void_bag_tally', { p_tally: t.id, p_reason: 'Conteo duplicado' });
    expect(e.error).toBeTruthy();
    ok(await W.c.supA.rpc('void_bag_tally', { p_tally: t.id, p_reason: 'Conteo duplicado en el turno' }));
    const bl = ok(await admin().from('service_bls').select('discharged_tm').eq('id', B.bl).single()) as { discharged_tm: number };
    expect(Number(bl.discharged_tm)).toBe(30);
  });
});

describe('Configuración del Master: marca y esquemas de turnos', () => {
  it('guarda paleta de 2–3 colores y descargo de responsabilidad; valida los códigos', async () => {
    ok(await W.c.masterA.from('organization_settings').update({ brand_colors: ['#0f3b5f', '#f2a600', '#00b894'], report_disclaimer: 'Resultados válidos solo para la operación descrita.' }).eq('organization_id', W.orgA));
    const bad = await W.c.masterA.from('organization_settings').update({ brand_colors: ['azul'] }).eq('organization_id', W.orgA).select();
    expect(bad.error).toBeTruthy();
    const op = await W.c.opsA.from('organization_settings').update({ report_disclaimer: 'x' }).eq('organization_id', W.orgA).select();
    expect((op.data ?? []).length).toBe(0);
  });

  it('un nuevo esquema de turnos se elige al crear el servicio y define el turno de cada pesaje', async () => {
    const plan = ok(await W.c.masterA.from('shift_plans').insert({ terminal_id: W.termA, organization_id: W.orgA, name: `Intertek ${run}` }).select('id').single()) as { id: string };
    ok(await W.c.masterA.from('shifts').insert([
      { terminal_id: W.termA, organization_id: W.orgA, plan_id: plan.id, name: 'Turno A', start_time: '07:00', end_time: '14:30', sort: 1 },
      { terminal_id: W.termA, organization_id: W.orgA, plan_id: plan.id, name: 'Turno B', start_time: '14:30', end_time: '21:30', sort: 2 },
      { terminal_id: W.termA, organization_id: W.orgA, plan_id: plan.id, name: 'Turno C', start_time: '21:30', end_time: '07:00', sort: 3 }]));
    const id = ok(await W.c.opsA.rpc('create_service', { p: { terminal_id: W.termA, customer_id: W.custA2, service_number: `TUR-${run}`, shift_plan_id: plan.id,
      vessel: { name: `MV Turnos ${run}` }, holds_count: 1, scale_ids: [W.scale1], products: [{ product_id: W.prodMaiz, holds: [{ hold_number: 1, planned_tm: 500 }] }] } })) as string;
    ok(await W.c.opsA.rpc('change_service_status', { p_service: id, p_status: 'in_operation' }));
    const day = localStamp(TZ, -24 * 60).slice(0, 10);
    const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ service_id: id, product_id: W.prodMaiz, service_hold_id: (ok(await W.c.opsA.from('service_holds').select('id').eq('service_id', id).single()) as { id: string }).id,
      weighed_local: `${day}T23:10` }) })) as { ticket_id: string };
    const t = ok(await W.c.supA.from('operational_cycles').select('shift_name').eq('id', r.ticket_id).single()) as { shift_name: string };
    expect(t.shift_name).toBe('Turno C');
    const k = ok(await W.c.supA.rpc('service_kpis', { p_service: id })) as any;
    expect(k.shift_periods[0].from).toBe(`${day}T21:30`);
  });
});

describe('Tiempos perdidos', () => {
  let causeId: string;
  beforeAll(async () => {
    const c = ok(await W.c.supA.from('downtime_causes').select('id, name').eq('organization_id', W.orgA).eq('name', 'Falta de camiones').single()) as { id: string };
    causeId = c.id;
  });

  it('calcula correctamente un evento que atraviesa la medianoche', async () => {
    const res = ok(await W.c.supA.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: causeId,
      started_local: '2026-11-20T23:30', ended_local: '2026-11-21T01:15', scope: 'operation', observations: 'Prueba medianoche' } })) as { duration_minutes: number };
    expect(Number(res.duration_minutes)).toBe(105);
  });

  it('rechaza duraciones negativas o nulas', async () => {
    const e = await W.c.supA.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: causeId,
      started_local: '2026-11-21T10:00', ended_local: '2026-11-21T09:00' } });
    expect(e.error?.message).toMatch(/posterior/);
  });

  it('el evento «Otros» exige escribir qué pasó', async () => {
    const otros = ok(await W.c.supA.from('downtime_causes').select('id, requires_description').eq('organization_id', W.orgA).eq('name', 'Otros').single()) as { id: string; requires_description: boolean };
    expect(otros.requires_description).toBe(true);
    const e = await W.c.supA.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: otros.id,
      started_local: '2026-11-21T11:00', ended_local: '2026-11-21T11:10' } });
    expect(e.error?.message).toMatch(/Describa qué pasó/);
  });

  it('distingue alcance por bodega y báscula y el operador no registra tiempos perdidos', async () => {
    ok(await W.c.supA.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: causeId,
      started_local: '2026-11-21T08:00', ended_local: '2026-11-21T08:40', scope: 'hold', service_hold_id: W.hold1 } }));
    ok(await W.c.supA.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: causeId,
      started_local: '2026-11-21T09:00', ended_local: '2026-11-21T09:20', scope: 'scale', scale_id: W.scale1 } }));
    const e = await W.c.op1.rpc('register_downtime', { p: { client_request_id: randomUUID(), service_id: W.service, cause_id: causeId,
      started_local: '2026-11-21T08:00', ended_local: '2026-11-21T08:40' } });
    expect(e.error).toBeTruthy();
    const s = ok(await W.c.supA.rpc('downtime_summary', { p: { service_id: W.service } })) as { total_minutes: number; events: number; pareto: unknown[]; by_scope: Record<string, number> };
    expect(Number(s.total_minutes)).toBe(165);
    expect(s.events).toBe(3);
    expect(Number(s.by_scope.hold)).toBe(40);
  });
});

describe('Correcciones auditadas', () => {
  let ticketId: string;
  beforeAll(async () => {
    const r = ok(await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ gross: 40000, tare: 15000, truck_plate: 'C-999ERR' }) })) as { ticket_id: string };
    ticketId = r.ticket_id;
  });

  it('el operador solicita, el supervisor aprueba y el tonelaje se recalcula con movimientos compensatorios', async () => {
    const before = await cargo(W.cargoFert);
    const req = ok(await W.c.op1.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: ticketId, p_action: 'update',
      p_changes: { tare_kg: 15500, truck_plate: 'C-998ERR' }, p_reason: 'Tara repesada: lona húmeda' })) as { status: string; request_id: string };
    expect(req.status).toBe('pending');
    const self = await W.c.op1.rpc('review_correction', { p_request: req.request_id, p_approve: true });
    expect(self.error).toBeTruthy();
    ok(await W.c.supA.rpc('review_correction', { p_request: req.request_id, p_approve: true, p_note: 'Verificado con ticket físico' }));
    const after = await cargo(W.cargoFert);
    expect(r3(Number(before.discharged_tm) - Number(after.discharged_tm))).toBe(0.5);
    const t = ok(await W.c.supA.from('weigh_tickets').select('net_tm, truck_plate, revision').eq('id', ticketId).single()) as { net_tm: number; truck_plate: string; revision: number };
    expect(Number(t.net_tm)).toBe(24.5); expect(t.truck_plate).toBe('C-998ERR'); expect(t.revision).toBe(2);
    const hist = ok(await W.c.supA.from('correction_history').select('field, old_value, new_value, reason').eq('target_id', ticketId)) as { field: string; old_value: string; new_value: string }[];
    expect(hist.map((h) => h.field).sort()).toEqual(['tare_kg', 'truck_plate']);
    expect(hist.find((h) => h.field === 'truck_plate')!.old_value).toBe('C-999ERR');
    expect(r3(await ledgerSum(W.cargoFert))).toBe(r3(Number(after.discharged_tm)));
  });

  it('corregir bodega/producto traslada el tonelaje entre saldos en una transacción', async () => {
    const fert0 = await cargo(W.cargoFert), urea0 = await cargo(W.cargoUrea);
    const room = Number(urea0.initial_tm) - Number(urea0.discharged_tm);
    if (room < 24.5) ok(await W.c.opsA.rpc('adjust_cargo_initial', { p_cargo: W.cargoUrea, p_new_initial: Number(urea0.initial_tm) + 50, p_reason: 'Ampliación de manifiesto para prueba' }));
    ok(await W.c.supA.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: ticketId, p_action: 'update',
      p_changes: { product_id: W.prodUrea }, p_reason: 'Producto mal seleccionado en báscula', p_expected_revision: 2 }));
    const fert1 = await cargo(W.cargoFert), urea1 = await cargo(W.cargoUrea);
    expect(r3(Number(fert0.discharged_tm) - Number(fert1.discharged_tm))).toBe(24.5);
    expect(r3(Number(urea1.discharged_tm) - Number(urea0.discharged_tm))).toBe(24.5);
  });

  it('control de concurrencia optimista: revisión desactualizada es rechazada', async () => {
    const e = await W.c.supA.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: ticketId, p_action: 'update',
      p_changes: { notes: 'x' }, p_reason: 'Revisión vieja para prueba', p_expected_revision: 1 });
    expect(e.error?.message).toMatch(/modificado/);
  });

  it('anular revierte el descuento y conserva el registro (sin borrado físico)', async () => {
    const urea0 = await cargo(W.cargoUrea);
    ok(await W.c.supA.rpc('request_correction', { p_target_type: 'weigh_ticket', p_target_id: ticketId, p_action: 'void', p_changes: {}, p_reason: 'Ticket duplicado por reimpresión' }));
    const urea1 = await cargo(W.cargoUrea);
    expect(r3(Number(urea0.discharged_tm) - Number(urea1.discharged_tm))).toBe(24.5);
    const t = ok(await W.c.supA.from('weigh_tickets').select('status').eq('id', ticketId).single()) as { status: string };
    expect(t.status).toBe('voided');
    const audit = ok(await W.c.masterA.from('audit_logs').select('action, reason, actor_name').eq('table_name', 'weigh_tickets').eq('record_id', ticketId)) as { action: string; reason: string }[];
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(audit.some((x) => x.reason === 'Ticket duplicado por reimpresión')).toBe(true);
    const supAudit = ok(await W.c.supA.from('audit_logs').select('id').limit(1)) as unknown[];
    expect(supAudit.length).toBe(0);
  });

  it('conciliación: saldo = ledger = Σ tickets válidos en todas las líneas', async () => {
    for (const id of [W.cargoFert, W.cargoUrea, W.cargoMaiz]) {
      const c = await cargo(id);
      expect(r3(await ledgerSum(id)), id).toBe(r3(Number(c.discharged_tm)));
      expect(r3(await validTicketSum(id)), id).toBe(r3(Number(c.discharged_tm)));
    }
  });
});

describe('Escalamiento de privilegios', () => {
  it('nadie modifica su propio rol; un operativo no crea Masters', async () => {
    const me = ok(await W.c.opsA.from('organization_members').select('id').eq('user_id', W.uid.opsA).single()) as { id: string };
    const e1 = await W.c.opsA.rpc('admin_update_member', { p_member: me.id, p: { role_code: 'master_admin' } });
    expect(e1.error).toBeTruthy();
    const other = ok(await W.c.masterA.from('organization_members').select('id').eq('user_id', W.uid.supA).single()) as { id: string };
    const e2 = await W.c.opsA.rpc('admin_update_member', { p_member: other.id, p: { role_code: 'master_admin' } });
    expect(e2.error).toBeTruthy();
    const ins = await W.c.opsA.from('organization_members').insert({ organization_id: W.orgA, user_id: W.uid.cuA1, role_code: 'master_admin' });
    expect(ins.error).toBeTruthy();
  });

  it('el último Administrador Master no puede degradarse', async () => {
    const me = ok(await W.c.masterA.from('organization_members').select('id').eq('user_id', W.uid.masterA).single()) as { id: string };
    const e = await W.c.masterA.rpc('admin_update_member', { p_member: me.id, p: { status: 'inactive' } });
    expect(e.error).toBeTruthy();
  });

  it('un usuario desactivado pierde acceso de inmediato aunque su JWT siga vigente', async () => {
    const m = ok(await W.c.masterA.from('organization_members').select('id').eq('user_id', W.uid.analystA).single()) as { id: string };
    ok(await W.c.masterA.rpc('admin_update_member', { p_member: m.id, p: { status: 'inactive', reason: 'Baja de personal' } }));
    const rows = ok(await W.c.analystA.from('services').select('id')) as unknown[];
    expect(rows.length).toBe(0);
    ok(await W.c.masterA.rpc('admin_update_member', { p_member: m.id, p: { status: 'active' } }));
  });

  it('contraseña temporal: sin acceso a datos hasta cambiarla (verificado en servidor)', async () => {
    const id = await createUser(mail('temp'), 'Usuario Temporal', 'staff', true);
    await addMember(W.orgA, id, 'analyst');
    const c = await signIn(mail('temp'));
    expect((ok(await c.from('services').select('id')) as unknown[]).length).toBe(0);
    const early = await c.rpc('confirm_password_changed');
    expect(early.error?.message).toMatch(/aún no/);
    ok(await c.auth.updateUser({ password: PASSWORD + '-nueva' }));
    ok(await c.rpc('confirm_password_changed'));
    const c2 = await signIn(mail('temp'), PASSWORD + '-nueva');
    expect((ok(await c2.from('services').select('id')) as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('Productividad y cierre de operación', () => {
  it('KPIs diferencian ciclo de báscula, tiempo perdido y tiempo efectivo', async () => {
    const k = ok(await W.c.supA.rpc('service_kpis', { p_service: W.service })) as Record<string, unknown>;
    expect(Number(k.trucks)).toBeGreaterThan(30);
    expect(k.avg_cycle_minutes).not.toBeNull();
    expect(k).toHaveProperty('downtime_minutes_reported');
    expect(k).toHaveProperty('effective_hours');
    expect((k.by_scale as unknown[]).length).toBe(2);
    expect((k.by_hold as unknown[]).length).toBe(2);
    const portal = ok(await W.c.cuA1.rpc('service_kpis', { p_service: W.service })) as Record<string, unknown>;
    expect(portal.totals).toEqual(k.totals);
  });

  it('no permite finalizar sin nota si queda saldo pendiente', async () => {
    const e2 = await W.c.opsA.rpc('close_service', { p_service: W.service });
    expect(e2.error?.message).toMatch(/pendientes/);
  });

  it('finaliza, crea un único trabajo de reporte e impide nuevos pesajes', async () => {
    const r = ok(await W.c.opsA.rpc('close_service', { p_service: W.service, p_note: 'Saldo a bordo según inspección de calado', p_conclusions: 'Operación sin incidentes mayores.' })) as { job_id: string; report_id: string };
    expect(r.job_id).toBeTruthy();
    const again = await W.c.opsA.rpc('close_service', { p_service: W.service, p_note: 'Segundo cierre' });
    expect(again.error).toBeTruthy();
    const jobs = ok(await W.c.opsA.from('report_jobs').select('id').eq('service_id', W.service)) as unknown[];
    expect(jobs.length).toBe(1);
    const retry = ok(await W.c.opsA.rpc('retry_report_job', { p_service: W.service })) as string;
    expect(retry).toBe(r.job_id);
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload() });
    expect(e.error?.message).toMatch(/reapertura/);
    const edit = await W.c.opsA.from('services').update({ observations: 'cambio' }).eq('id', W.service).select();
    expect(edit.error).toBeTruthy();
    const snap = ok(await W.c.supA.from('productivity_snapshots').select('kind').eq('service_id', W.service)) as { kind: string }[];
    expect(snap[0].kind).toBe('closure');
  });

  it('la verificación pública no revela nada sin un código válido', async () => {
    const v = ok(await anon().rpc('verify_report', { p_code: 'VC-NOEXISTE' })) as { found: boolean };
    expect(v.found).toBe(false);
  });
});

export { W, PASSWORD };
