// deno-lint-ignore-file no-explicit-any
/**
 * Generador del INFORME FINAL DE OPERACIÓN DE DESCARGA (PDF).
 * Módulo puro: recibe la librería pdf-lib por parámetro para ejecutarse igual en
 * Supabase Edge Functions (Deno) y en las pruebas unitarias (Node).
 *
 * Firma: este documento lleva una FIRMA GRÁFICA (imagen) y un SELLO de la empresa,
 * más un código de verificación cuyo hash SHA-256 queda registrado en el sistema.
 * No es una firma electrónica criptográfica con certificado.
 */

export type ReportImages = {
  orgLogo?: Uint8Array | null;
  customerLogo?: Uint8Array | null;
  signature?: Uint8Array | null;
  seal?: Uint8Array | null;
};

export type ReportOptions = {
  mode: 'draft' | 'signed';
  version: number;
  verificationCode: string;
  verifyUrl?: string;
  issuedAt?: Date;
  signer?: { name: string; position: string } | null;
  sealName?: string | null;
  changeSummary?: string | null;
};

type RGB = { r: number; g: number; b: number };

const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
/** Las fuentes estándar de PDF usan WinAnsi: se sustituyen caracteres fuera de rango. */
export function sanitize(v: unknown): string {
  const s = String(v ?? '')
    .replace(/[‐-‒]/g, '-')
    .replace(/→/g, '->')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[  ]/g, ' ')
    .replace(/\r?\n/g, ' ');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch) ? ch : '?';
  }
  return out;
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x0b4f71;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const mix = (c: RGB, w: number): RGB => ({ r: c.r + (1 - c.r) * w, g: c.g + (1 - c.g) * w, b: c.b + (1 - c.b) * w });

