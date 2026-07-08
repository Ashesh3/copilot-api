import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteSingleFile } from "vite-plugin-singlefile"

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/dashboard/api": {
        target: "http://localhost:4141",
        changeOrigin: true,
      },
      "/usage": {
        target: "http://localhost:4141",
        changeOrigin: true,
      },
    },
  },
})
