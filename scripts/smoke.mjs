// Дымовой тест в headless Chrome через DevTools Protocol (без зависимостей).
// Запуск: node scripts/smoke.mjs [url] [outDir]. Нужен запущенный dev-сервер.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'http://localhost:5174/';
const OUT = process.argv[3] || process.env.TMPDIR || '/tmp';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'uavmap-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1200,800', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const f = join(OUT, `smoke-${name}.png`);
  writeFileSync(f, Buffer.from(data, 'base64'));
  return f;
};
const waitFor = async (expr, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); }
  throw new Error(`timeout: ${expr}`);
};

const results = [];
const step = async (name, fn) => {
  try { const v = await fn(); results.push(`✓ ${name}${v ? ` — ${v}` : ''}`); }
  catch (e) { results.push(`✗ ${name} — ${e.message}`); }
};

try {
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch { /* ждём */ }
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id).res(d.result || {}); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description?.split('\n')[0]);
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  await send('Runtime.enable');
  await send('Page.enable');
  // Чистый проект и район с рельефом (Красная Поляна).
  await send('Page.navigate', { url: URL_ });
  await sleep(500);
  await ev(`localStorage.clear(); true`);
  await send('Page.navigate', { url: URL_ });

  await step('карта загрузилась', () => waitFor(`!!window.__map && window.__map.isStyleLoaded()`));
  await step('высота в плашке', async () => { await waitFor(`/\\d/.test(document.getElementById('hereH').textContent)`); return ev(`document.getElementById('hereH').textContent + ' м'`); });
  await shot('1-start');

  await step('поставить пульт (Проверить связь)', async () => {
    await ev(`document.getElementById('btnLink').click(); true`);
    await waitFor(`!document.getElementById('linkStrip').hidden`);
    await waitFor(`/запас|рельеф|Прицел на пульте/.test(document.getElementById('lsStatus').textContent)`);
  });
  await step('связь до креста после сдвига 3 км на северо-восток', async () => {
    await ev(`(() => { const m = window.__map, c = m.getCenter(); m.jumpTo({ center: [c.lng + 0.03, c.lat + 0.02] }); return true; })()`);
    await waitFor(`/запас/.test(document.getElementById('lsStatus').textContent)`);
    return ev(`document.getElementById('lsStatus').textContent`);
  });
  await shot('2-link');

  await step('профиль трассы', async () => {
    await ev(`document.getElementById('btnProfile').click(); true`);
    await waitFor(`!document.getElementById('sheet').hidden && !!document.getElementById('profileCanvas')`);
    return ev(`document.querySelector('#shBody .verdict')?.textContent`);
  });
  await shot('3-profile');

  await step('зона покрытия 10 км', async () => {
    await ev(`document.querySelector('[data-ls="zone"]').click(); true`);
    await sleep(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#shBody button')]; b.find(x => x.textContent.trim() === '10 км')?.click(); b.find(x => /Рассчитать/.test(x.textContent))?.click(); return true; })()`);
    const t0 = Date.now();
    await waitFor(`!!window.__map.getLayer('cov-raster')`, 60000);
    return `${((Date.now() - t0) / 1000).toFixed(1)} с, строк в таблице: ${await ev(`document.querySelectorAll('#shBody table.rt tr').length - 1`)}`;
  });
  await sleep(800);
  await shot('4-coverage');
  await ev(`(() => { document.getElementById('shClose').click(); const s = document.querySelector('.station'); window.__map.jumpTo({ zoom: 11.3 }); return true; })()`);
  await ev(`(() => { const st = JSON.parse(localStorage.getItem('radius.project.v1') || '{}').station; if (st) window.__map.jumpTo({ center: [st.lon, st.lat] }); return true; })()`);
  await sleep(2500);
  await shot('4b-coverage-map');

  await step('метка и меню', async () => {
    await ev(`document.getElementById('btnMark').click(); true`);
    await waitFor(`document.querySelectorAll('.mk').length > 0`);
    await ev(`document.getElementById('shClose').click(); document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    await ev(`[...document.querySelectorAll('.dr-item')].find(b => /Расчёт/.test(b.textContent)).click(); true`);
    return `пунктов в «Расчёт»: ${await ev(`document.querySelectorAll('#drBody input, #drBody .li').length`)}`;
  });
  await shot('5-menu');
  await step('сохранение после перезагрузки', async () => {
    await sleep(500);
    await send('Page.reload');
    await waitFor(`!!window.__map && window.__map.isStyleLoaded()`);
    await waitFor(`document.querySelectorAll('.mk').length > 0 && !!document.querySelector('.station')`);
  });
} catch (e) {
  results.push(`✗ сбой сценария — ${e.message}`);
} finally {
  console.log(results.join('\n'));
  console.log(errors.length ? `Ошибки консоли (${errors.length}):\n  ${[...new Set(errors)].slice(0, 8).join('\n  ')}` : 'Ошибок в консоли нет');
  console.log(`Скриншоты: ${OUT}/smoke-*.png`);
  ws?.close();
  chrome.kill();
  process.exit(results.some((r) => r.startsWith('✗')) || errors.length ? 1 : 0);
}
