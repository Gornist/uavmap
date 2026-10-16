// Настройка антенн на земле: тип и направление — отдельно для пульта (управление) и видеоприёмника.
// Один и тот же блок — в шторке пульта (нажатие на 📡 на карте) и в меню «Аппаратура и высота».
import { S, center, emit, toast } from './app';
import { h, button, field } from './ui';
import { ANTENNA_TYPES, AntennaKind, directional, rumb, angleOff } from './antenna';
import { bearing } from './geo';
import type { LineId } from './radio';

/** Цвета лучей на карте: управление — акцент, видео — голубой (те же — у меток в блоке настройки). */
export const BEAM_COLOR: Record<LineId, string> = { rc: '#d9a446', video: '#4aa3ff' };
export const LINE_TITLE: Record<LineId, string> = { rc: 'Пульт (управление)', video: 'Видеоприёмник' };

/** Направление от пульта на прицел, ° (null — пульта нет или прицел на нём). */
export function aimToCross(): number | null {
  const st = S.station;
  if (!st) return null;
  const c = center();
  return Math.abs(c.lat - st.lat) + Math.abs(c.lon - st.lon) < 1e-6 ? null : Math.round(bearing(st, c)) % 360;
}

const changed = () => { emit('radio'); emit('station'); };

/** Направить антенну линии на прицел; false — некуда (нет пульта или прицел на нём). */
export function aimLine(line: LineId): boolean {
  const az = aimToCross();
  if (az === null) return false;
  S.antenna[line].heading = az;
  changed();
  return true;
}

/** Блок «Антенны»: rerender — перерисовать содержащий экран после смены типа. */
export function antennaPanel(el: HTMLElement, rerender: () => void): void {
  const num = (s: string) => parseFloat(s.replace(',', '.'));
  const card = (line: LineId) => {
    let a = S.antenna[line];
    const box = h('<div class="ant-card"></div>');
    box.appendChild(h(`<p class="ant-label"><i style="background:${BEAM_COLOR[line]}"></i></p>`)).append(LINE_TITLE[line]);
    const seg = h('<div class="seg seg-wrap"></div>');
    for (const k of Object.keys(ANTENNA_TYPES) as AntennaKind[]) {
      const t = ANTENNA_TYPES[k];
      seg.appendChild(button(k === 'omni' || k === 'custom' ? t.name : `${t.name} ${t.beamDeg}°`, a.kind === k ? 'on' : '', () => {
        const was = directional(a);
        const keep = k === 'custom' && was;
        S.antenna[line] = { kind: k, gainDbi: keep ? a.gainDbi : t.gainDbi, beamDeg: keep ? a.beamDeg : t.beamDeg, heading: a.heading };
        // Стала направленной — сразу на прицел: «на север» по умолчанию никому не нужно.
        if (!was && k !== 'omni') { const az = aimToCross(); if (az !== null) S.antenna[line].heading = az; }
        changed(); rerender();
      }));
    }
    box.appendChild(seg);
    if (a.kind === 'custom') {
      for (const [key, lab, lo, hi] of [['gainDbi', 'Усиление, дБи', 0, 40], ['beamDeg', 'Ширина луча (по −3 дБ), °', 5, 180]] as const) {
        const f = field(lab, '<input type="number" inputmode="decimal" step="1">');
        const inp = f.querySelector('input') as HTMLInputElement;
        inp.value = String(a[key]);
        inp.addEventListener('change', () => {
          const v = num(inp.value);
          if (!Number.isFinite(v) || v < lo || v > hi) { inp.value = String(a[key]); toast(`${lab}: от ${lo} до ${hi}`); return; }
          a[key] = v; changed();
        });
        box.appendChild(f);
      }
    } else if (a.kind !== 'omni') {
      box.appendChild(h('<p class="hint muted"></p>')).textContent = `${a.gainDbi} дБи в луче ${a.beamDeg}°, сзади слабее на ${ANTENNA_TYPES[a.kind].fbrDb} дБ.`;
    }
    if (directional(a)) {
      // Азимут антенны — от севера по часовой, как на компасе и как «аз.» в строке связи; рядом румб (С, СВ, В…).
      const row = h('<div class="ant-dir"><label><span>Азимут</span><input type="number" inputmode="numeric" min="0" max="359" step="1"><b class="ant-rumb"></b></label></div>');
      const inp = row.querySelector('input') as HTMLInputElement;
      const rb = row.querySelector('.ant-rumb') as HTMLElement;
      const ref = h('<p class="hint ant-ref"></p>');
      const show = () => {
        inp.value = String(Math.round(a.heading));
        rb.textContent = `° ${rumb(a.heading)}`;
        // Подсказка: азимут на прицел и попадает ли прицел в луч — сверять с компасом при установке антенны.
        const az = aimToCross();
        ref.className = 'hint ant-ref';
        if (az === null) { ref.textContent = 'Азимут — от севера по часовой стрелке, как на компасе.'; return; }
        const off = Math.round(angleOff(az, a.heading));
        ref.textContent = `На прицел — азимут ${az}° ${rumb(az)}${off <= a.beamDeg / 2 ? ', прицел в луче' : `, прицел вне луча (на ${off}°)`}.`;
        ref.classList.add(off <= a.beamDeg / 2 ? 'status-ok' : 'status-weak');
      };
      show();
      inp.addEventListener('change', () => {
        const v = num(inp.value);
        if (!Number.isFinite(v)) { show(); toast('Азимут: градусы от севера по часовой, 0–359'); return; }
        a = S.antenna[line];
        a.heading = ((Math.round(v) % 360) + 360) % 360;
        show(); changed();
      });
      row.appendChild(button('На прицел', 'ghost', () => {
        if (!aimLine(line)) { toast('Поставьте пульт и наведите прицел на цель'); return; }
        a = S.antenna[line]; show();
      }));
      box.append(row, ref);
    }
    el.appendChild(box);
  };
  card('rc');
  if (S.video.enabled) card('video');
  el.appendChild(h('<p class="hint muted">Направленная антенна (патч, яги): усиление — только в её луче, зона покрытия — сектор, на карте у пульта показан луч. Её усиление заменяет усиление антенны на земле из аппаратуры.</p>'));
}
