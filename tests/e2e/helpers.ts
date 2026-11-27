import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

type Env = { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string };

let cached: Env | null = null;
export function localEnv(): Env {
  if (cached) return cached;
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    cached = { API_URL: process.env.SUPABASE_URL, ANON_KEY: process.env.SUPABASE_ANON_KEY, SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
    return cached;
  }
  const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out.slice(out.indexOf('{')));
  cached = { API_URL: j.API_URL, ANON_KEY: j.ANON_KEY, SERVICE_ROLE_KEY: j.SERVICE_ROLE_KEY };
  return cached;
}

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const admin = () => createClient(localEnv().API_URL, localEnv().SERVICE_ROLE_KEY, opts);
export const anon = () => createClient(localEnv().API_URL, localEnv().ANON_KEY, opts);

export const PASSWORD = 'Prueba-Segura-2026';
export const uniq = () => randomUUID().slice(0, 8);

/** Crea un usuario confirmado con perfil activo y devuelve su id. */
export async function createUser(email: string, fullName: string, kind: 'staff' | 'customer' = 'staff', mustChange = false) {
  const a = admin();
  const { data, error } = await a.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const id = data.user.id;
  const { error: e2 } = await a.from('user_profiles').insert({ user_id: id, full_name: fullName, email, kind, must_change_password: false });
  if (e2) throw e2;
  if (mustChange) {
    const { error: e3 } = await a.rpc('worker_register_temp_password', { p_user: id });
    if (e3) throw e3;
  }
  return id;
}

export async function signIn(email: string, password = PASSWORD): Promise<SupabaseClient> {
  const c = createClient(localEnv().API_URL, localEnv().ANON_KEY, opts);
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  return c;
}

export async function addMember(orgId: string, userId: string, role: string, extra: Partial<{ all_terminals: boolean; extra_permissions: string[] }> = {}) {
  const { error } = await admin().from('organization_members').insert({ organization_id: orgId, user_id: userId, role_code: role, ...extra });
  if (error) throw error;
}

export function ok<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.data;
}

/** Fecha/hora local 'YYYY-MM-DDTHH:MM' en la zona indicada, desplazada en minutos. */
export function localStamp(tz: string, offsetMin = 0, base = Date.now()) {
  const d = new Date(base + offsetMin * 60000);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
