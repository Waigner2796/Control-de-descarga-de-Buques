// Ejecución LOCAL de Edge Functions en entornos donde el contenedor de Docker no puede
// descargar paquetes npm (p. ej. sandboxes con inspección TLS).
//   node scripts/vendor-edge-deps.mjs on   → empaqueta deps desde node_modules y apunta deno.json a ellas
//   node scripts/vendor-edge-deps.mjs off  → restaura los deno.json de producción (npm:)
// Nunca despliegue con el modo "on" activo.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FUNCTIONS = readdirSync('supabase/functions', { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.')).map((d) => d.name);
const PROD = { imports: { 'pdf-lib': 'npm:pdf-lib@1.17.1', '@supabase/supabase-js': 'npm:@supabase/supabase-js@2.47.10' } };
const LOCAL = { imports: { 'pdf-lib': '../.local/vendor/pdf-lib.js', '@supabase/supabase-js': '../.local/vendor/supabase-js.js' } };
const mode = process.argv[2];

if (mode === 'on') {
  const out = resolve('supabase/functions/.local/vendor');
  mkdirSync(out, { recursive: true });
  copyFileSync(resolve('node_modules/pdf-lib/dist/pdf-lib.esm.js'), `${out}/pdf-lib.js`);
  await build({
    stdin: { contents: "export * from '@supabase/supabase-js';", resolveDir: process.cwd() },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: `${out}/supabase-js.js`, logLevel: 'warning',
  });
}
if (mode !== 'on' && mode !== 'off') { console.error('Uso: node scripts/vendor-edge-deps.mjs on|off'); process.exit(1); }
for (const f of FUNCTIONS) {
  const p = resolve('supabase/functions', f, 'deno.json');
  if (existsSync(resolve('supabase/functions', f, 'index.ts'))) writeFileSync(p, JSON.stringify(mode === 'on' ? LOCAL : PROD, null, 2) + '\n');
}
console.log(mode === 'on' ? 'Edge Functions apuntan a dependencias locales (no desplegar así).' : 'deno.json de producción restaurados.');
