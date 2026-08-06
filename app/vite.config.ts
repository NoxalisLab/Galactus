import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no auto-open.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
  build: {
    target: "safari15",
    outDir: "dist",
  },
});
