import { describe, it, expect } from 'vitest';
// @ts-expect-error -- в проекте нет @types/node; тест выполняется vitest в node (как theme.test.ts)
import { createRequire } from 'node:module';
// @ts-expect-error -- то же
import { mkdtempSync, readFileSync } from 'node:fs';
// @ts-expect-error -- то же
import { tmpdir } from 'node:os';
// @ts-expect-error -- то же
import { join } from 'node:path';
import { MbTiles, ByteSource, tableCols, indexCols, parseInfo, cmpKey } from './mbtiles';

// Настоящие файлы SQLite собираем встроенным node:sqlite (Node ≥ 22.13); где его нет — тесты чтения пропускаются
// (видно в отчёте как skipped). require — потому что Vite отрезает префикс «node:» у import.
type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
let DatabaseSync: (new (path: string) => Db) | null = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const withSqlite = it.skipIf(!DatabaseSync);

const bufSource = (b: Uint8Array): ByteSource => ({
  size: b.length,
  read: async (o, n) => b.slice(o, o + n).buffer,
});

/** Тайл-заглушка: байты, по которым видно, какой это тайл; big — больше страницы (цепочка переполнения). */
function tile(z: number, x: number, y: number, big = false): Uint8Array {
  const n = big ? 9000 : 40;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (z * 31 + x * 7 + y * 3 + i) & 255;
  return b;
}

function build(schema: 'flat' | 'dedup', opts: { pageSize?: number; autoindex?: boolean; noIndex?: boolean; format?: string } = {}): Uint8Array {
  const path = join(mkdtempSync(join(tmpdir(), 'mbt-')), 't.mbtiles');
  const db = new DatabaseSync!(path);
  db.exec(`PRAGMA page_size = ${opts.pageSize ?? 1024}; PRAGMA journal_mode = DELETE;`);
  db.exec('CREATE TABLE metadata (name text, value text);');
  const md = db.prepare('INSERT INTO metadata VALUES (?, ?)');
  for (const [k, v] of [['name', 'Тест'], ['format', opts.format ?? 'png'], ['bounds', '37.5,55.5,37.9,55.9'], ['minzoom', '8'], ['maxzoom', '13']]) md.run(k, v);
  if (schema === 'flat') {
    db.exec(opts.autoindex
      ? 'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob, UNIQUE (zoom_level, tile_column, tile_row));'
      : 'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);');
    if (!opts.autoindex && !opts.noIndex) db.exec('CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
    const ins = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let z = 8; z <= 13; z++) for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) ins.run(z, x, y, tile(z, x, y, x === 5 && y === 7));
    db.exec('COMMIT');
  } else {
    db.exec('CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT);');
    db.exec('CREATE TABLE images (tile_data blob, tile_id text);');
    db.exec('CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row);');
    db.exec('CREATE UNIQUE INDEX images_id ON images (tile_id);');
    db.exec('CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id;');
    const im = db.prepare('INSERT INTO images VALUES (?, ?)'), mp = db.prepare('INSERT INTO map VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    // Дедупликация: у половины тайлов одна общая картинка.
    im.run(tile(0, 0, 0), 'same');
    for (let z = 10; z <= 12; z++) for (let x = 0; x < 40; x++) for (let y = 0; y < 40; y++) {
      if ((x + y) % 2) { mp.run(z, x, y, 'same'); continue; }
      const id = `t${z}-${x}-${y}`;
      im.run(tile(z, x, y, x === 4 && y === 6), id);
      mp.run(z, x, y, id);
    }
    db.exec('COMMIT');
  }
  db.close();
  return new Uint8Array(readFileSync(path));
}

/** Тайл по XYZ: строка MBTiles — по TMS (y снизу). */
const tms = (z: number, y: number) => 2 ** z - 1 - y;

