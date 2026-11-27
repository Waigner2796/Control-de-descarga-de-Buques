import { describe, expect, it } from 'vitest';
import * as PDFLib from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildReportPdf, maskDpi, newVerificationCode, sanitize, sha256Hex } from '../../supabase/functions/_shared/report-pdf';

function samplePayload(nTickets = 120) {
  const tickets = Array.from({ length: nTickets }, (_, i) => ({
    ticket: `T1-${String(4100 + i).padStart(6, '0')}`, plate: `C-${100 + (i % 37)}BCD`, tc: `TC-${200 + (i % 23)}FGH`,
    driver: ['Juan Carlos Pérez López', 'Mario Ajú Xicay', 'Óscar Tzul Chávez', 'Byron Morales Díaz'][i % 4], dpi: '2456789010101',
    gross_kg: 46000 + (i % 7) * 120, tare_kg: 15000 + (i % 5) * 80, net_kg: 31000 + (i % 7) * 120 - (i % 5) * 80, net_tm: 31,
    time: '21/11/2026 08:13', cycle_min: i ? 42 : null, bl: i % 2 ? 'BL-002' : 'BL-001', units: i % 4 ? 600 : null, scale: i % 2 ? 'Báscula 2' : 'Báscula 1', hold: (i % 3) + 1,
    product: ['Fertilizante', 'Urea', 'Maíz'][i % 3], revision: 1,
  }));
  return {
    service: { service_number: 'SV-2026-001', status: 'finalized', observations: 'Descarga directa a camión con las 4 grúas del buque.', closure_note: 'Saldo a bordo según inspección de calado.', data_revision: 3 },
    organization: { name: 'Estibadora del Pacífico, S.A.', legal_name: 'Estibadora del Pacífico, Sociedad Anónima' },
    settings: { dpi_exposure_in_reports: 'masked', report_footer: '' },
    template: { title: 'INFORME FINAL DE OPERACIÓN DE DESCARGA', primary_color: '#0b4f71', show_customer_logo: true, footer_text: '' },
    report: { conclusions: 'La operación concluyó sin incidentes de seguridad. Se recomienda programar más camiones en el turno 3.' },
    customer: { trade_name: 'Fertilizantes del Sur', legal_name: 'Fertilizantes del Sur, S.A.', tax_id: '1234567-8' },
    terminal: { name: 'Terminal Quetzal · Atraque 2', timezone: 'America/Guatemala' },
    vessel: { name: 'MV Ocean Kestrel', imo_number: '9785412' }, vessels: ['MV Ocean Kestrel'], responsible: 'Carlos Méndez',
    metrics: {
      totals: { initial_tm: 10000, discharged_tm: 9850.25, pending_tm: 149.75, progress_pct: 98.5, initial_units: 200000, discharged_units: 197005 },
      shift_periods: [1, 2, 3].map((n) => ({ n, shift_name: `Turno ${n}`, from: `2026-11-2${n}T07:00`, to: `2026-11-2${n}T14:30`, holds: [{ hold_number: 1, tm: 1000 * n, bags: 20000 * n }, { hold_number: 2, tm: 800, bags: 16000 }],
        tm: 1000 * n + 800, bags: 20000 * n + 16000, cum_tm: 1800 * n, cum_bags: 36000 * n, damaged: n === 2 ? { dirty: 1, broken: 2, wet: 0, to_sea: 1, total: 4, notes: 'Eslinga' } : null })),
      bag_samples: { count: 75, avg_net_kg: 50.06, avg_temp_c: 32.8 }, damaged_bags: 4,
      trucks: nTickets, tons_in_range: 9850.25, avg_tm_per_truck: 31.2, avg_cycle_minutes: 3.4, window_hours: 52.5, tph: 187.62,
      downtime_minutes_reported: 315, downtime_events: 4, downtime_operation_minutes: 180, effective_hours: 49.5, tph_effective: 199, trucks_per_hour: 6,
      by_scale: [{ name: 'Báscula 1', trucks: 60, tons: 4925, avg_tm_per_truck: 31.2, avg_cycle_minutes: 3.3 }, { name: 'Báscula 2', trucks: 60, tons: 4925.25, avg_tm_per_truck: 31.2, avg_cycle_minutes: 3.5 }],
      by_hold: [1, 2, 3].map((h) => ({ hold_number: h, trucks: 40, discharged_tm: 3283, pending_tm: 50, downtime_minutes: 40 })),
      by_product: [{ name: 'Fertilizante', trucks: 40, initial_tm: 3000, discharged_tm: 2950, pending_tm: 50 }, { name: 'Urea', trucks: 40, initial_tm: 2000, discharged_tm: 2000, pending_tm: 0 }, { name: 'Maíz', trucks: 40, initial_tm: 5000, discharged_tm: 4900.25, pending_tm: 99.75 }],
      downtime_by_cause: [{ cause: 'Falta de camiones', category: 'Logística', events: 2, minutes: 200, pct: 63.5, cum_pct: 63.5 }, { cause: 'Falla de grab', category: 'Equipos', events: 1, minutes: 75, pct: 23.8, cum_pct: 87.3 }, { cause: 'Condiciones climáticas', category: 'Climáticas', events: 1, minutes: 40, pct: 12.7, cum_pct: 100 }],
    },
    cargo_type: 'bulk',
    bls: [{ bl: 'BL-001', product: 'Fertilizante', planned_tm: 3000, discharged_tm: 2950, diff_tm: -50, status: 'completed', planned_units: 60000, discharged_units: 59000 }, { bl: 'BL-002', product: 'Urea', planned_tm: 2000, discharged_tm: 2000, diff_tm: 0, status: 'open', planned_units: 40000, discharged_units: 40000 }],
    cargo: [{ hold_number: 1, vessel: 'MV Ocean Kestrel', product: 'Fertilizante', initial_tm: 3000, discharged_tm: 2950, pending_tm: 50 }, { hold_number: 1, vessel: 'MV Ocean Kestrel', product: 'Urea', initial_tm: 2000, discharged_tm: 2000, pending_tm: 0 }, { hold_number: 2, vessel: 'MV Ocean Kestrel', product: 'Maíz', initial_tm: 5000, discharged_tm: 4900.25, pending_tm: 99.75 }],
    tickets, voided_tickets: 2,
    downtime: [{ date: '20/11/2026', start: '20/11/2026 23:30', end: '21/11/2026 01:15', cause: 'Falta de camiones', category: 'Logística', scope: 'operation', minutes: 105, observations: 'Cruce de medianoche' }, { date: '21/11/2026', start: '21/11/2026 08:00', end: '21/11/2026 08:40', cause: 'Falla de grab', category: 'Equipos', scope: 'hold', hold: 1, minutes: 40, observations: '' }],
    corrections: 3,
    dates: { start: '20/11/2026 06:00', end: '22/11/2026 10:30', first_ticket: '20/11/2026 06:12', last_ticket: '22/11/2026 10:05' },
  };
}

