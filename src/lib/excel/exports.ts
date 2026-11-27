import { rpc, supabase, unwrap } from '../supabase';
import { cyclesQuery, CYCLE_COLS, DOWNTIME_COLS, fetchAll, type CycleFilters, type CycleRow, type DowntimeRow } from '../queries';
import type { Kpis } from '../service-data';
import { SERVICE_STATUS, SCOPE } from '../labels';
import { download, localDate, newWorkbook, sheetHeader, STYLE, table, type Col } from './layout';
import type { Workbook } from 'exceljs';

const F = STYLE.fmt;
const stamp = () => new Date().toLocaleString('es-GT');

type SvcInfo = { id: string; organization_id: string; service_number: string; status: string; customer_name: string; vessel_name: string; imo_number: string | null; terminal_name: string; timezone: string;
  actual_start: string | null; planned_start: string | null; finalized_at: string | null; responsible_name: string | null; initial_tm: number; discharged_tm: number; pending_tm: number; progress_pct: number };

async function service(id: string) {
  return unwrap(await supabase.from('service_overview').select('id, organization_id, service_number, status, customer_name, vessel_name, imo_number, terminal_name, timezone, actual_start, planned_start, finalized_at, responsible_name, initial_tm, discharged_tm, pending_tm, progress_pct').eq('id', id).single()) as SvcInfo;
}
const cycles = (s: SvcInfo) => fetchAll<CycleRow>(() => supabase.from('operational_cycles').select(CYCLE_COLS).eq('service_id', s.id).eq('status', 'valid'), [{ col: 'started_at', asc: true }, { col: 'id', asc: true }]);
const downtimes = (s: SvcInfo) => fetchAll<DowntimeRow>(() => supabase.from('downtime_overview').select(DOWNTIME_COLS).eq('service_id', s.id).eq('status', 'valid'), [{ col: 'started_at', asc: true }]);
const meta = (s: SvcInfo): [string, string][] => [['Servicio', s.service_number], ['Cliente', s.customer_name], ['Buque', `${s.vessel_name}${s.imo_number ? ` · IMO ${s.imo_number}` : ''}`], ['Terminal', s.terminal_name], ['Generado', stamp()]];

/* ------------------------------------------------------------------ hojas reutilizables */
function sheetSummary(wb: Workbook, s: SvcInfo, k: Kpis | null, trucks: number) {
  const ws = wb.addWorksheet('Resumen del servicio');
  const start = sheetHeader(ws, 'Resumen del servicio', [['Generado', stamp()]], 2);
  const tz = s.timezone;
  table(ws, start, [{ header: 'Campo', key: 'k', width: 34 }, { header: 'Valor', key: 'v', width: 40 }], [
    { k: 'Buque', v: s.vessel_name }, { k: 'Número IMO', v: s.imo_number ?? 'No registrado' }, { k: 'Servicio', v: s.service_number }, { k: 'Cliente', v: s.customer_name },
    { k: 'Terminal', v: s.terminal_name }, { k: 'Estado', v: SERVICE_STATUS[s.status]?.label ?? s.status }, { k: 'Responsable', v: s.responsible_name ?? '' },
    { k: 'Fecha de inicio', v: localDate(s.actual_start ?? s.planned_start, tz) }, { k: 'Fecha de finalización', v: localDate(s.finalized_at, tz) },
    { k: 'Tonelaje inicial (TM)', v: Number(s.initial_tm) }, { k: 'Tonelaje descargado (TM)', v: Number(s.discharged_tm) }, { k: 'Tonelaje pendiente (TM)', v: Number(s.pending_tm) },
    { k: 'Porcentaje de avance (%)', v: Number(s.progress_pct) }, { k: 'Camiones registrados', v: trucks },
    { k: 'Promedio por camión (TM)', v: k?.avg_tm_per_truck ?? null }, { k: 'Toneladas por hora', v: k?.tph ?? null }, { k: 'Tiempo promedio de ciclo (min)', v: k?.avg_cycle_minutes ?? null },
    { k: 'Tiempo perdido reportado (h)', v: k ? Number(k.downtime_minutes_reported) / 60 : null }, { k: 'Tiempo efectivo de operación (h)', v: k?.effective_hours ?? null },
  ]);
  const fmts: Record<number, string> = { 7: F.datetime, 8: F.datetime, 9: F.tm, 10: F.tm, 11: F.tm, 12: F.pct, 13: F.int, 14: F.tm, 15: F.tm2, 16: F.min, 17: F.tm2, 18: F.tm2 };
  Object.entries(fmts).forEach(([i, f]) => { const c = ws.getRow(start + 1 + Number(i)).getCell(2); c.numFmt = f; c.alignment = { horizontal: 'left' }; });
}

