import { describe, expect, it } from 'vitest';
import { computeChunk, computeCoverage, CoverageJob, emptyResult, lossThreshold, mergeChunk, sectorCrop, splitRays } from './coverageCore';
import { DemGrid, sampleGrid, sampleRay, sampleRayPoints } from './elevation';
import { destination, lonLatToPixel } from './geo';
import { analyzeLink, budget, DEFAULT_RADIO, DEFAULT_VIDEO, freeSpaceRange, fspl } from './radio';

const LAT = 55.75, LON = 37.62, Z = 12;
const SIZE = 1024;                    // ≈ ±11 км при 21.9 м/px на этой широте
const [CX, CY] = lonLatToPixel(LON, LAT, Z);
const P = { ...DEFAULT_RADIO };
const BUDGET = budget(P);

/** Мозаика z=12 с центром в пульте; height(dxPx, dyPx) — рельеф в пикселях от пульта (dy<0 — север). */
function grid(height: (dx: number, dy: number) => number): DemGrid {
  const px0 = Math.floor(CX) - SIZE / 2, py0 = Math.floor(CY) - SIZE / 2;
  const data = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) data[y * SIZE + x] = height(px0 + x + 0.5 - CX, py0 + y + 0.5 - CY);
  return { z: Z, px0, py0, width: SIZE, height: SIZE, data };
}

/** Треугольный хребет поперёк направления на север: пик на dy = −at пикселей, полуширина w px. */
const ridgeAt = (at: number, w: number, h: number) => (_dx: number, dy: number) => Math.max(0, h * (1 - Math.abs(dy + at) / w));

function job(g: DemGrid, over: Partial<CoverageJob> = {}): CoverageJob {
  return {
    grid: g, lat: LAT, lon: LON, antH: 2, heights: [30], mode: 'takeoff', radius: 5000, step: 50, rays: 4,
    freqMHz: P.freqMHz, budget: BUDGET, k: P.k, fade: P.fadeMarginDb, ...over,
  };
}

/** Профиль рельефа вдоль луча — тот же способ выборки, что в ядре. */
/** Билинейная высота в точке на луче (как конец профиля в calcLink). */
function pointAt(g: DemGrid, az: number, dist: number): number {
  const p = destination({ lat: LAT, lon: LON }, az, dist);
  const [x, y] = lonLatToPixel(p.lon, p.lat, Z);
  return sampleGrid(g, x, y);
}

function rayProfile(g: DemGrid, az: number, upTo: number, step: number): Float64Array {
  // Та же выборка, что в computeCoverage: максимум в окне ±step/2, точка пульта — билинейно.
  const n = Math.floor(upTo / step);
  const out = new Float64Array(n + 1);
  sampleRay(g, LAT, LON, az, step, n + 1, out);
  const [x0, y0] = lonLatToPixel(LON, LAT, Z);
  out[0] = sampleGrid(g, x0, y0);
  return out;
}

const M = (res: ReturnType<typeof computeCoverage>, h: number, r: number, rays: number, s: number) =>
  res.margins[(h * rays + r) * res.samples + s];