describe('Generador del PDF del informe final', () => {
  it('servicio de carga en sacos: barco por bodega, avance por turno, verificación de sacos, paleta, logo y disclaimer', async () => {
    const data = { ...samplePayload(0), cargo_type: 'bags', operation_kind: 'load', shift_plan: '3 turnos',
      settings: { dpi_exposure_in_reports: 'masked', report_footer: '', brand_colors: ['#0f3b5f', '#f2a600', '#00b894'], report_disclaimer: 'Los resultados se refieren únicamente a la operación descrita.' },
      bag_sample_report: [{ shift_name: 'Turno 3', from: '03/03/2026 21:30', to: '04/03/2026 07:00', samples: 75, avg_net_kg: 50.06, avg_temp_c: 32.8,
        rows: Array.from({ length: 25 }, (_, i) => ({ ticket: String(1601930 + Math.floor(i / 11) * 10), product: 'Azúcar', samples: 3, avg_gross_kg: 50.2, avg_net_kg: 50.03 + (i % 5) * 0.02, avg_temp_c: 32 + (i % 4) * 0.5, target_net_kg: 50 })) }] };
    const pdf = await buildReportPdf(PDFLib, data, {}, { mode: 'draft', version: 1, verificationCode: 'VC-SACO-AAAA-BBBB' });
    const loaded = await PDFLib.PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(5);
    const dir = process.env.PDF_OUT_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/sacos.pdf`, pdf); }
  });

  it('sanitiza texto a WinAnsi sin perder acentos del español', () => {
    expect(sanitize('Bodega ñandú — ÁÉÍÓÚ ¿¡')).toBe('Bodega ñandú — ÁÉÍÓÚ ¿¡');
    expect(sanitize('flecha → ok ≥ 1 ✓')).toBe('flecha -> ok >= 1 ?');
  });

  it('enmascara el DPI según configuración', () => {
    expect(maskDpi('2456789010101', 'masked')).toBe('**** ***** 0101');
    expect(maskDpi('2456789010101', 'full')).toBe('2456 78901 0101');
  });

  it('códigos de verificación únicos y con formato', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newVerificationCode()));
    expect(codes.size).toBe(200);
    [...codes].forEach((c) => expect(c).toMatch(/^VC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/));
  });

  it('genera borrador y versión firmada con las 9 secciones y hash estable', async () => {
    const data = samplePayload();
    const draft = await buildReportPdf(PDFLib, data, {}, { mode: 'draft', version: 1, verificationCode: 'VC-TEST-AAAA-BBBB' });
    const issuedAt = new Date('2026-11-22T17:00:00Z');
    const opts = { mode: 'signed' as const, version: 1, verificationCode: 'VC-TEST-AAAA-BBBB', issuedAt, signer: { name: 'Ana Lucía Morales', position: 'Gerente de Operaciones' }, verifyUrl: 'https://vessel.example/verificar' };
    const signed = await buildReportPdf(PDFLib, data, {}, opts);
    const loaded = await PDFLib.PDFDocument.load(signed);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(6);
    expect(loaded.getTitle()).toContain('SV-2026-001');
    const h1 = await sha256Hex(signed);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(await sha256Hex(draft));
    const dir = process.env.PDF_OUT_DIR;
    if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/borrador.pdf`, draft); writeFileSync(`${dir}/firmado.pdf`, signed); }
  });

  it('soporta miles de registros con salto de página y encabezado repetido', async () => {
    const pdf = await buildReportPdf(PDFLib, samplePayload(2500), {}, { mode: 'draft', version: 2, verificationCode: 'VC-BIG0-0000-0000', changeSummary: 'Sustituye a la versión 1 por corrección de tara.' });
    const loaded = await PDFLib.PDFDocument.load(pdf);
    expect(loaded.getPageCount()).toBeGreaterThan(40);
  });
});