describe('MBTiles: чтение без SQLite', () => {
  withSqlite('плоская схема: тайлы по (z, x, y), большой тайл через переполнение, нет — null', async () => {
    const db = await MbTiles.open(bufSource(build('flat')));
    expect(db.info).toEqual({ format: 'png', bounds: [37.5, 55.5, 37.9, 55.9], minzoom: 8, maxzoom: 13, name: 'Тест' });
    for (const [z, x, y] of [[8, 0, 0], [13, 29, 29], [11, 17, 3], [10, 5, 7]] as const) {
      expect(await db.getZxy(z, x, tms(z, y))).toEqual(tile(z, x, y, x === 5 && y === 7));
    }
    expect(await db.getZxy(13, 30, tms(13, 0))).toBeNull();
    expect(await db.getZxy(7, 0, 0)).toBeNull();
  });

  withSqlite('страница 4 КБ и автоиндекс UNIQUE', async () => {
    const db = await MbTiles.open(bufSource(build('flat', { pageSize: 4096, autoindex: true })));
    expect(await db.getZxy(12, 21, tms(12, 9))).toEqual(tile(12, 21, 9));
    expect(await db.getZxy(9, 5, tms(9, 7))).toEqual(tile(9, 5, 7, true));
  });

  withSqlite('дедуплицированная схема map/images', async () => {
    const db = await MbTiles.open(bufSource(build('dedup')));
    expect(await db.getZxy(11, 2, tms(11, 4))).toEqual(tile(11, 2, 4));
    expect(await db.getZxy(11, 3, tms(11, 4))).toEqual(tile(0, 0, 0)); // общая картинка
    expect(await db.getZxy(12, 4, tms(12, 6))).toEqual(tile(12, 4, 6, true));
    expect(await db.getZxy(12, 40, 0)).toBeNull();
  });

  withSqlite('images с «tile_id TEXT PRIMARY KEY» — автоиндекс столбца', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mbt-')), 'pk.mbtiles');
    const db = new DatabaseSync!(path);
    db.exec('PRAGMA page_size = 1024; CREATE TABLE metadata (name text, value text);');
    db.exec('CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT, UNIQUE (zoom_level, tile_column, tile_row));');
    db.exec('CREATE TABLE images (tile_id TEXT PRIMARY KEY, tile_data BLOB);');
    db.exec('CREATE VIEW tiles AS SELECT zoom_level, tile_column, tile_row, tile_data FROM map JOIN images USING (tile_id);');
    const im = db.prepare('INSERT INTO images VALUES (?, ?)'), mp = db.prepare('INSERT INTO map VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    for (let x = 0; x < 50; x++) for (let y = 0; y < 20; y++) { im.run(`k${x}-${y}`, tile(9, x, y)); mp.run(9, x, y, `k${x}-${y}`); }
    db.exec('COMMIT'); db.close();
    const r = await MbTiles.open(bufSource(new Uint8Array(readFileSync(path))));
    expect(await r.getZxy(9, 33, tms(9, 12))).toEqual(tile(9, 33, 12));
  });

  withSqlite('понятные отказы: без индекса, вектор, не SQLite', async () => {
    await expect(MbTiles.open(bufSource(build('flat', { noIndex: true })))).rejects.toThrow(/нет индекса/);
    await expect(MbTiles.open(bufSource(build('flat', { format: 'pbf' })))).rejects.toThrow(/Векторные/);
    await expect(MbTiles.open(bufSource(new Uint8Array(4096)))).rejects.toThrow(/не база SQLite/);
  });
});

describe('MBTiles: разбор схемы и метаданных', () => {
  it('столбцы таблицы и индекса', () => {
    expect(tableCols('CREATE TABLE tiles (zoom_level integer, "tile_column" integer, tile_row integer, tile_data blob, UNIQUE (zoom_level, tile_column, tile_row))'))
      .toEqual(['zoom_level', 'tile_column', 'tile_row', 'tile_data']);
    expect(indexCols('CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)')).toEqual(['zoom_level', 'tile_column', 'tile_row']);
  });
  it('метаданные: jpeg → jpg, кривые границы и масштабы — по умолчанию', () => {
    const i = parseInfo(new Map([['format', 'jpeg'], ['bounds', '10,20,5,30'], ['minzoom', '15'], ['maxzoom', 'x']]));
    expect(i.format).toBe('jpg');
    expect(i.bounds[0]).toBe(-180);
    expect([i.minzoom, i.maxzoom]).toEqual([15, 18]);
  });
  it('порядок ключей как в SQLite: NULL < числа < текст', () => {
    expect(cmpKey([1, 2, 3, 99], [1, 2, 3])).toBe(0);
    expect(cmpKey([1, 2, 4], [1, 2, 3])).toBeGreaterThan(0);
    expect(cmpKey([null], [0])).toBeLessThan(0);
    expect(cmpKey(['a'], [5])).toBeGreaterThan(0);
    expect(cmpKey(['t10'], ['t9'])).toBeLessThan(0);
  });
});

describe('MBTiles: индекс, по которому нельзя искать по возрастанию', () => {
  it('DESC, COLLATE и частичный индекс не используются', () => {
    expect(indexCols('CREATE INDEX i ON tiles (zoom_level DESC, tile_column, tile_row)')).toEqual([]);
    expect(indexCols('CREATE INDEX i ON tiles (zoom_level, tile_column, tile_row) WHERE zoom_level > 5')).toEqual([]);
    expect(indexCols('CREATE INDEX i ON tiles (zoom_level ASC, tile_column, tile_row)')).toEqual(['zoom_level', 'tile_column', 'tile_row']);
  });
});

describe('MBTiles: недоверенная длина записи', () => {
  withSqlite('длина ячейки больше файла — отказ, а не выделение гигабайт', async () => {
    const b = build('flat');
    // Первая ячейка sqlite_master на странице 1: указатель — по смещению 108; длина записи — varint в начале ячейки.
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const cell = dv.getUint16(108);
    b.set([0xff, 0xff, 0xff, 0x7f], cell); // ~268 Мб
    await expect(MbTiles.open(bufSource(b))).rejects.toThrow(/больше файла|Повреждённая/);
  });
});
