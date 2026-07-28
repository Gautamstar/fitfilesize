import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, proxy API calls to the FastAPI backend on :8000 so the browser sees
// one origin and CORS never comes up. In production the frontend is served from
// a different host, so the API base comes from VITE_API_URL instead.
export default defineConfig({
  plugins: [react()],
  server: {
    // 5173 is taken by edaProj's frontend
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
