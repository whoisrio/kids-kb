import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resetDbForTest } from "./db.js";

describe("resetDbForTest 守卫", () => {
  it("库名不含 test 时拒绝执行（防误毁开发库）", async () => {
    await expect(resetDbForTest("postgresql://localhost/kb")).rejects.toThrow(/test/);
  });
});

const TEST_URL = process.env.KB_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("resetDbForTest（真库）", () => {
  it("重放后 schema_migrations 账本与 migration 文件一一对应", async () => {
    const pool = await resetDbForTest(TEST_URL!);
    try {
      const { rows } = await pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      const dir = fileURLToPath(new URL("../../pipeline/kb/migrations", import.meta.url));
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      expect(rows.map((r) => r.name)).toEqual(files);
    } finally {
      await pool.end();
    }
  });
});
