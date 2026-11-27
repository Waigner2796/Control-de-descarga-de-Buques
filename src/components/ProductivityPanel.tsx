import { useMemo } from 'react';
import { hourLabel, useServiceKpis } from '@/lib/service-data';
import { addDays, date, fmt0, fmt1, fmt2, hours, localDayStartIso, minutes, pct } from '@/lib/format';
import { ChartFrame, Columns, Cumulative, HBars, SERIES } from '@/components/charts';
import { DataTable, Dot, ErrorBox, Kpi, Notice, Section, Skeleton } from '@/components/ui';

/** Indicadores de productividad de un servicio (opcionalmente en un rango de fechas locales). */
export function ProductivityPanel({ serviceId, tz, from, to, portal }: { serviceId: string; tz: string; from?: string; to?: string; portal?: boolean }) {
  const fromIso = from ? localDayStartIso(from, tz) : null;
  const toIso = to ? localDayStartIso(addDays(to, 1), tz) : null;
  const q = useServiceKpis(serviceId, fromIso, toIso);
  const k = q.data;
  const scaleIdx = useMemo(() => Object.fromEntries((k?.by_scale ?? []).map((s, i) => [s.scale_id, i])), [k]);
  const multiDay = (k?.daily.length ?? 0) > 1;
  const hourly = useMemo(() => {
    if (!k) return [];
    return k.hourly.map((h) => {
      const row: Record<string, unknown> = { hora: hourLabel(h.hour, multiDay), camiones: h.trucks, acumulado: Number(h.cum_tons) };
      k.hourly_by_scale.filter((x) => x.hour === h.hour).forEach((x) => { row[x.scale_id] = Number(x.tons); });
      return row;
    });
  }, [k, multiDay]);
  if (q.isLoading) return <div className="grid gap-3 md:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!k) return null;
  const tot = k.totals;
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Kpi label="Tonelaje inicial" value={`${fmt0(tot.initial_tm)} TM`} />
        <Kpi label="Descargado" value={`${fmt1(tot.discharged_tm)} TM`} sub={pct(tot.progress_pct)} tone={portal ? 'portal' : undefined} />
        <Kpi label="Pendiente" value={`${fmt1(tot.pending_tm)} TM`} tone="red" />
        <Kpi label="Camiones" value={fmt0(k.trucks)} sub={`${fmt2(k.trucks_per_hour)} por hora`} />
        <Kpi label="Promedio por camión" value={`${fmt2(k.avg_tm_per_truck)} TM`} />
        <Kpi label="Toneladas por hora" value={fmt1(k.tph)} sub="ventana operativa" />
        <Kpi label="Ciclo promedio" value={minutes(k.avg_cycle_minutes)} sub="final − inicio en báscula" />
        <Kpi label="Tiempo perdido" value={hours(k.downtime_minutes_reported)} sub={`${k.downtime_events} eventos reportados`} />
        <Kpi label="Parada de operación" value={hours(k.downtime_operation_minutes)} sub="solapes fusionados" />
        <Kpi label="Tiempo efectivo" value={k.effective_hours == null ? '—' : `${fmt1(k.effective_hours)} h`} sub={`de ${fmt1(k.window_hours)} h de ventana`} />
        <Kpi label="TM por hora efectiva" value={fmt1(k.tph_effective)} />
        <Kpi label="Avance" value={pct(tot.progress_pct)} />
      </div>
      <Notice tone="info">Ventana operativa: del primer al último pesaje{from || to ? ' dentro del rango' : ''}. El tiempo efectivo descuenta solo los tiempos perdidos de toda la operación; los de una bodega o báscula se muestran aparte. No se calculan esperas entre camiones porque no se registran esas marcas.</Notice>
      <div className="grid gap-5 xl:grid-cols-2">
        <Section title="Toneladas descargadas por hora" actions={<span className="text-[13px] text-mute">por báscula</span>}>
          <ChartFrame height={250} empty={!hourly.length}>
            <Columns data={hourly} x="hora" stacked unit="TM" series={k.by_scale.filter((s) => s.trucks > 0).map((s) => ({ key: s.scale_id, name: s.name, color: SERIES[scaleIdx[s.scale_id] % SERIES.length] }))} />
          </ChartFrame>
        </Section>
        <Section title="Camiones registrados por hora">
          <ChartFrame height={250} empty={!hourly.length}><Columns data={hourly} x="hora" series={[{ key: 'camiones', name: 'Camiones', color: 'var(--s3)' }]} fmt={fmt0} /></ChartFrame>
        </Section>
        <Section title="Avance acumulado del servicio">
          <ChartFrame height={250} empty={!hourly.length}><Cumulative data={hourly} x="hora" y="acumulado" target={Number(tot.initial_tm)} /></ChartFrame>
        </Section>
        <Section title="Comparativo de básculas">
          <HBars rows={k.by_scale.map((s) => ({ key: s.scale_id, label: <span className="inline-flex items-center gap-2"><Dot color={SERIES[scaleIdx[s.scale_id] % SERIES.length]} />{s.name}</span>, value: Number(s.tons), text: `${fmt1(s.tons)} TM`, extra: `${s.trucks} cam. · ${fmt1(s.tph)} TM/h · ciclo ${minutes(s.avg_cycle_minutes)}`, color: SERIES[scaleIdx[s.scale_id] % SERIES.length] }))} />
        </Section>
        <Section title="Productividad por bodega">
          <HBars rows={k.by_hold.map((h) => ({ key: h.service_hold_id, label: `Bodega ${h.hold_number}`, value: Number(h.discharged_tm), text: `${fmt1(h.discharged_tm)} TM`, extra: `${pct(Number(h.initial_tm) ? (Number(h.discharged_tm) / Number(h.initial_tm)) * 100 : 0)} · ${h.trucks} cam.${Number(h.downtime_minutes) ? ` · perdido ${hours(h.downtime_minutes)}` : ''}` }))} max={Math.max(...k.by_hold.map((h) => Number(h.initial_tm)), 1)} />
        </Section>
        <Section title="Productividad por producto">
          <HBars rows={k.by_product.map((p) => ({ key: p.product_id, label: <span className="inline-flex items-center gap-2"><Dot color={p.color} />{p.name}</span>, value: Number(p.discharged_tm), text: `${fmt1(p.discharged_tm)} TM`, extra: `de ${fmt0(p.initial_tm)} · ${p.trucks} cam.`, color: p.color }))} max={Math.max(...k.by_product.map((p) => Number(p.initial_tm)), 1)} />
        </Section>
        <Section title="Comparativo por turno">
          <HBars rows={k.by_shift.map((s) => ({ key: s.shift, label: s.shift, value: Number(s.tons), text: `${fmt1(s.tons)} TM`, extra: `${s.trucks} cam.` }))} />
        </Section>
        <Section title="Tiempo perdido por evento">
          <HBars rows={k.downtime_by_cause.map((d) => ({ key: d.cause, label: <span className="inline-flex items-center gap-2"><Dot color={d.color} />{d.cause}</span>, value: Number(d.minutes), text: hours(d.minutes), extra: `${fmt1(d.pct)} %`, color: d.color }))} empty="Sin tiempos perdidos registrados." />
        </Section>
      </div>
      {multiDay && (
        <Section title="Toneladas por día">
          <DataTable columns={[{ key: 'd', header: 'Fecha', cell: (r: { date: string; tons: number; trucks: number }) => date(r.date) }, { key: 't', header: 'Camiones', align: 'right', cell: (r) => fmt0(r.trucks) }, { key: 'n', header: 'Toneladas', align: 'right', cell: (r) => fmt2(r.tons) }]} rows={k.daily} rowKey={(r) => r.date} />
        </Section>
      )}
    </div>
  );
}
