// Дымовой тест в headless Chrome через DevTools Protocol (без зависимостей).
// Запуск: node scripts/smoke.mjs [url] [outDir] [--desktop|--mobile]. Нужен запущенный dev-сервер.
// По умолчанию два прогона подряд: десктоп и телефон (390×844, касания).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const URL_ = args[0] || 'http://localhost:5174/';
const OUT = args[1] || process.env.TMPDIR || '/tmp';
const MODES = flags.includes('--mobile') ? ['mobile'] : flags.includes('--desktop') ? ['desktop'] : ['desktop', 'mobile'];
let mode = 'desktop';
const LAND = flags.includes('--landscape'); // мобильный прогон 844×390
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
  const f = join(OUT, `smoke-${mode === 'mobile' ? 'm-' : ''}${name}.png`);
  writeFileSync(f, Buffer.from(data, 'base64'));
  return f;
};
const waitFor = async (expr, ms = 20000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); }
  throw new Error(`timeout: ${expr}`);
};


const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
const rectsCheck = `(() => {
  const vw = innerWidth, vh = innerHeight, bad = [];
  for (const b of document.querySelectorAll('button')) {
    const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
    if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
    if (r.width < 43.5 || r.height < 43.5) bad.push((b.id || b.className || b.textContent.trim()).toString().slice(0, 18) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return bad;
})()`;
const noScroll = `(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth ? '' : 'scrollWidth ' + document.documentElement.scrollWidth + ' > ' + innerWidth)()`;
const overlapCheck = `(() => {
  const ids = ['topLeft', 'infoCard', 'rightBar', 'linkStrip', 'bottomBar', 'cross'];
  const r = ids.map((id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const q = e.getBoundingClientRect(); return q.width ? [id, q] : null; }).filter(Boolean);
  const bad = [];
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
    const [n1, a] = r[i], [n2, b] = r[j];
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(n1 + '×' + n2);
  }
  return bad;
})()`;

const checkLayout = async (where) => {
  const sw = await ev(noScroll);
  if (sw) throw new Error(`${where}: горизонтальная прокрутка (${sw})`);
  if (mode === 'mobile') {
    const small = await ev(rectsCheck);
    if (small.length) throw new Error(`${where}: кнопки < 44 px: ${small.slice(0, 8).join(', ')}`);
  }
  return mode === 'mobile' ? 'без гор. прокрутки, кнопки ≥ 44 px' : 'без гор. прокрутки';
};

const results = [];
const step = async (name, fn) => {
  try { const v = await fn(); results.push(`✓ [${mode}] ${name}${v ? ` — ${v}` : ''}`); }
  catch (e) { results.push(`✗ [${mode}] ${name} — ${e.message}`); }
};

