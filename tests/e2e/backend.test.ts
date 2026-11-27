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
    started_local: localStamp(TZ, -30), ended_local: localStamp(TZ, -27), ...o,
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
  W.serviceB = ok(await W.c.masterB.rpc('create_service', { p: { terminal_id: W.termB, customer_id: W.custB1, vessel_id: vB, service_number: `SV-2026-${run}` } })) as string;

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

  it('rechaza horas incoherentes en modalidad manual', async () => {
    const e = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ started_local: localStamp(TZ, -10), ended_local: localStamp(TZ, -20) }) });
    expect(e.error?.message).toMatch(/hora final/);
  });

  it('el operador solo registra en sus básculas autorizadas; analista y cliente no registran', async () => {
    const e1 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ scale_id: W.scale2 }) });
    expect(e1.error?.message).toMatch(/autorizado/);
    const e2 = await W.c.analystA.rpc('register_weigh_ticket', { p: ticketPayload() });
    expect(e2.error?.message).toMatch(/autorizado/);
    const e3 = await W.c.op1.rpc('register_weigh_ticket', { p: ticketPayload({ scale_id: W.scale3 }) });
    expect(e3.error?.message).toMatch(/autorizado/);
  });

  it('modalidad "hora del servidor": inicio y final los fija el servidor, no el navegador', async () => {
    const manual = await W.c.op2.rpc('register_weigh_ticket', { p: ticketPayload({ scale_id: W.scale2, service_hold_id: W.hold2, product_id: W.prodMaiz }) });
    expect(manual.error?.message).toMatch(/hora de inicio/);
    const visit = ok(await W.c.op2.rpc('start_scale_visit', { p_scale: W.scale2, p_service: W.service })) as { id: string; started_at: string };
    const stamped = ok(await W.c.op2.rpc('stamp_scale_visit_end', { p_visit: visit.id })) as { ended_at: string };
    const res = ok(await W.c.op2.rpc('register_weigh_ticket', { p: ticketPayload({
      scale_id: W.scale2, service_hold_id: W.hold2, product_id: W.prodMaiz, visit_id: visit.id,
      started_local: '2020-01-01T00:00', ended_local: '2020-01-01T00:05' }) })) as { started_at: string; ended_at: string };
    expect(new Date(res.started_at).toISOString()).toBe(new Date(visit.started_at).toISOString());
    expect(new Date(res.ended_at).toISOString()).toBe(new Date(stamped.ended_at).toISOString());
    const t = ok(await W.c.masterA.from('weigh_tickets').select('time_capture_mode').eq('visit_id', visit.id).single()) as { time_capture_mode: string };
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
      truck_plate: i % 2 ? 'C-777XYZ' : 'C-555ABC', started_local: localStamp(TZ, -300 + i * 5), ended_local: localStamp(TZ, -297 + i * 5) }));
    for (const p of batch) ok(await W.c.op1.rpc('register_weigh_ticket', { p }));
    const page1 = await W.c.supA.from('operational_cycles').select('id, truck_plate, cycle_minutes', { count: 'exact' })
      .eq('service_id', W.service).order('started_at', { ascending: false }).range(0, 24);
    expect(page1.error).toBeNull();
    expect(page1.data!.length).toBe(25);
    expect(page1.count!).toBeGreaterThanOrEqual(33);
    const page2 = await W.c.supA.from('operational_cycles').select('id', { count: 'exact' }).eq('service_id', W.service)
      .order('started_at', { ascending: false }).range(25, 49);
    expect(page2.data!.length).toBe(page1.count! - 25);
    const filtered = await W.c.supA.from('operational_cycles').select('id', { count: 'exact', head: true }).eq('service_id', W.service).ilike('truck_plate', '%777%');
    expect(filtered.count).toBe(15);
    expect(page1.data!.every((r) => Number(r.cycle_minutes) >= 0)).toBe(true);
  });

  it('el operador solo ve los ciclos de sus básculas', async () => {
    const rows = ok(await W.c.op2.from('operational_cycles').select('scale_id').eq('service_id', W.service)) as { scale_id: string }[];
    expect(rows.every((r) => [W.scale1, W.scale2].includes(r.scale_id))).toBe(true);
    const sup = await W.c.supA.from('weigh_tickets').select('id', { count: 'exact', head: true }).eq('service_id', W.service);
    expect(sup.count!).toBeGreaterThan(rows.length - 1);
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

  it('no permite finalizar con visitas abiertas ni sin nota si hay pendiente', async () => {
    const v = ok(await W.c.op2.rpc('start_scale_visit', { p_scale: W.scale2, p_service: W.service })) as { id: string };
    const e = await W.c.opsA.rpc('close_service', { p_service: W.service, p_note: 'Cierre de prueba con saldo' });
    expect(e.error?.message).toMatch(/visita/);
    ok(await W.c.op2.rpc('cancel_scale_visit', { p_visit: v.id, p_reason: 'Camión retirado' }));
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
