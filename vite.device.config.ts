import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  worker: { format: 'es' },
  build: {
    outDir: 'dist/device-check', emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL('./src/diagnostics/main.tsx', import.meta.url)),
      formats: ['es'], fileName: 'device-check', cssFileName: 'device-check' },
  },
  plugins: [{ name: 'device-validation-html', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'index.html', source: readFileSync(new URL('./device-check/index.html', import.meta.url), 'utf8') });
  } }],
});
