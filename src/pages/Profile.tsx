import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { friendly, rpc, supabase, unwrap } from '@/lib/supabase';
import { Button, DL, ErrorBox, Field, Input, PageHeader, Section, useToast } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';

export default function Profile({ portal }: { portal?: boolean }) {
  const { ctx, membership, customerLink, refresh, signOut } = useAuth();
  const toast = useToast();
  const [v, setV] = useState({ full_name: '', phone: '' });
  const [p, setP] = useState({ a: '', b: '' });
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (ctx?.profile) setV({ full_name: ctx.profile.full_name ?? '', phone: ctx.profile.phone ?? '' }); }, [ctx?.profile]);
  const save = async () => { try { unwrap(await supabase.from('user_profiles').update(v).eq('user_id', ctx!.user_id)); await refresh(); toast('Perfil actualizado'); } catch (e) { toast((e as Error).message, 'bad'); } };
  const changePwd = async () => {
    setErr(null);
    if (p.a.length < 10 || !/[a-z]/.test(p.a) || !/[A-Z]/.test(p.a) || !/\d/.test(p.a)) return setErr('Use al menos 10 caracteres con mayúsculas, minúsculas y números.');
    if (p.a !== p.b) return setErr('Las contraseñas no coinciden.');
    const { error } = await supabase.auth.updateUser({ password: p.a });
    if (error) return setErr(friendly(error));
    await rpc('confirm_password_changed').catch(() => undefined);
    setP({ a: '', b: '' }); toast('Contraseña actualizada');
  };
  return (
    <div className="max-w-3xl">
      <PageHeader title="Mi perfil" sub={ctx?.profile?.email} />
      <div className="grid gap-5">
        <Section title="Datos personales">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nombre completo"><Input value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} /></Field>
            <Field label="Teléfono"><Input value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} /></Field>
          </div>
          <div className="mt-4"><DL items={portal ? [['Cliente', customerLink?.customer_name], ['Empresa prestadora', customerLink?.organization_name]] : [['Empresa', membership?.organization_name], ['Rol', membership?.role_name]]} /></div>
          <Button className="mt-4" variant={portal ? 'portal' : 'primary'} onClick={save}>Guardar</Button>
        </Section>
        <Section title="Cambiar contraseña">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nueva contraseña"><Input type="password" autoComplete="new-password" value={p.a} onChange={(e) => setP({ ...p, a: e.target.value })} /></Field>
            <Field label="Confirmar"><Input type="password" autoComplete="new-password" value={p.b} onChange={(e) => setP({ ...p, b: e.target.value })} /></Field>
          </div>
          {err && <div className="mt-3"><ErrorBox error={err} /></div>}
          <Button className="mt-4" onClick={changePwd}>Actualizar contraseña</Button>
        </Section>
        <Section title="Preferencias"><div className="flex items-center justify-between gap-3"><span className="text-[14px]">Tema de la interfaz</span><ThemeToggle /></div></Section>
        <div><Button variant="ghost" onClick={signOut}>Cerrar sesión</Button></div>
      </div>
    </div>
  );
}
