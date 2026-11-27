/**
 * Formato de los libros Excel de Vessel Control.
 *
 * IMPORTANTE: la plantilla Excel oficial de la empresa NO se adjuntó al repositorio.
 * Este archivo concentra todo el formato (colores, fuentes, anchos, formatos numéricos,
 * encabezados, impresión) y el orden de columnas de cada hoja, partiendo de la
 * estructura que ya usaba el prototipo (legacy/prototipo-control-descarga.html).
 * Cuando se reciba la plantilla, se ajusta AQUÍ para reproducirla fielmente
 * (hojas, encabezados, fórmulas, colores, bordes, logotipos y diseño de impresión).
 */
import type { Workbook, Worksheet } from 'exceljs';

export const STYLE = {
  brand: 'FF0B4F71',
  brandSoft: 'FFE2F0F8',
  zebra: 'FFF5F7F9',
  border: 'FFC5D0DA',
  font: 'Calibri',
  fmt: { kg: '#,##0', tm: '#,##0.000', tm2: '#,##0.00', pct: '0.00"%"', int: '#,##0', min: '#,##0.0', date: 'dd/mm/yyyy', time: 'hh:mm', datetime: 'dd/mm/yyyy hh:mm' },
};

export type Col = { header: string; key: string; width: number; fmt?: string; total?: 'sum' | 'avg' | 'count' };

const thin = { style: 'thin' as const, color: { argb: STYLE.border } };

/** Bloque de encabezado del libro (empresa, título y metadatos). Devuelve la fila donde empieza la tabla. */
export function sheetHeader(ws: Worksheet, title: string, meta: [string, string][], span: number) {
  ws.mergeCells(1, 1, 1, Math.max(2, span));
  const t = ws.getCell(1, 1);
  t.value = title;
  t.font = { name: STYLE.font, size: 15, bold: true, color: { argb: STYLE.brand } };
  meta.forEach(([k, v], i) => {
    const r = ws.getRow(2 + i);
    r.getCell(1).value = k; r.getCell(1).font = { name: STYLE.font, size: 9, bold: true, color: { argb: 'FF5A6A79' } };
    r.getCell(2).value = v; r.getCell(2).font = { name: STYLE.font, size: 10 };
  });
  return 3 + meta.length;
}

/** Tabla con encabezado de marca, bordes, filas alternas, autofiltro, fila de totales con fórmulas y paneles fijos. */
export function table(ws: Worksheet, startRow: number, cols: Col[], rows: Record<string, unknown>[], opts: { totalsLabel?: string } = {}) {
  ws.columns.forEach(() => undefined);
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  const head = ws.getRow(startRow);
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: STYLE.font, size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE.brand } };
    cell.alignment = { vertical: 'middle', horizontal: c.fmt ? 'right' : 'left', wrapText: true };
    cell.border = { top: thin, bottom: thin, left: thin, right: thin };
  });
  head.height = 30;
  rows.forEach((r, ri) => {
    const row = ws.getRow(startRow + 1 + ri);
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      const v = r[c.key];
      cell.value = (v ?? null) as never;
      cell.font = { name: STYLE.font, size: 10 };
      if (c.fmt) { cell.numFmt = c.fmt; cell.alignment = { horizontal: 'right' }; }
      cell.border = { bottom: thin, left: thin, right: thin };
      if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE.zebra } };
    });
  });
  const last = startRow + rows.length;
  if (cols.some((c) => c.total) && rows.length) {
    const tr = ws.getRow(last + 1);
    tr.getCell(1).value = opts.totalsLabel ?? 'Total';
    cols.forEach((c, i) => {
      const cell = tr.getCell(i + 1);
      const L = ws.getColumn(i + 1).letter;
      if (c.total) cell.value = { formula: c.total === 'sum' ? `SUM(${L}${startRow + 1}:${L}${last})` : c.total === 'avg' ? `AVERAGE(${L}${startRow + 1}:${L}${last})` : `COUNTA(${L}${startRow + 1}:${L}${last})` } as never;
      if (c.fmt) cell.numFmt = c.fmt;
      cell.font = { name: STYLE.font, size: 10, bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE.brandSoft } };
      cell.border = { top: thin, bottom: thin, left: thin, right: thin };
    });
  }
  ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: Math.max(startRow, last), column: cols.length } };
  ws.views = [{ state: 'frozen', ySplit: startRow, xSplit: 0 }];
  ws.pageSetup = { orientation: cols.length > 8 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  ws.pageSetup.printTitlesRow = `${startRow}:${startRow}`;
  ws.headerFooter = { oddFooter: '&L&8Vessel Control&R&8Página &P de &N' };
  return last;
}

export async function newWorkbook(): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vessel Control';
  wb.created = new Date();
  return wb;
}

export async function download(wb: Workbook, filename: string) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Excel almacena fechas sin zona: se convierte el instante UTC a la hora local de la terminal. */
export function localDate(iso: string | null | undefined, tz: string): Date | null {
  if (!iso) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second));
}
