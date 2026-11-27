import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmt0 } from '@/lib/format';

export type ShipProduct = { cargo_id: string; name: string; color: string; initial_tm: number; pending_tm: number };
export type ShipHold = { id: string; hold_number: number; products: ShipProduct[] };

const RM = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function shade(hex: string, k: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
  return `rgb(${f((n >> 16) & 255)} ${f((n >> 8) & 255)} ${f(n & 255)})`;
}

/** Saldos mostrados con interpolación suave hacia los valores reales. */
function useAnimatedPending(holds: ShipHold[]) {
  const target = useMemo(() => Object.fromEntries(holds.flatMap((h) => h.products.map((p) => [p.cargo_id, Number(p.pending_tm)]))), [holds]);
  const [shown, setShown] = useState<Record<string, number>>(target);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  useEffect(() => {
    const from = { ...target, ...Object.fromEntries(Object.keys(target).filter((k) => k in shownRef.current).map((k) => [k, shownRef.current[k]])) };
    const changed = Object.keys(target).some((k) => Math.abs((from[k] ?? 0) - target[k]) > 0.001);
    if (!changed || RM) { setShown(target); return; }
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / 900), e = 1 - (1 - p) ** 3;
      setShown(Object.fromEntries(Object.keys(target).map((k) => [k, from[k] + (target[k] - from[k]) * e])));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return shown;
}

export function ShipView({ holds, selected, onSelect, vesselName, className }: {
  holds: ShipHold[]; selected?: string | null; onSelect?: (holdId: string) => void; vesselName?: string; className?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const uid = useId().replace(/:/g, '');
  useLayoutEffect(() => {
    const el = wrap.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el); setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const shown = useAnimatedPending(holds);
  const H = W < 560 ? 230 : Math.min(340, Math.max(260, W * 0.3));
  const ready = W > 0;
  const nar = W < 560;
  const sorted = [...holds].sort((a, b) => a.hold_number - b.hold_number);
  const n = Math.max(1, sorted.length);
  const pv = (p: ShipProduct) => shown[p.cargo_id] ?? Number(p.pending_tm);
  const tot = sorted.reduce((a, h) => a + h.products.reduce((b, p) => b + Number(p.initial_tm), 0), 0);
  const pt = sorted.reduce((a, h) => a + h.products.reduce((b, p) => b + pv(p), 0), 0);
  const prog = tot ? 1 - pt / tot : 0;

  const x0 = W * 0.015, x1 = W * 0.985, deck = H * 0.4, keel = H * 0.88, water = H * 0.7, lift = -prog * H * 0.06;
  const bowL = W * 0.07, sx0 = x1 - W * (nar ? 0.16 : 0.13), sx1 = x1 - W * 0.008, hx0 = x0 + bowL + W * 0.02, hx1 = sx0 - W * 0.012;
  const gap = Math.max(4, W * 0.007), hw = (hx1 - hx0 - gap * (n - 1)) / n;
  const top = deck + 4, bot = keel - 8, ih = bot - top, full = ih * 0.9;
  const hp = `M${x0},${deck - 16}L${x0 + bowL},${deck - 16}L${x0 + bowL},${deck}L${x1},${deck}L${x1},${deck + (keel - deck) * 0.5}Q${x1 - W * 0.004},${keel} ${x1 - W * 0.04},${keel}L${x0 + bowL * 0.95},${keel}C${x0 + bowL * 0.35},${keel} ${x0 + bowL * 0.06},${deck + (keel - deck) * 0.3} ${x0},${deck - 16}Z`;
  let wave = ''; for (let x = 0; x < W; x += 28) wave += `Q${x + 7},${water - 3} ${x + 14},${water} Q${x + 21},${water + 3} ${x + 28},${water}`;
  const lv = Math.min(H * 0.065, 22), stop = deck - 4 * lv;
  const cnt = Math.max(2, Math.floor((sx1 - sx0) / 12)), ww = (sx1 - sx0 - 8) / cnt;
  const fx = sx0 + (sx1 - sx0) * 0.55, fw = Math.max(8, W * 0.018);
  const products = useMemo(() => {
    const m = new Map<string, ShipProduct>();
    holds.forEach((h) => h.products.forEach((p) => m.set(p.color, p)));
    return [...m.values()];
  }, [holds]);
  const pid = (color: string) => `pt-${uid}-${color.replace('#', '')}`;

  return (
    <div ref={wrap} className={`w-full min-w-0 ${className ?? ''}`}>
      {!ready ? <div style={{ height: 260 }} aria-hidden /> : <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Buque ${vesselName ?? ''}: ${fmt0(prog * 100)} % descargado`} className="block select-none font-cond">
        <defs>
          {products.map((p) => (
            <pattern key={p.color} id={pid(p.color)} width="8" height="8" patternUnits="userSpaceOnUse">
              <rect width="8" height="8" fill={p.color} />
              <circle cx="2" cy="2" r="1.1" fill={shade(p.color, -0.3)} opacity=".8" />
              <circle cx="6" cy="5.5" r=".9" fill={shade(p.color, 0.3)} opacity=".6" />
            </pattern>
          ))}
          <clipPath id={`hull-${uid}`}><path d={hp} /></clipPath>
          <linearGradient id={`wg-${uid}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--water1)" /><stop offset="1" stopColor="var(--water2)" /></linearGradient>
        </defs>
        <path d={`M0,${water}${wave}L${W},${H}L0,${H}Z`} fill={`url(#wg-${uid})`} />
        <g transform={`translate(0,${lift.toFixed(1)})`}>
          <path d={hp} fill="var(--hull)" />
          <g clipPath={`url(#hull-${uid})`}>
            <rect x="0" y={water - lift} width={W} height={H} fill="#a8372a" />
            <rect x="0" y={water - lift - 3} width={W} height="3" fill="#e9eef2" />
          </g>
          <rect x={sx0} y={stop} width={sx1 - sx0} height={deck - stop} fill="var(--sup)" stroke="var(--hull)" />
          <rect x={sx0 - W * 0.012} y={stop - lv * 0.2} width={sx1 - sx0 + W * 0.012} height={lv * 0.55} fill="var(--sup)" stroke="var(--hull)" />
          {Array.from({ length: 4 }).flatMap((_, f) => Array.from({ length: cnt }).map((__, k) => (
            <rect key={`w${f}-${k}`} x={sx0 + 4 + k * ww} y={stop + f * lv + lv * 0.42} width={Math.max(2, ww - 4)} height={lv * 0.3} fill="var(--hull)" opacity=".75" />
          )))}
          <path d={`M${fx},${stop}L${fx + fw * 0.15},${stop - lv * 1.5}L${fx + fw * 1.1},${stop - lv * 1.5}L${fx + fw},${stop}Z`} fill="var(--hull)" />
          <rect x={fx + fw * 0.12} y={stop - lv * 1.15} width={fw * 0.92} height={lv * 0.32} fill="rgb(var(--c-sea))" />
          <line x1={x0 + bowL * 0.6} y1={deck - 16} x2={x0 + bowL * 0.6} y2={deck - 16 - lv * 1.6} stroke="var(--crane)" strokeWidth="3" />
          {Array.from({ length: n - 1 }).map((_, i) => {
            const cx = hx0 + (i + 1) * (hw + gap) - gap / 2, ph = H * 0.2, ty = deck - ph, jx = cx - hw * 0.3, jy = deck - ph * 1.35;
            return (
              <g key={`c${i}`}>
                <rect x={cx - 3.5} y={ty} width="7" height={ph} fill="var(--crane)" stroke="var(--hull)" strokeWidth=".8" />
                <line x1={cx} y1={ty + ph * 0.25} x2={jx} y2={jy} stroke="var(--crane)" strokeWidth="4" strokeLinecap="round" />
                {!nar && <><line x1={jx} y1={jy} x2={jx} y2={deck - 26} stroke="rgb(var(--c-mute))" /><path d={`M${jx - 6},${deck - 26}L${jx + 6},${deck - 26}L${jx + 4},${deck - 20}L${jx - 4},${deck - 20}Z`} fill="rgb(var(--c-mute))" /></>}
              </g>
            );
          })}
          {sorted.map((h, i) => {
            const hx = hx0 + i * (hw + gap);
            const T0 = h.products.reduce((a, p) => a + Number(p.initial_tm), 0), T = T0 || 1;
            const P = h.products.reduce((a, p) => a + pv(p), 0);
            const pctDone = Math.round((1 - P / T) * 100);
            const layers = h.products.map((p) => ({ p, v: pv(p) })).filter((l) => l.v > 0);
            let y = bot;
            const sel = selected === h.id;
            const ly = bot - full, empty = bot - (full * P) / T - ly, inside = empty < 26;
            return (
              <g key={h.id} role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined}
                aria-label={`Bodega ${h.hold_number}: ${pctDone} % descargado, ${fmt0(P)} TM pendientes`}
                onClick={onSelect ? () => onSelect(h.id) : undefined}
                onKeyDown={onSelect ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(h.id); } } : undefined}
                className={onSelect ? 'cursor-pointer outline-none [&:focus-visible>rect:last-of-type]:stroke-[rgb(var(--c-sea))]' : undefined}>
                <rect x={hx} y={top} width={hw} height={ih} fill="var(--hold)" />
                {layers.map((l, j) => {
                  const lh = (full * l.v) / T, yt = y - lh;
                  const el = j === layers.length - 1 && lh > 3
                    ? <path key={l.p.cargo_id} d={`M${hx},${y}L${hx},${yt + Math.min(7, lh * 0.5)}Q${hx + hw / 2},${yt - Math.min(7, lh * 0.5)} ${hx + hw},${yt + Math.min(7, lh * 0.5)}L${hx + hw},${y}Z`} fill={`url(#${pid(l.p.color)})`} />
                    : <rect key={l.p.cargo_id} x={hx} y={yt} width={hw} height={lh} fill={`url(#${pid(l.p.color)})`} />;
                  y = yt;
                  return el;
                })}
                <line x1={hx + 2} x2={hx + hw - 2} y1={bot - full} y2={bot - full} stroke="rgb(var(--c-mute))" strokeDasharray="3 3" />
                <rect x={hx + 2} y={deck - 18} width={Math.max(0, hw - 4)} height="18" fill={sel ? 'rgb(var(--c-sea))' : 'var(--coam)'} />
                <text x={hx + hw / 2} y={deck - 4.5} textAnchor="middle" fill="#fff" fontWeight="700" fontSize="13">B{h.hold_number}</text>
                {inside && T0 > 0 && <rect x={hx + hw / 2 - 23} y={ly + 4} width="46" height="20" rx="10" fill="rgb(15 29 43 / .62)" />}
                <text x={hx + hw / 2} y={ly + 19} textAnchor="middle" fontSize="15" fontWeight="700" fill={inside ? '#fff' : 'rgb(var(--c-ink))'}>
                  {T0 ? `${pctDone}%` : '—'}
                </text>
                {!nar && empty > 46 && hw > 70 && <text x={hx + hw / 2} y={ly + 37} textAnchor="middle" fontSize="12.5" fill="rgb(var(--c-mute))">{fmt0(P)} TM</text>}
                <rect x={hx} y={top} width={hw} height={ih} fill="none" stroke={sel ? 'rgb(var(--c-sea))' : 'var(--coam)'} strokeWidth={sel ? 3 : 1} />
              </g>
            );
          })}
        </g>
      </svg>}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-mute">
        {products.map((p) => <span key={p.color} className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />{p.name}</span>)}
        <span>Línea punteada: carga inicial · el porcentaje es lo descargado{onSelect ? ' · toque una bodega para ver el detalle' : ''}</span>
      </div>
    </div>
  );
}
