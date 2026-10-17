import { describe, it, expect } from 'vitest';
import { tileRange, enumerateTiles, countTiles, estimateBytes, planLayers, parseAreas, exclusiveKeys, tileKey, tileUrl, keyToUrl, Area, DEFAULT_TILE_BYTES, areasCover, prepRadiusKm, prepLayers, prepState, dedupLayers, downloadVerdict, VIEW_Z0, VIEW_Z1 } from './offlineCore';
import { coverageZoom } from './elevation';

const area = (id: string, lat: number, lon: number, km: number, z = [10]): Area => ({
  id, name: id, lat, lon, km, calc: true, view: false, layers: z.map((zz) => ({ z: zz, km })), tiles: 1, bytes: 1, ts: 1, src: 'mapterhorn',
});

describe('перечисление тайлов', () => {
  it('без дублей и все в диапазоне', () => {
    const t = enumerateTiles(50, 30, [{ z: 12, km: 10 }, { z: 12, km: 5 }, { z: 11, km: 10 }]);
    const keys = t.map(tileKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of t) { expect(x.x).toBeGreaterThanOrEqual(0); expect(x.x).toBeLessThan(2 ** x.z); }
  });
  it('число тайлов растёт с радиусом и зумом', () => {
    expect(countTiles(50, 30, 20, 12)).toBeGreaterThan(countTiles(50, 30, 10, 12));
    expect(countTiles(50, 30, 40, 13)).toBeGreaterThan(countTiles(50, 30, 40, 12) * 3);
  });
  it('обёртка по X через антимеридиан (виртуальный z8 → тайлы источника z7)', () => {
    const t = enumerateTiles(60, 179.9, [{ z: 8, km: 40 }]);
    expect(t.every((v) => v.z === 7)).toBe(true);
    const xs = new Set(t.map((v) => v.x));
    expect(xs.has(127)).toBe(true);
    expect(xs.has(0)).toBe(true);
    expect(t.length).toBe(new Set(t.map(tileKey)).size);
  });
  it('обрезка по Y у полюса', () => {
    const t = enumerateTiles(85, 0, [{ z: 6, km: 100 }]);
    expect(Math.min(...t.map((v) => v.y))).toBe(0);
    expect(t.every((v) => v.y >= 0 && v.y < 32)).toBe(true);
  });
  it('огромный радиус не даёт больше 2^z колонок', () => {
    const r = tileRange(0, 0, 40000, 3);
    expect(r.x1 - r.x0 + 1).toBeLessThanOrEqual(8);
  });
  it('URL тайла по шаблону DEM', () => {
    expect(tileUrl({ z: 3, x: 4, y: 5 })).toBe('https://tiles.mapterhorn.com/3/4/5.webp');
    expect(keyToUrl('3/4/5')).toBe(tileUrl({ z: 3, x: 4, y: 5 }));
  });
});

describe('тайлы источника 512 px', () => {
  it('четыре соседних виртуальных тайла — один тайл источника уровнем выше', () => {
    const p = { lat: 43.68, lon: 40.2 };
    const virt = enumerateTiles(p.lat, p.lon, [{ z: 13, km: 3 }]);
    expect(virt.every((t) => t.z === 12)).toBe(true);
    expect(new Set(virt.map(tileKey)).size).toBe(virt.length);
  });
});

