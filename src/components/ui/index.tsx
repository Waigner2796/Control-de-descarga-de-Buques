import { cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactElement, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Info, Loader2, Search, X } from 'lucide-react';
import type { Tone } from '@/lib/labels';

/* ----------------------------------------------------------------------------- Botones */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'portal'; size?: 'sm' | 'md' | 'lg'; loading?: boolean; icon?: ReactNode };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button ref={ref} type={rest.type ?? 'button'} disabled={disabled || loading} {...rest}
      className={clsx('press inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap select-none disabled:opacity-55 disabled:cursor-not-allowed',
        size === 'sm' && 'min-h-[34px] px-3 text-[13px]', size === 'md' && 'min-h-[40px] px-4 text-[14px]', size === 'lg' && 'min-h-[48px] px-5 text-[15px]',
        variant === 'primary' && 'bg-sea text-white hover:bg-sea/90 dark:text-bg',
        variant === 'portal' && 'bg-portal text-white hover:bg-portal/90 dark:text-bg',
        variant === 'secondary' && 'border border-edge bg-bg text-ink hover:border-mute/60 hover:bg-panel',
        variant === 'ghost' && 'text-ink hover:bg-panel',
        variant === 'danger' && 'bg-red text-white hover:bg-red/90 dark:text-bg', className)}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* ----------------------------------------------------------------------------- Campos */
