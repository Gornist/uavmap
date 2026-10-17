import { describe, it, expect, vi } from 'vitest';
import { plan, MAX_TILES } from './prefetch';
import { coverageZoom } from './elevation';
import { enumerateTiles } from './offlineCore';
import { distance, pixelToLonLat } from './geo';

// prefetch.ts подписывается на события приложения: app.ts создаёт карту MapLibre — в node её нет, подменяем.
vi.mock('./app', () => ({ S: {}, on: () => undefined }));

/** Центр тайла источника (z, x, y) — тайлы 512 px, в координатах lonLatToPixel (256 px) это 256 px уровня z. */
const tileCenter = (t: { z: number; x: number; y: number }) => {
  const [lon, lat] = pixelToLonLat((t.x + 0.5) * 256, (t.y + 0.5) * 256, t.z);
  return { lat, lon };
};

describe('подкачка рельефа вокруг пульта: план тайлов', () => {
  const st = { lat: 43.6805, lon: 40.2045 }; // Красная Поляна

  it('те же тайлы, что нужны зоне радиусом r, ближние к пульту — первыми', () => {
    const r = 10000;
    const p = plan(st.lat, st.lon, r);
    const { z } = coverageZoom(st, r);
    const all = enumerateTiles(st.lat, st.lon, [{ z, km: r / 1000 }]);
    expect(p.length).toBe(Math.min(all.length, MAX_TILES));
    const key = (t: { z: number; x: number; y: number }) => `${t.z}/${t.x}/${t.y}`;
    expect(new Set(p.map(key))).toEqual(new Set(all.map(key)));
    // Первый тайл — тот, в котором стоит пульт; дальше расстояние до пульта не убывает (с точностью до тайла).
    const d = p.map((t) => distance(st, tileCenter(t)));
    const span = distance(tileCenter(p[0]), tileCenter({ ...p[0], x: p[0].x + 1 }));
    expect(d[0]).toBeLessThan(span);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThan(d[i - 1] - span * 0.75);
  });

  it('не больше MAX_TILES, при обрезке остаются ближние к пульту', () => {
    // Штатные радиусы (до 40 км) дают ≤ 64 тайлов: уровень зоны понижается по числу тайлов. Обрезка срабатывает,
    // когда уровень упирается в нижний предел (z8) — огромный радиус.
    const r = 1_500_000;
    const p = plan(st.lat, st.lon, r);
    const { z } = coverageZoom(st, r);
    const all = enumerateTiles(st.lat, st.lon, [{ z, km: r / 1000 }]);
    expect(all.length).toBeGreaterThan(MAX_TILES);
    expect(p.length).toBe(MAX_TILES);
    const far = Math.max(...p.map((t) => distance(st, tileCenter(t))));
    const keys = new Set(p.map((t) => `${t.x}/${t.y}`));
    const dropped = all.filter((t) => !keys.has(`${t.x}/${t.y}`));
    expect(dropped.length).toBe(all.length - MAX_TILES);
    // Отброшенные — не ближе оставленных (с точностью до тайла: сортировка по номерам тайлов, а не по метрам).
    for (const t of dropped) expect(distance(st, tileCenter(t))).toBeGreaterThan(far * 0.8);
  });
});
