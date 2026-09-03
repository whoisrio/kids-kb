import { defineConfig } from "@playwright/test";

/**
 * 全栈 E2E：真实三服务 + 本机 ollama + PostgreSQL。
 * 服务编排：三个 webServer 各自 reuseExistingServer——已在跑的复用，缺的由 Playwright 拉起并托管。
 * 前置：pipeline .venv、ollama（chat/embed 模型）、PostgreSQL 就绪。
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5200",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "uv run python -m kb.cli serve-internal",
      cwd: "../pipeline",
      url: "http://127.0.0.1:8766/openapi.json",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      // CHAT_MODELS：保证 ≥2 个可切换模型（模型切换用例依赖；dotenv 不覆盖已有环境变量）
      command: "npm run dev",
      cwd: "../backend",
      url: "http://127.0.0.1:8787/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
      env: { CHAT_MODELS: process.env.CHAT_MODELS ?? "qwen3.5:4b,qwen3.5:2b" },
    },
    {
      command: "npm run dev",
      cwd: "../frontend",
      url: "http://127.0.0.1:5200",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
