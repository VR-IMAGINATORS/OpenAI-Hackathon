import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/web',
  // Never load the repository root's private .env into the frontend.
  envDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false } },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
