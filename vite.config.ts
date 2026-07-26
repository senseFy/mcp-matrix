import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  test: {
    fileParallelism: false,
  },
  build: {
    target: 'es2022',
  },
});
