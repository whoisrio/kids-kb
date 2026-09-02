import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(databaseUrl: string): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: databaseUrl });
  return pool;
}

/** 测试用：重置 schema 并重放 pipeline 侧 migrations（Python 是 schema 唯一主人）。 */
export async function resetDbForTest(databaseUrl: string): Promise<pg.Pool> {
  const p = new pg.Pool({ connectionString: databaseUrl });
  await p.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  const dir = fileURLToPath(new URL("../../pipeline/kb/migrations", import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await p.query(readFileSync(join(dir, f), "utf-8"));
  }
  return p;
}
