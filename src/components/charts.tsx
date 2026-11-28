import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmt0, fmt1, fmt2 } from '@/lib/format';

/** Paleta categórica validada (orden fijo, el color sigue a la entidad). */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];

const axis = { stroke: 'var(--axis)', tick: { fill: 'rgb(var(--c-mute))', fontSize: 12 }, tickLine: false };

function Tip({ active, payload, label, unit, fmt = fmt1 }: { active?: boolean; payload?: { name: string; value: number; color: string; dataKey: string }[]; label?: string; unit?: string; fmt?: (v: unknown) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-bg px-3 py-2 text-[13px] shadow-pop">
      <div className="mb-1 font-semibold">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <i className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-mute">{p.name}</span>
          <span className="num ml-auto pl-3 font-semibold">{fmt(p.value)}{unit ? ` ${unit}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

export function ChartFrame({ title, sub, children, height = 240, empty }: { title?: ReactNode; sub?: ReactNode; children: ReactNode; height?: number; empty?: boolean }) {
  return (
    <figure className="min-w-0">
      {title && <figcaption className="mb-2"><span className="font-cond text-[17px] font-semibold">{title}</span>{sub && <span className="ml-2 text-[13px] text-mute">{sub}</span>}</figcaption>}
      <div style={{ height }} className="min-w-0">
        {empty ? <div className="flex h-full items-center justify-center rounded-lg bg-panel/60 text-[14px] text-mute">Sin datos en el periodo seleccionado</div> : children}
      </div>
    </figure>
  );
}

/** Columnas (una serie o apiladas por categoría). */
export function Columns({ data, x, series, unit, stacked, fmt = fmt1 }: {
  data: Record<string, unknown>[]; x: string; series: { key: string; name: string; color?: string }[]; unit?: string; stacked?: boolean; fmt?: (v: unknown) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }} barCategoryGap="22%">
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey={x} {...axis} minTickGap={18} />
        <YAxis {...axis} axisLine={false} tickFormatter={(v) => fmt0(v)} width={52} />
        <Tooltip cursor={{ fill: 'rgb(var(--c-sea) / 0.06)' }} content={<Tip unit={unit} fmt={fmt} />} />
        {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 13, color: 'rgb(var(--c-mute))' }} />}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} stackId={stacked ? 'a' : undefined} fill={s.color ?? SERIES[i % SERIES.length]}
            radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} stroke="rgb(var(--c-bg))" strokeWidth={stacked ? 1 : 0} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Avance acumulado frente al tonelaje programado (una sola escala). */
export function Cumulative({ data, x, y, target, name = 'Descargado acumulado' }: { data: Record<string, unknown>[]; x: string; y: string; target?: number; name?: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: -8 }}>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis dataKey={x} {...axis} minTickGap={24} />
        <YAxis {...axis} axisLine={false} tickFormatter={(v) => fmt0(v)} width={60} domain={[0, (m: number) => Math.max(m, target ?? 0)]} />
        <Tooltip content={<Tip unit="TM" fmt={fmt2} />} />
        {target != null && <ReferenceLine y={target} stroke="rgb(var(--c-red))" strokeDasharray="4 4" label={{ value: `Programado ${fmt0(target)} TM`, position: 'insideTopRight', fill: 'rgb(var(--c-mute))', fontSize: 12 }} />}
        <Line type="monotone" dataKey={y} name={name} stroke="var(--s1)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Barras horizontales con etiqueta directa (comparativos y Pareto sin doble eje). */
export function HBars({ rows, max, empty = 'Sin datos en el periodo.' }: {
  rows: { key: string; label: ReactNode; value: number; text: ReactNode; color?: string; extra?: ReactNode; highlight?: boolean }[]; max?: number; empty?: string;
}) {
  if (!rows.length) return <p className="py-4 text-[14px] text-mute">{empty}</p>;
  const mx = max ?? Math.max(1e-9, ...rows.map((r) => r.value));
  return (
    <div className="grid grid-cols-[minmax(90px,max-content)_minmax(60px,1fr)_auto] items-center gap-x-3 gap-y-2 text-[14px]">
      {rows.map((r) => (
        <div key={r.key} className="contents">
          <span className="truncate">{r.label}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-line" title={typeof r.text === 'string' ? r.text : undefined}>
            <i className="block h-full rounded-full transition-[width] duration-500 ease-out" style={{ width: `${Math.min(100, (r.value / mx) * 100)}%`, background: r.color ?? 'rgb(var(--c-sea))' }} />
          </span>
          <span className={`num whitespace-nowrap text-right ${r.highlight ? 'font-bold text-red' : 'font-semibold'}`}>{r.text}{r.extra && <span className="ml-2 font-normal text-mute">{r.extra}</span>}</span>
        </div>
      ))}
    </div>
  );
}

export const fmtTph = (v: unknown) => `${fmt2(v)} TM/h`;