describe('computeCoverage: ровная земля', () => {
  const g = grid(() => 100);
  const res = computeCoverage(job(g, { heights: [30, 100] }));

  it('размеры массивов и ground0', () => {
    expect(res.samples).toBe(101);
    expect(res.margins.length).toBe(2 * 4 * 101);
    expect(res.firstLoss.length).toBe(2 * 4);
    expect(res.ground0).toBeCloseTo(100, 4);
  });
  it('в точке пульта запас 99 (заглушка)', () => {
    for (let h = 0; h < 2; h++) for (let r = 0; r < 4; r++) expect(M(res, h, r, 4, 0)).toBe(99);
  });
  it('запас на луче = budget − fspl(d) (дифракции нет), убывает с расстоянием', () => {
    for (let h = 0; h < 2; h++) for (let r = 0; r < 4; r++) {
      let prev = Infinity;
      for (let s = 2; s <= 100; s++) {
        const m = M(res, h, r, 4, s);
        expect(m).toBeCloseTo(BUDGET - fspl(s * 50, P.freqMHz), 3);
        expect(m).toBeLessThan(prev);
        prev = m;
      }
    }
  });
  it('совпадает с analyzeLink на том же профиле (допуск 0.05 дБ)', () => {
    const prof = rayProfile(g, 0, 5000, 50);
    for (const s of [10, 40, 100]) {
      const a = analyzeLink(prof.subarray(0, s + 1), s * 50, prof[0] + 2, prof[0] + 30, P);
      expect(M(res, 0, 0, 4, s)).toBeCloseTo(a.margin, 1);
    }
  });
  it('firstLoss на свободных лучах = radius (запас на 5 км ≈ 16 дБ > fade)', () => {
    for (const v of res.firstLoss) expect(v).toBe(5000);
  });
  it('firstLoss = дальность до первого s с запасом < fade при длинном радиусе', () => {
    const far = computeCoverage(job(g, { radius: 30000, step: 300, rays: 2, antH: 30, heights: [100] }));
    const fl = far.firstLoss[0];
    expect(fl).toBeLessThan(30000);
    // последняя точка с запасом ≥ fade: fspl = budget − fade → ≈ freeSpaceRange (при потерях 4 дБ ≈7.8 км) в пределах шага
    expect(Math.abs(fl - freeSpaceRange(P))).toBeLessThan(400);
    expect(M(far, 0, 0, 2, Math.round(fl / 300))).toBeGreaterThanOrEqual(P.fadeMarginDb);
    expect(M(far, 0, 0, 2, Math.round(fl / 300) + 1)).toBeLessThan(P.fadeMarginDb);
  });
  it('прогресс вызывается и не превышает 1', () => {
    const seen: number[] = [];
    computeCoverage(job(g, { rays: 33 }), (f) => seen.push(f));
    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) { expect(f).toBeGreaterThanOrEqual(0); expect(f).toBeLessThan(1); }
  });
});

describe('computeCoverage: хребет на севере (≈2.2 км, 150 м)', () => {
  const g = grid(ridgeAt(100, 10, 150));
  const res = computeCoverage(job(g, { heights: [30, 100, 250], rays: 4 }));
  // лучи: 0=север (хребет), 1=восток, 2=юг, 3=запад
  const fl = (h: number, r: number) => res.firstLoss[h * 4 + r];

  it('за хребтом запас резко падает (скачок > 8 дБ относительно свободной земли)', () => {
    // s=70 → 3.5 км, за гребнем (≈2.2 км)
    const free = M(res, 0, 1, 4, 70), shadow = M(res, 0, 0, 4, 70);
    expect(free - shadow).toBeGreaterThan(8);
    // до хребта (1.5 км) разницы нет
    expect(M(res, 0, 0, 4, 30)).toBeCloseTo(M(res, 0, 1, 4, 30), 1);
  });
  it('firstLoss на луче с хребтом меньше, чем на свободных; свободные = radius', () => {
    for (const r of [1, 2, 3]) expect(fl(0, r)).toBe(5000);
    expect(fl(0, 0)).toBeLessThan(5000);
    expect(fl(0, 0)).toBeGreaterThan(1000);
    expect(fl(0, 0)).toBeLessThan(3500);
  });
  it('большая высота дрона → firstLoss не меньше, и на 250 м строго больше, чем на 30 м', () => {
    expect(fl(1, 0)).toBeGreaterThanOrEqual(fl(0, 0));
    expect(fl(2, 0)).toBeGreaterThanOrEqual(fl(1, 0));
    expect(fl(2, 0)).toBeGreaterThan(fl(0, 0));
  });
  it('запас в точке за хребтом растёт с высотой дрона', () => {
    const s = 60;
    expect(M(res, 1, 0, 4, s)).toBeGreaterThan(M(res, 0, 0, 4, s));
    expect(M(res, 2, 0, 4, s)).toBeGreaterThan(M(res, 1, 0, 4, s));
  });
  it('запас с ОДНИМ препятствием совпадает с analyzeLink (допуск 1 дБ)', () => {
    const prof = rayProfile(g, 0, 5000, 50);
    for (const s of [70, 80, 90, 100]) {
      const a = analyzeLink(prof.subarray(0, s + 1), s * 50, prof[0] + 2, prof[s] + 30, P);
      expect(Math.abs(M(res, 0, 0, 4, s) - a.margin)).toBeLessThan(1);
    }
  });
});

