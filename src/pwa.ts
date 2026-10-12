// PWA: регистрация Service Worker, офлайн-оболочка, индикатор сети. Владелец: задача A.
import { registerSW } from 'virtual:pwa-register';
import { toast, openSheet } from './app';

/** Зарегистрировать Service Worker (production или VITE_PWA_DEV=1). */
export function initPwa(): void {
  window.addEventListener('offline', () => toast('Нет сети: работают скачанные районы и свои карты', 4500));
  window.addEventListener('online', () => toast('Сеть появилась'));

  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV && import.meta.env.VITE_PWA_DEV !== '1') return;

  const update = registerSW({
    onOfflineReady: () => toast('Готово к работе без сети'),
    onNeedRefresh: () => {
      const box = document.createElement('div');
      const p = document.createElement('p');
      p.textContent = 'Доступна новая версия — обновить? Несохранённые расчёты будут потеряны.';
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = 'Обновить';
      btn.onclick = () => void update(true);
      box.append(p, btn);
      openSheet('Обновление', box);
    },
    onRegisterError: (e) => console.warn('SW:', e),
  });
}
