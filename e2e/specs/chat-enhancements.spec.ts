import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, test, type Page } from "@playwright/test";

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";
const SESSIONS_ROOT =
  process.env.KB_SESSIONS_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backend/storage/sessions");

const Q1 = `E2E-${RUN}-不要使用工具，请先思考一遍，然后只原样输出这一行：$998001$。`;
const Q1_EDIT = `E2E-${RUN}-不要使用工具，请只原样输出这一行：$888888$。`;
const Q2 = `E2E-${RUN}-不要使用工具，请只输出下面 3 行，不要标题、加粗或解释，使用 markdown 无序列表：\n- 预习建议一\n- 预习建议二\n- 预习建议三`;

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let sessionId = "";
let turnCount = 0;
let runStart = new Date();

test.beforeAll(() => {
  runStart = new Date();
});

function findSessionFile(id: string): string {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const filePath = path.join(dir, name);
      return statSync(filePath).isDirectory() ? walk(filePath) : [filePath];
    });
  const file = walk(SESSIONS_ROOT).find((candidate) => candidate.endsWith(`_${id}.jsonl`));
  if (!file) throw new Error(`Session file not found: ${id}`);
  return file;
}

async function waitReplyDone(page: Page, timeout = 240_000) {
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false", { timeout });
  await expect
    .poll(async () => (await page.locator(".msg:last-child .bubble").textContent())?.length ?? 0, { timeout })
    .toBeGreaterThan(0);
  const reply = (await page.locator(".msg:last-child .bubble").textContent())!;
  expect(reply).not.toContain("出错了");
  turnCount++;
  return reply;
}

async function send(page: Page, text: string) {
  await page.getByPlaceholder(/问点什么/).fill(text);
  await page.getByRole("button", { name: "发送" }).click();
}

test("t1 thinking 当轮展开-自动折叠 + assistant 消息 markdown/LaTeX 渲染", async ({ page }) => {
  test.setTimeout(420_000);
  let reply = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/");
    await send(page, Q1);
    await expect
      .poll(async () => page.locator(".thinking.open").count(), { timeout: 60_000 })
      .toBeGreaterThan(0);
    reply = await waitReplyDone(page);
    await expect(page.locator(".thinking.open")).toHaveCount(0);
    expect(page.locator(".thinking")).toHaveCount(1);
    if (await page.locator(".msg:last-child .bubble .katex").first().isVisible()) break;
    const sessions = await (await page.request.get("/api/sessions")).json() as
      { id: string; title: string }[];
    for (const session of sessions.filter((item) => item.title.startsWith(`E2E-${RUN}`))) {
      await page.request.delete(`/api/sessions/${session.id}`);
    }
  }
  await expect(page.locator(".msg:last-child .bubble .katex").first()).toBeVisible({ timeout: 10_000 });
  expect(reply).toContain("998001");

  const list = (await (await page.request.get("/api/sessions")).json()) as { id: string; title: string }[];
  sessionId = list.find((session) => session.title.startsWith(`E2E-${RUN}`))!.id;
  const detail = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    currentLane: string;
    lanes: { id: string }[];
    messages: { entryId: string; role: string; content: string; thinking?: string }[];
  };
  expect(detail.currentLane).toBe("main");
  expect(detail.lanes).toEqual([{ id: "main", forkEntryId: null, fromLaneId: null }]);
  expect(detail.messages).toHaveLength(2);
  expect(detail.messages.every((message) => typeof message.entryId === "string")).toBe(true);
  expect(detail.messages[1].thinking).toBeTruthy();

  const raw = readFileSync(findSessionFile(sessionId), "utf8");
  expect(raw).toContain('"type":"thinking"');

  const { rows: calls } = await pool.query(
    "SELECT count(*)::int AS n FROM llm_calls WHERE purpose='chat' AND completion_tokens > 0");
  expect(calls[0].n).toBeGreaterThanOrEqual(turnCount);
});

test("t2 编辑消息开新分支 + ‹i/n› 切回原分支", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".msg")).toHaveCount(2);
  await page.locator(".msg.user").first().hover();
  await page.locator(".msg.user").first().getByRole("button", { name: "编辑" }).click();
  await page.getByRole("textbox", { name: "编辑消息" }).fill(Q1_EDIT);
  await page.getByRole("button", { name: "保存" }).click();
  await waitReplyDone(page);
  const firstSwitch = page.locator(".msg").first().locator(".branch-switch");
  await expect(firstSwitch).toContainText("2/2");
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("888888");
  await firstSwitch.getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("998001");
  await expect(firstSwitch).toContainText("1/2");

  const detail = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    currentLane: string; lanes: { id: string; forkEntryId: string | null; fromLaneId: string | null }[];
    messages: { content: string }[];
  };
  expect(detail.lanes).toHaveLength(2);
  expect(detail.lanes[1].fromLaneId).toBe("main");
  expect(detail.lanes[1].forkEntryId).toBeNull();
  expect(detail.currentLane).toBe(detail.lanes[1].id);
  const mainDetail = (await (await page.request.get(
    `/api/sessions/${sessionId}?lane=main`)).json()) as { messages: { content: string }[] };
  expect(mainDetail.messages[0].content).toContain("998001");
});

