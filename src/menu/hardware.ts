// Меню → «Аппаратура и высота»: аппаратура по линиям, местность у пульта, режим высоты, «Для опытных»
// (итог и числовые параметры линий). Сама высота дрона — в строке связи, высоты для сравнения — в зоне покрытия.
import { S, toast, emit } from '../app';
import { h, field, button, details } from '../ui';
import { presetsFor, RadioParams, LineId, budget, freeSpaceRange, radioHorizon } from '../radio';
import { applyPreset, effRadio, effVideoOrNull } from '../station';
import { presetName } from '../verdict';
import { km } from '../format';
import { CLUTTER, clutterLoss } from '../clutter';
import { fire, render, section, num } from './common';
import { antennaPanel } from '../antennaUi';

const RADIO_FIELDS: { key: keyof RadioParams; label: string; min: number; max: number; step: string; hint?: (v: number) => string }[] = [
  { key: 'freqMHz', label: 'Частота, МГц', min: 1, max: 100000, step: '1' },
  { key: 'txPowerDbm', label: 'Мощность передатчика, дБм', min: -30, max: 60, step: '1', hint: (v) => `≈ ${+(10 ** (v / 10)).toPrecision(3)} мВт` },
  { key: 'txGainDbi', label: 'Усиление антенны пульта, дБи', min: -10, max: 50, step: '0.5' },
  { key: 'rxGainDbi', label: 'Усиление антенны дрона, дБи', min: -10, max: 50, step: '0.5' },
  { key: 'sensDbm', label: 'Чувствительность приёмника, дБм', min: -170, max: -30, step: '1' },
  { key: 'lossDb', label: 'Потери в тракте, дБ', min: 0, max: 60, step: '0.5' },
  { key: 'clutterDb', label: 'Потери на местности (лес, застройка), дБ', min: 0, max: 60, step: '1' },
  { key: 'fadeMarginDb', label: 'Желаемый запас, дБ', min: 0, max: 60, step: '1' },
  { key: 'k', label: 'Коэффициент рефракции k', min: 0.5, max: 3, step: '0.01' },
];

let calcTab: LineId = 'rc';
let advOpen = false; // «Для опытных» остаётся раскрытым при перерисовке раздела
const lineRadio = (line: LineId) => (line === 'rc' ? S.radio : S.video.radio);
const linePreset = (line: LineId) => (line === 'rc' ? S.presetId : S.video.presetId);
/** Подписи полей для видео: передатчик — на дроне, приёмник — на земле. */
const VIDEO_LABELS: Partial<Record<keyof RadioParams, string>> = {
  txPowerDbm: 'Мощность видеопередатчика, дБм',
  txGainDbi: 'Усиление антенны дрона (VTX), дБи',
  rxGainDbi: 'Усиление антенны приёма на земле, дБи',
};

function lineParams(el: HTMLElement, line: LineId, upd: () => void) {
  const R = lineRadio(line);
  for (const f of RADIO_FIELDS) {
    const label = (line === 'video' && VIDEO_LABELS[f.key]) || f.label;
    const row = field(label, `<input type="number" inputmode="decimal" step="${f.step}">`);
    const inp = row.querySelector('input') as HTMLInputElement;
    inp.value = String(R[f.key]);
    const hint = h('<p class="hint" style="margin:-4px 0 4px;text-align:right"></p>');
    const showHint = () => { hint.textContent = f.hint ? f.hint(R[f.key]) : ''; hint.hidden = !f.hint; };
    showHint();
    inp.addEventListener('change', () => {
      const v = num(inp.value);
      if (!Number.isFinite(v) || v < f.min || v > f.max) { inp.value = String(R[f.key]); toast(`${label}: от ${f.min} до ${f.max}`); return; }
      R[f.key] = v;
      if (line === 'rc') S.presetId = 'custom'; else S.video.presetId = 'custom';
      fire('radio'); showHint(); upd();
    });
    el.append(row, hint);
  }
}

