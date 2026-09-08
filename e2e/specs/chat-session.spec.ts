import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 1.5 聊天会话全栈 E2E：UI → API → JSONL 落盘 → llm_calls 计量。
 * 真实栈（三服务 + ollama + PostgreSQL），每个场景断言到数据字段值。
 * 串行执行：t1 建会话 A，t2 回看，t3 模型切换，t4 新对话建会话 B。
 */

const RUN = Date.now().toString(36); // 本次运行唯一标记（侧栏可能有历史会话）
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const BACKEND_URL = process.env.KB_E2E_BACKEND_URL ?? "http://127.0.0.1:8787";
const SESSIONS_ROOT =
  process.env.KB_SESSIONS_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/storage/sessions");

const MSG_A1 = `E2E-${RUN}-小宝这周数学口算练习做得怎么样？不使用工具，请只用一句话回答。`;
const MSG_A2 = `E2E-${RUN}-英语学习上有什么建议？不使用工具，请只用一句话回答。`;
const MSG_B1 = `E2E-${RUN}-五道两位数乘法题目是什么？不使用工具，请只列出题目。`;

test.describe.configure({ mode: "serial" });

const pool = new pg.Pool({ connectionString: DB_URL });
const runStart = new Date();

// 会话 A 的跨用例状态（t1 写入）
let sessionA: { id: string; title: string; model: string } | null = null;

/** 等流式收尾（data-streaming 复位）且助手气泡非空、无错误文案。 */
async function waitReplyDone(page: Page, timeout = 240_000) {
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", { timeout });
  await expect
    .poll(async () => (await page.locator(".msg:last-child .bubble").textContent())?.length ?? 0, {
      timeout,
    })
    .toBeGreaterThan(0);
  const reply = (await page.locator(".msg:last-child .bubble").textContent())!;
  expect(reply).not.toContain("出错了"); // 错误路径也会复位 streaming，不算回复成功
  return reply;
}

async function sendMessage(page: Page, text: string) {
  await page.getByPlaceholder(/问点什么/).fill(text);
  await page.getByRole("button", { name: "发送" }).click();
}

/** 会话消息流中全部气泡文本（user/agent 交替）。 */
async function bubbleTexts(page: Page) {
  return page.locator(".msg .bubble").allTextContents();
}

/** 在 sessions 根下按会话 id 定位 JSONL 文件。 */
function findSessionFile(id: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const hit = walk(SESSIONS_ROOT).filter((f) => f.endsWith(`${id}.jsonl`));
  expect(hit, `会话 ${id} 的 JSONL 文件`).toHaveLength(1);
  return hit[0];
}

