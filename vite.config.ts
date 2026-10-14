/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { THEMES } from './src/theme';

// base — путь на GitHub Pages: https://gornist.github.io/uavmap/
// SW в dev выключен (мешает HMR); включить для отладки: VITE_PWA_DEV=1 npm run dev
export default defineConfig(({ command, mode }) => {
  const pwaDev = loadEnv(mode, '.', 'VITE_').VITE_PWA_DEV === '1';
  return {
    base: command === 'build' ? '/uavmap/' : '/',
    worker: { format: 'iife' }, // классический воркер: module workers только с Chrome 80
    // CSP-сборка MapLibre: без встроенного кода воркера (~70 КБ) — воркер грузится отдельным файлом (polyfills.ts).
    resolve: { alias: [{ find: /^maplibre-gl$/, replacement: 'maplibre-gl/dist/maplibre-gl-csp.js' }] },
    // chrome68: пульты-планшеты без Google Play живут на старом Chrome/WebView — транспилируем и зависимости.
    build: { target: ['es2017', 'chrome68'], sourcemap: true },
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
    plugins: [
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false, // регистрирует src/pwa.ts
        includeManifestIcons: false, // иконки уже попадают в precache по globPatterns — без дублей
        manifest: {
          name: 'uavmap — радиовидимость дрона',
          short_name: 'uavmap',
          lang: 'ru',
          display: 'standalone',
          // Манифест статичен: заставка и рамка — цвет фона ночной темы; во время работы theme.ts ставит цвет текущей темы.
          background_color: THEMES.night.bg,
          theme_color: THEMES.night.bg,
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
        injectManifest: {
          rollupFormat: 'iife',
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2,pbf}'], // woff2 — шрифты интерфейса, pbf — глифы карты, офлайн,
          globIgnores: ['**/*.map'],
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        },
        devOptions: { enabled: pwaDev, type: 'module', navigateFallback: 'index.html' },
      }),
    ],
  };
});