async function scenario() {
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
    await waitFor(`/Связь|грани|Нет |ниже рельефа|Считаю|рельеф|Прицел на пульте/.test(document.getElementById('lsStatus').textContent)`);
  });
  await step('связь до креста после сдвига 3 км на северо-восток', async () => {
    await ev(`(() => { const m = window.__map, c = m.getCenter(); m.jumpTo({ center: [c.lng + 0.03, c.lat + 0.02] }); return true; })()`);
    await waitFor(`/Упр\\.|Запас/.test(document.getElementById('lsStatus').textContent)`);
    const t = await ev(`document.getElementById('lsStatus').textContent`);
    if (!/[✓⚠✕]/.test(t) || !/км/.test(t)) throw new Error('нет вердикта со значком и дальности: ' + t);
    return t;
  });
  await step('строка связи показывает обе линии', async () => {
    // На этой трассе дрон на 100 м оказывается ниже рельефа (прочерки) — поднимаем его, чтобы увидеть запасы.
    await ev(`(() => { const i = document.getElementById('inDrone'); i.value = '1500'; i.dispatchEvent(new Event('input')); return true; })()`);
    await waitFor(`/Упр\\.\\s*[+−]\\d/.test(document.getElementById('lsStatus').textContent)`);
    const t = await ev(`document.getElementById('lsStatus').textContent`);
    if (!/Упр\.\s*[+−]\d/.test(t) || !/Видео\s*[+−]\d/.test(t)) throw new Error('нет обеих линий: ' + t);
    const big = await ev(`document.querySelector('#lsStatus .verdict-big')?.className || ''`);
    if (!/status-(ok|weak|none)/.test(big)) throw new Error('у вердикта нет класса статуса: ' + big);
    const hl = await ev(`document.getElementById('hereLink').textContent`);
    if (!/До пульта.*[✓⚠✕]/.test(hl)) throw new Error('плашка «До пульта» без вердикта: ' + hl);
    return t;
  });
  await shot('2-link');

  await step('профиль трассы', async () => {
    await ev(`document.getElementById('btnProfile').click(); true`);
    await waitFor(`!document.getElementById('sheet').hidden && !!document.getElementById('profileCanvas')`);
    return ev(`document.querySelector('#shBody .verdict')?.textContent`);
  });
  await shot('3-profile');

  await step('профиль: вердикт, объяснение, 3 цифры и таблицы по обеим линиям в «Подробнее»', async () => {
    const v = await ev(`document.querySelector('#shBody .verdict')?.textContent || ''`);
    if (!/[✓⚠✕]/.test(v)) throw new Error('вердикт без значка: ' + v);
    const why = await ev(`document.querySelector('#shBody .verdict-why')?.textContent || ''`);
    if (why.length < 10) throw new Error('нет объяснения вердикта');
    const keys = await ev(`document.querySelectorAll('#shBody .kv-key > div').length`);
    if (keys !== 3) throw new Error('ключевых цифр не 3: ' + keys);
    if (await ev(`[...document.querySelectorAll('#shBody details.details')].some(d => d.open)`)) throw new Error('«Подробнее» раскрыто по умолчанию');
    await ev(`document.querySelectorAll('#shBody details.details').forEach(d => d.open = true); true`);
    if (!(await ev(`!!document.getElementById('tblPV') && [...document.querySelectorAll('#tblH th')].some(t => /Видео/.test(t.textContent))`))) throw new Error('нет колонки/таблицы видео');
    if (!(await ev(`/Упр\\./.test(document.querySelector('#shBody details .kv')?.textContent || '') || /упр\\./.test(document.querySelector('#shBody details .kv')?.textContent || '')`))) throw new Error('в «Подробнее» нет данных по управлению');
    return `${v} — ${why}`;
  });
  await ev(`(() => { const i = document.getElementById('inDrone'); i.value = '100'; i.dispatchEvent(new Event('input')); return true; })()`);
  await step('зона покрытия 10 км', async () => {
    await ev(`document.querySelector('[data-ls="zone"]').click(); true`);
    await sleep(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#shBody button')]; b.find(x => x.textContent.trim() === '10 км')?.click(); b.find(x => /Рассчитать/.test(x.textContent))?.click(); return true; })()`);
    const t0 = Date.now();
    await waitFor(`!!window.__map.getLayer('cov-raster')`, 60000);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    await waitFor(`/Связь держится до/.test(document.querySelector('#shBody .cov-result')?.textContent || '')`, 5000);
    const sum = await ev(`document.querySelector('#shBody .cov-result').textContent`);
    // Таблица — в свёрнутом «Подробнее»: раскрываем, как пользователь.
    await ev(`(() => { const d = [...document.querySelectorAll('#shBody details.details')].find(x => /Подробнее/.test(x.querySelector('summary').textContent)); if (d) d.open = true; return true; })()`);
    const hdr = await ev(`[...document.querySelectorAll('#shBody details[open] table.rt th')].map(t => t.textContent).join('|')`);
    if (!/Видео/.test(hdr)) throw new Error('в таблице зоны нет колонки «Видео»: ' + hdr);
    return `${sec} с, «${sum}», строк в таблице: ${await ev(`document.querySelectorAll('#shBody table.rt tr').length - 1`)}, колонки: ${hdr}`;
  });
  await sleep(800);
  await shot('4-coverage');
  await ev(`(() => { document.getElementById('shClose').click(); const s = document.querySelector('.station'); window.__map.jumpTo({ zoom: 11.3 }); return true; })()`);
  await ev(`(() => { const st = JSON.parse(localStorage.getItem('radius.project.v1') || '{}').station; if (st) window.__map.jumpTo({ center: [st.lon, st.lat] }); return true; })()`);
  await sleep(2500);
  await shot('4b-coverage-map');

  await step('нет перекрытий и размеры нажатия (строка связи открыта)', async () => {
    await ev(`document.getElementById('shClose').click(); true`);
    await ev(`document.getElementById('linkStrip').hidden || true`);
    const ov = mode === 'mobile' ? await ev(overlapCheck) : [];
    if (ov.length) throw new Error('перекрытия: ' + ov.join(', '));
    return checkLayout('карта');
  });
  await step('метка и меню', async () => {
    await ev(`document.getElementById('btnMark').click(); true`);
    await waitFor(`document.querySelectorAll('.mk').length > 0`);
    await ev(`document.getElementById('shClose').click(); document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    await ev(`[...document.querySelectorAll('.dr-item')].find(b => /Расчёт/.test(b.textContent)).click(); true`);
    return `пунктов в «Расчёт»: ${await ev(`document.querySelectorAll('#drBody input, #drBody .li').length`)}`;
  });
  await step('меню: нет прокрутки и кнопки ≥ 44 px', () => checkLayout('меню'));
  await shot('5-menu');
  await step('тема: переключатель День / Ночь / Авто в настройках', async () => {
    await ev(`document.querySelector('.dr-back')?.click(); true`);
    await ev(`[...document.querySelectorAll('.dr-item')].find(b => /Настройки/.test(b.textContent)).click(); true`);
    const pick = (t) => ev(`(() => { const b = [...document.querySelectorAll('#drBody .seg button')].find(x => x.textContent.trim() === '${t}'); if (!b) return false; b.click(); return true; })()`);
    if (!(await pick('Ночь'))) throw new Error('нет кнопки «Ночь»');
    await sleep(300);
    const night = await ev(`document.documentElement.dataset.theme`);
    await pick('День'); await sleep(300);
    const day = await ev(`document.documentElement.dataset.theme`);
    await pick('Авто');
    if (night !== 'night' || day !== 'day') throw new Error(`data-theme: ${night} / ${day}`);
    return 'night → day → авто';
  });

  if (mode === 'mobile') {
    await ev(`document.getElementById('drClose').click(); true`);
    await sleep(400);
    await step('долгое нажатие открывает шторку «Точка»', async () => {
      await ev(`document.getElementById('shClose').click(); true`);
      const px = await ev(`innerWidth / 2`);
      await touch('touchStart', px, 110);
      await sleep(900);
      await touch('touchEnd');
      await waitFor(`!document.getElementById('sheet').hidden && document.getElementById('shTitle').textContent === 'Точка'`, 3000);
      await sleep(400);
      await shot('6-point');
      return checkLayout('шторка');
    });
    if (!LAND) await step('свайп вниз по ручке закрывает шторку', async () => {
      const g = await ev(`(() => { const r = document.getElementById('shGrip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
      await touch('touchStart', g[0], g[1]);
      for (let i = 1; i <= 8; i++) { await touch('touchMove', g[0], g[1] + i * 25); await sleep(20); }
      await touch('touchEnd');
      await waitFor(`document.getElementById('sheet').hidden`, 3000);
    });
    if (LAND) await ev(`document.getElementById('shClose').click(); true`);
    await step('короткое нажатие не открывает шторку', async () => {
      await touch('touchStart', await ev(`innerWidth / 2`), 110); await sleep(150); await touch('touchEnd'); await sleep(900);
      if (await ev(`!document.getElementById('sheet').hidden`)) throw new Error('шторка открылась');
    });
  }
  await step('сохранение после перезагрузки', async () => {
    await sleep(500);
    await send('Page.reload');
    await waitFor(`!!window.__map && window.__map.isStyleLoaded()`);
    await waitFor(`document.querySelectorAll('.mk').length > 0 && !!document.querySelector('.station')`);
  });
}

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
  for (const m of MODES) {
    mode = m;
    if (m === 'mobile') {
      await send('Emulation.setDeviceMetricsOverride', { width: LAND ? 844 : 390, height: LAND ? 390 : 844, deviceScaleFactor: 2, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    await scenario();
  }
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
