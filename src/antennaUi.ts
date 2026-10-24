// Настройка антенн на земле: тип и направление — отдельно для пульта (управление) и видеоприёмника.
// Один и тот же блок — в шторке пульта (нажатие на 📡 на карте) и в меню «Аппаратура и высота».
import { S, center, emit, toast } from './app';
import { h, button, field } from './ui';
import { ANTENNA_TYPES, AntennaKind, directional, rumb, angleOff, elevationDeg, hasVertical, TILT_MIN, TILT_MAX, azTerm, elTerm } from './antenna';
import { bearing, distance, R_EARTH } from './geo';
import { clampK, LineId } from './radio';

import { BEAM_COLOR } from './theme';
export { BEAM_COLOR };
export const LINE_TITLE: Record<LineId, string> = { rc: 'Пульт (управление)', video: 'Видеоприёмник' };

/** Направление от пульта на прицел, ° (null — пульта нет или прицел на нём). */
export function aimToCross(): number | null {
  const st = S.station;
  if (!st) return null;
  const c = center();
  return Math.abs(c.lat - st.lat) + Math.abs(c.lon - st.lon) < 1e-6 ? null : Math.round(bearing(st, c)) % 360;
}

/**
 * Угол места с антенны линии на дрон на текущей высоте в d м от пульта, ° (null — пульта нет или d < 5 м, как у
 * расчёта трассы). Высота дрона — над точкой взлёта (droneAbs в station.ts), антенна — над землёй у пульта:
 * их разность от рельефа не зависит, кривизна — с k линии, как в analyzeLink.
 */
function elevAt(line: LineId, d: number): number | null {
  const st = S.station;
  if (!st || d < 5) return null;
  return elevationDeg(st.antH, S.droneH, d, clampK((line === 'rc' ? S.radio : S.video.radio).k) * R_EARTH);
}

const clampTilt = (v: number) => Math.min(TILT_MAX, Math.max(TILT_MIN, Math.round(v)));
const changed = () => emit('antenna');

/**
 * Навести антенну линии: азимут az и наклон на дрон на текущей высоте в d м от пульта (d < 5 м — наклон не трогаем).
 * Без события: зовущий сам решает, что пересчитать.
 */
export function pointAntenna(line: LineId, az: number, d: number): void {
  S.antenna[line].heading = az;
  const el = elevAt(line, d);
  if (el !== null) S.antenna[line].tiltDeg = clampTilt(el);
}

