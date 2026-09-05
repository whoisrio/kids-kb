import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 显式绑 IPv4 loopback：Node≥17 解析 localhost 可能只绦 ::1，
  // 而 Playwright 编排探测与文档地址都是 127.0.0.1（浏览器输 localhost 会自动回落）。
  server: { host: "127.0.0.1", port: 5200, proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
});
