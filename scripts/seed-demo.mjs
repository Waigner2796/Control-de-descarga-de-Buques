// Datos de DEMOSTRACIÓN para el entorno LOCAL (supabase start). No usar en producción.
// Uso: node scripts/seed-demo.mjs   (requiere `npx supabase start` y `npx supabase functions serve`)
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { seedDemo } from './demo-data.mjs';

const out = execFileSync('npx', ['supabase', 'status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const st = JSON.parse(out.slice(out.indexOf('{')));
if (!/127\.0\.0\.1|localhost/.test(st.API_URL)) { console.error('Solo para entorno local.'); process.exit(1); }
const PASSWORD = 'VesselDemo2026';
await seedDemo({ createClient, url: st.API_URL, anonKey: st.ANON_KEY, serviceKey: st.SERVICE_ROLE_KEY, password: PASSWORD, domain: 'vessel.local' });
console.log(`\nContraseña de todos los usuarios de demostración: ${PASSWORD}`);
console.log('admin@ (plataforma) · master@ · operaciones@ · supervisor@ · bascula1@ · bascula2@ (hora del servidor) · analista@ · firmante@ · cliente.fertisur@ · cliente.molinos@  (dominio vessel.local)');
