/** agent 检索工具集（只读）：搜题库 / 看条目 / 孩子列表 / 孩子进展。
    Type 用 pi-ai 的再导出（pi-ai README 明确 re-export Type/Static/TSchema）。 */
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type pg from "pg";
import type { SearchHit } from "../retrieval/search.js";

export interface ToolDeps {
  pool: pg.Pool;
  search: (query: string, filters?: Record<string, string>) => Promise<SearchHit[]>;
}

/** AgentToolResult.details 为必填；工具结果不带结构化细节，给空对象。 */
const toText = (s: string) => ({ content: [{ type: "text" as const, text: s }], details: {} });

/** 保留每个工具的参数类型推导（AgentTool 默认泛型会把 params 抹成 unknown）。 */
function defineTool<S extends TSchema>(t: AgentTool<S>): AgentTool {
  return t as unknown as AgentTool;
}

export function makeTools(deps: ToolDeps): AgentTool[] {
  return [
    defineTool({
      name: "search_items",
      label: "搜题库",
      description: "语义检索题库条目（例题讲解/练习/答案），可按科目、章节过滤",
      parameters: Type.Object({
        query: Type.String({ description: "检索问题" }),
        subject: Type.Optional(Type.String({ description: "科目过滤，如 数学" })),
        chapter: Type.Optional(Type.String({ description: "章节过滤" })),
      }),
      execute: async (_id, params) => {
        const filters: Record<string, string> = {};
        if (params.subject) filters.subject = params.subject;
        if (params.chapter) filters.chapter = params.chapter;
        const hits = await deps.search(params.query, filters);
        if (hits.length === 0) return toText("题库里没有找到相关内容。");
        return toText(hits.map((h, i) =>
          `【${i + 1}】${h.label ?? ""}（${h.doc_title} · ${h.chapter}）\n${h.content_md}`,
        ).join("\n\n"));
      },
    }),
    defineTool({
      name: "get_item",
      label: "看条目",
      description: "按 item_id 取条目完整内容（题干/讲解/答案、章节、标签）",
      parameters: Type.Object({ item_id: Type.String() }),
      execute: async (_id, params) => {
        const { rows } = await deps.pool.query(
          `SELECT i.content_type, i.label, i.content_md, i.chapter, i.taxonomy, i.tags, d.title
           FROM items i JOIN documents d ON d.id = i.document_id WHERE i.id = $1`,
          [params.item_id],
        );
        if (rows.length === 0) throw new Error(`条目不存在: ${params.item_id}`);
        const r = rows[0];
        return toText(
          `${r.label}（${r.title} · ${r.chapter} · ${r.content_type}）\n${r.content_md}`,
        );
      },
    }),
    defineTool({
      name: "list_children",
      label: "孩子列表",
      description: "列出所有孩子（id、姓名、年级）",
      parameters: Type.Object({}),
      execute: async () => {
        const { rows } = await deps.pool.query(
          "SELECT id, name, grade FROM children ORDER BY created_at",
        );
        if (rows.length === 0) return toText("还没有孩子档案。");
        return toText(rows.map((r) => `${r.name}（${r.grade ?? "未填年级"}，id: ${r.id}）`).join("\n"));
      },
    }),
    defineTool({
      name: "get_child_progress",
      label: "孩子进展",
      description: "某孩子的做题记录统计：总数、对错分布、错因分布、最近错题",
      parameters: Type.Object({ child_id: Type.String() }),
      execute: async (_id, params) => {
        const { rows: totals } = await deps.pool.query(
          `SELECT count(*) AS n,
                  count(*) FILTER (WHERE result='correct') AS correct,
                  count(*) FILTER (WHERE result='wrong') AS wrong,
                  count(*) FILTER (WHERE result='partial') AS partial
           FROM attempts WHERE child_id=$1`,
          [params.child_id],
        );
        const { rows: causes } = await deps.pool.query(
          `SELECT error_cause, count(*) AS n FROM attempts
           WHERE child_id=$1 AND error_cause IS NOT NULL
           GROUP BY error_cause ORDER BY n DESC`,
          [params.child_id],
        );
        const { rows: recent } = await deps.pool.query(
          `SELECT i.label, i.chapter, a.result, a.error_cause, a.created_at
           FROM attempts a LEFT JOIN items i ON i.id = a.item_id
           WHERE a.child_id=$1 AND a.result <> 'correct'
           ORDER BY a.created_at DESC LIMIT 10`,
          [params.child_id],
        );
        const t = totals[0];
        const resultLabel: Record<string, string> = { correct: "对", wrong: "错", partial: "半对" };
        const lines = [
          `做题 ${t.n} 道：对 ${t.correct}、错 ${t.wrong}、半对 ${t.partial}`,
          causes.length ? `错因分布：${causes.map((c) => `${c.error_cause}×${c.n}`).join("、")}` : "",
          recent.length
            ? "最近错题：\n" + recent.map((r) =>
                `- ${r.label ?? "?"}（${r.chapter ?? "?"}）${resultLabel[r.result]}${r.error_cause ? " · " + r.error_cause : ""}`,
              ).join("\n")
            : "",
        ].filter(Boolean);
        return toText(lines.join("\n"));
      },
    }),
  ];
}
