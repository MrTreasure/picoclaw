import path from "path"

import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      // Auto-split route chunks can import useNavigate from the entry chunk
      // through a circular reference; the generated import points at a DOM
      // event constant instead. Keep routes in the entry until this is fixed.
      autoCodeSplitting: false,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 2048,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:18800",
        changeOrigin: true,
      },
      "/pico/media": {
        target: "http://localhost:18800",
        changeOrigin: true,
      },
      "/pico/ws": {
        target: "ws://localhost:18800",
        ws: true,
      },
    },
  },
})
