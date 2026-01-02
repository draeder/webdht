import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
  },
  resolve: {
    alias: {
      partialmesh: resolve(__dirname, 'src/vendor/partialmesh.ts'),
      'gossip-protocol': resolve(__dirname, 'src/vendor/gossip-protocol.ts'),
    },
  },
});
