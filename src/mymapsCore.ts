// Свои карты: чистая логика (проверка PMTiles, метаданные) — без DOM и карты, чтобы тестировать в node.
import type { Header } from 'pmtiles';
import { inRange } from './validate';

export const PM_MAX_BYTES = 2 * 1024 ** 3;
export const PM_HEADER_BYTES = 127;
export const META_KEY = 'uavmap.mymaps.v1';
export const MAX_ITEMS = 50;

export interface MyMapItem {
  id: string;
  kind: 'pmtiles' | 'mbtiles' | 'hgt' | 'tif';
  name: string;
  size: number;
  added: number;
  /** Имя файла в OPFS: <id>.<kind>. */
  file: string;
  /** [запад, юг, восток, север] */
  bounds: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
}

export interface PmInfo { bounds: [number, number, number, number]; minzoom: number; maxzoom: number; tileType: 'png' | 'jpg' | 'webp' }

const ID_RE = /^[a-z0-9]{6,16}$/;
export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
export const cleanName = (s: string) => [...s].filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127 && c !== '<' && c !== '>').join('').trim().slice(0, 80);

/** Типы тайлов в заголовке PMTiles v3 (TileType из pmtiles; сама библиотека грузится лениво). */
const TT_MVT = 1, TT_PNG = 2, TT_JPEG = 3, TT_WEBP = 4;

/**
 * Проверка PMTiles v3 с растровыми тайлами по первым 127 байтам и размеру файла.
 * parseHeader — bytesToHeader из pmtiles: библиотеку подгружает вызывающий (отдельный чанк).
 */
export function checkPmtiles(head: ArrayBuffer, fileSize: number, parseHeader: (b: ArrayBuffer) => Header): { ok: true; info: PmInfo } | { ok: false; error: string } {
  if (fileSize > PM_MAX_BYTES) return { ok: false, error: 'Файл больше 2 ГБ' };
  if (head.byteLength < PM_HEADER_BYTES || fileSize < PM_HEADER_BYTES) return { ok: false, error: 'Файл слишком мал для PMTiles' };
  const b = new Uint8Array(head);
  if (String.fromCharCode(...b.subarray(0, 7)) !== 'PMTiles') return { ok: false, error: 'Это не PMTiles (нет сигнатуры)' };
  if (b[7] !== 3) return { ok: false, error: `Поддерживается только PMTiles версии 3 (в файле: ${b[7]})` };
  let h;
  try { h = parseHeader(head.slice(0, PM_HEADER_BYTES)); } catch { return { ok: false, error: 'Повреждённый заголовок PMTiles' }; }
  if (h.tileType === TT_MVT) return { ok: false, error: 'Векторные PMTiles не поддерживаются — нужны растровые (png/jpg/webp)' };
  const type = h.tileType === TT_PNG ? 'png' : h.tileType === TT_JPEG ? 'jpg' : h.tileType === TT_WEBP ? 'webp' : null;
  if (!type) return { ok: false, error: 'Тип тайлов не png/jpg/webp (AVIF и прочие не поддерживаются)' };
  if (h.tileCompression > 1) return { ok: false, error: 'Тайлы сжаты (gzip и т.п.) — нужны несжатые растровые тайлы' };
  const inFile = (off: number, len: number) => Number.isFinite(off) && Number.isFinite(len) && off >= 0 && len >= 0 && off + len <= fileSize;
  if (!inFile(h.rootDirectoryOffset, h.rootDirectoryLength) || !inFile(h.tileDataOffset, h.tileDataLength ?? 0) || !inFile(h.leafDirectoryOffset, h.leafDirectoryLength ?? 0)) {
    return { ok: false, error: 'Заголовок указывает за пределы файла (файл обрезан или повреждён)' };
  }
  const { minLon: w, minLat: s, maxLon: e, maxLat: n, minZoom: z0, maxZoom: z1 } = h;
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
    // границы не заданы/мусор — берём весь мир, это не повод отвергать файл
    return finish(type, [-180, -85.05, 180, 85.05], z0, z1);
  }
  return finish(type, [w, s, e, n], z0, z1);
}

function finish(tileType: PmInfo['tileType'], bounds: PmInfo['bounds'], z0: number, z1: number): { ok: true; info: PmInfo } | { ok: false; error: string } {
  if (!Number.isInteger(z0) || !Number.isInteger(z1) || z0 < 0 || z1 > 24 || z0 > z1) return { ok: false, error: 'Некорректный диапазон зума в заголовке' };
  return { ok: true, info: { bounds, minzoom: z0, maxzoom: z1, tileType } };
}

const num = (v: unknown, lo: number, hi: number): number | null => (inRange(v, lo, hi) ? v : null);

/** Разбор сохранённых метаданных: невалидные записи отбрасываются, формат не доверяется. */
export function parseMeta(raw: string | null): MyMapItem[] {
  if (!raw) return [];
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  if (!j || typeof j !== 'object' || (j as { v?: unknown }).v !== 1 || !Array.isArray((j as { items?: unknown }).items)) return [];
  const out: MyMapItem[] = [];
  const seen = new Set<string>();
  for (const r of (j as { items: unknown[] }).items) {
    if (out.length >= MAX_ITEMS) break;
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const kind = o.kind === 'pmtiles' || o.kind === 'mbtiles' || o.kind === 'hgt' || o.kind === 'tif' ? o.kind : null;
    if (!kind || typeof o.id !== 'string' || !ID_RE.test(o.id) || seen.has(o.id) || typeof o.name !== 'string') continue;
    if (o.file !== `${o.id}.${kind}`) continue;
    const size = num(o.size, 0, PM_MAX_BYTES), added = num(o.added, 0, 1e14);
    const b = Array.isArray(o.bounds) && o.bounds.length === 4 ? o.bounds.map((x, i) => num(x, i % 2 ? -90 : -180, i % 2 ? 90 : 180)) : null;
    if (size === null || added === null || !b || b.some((x) => x === null)) continue;
    const [w, s, e, n] = b as number[];
    if (w >= e || s >= n) continue;
    const item: MyMapItem = { id: o.id, kind, name: cleanName(o.name) || o.id, size, added, file: o.file as string, bounds: [w, s, e, n] };
    if (kind === 'pmtiles' || kind === 'mbtiles') {
      const z0 = num(o.minzoom, 0, 24), z1 = num(o.maxzoom, 0, 24);
      if (z0 === null || z1 === null || !Number.isInteger(z0) || !Number.isInteger(z1) || z0 > z1) continue;
      item.minzoom = z0; item.maxzoom = z1;
    }
    seen.add(o.id);
    out.push(item);
  }
  return out;
}

export const serializeMeta = (items: MyMapItem[]) => JSON.stringify({ v: 1, items });

export function fmtBounds(b: [number, number, number, number]): string {
  const f = (v: number) => v.toFixed(2);
  return `${f(b[1])}…${f(b[3])}° с.ш., ${f(b[0])}…${f(b[2])}° в.д.`;
}

/** Источник байтов: срез файла (свои карты читаются кусками, не целиком). Отдельно от File — чтобы тестировать на буфере. */
export interface ByteSource { size: number; read(offset: number, length: number): Promise<ArrayBuffer> }

export const blobSource = (b: Blob): ByteSource => ({
  size: b.size,
  // Blob.arrayBuffer() — только с Chrome 76, пульты на Chrome 68.
  read: (o, n) => new Response(b.slice(o, o + n)).arrayBuffer(),
});
