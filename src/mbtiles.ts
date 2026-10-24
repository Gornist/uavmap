// MBTiles без конвертации: файл — база SQLite, читаем её сами, только нужные страницы (Blob.slice), без загрузки
// целиком в память и без SQLite-WASM. Поддержаны обе распространённые схемы:
//   - таблица tiles(zoom_level, tile_column, tile_row, tile_data) с индексом по (zoom_level, tile_column, tile_row);
//   - дедуплицированная (mb-util, TileMill): map(zoom_level, tile_column, tile_row, tile_id) + images(tile_data, tile_id)
//     с индексами по (zoom_level, tile_column, tile_row) и по tile_id; tiles — представление.
// Только чтение; без индекса (полный перебор многогигабайтной базы на пульте неподъёмен) — понятный отказ.
// Формат: https://www.sqlite.org/fileformat2.html; строка тайла — в схеме TMS (ось Y снизу).

import type { ByteSource } from './mymapsCore';
export type { ByteSource } from './mymapsCore';

type Value = number | string | Uint8Array | null;

export interface MbInfo {
  format: 'png' | 'jpg' | 'webp';
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  name: string;
}

const MAGIC = 'SQLite format 3\0';
const PAGE_CACHE = 64; // страниц в памяти (по 4–64 КБ)
/** Предел одной записи (тайл, строка метаданных), байт. */
const MAX_RECORD = 64 * 1024 * 1024;

/** Поиск тайла: (z, x, y по TMS) → данные тайла или null. */
type Finder = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

export class MbTiles {
  private cache = new Map<number, Promise<DataView>>();
  private finder: Finder | null = null;
  info!: MbInfo;

  private constructor(private src: ByteSource, private ps: number, private usable: number) {}

  /** Открыть и проверить: заголовок SQLite, схема, индексы, метаданные. Бросает Error с понятным текстом. */
  static async open(src: ByteSource): Promise<MbTiles> {
    if (src.size < 512) throw new Error('Файл слишком мал для MBTiles');
    const h = new DataView(await src.read(0, 100));
    let magic = '';
    for (let i = 0; i < 16; i++) magic += String.fromCharCode(h.getUint8(i));
    if (magic !== MAGIC) throw new Error('Это не MBTiles (не база SQLite)');
    const raw = h.getUint16(16);
    const ps = raw === 1 ? 65536 : raw;
    if (ps < 512 || ps > 65536 || (ps & (ps - 1))) throw new Error('Повреждённый заголовок базы (размер страницы)');
    if (h.getUint32(56) > 1) throw new Error('База в кодировке UTF-16 — не поддерживается');
    const db = new MbTiles(src, ps, ps - h.getUint8(20));
    await db.init();
    return db;
  }

