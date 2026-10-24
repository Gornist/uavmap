// Каталог интерфейса (design.html): цвета обеих тем с контрастом, шрифты и компоненты в разных состояниях —
// на настоящих стилях приложения, чтобы каталог не расходился с кодом. Правила и роли — docs/DESIGN.md.
// Только для разработки (в сборку не входит). Настройки устройства (тема, «Яркое солнце») здесь не сохраняются.
import '../style.css';
import '../styles/main.css';
import '../styles/live.css';
import '../styles/coverage.css';
import './preview.css';
import { THEMES, STATUS_MAP, BEAM_COLOR, MAP_THEME, contrast, ThemeName, ThemeTokens } from '../theme';

const root = document.documentElement;
const pv = document.getElementById('pv')!;
const esc = (t: string) => t.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Управление: тема и режимы читаемости ----------
let theme: ThemeName = 'day';
const setTheme = (t: ThemeName) => { theme = t; root.setAttribute('data-theme', t); render(); };
const toggle = (cls: string) => { root.classList.toggle(cls); render(); };

// ---------- Разделы ----------
/** Текстовые токены и к какому фону мерить их контраст (как в theme.test.ts). */
const TEXT: [keyof ThemeTokens, keyof ThemeTokens, number][] = [
  ['text', 'panel', 7], ['muted', 'panel', 4.5], ['accent-text', 'panel', 4.5], ['accent-ink', 'accent', 4.5],
  ['ok', 'panel', 4.5], ['weak', 'panel', 4.5], ['none', 'panel', 4.5],
  ['ok', 'ok-bg', 4.5], ['weak', 'weak-bg', 4.5], ['none', 'none-bg', 4.5],
];

function colors(): string {
  const t = THEMES[theme];
  const sw = (k: string, v: string) => `<div class="pv-sw"><i style="background:${v}"></i><b>--${esc(k)}</b><span class="mono">${esc(v)}</span></div>`;
  const tokens = (Object.keys(t) as (keyof ThemeTokens)[]).map((k) => sw(k, t[k])).join('');
  const rows = TEXT.map(([fg, bg, need]) => {
    const c = contrast(t[fg], t[bg]);
    return `<tr><td><span class="pv-chip" style="color:${t[fg]};background:${t[bg]}">Связь есть 1,3 км</span></td>`
      + `<td class="mono">--${fg} на --${bg}</td><td class="num ${c >= need ? 'status-ok' : 'status-none'}">${c.toFixed(1)} : 1 ${c >= need ? '✓' : '✕'} (нужно ${need})</td></tr>`;
  }).join('');
  const map = (name: string, v: string) => `<div class="pv-sw"><i style="background:${v}"></i><b>${esc(name)}</b><span class="mono">${esc(v)}</span></div>`;
  const mt = MAP_THEME[theme];
  return `<h2>Цвета — ${theme === 'day' ? 'День' : 'Ночь'}</h2>
    <div class="pv-grid">${tokens}</div>
    <h3>Контраст текста</h3>
    <table class="pv-t"><tr><th>Образец</th><th>Пара</th><th>Контраст</th></tr>${rows}</table>
    <h3>На карте</h3>
    <div class="pv-grid">${map('управление', BEAM_COLOR.rc)}${map('видео', BEAM_COLOR.video)}${map('есть', STATUS_MAP.ok)}${map('на грани', STATUS_MAP.weak)}${map('нет', STATUS_MAP.none)}${map('обводка', mt.casing)}${map('маршрут', mt.route)}</div>
    <div class="pv-lines">${(['rc', 'video'] as const).map((l) => `<svg viewBox="0 0 220 24" width="220" height="24"><path d="M4 12 H216" stroke="${mt.casing}" stroke-opacity="${mt.casingOpacity}" stroke-width="${l === 'video' ? 9 : 6}" stroke-linecap="round"/><path d="M4 12 H216" stroke="${BEAM_COLOR[l]}" stroke-width="${l === 'video' ? 5 : 2}" stroke-linecap="round"/></svg><span>${l === 'rc' ? 'граница управления' : 'граница видео'}</span>`).join('')}</div>`;
}

function type(): string {
  return `<h2>Шрифты</h2>
    <p class="pv-type" style="font: 600 20px var(--font-ui)">Golos Text 600 — Связь есть · 1,3 км</p>
    <p class="pv-type">Golos Text 400, 16 px — Поднимите до 440 м — будет управление; видео 5,8 ГГц не добьёт</p>
    <p class="pv-type muted" style="font-size:13px">13 px, вторичный — Упр. <span class="num">+25 дБ</span> · Видео <span class="num">+14 дБ</span> · аз. <span class="num">313°</span></p>
    <p class="pv-type mono">JetBrains Mono — X 48<em>39</em>128 Y 75<em>97</em>237 · 0O 1lI</p>
    <p class="pv-type num">Табличные цифры: 1111 м · 8888 м · 1,0 км · 10,4 км</p>`;
}

