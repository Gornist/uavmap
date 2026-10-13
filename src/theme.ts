// Темы интерфейса «Дневная» / «Ночная» + автоматический выбор.
// Источник правды для цветов — объект THEMES ниже. CSS-переменные в styles/theme.css обязаны совпадать
// с ним (это проверяет theme.test.ts вместе с WCAG-контрастом).
//
// API: initTheme() — применить сохранённый выбор (идемпотентно); setTheme('auto'|'day'|'night');
// getTheme() — выбор пользователя; resolvedTheme() — фактическая тема. Тема ставится как
// <html data-theme="day|night">; при смене на window летит событие 'uavmap:theme' (detail: 'day'|'night').

export type ThemeName = 'day' | 'night';
export type ThemeChoice = 'auto' | ThemeName;
export type Status = 'ok' | 'weak' | 'none';

/** Токены, которые попадают в CSS как --имя. Только непрозрачные #rrggbb (их проверяет тест контраста). */
export interface ThemeTokens {
  bg: string;            // фон страницы / под картой
  panel: string;         // плашки и шторки (непрозрачные)
  'panel-2': string;     // вложенные блоки, вторичные кнопки
  field: string;         // поля ввода
  line: string;          // границы
  'line-strong': string; // границы кнопок/полей, фокус-независимые
  text: string;          // основной текст
  muted: string;         // вторичный текст (подписи)
  accent: string;        // главная кнопка, прицел, линия визирования
  'accent-ink': string;  // текст на акценте
  'accent-text': string; // акцентный текст на панели (заголовки, активные вкладки)
  'accent-soft': string; // фон выбранного элемента (вкладка, сегмент)
  ok: string; weak: string; none: string;                // текст статуса на панели
  'ok-bg': string; 'weak-bg': string; 'none-bg': string; // фон плашки вердикта
  'chart-bg': string;
}

export const THEMES: Record<ThemeName, ThemeTokens> = {
  day: {
    bg: '#e9e5dd',
    panel: '#fbfaf7',
    'panel-2': '#f1ede6',
    field: '#ffffff',
    line: '#d3ccc0',
    'line-strong': '#8c8478',
    text: '#1d1b18',
    muted: '#4d4840',
    accent: '#d9a446',
    'accent-ink': '#1d1b18',
    'accent-text': '#7a4b0c',
    'accent-soft': '#f6e7c9',
    ok: '#1e6b38', weak: '#7f5600', none: '#a8322a',
    'ok-bg': '#e1efe4', 'weak-bg': '#f6ecd3', 'none-bg': '#f8e3df',
    'chart-bg': '#f5f2ec',
  },
  night: {
    bg: '#171614',
    panel: '#23211e',
    'panel-2': '#2c2a26',
    field: '#1b1a17',
    line: '#3d3a35',
    'line-strong': '#6b655c',
    text: '#eee9e0',
    muted: '#b8b0a3',
    accent: '#d6a24c',
    'accent-ink': '#1a1309',
    'accent-text': '#e3b566',
    'accent-soft': '#3a3020',
    ok: '#74d18f', weak: '#e8c160', none: '#f4907f',
    'ok-bg': '#1c3324', 'weak-bg': '#382e15', 'none-bg': '#3d201c',
    'chart-bg': '#1b1a17',
  },
};

/**
 * Цвета статусов поверх карты (линия связи, растр зоны покрытия, маркеры). Одинаковы в обеих темах:
 * подложка (спутник/топо) от темы не меняется, а прозрачность задаётся только у заливки растра.
 */
export const STATUS_MAP: Record<Status, string> = { ok: '#3fae5f', weak: '#e0a530', none: '#d9473a' };
export const STATUS_RGB: Record<Status, [number, number, number]> = {
  ok: hexRgb(STATUS_MAP.ok), weak: hexRgb(STATUS_MAP.weak), none: hexRgb(STATUS_MAP.none),
};

/** Цвета слоёв карты, зависящие от темы. */
export const MAP_THEME: Record<ThemeName, { bg: string; casing: string; casingOpacity: number; route: string; baseBrightness: number }> = {
  // casing — тёмная обводка линий: читается и на светлом топо, и на спутнике (сама линия яркая).
  day: { bg: '#e9e5dd', casing: '#15130f', casingOpacity: 0.7, route: '#2f86e0', baseBrightness: 1 },
  // ночью подложка дополнительно приглушается (×0.82), чтобы спутник не «светил» в темноте
  night: { bg: '#171614', casing: '#0d0c0a', casingOpacity: 0.8, route: '#4a9cf0', baseBrightness: 0.82 },
};

export function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Относительная яркость по WCAG 2.x. */
export function luminance(hex: string): number {
  const [r, g, b] = hexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------- Выбор темы ----------
export const THEME_KEY = 'uavmap.theme';
let choice: ThemeChoice = 'auto';
let applied: ThemeName | null = null;
let inited = false;

function readChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'day' || v === 'night' || v === 'auto') return v;
  } catch { /* приватный режим / нет доступа */ }
  return 'auto';
}

/** Авто: prefers-color-scheme; если браузер его не знает (Chrome < 76) — день с 7 до 20 по местному времени. */
export function autoTheme(now = new Date(), mm: ((q: string) => { matches: boolean }) | null = typeof matchMedia === 'function' ? matchMedia : null): ThemeName {
  if (mm) {
    if (mm('(prefers-color-scheme: dark)').matches) return 'night';
    if (mm('(prefers-color-scheme: light)').matches) return 'day';
  }
  const h = now.getHours();
  return h >= 7 && h < 20 ? 'day' : 'night';
}

export const getTheme = (): ThemeChoice => choice;
export const resolvedTheme = (): ThemeName => applied ?? (choice === 'auto' ? autoTheme() : choice);

function apply() {
  const t = choice === 'auto' ? autoTheme() : choice;
  if (typeof document === 'undefined') { applied = t; return; }
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEMES[t].bg);
  if (t !== applied) {
    applied = t;
    let ev: Event;
    try { ev = new CustomEvent('uavmap:theme', { detail: t }); } catch { ev = document.createEvent('CustomEvent'); (ev as CustomEvent).initCustomEvent('uavmap:theme', false, false, t); }
    window.dispatchEvent(ev);
  }
}

export function setTheme(c: ThemeChoice) {
  choice = c;
  try { localStorage.setItem(THEME_KEY, c); } catch { /* не сохранили — тема всё равно применится */ }
  apply();
}

/** Применить сохранённый выбор и следить за системной темой/временем суток. Повторный вызов безопасен. */
export function initTheme() {
  if (inited) return;
  inited = true;
  choice = readChoice();
  apply();
  if (typeof window === 'undefined') return;
  const onChange = () => { if (choice === 'auto') apply(); };
  if (typeof matchMedia === 'function') {
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-color-scheme: light)']) {
      const m = matchMedia(q);
      // addListener — для Chrome 68 (addEventListener у MediaQueryList появился позже)
      if (m.addEventListener) m.addEventListener('change', onChange); else m.addListener(onChange);
    }
  }
  window.setInterval(onChange, 10 * 60 * 1000); // авто по времени суток
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(); });
}
