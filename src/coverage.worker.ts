// Воркер зоны покрытия: считает части лучей (computeChunk) по запросам из coverageRun.ts.
// Один воркер обрабатывает очередь частей; у каждой — своя вырезка мозаики (передаётся, а не копируется).
import { computeChunk, CoverageChunk } from './coverageCore';

self.onmessage = (e: MessageEvent<{ id: number; chunk: CoverageChunk }>) => {
  const { id, chunk } = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const res = computeChunk(chunk, (progress) => post({ id, progress }));
    const tr: Transferable[] = [];
    for (const r of res) tr.push(r.margins.buffer, r.firstLoss.buffer);
    post({ id, done: res }, tr);
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
