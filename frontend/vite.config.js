import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    proxy: {
      '/admin/api': 'http://localhost:3000',
      '/v1': 'http://localhost:3000',
    },
  },
})
