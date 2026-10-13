// График профиля трассы: рельеф с учётом кривизны Земли, линия визирования, 1-я зона Френеля и её 60 %.
import type { LinkResult } from './radio';
import { fixed } from './format';

export function drawProfile(cv: HTMLCanvasElement, r: LinkResult, labels: { a: string; b: string }) {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const col = (n: string) => css.getPropertyValue(n).trim();
  // Шрифты и цвета — из CSS-переменных темы (styles/theme.css), поэтому график следует Дневной/Ночной теме.
  const mono = col('--font-mono') || 'ui-monospace, Menlo, monospace';
  const ui = col('--font-ui') || 'system-ui, sans-serif';

  const n = r.d.length - 1, D = r.dist;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= n; i++) {
    lo = Math.min(lo, r.ground[i], r.los_h[i] - r.fz[i]);
    hi = Math.max(hi, r.ground[i], r.los_h[i] + r.fz[i]);
  }
  const pad = (hi - lo) * 0.08 + 5;
  lo -= pad; hi += pad;
  const L = 48, Rt = 10, T = 12, B = 24;
  const X = (d: number) => L + ((W - L - Rt) * d) / D;
  const Y = (h: number) => T + ((H - T - B) * (hi - h)) / (hi - lo);

  // сетка
  ctx.strokeStyle = col('--grid'); ctx.fillStyle = col('--muted');
  ctx.font = `12px ${mono}`; ctx.lineWidth = 1;
  const stepH = niceStep((hi - lo) / 4), stepD = niceStep(D / 6);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let h = Math.ceil(lo / stepH) * stepH; h <= hi; h += stepH) {
    ctx.beginPath(); ctx.moveTo(L, Y(h)); ctx.lineTo(W - Rt, Y(h)); ctx.stroke();
    ctx.fillText(`${Math.round(h)}`, L - 4, Y(h));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let d = 0; d <= D + 1; d += stepD) {
    ctx.beginPath(); ctx.moveTo(X(d), T); ctx.lineTo(X(d), H - B); ctx.stroke();
    ctx.fillText(D > 2000 ? fixed(d / 1000, stepD < 1000 ? 1 : 0) : `${Math.round(d)}`, X(d), H - B + 5);
  }
  ctx.textAlign = 'left';
  ctx.fillText(D > 2000 ? 'км' : 'м', W - Rt - 14, H - B + 5);

  // зона Френеля
  const band = (k: number, fill: string) => {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) ctx.lineTo(X(r.d[i]), Y(r.los_h[i] + r.fz[i] * k));
    for (let i = n; i >= 0; i--) ctx.lineTo(X(r.d[i]), Y(r.los_h[i] - r.fz[i] * k));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  band(1, col('--fresnel'));
  band(0.6, col('--fresnel60'));

  // рельеф
  ctx.beginPath(); ctx.moveTo(X(0), H - B);
  for (let i = 0; i <= n; i++) ctx.lineTo(X(r.d[i]), Y(r.ground[i]));
  ctx.lineTo(X(D), H - B); ctx.closePath();
  const grad = ctx.createLinearGradient(0, T, 0, H - B);
  grad.addColorStop(0, col('--terrain-top')); grad.addColorStop(1, col('--terrain-bot'));
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = col('--terrain-line'); ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) ctx.lineTo(X(r.d[i]), Y(r.ground[i]));
  ctx.stroke();

  // участки, где рельеф лезет в 60 % зоны / перекрывает луч
  for (let i = 1; i < n; i++) {
    const clr = r.los_h[i] - r.ground[i];
    if (clr < 0.6 * r.fz[i]) {
      ctx.fillStyle = clr < 0 ? col('--none') : col('--weak');
      ctx.fillRect(X(r.d[i]) - 1, Y(r.ground[i]) - 1, 2.5, 3);
    }
  }

  // линия визирования
  ctx.strokeStyle = col('--chart-los') || col('--accent'); ctx.lineWidth = 2;
  ctx.setLineDash(r.los ? [] : [6, 4]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(r.los_h[0])); ctx.lineTo(X(D), Y(r.los_h[n])); ctx.stroke();
  ctx.setLineDash([]);

  // препятствия, учтённые в дифракции
  ctx.fillStyle = col('--none');
  for (const i of r.edges) {
    ctx.beginPath(); ctx.moveTo(X(r.d[i]), Y(r.ground[i]) - 9); ctx.lineTo(X(r.d[i]) - 5, Y(r.ground[i]) - 17); ctx.lineTo(X(r.d[i]) + 5, Y(r.ground[i]) - 17); ctx.fill();
  }

  // антенны
  const mast = (d: number, g: number, h: number, t: string, align: CanvasTextAlign) => {
    ctx.strokeStyle = col('--text'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(d), Y(g)); ctx.lineTo(X(d), Y(h)); ctx.stroke();
    ctx.fillStyle = col('--accent'); ctx.beginPath(); ctx.arc(X(d), Y(h), 4, 0, 7); ctx.fill();
    ctx.fillStyle = col('--text'); ctx.textAlign = align; ctx.textBaseline = 'bottom';
    ctx.font = `600 13px ${ui}`;
    ctx.fillText(t, X(d) + (align === 'left' ? 6 : -6), Y(h) - 4);
  };
  mast(0, r.ground[0], r.los_h[0], labels.a, 'left');
  mast(D, r.ground[n], r.los_h[n], labels.b, 'right');
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p;
}
