// Воркер зоны покрытия: обёртка над computeCoverage.
import { computeCoverage, CoverageJob } from './coverageCore';

self.onmessage = (e: MessageEvent<CoverageJob>) => {
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const res = computeCoverage(e.data, (progress) => post({ progress }));
    post({ done: res }, [res.margins.buffer, res.firstLoss.buffer]);
  } catch (err) {
    post({ error: err instanceof Error ? err.message : String(err) });
  }
};
