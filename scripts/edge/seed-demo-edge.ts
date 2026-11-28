// Edge Function TEMPORAL para cargar datos de demostración en un proyecto Supabase de PRUEBAS.
// No vive en supabase/functions para que `supabase functions deploy` nunca la publique por error.
// Protecciones:
//  - Token de un solo uso que debe existir en public._vc_bootstrap (tabla sin acceso para anon/authenticated).
//  - Se niega si ya existe alguna empresa (solo funciona en un proyecto vacío).
//  - La contraseña de los usuarios demo la envía quien la invoca; no hay contraseñas fijas.
// Tras usarla, reemplácela por una función inerte y elimine la tabla _vc_bootstrap.
import { createClient } from '@supabase/supabase-js';
import { seedDemo } from '../demo-data.mjs';

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
  const { count } = await admin.from('organizations').select('id', { count: 'exact', head: true });
  if (count) return json({ error: 'El proyecto ya tiene empresas; no se cargan datos de demostración.' }, 409);
  const body = await req.json().catch(() => ({}));
  if (typeof body.password !== 'string' || body.password.length < 12) return json({ error: 'Contraseña inválida' }, 400);
  const logs: string[] = [];
  try {
    const result = await seedDemo({ createClient, url, anonKey, serviceKey, password: body.password, domain: body.domain ?? 'vesselcontrol.example', log: (m: string) => logs.push(m) });
    return json({ result, logs });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e), logs }, 500);
  }
});
