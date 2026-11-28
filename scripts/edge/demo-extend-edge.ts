// Edge Function TEMPORAL: agrega a una demo existente los servicios de ejemplo del modelo por servicio
// (granel con BL y camiones; carga en sacos con boletas, lotes, dañados y peso de sacos).
// Protecciones: token de un solo uso en public._vc_bootstrap (sin acceso para anon/authenticated)
// y la contraseña de los usuarios demo la envía quien la invoca. Tras usarla se reemplaza por una función inerte.
import { createClient } from '@supabase/supabase-js';
import { extendDemo } from '../demo-extend.mjs';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = req.headers.get('x-bootstrap-token') ?? '';
  if (token.length < 32) return json({ error: 'forbidden' }, 403);
  const { data: row } = await admin.from('_vc_bootstrap').select('token').eq('token', token).maybeSingle();
  if (!row) return json({ error: 'forbidden' }, 403);
  await admin.from('_vc_bootstrap').delete().eq('token', token);
  const body = await req.json().catch(() => ({}));
  if (typeof body.password !== 'string' || body.password.length < 12) return json({ error: 'Contraseña inválida' }, 400);
  const logs: string[] = [];
  try {
    const result = await extendDemo({ createClient, url, anonKey, serviceKey, password: body.password, domain: body.domain ?? 'vesselcontrol.example', log: (m: string) => logs.push(m) });
    return json({ result, logs });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), logs }, 500);
  }
});
