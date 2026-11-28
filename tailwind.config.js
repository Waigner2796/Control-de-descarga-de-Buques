/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(--c-${v}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: c('bg'), ink: c('ink'), mute: c('mute'), line: c('line'), panel: c('panel'), field: c('field'), edge: c('edge'),
        harbor: c('harbor'), sea: c('sea'), seasoft: c('seasoft'), red: c('red'), redsoft: c('redsoft'),
        ok: c('ok'), oksoft: c('oksoft'), warn: c('warn'), warnsoft: c('warnsoft'), portal: c('portal'), portalsoft: c('portalsoft'),
      },
      fontFamily: {
        sans: ['Barlow', 'system-ui', 'sans-serif'],
        cond: ['"Barlow Semi Condensed"', 'Barlow', 'system-ui', 'sans-serif'],
      },
      fontSize: { '2xs': ['0.75rem', '1rem'] },
      borderRadius: { lg: '10px', xl: '12px' },
      boxShadow: {
        pop: '0 12px 32px -8px rgb(15 29 43 / 0.22), 0 2px 6px rgb(15 29 43 / 0.08)',
        card: '0 1px 2px rgb(15 29 43 / 0.06)',
      },
      transitionTimingFunction: { out: 'cubic-bezier(0.23, 1, 0.32, 1)', drawer: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'none' } },
        'pop-in': { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'none' } },
        'slide-in': { from: { transform: 'translateX(100%)' }, to: { transform: 'none' } },
        'slide-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'none' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        pulse2: { '0%': { boxShadow: '0 0 0 0 rgb(94 227 154 / .6)' }, '70%': { boxShadow: '0 0 0 9px rgb(94 227 154 / 0)' }, '100%': { boxShadow: '0 0 0 0 rgb(94 227 154 / 0)' } },
        flash: { from: { backgroundColor: 'rgb(var(--c-seasoft))' }, to: { backgroundColor: 'transparent' } },
      },
      animation: {
        'fade-up': 'fade-up 220ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'pop-in': 'pop-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'slide-in': 'slide-in 320ms cubic-bezier(0.32, 0.72, 0, 1) both',
        'slide-left': 'slide-left 280ms cubic-bezier(0.32, 0.72, 0, 1) both',
        live: 'pulse2 2s infinite',
        flash: 'flash 1.6s cubic-bezier(0.23, 1, 0.32, 1) both',
      },
    },
  },
  plugins: [],
};
