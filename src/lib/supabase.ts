import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = !!url && !!key;

/** Cliente del navegador: solo clave pública. La autorización real la aplican RLS y las RPC. */
export const supabase = createClient(url || 'http://127.0.0.1:54321', key || 'missing-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

type PgErr = { message?: string; code?: string; details?: string | null; hint?: string | null } | null;

/** Traduce errores de PostgREST/Postgres a mensajes legibles en español. */
export function friendly(e: PgErr | Error | unknown): string {
  const err = e as PgErr & { name?: string };
  const msg = err?.message ?? String(e ?? '');
  if (err?.code === '42501' && /permission denied|row-level security/i.test(msg)) return 'No tiene permiso para realizar esta acción.';
  if (err?.code === '23505' && /duplicate key/i.test(msg)) return 'Ya existe un registro con esos datos.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Sin conexión con el servidor. Verifique su red e intente de nuevo.';
  if (/JWT expired/i.test(msg)) return 'Su sesión expiró. Vuelva a iniciar sesión.';
  return msg || 'Ocurrió un error inesperado.';
}

export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ApiError(friendly(error), error.code);
  return data as T;
}

export function unwrap<T>(r: { data: T | null; error: PgErr }): T {
  if (r.error) throw new ApiError(friendly(r.error), r.error.code);
  return r.data as T;
}

/** Invoca una Edge Function con la sesión del usuario. */
export async function callFunction<T = Record<string, unknown>>(name: string, body: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body: body as Record<string, unknown> });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') message = (await ctx.json()).error ?? message;
    } catch { /* cuerpo no JSON */ }
    throw new ApiError(message);
  }
  return data as T;
}

/** URL firmada de corta duración tras validar permisos en Storage (RLS). */
export async function signedUrl(bucket: string, path: string, seconds = 120, download?: string) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, seconds, download ? { download } : undefined);
  if (error) throw new ApiError('No tiene acceso a este archivo o ya no está disponible.');
  return data.signedUrl;
}

export const uuid = () => crypto.randomUUID();
