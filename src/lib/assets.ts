import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';

/** URL firmada (1 h) de un recurso privado; se renueva antes de expirar. */
export function useAssetUrl(bucket: string, path: string | null | undefined) {
  const q = useQuery({
    queryKey: ['asset', bucket, path], enabled: !!path, staleTime: 50 * 60_000, gcTime: 55 * 60_000, retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path!, 3600);
      if (error) return null;
      return data.signedUrl;
    },
  });
  return q.data ?? null;
}

/** Sube una imagen PNG/JPG validando tipo y tamaño en el navegador (Storage vuelve a validar). */
export async function uploadImage(bucket: string, folder: string, file: File) {
  if (!['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Use una imagen PNG o JPG.');
  if (file.size > 5 * 1024 * 1024) throw new Error('La imagen supera 5 MB.');
  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const path = `${folder}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new Error(error.message.includes('row-level') ? 'No tiene permiso para subir este archivo.' : error.message);
  return path;
}