  // ---------- Страницы и B-деревья ----------
  private page(n: number): Promise<DataView> {
    let p = this.cache.get(n);
    if (p) { this.cache.delete(n); this.cache.set(n, p); return p; }
    if (n < 1 || (n - 1) * this.ps >= this.src.size) return Promise.reject(new Error('Повреждённая база: ссылка за конец файла'));
    p = this.src.read((n - 1) * this.ps, this.ps).then((b) => new DataView(b));
    p.catch(() => this.cache.delete(n));
    this.cache.set(n, p);
    while (this.cache.size > PAGE_CACHE) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  /** Полное содержимое ячейки (с переполнением). local — сколько байт лежит на самой странице. */
  private async payload(dv: DataView, off: number, size: number, isTable: boolean): Promise<Uint8Array> {
    // Длина — из файла (недоверенного): больше самого файла или предела записи — повреждение, память не выделяем.
    if (size > this.src.size || size > MAX_RECORD) throw new Error('Повреждённая база: запись больше файла');
    const U = this.usable;
    const X = isTable ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
    const out = new Uint8Array(size);
    if (size <= X) { out.set(new Uint8Array(dv.buffer, dv.byteOffset + off, size)); return out; }
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;
    out.set(new Uint8Array(dv.buffer, dv.byteOffset + off, local));
    let next = dv.getUint32(off + local), done = local, guard = 0;
    while (done < size) {
      if (!next || ++guard > 1e6) throw new Error('Повреждённая база: цепочка переполнения');
      const p = await this.page(next);
      const n = Math.min(U - 4, size - done);
      out.set(new Uint8Array(p.buffer, p.byteOffset + 4, n), done);
      done += n;
      next = p.getUint32(0);
    }
    return out;
  }

  /** Заголовок страницы B-дерева: тип, число ячеек, правый потомок, начало массива указателей. */
  private head(dv: DataView, n: number) {
    const b = n === 1 ? 100 : 0;
    const type = dv.getUint8(b);
    if (type !== 2 && type !== 5 && type !== 10 && type !== 13) throw new Error('Повреждённая база: неизвестный тип страницы');
    const leaf = type === 10 || type === 13;
    return { type, leaf, cells: dv.getUint16(b + 3), right: leaf ? 0 : dv.getUint32(b + 8), ptr: b + (leaf ? 8 : 12) };
  }

  /** Строка таблицы по rowid (поиск по B-дереву таблицы) или null. */
  private async row(root: number, rowid: number): Promise<Value[] | null> {
    let pn = root;
    for (let depth = 0; depth < 64; depth++) {
      const dv = await this.page(pn);
      const hd = this.head(dv, pn);
      if (hd.type !== 5 && hd.type !== 13) throw new Error('Повреждённая база: ожидалась таблица');
      if (hd.leaf) {
        let lo = 0, hi = hd.cells - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          let off = dv.getUint16(hd.ptr + mid * 2);
          const [size, a] = varint(dv, off); off += a;
          const [id, b] = varint(dv, off); off += b;
          if (id === rowid) return record(await this.payload(dv, off, size, true));
          if (id < rowid) lo = mid + 1; else hi = mid - 1;
        }
        return null;
      }
      // Внутренняя: ячейки (левый потомок, ключ); в левом потомке rowid ≤ ключа.
      let lo = 0, hi = hd.cells - 1, child = hd.right;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const off = dv.getUint16(hd.ptr + mid * 2);
        const [key] = varint(dv, off + 4);
        if (key >= rowid) { child = dv.getUint32(off); hi = mid - 1; } else lo = mid + 1;
      }
      pn = child;
    }
    throw new Error('Повреждённая база: слишком глубокое дерево');
  }

  /** Все строки таблицы (только для маленьких: sqlite_master, metadata). */
  private async scan(root: number, out: Value[][] = [], depth = 0): Promise<Value[][]> {
    if (depth > 64 || out.length > 10000) throw new Error('Повреждённая база: служебная таблица слишком велика');
    const dv = await this.page(root);
    const hd = this.head(dv, root);
    for (let i = 0; i < hd.cells; i++) {
      let off = dv.getUint16(hd.ptr + i * 2);
      if (hd.leaf) {
        const [size, a] = varint(dv, off); off += a;
        const [, b] = varint(dv, off); off += b;
        out.push(record(await this.payload(dv, off, size, true)));
      } else await this.scan(dv.getUint32(off), out, depth + 1);
    }
    if (!hd.leaf) await this.scan(hd.right, out, depth + 1);
    return out;
  }

  /**
   * Точный поиск по индексу: запись индекса = значения столбцов + rowid. key — значения столбцов (префикс записи).
   * В индексных B-деревьях записи лежат и во внутренних ячейках. Возвращает rowid или null.
   */
  private async seek(root: number, key: Value[]): Promise<number | null> {
    let pn = root;
    for (let depth = 0; depth < 64; depth++) {
      const dv = await this.page(pn);
      const hd = this.head(dv, pn);
      if (hd.type !== 2 && hd.type !== 10) throw new Error('Повреждённая база: ожидался индекс');
      // Первая ячейка с записью ≥ key (по префиксу key).
      let lo = 0, hi = hd.cells - 1, found = -1, rec: Value[] | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        let off = dv.getUint16(hd.ptr + mid * 2);
        if (!hd.leaf) off += 4;
        const [size, a] = varint(dv, off);
        const r = record(await this.payload(dv, off + a, size, false));
        const c = cmpKey(r, key);
        if (c >= 0) { found = mid; rec = r; hi = mid - 1; } else lo = mid + 1;
      }
      if (rec && cmpKey(rec, key) === 0) { const id = rec[rec.length - 1]; return typeof id === 'number' ? id : null; }
      if (hd.leaf) return null;
      pn = found >= 0 ? dv.getUint32(dv.getUint16(hd.ptr + found * 2)) : hd.right;
    }
    throw new Error('Повреждённая база: слишком глубокое дерево');
  }

  // ---------- Схема ----------
  private async init(): Promise<void> {
    const master = (await this.scan(1)).map((r) => ({ type: r[0], name: r[1], tbl: r[2], root: r[3], sql: typeof r[4] === 'string' ? r[4] : '' }));
    const table = (name: string) => master.find((m) => m.type === 'table' && String(m.name).toLowerCase() === name);
    const view = (name: string) => master.find((m) => m.type === 'view' && String(m.name).toLowerCase() === name);
    /** Индекс таблицы, чьи первые столбцы — cols (по порядку); у UNIQUE-ограничения — автоиндекс, его столбцы — из CREATE TABLE. */
    const index = (tbl: string, cols: string[]) => master.find((m) => {
      if (m.type !== 'index' || String(m.tbl).toLowerCase() !== tbl || typeof m.root !== 'number' || !m.root) return false;
      const ic = m.sql ? indexCols(m.sql) : uniqueCols(table(tbl)?.sql ?? '');
      return cols.every((c, i) => ic[i] === c);
    });
    const meta = table('metadata');
    const kv = new Map<string, string>();
    if (meta && typeof meta.root === 'number') {
      const mc = tableCols(meta.sql);
      const ni = mc.indexOf('name'), vi = mc.indexOf('value');
      for (const r of await this.scan(meta.root)) {
        const k = r[ni], v = r[vi];
        if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) kv.set(k.toLowerCase(), String(v));
      }
    }
    this.info = parseInfo(kv);

    const ZXY = ['zoom_level', 'tile_column', 'tile_row'];
    const tiles = table('tiles');
    if (tiles && typeof tiles.root === 'number') {
      if (/without\s+rowid/i.test(tiles.sql)) throw new Error('Таблица тайлов без rowid — не поддерживается; пересохраните файл (например, mb-util)');
      const ix = index('tiles', ZXY);
      if (!ix) throw new Error('В файле нет индекса тайлов — откройте его в sqlite3 и выполните: CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
      const di = tableCols(tiles.sql).indexOf('tile_data');
      if (di < 0) throw new Error('В таблице tiles нет столбца tile_data');
      const troot = tiles.root, iroot = ix.root as number;
      this.finder = async (z, x, y) => {
        const id = await this.seek(iroot, [z, x, y]);
        const r = id === null ? null : await this.row(troot, id);
        return r ? blobOf(r[di]) : null;
      };
      return;
    }
    const mapT = table('map'), images = table('images');
    if (view('tiles') && mapT && images && typeof mapT.root === 'number' && typeof images.root === 'number') {
      const mi = index('map', ZXY), ii = index('images', ['tile_id']);
      if (!mi || !ii) throw new Error('В файле нет индексов map/images — пересохраните его (mb-util)');
      const mcols = tableCols(mapT.sql), icols = tableCols(images.sql);
      const mid = mcols.indexOf('tile_id'), idata = icols.indexOf('tile_data');
      if (mid < 0 || idata < 0) throw new Error('Неизвестная схема map/images');
      const mroot = mapT.root, iroot = images.root, mix = mi.root as number, iix = ii.root as number;
      this.finder = async (z, x, y) => {
        const r1 = await this.seek(mix, [z, x, y]);
        const m = r1 === null ? null : await this.row(mroot, r1);
        const tid = m ? m[mid] : null;
        if (tid === null || tid === undefined) return null;
        const r2 = await this.seek(iix, [tid instanceof Uint8Array ? null : tid]);
        const im = r2 === null ? null : await this.row(iroot, r2);
        return im ? blobOf(im[idata]) : null;
      };
      return;
    }
    throw new Error('В файле нет таблицы тайлов (tiles или map/images) — это не MBTiles');
  }

  /** Тайл в схеме XYZ (как у карты): строка MBTiles — по TMS. null — тайла нет. */
  getZxy(z: number, x: number, y: number): Promise<Uint8Array | null> {
    return this.finder!(z, x, 2 ** z - 1 - y);
  }
}