function buttons(): string {
  return `<h2>Кнопки</h2>
    <div class="pv-row"><button class="primary">Рассчитать</button><button class="ghost">Закрыть</button><button class="danger">Удалить</button><button class="primary" disabled>Неактивна</button></div>
    <div class="seg" style="max-width:420px"><button>Всенаправленная</button><button class="on">Патч 60°</button><button>Яги 30°</button><button>Своя</button></div>
    <div class="chips pv-row"><button class="on">5 км</button><button>10 км</button><button>15 км</button></div>
    <div class="pv-row pv-mapbar">
      <div class="zoom-pill"><button aria-label="Приблизить">+</button><button aria-label="Отдалить">−</button></div>
      <button class="round" aria-label="Где я"><svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="4.6" r="2.4" fill="currentColor"/><path d="M12 8.2c-2 0-3.4 1.1-3.4 3v4.2h1.8V22h3.2v-6.6h1.8v-4.2c0-1.9-1.4-3-3.4-3z" fill="currentColor"/></svg></button>
      <button class="round on" aria-label="Линия к прицелу (вкл.)"><svg viewBox="0 0 24 24" width="22" height="22"><circle cx="5" cy="19" r="2.6" fill="currentColor"/><path d="M7 17 L16 8" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2"/><circle cx="18" cy="6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M18 1v2.4M18 8.6V11M13 6h2.4M20.6 6H23" stroke="currentColor" stroke-width="1.6"/></svg></button>
      <button class="round" aria-label="К пульту">⌂</button>
      <span class="muted">кнопки карты; «Линия к прицелу» — включена (.on)</span>
    </div>
    <nav id="bottomBar" class="pv-static"><button><span class="ico">⚑</span><span class="tx">Метка</span></button><button><span class="ico">◎</span><span class="tx">Зона</span></button><button><span class="ico">◆</span><span class="tx">Где встать</span></button><button><span class="ico">☰</span><span class="tx">Меню</span></button></nav>`;
}

/** Состояния строки связи — как их собирает live.ts (renderStrip). */
const STRIP: Record<string, string> = {
  'есть': `<div class="ls-verdict status-ok">✓ Связь есть · <span class="num">1,3 км</span><span class="ls-more">›</span></div><div class="ls-need">Управление и видео держатся; можно снизиться до 302 м</div><div class="ls-sub muted">Упр. <span class="status-ok num">+30 дБ</span> · Видео <span class="status-ok num">+23 дБ</span> · аз. <span class="num">272°</span> · <span class="status-ok">офлайн ✓</span></div>`,
  'на грани': `<div class="ls-verdict status-weak">⚠ Видео на грани · <span class="num">2,5 км</span><span class="ls-more">›</span></div><div class="ls-need">Видео 5,8 ГГц на грани и на 1500 м — подойдите ближе</div><div class="ls-sub muted">Упр. <span class="status-ok num">+20 дБ</span> · Видео <span class="status-weak num">+8 дБ</span> · аз. <span class="num">71°</span> · лес <span class="num">−12 дБ</span></div>`,
  'нет + антенна': `<div class="ls-verdict status-none">✕ Нет видео · <span class="num">669 м</span><span class="ls-more">›</span></div><div class="ls-need">Поднимите до 440 м — будет управление; видео 5,8 ГГц не добьёт</div><div class="ls-sub muted">Упр. <span class="status-weak num">+1 дБ</span> · Видео <span class="status-none num">−23 дБ</span> · аз. <span class="num">48°</span> · лес <span class="num">−43 дБ</span> · <span class="status-none">видео пропадёт на <span class="num">162 м</span></span></div><div class="ls-aim"><span class="status-weak">Прицел (аз. 48° СВ) вне луча антенны видео — аз. 200° ЮЮЗ</span><button class="ghost">Повернуть</button></div>`,
  'сообщение': `<div class="ls-msg">Нет данных рельефа здесь</div><button class="ghost ls-dl">Скачать район</button>`,
};
let stripState = 'есть';

function strip(): string {
  const tabs = Object.keys(STRIP).map((k) => `<button class="${k === stripState ? 'on' : ''}" data-strip="${esc(k)}">${esc(k)}</button>`).join('');
  return `<h2>Строка связи</h2>
    <div class="seg pv-seg">${tabs}</div>
    <div id="linkStrip" class="pv-static"><div id="lsMain"><div class="ls-status" id="lsStatus">${STRIP[stripState]}</div></div></div>
    <div class="pv-row" style="margin-top:12px">
      <div class="cov-pill pv-static-pill"><button type="button" class="cov-pill-main"><span class="cov-pill-t"><span class="cov-pill-w">Дрон </span>100 м · до 1,2 км</span><span class="cov-pill-lg cov-pill-lines"><i style="background:${BEAM_COLOR.rc}"></i><span class="cov-pill-n">упр.</span><i style="background:${BEAM_COLOR.video}"></i><span class="cov-pill-n">видео</span></span></button><button type="button" class="cov-pill-x" aria-label="Убрать зону">✕</button></div>
      <button class="cross-chip"><span>На 437 м выше пульта</span><span class="cc-more">›</span></button>
    </div>`;
}