const TRUCK_COLS: Col[] = [
  { header: 'Correlativo', key: 'n', width: 11, fmt: F.int }, { header: 'Ticket', key: 'ticket', width: 14 }, { header: 'Fecha', key: 'date', width: 12, fmt: F.date },
  { header: 'Hora de inicio', key: 'start', width: 10, fmt: F.time }, { header: 'Hora final', key: 'end', width: 10, fmt: F.time },
  { header: 'Matrícula camión', key: 'plate', width: 14 }, { header: 'Matrícula TC', key: 'tc', width: 14 }, { header: 'Piloto', key: 'driver', width: 28 }, { header: 'DPI', key: 'dpi', width: 16 },
  { header: 'Báscula', key: 'scale', width: 13 }, { header: 'Bodega', key: 'hold', width: 9, fmt: F.int }, { header: 'Producto', key: 'product', width: 14 },
  { header: 'Peso bruto (kg)', key: 'gross', width: 14, fmt: F.kg, total: 'sum' }, { header: 'Tara (kg)', key: 'tare', width: 12, fmt: F.kg, total: 'sum' },
  { header: 'Peso neto (kg)', key: 'net', width: 14, fmt: F.kg, total: 'sum' }, { header: 'Peso neto (TM)', key: 'nettm', width: 13, fmt: F.tm, total: 'sum' },
  { header: 'Turno', key: 'shift', width: 10 }, { header: 'Usuario', key: 'user', width: 20 },
];
const truckRows = (rows: CycleRow[], tz: string) => rows.map((r, i) => {
  const s = localDate(r.started_at, tz); const e = localDate(r.ended_at, tz);
  return { n: i + 1, ticket: r.ticket_number, date: s, start: s, end: e, plate: r.truck_plate, tc: r.tractor_plate ?? '', driver: r.driver_name, dpi: r.driver_dpi, scale: r.scale_name,
    hold: r.hold_number, product: r.product_name, gross: Number(r.gross_kg), tare: Number(r.tare_kg), net: Number(r.net_kg), nettm: Number(r.net_tm), shift: r.shift_name ?? '', user: r.registered_by_name ?? '' };
});
function sheetTrucks(wb: Workbook, rows: CycleRow[], tz: string, m: [string, string][], name = 'Detalle de pesajes') {
  const ws = wb.addWorksheet(name);
  table(ws, sheetHeader(ws, name, m, TRUCK_COLS.length), TRUCK_COLS, truckRows(rows, tz));
}