// ---------- Разбор ----------

/** varint SQLite: [значение, длина]. До 9 байт; значения тайлов и rowid укладываются в 2^53. */
export function varint(dv: DataView, off: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    const b = dv.getUint8(off + i);
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) return [v, i + 1];
  }
  return [v * 256 + dv.getUint8(off + 8), 9];
}

/** Запись: заголовок (типы столбцов) и значения. */
export function record(p: Uint8Array): Value[] {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const [hs, a] = varint(dv, 0);
  const types: number[] = [];
  for (let o = a; o < hs;) { const [t, n] = varint(dv, o); types.push(t); o += n; }
  const out: Value[] = [];
  let o = hs;
  for (const t of types) {
    if (t === 0) out.push(null);
    else if (t >= 1 && t <= 6) {
      const n = [0, 1, 2, 3, 4, 6, 8][t];
      let v = dv.getInt8(o);
      for (let i = 1; i < n; i++) v = v * 256 + dv.getUint8(o + i);
      out.push(v); o += n;
    } else if (t === 7) { out.push(dv.getFloat64(o)); o += 8; }
    else if (t === 8 || t === 9) out.push(t - 8);
    else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; out.push(p.subarray(o, o + n)); o += n; }
    else if (t >= 13) { const n = (t - 13) / 2; out.push(utf8(p.subarray(o, o + n))); o += n; }
    else throw new Error('Повреждённая база: неизвестный тип значения');
  }
  return out;
}