/** Высотомер: полосы как у altimeter.ts (видео по высоте, склон штриховкой), подписи справа. */
function altimeter(): string {
  const GROUND = 'repeating-linear-gradient(135deg, #6b4f2f 0, #6b4f2f 6px, #4f3a22 6px, #4f3a22 12px)';
  const bands: [number, number, string, string][] = [[0, 22, GROUND, 'склон'], [22, 50, STATUS_MAP.none, ''], [50, 72, STATUS_MAP.weak, ''], [72, 100, STATUS_MAP.ok, '']];
  const b = bands.map(([f, t, bg, s]) => `<div class="alt-band" style="bottom:${f}%;height:${t - f}%;background:${bg}">${s ? `<span>${s}</span>` : ''}</div>`).join('');
  const ticks = [100, 200, 300, 400, 500].map((v) => `<div class="alt-tick" style="bottom:${v / 6}%">${v}</div>`).join('');
  return `<h2>Высотомер</h2>
    <div class="pv-alt">
      <div class="altimeter pv-static-alt" role="img" aria-label="Пример высотомера">
        <div class="alt-cap alt-name">Дрон</div>
        <div class="alt-track"><div class="alt-bands">${b}</div><div class="alt-ticks">${ticks}
          <div class="alt-need alt-need-weak" style="bottom:50%">видео на грани от 300 м</div>
          <div class="alt-need alt-need-rc" style="bottom:72%">упр. от 432 м</div></div>
          <div class="alt-drone" style="bottom:${450 / 6}%"><button type="button" class="alt-lbl">450</button></div></div>
        <div class="alt-cap">м над <br>взлётом</div>
      </div>
      <p class="pv-note" style="max-width:340px">Цвет — видео на этой высоте (без видеоприёмника — управление); штриховка — дрон был бы в склоне у прицела; золотая подпись — управлению нужно выше, чем видео.</p>
    </div>`;
}

function sheet(): string {
  return `<h2>Шторка и сообщения</h2>
    <section class="pv-sheet card">
      <div class="sh-head"><h3>Профиль до прицела · 1,3 км</h3><button class="mini">✕</button></div>
      <div class="verdict verdict-big status-ok">✓ Связь есть</div>
      <div class="verdict verdict-big status-weak">⚠ Видео на грани</div>
      <div class="verdict verdict-big status-none">✕ Нет связи</div>
      <p class="verdict-why">Лес на пути: 140 м сквозь кроны, сигнал у видео слабее на 43 дБ.</p>
      <details class="details"><summary>Подробнее</summary><p class="hint">Модель: свободное пространство + дифракция на рельефе.</p></details>
      <div class="row"><button class="primary">Рассчитать</button><button class="ghost">Закрыть</button></div>
    </section>
    <div id="toast" class="show pv-static">Пульт поставлен. Двигайте карту — прицел покажет связь.</div>`;
}

function render() {
  const big = root.classList.contains('big-text'), sun = root.classList.contains('sun');
  pv.innerHTML = `<header class="pv-head">
      <h1>Радиус — каталог интерфейса</h1>
      <p class="muted">Правила — docs/DESIGN.md. Здесь — настоящие стили приложения.</p>
      <div class="pv-row">
        <div class="seg pv-seg"><button class="${theme === 'day' ? 'on' : ''}" data-theme-set="day">День</button><button class="${theme === 'night' ? 'on' : ''}" data-theme-set="night">Ночь</button></div>
        <label class="chk"><input type="checkbox" data-cls="sun"${sun ? ' checked' : ''}><span><span class="chk-t">Яркое солнце</span></span></label>
        <label class="chk"><input type="checkbox" data-cls="big-text"${big ? ' checked' : ''}><span><span class="chk-t">Крупный текст</span></span></label>
      </div>
    </header>
    <div class="pv-map">${strip()}${altimeter()}</div>
    ${buttons()}${sheet()}${type()}${colors()}`;
}

pv.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const th = t.closest<HTMLElement>('[data-theme-set]');
  if (th) { setTheme(th.dataset.themeSet as ThemeName); return; }
  const st = t.closest<HTMLElement>('[data-strip]');
  if (st) { stripState = st.dataset.strip!; render(); }
});
pv.addEventListener('change', (e) => {
  const c = (e.target as HTMLElement).closest<HTMLInputElement>('[data-cls]');
  if (c) toggle(c.dataset.cls!);
});

setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day');
