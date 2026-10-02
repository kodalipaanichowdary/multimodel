import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const api = process.env.API_TARGET ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: api, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
