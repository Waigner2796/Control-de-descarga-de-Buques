
/** Exporta una tabla simple a PDF horizontal (listados filtrados: ciclos, tiempos perdidos). */
export async function tablePdf(opts: { title: string; subtitle?: string; org?: string; headers: string[]; widths: number[]; rows: (string | number)[][]; align?: ('l' | 'r')[]; totals?: (string | number)[] }) {
  const [{ PDFDocument, StandardFonts, rgb }, { sanitize }] = await Promise.all([import('pdf-lib'), import('../../supabase/functions/_shared/report-pdf')]);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 841.89, H = 595.28, M = 36, size = 7.5, lh = 14;
  const brand = rgb(11 / 255, 79 / 255, 113 / 255), mute = rgb(0.35, 0.42, 0.47), line = rgb(0.86, 0.89, 0.92);
  const sc = (W - 2 * M) / opts.widths.reduce((a, b) => a + b, 0);
  const ws = opts.widths.map((w) => w * sc);
  const fit = (s: unknown, max: number, f = font) => { let t = sanitize(s); while (t.length > 1 && f.widthOfTextAtSize(t, size) > max) t = t.slice(0, -2) + '…'; return t; };
  let page = doc.addPage([W, H]); let y = H - M;
  const pages = [page];
  const head = () => {
    page.drawRectangle({ x: M, y: y - lh, width: W - 2 * M, height: lh, color: brand });
    let x = M;
    opts.headers.forEach((h, i) => { const t = fit(h, ws[i] - 6, bold); const tx = opts.align?.[i] === 'r' ? x + ws[i] - 3 - bold.widthOfTextAtSize(t, size) : x + 3; page.drawText(t, { x: tx, y: y - lh + 4, size, font: bold, color: rgb(1, 1, 1) }); x += ws[i]; });
    y -= lh;
  };
  page.drawText(sanitize(opts.title), { x: M, y: y - 14, size: 15, font: bold, color: rgb(0.06, 0.11, 0.17) });
  page.drawText(sanitize([opts.org, opts.subtitle, `Generado ${new Date().toLocaleString('es-GT')}`].filter(Boolean).join(' · ')), { x: M, y: y - 28, size: 8, font, color: mute });
  y -= 42; head();
  const all = opts.totals ? [...opts.rows, opts.totals] : opts.rows;
  all.forEach((r, ri) => {
    if (y - lh < M + 14) { page = doc.addPage([W, H]); pages.push(page); y = H - M; head(); }
    const isT = !!opts.totals && ri === all.length - 1;
    if (ri % 2 === 1 || isT) page.drawRectangle({ x: M, y: y - lh, width: W - 2 * M, height: lh, color: isT ? rgb(0.88, 0.94, 0.97) : rgb(0.965, 0.973, 0.98) });
    let x = M;
    r.forEach((v, i) => { const f = isT ? bold : font; const t = fit(v, ws[i] - 6, f); const tx = opts.align?.[i] === 'r' ? x + ws[i] - 3 - f.widthOfTextAtSize(t, size) : x + 3; page.drawText(t, { x: tx, y: y - lh + 4, size, font: f }); x += ws[i]; });
    y -= lh;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.3, color: line });
  });
  pages.forEach((p, i) => p.drawText(`Página ${i + 1} de ${pages.length} · Vessel Control`, { x: W - M - 120, y: 18, size: 7, font, color: mute }));
  const bytes = await doc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${opts.title.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_')}.pdf`;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