describe('computeCoverage: режимы terrain / takeoff', () => {
  // уклон на север: +0.05 м на пиксель (≈ 2.3 м/км), на 5 км подъём ≈ 11 м... берём круче: 0.3 м/px → ≈ 14 м/км
  const slope = (_dx: number, dy: number) => Math.max(0, -dy) * 0.3;
  const g = grid(slope);
  const take = computeCoverage(job(g, { mode: 'takeoff', heights: [30], rays: 4 }));
  const terr = computeCoverage(job(g, { mode: 'terrain', heights: [30], rays: 4 }));

  it('на плоском направлении (восток/запад/юг) режимы одинаковы', () => {
    for (const r of [1, 2, 3]) for (const s of [5, 50, 100]) expect(M(terr, 0, r, 4, s)).toBeCloseTo(M(take, 0, r, 4, s), 1);
  });
  it('в гору: «над землёй» (terrain) даёт запас не хуже «от точки взлёта»', () => {
    for (const s of [20, 50, 100]) expect(M(terr, 0, 0, 4, s)).toBeGreaterThanOrEqual(M(take, 0, 0, 4, s) - 1e-3);
    expect(terr.firstLoss[0]).toBeGreaterThanOrEqual(take.firstLoss[0]);
  });
  it('в гору на 5 км: от точки взлёта дрон (30 м) ниже склона → глухо, terrain — почти свободное пространство', () => {
    const s = 100;
    expect(M(take, 0, 0, 4, s)).toBeLessThan(0);
    expect(M(terr, 0, 0, 4, s)).toBeGreaterThan(BUDGET - fspl(5000, P.freqMHz) - 12);
    expect(take.firstLoss[0]).toBeLessThan(terr.firstLoss[0]);
  });
});

describe('Зона и профиль: ДВА препятствия (оба — дельта-Буллингтон, P.526-15 § 4.5)', () => {
  // Два узких хребта на севере (1.1 и 2.8 км). Когда-то зона брала только главный клин и была оптимистичнее до ~29 дБ.
  // При 120 м оба хребта — горизонты от пульта и от дрона (edges = 2 точки Буллингтона).
  const twoRidges = (h: number) => {
    const g = grid((dx, dy) => ridgeAt(50, 4, h)(dx, dy) + ridgeAt(128, 4, h)(dx, dy));
    const res = computeCoverage(job(g, { heights: [30], rays: 4 }));
    const prof = rayProfile(g, 0, 5000, 50);
    const diffs = [70, 80, 90, 100].map((s) => {
      const a = analyzeLink(prof.subarray(0, s + 1), s * 50, prof[0] + 2, prof[s] + 30, P);
      return { zone: M(res, 0, 0, 4, s), profile: a.margin, edges: a.edges.length };
    });
    return diffs;
  };

  for (const h of [25, 120]) {
    it(`хребты ${h} м: запас зоны совпадает с профилем (±0.5 дБ)`, () => {
      for (const x of twoRidges(h)) {
        if (h === 120) expect(x.edges).toBeGreaterThanOrEqual(2);
        expect(Math.abs(x.zone - x.profile)).toBeLessThan(0.5);
      }
    });
  }
});

describe('аудит (2A): дрон под землёй и море', () => {
  it('режим takeoff: точки выше взлёта + высоты дрона — связи нет (−99)', () => {
    // склон вверх на север
    const g = grid((_dx, dy) => Math.max(0, -dy) * 10); // склон на север (dy<0), ~10 м на пиксель сетки
    const res = computeCoverage(job(g, { radius: 3000, step: 50, rays: 4, heights: [100], mode: 'takeoff' }));
    expect(M(res, 0, 0, 4, 59)).toBe(-99); // ~3 км на север рельеф сотни метров > 0 + 100 м
  });
  it("режим terrain над морем: отрицательный рельеф не обрезается (дрон считается над дном — пессимистично)", () => {
    const sea = grid(() => -200);
    const res = computeCoverage(job(sea, { radius: 2000, step: 50, rays: 4, heights: [50], mode: 'terrain', antH: 2 }));
    expect(M(res, 0, 0, 4, 20)).toBeGreaterThan(-99);
  });
});