export function hardware(el: HTMLElement) {
  // ----- аппаратура: два выпадающих списка с человеческими названиями -----
  section(el, 'Аппаратура');
  const presetSelect = (line: LineId, label: string) => {
    const row = field(label, '<select></select>');
    row.classList.add('col'); // подпись над списком: названия аппаратуры длинные
    const sel = row.querySelector('select') as HTMLSelectElement;
    const add = (value: string, text: string) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); };
    if (line === 'video') add('off', 'Не учитывать видео');
    for (const p of presetsFor(line)) add(p.id, presetName(p));
    if (linePreset(line) === 'custom') add('custom', 'Свои параметры (вручную)');
    sel.value = line === 'video' && !S.video.enabled ? 'off' : linePreset(line);
    sel.addEventListener('change', () => {
      if (sel.value === 'off') { S.video.enabled = false; emit('radio'); render(); return; }
      if (sel.value === 'custom') { if (line === 'video') { S.video.enabled = true; emit('radio'); } render(); return; }
      applyPreset(sel.value, line); render();
    });
    el.appendChild(row);
    const p = presetsFor(line).find((x) => x.id === linePreset(line));
    if (p && !(line === 'video' && !S.video.enabled)) {
      const n = h('<p class="hint muted"></p>'); n.textContent = p.note; el.appendChild(n);
    }
  };
  presetSelect('rc', 'Управление');
  presetSelect('video', 'Видео');

  section(el, 'Местность у пульта');
  const cseg = h('<div class="seg"></div>');
  for (const c of CLUTTER) {
    const b = button(c.name, S.clutter === c.id ? 'on' : '', () => { S.clutter = c.id; emit('radio'); render(); });
    b.title = c.hint;
    cseg.appendChild(b);
  }
  el.appendChild(cseg);
  const cur = CLUTTER.find((c) => c.id === S.clutter)!;
  const ch = h('<p class="hint muted"></p>');
  ch.textContent = `${cur.hint[0].toUpperCase()}${cur.hint.slice(1)}${clutterLoss(S.clutter, S.radio.freqMHz) ? ` — сигнал слабее на ${Math.round(clutterLoss(S.clutter, S.radio.freqMHz))} дБ` : ''}.`;
  el.appendChild(ch);

  antennas(el);

  el.appendChild(h('<p class="hint muted">Высота дрона — над точкой взлёта, как её показывает барометр в очках. Её задают на высотомере у края карты.</p>'));

  // ----- для опытных: итог и числовые параметры линий -----
  const adv = details('Для опытных', advOpen, (v) => { advOpen = v; });
  el.appendChild(adv);

  const summary = h('<div class="kv"></div>');
  const upd = () => {
    const antH = S.station?.antH ?? 2;
    // Те же параметры, что у расчёта: местность и антенна на земле (направленная — в своём луче).
    const rc = effRadio(), vd = effVideoOrNull();
    const hz = radioHorizon(antH, S.droneH, S.radio.k);
    const rng = (p: typeof rc) => km(freeSpaceRange(p));
    const rows: [string, string][] = vd
      ? [['Дальность без рельефа, упр. / видео', `${rng(rc)} / ${rng(vd)}`],
         ['Потенциал, упр. / видео', `${Math.round(budget(rc))} / ${Math.round(budget(vd))} дБ`],
         [`Радиогоризонт (дрон ${S.droneH} м)`, km(hz)]]
      : [['Дальность без рельефа', rng(rc)], ['Энергетический потенциал', `${Math.round(budget(rc))} дБ`], [`Радиогоризонт (дрон ${S.droneH} м)`, km(hz)]];
    summary.innerHTML = '';
    for (const [k, v] of rows) {
      const d = h('<div><small></small><b class="num"></b></div>');
      d.querySelector('small')!.textContent = k; d.querySelector('b')!.textContent = v;
      summary.appendChild(d);
    }
  };
  upd();
  adv.appendChild(summary);

  const tabs = h('<div class="seg"></div>');
  for (const [id, t] of [['rc', 'Управление'], ['video', 'Видео']] as const) {
    tabs.appendChild(button(t, calcTab === id ? 'on' : '', () => { calcTab = id; render(); }));
  }
  adv.appendChild(tabs);
  if (calcTab === 'video' && !S.video.enabled) adv.appendChild(h('<p class="hint">Видео не учитывается — выберите его в списке «Видео» выше.</p>'));
  else {
    if (linePreset(calcTab) === 'custom') adv.appendChild(h('<p class="hint">Параметры изменены вручную.</p>'));
    lineParams(adv, calcTab, upd);
    adv.appendChild(h('<p class="hint">Пресеты ориентировочные — подставьте паспортные данные своей аппаратуры.</p>'));
  }
}

/** Антенны на земле — тот же блок, что в шторке пульта (нажатие на 📡 на карте). */
function antennas(el: HTMLElement) {
  section(el, 'Антенны на земле');
  el.appendChild(h('<p class="hint muted">То же — в шторке пульта: нажмите на 📡 на карте.</p>'));
  antennaPanel(el, render);
}
