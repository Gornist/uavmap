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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
/** Центр элемента в координатах окна. */
const centerOf = async (sel) => JSON.parse(await ev(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })())`));
/** Настоящее нажатие (палец на телефоне, мышь на десктопе), с перетаскиванием по точкам path. */
const gesture = async (x, y, path = []) => {
  if (mode === 'mobile') {
    await touch('touchStart', x, y);
    for (const [px, py] of path) { await sleep(30); await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px, y: py, id: 1 }] }); }
    await sleep(60); await touch('touchEnd');
  } else {
    await mouse('mousePressed', x, y);
    for (const [px, py] of path) { await sleep(30); await mouse('mouseMoved', px, py); }
    const [ex, ey] = path.length ? path[path.length - 1] : [x, y];
    await mouse('mouseReleased', ex, ey);
  }
};
/** Высота дрона через высотомер: нажатие на подпись дрона → точное число в диалоге. */
const setDrone = async (v) => {
  const [x, y] = await centerOf('#altimeter .alt-lbl');
  const hit = await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.id || e.className) : 'нет'; })()`);
  await gesture(x, y);
  await waitFor(`!!document.querySelector('.dlg input')`, 3000).catch(() => { throw new Error(`нет диалога высоты; под пальцем ${hit} (${x},${y})`); });
  await ev(`(() => { const i = document.querySelector('.dlg input'); i.value = '${v}'; document.querySelector('.dlg .primary').click(); return true; })()`);
};
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
  const ids = ['topLeft', 'crossChip', 'altimeter', 'mapBar', 'linkStrip', 'bottomBar', 'cross'];
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
  await step('высота в чипе под прицелом', async () => { await waitFor(`/Рельеф \\d+ м/.test(document.getElementById('crossChipText').textContent)`); return ev(`document.getElementById('crossChipText').textContent`); });
  await shot('1-start');

  await step('пустое состояние: «Поставьте пульт» и «Пульт здесь»', async () => {
    await waitFor(`!document.getElementById('linkStrip').hidden && !document.getElementById('lsEmpty').hidden`);
    const t = await ev(`document.getElementById('lsEmpty').textContent`);
    if (!/Поставьте пульт/.test(t) || !/Пульт здесь/.test(t) || !/По GPS/.test(t)) throw new Error('нет пустого состояния: ' + t);
    await ev(`document.getElementById('btnStHere').click(); true`);
    await waitFor(`!document.getElementById('lsMain').hidden`);
    await waitFor(`!document.getElementById('altimeter').hidden`, 3000);
    await waitFor(`/Связь|грани|Нет |ниже склона|Считаю|рельеф|Прицел на пульте/.test(document.getElementById('lsStatus').textContent)`);
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
    const chip = await ev(`document.getElementById('crossChipText').textContent`);
    if (!/(выше|ниже) пульта|Вровень/.test(chip)) throw new Error('чип не относительно пульта: ' + chip);
    await setDrone(1500);
    await waitFor(`/Упр\\.\\s*[+−]\\d/.test(document.getElementById('lsStatus').textContent)`);
    const t = await ev(`document.getElementById('lsStatus').textContent`);
    if (!/Упр\.\s*[+−]\d/.test(t) || !/Видео\s*[+−]\d/.test(t)) throw new Error('нет обеих линий: ' + t);
    const big = await ev(`document.querySelector('#lsStatus .ls-verdict')?.className || ''`);
    if (!/status-(ok|weak|none)/.test(big)) throw new Error('у вердикта нет класса статуса: ' + big);
    const need = await ev(`document.querySelector('#lsStatus .ls-need')?.textContent || ''`);
    if (!/(Поднимите до \d+ м|держ|не добьёт|на грани)/.test(need)) throw new Error('нет подсказки по высоте: ' + need);
    if (/−99|ниже рельефа|поднимите дрон/i.test(t)) throw new Error('служебный текст в строке: ' + t);
    // Вердикт — одна строка, не обрезан (высота строки по содержимому).
    const clip = await ev(`(() => { const e = document.getElementById('linkStrip'); return e.scrollHeight > e.clientHeight + 1; })()`);
    if (clip) throw new Error('строка связи обрезана');
    return t;
  });
  await step('высотомер: полосы, неверная высота не принимается', async () => {
    const lv = await ev(`[...document.querySelectorAll('#altimeter .alt-band')].map(b => b.className.replace('alt-band alt-', '')).join(',')`);
    if (!/ok|weak|none/.test(lv)) throw new Error('нет цветных полос: ' + lv);
    await setDrone(9000);
    await sleep(200);
    const v = await ev(`+document.getElementById('altimeter').getAttribute('aria-valuenow')`);
    if (v !== 1500) throw new Error('высота после 9000: ' + v);
    return `полосы ${lv}; дрон 9000 → ${v}`;
  });
  await step('высотомер: перетаскивание меняет высоту и строку связи', async () => {
    const [x, y] = await centerOf('#altimeter .alt-lbl');
    const [tx, ty] = await centerOf('#altimeter .alt-track');
    const th = await ev(`document.querySelector('#altimeter .alt-track').getBoundingClientRect().height`);
    const yTo = Math.round(ty + th * 0.35); // ниже середины шкалы
    await gesture(x, y, [[x, y + 10], [tx, Math.round((y + yTo) / 2)], [tx, yTo]]);
    await sleep(300);
    const v = await ev(`+document.getElementById('altimeter').getAttribute('aria-valuenow')`);
    const lbl = await ev(`document.querySelector('#altimeter .alt-lbl').textContent`);
    if (!(v < 1500) || !lbl.includes(String(v))) throw new Error(`после перетаскивания: droneH ${v}, подпись «${lbl}»`);
    await waitFor(`/(Поднимите до \\d+ м|держ|не добьёт|на грани)/.test(document.querySelector('#lsStatus .ls-need')?.textContent || '')`);
    await setDrone(1500);
    await waitFor(`/1500/.test(document.querySelector('#altimeter .alt-lbl').textContent)`, 3000);
    return `дрон → ${v} м`;
  });
  await shot('2-link');

  await step('профиль трассы', async () => {
    await ev(`document.querySelector('#lsStatus .ls-need').click(); true`); // нажатие на строку связи — профиль
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
    const need = await ev(`document.querySelector('#shBody .prof-need')?.textContent || ''`);
    if (!/Управление/.test(need) || !/Видео/.test(need)) throw new Error('в профиле нет высоты по линиям: ' + need);
    if (await ev(`[...document.querySelectorAll('#shBody tr')].some(tr => tr.dataset.p || tr.dataset.h)`)) throw new Error('выбор строкой таблицы остался');
    if (!(await ev(`document.querySelectorAll('#shBody button.apply').length > 0`))) throw new Error('нет кнопок «Применить»');
    if (/Дрон −|над землёй \/ над морем−/.test(await ev(`document.getElementById('shBody').textContent`))) throw new Error('отрицательная высота дрона');
    return `${v} — ${why}`;
  });
  await step('где встать: сразу 1 км, варианты с номерами', async () => {
    await ev(`document.getElementById('shClose').click(); document.getElementById('btnBest').click(); true`);
    await waitFor(`!document.getElementById('sheet').hidden && /Где встать/.test(document.getElementById('shTitle').textContent) && (document.querySelectorAll('#shBody button.apply').length > 0 || /лучше не станет|Нет данных/.test(document.getElementById('shBody').textContent))`, 30000);
    const txt = await ev(`document.getElementById('shBody').textContent`);
    if (/−99/.test(txt)) throw new Error('служебный запас −99: ' + txt);
    const n = await ev(`document.querySelectorAll('.bs-mk:not(.bs-target)').length`);
    const labels = await ev(`[...document.querySelectorAll('.bs-mk:not(.bs-target) .bs-label')].map(e => e.textContent).join(',')`);
    if (n && labels !== [...Array(n)].map((_, i) => i + 1).join(',')) throw new Error('подписи ромбов: ' + labels);
    await sleep(800);
    await shot('3b-best');
    // Ромбы не под шторкой: каждый виден в свободной части карты.
    const hidden = await ev(`(() => { const sh = document.getElementById('sheet').getBoundingClientRect(); return [...document.querySelectorAll('.bs-mk')].filter(m => { const r = m.getBoundingClientRect(); const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2; return cx > sh.left && cx < sh.right && cy > sh.top && cy < sh.bottom; }).length; })()`);
    if (hidden) throw new Error('ромбов под шторкой: ' + hidden);
    await ev(`document.getElementById('shClose').click(); true`);
    if (await ev(`document.querySelectorAll('.bs-mk').length`)) throw new Error('ромбы не убраны после закрытия');
    return n ? `вариантов: ${n}` : txt.slice(0, 80);
  });
  await setDrone(100);
  await step('зона покрытия 10 км', async () => {
    await ev(`document.getElementById('btnZone').click(); true`);
    await sleep(300);
    await ev(`(() => { const b = [...document.querySelectorAll('#shBody button')]; b.find(x => x.textContent.trim() === '10 км')?.click(); b.find(x => /Рассчитать/.test(x.textContent))?.click(); return true; })()`);
    const t0 = Date.now();
    await waitFor(`!!window.__map.getLayer('cov-raster')`, 60000);
    // Точный результат: на телефоне шторка сама сворачивается в плашку, на десктопе — пропадает «Черновой» и «Отмена».
    const pillOn = `(() => { const p = document.getElementById('covPill'); return !!p && !p.hidden; })()`;
    const sheetDone = `!document.getElementById('sheet').hidden && !!document.querySelector('#shBody .cov-result') && !document.querySelector('#shBody .cov-prelim') && ![...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === 'Отмена')`;
    await waitFor(mode === 'mobile' ? pillOn : sheetDone, 60000);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    let pillTxt = '';
    if (mode === 'mobile') {
      if (!(await ev(`document.getElementById('sheet').hidden`))) throw new Error('на телефоне шторка не свернулась после расчёта');
      pillTxt = await ev(`document.querySelector('#covPill .cov-pill-main').textContent`);
      if (!/Дрон 100 м · до .*✓⚠✕/.test(pillTxt)) throw new Error('плашка зоны: ' + pillTxt);
      await ev(`document.querySelector('#covPill .cov-pill-main').click(); true`); // тап по плашке — развернуть шторку
      await waitFor(`!document.getElementById('sheet').hidden && !!document.querySelector('#shBody .cov-result')`, 3000);
    }
    const sum = await ev(`document.querySelector('#shBody .cov-result').textContent`);
    if (!/Связь держится до .* · дрон 100 м/.test(sum)) throw new Error('итог зоны: ' + sum);
    if (await ev(`[...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === 'Закрыть')`)) throw new Error('лишняя кнопка «Закрыть»');
    if (await ev(`document.querySelectorAll('#shBody details.details').length`) !== 1) throw new Error('в шторке зоны должен быть один блок «Ещё»');
    // Таблица — в свёрнутом «Ещё»: раскрываем, как пользователь.
    await ev(`(() => { const d = [...document.querySelectorAll('#shBody details.details')].find(x => /Ещё/.test(x.querySelector('summary').textContent)); if (d) d.open = true; return true; })()`);
    const hdr = await ev(`[...document.querySelectorAll('#shBody details[open] table.rt th')].map(t => t.textContent).join('|')`);
    if (!/Упр\..*Видео.*Обе/.test(hdr)) throw new Error('в таблице зоны нет колонок Упр./Видео/Обе: ' + hdr);
    return `${sec} с, «${sum}»${pillTxt ? `, плашка «${pillTxt}»` : ''}, колонки: ${hdr}`;
  });
  await sleep(800);
  await shot('4-coverage');
  await step('зона: плашка на карте после закрытия шторки, не перекрывает панели', async () => {
    await ev(`document.getElementById('shClose').click(); true`);
    await waitFor(`(() => { const p = document.getElementById('covPill'); return !!p && !p.hidden; })()`, 3000);
    const t = await ev(`document.querySelector('#covPill .cov-pill-main').textContent`);
    if (!/Дрон \d+ м · до /.test(t)) throw new Error('плашка: ' + t);
    const bad = await ev(`(() => {
      const p = document.getElementById('covPill').getBoundingClientRect(), out = [];
      if (p.left < 0 || p.top < 0 || p.right > innerWidth || p.bottom > innerHeight) out.push('за экраном');
      for (const id of ['topLeft', 'crossChip', 'altimeter', 'mapBar', 'linkStrip', 'bottomBar', 'cross']) {
        const e = document.getElementById(id); if (!e || e.hidden) continue;
        const r = e.getBoundingClientRect(); if (!r.width) continue;
        if (p.left < r.right - 1 && r.left < p.right - 1 && p.top < r.bottom - 1 && r.top < p.bottom - 1) out.push(id);
      }
      return out;
    })()`);
    if (bad.length) throw new Error('плашка перекрывает: ' + bad.join(', '));
    return t;
  });
  await ev(`(() => { window.__map.jumpTo({ zoom: 11.3 }); return true; })()`);
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
    // Карточка метки: «Рельеф» и координаты одним форматом + свёрнутые «Другие форматы».
    await waitFor(`/Метка/.test(document.getElementById('shTitle').textContent) && !!document.querySelector('#shBody .coords-main')`, 3000);
    if (!(await ev(`/Рельеф/.test(document.getElementById('shBody').textContent) && !document.querySelector('#shBody .coords details').open`))) throw new Error('в карточке метки нет «Рельеф» или «Другие форматы» раскрыты');
    await ev(`document.getElementById('shClose').click(); document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    const items = await ev(`[...document.querySelectorAll('.dr-item b')].map(b => b.textContent).join(' · ')`);
    await ev(`[...document.querySelectorAll('.dr-item')].find(b => /Аппаратура/.test(b.textContent)).click(); true`);
    const sel = await ev(`document.querySelectorAll('#drBody select').length`);
    if (sel !== 2) throw new Error('в «Аппаратура и высота» нет двух списков аппаратуры: ' + sel);
    return `разделы: ${items}`;
  });
  await step('меню: нет прокрутки и кнопки ≥ 44 px', () => checkLayout('меню'));
  await shot('5-menu');
  await step('меню → Инструменты: линейка включается с подписями кнопок', async () => {
    await ev(`document.querySelector('.dr-back').click(); [...document.querySelectorAll('.dr-item')].find(b => /Инструменты/.test(b.textContent)).click(); true`);
    await ev(`[...document.querySelectorAll('#drBody button')].find(b => /Включить линейку/.test(b.textContent)).click(); true`);
    await waitFor(`!document.getElementById('rulerBar').hidden && !document.body.classList.contains('drawer-open')`, 3000);
    const labels = await ev(`[...document.querySelectorAll('#rulerBar button')].map(b => b.textContent.trim()).join('|')`);
    if (labels !== '+ Точка|Отменить|Сохранить маршрут|Готово') throw new Error('подписи: ' + labels);
    await ev(`document.getElementById('rulerAdd').click(); true`);
    await sleep(300);
    await shot('5b-ruler');
    const lay = await checkLayout('линейка');
    await ev(`document.getElementById('rulerDone').click(); true`);
    if (!(await ev(`document.getElementById('rulerBar').hidden`))) throw new Error('«Готово» не выключила линейку');
    await ev(`document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    return lay;
  });
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
      // Ниже плашки зоны (#covPill), но не в центре: в ландшафте там прицел с меткой из шага «метка и меню».
      const py = await ev(`innerHeight < 500 ? 110 : 200`);
      await touch('touchStart', px, py);
      await sleep(900);
      await touch('touchEnd');
      await waitFor(`!document.getElementById('sheet').hidden && document.getElementById('shTitle').textContent === 'Точка'`, 3000);
      await sleep(400);
      await shot('6-point');
      const t = await ev(`document.getElementById('shBody').textContent`);
      if (!/Рельеф/.test(t) || !/Метка сюда/.test(t) || !/Пульт сюда/.test(t)) throw new Error('в «Точке» нет «Рельеф» / «Метка сюда» / «Пульт сюда»');
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
      await touch('touchStart', await ev(`innerWidth / 2`), await ev(`innerHeight < 500 ? 110 : 200`)); await sleep(150); await touch('touchEnd'); await sleep(900);
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