const CYCLE_SHEET: Col[] = [
  { header: 'Ticket', key: 'ticket', width: 14 }, { header: 'Servicio', key: 'svc', width: 14 }, { header: 'Matrícula camión', key: 'plate', width: 14 }, { header: 'Báscula', key: 'scale', width: 13 },
  { header: 'Bodega', key: 'hold', width: 9, fmt: F.int }, { header: 'Producto', key: 'product', width: 14 }, { header: 'Fecha', key: 'date', width: 12, fmt: F.date },
  { header: 'Hora de inicio', key: 'start', width: 11, fmt: F.time }, { header: 'Hora final', key: 'end', width: 11, fmt: F.time },
  { header: 'Tiempo de ciclo (min)', key: 'cycle', width: 14, fmt: F.min, total: 'avg' }, { header: 'Neto (TM)', key: 'net', width: 12, fmt: F.tm, total: 'sum' },
  { header: 'Modalidad de hora', key: 'mode', width: 18 }, { header: 'Turno', key: 'shift', width: 10 }, { header: 'Estado', key: 'st', width: 10 },
];
const cycleRows = (rows: CycleRow[], tz: string) => rows.map((r) => {
  const s = localDate(r.started_at, tz);
  return { ticket: r.ticket_number, svc: r.service_number, plate: r.truck_plate, scale: r.scale_name, hold: r.hold_number, product: r.product_name, date: s, start: s, end: localDate(r.ended_at, tz),
    cycle: Number(r.cycle_minutes), net: Number(r.net_tm), mode: r.time_capture_mode === 'server_now' ? 'Hora del servidor' : 'Manual', shift: r.shift_name ?? '', st: r.status === 'valid' ? 'Válido' : 'Anulado' };
});

const DT_COLS: Col[] = [
  { header: 'Servicio', key: 'svc', width: 14 }, { header: 'Buque', key: 'vessel', width: 20 }, { header: 'Fecha', key: 'date', width: 12, fmt: F.date },
  { header: 'Hora de inicio', key: 'start', width: 16, fmt: F.datetime }, { header: 'Hora final', key: 'end', width: 16, fmt: F.datetime }, { header: 'Evento', key: 'cause', width: 28 },
  { header: 'Categoría', key: 'cat', width: 14 }, { header: 'Alcance', key: 'scope', width: 16 }, { header: 'Duración (min)', key: 'min', width: 13, fmt: F.min, total: 'sum' },
  { header: 'Duración (h)', key: 'h', width: 11, fmt: F.tm2, total: 'sum' }, { header: 'Turno', key: 'shift', width: 10 }, { header: 'Observaciones', key: 'obs', width: 36 }, { header: 'Responsable del registro', key: 'by', width: 22 },
];
const dtRows = (rows: DowntimeRow[], tz: string) => rows.map((d) => ({ svc: d.service_number, vessel: d.vessel_name, date: localDate(d.started_at, tz), start: localDate(d.started_at, tz), end: localDate(d.ended_at, tz),
  cause: d.cause_name, cat: d.category_name, scope: d.scope === 'hold' ? `Bodega ${d.hold_number}` : d.scope === 'scale' ? (d.scale_name ?? '') : SCOPE.operation, min: Number(d.duration_minutes), h: Number(d.duration_minutes) / 60,
  shift: d.shift_name ?? '', obs: d.observations ?? '', by: d.reported_by_name ?? '' }));

