// Потери на местности у пульта (антенна 1.5–2 м среди деревьев/домов). Дрон в воздухе — у него не учитываем:
// полог леса частично уже есть в SRTM. Ориентиры: ITU-R P.833 (растительность, ~0.2–0.4 дБ/м листвы на 2.4 ГГц
// с насыщением) и P.2108 §3.1 (поправка на застройку у терминала).
import type { RadioParams } from './radio';

export type ClutterClass = 'open' | 'sparse' | 'village' | 'forest';

export const CLUTTER: { id: ClutterClass; name: string; hint: string; db24: number }[] = [
  { id: 'open', name: 'Открыто', hint: 'поле, вершина, крыша', db24: 0 },
  { id: 'sparse', name: 'Редкие деревья', hint: 'кусты, лесополоса рядом', db24: 4 },
  { id: 'village', name: 'Посёлок', hint: 'дома, заборы вокруг', db24: 6 },
  { id: 'forest', name: 'В лесу', hint: 'под кронами, просека', db24: 15 },
];

/** Потери для класса на частоте f: на 2.4 ГГц — табличные, ниже частота — меньше (~f^0.6), выше — до ×1.2. */
export function clutterLoss(cls: ClutterClass, freqMHz: number): number {
  const base = CLUTTER.find((c) => c.id === cls)?.db24 ?? 0;
  return base * Math.min(1.2, (freqMHz / 2440) ** 0.6);
}

/** Радиопараметры с учётом класса местности у пульта (ручные «потери на местности» складываются). */
export function withClutter(p: RadioParams, cls: ClutterClass): RadioParams {
  const extra = clutterLoss(cls, p.freqMHz);
  return extra ? { ...p, clutterDb: p.clutterDb + extra } : p;
}