describe('оценка и план', () => {
  it('объём', () => {
    expect(estimateBytes(100)).toBe(100 * DEFAULT_TILE_BYTES);
    expect(estimateBytes(10, 1000)).toBe(10000);
  });
  it('слои расчёта и карты', () => {
    const l = planLayers(50, 30, 10, true, true);
    expect(l.some((x) => x.z === 8) && l.some((x) => x.z === 13)).toBe(true);
    expect(planLayers(50, 30, 10, false, false)).toEqual([]);
    const keys = l.map((x) => `${x.z}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('слои зоны — тот же уровень рельефа, что берёт расчёт зоны (coverageZoom)', () => {
    for (const [lat, lon] of [[43.68, 40.2], [55.75, 37.62], [64.5, 40.5]]) {
      const l = planLayers(lat, lon, 40, true, false);
      for (const r of [5, 10, 15, 25, 40]) {
        const z = coverageZoom({ lat, lon }, r * 1000).z;
        expect(l.some((x) => x.z === z && x.km >= r), `${lat}, ${r} км`).toBe(true);
      }
    }
  });
  it('растёт с радиусом на широтах 45 и 55', () => {
    for (const lat of [45, 55]) {
      const n = [5, 10, 20, 40].map((km) => enumerateTiles(lat, 30, planLayers(lat, 30, km, true, true)).length);
      expect(n[0]).toBeLessThan(n[1]); expect(n[1]).toBeLessThan(n[2]); expect(n[2]).toBeLessThan(n[3]);
    }
  });
});

describe('удаление только неиспользуемых', () => {
  it('одинокий район удаляется целиком', () => {
    const a = area('a', 50, 30, 10);
    expect(exclusiveKeys(a, []).length).toBe(enumerateTiles(50, 30, a.layers).length);
  });
  it('пересечение остаётся', () => {
    const a = area('a', 50, 30, 10), b = area('b', 50, 30.1, 10);
    const ka = enumerateTiles(50, 30, a.layers).map(tileKey), kb = new Set(enumerateTiles(50, 30.1, b.layers).map(tileKey));
    const ex = exclusiveKeys(a, [b]);
    expect(ex.length).toBeLessThan(ka.length);
    expect(ex.every((k) => !kb.has(k))).toBe(true);
    expect(ex.length).toBe(ka.filter((k) => !kb.has(k)).length);
  });
  it('полностью перекрытый район ничего не удаляет', () => {
    expect(exclusiveKeys(area('a', 50, 30, 5), [area('b', 50, 30, 10)])).toEqual([]);
  });
});

describe('разбор метаданных', () => {
  const ok = area('a', 50, 30, 10);
  it('нормальные записи', () => {
    expect(parseAreas(JSON.stringify({ v: 1, areas: [ok] }))).toEqual([ok]);
  });
  it('мусор', () => {
    expect(parseAreas(null)).toEqual([]);
    expect(parseAreas('{{')).toEqual([]);
    expect(parseAreas('42')).toEqual([]);
    expect(parseAreas(JSON.stringify({ areas: 5 }))).toEqual([]);
  });
  it('повреждённые записи отбрасываются, дубли id тоже', () => {
    const bad = [
      null, 1, 'x', { ...ok, id: '' }, { ...ok, id: 'b', lat: 95 }, { ...ok, id: 'c', km: -1 },
      { ...ok, id: 'd', layers: [] }, { ...ok, id: 'e', layers: [{ z: 99, km: 1 }] }, { ...ok, id: 'f', tiles: 'many' },
      { ...ok, id: 'g', lon: NaN }, ok,
    ];
    expect(parseAreas(JSON.stringify({ areas: bad })).map((x) => x.id)).toEqual(['a']);
    expect(parseAreas(JSON.stringify([ok, ok])).length).toBe(1);
  });
});

describe('areasCover: рельеф без сети для трассы', () => {
  const a = (over: Partial<Area> = {}): Area => ({ id: 'a', name: 'a', lat: 43.68, lon: 40.2, km: 10, calc: true, view: false, layers: [], tiles: 1, bytes: 1, ts: 1, src: 'mapterhorn', ...over });
  const st = { lat: 43.68, lon: 40.2 }, near = { lat: 43.70, lon: 40.25 }, far = { lat: 44.2, lon: 40.2 };
  it('пульт и прицел внутри района — да; прицел вне — нет', () => {
    expect(areasCover([a()], [st, near])).toBe('yes');
    expect(areasCover([a()], [st, far])).toBe('no');
  });
  it('нет районов, только карта без расчёта, старый источник или недокачанный район — молчим', () => {
    expect(areasCover([], [st])).toBe('none');
    expect(areasCover([a({ calc: false }), a({ src: 'aws' }), a({ complete: false })], [st])).toBe('none');
  });
  it('признак «недокачан» переживает сохранение; у районов прежних версий его нет — полные', () => {
    const L = [{ z: 10, km: 10 }]; // район без слоёв parseAreas отбрасывает
    const raw = JSON.stringify({ v: 1, areas: [a({ id: 'p', complete: false, layers: L }), a({ id: 'q', layers: L })] });
    expect(parseAreas(raw).map((x) => x.complete)).toEqual([false, undefined]);
  });
  it('точки в разных районах — нет: трасса целиком должна быть в одном', () => {
    expect(areasCover([a(), a({ id: 'b', lat: 44.2 })], [st, far])).toBe('no');
  });
});

describe('«Подготовить без сети»', () => {
  it('радиус района — радиус зоны вверх до ближайшего из 5/10/20/40 км', () => {
    expect(prepRadiusKm(5000)).toBe(5);
    expect(prepRadiusKm(4000)).toBe(5);
    expect(prepRadiusKm(5001)).toBe(10);
    expect(prepRadiusKm(10000)).toBe(10);
    expect(prepRadiusKm(15000)).toBe(20); // зона по умолчанию
    expect(prepRadiusKm(25000)).toBe(40);
    expect(prepRadiusKm(40000)).toBe(40);
    expect(prepRadiusKm(100000)).toBe(40); // больше наибольшего — наибольший
  });
  it('слои: расчёт и карта на весь район, уровень зоны текущего радиуса — даже не из списка зон', () => {
    for (const [lat, lon] of [[43.68, 40.2], [55.75, 37.62], [64.5, 40.5]]) {
      for (const r of [5000, 12000, 15000, 25000]) {
        const { km, layers } = prepLayers(lat, lon, r);
        expect(km).toBe(prepRadiusKm(r));
        const z = coverageZoom({ lat, lon }, r).z;
        expect(layers.some((x) => x.z === z && x.km >= r / 1000), `${lat}, ${r} м`).toBe(true);
        for (let v = VIEW_Z0; v <= VIEW_Z1; v++) expect(layers.some((x) => x.z === v && x.km === km)).toBe(true);
        expect(new Set(layers.map((x) => x.z)).size).toBe(layers.length); // без дублей по уровню
      }
    }
  });
  it('слои: больше 40 км — район 40 км, уровень зоны берётся для 40 км', () => {
    const { km, layers } = prepLayers(50, 30, 60000);
    expect(km).toBe(40);
    expect(layers.every((x) => x.km <= 40)).toBe(true);
  });
  it('dedupLayers: меньший радиус того же уровня поглощается, порядок сохраняется', () => {
    expect(dedupLayers([{ z: 10, km: 5 }, { z: 11, km: 5 }, { z: 10, km: 20 }, { z: 11, km: 5 }])).toEqual([{ z: 11, km: 5 }, { z: 10, km: 20 }]);
  });
  const A = (over: Partial<Area> = {}): Area => ({ id: 'a', name: 'a', lat: 43.68, lon: 40.2, km: 20, calc: true, view: true, layers: prepLayers(43.68, 40.2, 15000).layers, tiles: 1, bytes: 1, ts: 1, src: 'mapterhorn', ...over });
  const st = { lat: 43.68, lon: 40.2 };
  it('готовность у пульта: вся зона в районе — ready; пульт внутри, зона за краем — edge; вне — none', () => {
    expect(prepState([A()], st, 15000)).toBe('ready');
    expect(prepState([A()], st, 20000)).toBe('ready');
    expect(prepState([A()], { lat: 43.68 + 0.09, lon: 40.2 }, 15000)).toBe('edge'); // ~10 км от центра
    expect(prepState([A()], { lat: 44.2, lon: 40.2 }, 15000)).toBe('none');
    expect(prepState([], st, 15000)).toBe('none');
  });
  it('готовность по слоям: уровень зоны скачан на меньший радиус вокруг центра района — пульт со сдвигом не «готов»', () => {
    // «Скачать» 40 км только для расчёта: уровни зон 5–40 км — каждый на свой радиус вокруг центра.
    const big = A({ km: 40, view: false, layers: planLayers(43.68, 40.2, 40, true, false) });
    expect(prepState([big], st, 15000)).toBe('ready');
    const off = { lat: 43.68 + 0.18, lon: 40.2 }; // ~20 км к северу: пульт внутри 40 км, зона 15 км — тоже
    const zoneZ = coverageZoom(off, 15000).z;
    const zoneLayer = big.layers.find((l) => l.z === zoneZ)!;
    expect(prepState([big], off, 15000)).toBe(zoneLayer.km >= 35 ? 'ready' : 'edge');
    // Слой нужного уровня только на 10 км вокруг центра — зона 15 км у сдвинутого пульта не покрыта.
    const thin = A({ km: 40, view: false, layers: [{ z: zoneZ, km: 10 }, { z: zoneZ - 1, km: 40 }] });
    expect(prepState([thin], off, 15000)).toBe('edge');
  });
  it('готовность: недокачанный, без расчёта или со старого источника район не считается', () => {
    expect(prepState([A({ complete: false }), A({ calc: false }), A({ src: 'aws' })], st, 5000)).toBe('none');
  });
  it('итог скачивания — понятным текстом', () => {
    const ok = { done: 10, skipped: 2, errors: 0, aborted: false };
    expect(downloadVerdict(ok, '~3 МБ', 'Подготовить без сети')).toBe('Готово: ~3 МБ — расчёт здесь работает без сети');
    expect(downloadVerdict({ ...ok, errors: 3 }, '~3 МБ', 'Обновить')).toMatch(/^Скачано не всё \(~3 МБ\).*«Обновить»/);
    expect(downloadVerdict({ ...ok, aborted: true }, '~3 МБ', 'Обновить')).toMatch(/отменено.*~3 МБ.*«Обновить» докачает/);
    // Источник не отвечает — важнее отмены и частичных ошибок.
    expect(downloadVerdict({ done: 0, skipped: 0, errors: 6, aborted: false, sourceDown: true }, '~0 Б', 'Подготовить без сети')).toMatch(/^Скачано не всё — источник рельефа \(Mapterhorn\) не отвечает.*«Подготовить без сети»/);
  });
});
