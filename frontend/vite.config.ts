import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The visualizer engine source lives in ``backend/visualizer_engine/src``
      // and is the SOURCE OF TRUTH for both the offline render (Node sidecar)
      // and the in-browser preview. Importing via this alias keeps the
      // frontend in sync without copy-pasting two parallel files.
      "@visualizer": path.resolve(__dirname, "../backend/visualizer_engine/src"),
    },
  },
  server: {
    // Vite blocks file access outside the workspace root by default. We need
    // to whitelist the visualizer engine source so the @visualizer/* alias
    // can be served during dev.
    fs: {
      allow: [
        path.resolve(__dirname),
        path.resolve(__dirname, "../backend/visualizer_engine/src"),
      ],
    },
    proxy: {
      "/api": "http://localhost:8000",
      "/files": "http://localhost:8000",
    },
  },
})
