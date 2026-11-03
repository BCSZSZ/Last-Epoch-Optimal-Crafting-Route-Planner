import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: process.env.PAGES_BASE ?? '/',
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts'], testTimeout: 30000 },
});
