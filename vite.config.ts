/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// base — путь на GitHub Pages: https://gornist.github.io/uavmap/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/uavmap/' : '/',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
