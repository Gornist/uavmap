// Полифиллы без зависимостей. Отдельный модуль: импорты выполняются раньше тела модуля,
// а MapLibre при загрузке уже обращается к globalThis — этот файл должен выполниться до него.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g: any = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
if (typeof (g as any).globalThis === 'undefined') g.globalThis = g; // Chrome 71

if (!Object.fromEntries) { // Chrome 73
  (Object as any).fromEntries = (it: Iterable<readonly [PropertyKey, unknown]>) => {
    const o: Record<PropertyKey, unknown> = {};
    for (const [k, v] of it) o[k] = v;
    return o;
  };
}

if (!(Promise as any).allSettled) { // Chrome 76
  (Promise as any).allSettled = (ps: Iterable<unknown>) => Promise.all(Array.from(ps, (p) =>
    Promise.resolve(p).then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }))));
}

if (!(String.prototype as any).matchAll) { // Chrome 73
  (String.prototype as any).matchAll = function* (this: string, re: RegExp) {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = r.exec(this))) { yield m; if (m[0] === '') r.lastIndex++; }
  };
}

if (!(Array.prototype as any).flat) { // Chrome 69
  (Array.prototype as any).flat = function (this: unknown[], depth = 1): unknown[] {
    return depth < 1 ? this.slice() : this.reduce<unknown[]>((a, v) => a.concat(Array.isArray(v) ? (v as any).flat(depth - 1) : v), []);
  };
  (Array.prototype as any).flatMap = function (this: unknown[], f: (v: unknown, i: number, a: unknown[]) => unknown) {
    return (this.map(f) as any).flat(1);
  };
}


// gap у flexbox — с Chrome 84. Без него элементы слипаются; .no-flexgap включает запасные отступы в style.css.
if (typeof document !== 'undefined') {
  const mark = () => {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
    d.appendChild(document.createElement('div')); d.appendChild(document.createElement('div'));
    document.documentElement.appendChild(d);
    if (d.scrollHeight !== 1) document.documentElement.classList.add('no-flexgap');
    d.remove();
  };
  if (document.documentElement) mark(); else document.addEventListener('DOMContentLoaded', mark);

  // env() — с Chrome 69. Без него calc(… var(--safe-b)) недействителен целиком и позиции панелей сбрасываются.
  const css = (window as any).CSS;
  if (!(css && css.supports && css.supports('top: env(safe-area-inset-top, 0px)'))) {
    for (const s of ['b', 't', 'l', 'r']) document.documentElement.style.setProperty(`--safe-${s}`, '0px');
  }
}

export {};
