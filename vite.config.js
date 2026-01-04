import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    host: '0.0.0.0', // Expose on network
  },
  resolve: {
    alias: {
      'gossip-protocol': resolve(__dirname, 'src/vendor/gossip-protocol.ts'),
    },
  },
  define: {
    __DEV__: true,
  },
  optimizeDeps: {
    exclude: ['@koush/wrtc', 'simple-peer'],
  },
});