/** Направить антенну линии на прицел: азимут и наклон на дрон над прицелом; false — некуда (нет пульта или прицел на нём). */
export function aimLine(line: LineId): boolean {
  const az = aimToCross();
  if (az === null) return false;
  pointAntenna(line, az, distance(S.station!, center()));
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
        // Наклон сохраняется при смене типа; вертикальная ширина луча у патча и яги — как горизонтальная.
        S.antenna[line] = {
          kind: k, gainDbi: keep ? a.gainDbi : t.gainDbi, beamDeg: keep ? a.beamDeg : t.beamDeg, heading: a.heading,
          tiltDeg: a.tiltDeg ?? 0, beamVDeg: keep ? a.beamVDeg ?? a.beamDeg : t.beamDeg,
        };
        // Стала направленной — сразу на прицел: «на север» по умолчанию никому не нужно.
        if (!was && k !== 'omni') { const az = aimToCross(); if (az !== null) S.antenna[line].heading = az; }
        changed(); rerender();
      }));
    }
    box.appendChild(seg);
    if (a.kind === 'custom') {
      const fields = [['gainDbi', 'Усиление, дБи', 0, 40], ['beamDeg', 'Ширина луча (по −3 дБ), °', 5, 180],
        ['beamVDeg', 'Ширина луча по вертикали, °', 5, 180]] as const;
      for (const [key, lab, lo, hi] of fields) {
        const f = field(lab, '<input type="number" inputmode="decimal" step="1">');
        const inp = f.querySelector('input') as HTMLInputElement;
        const cur = () => a[key] ?? a.beamDeg; // beamVDeg нет только у объекта до этапа 7 — проект его всегда хранит
        inp.value = String(cur());
        inp.addEventListener('change', () => {
          const v = num(inp.value);
          if (!Number.isFinite(v) || v < lo || v > hi) { inp.value = String(cur()); toast(`${lab}: от ${lo} до ${hi}`); return; }
          a[key] = v; changed();
        });
        box.appendChild(f);
      }
    } else if (a.kind !== 'omni') {
      box.appendChild(h('<p class="hint muted"></p>')).textContent = `${a.gainDbi} дБи в луче ${a.beamDeg}° (и по горизонтали, и по вертикали), сзади слабее на ${ANTENNA_TYPES[a.kind].fbrDb} дБ.`;
    }
    if (directional(a)) {
      // Азимут антенны — от севера по часовой, как на компасе и как «аз.» в строке связи; рядом румб (С, СВ, В…).
      // Наклон — угол места оси, ° вверх от горизонта: пилоты задирают патч и яги на высокий дрон.
      const row = h(`<div class="ant-dir"><label><span>Азимут</span><input type="number" inputmode="numeric" min="0" max="359" step="1"><b class="ant-rumb"></b></label>`
        + `<label class="ant-tilt" title="Угол места оси антенны, градусы вверх от горизонта"><span>Наклон</span><input type="number" inputmode="numeric" min="${TILT_MIN}" max="${TILT_MAX}" step="1"><b>° вверх</b></label></div>`);
      const [inp, tilt] = Array.from(row.querySelectorAll('input'));
      const rb = row.querySelector('.ant-rumb') as HTMLElement;
      const ref = h('<p class="hint ant-ref"></p>');
      const show = () => {
        inp.value = String(Math.round(a.heading));
        tilt.value = String(a.tiltDeg ?? 0);
        rb.textContent = `° ${rumb(a.heading)}`;
        // Подсказка: азимут и угол места на прицел, попадает ли дрон над прицелом в луч — сверять при установке антенны.
        const az = aimToCross();
        ref.className = 'hint ant-ref';
        if (az === null) { ref.textContent = 'Азимут — от севера по часовой стрелке, как на компасе.'; return; }
        const off = Math.round(angleOff(az, a.heading));
        const el = elevAt(line, distance(S.station!, center()));
        const elOff = el === null ? 0 : Math.round(el - (a.tiltDeg ?? 0));
        // «В луче» — по тому же эллиптическому контуру −3 дБ, что и расчёт (azTerm + elTerm ≤ 3), а не по осям отдельно.
        const term = azTerm(a, az, a.heading) + (el !== null && hasVertical(a) ? elTerm(a, el) : 0);
        const vMain = el !== null && hasVertical(a) && elTerm(a, el) > azTerm(a, az, a.heading);
        const where = term <= 3 ? 'прицел в луче'
          : vMain ? `дрон ${elOff > 0 ? 'выше' : 'ниже'} луча (на ${Math.abs(elOff)}°)` : `прицел вне луча (на ${off}°)`;
        ref.textContent = `На прицел — азимут ${az}° ${rumb(az)}${el === null ? '' : `, угол места ${Math.round(el)}°`}, ${where}.`;
        ref.classList.add(where === 'прицел в луче' ? 'status-ok' : 'status-weak');
      };
      show();
      inp.addEventListener('change', () => {
        const v = num(inp.value);
        if (!Number.isFinite(v)) { show(); toast('Азимут: градусы от севера по часовой, 0–359'); return; }
        a = S.antenna[line];
        a.heading = ((Math.round(v) % 360) + 360) % 360;
        show(); changed();
      });
      tilt.addEventListener('change', () => {
        const v = num(tilt.value);
        a = S.antenna[line];
        if (!Number.isFinite(v) || v < TILT_MIN || v > TILT_MAX) { show(); toast(`Наклон: от ${TILT_MIN} до ${TILT_MAX}° (вверх от горизонта)`); return; }
        a.tiltDeg = Math.round(v);
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
  el.appendChild(h('<p class="hint muted">Направленная антенна (патч, яги): усиление — только в её луче, зона покрытия — сектор, на карте у пульта показан луч. Её усиление заменяет усиление антенны на земле из аппаратуры. Наклон учитывается по высоте дрона: на прицел — угол места на дрон над прицелом на текущей высоте.</p>'));
}
