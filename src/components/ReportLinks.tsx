import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { signedUrl } from '@/lib/supabase';
import { Button, useToast } from '@/components/ui';

/** Abre o descarga un PDF privado mediante URL firmada de 2 minutos (Storage valida permisos). */
export function ReportButtons({ path, filename, compact, portal }: { path: string | null | undefined; filename?: string; compact?: boolean; portal?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'view' | 'dl' | null>(null);
  if (!path) return <span className="text-[13px] text-mute">—</span>;
  const go = async (mode: 'view' | 'dl') => {
    setBusy(mode);
    try {
      const url = await signedUrl('reports', path, 120, mode === 'dl' ? filename ?? 'informe.pdf' : undefined);
      if (mode === 'view') window.open(url, '_blank', 'noopener'); else window.location.assign(url);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'bad'); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button size="sm" variant={portal ? 'portal' : 'secondary'} loading={busy === 'view'} icon={<ExternalLink className="h-4 w-4" />} onClick={() => go('view')}>{compact ? 'Ver' : 'Ver PDF'}</Button>
      <Button size="sm" variant="ghost" loading={busy === 'dl'} icon={<Download className="h-4 w-4" />} onClick={() => go('dl')} aria-label="Descargar PDF">{compact ? '' : 'Descargar'}</Button>
    </div>
  );
}

export function TempPasswordNotice({ password, email }: { password: string; email: string }) {
  const toast = useToast();
  return (
    <div className="rounded-xl border border-warn/40 bg-warnsoft p-4">
      <p className="text-[14px]">Entregue estas credenciales por un canal seguro. <b>La contraseña temporal solo se muestra una vez</b> y deberá cambiarse en el primer ingreso.</p>
      <div className="mt-3 grid gap-1 text-[14px]"><span className="text-mute">Usuario</span><code className="num">{email}</code></div>
      <div className="mt-2 flex items-center gap-2">
        <code className="num flex-1 rounded-lg bg-bg px-3 py-2 text-[17px] font-bold tracking-wider">{password}</code>
        <Button size="sm" onClick={() => { navigator.clipboard?.writeText(password); toast('Contraseña copiada'); }}>Copiar</Button>
      </div>
    </div>
  );
}
