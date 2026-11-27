// Utilidades HTTP y clientes de Supabase para Edge Functions (Deno).
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map((s) => s.trim());

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });
}

/** Cliente con privilegios de servicio. NUNCA se expone al navegador. */
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cliente que actúa como el usuario que llama (RLS y auth.uid() del usuario). */
export function userClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

export function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}

export function isServiceRole(req: Request): boolean {
  const t = bearer(req);
  return !!t && t === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
}

/** Valida el JWT contra Auth (no confía en claims sin verificar) y devuelve el usuario. */
export async function requireUser(req: Request): Promise<User> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'No autenticado');
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'Sesión inválida o expirada');
  return data.user;
}

export async function requirePermission(req: Request, orgId: string, perm: string) {
  const { data, error } = await userClient(req).rpc('has_permission', { p_org: orgId, p_perm: perm });
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(403, `Permiso insuficiente (${perm})`);
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
    if (req.method !== 'POST') return json(req, { error: 'Método no permitido' }, 405);
    try {
      return await fn(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) console.error(e);
      return json(req, { error: message }, status);
    }
  };
}

export async function download(bucket: string, path?: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  const { data, error } = await serviceClient().storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}