describe('Зона и профиль: холмистый рельеф, все высоты и оба режима (±0.5 дБ)', () => {
  const hills = (dx: number, dy: number) => 150 + 60 * Math.sin(dx / 37) * Math.cos(dy / 53) + 20 * Math.sin((dx + dy) / 11);
  const g = grid(hills);
  const heights = [5, 30, 120, 400];
  for (const mode of ['takeoff', 'terrain'] as const) {
    it(`режим ${mode}`, () => {
      const rays = 8;
      const res = computeCoverage(job(g, { heights, rays, mode, radius: 8000, step: 50 }));
      for (const r of [0, 3, 5]) {
        const prof = rayProfile(g, (360 * r) / rays, 8000, 50);
        for (const s of [1, 2, 7, 40, 99, 160]) {
          for (let h = 0; h < heights.length; h++) {
            // Конец профиля — высота в самой точке дрона (как в calcLink), промежуточные — максимум окна.
            const sub = prof.slice(0, s + 1);
            sub[s] = pointAt(g, (360 * r) / rays, s * 50);
            const hB = (mode === 'takeoff' ? sub[0] : sub[s]) + heights[h];
            const a = analyzeLink(sub, s * 50, sub[0] + 2, hB, P);
            const z = M(res, h, r, rays, s);
            if (a.belowGround) expect(z).toBe(-99);
            else expect(Math.abs(z - a.margin)).toBeLessThan(0.5);
          }
        }
      }
    });
  }
});

describe('ускорения: части лучей, вырезки сетки и отсечение «заведомо нет связи» дают тот же результат', () => {
  const hills = (dx: number, dy: number) => 150 + 70 * Math.sin(dx / 23) * Math.cos(dy / 31) + 25 * Math.sin((dx + dy) / 7);
  const g = grid(hills);
  const lvl = (m: number, fade: number) => (m >= fade ? 2 : m >= 0 ? 1 : 0);
  const V = { ...DEFAULT_VIDEO };
  const lines = [
    { freqMHz: P.freqMHz, budget: BUDGET, k: P.k, fade: P.fadeMarginDb },
    { freqMHz: V.freqMHz, budget: budget(V), k: V.k, fade: V.fadeMarginDb },   // свободное пространство кончается ≈ 6.5 км
    { freqMHz: 868, budget: BUDGET + 10, k: 4 / 3, fade: -3 },                  // отрицательный запас на замирания
  ];
  const heights = [5, 30, 120, 400];
  for (const mode of ['takeoff', 'terrain'] as const) {
    it(`режим ${mode}: 5 частей × вырезки × exact=false ≡ полный последовательный расчёт`, () => {
      const rays = 36, radius = 10000, step = 50;
      const base = { grid: g, lat: LAT, lon: LON, antH: 2, heights, mode, radius, step, rays };
      const full = lines.map((ln) => computeCoverage({ ...base, ...ln }));
      const parts = lines.map(() => emptyResult(heights.length, rays, full[0].samples));
      for (const [r0, r1] of splitRays(rays, 5)) {
        const crop = sectorCrop(g, LAT, LON, rays, r0, r1, radius, step);
        expect(crop.data.length).toBeLessThan(g.data.length);
        const res = computeChunk({ ...base, grid: crop, r0, r1, exact: false, lines });
        res.forEach((r, li) => mergeChunk(parts[li], r, heights.length, rays, r0, r1));
      }
      lines.forEach((ln, li) => {
        const a = full[li], b = parts[li], thr = lossThreshold(ln.fade);
        let pruned = 0, badLvl = 0, badBound = 0;
        expect(b.firstLoss).toEqual(a.firstLoss);
        expect(b.ground0).toBe(a.ground0);
        for (let i = 0; i < a.margins.length; i++) {
          if (lvl(b.margins[i], ln.fade) !== lvl(a.margins[i], ln.fade)) badLvl++;
          if (b.margins[i] !== a.margins[i]) {
            // Где не считалось точно — верхняя оценка ниже порога «нет связи».
            pruned++;
            if (!(b.margins[i] < thr && b.margins[i] >= a.margins[i])) badBound++;
          }
        }
        expect(badLvl).toBe(0);
        expect(badBound).toBe(0);
        if (li === 1) expect(pruned).toBeGreaterThan(a.margins.length / 4);
      });
    });
  }
  it('вырезка под сектор при exact=true даёт те же числа, что и вся мозаика', () => {
    const job0 = job(g, { heights, rays: 20, radius: 9000, step: 60 });
    const full = computeCoverage(job0);
    const part = emptyResult(heights.length, 20, full.samples);
    for (const [r0, r1] of splitRays(20, 3)) mergeChunk(part, computeCoverage({ ...job0, grid: sectorCrop(g, LAT, LON, 20, r0, r1, 9000, 60), r0, r1 }), heights.length, 20, r0, r1);
    expect(part.margins).toEqual(full.margins);
    expect(part.firstLoss).toEqual(full.firstLoss);
  });
  it('splitRays покрывает все лучи без пропусков', () => {
    expect(splitRays(10, 3)).toEqual([[0, 3], [3, 6], [6, 10]]);
    expect(splitRays(2, 5)).toEqual([[0, 1], [1, 2]]);
  });
});

