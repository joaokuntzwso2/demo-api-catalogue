import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
        '/api/catalogue-sync': {
          target: 'http://host.docker.internal:6400',
          changeOrigin: true,
          secure: false
        },
        '/api/runtime-control': {
          target: 'http://host.docker.internal:6400',
          changeOrigin: true,
          secure: false
        },
        '/api/contract-validation': {
          target: 'http://host.docker.internal:6400',
          changeOrigin: true,
          secure: false
        },
      '/catalogue-status/v1/apis': { target: 'http://host.docker.internal:6400', changeOrigin: true, secure: false, rewrite: () => '/api/catalogue-status/apis' },
      '/catalogue-status/v1/summary': { target: 'http://host.docker.internal:6400', changeOrigin: true, secure: false, rewrite: () => '/api/catalogue-status/summary' }
    }
  }
});