import { describe, expect, it } from 'vitest';
// @ts-expect-error -- в проекте нет @types/node; тест выполняется vitest в node (environment: 'node')
import { readFileSync } from 'node:fs';
import { THEMES, STATUS_MAP, STATUS_RGB, contrast, autoTheme, type ThemeName, type ThemeTokens } from './theme';

// ?raw для .css vitest отдаёт пустым — читаем файл напрямую.
const css: string = readFileSync(new URL('./styles/theme.css', import.meta.url), 'utf8');

/** Все блоки CSS с маркером «@tokens <тема>» → карта --имя → значение. */
function cssBlocks(theme: ThemeName): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const re = new RegExp(`/\\* @tokens ${theme} \\*/([^}]*)}`, 'g');
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const vars: Record<string, string> = {};
    for (const d of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
    out.push(vars);
  }
  return out;
}

type K = keyof ThemeTokens;
/** [передний план, фон, минимум]: основной текст ≥ 7:1, вторичный и статусы ≥ 4.5:1 (бриф docs/DESIGN.md). */
const PAIRS: [K, K, number][] = [
  ['text', 'bg', 7], ['text', 'panel', 7], ['text', 'panel-2', 7], ['text', 'field', 7], ['text', 'accent-soft', 7],
  ['accent-ink', 'accent', 7],
  ['muted', 'bg', 4.5], ['muted', 'panel', 4.5], ['muted', 'panel-2', 4.5], ['muted', 'field', 4.5],
  ['accent-text', 'panel', 4.5], ['accent-text', 'panel-2', 4.5], ['accent-text', 'accent-soft', 4.5],
  ['ok', 'panel', 4.5], ['weak', 'panel', 4.5], ['none', 'panel', 4.5],
  ['ok', 'panel-2', 4.5], ['weak', 'panel-2', 4.5], ['none', 'panel-2', 4.5],
  ['ok', 'ok-bg', 4.5], ['weak', 'weak-bg', 4.5], ['none', 'none-bg', 4.5],
  ['text', 'ok-bg', 7], ['text', 'weak-bg', 7], ['text', 'none-bg', 7],
];

describe('темы: WCAG-контраст', () => {
  it('формула совпадает с эталоном WCAG', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
  for (const t of ['day', 'night'] as ThemeName[]) {
    for (const [fg, bg, min] of PAIRS) {
      it(`${t}: --${fg} на --${bg} ≥ ${min}:1`, () => {
        expect(contrast(THEMES[t][fg], THEMES[t][bg])).toBeGreaterThanOrEqual(min);
      });
    }
  }
});

describe('темы: CSS совпадает с THEMES (один источник правды)', () => {
  it.each([['day', 1], ['night', 2]] as [ThemeName, number][])('%s: блоков @tokens — %i, значения совпадают', (t, n) => {
    const blocks = cssBlocks(t);
    expect(blocks).toHaveLength(n);
    for (const b of blocks) {
      for (const [k, v] of Object.entries(THEMES[t])) expect(b[k], `--${k}`).toBe(v);
    }
  });
  it('все токены — непрозрачные #rrggbb', () => {
    for (const t of Object.values(THEMES)) for (const v of Object.values(t)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('theme-color в index.html — фон ночной темы (до загрузки скриптов; дальше ставит theme.ts)', () => {
    const html: string = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain(`<meta name="theme-color" content="${THEMES.night.bg}" />`);
  });
  it('RGB статусов для растра = STATUS_MAP', () => {
    expect(STATUS_RGB.ok).toEqual([0x3f, 0xae, 0x5f]);
    for (const s of ['ok', 'weak', 'none'] as const) expect('#' + STATUS_RGB[s].map((c) => c.toString(16).padStart(2, '0')).join('')).toBe(STATUS_MAP[s]);
  });
});

describe('autoTheme', () => {
  const mm = (dark: boolean | null) => (q: string) => ({ matches: dark === null ? false : q.includes('dark') === dark });
  it('следует prefers-color-scheme', () => {
    expect(autoTheme(new Date(2026, 0, 1, 12), mm(true))).toBe('night');
    expect(autoTheme(new Date(2026, 0, 1, 23), mm(false))).toBe('day');
  });
  it('без предпочтения — день с 7 до 20', () => {
    expect(autoTheme(new Date(2026, 0, 1, 6, 59), mm(null))).toBe('night');
    expect(autoTheme(new Date(2026, 0, 1, 7), mm(null))).toBe('day');
    expect(autoTheme(new Date(2026, 0, 1, 19, 59), null)).toBe('day');
    expect(autoTheme(new Date(2026, 0, 1, 20), null)).toBe('night');
  });
});
