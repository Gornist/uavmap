// Редкие части интерфейса — отдельными чанками: основной бандл меньше, старт быстрее.
// Офлайн они доступны так же — Service Worker кладёт в кеш оболочки все чанки сборки.
import type { LatLon } from './geo';
import { toast } from './app';

const loadFail = () => toast('Не удалось загрузить часть приложения — обновите страницу', 5000);
const profile = () => import('./profileSheet');

/** Шторка «Профиль трассы» (без цели — до прицела). */
export const showProfile = (target?: LatLon) => profile().then((m) => m.showProfile(target), loadFail);

/** Подгрузить чанки заранее, в простое после старта: первое открытие — без задержки на загрузку. */
export function preload(loaders: Array<() => Promise<unknown>>) {
  const go = () => { for (const l of [profile, ...loaders]) l().catch(() => { /* не страшно: загрузим при открытии */ }); };
  const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(go, { timeout: 5000 }); else setTimeout(go, 2000);
}