test("t3 regenerate 在末条 assistant 前开叉重发原文", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".msg")).toHaveCount(2);
  await page.locator(".msg.agent").last().hover();
  await page.locator(".msg.agent").last().getByRole("button", { name: "重新生成" }).click();
  await waitReplyDone(page);
  await expect(page.locator(".msg")).toHaveCount(3);
  const second = page.locator(".msg").nth(1);
  await expect(second).toHaveClass(/user/);
  await expect(second.locator(".branch-switch")).toContainText("2/2");
  await second.locator(".branch-switch").getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg")).toHaveCount(2);
});

test("t4 rewind 截断 + 下一次发送在该消息处开叉 + markdown 列表", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  // Reload defaults to the latest regenerated branch. Cycle through the edited root lane to main.
  await expect(page.locator(".msg")).toHaveCount(3);
  const mainSwitch = page.locator(".msg").first().locator(".branch-switch");
  await expect(mainSwitch).toContainText("1/2");
  await mainSwitch.getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("888888");
  await mainSwitch.getByRole("button", { name: "‹" }).click();
  await expect(page.locator(".msg.user").first().locator(".bubble")).toContainText("998001");
  await expect(page.locator(".msg")).toHaveCount(2);
  await send(page, Q2);
  await waitReplyDone(page);
  await expect(page.locator(".msg:last-child .bubble li").first()).toBeVisible();
  await page.locator(".msg").nth(1).hover();
  await page.locator(".msg").nth(1).getByRole("button", { name: "回到这" }).click();
  await expect(page.getByRole("status")).toContainText("后续内容保留在原分支");
  await expect(page.locator(".msg")).toHaveCount(2);
  await send(page, Q1);
  await waitReplyDone(page);
  await expect(page.locator(".msg")).toHaveCount(4);
  const third = page.locator(".msg").nth(2);
  await expect(third.locator(".branch-switch")).toContainText("2/2");

  const mainDetail = (await (await page.request.get(
    `/api/sessions/${sessionId}?lane=main`)).json()) as { messages: { entryId: string }[] };
  const latest = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    lanes: { forkEntryId: string | null }[];
  };
  expect(latest.lanes.at(-1)!.forkEntryId).toBe(mainDetail.messages[1].entryId);
});

test("t5 复制：单条原文 + 整会话 Markdown 稿（不含 thinking）", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first().click();
  await expect(page.locator(".chat-wrap")).toHaveAttribute("data-streaming", "false");
  await page.locator(".msg.user").first().hover();
  await page.locator(".msg.user").first().getByRole("button", { name: "复制" }).click();
  await expect(page.locator(".toast")).toContainText("已复制");
  const single = await page.evaluate(() => navigator.clipboard.readText());
  expect(single).toContain("998001");
  await page.getByRole("button", { name: "复制全文" }).click();
  await expect(page.locator(".toast")).toContainText("已复制全文");
  const all = await page.evaluate(() => navigator.clipboard.readText());
  expect(all).toContain("## 我");
  expect(all).toContain("## 学习助手");
  expect(all).not.toContain("思考过程");
});

test("t6 删除会话：列表/文件/API 均无残留", async ({ page }) => {
  await page.goto("/");
  const item = page.locator(".session-item").filter({ hasText: `E2E-${RUN}` }).first();
  await item.hover();
  await item.locator(".del").click();
  await page.getByRole("dialog").getByRole("button", { name: "删除" }).click();
  await expect(page.locator(".session-item").filter({ hasText: `E2E-${RUN}` })).toHaveCount(0);
  await expect(page.locator(".chat-empty")).toBeVisible();
  expect((await page.request.get(`/api/sessions/${sessionId}`)).status()).toBe(404);
  await expect.poll(() => {
    try {
      findSessionFile(sessionId);
      return true;
    } catch {
      return false;
    }
  }, { timeout: 5_000 }).toBe(false);
});

test.afterAll(async () => {
  await pool.query(
    "DELETE FROM llm_calls WHERE purpose='chat' AND created_at >= $1",
    [runStart.toISOString()],
  );
  await pool.end();
});
