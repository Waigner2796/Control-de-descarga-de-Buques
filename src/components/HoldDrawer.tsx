import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase, unwrap } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { fmt0, fmt1, fmt2, pct, time } from '@/lib/format';
import type { CargoLine, HoldRow } from '@/lib/service-data';
import { Button, Dot, Drawer, Meter } from '@/components/ui';

export function HoldDrawer({ serviceId, hold, cargo, tz, open, onClose, canWeigh }: {
  serviceId: string; hold: HoldRow | null; cargo: CargoLine[]; tz: string; open: boolean; onClose: () => void; canWeigh?: boolean;
}) {
  const { can } = useAuth();
  const lines = hold ? cargo.filter((c) => c.service_hold_id === hold.id) : [];
  const T = lines.reduce((a, c) => a + Number(c.initial_tm), 0);
  const D = lines.reduce((a, c) => a + Number(c.discharged_tm), 0);
  const recent = useQuery({
    queryKey: ['hold-recent', hold?.id], enabled: open && !!hold && (can('weighing.view_all') || can('weighing.register')),
    queryFn: async () => unwrap(await supabase.from('operational_cycles').select('id, ticket_number, truck_plate, scale_name, product_name, net_tm, weighed_at').eq('service_hold_id', hold!.id).eq('status', 'valid').order('weighed_at', { ascending: false }).limit(6)) as { id: string; ticket_number: string; truck_plate: string; scale_name: string; product_name: string; net_tm: number; weighed_at: string }[],
  });
  return (
    <Drawer open={open && !!hold} onClose={onClose} title={hold ? `Bodega ${hold.hold_number}` : ''}
      footer={canWeigh && T - D > 0 ? <Link to={`/app/pesaje?servicio=${serviceId}&bodega=${hold?.id}`}><Button variant="primary">Registrar pesaje en esta bodega</Button></Link> : undefined}>
      {hold && (
        <div className="grid gap-5">
          <div>
            <div className="text-[13px] text-mute">{hold.vessel?.name}</div>
            <div className="num text-[34px] font-bold leading-tight text-red">{fmt1(T - D)} TM</div>
            <div className="text-[14px] text-mute">pendientes de {fmt0(T)} TM · {pct(T ? (D / T) * 100 : 0)} descargado{hold.capacity_tm ? ` · capacidad ${fmt0(hold.capacity_tm)} TM` : ''}</div>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-line">
              {lines.map((c) => <i key={c.id} style={{ width: `${T ? ((Number(c.initial_tm) - Number(c.discharged_tm)) / T) * 100 : 0}%`, background: c.product.color }} className="transition-[width] duration-700 ease-out" />)}
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-[14px]">
              <thead className="bg-panel text-[12.5px] text-mute"><tr><th className="px-3 py-2 text-left">Producto</th><th className="px-3 py-2 text-right">Inicial</th><th className="px-3 py-2 text-right">Descargado</th><th className="px-3 py-2 text-right">Pendiente</th></tr></thead>
              <tbody>
                {lines.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="px-3 py-2"><span className="inline-flex items-center gap-2"><Dot color={c.product.color} />{c.product.name}</span><Meter className="mt-1.5" value={Number(c.initial_tm) ? (Number(c.discharged_tm) / Number(c.initial_tm)) * 100 : 0} /></td>
                    <td className="num px-3 py-2 text-right">{fmt0(c.initial_tm)}</td>
                    <td className="num px-3 py-2 text-right">{fmt1(c.discharged_tm)}</td>
                    <td className="num px-3 py-2 text-right font-semibold">{fmt1(Number(c.initial_tm) - Number(c.discharged_tm))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {recent.data && (
            <div>
              <h3 className="mb-2 text-[16px] font-semibold">Últimos camiones</h3>
              {recent.data.length ? (
                <ol className="grid gap-1.5">
                  {recent.data.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 rounded-lg bg-panel/60 px-3 py-2 text-[14px]">
                      <span className="num text-mute">{time(r.weighed_at, tz)}</span>
                      <span className="min-w-0 flex-1 truncate"><b>{r.truck_plate}</b> · {r.scale_name}<span className="block text-[12.5px] text-mute">{r.product_name} · ticket {r.ticket_number}</span></span>
                      <span className="num font-semibold">{fmt2(r.net_tm)} TM</span>
                    </li>
                  ))}
                </ol>
              ) : <p className="text-[14px] text-mute">Sin pesajes todavía en esta bodega.</p>}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
