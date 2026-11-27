export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'vc.theme';

export function getTheme(): ThemePref {
  try { return (localStorage.getItem(KEY) as ThemePref) || 'system'; } catch { return 'system'; }
}
export function applyTheme(pref: ThemePref = getTheme()) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', pref);
}
export function setTheme(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* sin almacenamiento */ }
  applyTheme(pref);
}
