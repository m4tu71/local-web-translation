import { defineConfig } from 'vite';

export default defineConfig({
  base: '/local-web-translation/',
  server: {
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: 'localhost',
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
  },
});
