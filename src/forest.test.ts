import { describe, it, expect } from 'vitest';
import Pbf from 'pbf';
import { woodRings } from './forestCore';

// Мини-кодер MVT (спецификация Mapbox Vector Tile 2.1): слой landcover с полигонами и свойством class.
const zz = (n: number) => (n << 1) ^ (n >> 31);
const cmd = (id: number, count: number) => (id & 7) | (count << 3);

/** Геометрия полигона: кольца в координатах тайла (extent 4096). */
function geom(rings: [number, number][][]): number[] {
  const out: number[] = [];
  let cx = 0, cy = 0;
  for (const r of rings) {
    out.push(cmd(1, 1), zz(r[0][0] - cx), zz(r[0][1] - cy)); cx = r[0][0]; cy = r[0][1];
    out.push(cmd(2, r.length - 1));
    for (const [x, y] of r.slice(1)) { out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
    out.push(cmd(7, 1));
  }
  return out;
}

function tile(features: { cls: string; rings: [number, number][][]; type?: number }[], layer = 'landcover'): ArrayBuffer {
  const classes = [...new Set(features.map((f) => f.cls))];
  const pbf = new Pbf();
  pbf.writeMessage(3, (_: null, pp?: Pbf) => {
    const p = pp!;
    p.writeVarintField(15, 2);
    p.writeStringField(1, layer);
    for (const f of features) {
      p.writeMessage(2, (_: null, qq?: Pbf) => {
        const q = qq!;
        q.writePackedVarint(2, [0, classes.indexOf(f.cls)]);
        q.writeVarintField(3, f.type ?? 3);
        q.writePackedVarint(4, geom(f.rings));
      }, null);
    }
    p.writeStringField(3, 'class');
    for (const c of classes) p.writeMessage(4, (_: null, q?: Pbf) => q!.writeStringField(1, c), null);
    p.writeVarintField(5, 4096);
  }, null);
  const u = pbf.finish();
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

const square = (x0: number, y0: number, s: number): [number, number][] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]];

describe('лес: разбор векторного тайла', () => {
  it('берёт только wood, кольца — в долях тайла, дыры сохраняются', () => {
    const rings = woodRings(tile([
      { cls: 'wood', rings: [square(0, 0, 2048), square(512, 512, 512).reverse()] }, // лес с поляной
      { cls: 'grass', rings: [square(2048, 2048, 1024)] },
    ]));
    expect(rings.length).toBe(2);
    expect(Array.from(rings[0].slice(0, 4))).toEqual([0, 0, 0.5, 0]);
    expect(Array.from(rings[1].slice(0, 2))).toEqual([512 / 4096, 1024 / 4096]); // дыра: обход в обратную сторону
  });
  it('пустой ответ, нет слоя landcover, линии вместо полигонов — пусто', () => {
    expect(woodRings(new ArrayBuffer(0))).toEqual([]);
    expect(woodRings(tile([{ cls: 'wood', rings: [square(0, 0, 100)] }], 'water'))).toEqual([]);
    expect(woodRings(tile([{ cls: 'wood', rings: [square(0, 0, 100)], type: 2 }]))).toEqual([]);
  });
});