export function Field({ label, hint, error, children, className, htmlFor, required }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string; required?: boolean }) {
  const autoId = useId();
  const el = isValidElement(children) ? (children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>) : null;
  const id = htmlFor ?? el?.props.id ?? autoId;
  const descId = `${id}-desc`;
  const control = el && ['input', 'select', 'textarea'].includes(typeof el.type === 'string' ? el.type : '') || (el && typeof el.type !== 'string')
    ? cloneElement(el, { id, 'aria-describedby': hint || error ? descId : undefined, ...(error ? { 'aria-invalid': true } : {}) })
    : children;
  return (
    <div className={clsx('grid content-start gap-1.5', className)}>
      <label htmlFor={id} className="lbl">{label}{required && <span className="text-red"> *</span>}</label>
      {control}
      {error ? <p id={descId} className="text-[13px] text-red" role="alert">{error}</p> : hint ? <p id={descId} className="text-[13px] text-mute">{hint}</p> : null}
    </div>
  );
}
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={clsx('field', className)} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...p }, ref) {
  return <select ref={ref} {...p} className={clsx('field pr-8', className)}>{children}</select>;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} rows={3} {...p} className={clsx('field', className)} />;
});
export function Checkbox({ label, checked, onChange, disabled, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={id} className={clsx('flex min-h-[36px] cursor-pointer items-start gap-2.5 py-1', disabled && 'cursor-not-allowed opacity-60')}>
      <input id={id} type="checkbox" className="mt-[3px] h-4 w-4 accent-[rgb(var(--c-sea))]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-[14px] leading-snug">{label}{hint && <span className="block text-[13px] text-mute">{hint}</span>}</span>
    </label>
  );
}
export function SearchInput({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const t = setTimeout(() => { if (v !== value) onChange(v); }, 300); return () => clearTimeout(t); }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={clsx('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mute" aria-hidden />
      <input type="search" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={placeholder} className="field pl-9" />
    </div>
  );
}

/* ----------------------------------------------------------------------------- Indicadores */
const toneCls: Record<Tone, string> = {
  ok: 'bg-oksoft text-ok', info: 'bg-seasoft text-sea', warn: 'bg-warnsoft text-warn', bad: 'bg-redsoft text-red', mute: 'bg-panel text-mute', portal: 'bg-portalsoft text-portal',
};
export function Badge({ tone = 'mute', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold', toneCls[tone], className)}>{children}</span>;
}
export function StatusBadge({ map, value }: { map: Record<string, { label: string; tone: Tone }>; value: string | null | undefined }) {
  const s = value ? map[value] : null;
  return s ? <Badge tone={s.tone}>{s.label}</Badge> : <Badge>{value ?? '—'}</Badge>;
}
export function Dot({ color, className }: { color: string; className?: string }) {
  return <i aria-hidden className={clsx('inline-block h-2.5 w-2.5 flex-none rounded-full', className)} style={{ background: color }} />;
}
export function Meter({ value, tone = 'sea', className, label }: { value: number; tone?: 'sea' | 'red' | 'ok' | 'portal'; className?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label} className={clsx('h-1.5 overflow-hidden rounded-full bg-line', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-700 ease-out', tone === 'sea' && 'bg-sea', tone === 'red' && 'bg-red', tone === 'ok' && 'bg-ok', tone === 'portal' && 'bg-portal')} style={{ width: `${v}%` }} />
    </div>
  );
}
export function Kpi({ label, value, sub, tone, loading }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'red' | 'ok' | 'portal'; loading?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-bg px-4 py-3">
      <div className="truncate text-[13px] text-mute">{label}</div>
      {loading ? <div className="skeleton mt-1.5 h-7 w-24" /> : (
        <div className={clsx('num mt-0.5 truncate text-[26px] font-bold leading-tight', tone === 'red' && 'text-red', tone === 'ok' && 'text-ok', tone === 'portal' && 'text-portal')}>{value}</div>
      )}
      {sub && <div className="mt-0.5 truncate text-[13px] text-mute">{sub}</div>}
    </div>
  );
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} aria-hidden />;
}
export function Spinner({ label = 'Cargando' }: { label?: string }) {
  return <div className="flex items-center gap-2 py-6 text-mute" role="status"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}
export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-edge px-6 py-10 text-center">
      {icon && <div className="text-mute">{icon}</div>}
      <p className="font-cond text-[18px] font-semibold">{title}</p>
      {children && <div className="max-w-[52ch] text-[14px] text-mute">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red/30 bg-redsoft px-4 py-3 text-[14px] text-red" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
      <div className="flex-1">{error instanceof Error ? error.message : String(error)}</div>
      {onRetry && <button className="font-semibold underline" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}
export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode; className?: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={clsx('flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-[14px]', tone === 'info' && 'bg-seasoft text-ink', tone === 'warn' && 'bg-warnsoft text-ink', tone === 'ok' && 'bg-oksoft text-ink', className)}>
      <Icon className={clsx('mt-0.5 h-4 w-4 flex-none', tone === 'info' && 'text-sea', tone === 'warn' && 'text-warn', tone === 'ok' && 'text-ok')} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- Estructura */
export function PageHeader({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[30px] font-bold leading-tight md:text-[34px]">{title}</h1>
        {sub && <div className="mt-1 text-[15px] text-mute">{sub}</div>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function Section({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('card min-w-0 p-4 md:p-5', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-[19px] font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
export function Tabs({ tabs, value, onChange, className }: { tabs: { id: string; label: ReactNode; count?: number }[]; value: string; onChange: (id: string) => void; className?: string }) {
  return (
    <div role="tablist" className={clsx('-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-line px-1', className)}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={clsx('press relative -mb-px flex min-h-[42px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[14px] font-semibold',
            value === t.id ? 'border-sea text-ink' : 'border-transparent text-mute hover:text-ink')}>
          {t.label}{t.count != null && <span className="rounded-full bg-panel px-1.5 text-[12px] text-mute">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function DL({ items, cols = 2 }: { items: [ReactNode, ReactNode][]; cols?: 2 | 3 | 4 }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3', cols === 2 && 'sm:grid-cols-2', cols === 3 && 'sm:grid-cols-3', cols === 4 && 'sm:grid-cols-2 lg:grid-cols-4')}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0"><dt className="text-[13px] text-mute">{k}</dt><dd className="mt-0.5 break-words font-medium">{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

/* ----------------------------------------------------------------------------- Diálogos */
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current; if (!d) return;
    if (open && !d.open) d.showModal(); else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={clsx('m-auto max-h-[90dvh] w-[calc(100%-32px)] overflow-hidden rounded-xl border border-line bg-bg p-0 text-ink shadow-pop backdrop:bg-[rgb(15_29_43/0.45)] open:animate-pop-in', wide ? 'max-w-3xl' : 'max-w-lg')}>
      {open && (
        <div className="flex max-h-[90dvh] flex-col">
          <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
            <h2 className="text-[20px] font-semibold">{title}</h2>
            <button onClick={onClose} className="press rounded-lg p-1.5 text-mute hover:bg-panel hover:text-ink" aria-label="Cerrar"><X className="h-5 w-5" /></button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-panel/50 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-[rgb(15_29_43/0.4)] animate-[fade-up_200ms_ease-out_both]" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="absolute inset-y-0 right-0 flex w-full max-w-[480px] flex-col border-l border-line bg-bg shadow-pop animate-slide-in">
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 truncate text-[20px] font-semibold">{title}</h2>
          <button onClick={onClose} className="press rounded-lg p-1.5 text-mute hover:bg-panel hover:text-ink" aria-label="Cerrar"><X className="h-5 w-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </aside>
    </div>, document.body);
}

/** Diálogo de confirmación con motivo obligatorio (queda en la auditoría). */
export function ReasonDialog({ open, onClose, title, description, confirmLabel = 'Confirmar', danger, minLength = 8, onConfirm, extra }: {
  open: boolean; onClose: () => void; title: string; description?: ReactNode; confirmLabel?: string; danger?: boolean; minLength?: number;
  onConfirm: (reason: string) => Promise<unknown>; extra?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setReason(''); setErr(null); } }, [open]);
  const submit = async () => {
    if (reason.trim().length < minLength) { setErr(`Escriba el motivo (mínimo ${minLength} caracteres).`); return; }
    setBusy(true); setErr(null);
    try { await onConfirm(reason.trim()); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onClose={onClose} title={title}
      footer={<><Button onClick={onClose}>Cancelar</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={submit}>{confirmLabel}</Button></>}>
      <div className="grid gap-4">
        {description && <div className="text-[14px]">{description}</div>}
        {extra}
        <Field label="Motivo" hint="Queda registrado en la bitácora de auditoría." error={err}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Describa el motivo del cambio" />
        </Field>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------------------------- Toasts */
type ToastItem = { id: number; text: string; tone: 'ok' | 'bad' | 'info' };
const ToastCtx = createContext<(text: string, tone?: ToastItem['tone']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: ToastItem['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] grid w-[min(420px,calc(100%-32px))] gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-bg px-4 py-3 text-[14px] shadow-pop animate-fade-up',
            t.tone === 'ok' && 'border-ok/40', t.tone === 'bad' && 'border-red/40', t.tone === 'info' && 'border-sea/40')}>
            {t.tone === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 flex-none text-ok" /> : t.tone === 'bad' ? <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-red" /> : <Info className="mt-0.5 h-4 w-4 flex-none text-sea" />}
            <span className="flex-1">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/* ----------------------------------------------------------------------------- Tabla */
export type Column<T> = {
  key: string; header: ReactNode; cell: (row: T) => ReactNode; align?: 'left' | 'right' | 'center';
  sortKey?: string; className?: string; hideBelow?: 'sm' | 'md' | 'lg'; wrap?: boolean;
};
export function DataTable<T>({ columns, rows, rowKey, loading, sort, onSort, onRowClick, empty, rowClassName }: {
  columns: Column<T>[]; rows: T[] | undefined; rowKey: (r: T) => string; loading?: boolean;
  sort?: { key: string; asc: boolean }; onSort?: (key: string) => void; onRowClick?: (r: T) => void; empty?: ReactNode; rowClassName?: (r: T) => string | undefined;
}) {
  const hide = (c: Column<T>) => clsx(c.hideBelow === 'sm' && 'hidden sm:table-cell', c.hideBelow === 'md' && 'hidden md:table-cell', c.hideBelow === 'lg' && 'hidden lg:table-cell');
  return (
    <div className="relative overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-[14px]">
        <thead className="bg-panel">
          <tr>
            {columns.map((c) => {
              const active = sort && c.sortKey && sort.key === c.sortKey;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort!.asc ? 'ascending' : 'descending') : undefined}
                  className={clsx('whitespace-nowrap border-b border-line px-3 py-2.5 text-[12.5px] font-semibold text-mute', c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left', hide(c))}>
                  {c.sortKey && onSort ? (
                    <button onClick={() => onSort(c.sortKey!)} className={clsx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}>
                      {c.header}{active ? (sort!.asc ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />) : <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && !rows?.length ? Array.from({ length: 6 }).map((_, i) => (
            <tr key={i}>{columns.map((c) => <td key={c.key} className={clsx('border-b border-line px-3 py-3', hide(c))}><div className="skeleton h-4 w-full max-w-[140px]" /></td>)}</tr>
          )) : rows?.length ? rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={clsx('transition-colors duration-150', onRowClick && 'cursor-pointer hover:bg-panel/70', loading && 'opacity-60', rowClassName?.(r))}>
              {columns.map((c) => (
                <td key={c.key} className={clsx('border-b border-line px-3 py-2.5 align-middle', c.wrap ? 'min-w-[200px] max-w-[420px]' : 'whitespace-nowrap', c.align === 'right' ? 'text-right num' : c.align === 'center' ? 'text-center' : 'text-left', hide(c), c.className)}>{c.cell(r)}</td>
              ))}
            </tr>
          )) : (
            <tr><td colSpan={columns.length} className="px-3 py-8">{empty ?? <p className="text-center text-mute">Sin registros con los filtros actuales.</p>}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize, sizes = [25, 50, 100] }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (s: number) => void; sizes?: number[];
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  const nf = new Intl.NumberFormat('es-GT');
  const btn = 'press inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-bg hover:bg-panel disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[14px]">
      <div className="text-mute num">Página {nf.format(page)} de {nf.format(pages)} <span className="mx-1.5 text-edge">|</span> Registros {nf.format(from)}–{nf.format(to)} de {nf.format(total)}</div>
      <div className="flex items-center gap-1.5">
        {onPageSize && (
          <label className="mr-2 flex items-center gap-2 text-mute">Por página
            <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="field min-h-[36px] w-auto py-1">
              {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )}
        <button className={btn} onClick={() => onPage(1)} disabled={page <= 1} aria-label="Primera página"><ChevronsLeft className="h-4 w-4" /></button>
        <button className={btn} onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Página anterior"><ChevronLeft className="h-4 w-4" /></button>
        <button className={btn} onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Página siguiente"><ChevronRight className="h-4 w-4" /></button>
        <button className={btn} onClick={() => onPage(pages)} disabled={page >= pages} aria-label="Última página"><ChevronsRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-3 grid grid-cols-1 items-end gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">{children}</div>;
}
