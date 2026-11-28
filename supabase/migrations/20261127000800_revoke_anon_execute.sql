-- =============================================================================
-- VESSEL CONTROL · Migración 008 · Defensa en profundidad para las RPC
-- En Supabase alojado, los privilegios por defecto otorgan EXECUTE a anon/PUBLIC
-- sobre funciones nuevas del esquema public. Todas las RPC ya validan identidad y
-- permisos, pero sin sesión no deben poder invocarse: solo verify_report es pública.
-- authenticated conserva los GRANT explícitos de cada función.
-- =============================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;

grant execute on function public.verify_report(text) to anon, authenticated;
