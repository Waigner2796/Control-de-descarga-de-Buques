import { useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import clsx from 'clsx';
import { getTheme, setTheme, type ThemePref } from '@/lib/theme';

const OPTS: { v: ThemePref; icon: typeof Sun; label: string }[] = [
  { v: 'light', icon: Sun, label: 'Tema claro' }, { v: 'system', icon: Monitor, label: 'Tema del sistema' }, { v: 'dark', icon: Moon, label: 'Tema oscuro' },
];
export function ThemeToggle({ dark }: { dark?: boolean }) {
  const [t, setT] = useState<ThemePref>(getTheme());
  return (
    <div role="radiogroup" aria-label="Tema" className={clsx('inline-flex rounded-lg p-0.5', dark ? 'bg-white/10' : 'bg-panel')}>
      {OPTS.map((o) => (
        <button key={o.v} role="radio" aria-checked={t === o.v} aria-label={o.label} title={o.label}
          onClick={() => { setTheme(o.v); setT(o.v); }}
          className={clsx('press rounded-md p-1.5', t === o.v ? (dark ? 'bg-white/25' : 'bg-bg shadow-card') : 'opacity-70 hover:opacity-100')}>
          <o.icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
