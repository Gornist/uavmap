// Дымовой тест в headless Chrome через DevTools Protocol (без зависимостей).
// Запуск: node scripts/smoke.mjs [url] [outDir] [--desktop|--mobile] [--landscape] [--fallback|--offline]. Нужен запущенный dev-сервер.
// По умолчанию два прогона подряд: десктоп и телефон (390×844, касания).
// --fallback — только короткий сценарий «основной источник рельефа завис → запасной AWS» (десктоп).
// --offline — только сценарий «Подготовить без сети → сеть пропала → перезагрузка» (десктоп). Нужен Service Worker,
//   а в dev он выключен — запускать на сборке с window.__map (VITE_SMOKE=1), например:
//   VITE_SMOKE=1 npx vite build --base /uavmap/ --outDir "$TMPDIR/uavmap-smoke" --emptyOutDir
//   npx vite preview --base /uavmap/ --outDir "$TMPDIR/uavmap-smoke" --port 4174
//   node scripts/smoke.mjs http://localhost:4174/uavmap/ "$TMPDIR" --offline
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
const FALLBACK = flags.includes('--fallback');
const OFFLINE = flags.includes('--offline');
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
/** Команда CDP; sessionId — сессия другой цели (Service Worker), подключённой с flatten. */
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
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
/** Данные GeoJSON-источника карты (то, что сейчас нарисовано); null — источника нет. */
const geo = (id) => ev(`(() => { const s = window.__map.getSource(${JSON.stringify(id)}); return s ? s.serialize().data : null; })()`);
const feats = async (id) => (await geo(id))?.features || [];
/**
 * Нажатие на элемент: настоящий жест, если элемент не закрыт другим; иначе — click(). Возвращает '' при настоящем
 * нажатии, иначе — чем закрыт (для пометки в результате шага).
 */
