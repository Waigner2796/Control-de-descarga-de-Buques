import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { friendly, rpc, supabase } from '@/lib/supabase';
import { Button, ErrorBox, Field, Input, Notice } from '@/components/ui';

export function AuthShell({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
      <div className="relative hidden overflow-hidden bg-harbor text-white lg:block">
        <svg className="absolute inset-x-0 bottom-0 h-[58%] w-full" viewBox="0 0 800 420" preserveAspectRatio="xMidYMax slice" aria-hidden>
          <path d="M0 250 Q 50 242 100 250 T 200 250 T 300 250 T 400 250 T 500 250 T 600 250 T 700 250 T 800 250 V420 H0Z" fill="#0a3a57" />
          <path d="M70 150 h560 v70 q0 30 -30 30 H120 q-50 0 -50 -100Z" fill="#1b2b3a" />
          <rect x="70" y="200" width="560" height="50" fill="#a8372a" opacity=".9" />
          {[0, 1, 2, 3, 4].map((i) => <g key={i}><rect x={130 + i * 86} y="108" width="74" height="70" fill="#152230" /><rect x={130 + i * 86} y={108 + (i % 3) * 14} width="74" height={70 - (i % 3) * 14} fill={['#4c9a4f', '#b4c5d4', '#f0b400', '#b9834a', '#3a3f45'][i]} /></g>)}
          <rect x="560" y="70" width="60" height="80" fill="#f2f5f7" />
        </svg>
        <div className="relative max-w-[520px] p-12">
          <b className="font-cond text-[22px]">Vessel Control</b>
          <p className="mt-10 font-cond text-[40px] font-bold leading-[1.05]">Control de descarga, saldos por bodega y reportes firmados en un solo lugar.</p>
          <p className="mt-4 text-[16px] text-white/80">Plataforma para empresas de descarga de graneles: clientes, servicios, básculas, tiempos perdidos y productividad.</p>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-10">
        <div className="w-full max-w-[380px] animate-fade-up">
          <b className="mb-8 block font-cond text-[20px] text-harbor dark:text-sea lg:hidden">Vessel Control</b>
          <h1 className="text-[30px] font-bold">{title}</h1>
          {sub && <p className="mt-1 text-mute">{sub}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  const { session } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (session) return <Navigate to={loc.state?.from ?? '/'} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setErr(/invalid/i.test(error.message) ? 'Correo o contraseña incorrectos.' : /banned/i.test(error.message) ? 'Su acceso está desactivado. Contacte al administrador.' : friendly(error)); return; }
    nav(loc.state?.from ?? '/', { replace: true });
  };
  return (
    <AuthShell title="Iniciar sesión" sub="Ingrese con las credenciales que le entregó su administrador.">
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Correo electrónico" htmlFor="email"><Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Contraseña" htmlFor="password"><Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        {err && <ErrorBox error={err} />}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Entrar</Button>
        <Link to="/recuperar" className="text-center text-[14px] font-semibold text-sea hover:underline">¿Olvidó su contraseña?</Link>
        <Link to="/verificar" className="text-center text-[13px] text-mute hover:underline">Verificar un informe firmado</Link>
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/restablecer` });
    setBusy(false); setSent(true);
  };
  return (
    <AuthShell title="Recuperar contraseña" sub="Le enviaremos un enlace para crear una nueva contraseña.">
      {sent ? <Notice tone="ok">Si el correo está registrado, recibirá un enlace en unos minutos. Revise también la carpeta de spam.</Notice> : (
        <form onSubmit={submit} className="grid gap-4">
          <Field label="Correo electrónico" htmlFor="email"><Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" variant="primary" size="lg" loading={busy}>Enviar enlace</Button>
        </form>
      )}
      <Link to="/login" className="mt-5 block text-center text-[14px] font-semibold text-sea hover:underline">Volver a iniciar sesión</Link>
    </AuthShell>
  );
}

const pwdRule = (p: string) => p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);

function NewPasswordForm({ onDone }: { onDone: () => void }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!pwdRule(p1)) { setErr('Use al menos 10 caracteres con mayúsculas, minúsculas y números.'); return; }
    if (p1 !== p2) { setErr('Las contraseñas no coinciden.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: p1 });
    if (error) { setBusy(false); setErr(/same|different/i.test(error.message) ? 'La nueva contraseña debe ser distinta de la temporal.' : friendly(error)); return; }
    try { await rpc('confirm_password_changed'); } catch (e2) { setBusy(false); setErr(friendly(e2)); return; }
    setBusy(false); onDone();
  };
  return (
    <form onSubmit={submit} className="grid gap-4">
      <Field label="Nueva contraseña" htmlFor="p1" hint="Mínimo 10 caracteres, con mayúsculas, minúsculas y números."><Input id="p1" type="password" autoComplete="new-password" value={p1} onChange={(e) => setP1(e.target.value)} /></Field>
      <Field label="Confirmar contraseña" htmlFor="p2"><Input id="p2" type="password" autoComplete="new-password" value={p2} onChange={(e) => setP2(e.target.value)} /></Field>
      {err && <ErrorBox error={err} />}
      <Button type="submit" variant="primary" size="lg" loading={busy}>Guardar contraseña</Button>
    </form>
  );
}

export function ChangePassword() {
  const { session, ready, refresh, signOut } = useAuth();
  const nav = useNavigate();
  if (ready && !session) return <Navigate to="/login" replace />;
  return (
    <AuthShell title="Cree su contraseña" sub="Por seguridad debe reemplazar la contraseña temporal antes de continuar.">
      <NewPasswordForm onDone={async () => { await refresh(); nav('/', { replace: true }); }} />
      <button onClick={signOut} className="mt-5 block w-full text-center text-[14px] text-mute hover:underline">Cerrar sesión</button>
    </AuthShell>
  );
}

export function ResetPassword() {
  const { session, ready, setRecovering, refresh } = useAuth();
  const nav = useNavigate();
  if (ready && !session) return (
    <AuthShell title="Enlace inválido o vencido"><p className="text-mute">Solicite un nuevo enlace de recuperación.</p><Link to="/recuperar" className="mt-4 inline-block font-semibold text-sea">Recuperar contraseña</Link></AuthShell>
  );
  return (
    <AuthShell title="Nueva contraseña" sub="Defina la contraseña que usará para ingresar.">
      <NewPasswordForm onDone={async () => { setRecovering(false); await refresh(); nav('/', { replace: true }); }} />
    </AuthShell>
  );
}

export function NoAccess({ inline }: { inline?: boolean }) {
  const { signOut } = useAuth();
  const body = (
    <div className="mx-auto max-w-md py-16 text-center">
      <ShieldCheck className="mx-auto h-10 w-10 text-mute" />
      <h1 className="mt-3 text-[26px] font-bold">Sin acceso a esta sección</h1>
      <p className="mt-2 text-mute">Su usuario no tiene permisos para ver esta información. Si cree que es un error, contacte al administrador de su empresa.</p>
      {!inline && <Button className="mt-5" onClick={signOut}>Cerrar sesión</Button>}
    </div>
  );
  return inline ? body : <div className="flex min-h-full items-center px-4">{body}</div>;
}

export function NotConfigured() {
  return (
    <div className="mx-auto max-w-lg px-5 py-20">
      <h1 className="text-[28px] font-bold">Falta configurar Supabase</h1>
      <p className="mt-2 text-mute">Defina <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> (clave pública) en el entorno de despliegue. Consulte docs/DESPLIEGUE.md.</p>
    </div>
  );
}
