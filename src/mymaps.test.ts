import { describe, it, expect } from 'vitest';
import { checkPmtiles, parseMeta, serializeMeta, cleanName, PM_MAX_BYTES } from './mymapsCore';

/** Синтетический заголовок PMTiles v3 (127 байт). */
function header(o: { magic?: string; ver?: number; type?: number; comp?: number; z0?: number; z1?: number; bounds?: number[]; tileOff?: number; tileLen?: number } = {}) {
  const b = new ArrayBuffer(127), dv = new DataView(b), u = new Uint8Array(b);
  [...(o.magic ?? 'PMTiles')].forEach((c, i) => { u[i] = c.charCodeAt(0); });
  u[7] = o.ver ?? 3;
  dv.setBigUint64(8, 127n, true); dv.setBigUint64(16, 100n, true); // корневой каталог
  dv.setBigUint64(24, 227n, true); dv.setBigUint64(32, 10n, true); // метаданные
  dv.setBigUint64(40, 237n, true); dv.setBigUint64(48, 0n, true); // листья
  dv.setBigUint64(56, BigInt(o.tileOff ?? 237), true); dv.setBigUint64(64, BigInt(o.tileLen ?? 1000), true);
  u[96] = 1; u[97] = 1; u[98] = o.comp ?? 1; u[99] = o.type ?? 2; u[100] = o.z0 ?? 0; u[101] = o.z1 ?? 14;
  const bd = o.bounds ?? [37, 55, 38, 56];
  bd.forEach((v, i) => dv.setInt32(102 + i * 4, Math.round(v * 1e7), true));
  return b;
}

describe('PMTiles: проверка заголовка', () => {
  it('нормальный растровый архив', () => {
    const r = checkPmtiles(header(), 5000);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.info.bounds).toEqual([37, 55, 38, 56]); expect([r.info.minzoom, r.info.maxzoom, r.info.tileType]).toEqual([0, 14, 'png']); }
  });
  it('jpg и webp', () => {
    for (const [t, n] of [[3, 'jpg'], [4, 'webp']] as const) { const r = checkPmtiles(header({ type: t }), 5000); expect(r.ok && r.info.tileType).toBe(n); }
  });
  it('мусор вместо сигнатуры и чужая версия', () => {
    expect(checkPmtiles(header({ magic: 'PMTileX' }), 5000)).toMatchObject({ ok: false, error: expect.stringMatching(/сигнатур/) });
    expect(checkPmtiles(header({ ver: 2 }), 5000)).toMatchObject({ ok: false, error: expect.stringMatching(/версии 3/) });
    expect(checkPmtiles(new ArrayBuffer(50), 50)).toMatchObject({ ok: false });
    expect(checkPmtiles(new ArrayBuffer(127), 127)).toMatchObject({ ok: false });
  });
  it('векторные и прочие типы отвергаются', () => {
    expect(checkPmtiles(header({ type: 1 }), 5000)).toMatchObject({ ok: false, error: expect.stringMatching(/Векторные/) });
    expect(checkPmtiles(header({ type: 5 }), 5000)).toMatchObject({ ok: false });
    expect(checkPmtiles(header({ comp: 2 }), 5000)).toMatchObject({ ok: false });
  });
  it('размеры: >2 ГБ и смещения за файлом', () => {
    expect(checkPmtiles(header(), PM_MAX_BYTES + 1)).toMatchObject({ ok: false });
    expect(checkPmtiles(header({ tileLen: 1e9 }), 5000)).toMatchObject({ ok: false, error: expect.stringMatching(/за пределы/) });
  });
  it('мусорные границы → весь мир, мусорный зум → отказ', () => {
    const r = checkPmtiles(header({ bounds: [200, 55, 38, 56] }), 5000);
    expect(r.ok && r.info.bounds[0]).toBe(-180);
    expect(checkPmtiles(header({ z0: 10, z1: 5 }), 5000)).toMatchObject({ ok: false });
    expect(checkPmtiles(header({ z1: 40 }), 5000)).toMatchObject({ ok: false });
  });
});

describe('метаданные localStorage', () => {
  const good = { id: 'abc12345', kind: 'pmtiles', name: 'Карта', size: 10, added: 1, file: 'abc12345.pmtiles', bounds: [37, 55, 38, 56], minzoom: 0, maxzoom: 14 };
  const hgt = { id: 'hgt00001', kind: 'hgt', name: 'N55E037.hgt', size: 2884802, added: 2, file: 'hgt00001.hgt', bounds: [37, 55, 38, 56] };
  it('круг туда-обратно', () => {
    expect(parseMeta(serializeMeta([good, hgt] as never))).toEqual([good, hgt]);
  });
  it('мусор целиком', () => {
    for (const raw of [null, '', '{', 'null', '[]', '{"v":2,"items":[]}', '{"v":1,"items":5}', '"x"']) expect(parseMeta(raw)).toEqual([]);
  });
  it('невалидные записи отбрасываются, валидные остаются', () => {
    const items = [
      good, 5, null, 'x',
      { ...good, id: '../evil', file: '../evil.pmtiles' },
      { ...good, id: 'zzzzzz01', file: 'other.pmtiles' },
      { ...good, id: 'zzzzzz02', file: 'zzzzzz02.pmtiles', kind: 'exe' },
      { ...good, id: 'zzzzzz03', file: 'zzzzzz03.pmtiles', bounds: [1, 2, 3] },
      { ...good, id: 'zzzzzz04', file: 'zzzzzz04.pmtiles', bounds: [38, 55, 37, 56] },
      { ...good, id: 'zzzzzz05', file: 'zzzzzz05.pmtiles', size: -1 },
      { ...good, id: 'zzzzzz06', file: 'zzzzzz06.pmtiles', minzoom: 9, maxzoom: 3 },
      { ...good, id: 'zzzzzz07', file: 'zzzzzz07.pmtiles', name: 7 },
      good, // дубликат id
    ];
    const r = parseMeta(JSON.stringify({ v: 1, items }));
    expect(r.map((x) => x.id)).toEqual(['abc12345']);
  });
  it('имя очищается', () => {
    expect(cleanName('  <b>x</b>\u0000\n ')).toBe('bx/b');
    expect(cleanName('a'.repeat(300)).length).toBe(80);
  });
});