function readJsonl(file: string) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function messageText(entry: { message: { content: unknown } }): string {
  const c = entry.message.content;
  return typeof c === "string" ? c : (c as { type: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

/** 最近一条 chat 计量行（创建时间不早于 runStart）。 */
async function latestChatCall(runStart: Date) {
  const { rows } = await pool.query(
    `SELECT purpose, model, modality, document_id, prompt_tokens, completion_tokens
     FROM llm_calls WHERE purpose = 'chat' AND created_at >= $1
     ORDER BY created_at DESC LIMIT 1`,
    [runStart.toISOString()],
  );
  expect(rows, "llm_calls 应有本次运行的 chat 行").toHaveLength(1);
  return rows[0] as {
    purpose: string; model: string; modality: string;
    document_id: string | null; prompt_tokens: number; completion_tokens: number;
  };
}

test.afterAll(async ({ request }) => {
  const list = await (await request.get(`${BACKEND_URL}/api/sessions`)).json() as
    { id: string; title: string }[];
  const createdSessions = list.filter((session) =>
    session.title.startsWith(`E2E-${RUN}-`));
  for (const session of createdSessions) {
    await request.delete(`${BACKEND_URL}/api/sessions/${session.id}`);
  }
  await pool.query(
    "DELETE FROM llm_calls WHERE purpose='chat' AND created_at >= $1",
    [runStart.toISOString()],
  );
  await pool.end();
});

test("t1 发消息：流式回复 + 侧栏新会话 + JSONL 落盘 + llm_calls 计量", async ({ page }) => {
  const runStart = new Date();
  await page.goto("/");
  await sendMessage(page, MSG_A1);

  // 用户消息上屏，流式进行 → 收尾，回复完整
  await expect(page.locator(".msg.user .bubble")).toContainText(MSG_A1);
  const replyA1 = await waitReplyDone(page);
  expect(replyA1.length).toBeGreaterThan(10); // 完整回答而非空/残句

  // 侧栏：新会话即时出现、标题=首条用户消息前 20 字、高亮
  const titleA = MSG_A1.slice(0, 20);
  const itemA = page.locator(".session-item").filter({ hasText: titleA });
  await expect(itemA).toHaveCount(1);
  await expect(itemA).toHaveClass(/active/);

  // API：列表摘要字段逐一核对
  const list = (await (await page.request.get("/api/sessions")).json()) as {
    id: string; title: string; model: string; createdAt: number; modifiedAt: number;
  }[];
  const summary = list.find((s) => s.title === titleA);
  expect(summary, "列表应含新会话").toBeDefined();
  expect(summary!.createdAt).toBeGreaterThan(0);
  expect(summary!.modifiedAt).toBeGreaterThanOrEqual(summary!.createdAt);

  // API：回看 detail 字段
  const detail = (await (await page.request.get(`/api/sessions/${summary!.id}`)).json()) as {
    title: string; currentModel: string; currentLane: string;
    lanes: { id: string; forkEntryId: string | null; fromLaneId: string | null }[];
    messages: { role: string; content: string; entryId: string }[];
  };
  expect(detail.title).toBe(titleA);
  expect(detail.currentModel).toBe(summary!.model); // 无 model_change 时回落创建模型
  expect(detail.messages.length).toBeGreaterThanOrEqual(2);
  expect(detail.messages[0]).toMatchObject({ role: "user", content: MSG_A1 });
  expect(typeof detail.messages[0].entryId).toBe("string");
  expect(detail.currentLane).toBe("main");
  expect(detail.lanes).toEqual([{ id: "main", forkEntryId: null, fromLaneId: null }]);
  const lastAssistant = [...detail.messages].reverse().find((m) => m.role === "assistant")!;
  expect(lastAssistant.content.replace(/\s+/g, "")).toBe(replyA1.replace(/\s+/g, ""));
  expect(detail.messages.map((m) => m.role)).toEqual(expect.arrayContaining(["user", "assistant"]));

  // JSONL：header metadata + user/assistant message 落盘
  const entries = readJsonl(findSessionFile(summary!.id));
  const header = entries.find((e) => e.type === undefined || e.type === null) ??
    entries.find((e) => JSON.stringify(e).includes('"title"'));
  expect(header.metadata).toMatchObject({ title: titleA, model: summary!.model });
  const userEntry = entries.find((e) => e.type === "message" && e.message.role === "user" && messageText(e) === MSG_A1);
  expect(userEntry, "JSONL 应含首条用户消息").toBeDefined();
  const assistantEntry = entries.find((e) => e.type === "message" && e.message.role === "assistant" && messageText(e) === replyA1);
  expect(assistantEntry, "JSONL 应含最终助手消息").toBeDefined();

  // llm_calls：purpose/model/modality/document_id/token 逐字段
  const call = await latestChatCall(runStart);
  expect(call).toMatchObject({ purpose: "chat", model: summary!.model, modality: "text", document_id: null });
  expect(call.prompt_tokens).toBeGreaterThan(0);
  expect(call.completion_tokens).toBeGreaterThan(0);

  sessionA = { id: summary!.id, title: titleA, model: summary!.model };
});

test("t2 刷新回看：侧栏入口 + 完整消息流 + 下拉同步 currentModel", async ({ page }) => {
  test.skip(!sessionA, "依赖 t1");
  await page.goto("/"); // 刷新后无内存状态
  const itemA = page.locator(".session-item").filter({ hasText: sessionA!.title });
  await expect(itemA).toHaveCount(1);
  await expect(itemA).not.toHaveClass(/active/); // 未选中
  await itemA.click();

  // 回看消息与 API detail 完全一致
  const detail = (await (await page.request.get(`/api/sessions/${sessionA!.id}`)).json()) as {
    currentModel: string; currentLane: string; messages: { role: string; content: string }[];
  };
  // 等回看消息渲染完成（fetchSessionDetail 异步）
  await expect(page.locator(".msg")).toHaveCount(detail.messages.length);
  await expect(page.locator(".msg").nth(detail.messages.length - 1).locator(".bubble"))
    .toContainText(detail.messages.at(-1)!.content.slice(0, 30));
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false");
  const bubbles = await bubbleTexts(page);
  expect(bubbles).toEqual(detail.messages.map((m) => m.content));
  await expect(itemA).toHaveClass(/active/); // 当前会话标记
  // 模型下拉同步会话当前模型
  await expect(page.locator("select[aria-label='选择模型']")).toHaveValue(detail.currentModel);
});

test("t3 切换模型：下一条消息用新模型 + model_change 留痕 + llm_calls 新模型", async ({ page }) => {
  test.skip(!sessionA, "依赖 t1");
  const runStart = new Date();
  const models = (await (await page.request.get("/api/models")).json()) as { id: string }[];
  // 目标模型 ≠ 会话 A 当前模型（从 API 取权威值，而非下拉显示值）
  const detailBefore = (await (await page.request.get(`/api/sessions/${sessionA!.id}`)).json()) as {
    currentModel: string; currentLane: string; messages: { content: string }[];
  };
  const target = models.find((m) => m.id !== detailBefore.currentModel)?.id;
  test.skip(!target, "仅一个注册模型，跳过切换用例");

  // 回到会话 A：等回看消息加载（按 API 权威消息数）再切模型发消息
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: sessionA!.title }).click();
  await expect(page.locator(".msg")).toHaveCount(detailBefore.messages.length);
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false");
  await page.locator("select[aria-label='选择模型']").selectOption(target!);
  await sendMessage(page, MSG_A2);
  const replyA2 = await waitReplyDone(page);

  // 会话 A 上下文延续：原历史加本轮 user/assistant
  expect((await bubbleTexts(page)).length).toBe(detailBefore.messages.length + 2);

  // API：currentModel 更新
  const detail = (await (await page.request.get(`/api/sessions/${sessionA!.id}`)).json()) as {
    currentModel: string; messages: { role: string; content: string }[];
  };
  expect(detail.currentModel).toBe(target);
  expect(detail.messages.map((m) => m.content)).toContain(MSG_A2);
  expect([...detail.messages].reverse().find((m) => m.role === "assistant")!.content).toBe(replyA2);

  // JSONL：model_change 留痕，且在其后的消息用新模型
  const entries = readJsonl(findSessionFile(sessionA!.id));
  const changeIdx = entries.findIndex((e) => e.type === "model_change");
  expect(changeIdx).toBeGreaterThanOrEqual(0);
  expect(entries[changeIdx].modelId).toBe(target);
  const msgAfterChange = entries.findIndex((e) => e.type === "message" && messageText(e) === MSG_A2);
  expect(msgAfterChange).toBeGreaterThan(changeIdx);

  // llm_calls：新模型行，逐字段
  const call = await latestChatCall(runStart);
  expect(call).toMatchObject({ purpose: "chat", model: target, modality: "text", document_id: null });
  expect(call.prompt_tokens).toBeGreaterThan(0);
  expect(call.completion_tokens).toBeGreaterThan(0);
});

test("t4 新对话：清空 → 新会话创建 → 侧栏排序与高亮", async ({ page }) => {
  test.skip(!sessionA, "依赖 t1");
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: sessionA!.title }).click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false");
  await expect(page.locator(".msg")).not.toHaveCount(0);

  // 新对话：清空消息流与当前会话标记，模型选择保留
  const modelBefore = await page.locator("select[aria-label='选择模型']").inputValue();
  await page.getByRole("button", { name: "＋ 新对话" }).click();
  await expect(page.locator(".msg")).toHaveCount(0);
  await expect(page.locator(".chat-empty")).toBeVisible();
  await expect(page.locator(".session-item.active")).toHaveCount(0);
  await expect(page.locator("select[aria-label='选择模型']")).toHaveValue(modelBefore);

  // 新会话发消息：第二个会话出现、排最前（modifiedAt 倒序）、高亮
  await sendMessage(page, MSG_B1);
  await waitReplyDone(page);
  const titleB = MSG_B1.slice(0, 20);
  const itemB = page.locator(".session-item").filter({ hasText: titleB });
  await expect(itemB).toHaveCount(1);
  await expect(itemB).toHaveClass(/active/);
  const itemA2 = page.locator(".session-item").filter({ hasText: sessionA!.title });
  const idxB = await page.locator(".session-item").evaluateAll(
    (els, text) => els.findIndex((el) => el.textContent?.includes(text)), titleB);
  const idxA = await page.locator(".session-item").evaluateAll(
    (els, text) => els.findIndex((el) => el.textContent?.includes(text)), sessionA!.title);
  expect(idxB).toBeGreaterThanOrEqual(0);
  expect(idxB).toBeLessThan(idxA); // 新会话排在前

  // 新会话 JSONL 落盘
  const list = (await (await page.request.get("/api/sessions")).json()) as { id: string; title: string }[];
  const summaryB = list.find((s) => s.title === titleB)!;
  const entriesB = readJsonl(findSessionFile(summaryB.id));
  expect(entriesB.some((e) => e.type === "message" && e.message.role === "user" && messageText(e) === MSG_B1)).toBe(true);
});
