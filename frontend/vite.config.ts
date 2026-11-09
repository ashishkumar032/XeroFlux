import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const proxy = { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } };
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], exclude: ['e2e/**', 'node_modules/**'] },
});