const press = async (sel) => {
  const [x, y] = await centerOf(sel);
  const over = await ev(`(() => { const e = document.elementFromPoint(${x}, ${y}); return !e ? 'за экраном' : e.closest(${JSON.stringify(sel)}) ? '' : (e.closest('[id]')?.id || e.className || e.tagName).toString().slice(0, 30); })()`);
  if (!over) await gesture(x, y);
  else await ev(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
  return over;
};
const key = async (k, code = k, vk = 0) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
};
/** Высота дрона с клавиатуры: фокус на высотомере, Enter → диалог точной высоты. */
const setDroneKey = async (v) => {
  await ev(`document.getElementById('altimeter').focus(); document.activeElement === document.getElementById('altimeter')`);
  await key('Enter', 'Enter', 13);
  await waitFor(`!!document.querySelector('.dlg input')`, 3000).catch(() => { throw new Error('Enter на высотомере не открыл диалог'); });
  await ev(`(() => { const i = document.querySelector('.dlg input'); i.value = '${v}'; document.querySelector('.dlg .primary').click(); return true; })()`);
};
/** Текст плашки зоны (без «✕»); пусто — плашки нет. */
const pillText = `(() => { const p = document.getElementById('covPill'); return p && !p.hidden ? p.querySelector('.cov-pill-main').textContent.trim() : ''; })()`;
/** Плашка зоны не за экраном и не на панелях. */
const pillOverlap = `(() => {
  const pe = document.getElementById('covPill'); if (!pe || pe.hidden) return [];
  const p = pe.getBoundingClientRect(), out = [];
  if (p.left < 0 || p.top < 0 || p.right > innerWidth || p.bottom > innerHeight) out.push('за экраном');
  for (const id of ['topLeft', 'crossChip', 'altimeter', 'mapBar', 'linkStrip', 'bottomBar', 'cross']) {
    const e = document.getElementById(id); if (!e || e.hidden) continue;
    const r = e.getBoundingClientRect(); if (!r.width) continue;
    if (p.left < r.right - 1 && r.left < p.right - 1 && p.top < r.bottom - 1 && r.top < p.bottom - 1) out.push('covPill×' + id);
  }
  return out;
})()`;
/** Блок антенн в шторке пульта: открыть нажатием на маркер 📡. */
const openStationSheet = async () => {
  const over = await press('.station');
  await waitFor(`!document.getElementById('sheet').hidden && /Пульт/.test(document.getElementById('shTitle').textContent) && document.querySelectorAll('#stAnts .ant-card').length === 2`, 3000)
    .catch(() => { throw new Error('шторка пульта с двумя антеннами не открылась'); });
  return over;
};
/** Тип антенны в карточке линии (0 — управление, 1 — видео) по началу подписи кнопки. */
const pickAntenna = (card, name) => ev(`(() => { const b = [...document.querySelectorAll('#stAnts .ant-card')[${card}].querySelectorAll('.seg button')].find(x => x.textContent.trim().startsWith(${JSON.stringify(name)})); if (!b) return false; b.click(); return true; })()`);

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
  const e0 = errors.length;
  try {
    const v = await fn();
    // Ошибка в консоли за время шага — шаг не прошёл, даже если состояние верное.
    if (errors.length > e0) throw new Error(`ошибки консоли: ${errors.slice(e0, e0 + 3).join(' | ')}`);
    results.push(`✓ [${mode}] ${name}${v ? ` — ${v}` : ''}`);
  } catch (e) { results.push(`✗ [${mode}] ${name} — ${e.message}`); }
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
  // Пульт поставлен, «Зону» не нажимали: радиогоризонт считается сам и рисуется только границами (без заливки).
  const edgeLines = `(window.__map.getSource('cov-edge')?.serialize().data.features || []).map(f => f.properties.line).sort().join(',')`;
  const covIdle = `!${pillText}.includes('считаю')`;
  await step('радиогоризонт сам: границы управления и видео без «Зоны», без заливки', async () => {
    await waitFor(`${edgeLines} === 'rc,video' && ${covIdle}`, 90000);
    const t = await ev(pillText);
    if (!/Дрон 100 м · до /.test(t) || !/упр\./.test(t) || !/видео/.test(t)) throw new Error('плашка: ' + t);
    if (/[✓⚠✕]/.test(t)) throw new Error('у плашки без заливки легенда ✓⚠✕: ' + t);
    if (await ev(`!!window.__map.getLayer('cov-raster')`)) throw new Error('появилась заливка зоны');
    const pts = (await feats('cov-edge')).map((f) => f.geometry.coordinates.length);
    if (pts.some((n) => n < 10)) throw new Error('граница из ' + pts.join('/') + ' точек');
    return t;
  });
  await step('радиогоризонт сам: высота с высотомера (Enter → диалог) — плашка с новой высотой', async () => {
    await setDroneKey(250);
    await waitFor(`+document.getElementById('altimeter').getAttribute('aria-valuenow') === 250`, 3000);
    await waitFor(`/Дрон 250 м · до /.test(${pillText}) && ${covIdle}`, 90000);
    if (await ev(edgeLines) !== 'rc,video') throw new Error('границы после смены высоты: ' + await ev(edgeLines));
    if (await ev(`!!window.__map.getLayer('cov-raster')`)) throw new Error('появилась заливка зоны');
    return ev(pillText);
  });
  await step('связь до креста после сдвига 3 км на северо-восток', async () => {
    await ev(`(() => { const m = window.__map, c = m.getCenter(); m.jumpTo({ center: [c.lng + 0.03, c.lat + 0.02] }); return true; })()`);
    await waitFor(`/Упр\\.|Запас/.test(document.getElementById('lsStatus').textContent)`);
    const t = await ev(`document.getElementById('lsStatus').textContent`);
    if (!/[✓⚠✕]/.test(t) || !/км/.test(t)) throw new Error('нет вердикта со значком и дальности: ' + t);
    return t;
  });
  await step('подсказка высотомера при первом расчёте: рядом со шкалой, «Понятно» закрывает и запоминает', async () => {
    await waitFor(`!!document.getElementById('altHint')`, 15000).catch(() => { throw new Error('подсказки нет'); });
    await shot('2b-alt-hint');
    const t = await ev(`document.getElementById('altHint').textContent`);
    if (!/над точкой взлёта/.test(t) || !/на грани/.test(t) || !/Понятно/.test(t)) throw new Error('текст подсказки: ' + t);
    const lay = await checkLayout('подсказка высотомера');
    const off = await ev(`(() => { const r = document.getElementById('altHint').getBoundingClientRect(); return r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight; })()`);
    if (off) throw new Error('подсказка за краем экрана');
    const over = await press('#altHint button');
    await waitFor(`!document.getElementById('altHint')`, 3000);
    if (await ev(`localStorage.getItem('uavmap.ui.altHint')`) !== '1') throw new Error('флаг подсказки не записан');
    return `${lay}${over ? `; кнопка закрыта ${over} — click()` : ''}`;
  });
  await step('кнопка линии к прицелу: по умолчанию пусто, нажатие — линия, повторное — пусто', async () => {
    const pressed = `document.getElementById('btnLink').getAttribute('aria-pressed')`;
    const nLink = `(window.__map.getSource('link')?.serialize().data.features.length ?? -1)`;
    if (await ev(pressed) !== 'false') throw new Error('кнопка включена по умолчанию');
    if (await ev(nLink) !== 0) throw new Error('линия нарисована без кнопки: ' + await ev(nLink));
    const over = await press('#btnLink');
    await waitFor(`${pressed} === 'true'`, 3000);
    await waitFor(`${nLink} === 1`, 15000);
    const g = (await feats('link'))[0].geometry;
    if (g.type !== 'LineString' || g.coordinates.length !== 2) throw new Error('не отрезок пульт → прицел: ' + g.type);
    await press('#btnLink');
    await waitFor(`${pressed} === 'false'`, 3000);
    await waitFor(`${nLink} === 0`, 3000);
    return over ? `click() — кнопку закрывает ${over}` : 'нажатием';
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
    // Цвет и подпись шкалы — видео; управлению нужно выше — вторая подпись «упр. от N м». Большая из подписей —
    // то же число, что в подсказке строки связи (дрон на 1500 м: «можно снизиться до N м» — нужная обеим линиям).
    const need = await ev(`document.querySelector('#lsStatus .ls-need')?.textContent || ''`);
    const lbls = await ev(`[...document.querySelectorAll('#altimeter .alt-need')].map(e => e.textContent)`);
    const lbl = lbls.join(' / ');
    const n = (need.match(/снизиться до (\d+) м/) || [])[1];
    if (lbls.length && !/^видео (на грани )?от \d+ м$/.test(lbls[0])) throw new Error(`подпись не о видео: «${lbl}»`);
    // «упр. от» не подписывается, если управлению нужно выше видео меньше чем на 5 м (altimeter.ts, RC_SAME_M).
    const nums = lbls.map((t) => +(t.match(/от (\d+) м$/) || [])[1]);
    if (n && !nums.some((v) => v <= +n && +n - v <= 5)) throw new Error(`подписи «${lbl}», в строке «${need}»`);
    if (lbl) {
      const bad = await ev(`(() => { const a = document.querySelector('#altimeter .alt-need').getBoundingClientRect(), b = document.querySelector('#altimeter .alt-lbl').getBoundingClientRect();
        return a.left < 0 || a.right > innerWidth || (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom); })()`);
      if (bad) throw new Error('подпись за экраном или на плашке высоты');
    }
    await setDrone(9000);
    await sleep(200);
    const v = await ev(`+document.getElementById('altimeter').getAttribute('aria-valuenow')`);
    if (v !== 1500) throw new Error('высота после 9000: ' + v);
    return `полосы ${lv}; ${lbl ? `«${lbl}»` : 'без подписи'}; дрон 9000 → ${v}`;
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
  await step('антенны: яги у видео на 180° — луч с подписью, «вне луча» и «Повернуть»', async () => {
    const over = await openStationSheet();
    if (!(await pickAntenna(1, 'Яги'))) throw new Error('нет кнопки «Яги» у видео');
    const inp = `document.querySelectorAll('#stAnts .ant-card')[1].querySelector('.ant-dir input')`;
    await waitFor(`!!${inp}`, 3000);
    await ev(`(() => { const i = ${inp}; i.value = '180'; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (await ev(`${inp}.value`) !== '180') throw new Error('азимут не принят: ' + await ev(`${inp}.value`));
    await ev(`document.getElementById('shClose').click(); true`);
    await waitFor(`document.getElementById('sheet').hidden`, 3000);
    const aim = await feats('aim');
    const sectors = aim.filter((f) => f.geometry.type === 'Polygon').length;
    const labels = aim.filter((f) => f.geometry.type === 'Point').map((f) => f.properties.label);
    if (sectors !== 1 || labels.length !== 1 || !/^Видео 180° Ю$/.test(labels[0])) throw new Error(`луч: секторов ${sectors}, подписи «${labels.join('|')}»`);
    // Прицел к северо-востоку от пульта (аз. ≈ 47°), луч яги 30° смотрит на юг — прицел вне луча.
    await waitFor(`/вне луча/.test(document.getElementById('lsStatus').textContent)`, 15000);
    const btn = await ev(`document.querySelector('#lsStatus [data-act="aim"]')?.textContent || ''`);
    if (btn !== 'Повернуть') throw new Error('кнопка поворота: «' + btn + '»');
    const az = +(await ev(`(document.getElementById('lsStatus').textContent.match(/аз\\. (\\d+)°/) || [])[1]`));
    await press('#lsStatus [data-act="aim"]');
    await waitFor(`!/вне луча/.test(document.getElementById('lsStatus').textContent)`, 15000);
    const l2 = (await feats('aim')).filter((f) => f.geometry.type === 'Point').map((f) => f.properties.label).join('|');
    if (!new RegExp(`^Видео ${az}° `).test(l2)) throw new Error(`после «Повернуть» подпись «${l2}», прицел аз. ${az}°`);
    return `луч «${labels[0]}» → «${l2}»${over ? ` (маркер закрыт ${over} — нажат через click())` : ''}`;
  });
  await step('антенны: видео снова всенаправленная — луча нет', async () => {
    await openStationSheet();
    if (!(await pickAntenna(1, 'Всенаправленная'))) throw new Error('нет кнопки «Всенаправленная»');
    await waitFor(`!document.querySelectorAll('#stAnts .ant-card')[1].querySelector('.ant-dir')`, 3000);
    await ev(`document.getElementById('shClose').click(); true`);
    await waitFor(`document.getElementById('sheet').hidden && (window.__map.getSource('aim')?.serialize().data.features.length ?? -1) === 0`, 3000);
    if (await ev(`/вне луча/.test(document.getElementById('lsStatus').textContent)`)) throw new Error('«вне луча» осталось');
  });
  await step('наклон антенны: поле есть, «На прицел» ставит и азимут, и наклон', async () => {
    await openStationSheet();
    if (!(await pickAntenna(0, 'Патч'))) throw new Error('нет кнопки «Патч» у управления');
    const card = `document.querySelectorAll('#stAnts .ant-card')[0]`;
    await waitFor(`!!${card}.querySelector('.ant-tilt input')`, 3000).catch(() => { throw new Error('нет поля наклона'); });
    // Сбить азимут и наклон, затем «На прицел».
    await ev(`(() => { const [a, t] = ${card}.querySelectorAll('.ant-dir input'); a.value = '200'; a.dispatchEvent(new Event('change', { bubbles: true })); t.value = '-5'; t.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const before = await ev(`[...${card}.querySelectorAll('.ant-dir input')].map((i) => i.value).join('/')`);
    if (before !== '200/-5') throw new Error('азимут/наклон не приняты: ' + before);
    if (!(await ev(`(() => { const b = [...${card}.querySelectorAll('.ant-dir button')].find((x) => x.textContent.trim() === 'На прицел'); if (!b) return false; b.click(); return true; })()`))) throw new Error('нет кнопки «На прицел»');
    const ref = await ev(`${card}.querySelector('.ant-ref').textContent`);
    const m = ref.match(/азимут (\d+)°.*угол места (-?\d+)°/);
    if (!m) throw new Error('подсказка без азимута и угла места: «' + ref + '»');
    const [az, tilt] = await ev(`[...${card}.querySelectorAll('.ant-dir input')].map((i) => i.value)`);
    const want = String(Math.min(60, Math.max(-10, +m[2])));
    if (az !== m[1] || tilt !== want) throw new Error(`после «На прицел» азимут ${az}, наклон ${tilt}; подсказка «${ref}»`);
    await ev(`${card}.scrollIntoView(); true`);
    await shot('2-tilt');
    await ev(`document.getElementById('shClose').click(); true`);
    await waitFor(`document.getElementById('sheet').hidden`, 3000);
    const label = (await feats('aim')).filter((f) => f.geometry.type === 'Point').map((f) => f.properties.label).join('|');
    if (!new RegExp(`^Упр\\. ${az}° \\S+${tilt !== '0' ? ` · наклон ${tilt}°` : ''}$`).test(label)) throw new Error('подпись луча: «' + label + '»');
    // Обратно: всенаправленная.
    await openStationSheet();
    if (!(await pickAntenna(0, 'Всенаправленная'))) throw new Error('нет кнопки «Всенаправленная»');
    await ev(`document.getElementById('shClose').click(); true`);
    await waitFor(`document.getElementById('sheet').hidden && (window.__map.getSource('aim')?.serialize().data.features.length ?? -1) === 0`, 3000);
    return `«${ref}» → азимут ${az}°, наклон ${tilt}°; луч «${label}»`;
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
  await step('меню → Метки и файлы: картинка карты (JPEG) и лист для печати', async () => {
    // Скачивание и окно печати перехватываем: файл не пишется, диалог не открывается.
    await ev(`(() => { window.__dl = []; window.__aClick = HTMLAnchorElement.prototype.click; window.__print = window.print; HTMLAnchorElement.prototype.click = function () { window.__dl.push({ name: this.download, href: this.href }); }; window.print = () => { window.__printed = true; }; return 1; })()`);
    const openFiles = async () => {
      await ev(`document.querySelector('.dr-back')?.click(); [...document.querySelectorAll('.dr-item')].find(b => /Метки и файлы/.test(b.textContent)).click(); true`);
    };
    await openFiles();
    await ev(`[...document.querySelectorAll('#drBody button')].find(b => b.textContent.trim() === 'Картинка карты').click(); true`);
    await waitFor(`window.__dl.length > 0`, 20000).catch(() => { throw new Error('картинка не сохранилась'); });
    const dl = await ev(`(async () => { const d = window.__dl[0]; const b = await (await fetch(d.href)).blob(); return { name: d.name, type: b.type, size: b.size }; })()`);
    if (!/^uavmap-карта-\d{8}-\d{4}\.jpg$/.test(dl.name) || dl.type !== 'image/jpeg' || dl.size < 20000) throw new Error('картинка: ' + JSON.stringify(dl));
    await ev(`document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    // Прицел — не на пульте: в лист попадает профиль до него.
    await ev(`document.getElementById('drClose').click(); window.__map.panBy([-220, -120], { duration: 0 }); true`);
    await sleep(1500);
    await ev(`document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    await openFiles();
    await ev(`[...document.querySelectorAll('#drBody button')].find(b => b.textContent.trim() === 'Лист для печати').click(); true`);
    await waitFor(`!!window.__printed && !!document.getElementById('printSheet')`, 20000).catch(() => { throw new Error('лист для печати не собрался'); });
    const t = await ev(`document.getElementById('printSheet').textContent.replace(/\\s+/g, ' ')`);
    for (const need of ['До прицела', 'Пульт и аппаратура', 'Управление']) if (!t.includes(need)) throw new Error(`в листе нет «${need}»: ${t.slice(0, 200)}`);
    const imgs = await ev(`[...document.querySelectorAll('#printSheet img')].map(i => i.naturalWidth).join(',')`);
    if (!/^\d+,\d+$/.test(imgs) || imgs.split(',').some((v) => +v < 300)) throw new Error('картинки листа (карта, профиль): ' + imgs);
    // На экране лист не виден; после печати убирается.
    if (await ev(`getComputedStyle(document.getElementById('printSheet')).display !== 'none'`)) throw new Error('лист виден на экране');
    await ev(`window.dispatchEvent(new Event('afterprint')); true`);
    if (await ev(`!!document.getElementById('printSheet') || document.documentElement.classList.contains('printing')`)) throw new Error('лист не убран после печати');
    await ev(`(() => { HTMLAnchorElement.prototype.click = window.__aClick; window.print = window.__print; return 1; })()`);
    await ev(`document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`);
    return `${dl.name}, ${Math.round(dl.size / 1024)} КБ; лист: картинки ${imgs} px`;
  });
  await step('лес на трассе: раздел в «Аппаратуре», высота деревьев, выключение убирает лес из строки', async () => {
    await ev(`document.querySelector('.dr-back')?.click(); [...document.querySelectorAll('.dr-item')].find(b => /Аппаратура/.test(b.textContent)).click(); true`);
    const chk = `[...document.querySelectorAll('#drBody label.chk')].find(l => /Учитывать лес/.test(l.textContent))?.querySelector('input')`;
    if (!(await ev(`!!(${chk}) && (${chk}).checked`))) throw new Error('нет включённого «Учитывать лес»');
    const hs = await ev(`[...document.querySelectorAll('#drBody .seg button')].map(b => b.textContent).filter(t => / м$/.test(t)).join(',')`);
    if (hs !== '10 м,15 м,20 м,25 м') throw new Error('высоты деревьев: ' + hs);
    await ev(`[...document.querySelectorAll('#drBody .seg button')].find(b => b.textContent === '20 м').click(); true`);
    if (!(await ev(`[...document.querySelectorAll('#drBody .seg button')].find(b => b.textContent === '20 м')?.classList.contains('on')`))) throw new Error('«20 м» не отмечена');
    await ev(`(${chk}).click(); true`);
    await sleep(1500);
    const off = await ev(`document.getElementById('lsStatus').textContent`);
    if (/лес/.test(off)) throw new Error('лес выключен, а в строке: ' + off);
    await ev(`(${chk}).click(); [...document.querySelectorAll('#drBody .seg button')].find(b => b.textContent === '15 м')?.click(); true`);
    await sleep(300);
    return `высоты ${hs}`;
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

  await step('читаемость: «Яркое солнце» и «Крупный текст» — классы, без прокрутки и перекрытий', async () => {
    const chk = (label, on) => ev(`(() => { const c = [...document.querySelectorAll('#drBody label.chk')].find(x => x.querySelector('.chk-t')?.textContent === ${JSON.stringify(label)}); if (!c) return false; const i = c.querySelector('input'); if (i.checked !== ${on}) i.click(); return i.checked === ${on}; })()`);
    const cls = `['sun', 'big-text'].filter(c => document.documentElement.classList.contains(c)).join(',')`;
    if (await ev(cls)) throw new Error('классы до включения: ' + await ev(cls));
    if (!(await chk('Яркое солнце', true)) || !(await chk('Крупный текст', true))) throw new Error('нет переключателей читаемости');
    if (await ev(cls) !== 'sun,big-text') throw new Error('классы <html>: ' + await ev(cls));
    const menu = await checkLayout('меню, крупный текст');
    await ev(`document.getElementById('drClose').click(); true`);
    await waitFor(`!document.body.classList.contains('drawer-open')`, 3000);
    await sleep(300); // перестроение раскладки под крупный текст
    await shot('5c-sun-big');
    const map_ = await checkLayout('карта, крупный текст');
    const ov = [...await ev(overlapCheck), ...await ev(pillOverlap)];
    if (ov.length) throw new Error('перекрытия с крупным текстом: ' + ov.join(', '));
    const clip = await ev(`(() => { const e = document.getElementById('linkStrip'); return !e.hidden && e.scrollHeight > e.clientHeight + 1; })()`);
    if (clip) throw new Error('строка связи обрезана с крупным текстом');
    await ev(`document.getElementById('btnMenu').click(); true`);
    await waitFor(`document.body.classList.contains('drawer-open')`, 3000);
    await ev(`document.querySelector('.dr-back')?.click(); [...document.querySelectorAll('.dr-item')].find(b => /Настройки/.test(b.textContent)).click(); true`);
    if (!(await chk('Яркое солнце', false)) || !(await chk('Крупный текст', false))) throw new Error('не выключились');
    if (await ev(cls)) throw new Error('классы после выключения: ' + await ev(cls));
    return `${menu}; ${map_}, без перекрытий`;
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
    // Подсказку высотомера уже закрыли — после перезагрузки и расчёта трассы её нет.
    await waitFor(`!!document.querySelector('#altimeter .alt-band:not(.alt-pending)')`, 30000).catch(() => undefined);
    await sleep(1500);
    if (await ev(`!!document.getElementById('altHint')`)) throw new Error('подсказка высотомера показана повторно');
  });
  // Каталог интерфейса (design.html, только dev-сервер): без ошибок, контраст текстовых токенов, без прокрутки вбок.
  if (!/\/uavmap\//.test(URL_)) await step('каталог интерфейса design.html: обе темы, контраст, без прокрутки вбок', async () => {
    await send('Page.navigate', { url: new URL('design.html', URL_).href });
    await waitFor(`!!document.querySelector('#pv .pv-t')`, 15000);
    const out = [];
    for (const t of ['day', 'night']) {
      await ev(`document.querySelector('[data-theme-set="${t}"]').click(); true`);
      await sleep(200);
      const bad = await ev(`[...document.querySelectorAll('#pv .pv-t td.status-none')].map(td => td.closest('tr').innerText.replace(/\\s+/g, ' '))`);
      if (bad.length) throw new Error(`${t}: мало контраста — ${bad.join('; ')}`);
      const rows = await ev(`document.querySelectorAll('#pv .pv-t tr').length - 1`);
      out.push(`${t}: ${rows} пар ✓`);
    }
    // Страница с прокруткой: мобильный Chrome расширяет окно под широкое содержимое (innerWidth растёт) —
    // сравниваем с заданной шириной окна (как в setDeviceMetricsOverride ниже), +1 px на округление.
    const vw = mode === 'mobile' ? (LAND ? 844 : 390) : 1200;
    const sw = await ev(`document.documentElement.scrollWidth > ${vw + 1} ? document.documentElement.scrollWidth + ' > ${vw}' : ''`);
    if (sw) throw new Error(`горизонтальная прокрутка (${sw})`);
    return out.join(', ');
  });
}

// ---------- Запасной рельеф: основной источник (Mapterhorn) «висит» ----------
const netLog = [];
let paused = 0;
async function scenarioFallback() {
  const origin = new URL(URL_).origin;
  await send('Page.navigate', { url: 'about:blank' });
  // Чистый сайт: без кеша Service Worker и HTTP-кеша рельеф придётся брать из сети, а основной не ответит.
  await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await send('Network.enable');
  await send('Network.clearBrowserCache');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // Запросы к основному источнику перехватываются и никогда не продолжаются — как замершее соединение.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*tiles.mapterhorn.com*', requestStage: 'Request' }] });
  netLog.length = 0; paused = 0;
  await send('Page.navigate', { url: URL_ });
  try {
    await step('запасной рельеф: карта загрузилась при зависшем основном источнике', () => waitFor(`!!window.__map && window.__map.isStyleLoaded()`, 30000));
    await step('запасной рельеф: высота под прицелом', async () => {
      await waitFor(`/Рельеф \\d+ м/.test(document.getElementById('crossChipText').textContent)`, 45000);
      return ev(`document.getElementById('crossChipText').textContent`);
    });
    await step('запасной рельеф: пульт и зона 10 км по AWS', async () => {
      await waitFor(`!document.getElementById('linkStrip').hidden && !document.getElementById('lsEmpty').hidden`, 10000);
      await ev(`document.getElementById('btnStHere').click(); true`);
      await waitFor(`!!document.querySelector('.station')`, 5000);
      await ev(`document.getElementById('btnZone').click(); true`);
      await waitFor(`!document.getElementById('sheet').hidden && [...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === '10 км')`, 5000);
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => x.textContent.trim() === '10 км').click(); true`);
      // Радиогоризонт сам мог уже начать расчёт (15 км, только границы) — отменяем: нужна зона с заливкой.
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => x.textContent.trim() === 'Отмена')?.click(); true`);
      await waitFor(`[...document.querySelectorAll('#shBody button')].some(x => /Рассчитать/.test(x.textContent))`, 3000);
      const t0 = Date.now();
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => /Рассчитать/.test(x.textContent)).click(); true`);
      await waitFor(`!!window.__map.getLayer('cov-raster') && !!document.querySelector('#shBody .cov-result') && !document.querySelector('#shBody .cov-prelim') && ![...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === 'Отмена')`, 120000)
        .catch(async () => { throw new Error('зона не посчиталась: ' + (await ev(`document.getElementById('shBody').textContent`)).slice(0, 160)); });
      const sum = await ev(`document.querySelector('#shBody .cov-result').textContent`);
      if (!/Связь держится до/.test(sum)) throw new Error('итог зоны: ' + sum);
      await shot('fallback-zone');
      return `${((Date.now() - t0) / 1000).toFixed(1)} с, «${sum}»`;
    });
    await step('запасной рельеф: «Подготовить без сети» — понятный отказ, район не создан', async () => {
      await ev(`document.getElementById('shClose').click(); true`);
      await openStationSheet();
      await ev(`document.getElementById('stPrep').click(); true`);
      // Предохранитель уже открыт — отказ сразу; иначе скачивание само заметит, что источник не отвечает.
      await waitFor(`/Mapterhorn\\) (сейчас )?не отвечает/.test(document.getElementById('toast').textContent)`, 150000)
        .catch(async () => { throw new Error('сообщение: ' + await ev(`document.getElementById('toast').textContent`)); });
      if (await ev(`!!localStorage.getItem('uavmap.offline.v1') && JSON.parse(localStorage.getItem('uavmap.offline.v1')).areas.length > 0`)) throw new Error('появился пустой район');
      const t = await ev(`document.getElementById('toast').textContent`);
      await ev(`document.getElementById('shClose').click(); true`);
      return t.slice(0, 90) + '…';
    });
    await step('запасной рельеф: запросы ушли к AWS, основной перехвачен', async () => {
      const aws = netLog.filter((u) => u.includes('s3.amazonaws.com/elevation-tiles-prod')).length;
      if (!aws) throw new Error('ни одного запроса к s3.amazonaws.com/elevation-tiles-prod');
      if (!paused) throw new Error('к основному источнику не было запросов — перехват не сработал');
      return `AWS: ${aws} запросов, основной: ${paused} подвешено`;
    });
  } finally {
    await send('Fetch.disable');
    await send('Network.setCacheDisabled', { cacheDisabled: false });
  }
}

// ---------- Без сети: «Подготовить без сети», затем сеть пропадает и страница перезагружается ----------
/** Сеть страницы и Service Worker (у него свои запросы — эмуляция страницы на них не действует). */
const setOffline = async (offline, swSession) => {
  const cond = { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
  await send('Network.emulateNetworkConditions', cond);
  if (swSession) await send('Network.emulateNetworkConditions', cond, swSession);
};
async function scenarioOffline() {
  const origin = new URL(URL_).origin;
  await send('Page.navigate', { url: 'about:blank' });
  await send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await send('Network.enable');
  await send('Network.clearBrowserCache');
  await send('Page.navigate', { url: URL_ });
  let swSession = '';
  const status = `document.getElementById('lsStatus').textContent`;
  try {
    await step('без сети: карта и Service Worker', async () => {
      await waitFor(`!!window.__map && window.__map.isStyleLoaded()`, 30000);
      await waitFor(`!!navigator.serviceWorker && !!navigator.serviceWorker.controller`, 30000)
        .catch(() => { throw new Error('страницей не управляет Service Worker — в dev он выключен, запустите на сборке (vite preview)'); });
      const { targetInfos } = await send('Target.getTargets');
      const swt = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(origin));
      if (!swt) throw new Error('нет цели service_worker');
      swSession = (await send('Target.attachToTarget', { targetId: swt.targetId, flatten: true })).sessionId;
      await send('Network.enable', {}, swSession);
      return swt.url.replace(origin, '');
    });
    await step('без сети: пульт и трасса 3 км', async () => {
      await waitFor(`/Рельеф \\d+ м/.test(document.getElementById('crossChipText').textContent)`, 30000);
      await waitFor(`!document.getElementById('linkStrip').hidden && !document.getElementById('lsEmpty').hidden`, 10000);
      await ev(`document.getElementById('btnStHere').click(); true`);
      await waitFor(`!!document.querySelector('.station')`, 5000);
      await ev(`(() => { const m = window.__map, c = m.getCenter(); m.jumpTo({ center: [c.lng + 0.03, c.lat + 0.02] }); return true; })()`);
      await waitFor(`/Упр\\.|Запас/.test(${status})`, 30000);
      return ev(status);
    });
    await step('без сети: «Подготовить без сети» в шторке пульта — готово, размер', async () => {
      await openStationSheet();
      const btn = await ev(`document.getElementById('stPrep').textContent`);
      if (btn !== 'Подготовить без сети') throw new Error('кнопка: ' + btn);
      await ev(`document.getElementById('stPrep').click(); true`);
      await waitFor(`!document.getElementById('progress').hidden || /^Готово/.test(document.getElementById('stOffNote').textContent)`, 10000);
      const t0 = Date.now();
      await waitFor(`/^Готово/.test(document.getElementById('stOffNote').textContent) && document.getElementById('progress').hidden`, 180000)
        .catch(async () => { throw new Error('не готово: ' + await ev(`document.getElementById('stOffNote').textContent + ' | ' + document.getElementById('toast').textContent`)); });
      const toastT = await ev(`document.getElementById('toast').textContent`);
      if (!/^Готово: ~.+ — расчёт здесь работает без сети$/.test(toastT)) throw new Error('итог: ' + toastT);
      const areas = await ev(`JSON.parse(localStorage.getItem('uavmap.offline.v1')).areas.map(a => a.km + ' км, ' + a.tiles + ' тайлов, ' + (a.calc && a.view ? 'расчёт + карта' : '?') + (a.complete === false ? ', не полный' : '')).join('; ')`);
      return `${((Date.now() - t0) / 1000).toFixed(1)} с, «${toastT}», ${areas}`;
    });
    await step('без сети: строка связи «офлайн ✓» после подготовки', async () => {
      await ev(`document.getElementById('shClose').click(); true`);
      await waitFor(`/офлайн ✓/.test(${status})`, 5000).catch(async () => { throw new Error('строка: ' + await ev(status)); });
    });
    const c0 = await ev(`(() => { const c = window.__map.getCenter(); return [c.lng, c.lat]; })()`);
    await step('без сети: сеть выключена (страница и Service Worker)', async () => {
      // Без кеша просмотренных и подкачанных тайлов: рельеф дальше — только из скачанного района.
      await ev(`caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('uavmap-dem-runtime')).map(k => caches.delete(k)))).then(() => true)`);
      await setOffline(true, swSession);
      const page = await ev(`navigator.onLine`);
      const r = await send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(URL_)} + '?probe=' + Date.now(), { cache: 'no-store' }).then(() => 'есть', () => 'нет')`, awaitPromise: true, returnByValue: true }, swSession);
      if (page !== false || r.result?.value !== 'нет') throw new Error(`navigator.onLine ${page}, сеть у Service Worker: ${r.result?.value}`);
      return 'navigator.onLine = false, fetch из Service Worker не проходит';
    });
    await step('без сети: перезагрузка — оболочка из Service Worker, высота под прицелом', async () => {
      await send('Page.reload');
      await waitFor(`!!window.__map && window.__map.isStyleLoaded()`, 30000);
      await ev(`window.__map.jumpTo({ center: ${JSON.stringify(c0)} }); true`);
      // Пульт стоит — высота относительно него («На 120 м выше пульта»); «Нет данных рельефа» — провал.
      await waitFor(`/Рельеф \\d+ м|\\d+ м (выше|ниже) пульта|Вровень/.test(document.getElementById('crossChipText').textContent)`, 30000)
        .catch(async () => { throw new Error('чип: ' + await ev(`document.getElementById('crossChipText').textContent`)); });
      return ev(`document.getElementById('crossChipText').textContent`);
    });
    await step('без сети: строка связи считается, «офлайн ✓»', async () => {
      await waitFor(`!!document.querySelector('.station')`, 5000);
      await waitFor(`/Упр\\.|Запас/.test(${status}) && /офлайн ✓/.test(${status})`, 30000)
        .catch(async () => { throw new Error('строка: ' + await ev(status)); });
      return ev(status);
    });
    await step('без сети: зона 10 км', async () => {
      await ev(`document.getElementById('btnZone').click(); true`);
      await waitFor(`!document.getElementById('sheet').hidden && [...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === '10 км')`, 5000);
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => x.textContent.trim() === '10 км').click(); true`);
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => x.textContent.trim() === 'Отмена')?.click(); true`);
      await waitFor(`[...document.querySelectorAll('#shBody button')].some(x => /Рассчитать/.test(x.textContent))`, 3000);
      const t0 = Date.now();
      await ev(`[...document.querySelectorAll('#shBody button')].find(x => /Рассчитать/.test(x.textContent)).click(); true`);
      await waitFor(`!!window.__map.getLayer('cov-raster') && !!document.querySelector('#shBody .cov-result') && !document.querySelector('#shBody .cov-prelim') && ![...document.querySelectorAll('#shBody button')].some(x => x.textContent.trim() === 'Отмена')`, 120000)
        .catch(async () => { throw new Error('зона не посчиталась: ' + (await ev(`document.getElementById('shBody').textContent`)).slice(0, 160)); });
      const sum = await ev(`document.querySelector('#shBody .cov-result').textContent`);
      if (!/Связь держится до/.test(sum)) throw new Error('итог зоны: ' + sum);
      await shot('offline-zone');
      return `${((Date.now() - t0) / 1000).toFixed(1)} с, «${sum}»`;
    });
  } finally {
    await setOffline(false, swSession).catch(() => undefined);
    if (swSession) await send('Target.detachFromTarget', { sessionId: swSession }).catch(() => undefined);
  }
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
    if (d.method === 'Network.requestWillBeSent') netLog.push(d.params.request.url);
    if (d.method === 'Fetch.requestPaused') paused++; // не продолжаем — запрос «висит»
  };
  await send('Runtime.enable');
  await send('Page.enable');
  for (const m of FALLBACK || OFFLINE ? ['desktop'] : MODES) {
    mode = m;
    if (m === 'mobile') {
      await send('Emulation.setDeviceMetricsOverride', { width: LAND ? 844 : 390, height: LAND ? 390 : 844, deviceScaleFactor: 2, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    } else {
      await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
    if (OFFLINE) await scenarioOffline(); else if (FALLBACK) await scenarioFallback(); else await scenario();
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
