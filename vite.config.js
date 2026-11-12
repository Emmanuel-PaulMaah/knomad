import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8000,
    strictPort: true
  },
  preview: {
    port: 8000,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