function sheetTonnage(wb: Workbook, k: Kpis, m: [string, string][]) {
  const ws = wb.addWorksheet('Resumen por bodega');
  const rows = k.by_hold.flatMap((h) => h.products.map((p) => ({ hold: `Bodega ${h.hold_number}`, product: p.name, ini: Number(p.initial_tm), dis: Number(p.discharged_tm), pen: Number(p.pending_tm), pct: Number(p.initial_tm) ? (Number(p.discharged_tm) / Number(p.initial_tm)) * 100 : 0 })));
  table(ws, sheetHeader(ws, 'Resumen de tonelaje por bodega y producto', m, 6), [
    { header: 'Bodega', key: 'hold', width: 12 }, { header: 'Producto', key: 'product', width: 18 }, { header: 'Tonelaje inicial (TM)', key: 'ini', width: 18, fmt: F.tm, total: 'sum' },
    { header: 'Tonelaje descargado (TM)', key: 'dis', width: 20, fmt: F.tm, total: 'sum' }, { header: 'Tonelaje pendiente (TM)', key: 'pen', width: 20, fmt: F.tm, total: 'sum' }, { header: 'Porcentaje de avance (%)', key: 'pct', width: 18, fmt: F.pct },
  ], rows);
}
function sheetScales(wb: Workbook, k: Kpis, m: [string, string][]) {
  const ws = wb.addWorksheet('Productividad por báscula');
  table(ws, sheetHeader(ws, 'Productividad por báscula', m, 7), [
    { header: 'Báscula', key: 'n', width: 16 }, { header: 'Total de camiones', key: 't', width: 14, fmt: F.int, total: 'sum' }, { header: 'Toneladas descargadas', key: 'tons', width: 18, fmt: F.tm, total: 'sum' },
    { header: 'Promedio por camión (TM)', key: 'avg', width: 18, fmt: F.tm }, { header: 'Ciclo promedio (min)', key: 'cyc', width: 16, fmt: F.min }, { header: 'Toneladas por hora', key: 'tph', width: 16, fmt: F.tm2 }, { header: 'Tiempo perdido (min)', key: 'dt', width: 16, fmt: F.min, total: 'sum' },
  ], k.by_scale.map((s) => ({ n: s.name, t: s.trucks, tons: Number(s.tons), avg: s.avg_tm_per_truck, cyc: s.avg_cycle_minutes, tph: s.tph, dt: Number(s.downtime_minutes) })));
}
function sheetHolds(wb: Workbook, k: Kpis, m: [string, string][]) {
  const ws = wb.addWorksheet('Productividad por bodega');
  table(ws, sheetHeader(ws, 'Productividad por bodega', m, 7), [
    { header: 'Bodega', key: 'h', width: 12 }, { header: 'Camiones', key: 't', width: 12, fmt: F.int, total: 'sum' }, { header: 'Inicial (TM)', key: 'i', width: 15, fmt: F.tm, total: 'sum' },
    { header: 'Descargado (TM)', key: 'd', width: 16, fmt: F.tm, total: 'sum' }, { header: 'Pendiente (TM)', key: 'p', width: 15, fmt: F.tm, total: 'sum' }, { header: 'Avance (%)', key: 'a', width: 12, fmt: F.pct }, { header: 'Tiempo perdido (min)', key: 'dt', width: 16, fmt: F.min, total: 'sum' },
  ], k.by_hold.map((h) => ({ h: `Bodega ${h.hold_number}`, t: h.trucks, i: Number(h.initial_tm), d: Number(h.discharged_tm), p: Number(h.pending_tm), a: Number(h.initial_tm) ? (Number(h.discharged_tm) / Number(h.initial_tm)) * 100 : 0, dt: Number(h.downtime_minutes) })));
}
function sheetHourly(wb: Workbook, rows: CycleRow[], tz: string, m: [string, string][]) {
  const g = new Map<string, { date: Date; hour: string; scale: string; hold: number; product: string; n: number; t: number }>();
  rows.forEach((r) => {
    const d = localDate(r.started_at, tz)!; const hour = `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    const key = [d.toISOString().slice(0, 10), hour, r.scale_name, r.hold_number, r.product_name].join('|');
    const x = g.get(key) ?? { date: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), hour, scale: r.scale_name, hold: r.hold_number, product: r.product_name, n: 0, t: 0 };
    x.n++; x.t += Number(r.net_tm); g.set(key, x);
  });
  const ws = wb.addWorksheet('Resumen por hora');
  table(ws, sheetHeader(ws, 'Resumen por hora', m, 7), [
    { header: 'Fecha', key: 'date', width: 12, fmt: F.date }, { header: 'Hora', key: 'hour', width: 8 }, { header: 'Báscula', key: 'scale', width: 14 }, { header: 'Bodega', key: 'hold', width: 9, fmt: F.int },
    { header: 'Producto', key: 'product', width: 16 }, { header: 'Cantidad de camiones', key: 'n', width: 16, fmt: F.int, total: 'sum' }, { header: 'Tonelaje descargado (TM)', key: 't', width: 20, fmt: F.tm, total: 'sum' },
  ], [...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, x]) => x));
}

/* ------------------------------------------------------------------ exportaciones públicas */
export async function exportServiceReport(serviceId: string) {
  const s = await service(serviceId);
  const [k, rows, dts] = await Promise.all([rpc<Kpis>('service_kpis', { p_service: serviceId }), cycles(s), downtimes(s)]);
  const wb = await newWorkbook();
  const m = meta(s);
  sheetSummary(wb, s, k, rows.length);
  sheetTrucks(wb, rows, s.timezone, m);
  sheetTonnage(wb, k, m);
  sheetScales(wb, k, m);
  const wc = wb.addWorksheet('Análisis de ciclos');
  table(wc, sheetHeader(wc, 'Análisis de ciclos', m, CYCLE_SHEET.length), CYCLE_SHEET, cycleRows(rows, s.timezone));
  sheetHourly(wb, rows, s.timezone, m);
  const wd = wb.addWorksheet('Tiempos perdidos');
  table(wd, sheetHeader(wd, 'Tiempos perdidos', m, DT_COLS.length), DT_COLS, dtRows(dts, s.timezone));
  await download(wb, `Servicio_${s.service_number}_${s.vessel_name}.xlsx`);
}

export async function exportServiceSheet(serviceId: string, kind: 'trucks' | 'cycles' | 'downtime' | 'tonnage') {
  const s = await service(serviceId);
  const wb = await newWorkbook();
  const m = meta(s);
  if (kind === 'trucks') sheetTrucks(wb, await cycles(s), s.timezone, m, 'Detalle de camiones');
  if (kind === 'cycles') { const ws = wb.addWorksheet('Ciclos'); table(ws, sheetHeader(ws, 'Ciclos de báscula', m, CYCLE_SHEET.length), CYCLE_SHEET, cycleRows(await cycles(s), s.timezone)); }
  if (kind === 'downtime') { const ws = wb.addWorksheet('Tiempos perdidos'); table(ws, sheetHeader(ws, 'Tiempos perdidos', m, DT_COLS.length), DT_COLS, dtRows(await downtimes(s), s.timezone)); }
  if (kind === 'tonnage') sheetTonnage(wb, await rpc<Kpis>('service_kpis', { p_service: serviceId }), m);
  const names = { trucks: 'Camiones', cycles: 'Ciclos', downtime: 'Tiempos_perdidos', tonnage: 'Tonelaje' };
  await download(wb, `${names[kind]}_${s.service_number}.xlsx`);
}

export async function exportProductivity(serviceId: string, number: string, tz: string, from?: string, to?: string) {
  const s = await service(serviceId);
  const { localDayStartIso, addDays } = await import('../format');
  const k = await rpc<Kpis>('service_kpis', { p_service: serviceId, p_from: from ? localDayStartIso(from, tz) : null, p_to: to ? localDayStartIso(addDays(to, 1), tz) : null });
  const wb = await newWorkbook();
  const m: [string, string][] = [...meta(s), ['Rango', from || to ? `${from || 'inicio'} a ${to || 'hoy'}` : 'Toda la operación']];
  sheetScales(wb, k, m); sheetHolds(wb, k, m);
  const wp = wb.addWorksheet('Productividad por producto');
  table(wp, sheetHeader(wp, 'Productividad por producto', m, 6), [
    { header: 'Producto', key: 'n', width: 18 }, { header: 'Camiones', key: 't', width: 12, fmt: F.int, total: 'sum' }, { header: 'Inicial (TM)', key: 'i', width: 15, fmt: F.tm, total: 'sum' },
    { header: 'Descargado (TM)', key: 'd', width: 16, fmt: F.tm, total: 'sum' }, { header: 'Pendiente (TM)', key: 'p', width: 15, fmt: F.tm, total: 'sum' }, { header: 'Toneladas en el rango', key: 'r', width: 18, fmt: F.tm, total: 'sum' },
  ], k.by_product.map((p) => ({ n: p.name, t: p.trucks, i: Number(p.initial_tm), d: Number(p.discharged_tm), p: Number(p.pending_tm), r: Number(p.tons) })));
  const wh = wb.addWorksheet('Toneladas por hora');
  table(wh, sheetHeader(wh, 'Toneladas y camiones por hora', m, 4), [
    { header: 'Hora (local)', key: 'h', width: 18 }, { header: 'Camiones', key: 't', width: 12, fmt: F.int, total: 'sum' }, { header: 'Toneladas', key: 'n', width: 14, fmt: F.tm, total: 'sum' }, { header: 'Acumulado (TM)', key: 'c', width: 16, fmt: F.tm },
  ], k.hourly.map((h) => ({ h: h.hour.replace('T', ' ').slice(0, 16), t: h.trucks, n: Number(h.tons), c: Number(h.cum_tons) })));
  await download(wb, `Productividad_${number}.xlsx`);
}

export async function exportCycles(rows: CycleRow[], tz: string, o: { title: string; filters: CycleFilters }) {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet('Ciclos');
  const LBL: Record<string, string> = { service: 'Servicio', customer: 'Cliente', vessel: 'Buque', hold: 'Bodega', product: 'Producto', scale: 'Báscula', shift: 'Turno', plate: 'Matrícula', ticket: 'Ticket', from: 'Desde', to: 'Hasta', status: 'Estado' };
  const show = (k: string, v: string) => k === 'service' ? (rows[0]?.service_number ?? v) : k === 'scale' ? (rows[0]?.scale_name ?? v) : k === 'product' ? (rows[0]?.product_name ?? v) : k === 'hold' ? `Bodega ${rows[0]?.hold_number ?? ''}` : k === 'status' ? (v === 'valid' ? 'Válidos' : 'Anulados') : k === 'shift' ? (rows[0]?.shift_name ?? v) : v;
  const f = Object.entries(o.filters).filter(([, v]) => v).map(([k, v]) => `${LBL[k] ?? k}: ${show(k, String(v))}`).join(' · ');
  table(ws, sheetHeader(ws, o.title, [['Filtros', f || 'Sin filtros'], ['Registros', String(rows.length)], ['Generado', stamp()]], CYCLE_SHEET.length), CYCLE_SHEET, cycleRows(rows, tz));
  const wt = wb.addWorksheet('Detalle de camiones');
  table(wt, sheetHeader(wt, 'Detalle de camiones', [['Filtros', f || 'Sin filtros']], TRUCK_COLS.length), TRUCK_COLS, truckRows(rows, tz));
  await download(wb, `${o.title.replace(/\s+/g, '_')}.xlsx`);
}

export async function exportDowntime(rows: DowntimeRow[], tz: string, serviceNumber?: string) {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet('Tiempos perdidos');
  table(ws, sheetHeader(ws, `Tiempos perdidos${serviceNumber ? ` · ${serviceNumber}` : ''}`, [['Eventos', String(rows.length)], ['Generado', stamp()]], DT_COLS.length), DT_COLS, dtRows(rows, tz));
  const by = new Map<string, { cause: string; cat: string; n: number; min: number }>();
  rows.forEach((d) => { const x = by.get(d.cause_name) ?? { cause: d.cause_name, cat: d.category_name, n: 0, min: 0 }; x.n++; x.min += Number(d.duration_minutes); by.set(d.cause_name, x); });
  const tot = [...by.values()].reduce((a, x) => a + x.min, 0);
  let cum = 0;
  const pareto = [...by.values()].sort((a, b) => b.min - a.min).map((x) => { cum += x.min; return { ...x, h: x.min / 60, pct: tot ? (x.min / tot) * 100 : 0, cum: tot ? (cum / tot) * 100 : 0 }; });
  const wp = wb.addWorksheet('Pareto de causas');
  table(wp, sheetHeader(wp, 'Pareto de causas de tiempo perdido', [['Generado', stamp()]], 7), [
    { header: 'Evento', key: 'cause', width: 30 }, { header: 'Categoría', key: 'cat', width: 16 }, { header: 'Eventos', key: 'n', width: 10, fmt: F.int, total: 'sum' }, { header: 'Minutos', key: 'min', width: 12, fmt: F.min, total: 'sum' },
    { header: 'Horas', key: 'h', width: 10, fmt: F.tm2, total: 'sum' }, { header: '% del total', key: 'pct', width: 12, fmt: F.pct }, { header: '% acumulado', key: 'cum', width: 13, fmt: F.pct },
  ], pareto);
  await download(wb, `Tiempos_perdidos${serviceNumber ? `_${serviceNumber}` : ''}.xlsx`);
}

export async function exportCustomerConsolidated(customerId: string, name: string) {
  const svcs = unwrap(await supabase.from('service_overview').select('id, service_number, status, vessel_name, terminal_name, timezone, products, initial_tm, discharged_tm, pending_tm, progress_pct, actual_start, planned_start, finalized_at').eq('customer_id', customerId).order('created_at')) as (SvcInfo & { products: string })[];
  const reps = unwrap(await supabase.from('report_overview').select('service_number, version, status, signed_at, verification_code').eq('customer_id', customerId).order('service_number')) as { service_number: string; version: number; status: string; signed_at: string | null; verification_code: string }[];
  const wb = await newWorkbook();
  const ws = wb.addWorksheet('Servicios del cliente');
  table(ws, sheetHeader(ws, `Reporte consolidado · ${name}`, [['Servicios', String(svcs.length)], ['Generado', stamp()]], 11), [
    { header: 'Servicio', key: 'n', width: 14 }, { header: 'Buque', key: 'v', width: 22 }, { header: 'Terminal', key: 't', width: 18 }, { header: 'Productos', key: 'p', width: 24 },
    { header: 'Inicio', key: 's', width: 14, fmt: F.date }, { header: 'Finalización', key: 'e', width: 14, fmt: F.date }, { header: 'Estado', key: 'st', width: 16 },
    { header: 'Tonelaje inicial (TM)', key: 'i', width: 16, fmt: F.tm, total: 'sum' }, { header: 'Descargado (TM)', key: 'd', width: 16, fmt: F.tm, total: 'sum' }, { header: 'Pendiente (TM)', key: 'pe', width: 15, fmt: F.tm, total: 'sum' }, { header: 'Avance (%)', key: 'a', width: 11, fmt: F.pct },
  ], svcs.map((x) => ({ n: x.service_number, v: x.vessel_name, t: x.terminal_name, p: x.products, s: localDate(x.actual_start ?? x.planned_start, x.timezone), e: localDate(x.finalized_at, x.timezone),
    st: SERVICE_STATUS[x.status]?.label ?? x.status, i: Number(x.initial_tm), d: Number(x.discharged_tm), pe: Number(x.pending_tm), a: Number(x.progress_pct) })));
  const wr = wb.addWorksheet('Informes emitidos');
  table(wr, sheetHeader(wr, 'Informes finales emitidos', [['Generado', stamp()]], 5), [
    { header: 'Servicio', key: 's', width: 14 }, { header: 'Versión', key: 'v', width: 9, fmt: F.int }, { header: 'Estado', key: 'st', width: 16 }, { header: 'Firmado', key: 'f', width: 18, fmt: F.datetime }, { header: 'Código de verificación', key: 'c', width: 24 },
  ], reps.map((r) => ({ s: r.service_number, v: r.version, st: r.status === 'signed' ? 'Vigente' : r.status === 'superseded' ? 'Sustituido' : 'Pendiente de firma', f: r.signed_at ? new Date(r.signed_at) : null, c: r.verification_code })));
  await download(wb, `Consolidado_${name}.xlsx`);
}

export { cyclesQuery };