const nf = (d: number) => new Intl.NumberFormat('es-GT', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt0 = (v: unknown) => (v == null || v === '' ? '—' : nf(0).format(Number(v)));
const fmt1 = (v: unknown) => (v == null || v === '' ? '—' : nf(1).format(Number(v)));
const fmt2 = (v: unknown) => (v == null || v === '' ? '—' : nf(2).format(Number(v)));
const fmt3 = (v: unknown) => (v == null || v === '' ? '—' : nf(3).format(Number(v)));
const hours = (min: unknown) => (min == null ? '—' : `${nf(2).format(Number(min) / 60)} h`);

const STATUS: Record<string, string> = {
  scheduled: 'Programado', preparing: 'En preparación', in_operation: 'En operación', suspended: 'Suspendido',
  closing: 'En proceso de cierre', finalized: 'Finalizado', cancelled: 'Cancelado',
};
const SCOPE: Record<string, string> = { operation: 'Operación', hold: 'Bodega', scale: 'Báscula' };

export function maskDpi(dpi: string, mode: string): string {
  const d = String(dpi || '').replace(/\D/g, '');
  if (mode === 'full') return d.length === 13 ? `${d.slice(0, 4)} ${d.slice(4, 9)} ${d.slice(9)}` : d;
  return d.length >= 4 ? `**** ***** ${d.slice(-4)}` : '****';
}

function formatInTz(date: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((x: any) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

type Col = { h: string; w: number; align?: 'l' | 'r' | 'c' };

export async function buildReportPdf(PDFLib: any, data: any, images: ReportImages, opt: ReportOptions): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const brand = hexToRgb(data.template?.primary_color || '#0b4f71');
  const C = {
    brand: rgb(brand.r, brand.g, brand.b),
    brandSoft: (() => { const c = mix(brand, 0.88); return rgb(c.r, c.g, c.b); })(),
    ink: rgb(0.06, 0.11, 0.17), mute: rgb(0.35, 0.42, 0.47), line: rgb(0.86, 0.89, 0.92),
    zebra: rgb(0.965, 0.973, 0.98), red: rgb(0.81, 0.23, 0.15), white: rgb(1, 1, 1), warn: rgb(0.61, 0.39, 0),
  };

  const svc = data.service || {};
  const tz = data.terminal?.timezone || 'America/Guatemala';
  const m = data.metrics || {};
  const totals = m.totals || {};
  const dpiMode = data.settings?.dpi_exposure_in_reports || 'masked';
  const title = sanitize(data.template?.title || 'INFORME FINAL DE OPERACIÓN DE DESCARGA');

  const embed = async (bytes?: Uint8Array | null) => {
    if (!bytes || bytes.length < 8) return null;
    try {
      if (bytes[0] === 0x89 && bytes[1] === 0x50) return await doc.embedPng(bytes);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return await doc.embedJpg(bytes);
    } catch (_) { /* imagen inválida: se omite */ }
    return null;
  };
  const [orgLogo, custLogo, sigImg, sealImg] = await Promise.all([
    embed(images.orgLogo), data.template?.show_customer_logo === false ? null : embed(images.customerLogo),
    embed(images.signature), embed(images.seal)]);

  const PORTRAIT: [number, number] = [595.28, 841.89];
  const LANDSCAPE: [number, number] = [841.89, 595.28];
  const MX = 42;
  let page: any; let W = 0; let H = 0; let y = 0;
  const pages: { page: any; cover: boolean }[] = [];

  const text = (s: unknown, x: number, yy: number, size = 9, f = font, color = C.ink) =>
    page.drawText(sanitize(s), { x, y: yy, size, font: f, color });
  const width = (s: unknown, size = 9, f = font) => f.widthOfTextAtSize(sanitize(s), size);
  const fit = (s: unknown, max: number, size: number, f = font) => {
    let t = sanitize(s);
    if (width(t, size, f) <= max) return t;
    while (t.length > 1 && width(t + '…', size, f) > max) t = t.slice(0, -1);
    return t + '…';
  };
  const wrap = (s: unknown, max: number, size: number, f = font): string[] => {
    const words = sanitize(s).split(/\s+/).filter(Boolean);
    const lines: string[] = []; let cur = '';
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (width(cand, size, f) <= max) cur = cand;
      else { if (cur) lines.push(cur); cur = width(w, size, f) > max ? fit(w, max, size, f) : w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  };

  const header = () => {
    page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: C.brand });
    text(fit(data.organization?.name || '', W / 2, 9, bold), MX, H - 30, 9, bold, C.brand);
    const right = `Informe final · Servicio ${sanitize(svc.service_number)} · Versión ${opt.version}`;
    text(fit(right, W / 2 - MX, 8), W - MX - width(fit(right, W / 2 - MX, 8), 8), H - 30, 8, font, C.mute);
    page.drawLine({ start: { x: MX, y: H - 38 }, end: { x: W - MX, y: H - 38 }, thickness: 0.6, color: C.line });
  };
  const newPage = (size: [number, number] = PORTRAIT, cover = false) => {
    page = doc.addPage(size); W = size[0]; H = size[1];
    pages.push({ page, cover });
    if (!cover) header();
    y = H - 60;
  };
  const ensure = (h: number, size?: [number, number]) => { if (y - h < 56) newPage(size || [W, H]); };

  const section = (n: number, label: string) => {
    ensure(52);
    y -= 10;
    page.drawRectangle({ x: MX, y: y - 12, width: 4, height: 26, color: C.brand });
    text(`SECCIÓN ${n}`, MX + 12, y + 6, 7.5, bold, C.mute);
    text(label, MX + 12, y - 10, 13, bold, C.ink);
    y -= 30;
  };
  const para = (s: unknown, size = 9.5, color = C.ink, f = font) => {
    for (const ln of wrap(s, W - 2 * MX, size, f)) { ensure(size + 4); text(ln, MX, y, size, f, color); y -= size + 4; }
  };
  const kv = (rows: [string, unknown][], cols = 2) => {
    const cw = (W - 2 * MX) / cols; const lh = 30;
    for (let i = 0; i < rows.length; i += cols) {
      ensure(lh);
      for (let j = 0; j < cols && i + j < rows.length; j++) {
        const [k, v] = rows[i + j]; const x = MX + j * cw;
        text(k.toUpperCase(), x, y, 7, bold, C.mute);
        text(fit(v ?? '—', cw - 12, 10.5, bold), x, y - 13, 10.5, bold, C.ink);
      }
      y -= lh;
    }
    y -= 4;
  };
  const stat = (items: [string, string, boolean?][]) => {
    const gap = 8; const cw = (W - 2 * MX - gap * (items.length - 1)) / items.length; const h = 54;
    ensure(h + 8);
    items.forEach(([k, v, red], i) => {
      const x = MX + i * (cw + gap);
      page.drawRectangle({ x, y: y - h, width: cw, height: h, color: C.brandSoft });
      text(k.toUpperCase(), x + 10, y - 16, 7, bold, C.mute);
      let fs = 17; while (fs > 10 && width(v, fs, bold) > cw - 20) fs -= 0.5;
      text(fit(v, cw - 20, fs, bold), x + 10, y - 40, fs, bold, red ? C.red : C.ink);
    });
    y -= h + 14;
  };
  const table = (cols: Col[], rows: unknown[][], o: { size?: number; total?: unknown[]; pageSize?: [number, number] } = {}) => {
    const size = o.size ?? 8; const pad = 4; const lh = size + 3;
    const totalW = cols.reduce((a, c) => a + c.w, 0); const scale = (W - 2 * MX) / totalW;
    const ws = cols.map((c) => c.w * scale);
    const drawHead = () => {
      const hh = lh + 2 * pad + 2;
      page.drawRectangle({ x: MX, y: y - hh, width: W - 2 * MX, height: hh, color: C.brand });
      let x = MX;
      cols.forEach((c, i) => {
        const t = fit(c.h, ws[i] - 2 * pad, size, bold);
        const tx = c.align === 'r' ? x + ws[i] - pad - width(t, size, bold) : c.align === 'c' ? x + (ws[i] - width(t, size, bold)) / 2 : x + pad;
        text(t, tx, y - pad - size, size, bold, C.white); x += ws[i];
      });
      y -= hh;
    };
    ensure(60); drawHead();
    const all = o.total ? [...rows, o.total] : rows;
    all.forEach((r, ri) => {
      const isTotal = !!o.total && ri === all.length - 1;
      const f = isTotal ? bold : font;
      const cells = r.map((v, i) => (cols[i].align === 'r' ? [fit(v, ws[i] - 2 * pad, size, f)] : wrap(v, ws[i] - 2 * pad, size, f).slice(0, 3)));
      const rh = Math.max(...cells.map((c) => c.length)) * lh + 2 * pad - 2;
      if (y - rh < 56) { newPage([W, H]); drawHead(); }
      if (isTotal) page.drawRectangle({ x: MX, y: y - rh, width: W - 2 * MX, height: rh, color: C.brandSoft });
      else if (ri % 2 === 1) page.drawRectangle({ x: MX, y: y - rh, width: W - 2 * MX, height: rh, color: C.zebra });
      let x = MX;
      cells.forEach((lines, i) => {
        lines.forEach((ln, li) => {
          const c = cols[i];
          const tx = c.align === 'r' ? x + ws[i] - pad - width(ln, size, f) : c.align === 'c' ? x + (ws[i] - width(ln, size, f)) / 2 : x + pad;
          text(ln, tx, y - pad - size - li * lh + 1, size, f, C.ink);
        });
        x += ws[i];
      });
      y -= rh;
      page.drawLine({ start: { x: MX, y }, end: { x: W - MX, y }, thickness: 0.4, color: C.line });
    });
    y -= 12;
  };
  const sub = (s: string) => { ensure(28); y -= 4; text(s, MX, y, 10.5, bold, C.ink); y -= 14; };

  // ------------------------------------------------------------------ PORTADA
  newPage(PORTRAIT, true);
  page.drawRectangle({ x: 0, y: 0, width: 16, height: H, color: C.brand });
  const logoBox = async (img: any, x: number, yy: number, maxW: number, maxH: number, alignRight = false) => {
    if (!img) return;
    const s = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: alignRight ? x - w : x, y: yy - h, width: w, height: h });
  };
  await logoBox(orgLogo, 60, H - 56, 170, 70);
  await logoBox(custLogo, W - 50, H - 56, 140, 60, true);
  if (!orgLogo) text(data.organization?.name || '', 60, H - 86, 16, bold, C.brand);
  let cy = H * 0.62;
  for (const ln of wrap(title, W - 130, 26, bold)) { text(ln, 60, cy, 26, bold, C.ink); cy -= 32; }
  cy -= 6;
  page.drawRectangle({ x: 60, y: cy, width: 64, height: 4, color: C.brand });
  cy -= 34;
  const coverRows: [string, unknown][] = [
    ['Número de servicio', svc.service_number], ['Buque', (data.vessels?.length ? data.vessels : [data.vessel?.name]).join(' · ')],
    ['Cliente', data.customer?.trade_name], ['Terminal', data.terminal?.name],
    ['Fecha de inicio', data.dates?.start || '—'], ['Fecha de finalización', data.dates?.end || '—'],
  ];
  for (const [k, v] of coverRows) {
    text(k.toUpperCase(), 60, cy, 7.5, bold, C.mute);
    text(fit(v ?? '—', W - 140, 14, bold), 60, cy - 17, 14, bold, C.ink);
    cy -= 40;
  }
  text(`Versión ${opt.version}${opt.mode === 'draft' ? ' · BORRADOR PENDIENTE DE FIRMA' : ''}`, 60, 92, 9, bold, opt.mode === 'draft' ? C.warn : C.mute);
  text(`Código de verificación: ${opt.verificationCode}`, 60, 76, 9, font, C.mute);
  if (opt.changeSummary) text(fit(opt.changeSummary, W - 120, 8.5), 60, 60, 8.5, font, C.mute);

  // ------------------------------------------------------------------ 1. INFORMACIÓN GENERAL
  newPage();
  section(1, 'Información general');
  kv([
    ['Cliente', data.customer?.legal_name || data.customer?.trade_name], ['NIT del cliente', data.customer?.tax_id || '—'],
    ['Buque', data.vessel?.name], ['Número IMO', data.vessel?.imo_number || 'No registrado'],
    ['Terminal', data.terminal?.name], ['Servicio', svc.service_number],
    ['Productos', (data.metrics?.by_product || []).map((p: any) => p.name).join(', ') || '—'], ['Responsable', data.responsible || '—'],
    ['Inicio de operación', data.dates?.start || '—'], ['Finalización', data.dates?.end || '—'],
    ['Primer pesaje', data.dates?.first_ticket || '—'], ['Último pesaje', data.dates?.last_ticket || '—'],
    ['Estado', STATUS[svc.status] || svc.status], ['Empresa prestadora', data.organization?.legal_name || data.organization?.name],
  ]);

  // ------------------------------------------------------------------ 2. RESUMEN DE TONELAJE
  section(2, 'Resumen de tonelaje');
  stat([
    ['Tonelaje inicial', `${fmt3(totals.initial_tm)} TM`], ['Descargado', `${fmt3(totals.discharged_tm)} TM`],
    ['Pendiente', `${fmt3(totals.pending_tm)} TM`, Number(totals.pending_tm) > 0], ['Descarga', `${fmt2(totals.progress_pct)} %`],
  ]);

  // ------------------------------------------------------------------ 3. DETALLE DE BODEGAS
  section(3, 'Detalle de bodegas');
  const cargo = (data.cargo || []) as any[];
  const multiVessel = new Set(cargo.map((c) => c.vessel)).size > 1;
  table([
    { h: 'Bodega', w: 60 }, ...(multiVessel ? [{ h: 'Buque', w: 90 } as Col] : []), { h: 'Producto', w: 120 },
    { h: 'Inicial (TM)', w: 80, align: 'r' }, { h: 'Descargado (TM)', w: 90, align: 'r' }, { h: 'Pendiente (TM)', w: 85, align: 'r' }, { h: 'Avance', w: 55, align: 'r' },
  ], cargo.map((c) => [`Bodega ${c.hold_number}`, ...(multiVessel ? [c.vessel] : []), c.product, fmt3(c.initial_tm), fmt3(c.discharged_tm), fmt3(c.pending_tm),
    `${fmt1(Number(c.initial_tm) ? (Number(c.discharged_tm) / Number(c.initial_tm)) * 100 : 0)} %`]),
  { total: ['Total', ...(multiVessel ? [''] : []), '', fmt3(totals.initial_tm), fmt3(totals.discharged_tm), fmt3(totals.pending_tm), `${fmt1(totals.progress_pct)} %`] });

  // ------------------------------------------------------------------ 4. DETALLE DE BÁSCULAS
  section(4, 'Detalle de básculas');
  const bs = (m.by_scale || []) as any[];
  table([{ h: 'Báscula', w: 150 }, { h: 'Camiones', w: 70, align: 'r' }, { h: 'Tonelaje (TM)', w: 95, align: 'r' }, { h: 'Prom. por camión (TM)', w: 105, align: 'r' }, { h: 'Ciclo promedio', w: 95, align: 'r' }],
    bs.map((s) => [s.name, fmt0(s.trucks), fmt3(s.tons), fmt3(s.avg_tm_per_truck), s.avg_cycle_minutes == null ? '—' : `${fmt1(s.avg_cycle_minutes)} min`]),
    { total: ['Total', fmt0(m.trucks), fmt3(m.tons_in_range), fmt3(m.avg_tm_per_truck), m.avg_cycle_minutes == null ? '—' : `${fmt1(m.avg_cycle_minutes)} min`] });

  // ------------------------------------------------------------------ 5. REGISTROS DE CAMIONES (horizontal)
  const tickets = (data.tickets || []) as any[];
  newPage(LANDSCAPE);
  section(5, `Registros de camiones (${fmt0(tickets.length)} pesajes válidos)`);
  const showDpi = dpiMode !== 'hidden';
  const tcols: Col[] = [
    { h: 'Ticket', w: 58 }, { h: 'Matrícula', w: 58 }, { h: 'Matrícula TC', w: 58 }, { h: 'Piloto', w: 104 },
    ...(showDpi ? [{ h: 'DPI', w: 70 } as Col] : []), { h: 'Bruto (kg)', w: 54, align: 'r' }, { h: 'Tara (kg)', w: 52, align: 'r' }, { h: 'Neto (kg)', w: 54, align: 'r' },
    { h: 'Hora de inicio', w: 72 }, { h: 'Hora final', w: 72 }, { h: 'Báscula', w: 58 }, { h: 'Bodega', w: 36, align: 'c' }, { h: 'Producto', w: 64 },
  ];
  table(tcols, tickets.map((t) => [t.ticket, t.plate, t.tc || '—', t.driver, ...(showDpi ? [maskDpi(t.dpi, dpiMode)] : []),
    fmt0(t.gross_kg), fmt0(t.tare_kg), fmt0(t.net_kg), t.start, t.end, t.scale, t.hold, t.product]),
  { size: 7, total: ['Total', '', '', '', ...(showDpi ? [''] : []), '', '', fmt0(tickets.reduce((a, t) => a + Number(t.net_kg), 0)), '', '', '', '', ''] });
  if (data.voided_tickets) para(`Tickets anulados con motivo auditado (no incluidos en el tonelaje): ${fmt0(data.voided_tickets)}.`, 8.5, C.mute);
  if (dpiMode === 'masked') para('DPI con exposición limitada: se muestran solo los últimos cuatro dígitos.', 8, C.mute);

  // ------------------------------------------------------------------ 6. TIEMPOS PERDIDOS
  newPage();
  section(6, 'Tiempos perdidos');
  const dts = (data.downtime || []) as any[];
  if (!dts.length) para('No se registraron tiempos perdidos durante la operación.', 9.5, C.mute);
  else table([
    { h: 'Fecha', w: 52 }, { h: 'Inicio', w: 70 }, { h: 'Final', w: 70 }, { h: 'Evento', w: 110 }, { h: 'Alcance', w: 64 },
    { h: 'Duración', w: 54, align: 'r' }, { h: 'Observaciones', w: 120 },
  ], dts.map((d) => [d.date, d.start, d.end, d.cause, d.scope === 'hold' ? `Bodega ${d.hold}` : d.scope === 'scale' ? d.scale : SCOPE[d.scope],
    `${fmt0(d.minutes)} min`, d.observations || '—']),
  { size: 7.5, total: ['Total', '', '', '', '', hours(m.downtime_minutes_reported), ''] });
  const pareto = (m.downtime_by_cause || []) as any[];
  if (pareto.length) {
    sub('Principales causas (Pareto)');
    table([{ h: 'Evento', w: 180 }, { h: 'Categoría', w: 110 }, { h: 'Eventos', w: 60, align: 'r' }, { h: 'Tiempo', w: 80, align: 'r' }, { h: '% del total', w: 70, align: 'r' }, { h: '% acumulado', w: 70, align: 'r' }],
      pareto.map((p) => [p.cause, p.category, fmt0(p.events), hours(p.minutes), `${fmt1(p.pct)} %`, `${fmt1(p.cum_pct)} %`]));
  }

  // ------------------------------------------------------------------ 7. PRODUCTIVIDAD
  section(7, 'Productividad');
  stat([['Camiones procesados', fmt0(m.trucks)], ['Toneladas por hora', m.tph == null ? '—' : `${fmt2(m.tph)}`], ['Ciclo promedio', m.avg_cycle_minutes == null ? '—' : `${fmt1(m.avg_cycle_minutes)} min`], ['Horas perdidas', hours(m.downtime_minutes_reported)]]);
  kv([
    ['Ventana operativa (primer a último pesaje)', m.window_hours == null ? '—' : `${fmt2(m.window_hours)} h`],
    ['Tiempo perdido de toda la operación', hours(m.downtime_operation_minutes)],
    ['Tiempo efectivo de operación', m.effective_hours == null ? '—' : `${fmt2(m.effective_hours)} h`],
    ['Toneladas por hora efectiva', m.tph_effective == null ? '—' : `${fmt2(m.tph_effective)} TM/h`],
    ['Promedio por camión', m.avg_tm_per_truck == null ? '—' : `${fmt3(m.avg_tm_per_truck)} TM`],
    ['Camiones por hora', m.trucks_per_hour == null ? '—' : fmt2(m.trucks_per_hour)],
  ]);
  para('El tiempo de ciclo corresponde a la diferencia entre la hora final y la hora de inicio registradas en báscula. El tiempo perdido es el reportado manualmente; solo los eventos con alcance de toda la operación (fusionando solapamientos) se descuentan para obtener el tiempo efectivo. Los eventos de una bodega o báscula no se consideran parada total.', 8, C.mute);
  y -= 4;
  sub('Productividad por bodega');
  table([{ h: 'Bodega', w: 70 }, { h: 'Camiones', w: 70, align: 'r' }, { h: 'Descargado (TM)', w: 100, align: 'r' }, { h: 'Pendiente (TM)', w: 100, align: 'r' }, { h: 'Tiempo perdido', w: 90, align: 'r' }],
    (m.by_hold || []).map((h: any) => [`Bodega ${h.hold_number}`, fmt0(h.trucks), fmt3(h.discharged_tm), fmt3(h.pending_tm), hours(h.downtime_minutes)]));
  sub('Productividad por producto');
  table([{ h: 'Producto', w: 150 }, { h: 'Camiones', w: 70, align: 'r' }, { h: 'Inicial (TM)', w: 90, align: 'r' }, { h: 'Descargado (TM)', w: 100, align: 'r' }, { h: 'Pendiente (TM)', w: 90, align: 'r' }],
    (m.by_product || []).map((p: any) => [p.name, fmt0(p.trucks), fmt3(p.initial_tm), fmt3(p.discharged_tm), fmt3(p.pending_tm)]));
  sub('Resumen de rendimiento');
  para(`Se procesaron ${fmt0(m.trucks)} camiones con un promedio de ${fmt3(m.avg_tm_per_truck)} TM por camión, para un total de ${fmt3(totals.discharged_tm)} TM descargadas (${fmt2(totals.progress_pct)} % del tonelaje inicial). El ritmo fue de ${m.tph == null ? '—' : fmt2(m.tph)} TM/h en la ventana operativa y de ${m.tph_effective == null ? '—' : fmt2(m.tph_effective)} TM/h sobre el tiempo efectivo, con ${hours(m.downtime_minutes_reported)} de tiempo perdido reportado en ${fmt0(m.downtime_events)} eventos.`);

  // ------------------------------------------------------------------ 8. OBSERVACIONES Y CONCLUSIONES
  section(8, 'Observaciones y conclusiones');
  if (svc.observations) { sub('Observaciones de la operación'); para(svc.observations); }
  if (svc.closure_note) { sub('Nota de cierre y conciliación'); para(svc.closure_note); }
  sub('Conclusiones');
  para(data.report?.conclusions || 'Sin conclusiones registradas.');
  if (data.corrections) para(`Registros corregidos con trazabilidad completa en el sistema: ${fmt0(data.corrections)} solicitud(es).`, 8.5, C.mute);
  if (opt.changeSummary) para(opt.changeSummary, 8.5, C.warn, bold);

  // ------------------------------------------------------------------ 9. FIRMA Y SELLO
  section(9, 'Firma y sello digital');
  ensure(190);
  const top = y;
  const boxW = (W - 2 * MX - 16) / 2;
  page.drawRectangle({ x: MX, y: top - 150, width: boxW, height: 150, borderColor: C.line, borderWidth: 0.8 });
  page.drawRectangle({ x: MX + boxW + 16, y: top - 150, width: boxW, height: 150, borderColor: C.line, borderWidth: 0.8 });
  if (opt.mode === 'signed' && opt.signer) {
    if (sigImg) { const s = Math.min((boxW - 40) / sigImg.width, 70 / sigImg.height, 1); page.drawImage(sigImg, { x: MX + 20, y: top - 92, width: sigImg.width * s, height: sigImg.height * s }); }
    page.drawLine({ start: { x: MX + 20, y: top - 98 }, end: { x: MX + boxW - 20, y: top - 98 }, thickness: 0.6, color: C.mute });
    text(fit(opt.signer.name, boxW - 40, 10.5, bold), MX + 20, top - 114, 10.5, bold);
    text(fit(opt.signer.position, boxW - 40, 9), MX + 20, top - 128, 9, font, C.mute);
    text('Representante autorizado', MX + 20, top - 141, 7.5, font, C.mute);
    if (sealImg) { const s = Math.min((boxW - 40) / sealImg.width, 110 / sealImg.height, 1); page.drawImage(sealImg, { x: MX + boxW + 16 + (boxW - sealImg.width * s) / 2, y: top - 20 - sealImg.height * s, width: sealImg.width * s, height: sealImg.height * s }); }
    else text('Sello de la empresa no configurado', MX + boxW + 32, top - 76, 9, font, C.mute);
    if (opt.sealName) text(fit(opt.sealName, boxW - 40, 7.5), MX + boxW + 32, top - 141, 7.5, font, C.mute);
  } else {
    text('PENDIENTE DE FIRMA', MX + 20, top - 70, 14, bold, C.warn);
    text('Un firmante autorizado debe revisar y firmar esta versión.', MX + 20, top - 88, 8.5, font, C.mute);
    text('SELLO PENDIENTE', MX + boxW + 32, top - 70, 14, bold, C.warn);
  }
  y = top - 166;
  kv([
    ['Fecha y hora de emisión', opt.mode === 'signed' && opt.issuedAt ? `${formatInTz(opt.issuedAt, tz)} (${tz})` : 'Pendiente'],
    ['Código de verificación', opt.verificationCode],
  ]);
  para(`Firma gráfica y sello de la empresa incorporados por el firmante autorizado identificado en el sistema. La integridad de este documento se comprueba con el código de verificación${opt.verifyUrl ? ` en ${opt.verifyUrl}` : ''}, que muestra el hash SHA-256 registrado al firmar. Este documento no contiene una firma electrónica avanzada ni certificada.`, 7.5, C.mute);

  // ------------------------------------------------------------------ pies, numeración y marca de agua
  const total = pages.length;
  pages.forEach(({ page: pg }, i) => {
    page = pg; W = pg.getWidth(); H = pg.getHeight();
    if (opt.mode === 'draft') {
      pg.drawText('BORRADOR · PENDIENTE DE FIRMA', { x: W * 0.16, y: H * 0.3, size: 42, font: bold, color: C.warn, opacity: 0.08, rotate: degrees(32) });
    }
    pg.drawLine({ start: { x: MX, y: 40 }, end: { x: W - MX, y: 40 }, thickness: 0.5, color: C.line });
    const left = sanitize(data.template?.footer_text || data.settings?.report_footer || `${data.organization?.name || ''} · Generado con Vessel Control`);
    pg.drawText(fit(left, W * 0.55, 7), { x: MX, y: 28, size: 7, font, color: C.mute });
    const right = `Verificación ${opt.verificationCode} · Página ${i + 1} de ${total}`;
    pg.drawText(right, { x: W - MX - font.widthOfTextAtSize(right, 7), y: 28, size: 7, font, color: C.mute });
  });

  doc.setTitle(`${title} · ${sanitize(svc.service_number)} · v${opt.version}`);
  doc.setAuthor(sanitize(data.organization?.name || 'Vessel Control'));
  doc.setSubject(sanitize(`Servicio ${svc.service_number} · ${data.vessel?.name || ''}`));
  doc.setProducer('Vessel Control');
  doc.setCreator('Vessel Control');
  if (opt.issuedAt) { doc.setCreationDate(opt.issuedAt); doc.setModificationDate(opt.issuedAt); }
  return await doc.save({ useObjectStreams: true });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newVerificationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(b).map((x) => alphabet[x % 32]).join('');
  return `VC-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}