const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const utf8 = (b: Uint8Array) => (dec ? dec.decode(b) : String.fromCharCode(...b));
const blobOf = (v: Value | undefined) => (v instanceof Uint8Array && v.length ? v.slice() : null);

/** Сравнение записи индекса с ключом по префиксу (порядок SQLite: NULL < числа < текст < BLOB; текст — побайтно). */
export function cmpKey(rec: Value[], key: Value[]): number {
  for (let i = 0; i < key.length; i++) {
    const a = rec[i] ?? null, b = key[i] ?? null;
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a === null || b === null) continue;
    if (typeof a === 'number' && typeof b === 'number') { if (a !== b) return a < b ? -1 : 1; continue; }
    const sa = typeof a === 'string' ? a : '', sb = typeof b === 'string' ? b : '';
    // Сравнение по кодам UTF-16 совпадает с побайтным UTF-8 для всех символов вне суррогатных пар — для tile_id хватает.
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return 0;
}
const rank = (v: Value) => (v === null ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);

const ident = (s: string) => s.trim().replace(/^["'`[]|["'`\]]$/g, '').toLowerCase();

/** Столбцы из CREATE TABLE по порядку (без ограничений таблицы). */
export function tableCols(sql: string): string[] {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  return splitTop(body)
    .map((d) => d.trim())
    .filter((d) => d && !/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(d))
    .map((d) => ident(d.split(/\s+/)[0]));
}

/**
 * Столбцы из CREATE INDEX … ON t (a, b, c). Поиск идёт по возрастанию и по всем строкам, поэтому индекс с DESC,
 * COLLATE или частичный (WHERE) не годится — тогда пустой список (индекс не используем).
 */
export function indexCols(sql: string): string[] {
  const m = /\(([^)]*)\)\s*(where\b.*)?$/is.exec(sql.trim());
  return m && !m[2] ? plainCols(m[1]) : [];
}

/**
 * Столбцы автоиндекса sqlite_autoindex_*: ограничение таблицы UNIQUE (…) / PRIMARY KEY (…) или столбец с UNIQUE /
 * PRIMARY KEY в своём описании («tile_id TEXT PRIMARY KEY»). INTEGER PRIMARY KEY — это rowid, автоиндекса у него нет.
 */
function uniqueCols(sql: string): string[] {
  const m = /(?:unique|primary\s+key)\s*\(([^)]*)\)/i.exec(sql);
  if (m) return plainCols(m[1]);
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  for (const d of splitTop(body)) {
    const w = d.trim().split(/\s+/);
    if (/\b(unique|primary\s+key)\b/i.test(d) && !/^integer$/i.test(w[1] ?? '') && !/\bdesc\b/i.test(d)) return [ident(w[0])];
  }
  return [];
}

/** «a, b, c» → столбцы; есть DESC или COLLATE — пустой список. */
function plainCols(list: string): string[] {
  const cols = list.split(',').map((c) => c.trim().split(/\s+/));
  if (cols.some((w) => w.length > 2 || (w.length === 2 && w[1].toLowerCase() !== 'asc'))) return [];
  return cols.map((w) => ident(w[0]));
}

/** Разбиение по запятым верхнего уровня (не внутри скобок). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Метаданные MBTiles: формат (только растр), границы, масштабы, название. */
export function parseInfo(kv: Map<string, string>): MbInfo {
  const f = (kv.get('format') || 'png').toLowerCase();
  const format = f === 'jpeg' ? 'jpg' : f;
  if (format === 'pbf' || format === 'mvt') throw new Error('Векторные MBTiles (pbf) не поддерживаются — нужна растровая карта (png, jpg, webp)');
  if (format !== 'png' && format !== 'jpg' && format !== 'webp') throw new Error(`Формат тайлов «${f}» не поддерживается — нужны png, jpg или webp`);
  let bounds: [number, number, number, number] = [-180, -85.0511, 180, 85.0511];
  const b = (kv.get('bounds') || '').split(',').map(Number);
  if (b.length === 4 && b.every(Number.isFinite) && b[0] < b[2] && b[1] < b[3] && b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90) bounds = b as typeof bounds;
  const z = (k: string, d: number) => { const v = Number(kv.get(k)); return Number.isInteger(v) && v >= 0 && v <= 24 ? v : d; };
  let minzoom = z('minzoom', 0), maxzoom = z('maxzoom', 18);
  if (minzoom > maxzoom) [minzoom, maxzoom] = [maxzoom, minzoom];
  return { format, bounds, minzoom, maxzoom, name: kv.get('name') || '' };
}
