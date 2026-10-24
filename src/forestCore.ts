// Лес: разбор векторного тайла OpenMapTiles без DOM и карты (тестируется в node). Загрузка и маски — forest.ts.
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';

/** Контуры леса тайла: кольца в долях тайла (0..1), по 2 числа на точку. */
export type Rings = Float32Array[];
/** Кольца полигонов леса (landcover, class = wood) из тела тайла MVT. Порядок обхода — как в тайле (для nonzero). */
export function woodRings(buf: ArrayBuffer): Rings {
  const out: Rings = [];
  if (!buf.byteLength) return out;
  const layer = new VectorTile(new Pbf(buf)).layers.landcover;
  if (!layer) return out;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3 || f.properties.class !== 'wood') continue;
    const ext = f.extent || 4096;
    for (const ring of f.loadGeometry()) {
      if (ring.length < 3) continue;
      const a = new Float32Array(ring.length * 2);
      ring.forEach((pt, k) => { a[2 * k] = pt.x / ext; a[2 * k + 1] = pt.y / ext; });
      out.push(a);
    }
  }
  return out;
}