describe('общий рельеф лучей для нескольких линий (computeChunk)', () => {
  const g = grid((dx, dy) => 150 + 70 * Math.sin(dx / 23) * Math.cos(dy / 31) + 25 * Math.sin((dx + dy) / 7));
  it('точки луча через rayNode совпадают с destination + lonLatToPixel', () => {
    const nS = 120, step = 40, out = new Float64Array(nS);
    for (const az of [0, 37.5, 133, 271]) {
      sampleRayPoints(g, LAT, LON, az, step, nS, out);
      for (let k = 1; k < nS; k++) expect(out[k]).toBeCloseTo(pointAt(g, az, k * step), 6);
    }
  });
  it('exact: две линии с общим рельефом ≡ каждая линия отдельно (бит в бит)', () => {
    const V = { ...DEFAULT_VIDEO };
    const lines = [
      { freqMHz: P.freqMHz, budget: BUDGET, k: P.k, fade: P.fadeMarginDb },
      { freqMHz: V.freqMHz, budget: budget(V), k: 1.2, fade: V.fadeMarginDb }, // и k другой: G/H по линии
    ];
    const base = { grid: g, lat: LAT, lon: LON, antH: 2, heights: [10, 80], mode: 'takeoff' as const, radius: 6000, step: 50, rays: 24, exact: true };
    const both = computeChunk({ ...base, r0: 0, r1: base.rays, lines });
    lines.forEach((ln, li) => {
      const one = computeCoverage({ ...base, ...ln });
      expect(both[li].margins).toEqual(one.margins);
      expect(both[li].firstLoss).toEqual(one.firstLoss);
    });
  });
});

describe('computeCoverage: направленная антенна на земле', () => {
  const flat = grid(() => 100);
  const patch = { kind: 'patch' as const, gainDbi: 8, beamDeg: 60 };
  it('на оси — как без поправки, сзади — слабее на отношение «вперёд/назад», на краю луча — на 3 дБ', () => {
    // 4 луча: 0°, 90°, 180°, 270°; антенна смотрит на восток (90°).
    const plain = computeCoverage(job(flat));
    const aimed = computeCoverage(job(flat, { aim: { antenna: patch, heading: 90 } }));
    const s = 40;
    expect(M(aimed, 0, 1, 4, s)).toBeCloseTo(M(plain, 0, 1, 4, s), 4);       // 90° — на оси
    expect(M(plain, 0, 3, 4, s) - M(aimed, 0, 3, 4, s)).toBeCloseTo(20, 4);  // 270° — сзади, FBR патча 20 дБ
    const edge = computeCoverage(job(flat, { aim: { antenna: patch, heading: 30 } })); // луч 0° — край луча (30°)
    expect(M(plain, 0, 0, 4, s) - M(edge, 0, 0, 4, s)).toBeCloseTo(3, 4); // запасы — Float32
  });
});
