import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/catalogue-status/v1/apis': {
        target: 'http://health-status-cache:6300',
        changeOrigin: true,
        rewrite: () => '/cache/results'
      },
      '/catalogue-status/v1/summary': {
        target: 'http://health-status-cache:6300',
        changeOrigin: true,
        rewrite: () => '/cache/summary'
      }
    }
  }
});