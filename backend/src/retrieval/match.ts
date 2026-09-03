/** 试卷题目 → 题库匹配:同学科混合检索 + rerank,第一名余弦超阈值自动关联。 */
import type pg from "pg";
import { hybridSearch, type SearchDeps, type SearchHit } from "./search.js";

export interface MatchResult {
  /** rerank 序 top-5 候选(供人工选择)。 */
  candidates: SearchHit[];
  /** 自动关联命中(第一名且 vec_score ≥ threshold);null = 需人工。 */
  auto: SearchHit | null;
}

export async function matchQuestion(
  pool: pg.Pool,
  deps: SearchDeps,
  content: string,
  subject: string,
  threshold: number,
): Promise<MatchResult> {
  const candidates = await hybridSearch(pool, deps, content, {
    topK: 5,
    filters: { subject },
  });
  const top = candidates[0];
  const auto = top && top.vec_score !== undefined && top.vec_score >= threshold ? top : null;
  return { candidates, auto };
}
