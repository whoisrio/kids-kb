import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl });
  return pool;
}

/**
 * 测试用：重置 schema 并重放 pipeline 侧 migrations（Python 是 schema 唯一主人）。
 * 重放同时向 schema_migrations 记账，与 pipeline/kb/db.py 的 migrate() 语义一致，
 * 保证之后 Python 侧 migrate() 判定无新 migration。
 */
export async function resetDbForTest(databaseUrl: string): Promise<pg.Pool> {
  // 防误毁守卫：destructive teardown 只允许指向测试库（库名须含 "test"）。
  const dbName = databaseUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!dbName.includes("test")) {
    throw new Error(
      `resetDbForTest 拒绝在非测试库上执行（库名 "${dbName}" 不含 "test"）：` +
        "该函数会 DROP SCHEMA public CASCADE，请确认 URL 指向测试库（如 postgresql://localhost/kb_test）",
    );
  }
  const p = new pg.Pool({ connectionString: databaseUrl });
  // 多个测试文件并行跑时会并发 reset 同一测试库（CREATE EXTENSION 等会撞唯一约束），
  // 用 advisory lock 把 reset 串行化。锁是会话级的，必须全程同一 client。
  const client = await p.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('resetDbForTest'))");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations " +
        "(name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    const dir = fileURLToPath(new URL("../../pipeline/kb/migrations", import.meta.url));
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      await client.query(readFileSync(join(dir, f), "utf-8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('resetDbForTest'))");
    client.release();
  }
  return p;
}
