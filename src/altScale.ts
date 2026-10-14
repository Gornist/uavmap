// Шкала высотомера без DOM: верх шкалы и цветные полосы «на какой высоте какая связь».

/** ok/weak/none — статус связи на этой высоте; ground — дрон был бы внутри склона у прицела. */
export type AltLevel = 'ok' | 'weak' | 'none' | 'ground';
export interface AltBand { from: number; to: number; level: AltLevel }

/** Предел поиска нужной высоты (как в minHeightForLink) — выше шкала не растёт. */
export const ALT_MAX = 1500;
const NICE = [300, 400, 500, 600, 800, 1000, 1200, ALT_MAX];

/**
 * Верх шкалы: круглое число с запасом ~25 % над важными высотами (дрон, нужные высоты, склон).
 * prev — прежний верх: пока он подходит (важное ниже него и не теряется внизу), шкала не перескакивает.
 */
export function scaleTop(marks: number[], prev?: number): number {
  const want = Math.max(0, ...marks.filter((m) => Number.isFinite(m))) * 1.25;
  if (prev && want <= prev && want > prev * 0.35) return prev;
  return NICE.find((v) => v >= want) ?? ALT_MAX;
}

/**
 * Полосы от 0 до top: level(h) в n точках, границы между разными уровнями уточняются делением пополам до ~1 м,
 * чтобы край цвета совпадал с числами подсказки.
 */
export function altBands(level: (h: number) => AltLevel, top: number, n = 40): AltBand[] {
  const step = top / n;
  const out: AltBand[] = [];
  let prevH = 0, prevLv = level(0);
  out.push({ from: 0, to: 0, level: prevLv });
  for (let i = 1; i <= n; i++) {
    const hh = i * step, lv = level(hh);
    if (lv !== prevLv) {
      let lo = prevH, hi = hh; // level(lo) = prevLv, level(hi) = lv
      while (hi - lo > 1) { const m = (lo + hi) / 2; if (level(m) === prevLv) lo = m; else hi = m; }
      out[out.length - 1].to = hi;
      out.push({ from: hi, to: hi, level: lv });
    }
    prevH = hh; prevLv = lv;
  }
  out[out.length - 1].to = top;
  return out.filter((b) => b.to > b.from);
}

/** Шаг высоты при перетаскивании: на шкале до 600 м — 10 м, выше — 25 м. */
export const altSnap = (top: number) => (top <= 600 ? 10 : 25);
