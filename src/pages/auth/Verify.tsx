import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileCheck2, XCircle } from 'lucide-react';
import { rpc } from '@/lib/supabase';
import { dt } from '@/lib/format';
import { Badge, Button, DL, Field, Input, Notice } from '@/components/ui';
import { AuthShell } from './AuthPages';

type Result = { found: boolean; status?: string; version?: number; service_number?: string; vessel?: string; customer?: string; organization?: string;
  signed_at?: string; signer_name?: string; signer_position?: string; sha256?: string; superseded_at?: string | null; superseded_by_version?: number | null };

async function sha256(file: File) {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function VerifyPage() {
  const params = useParams();
  const [code, setCode] = useState(params.code ?? '');
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const check = async (c: string) => {
    if (!c.trim()) return;
    setBusy(true); setFileHash(null);
    try { setRes(await rpc<Result>('verify_report', { p_code: c.trim() })); } catch { setRes({ found: false }); }
    setBusy(false);
  };
  useEffect(() => { if (params.code) check(params.code); }, [params.code]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e: FormEvent) => { e.preventDefault(); check(code); };
  const match = fileHash && res?.sha256 ? fileHash === res.sha256 : null;
  return (
    <AuthShell title="Verificar informe" sub="Ingrese el código impreso en el pie de página del PDF.">
      <form onSubmit={submit} className="grid gap-3">
        <Field label="Código de verificación" htmlFor="code"><Input id="code" placeholder="VC-XXXX-XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="num tracking-wide" /></Field>
        <Button type="submit" variant="primary" loading={busy}>Verificar</Button>
      </form>
      {res && !res.found && <Notice tone="warn" className="mt-5">No existe un informe firmado con ese código.</Notice>}
      {res?.found && (
        <div className="mt-6 grid gap-4 animate-fade-up">
          <div className="flex items-center gap-2">
            {res.status === 'signed' ? <Badge tone="ok"><CheckCircle2 className="h-3.5 w-3.5" />Versión vigente</Badge> : <Badge tone="warn">Sustituida por la versión {res.superseded_by_version}</Badge>}
            <span className="text-[14px] text-mute">Versión {res.version}</span>
          </div>
          <DL items={[['Servicio', res.service_number], ['Buque', res.vessel], ['Cliente', res.customer], ['Emitido por', res.organization],
            ['Firmante', `${res.signer_name} · ${res.signer_position}`], ['Fecha de firma', dt(res.signed_at)]]} />
          <div className="rounded-lg bg-panel p-3"><div className="text-[13px] text-mute">Hash SHA-256 registrado</div><code className="num break-all text-[12.5px]">{res.sha256}</code></div>
          <Field label="Comparar con su archivo PDF" hint="El archivo se procesa en su navegador; no se envía a ningún servidor.">
            <input type="file" accept="application/pdf" className="text-[14px]" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setFileHash(await sha256(f)); }} />
          </Field>
          {match === true && <Notice tone="ok"><FileCheck2 className="mr-1 inline h-4 w-4" />El archivo es idéntico al documento firmado registrado.</Notice>}
          {match === false && <Notice tone="warn"><XCircle className="mr-1 inline h-4 w-4" />El archivo NO coincide con el documento registrado: pudo ser modificado o corresponde a otra versión.</Notice>}
          <p className="text-[12.5px] text-mute">El informe lleva firma gráfica y sello de la empresa; su integridad se comprueba con este hash. No es una firma electrónica certificada.</p>
        </div>
      )}
    </AuthShell>
  );
}
