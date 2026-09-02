import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 真库测试共享同一个 KB_TEST_DATABASE_URL，并行文件会互相 DROP SCHEMA 撞车，串行跑。
    fileParallelism: false,
  },
});
