import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import clsx from 'clsx';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { rpc, supabase, unwrap } from '@/lib/supabase';
import { useRealtime } from '@/lib/hooks';
import { ago } from '@/lib/format';

type Note = { id: string; kind: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string };

export function NotificationsButton({ light, portal }: { light?: boolean; portal?: boolean }) {
  const { session } = useAuth();
  const uid = session?.user.id;
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications', uid], enabled: !!uid,
    queryFn: async () => unwrap(await supabase.from('notifications').select('id, kind, title, body, link, read_at, created_at').order('created_at', { ascending: false }).limit(20)) as Note[],
  });
  useRealtime('notifications', uid ? `recipient_user_id=eq.${uid}` : null, [['notifications', uid]], !!uid);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const unread = (q.data ?? []).filter((n) => !n.read_at).length;
  const markAll = async () => { await rpc('mark_notifications_read', { p_ids: null }); qc.invalidateQueries({ queryKey: ['notifications', uid] }); };
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-label={`Notificaciones${unread ? `, ${unread} sin leer` : ''}`} aria-expanded={open}
        className={clsx('press relative rounded-lg p-2', light ? 'text-white hover:bg-white/10' : 'text-ink hover:bg-panel')}>
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className={clsx('absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full px-1 text-center text-[11px] font-bold text-white', portal ? 'bg-portal' : 'bg-red')}>{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-11 z-50 w-[min(360px,calc(100vw-32px))] origin-top-right animate-pop-in rounded-xl border border-line bg-bg text-ink shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <b className="font-cond text-[16px]">Notificaciones</b>
            {unread > 0 && <button onClick={markAll} className="text-[13px] font-semibold text-sea hover:underline">Marcar todo como leído</button>}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {(q.data ?? []).length === 0 && <li className="px-4 py-6 text-center text-[14px] text-mute">Sin notificaciones por ahora.</li>}
            {(q.data ?? []).map((n) => (
              <li key={n.id} className={clsx('border-b border-line last:border-0', !n.read_at && 'bg-seasoft/50')}>
                <Link to={n.link ?? '#'} onClick={() => setOpen(false)} className="block px-4 py-2.5 hover:bg-panel">
                  <b className="block text-[14px]">{n.title}</b>
                  {n.body && <span className="block text-[13px] text-mute">{n.body}</span>}
                  <span className="text-[12px] text-mute">{ago(n.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
