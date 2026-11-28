const nf = (min: number, max = min) => new Intl.NumberFormat('es-GT', { minimumFractionDigits: min, maximumFractionDigits: max });
const F0 = nf(0), F1 = nf(1), F2 = nf(2), F3 = nf(3);

const n = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
export const fmt0 = (v: unknown) => (n(v) == null ? '—' : F0.format(n(v)!));
export const fmt1 = (v: unknown) => (n(v) == null ? '—' : F1.format(n(v)!));
export const fmt2 = (v: unknown) => (n(v) == null ? '—' : F2.format(n(v)!));
export const fmt3 = (v: unknown) => (n(v) == null ? '—' : F3.format(n(v)!));
export const tm = (v: unknown, d = 1) => (n(v) == null ? '—' : `${nf(d).format(n(v)!)} TM`);
export const pct = (v: unknown, d = 1) => (n(v) == null ? '—' : `${nf(d).format(n(v)!)} %`);
export const kg = (v: unknown) => (n(v) == null ? '—' : `${F0.format(n(v)!)} kg`);

export function minutes(v: unknown) {
  const m = n(v);
  if (m == null) return '—';
  if (m < 60) return `${F1.format(m)} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${Math.round(m - h * 60)} min`;
}
export const hours = (minutesValue: unknown) => (n(minutesValue) == null ? '—' : `${F2.format(n(minutesValue)! / 60)} h`);

export const DEFAULT_TZ = 'America/Guatemala';

function parts(d: Date, tz: string) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
}

/** Fecha y hora en la zona de la terminal (los datos se guardan en UTC). */
export function dt(v: string | Date | null | undefined, tz = DEFAULT_TZ, withSeconds = false) {
  if (!v) return '—';
  const p = parts(new Date(v), tz);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ''}`;
}
export function date(v: string | Date | null | undefined, tz = DEFAULT_TZ) {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const [y, m, d] = v.split('-'); return `${d}/${m}/${y}`; }
  const p = parts(new Date(v), tz);
  return `${p.day}/${p.month}/${p.year}`;
}
export function time(v: string | Date | null | undefined, tz = DEFAULT_TZ, withSeconds = false) {
  if (!v) return '—';
  const p = parts(new Date(v), tz);
  return `${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ''}`;
}
/** Valor para <input type="datetime-local"> en hora local de la terminal. */
export function localInput(v: string | Date = new Date(), tz = DEFAULT_TZ) {
  const p = parts(new Date(v), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function localDateInput(v: string | Date = new Date(), tz = DEFAULT_TZ) {
  return localInput(v, tz).slice(0, 10);
}
/** Convierte fecha local (YYYY-MM-DD) de la terminal a instante UTC ISO (inicio del día). */
export function localDayStartIso(day: string, tz = DEFAULT_TZ) {
  const guess = new Date(`${day}T00:00:00Z`);
  const p = parts(guess, tz);
  const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (asLocal - guess.getTime())).toISOString();
}
export function addDays(day: string, k: number) {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10);
}
export function ago(v: string | null | undefined) {
  if (!v) return 'sin registros';
  const m = (Date.now() - new Date(v).getTime()) / 60000;
  if (m < 1) return 'hace segundos';
  if (m < 60) return `hace ${Math.round(m)} min`;
  if (m < 60 * 24) return `hace ${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
  return `hace ${Math.floor(m / 1440)} d`;
}
/** Minutos entre dos valores datetime-local (puede cruzar medianoche si las fechas lo indican). */
export function diffMinutes(a: string, b: string) {
  if (!a || !b) return null;
  return (new Date(`${b}:00Z`).getTime() - new Date(`${a}:00Z`).getTime()) / 60000;
}
export const fileSize = (b: unknown) => (n(b) == null ? '—' : n(b)! < 1024 * 1024 ? `${F0.format(n(b)! / 1024)} KB` : `${F1.format(n(b)! / 1048576)} MB`);
export const parseNum = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(/,/g, '')));
export const fmtDpi = (v: string | null | undefined) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 13 ? `${d.slice(0, 4)} ${d.slice(4, 9)} ${d.slice(9)}` : (v ?? '');
};
/** Convierte 'YYYY-MM-DDTHH:MM' en hora local de la terminal a ISO UTC. */
export function localToIso(local: string, tz = DEFAULT_TZ) {
  if (!local) return null;
  const guess = new Date(`${local.length === 16 ? `${local}:00` : local}Z`);
  const p = parts(guess, tz);
  const asLocal = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return new Date(guess.getTime() - (asLocal - guess.getTime())).toISOString();
}
