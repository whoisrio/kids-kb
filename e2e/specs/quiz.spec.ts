import pg from "pg";
import { expect, test } from "@playwright/test";

/** 薄弱点出题全链路：统计页入口 → 真实 ollama 出题 → 练习页作答/判分 → UI/API/DB 逐层对账。
    t1 生成用例依赖真实 LLM（输出不确定，断言放宽到结构/字段，不断言题目文本）；
    t2 判分用例 SQL 直种子 quiz，选择题本地判分确定性断言，简答 AI 判分断言放宽到取值域。
    真实栈（三服务 + ollama + PostgreSQL）。 */

const RUN = Date.now().toString(36);
const DB_URL = process.env.KB_E2E_DATABASE_URL ?? "postgresql://localhost/kb";

const pool = new pg.Pool({ connectionString: DB_URL });

test.describe.configure({ mode: "serial" });

let childId1 = ""; // E2E${RUN}小宝（t1 生成）
let childId2 = ""; // E2E${RUN}朵朵（t2 判分）
let docId = "";
let quizId2 = "";
let questionIds2: string[] = [];
let runStart = ""; // DB now() 水位线，afterAll 只清本 run 的 llm_calls

const STEM_SINGLE = `E2E${RUN} 1+1=?`;
const STEM_MULTI = `E2E${RUN} 哪些是偶数?`;
const STEM_SHORT = `E2E${RUN} 说说怎么检查加法竖式`;

test.beforeAll(async () => {
  runStart = (await pool.query("SELECT now()::text AS now")).rows[0].now;
  await pool.query("DELETE FROM children WHERE name = ANY($1)", [
    [`E2E${RUN}小宝`, `E2E${RUN}朵朵`],
  ]);

  // ---- t1 种子：孩子 + 文档 + approved 条目 + wrong attempts 造薄弱点（计算类/口算）----
  childId1 = (await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'四年级') RETURNING id::text`,
    [`E2E${RUN}小宝`],
  )).rows[0].id;
  docId = (await pool.query(
    `INSERT INTO documents (title, subject, doc_type, source_path) VALUES ($1,'数学','workbook',$2) RETURNING id::text`,
    [`E2E${RUN}口算练习册`, `/tmp/e2e-quiz-${RUN}.pdf`],
  )).rows[0].id;
  const itemIds: string[] = [];
  for (let i = 1; i <= 2; i++) {
    itemIds.push((await pool.query(
      `INSERT INTO items (document_id, content_type, label, content_md, taxonomy, tags, qc_status)
       VALUES ($1,'exercise',$2,$3,'计算类',ARRAY['口算'],'approved') RETURNING id::text`,
      [docId, `例 ${i}`, `E2E${RUN} 参考例题 ${i}：两位数加法口算`],
    )).rows[0].id);
  }
  // 每题最新一次（rn=1）为 wrong → 进入薄弱知识点
  for (const itemId of itemIds) {
    await pool.query(
      `INSERT INTO attempts (child_id, item_id, result, error_cause) VALUES ($1,$2,'wrong','粗心')`,
      [childId1, itemId],
    );
  }
  await pool.query(
    `INSERT INTO attempts (child_id, item_id, result, error_cause) VALUES ($1,$2,'wrong','方法不会')`,
    [childId1, itemIds[0]],
  );

  // ---- t2 种子：孩子 + 固定 quiz（单选 B 对 / 多选 AC / 简答带 rubric，各 10 分）----
  childId2 = (await pool.query(
    `INSERT INTO children (name, grade) VALUES ($1,'三年级') RETURNING id::text`,
    [`E2E${RUN}朵朵`],
  )).rows[0].id;
  quizId2 = (await pool.query(
    `INSERT INTO quizzes (child_id, title, tags) VALUES ($1,$2,ARRAY['计算类']) RETURNING id::text`,
    [childId2, `E2E${RUN}数学专项`],
  )).rows[0].id;
  const seeds: {
    seq: number; type: string; question: string;
    options: { value: string; label: string }[] | null;
    answer: string[] | null; analysis: string | null; commentPrompt: string | null;
  }[] = [
    {
      seq: 1, type: "single", question: STEM_SINGLE,
      options: [
        { value: "A", label: "1" }, { value: "B", label: "2" },
        { value: "C", label: "3" }, { value: "D", label: "4" },
      ],
      answer: ["B"], analysis: "1+1=2", commentPrompt: null,
    },
    {
      seq: 2, type: "multiple", question: STEM_MULTI,
      options: [
        { value: "A", label: "2" }, { value: "B", label: "3" },
        { value: "C", label: "4" }, { value: "D", label: "5" },
      ],
      answer: ["A", "C"], analysis: "2 和 4 是偶数", commentPrompt: null,
    },
    {
      seq: 3, type: "short_answer", question: STEM_SHORT,
      options: null, answer: null,
      analysis: "逐位复核，注意进位",
      commentPrompt: "提到逐位复核/验算/进位检查即可得分",
    },
  ];
  for (const s of seeds) {
    questionIds2.push((await pool.query(
      `INSERT INTO quiz_questions (quiz_id, seq, type, question, options, answer, analysis, comment_prompt, points)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,10) RETURNING id::text`,
      [quizId2, s.seq, s.type, s.question,
       s.options ? JSON.stringify(s.options) : null, s.answer, s.analysis, s.commentPrompt],
    )).rows[0].id);
  }
});

test("t1 统计页针对薄弱点出题：真实 LLM 生成，UI 卡片与 DB 结构对账", async ({ page }) => {
  test.setTimeout(300_000); // 出题 LLM 调用可能 1-2 分钟
  const since = (await pool.query("SELECT now()::text AS now")).rows[0].now;

  await page.goto("/");
  await page.getByRole("button", { name: "统计" }).click();
  await page.getByRole("button", { name: `E2E${RUN}小宝` }).click();
  // 薄弱知识点里有「计算类/口算」tag，出题按钮可用
  await expect(page.locator(".tag-cloud .tag").filter({ hasText: "计算类" })).toBeVisible();
  const genBtn = page.getByRole("button", { name: "针对薄弱点出题" });
  await expect(genBtn).toBeEnabled();
  await genBtn.click();

  // 生成成功后客户端跳到练习视图（App setView，URL 不变），出现标题含「薄弱点强化」的卡片
  const card = page.locator(".qz-card").filter({ hasText: "薄弱点强化" });
  await expect(card).toBeVisible({ timeout: 240_000 });
  await expect(card.locator(".qz-badge")).toHaveText("待作答");
  await expect(card.locator(".qz-card-meta")).toContainText("题 ·");
  await expect(card.locator(".qz-card-meta")).toContainText("分");

  // ---- DB 对账 ----
  const { rows: quizRows } = await pool.query(
    "SELECT id::text, title, tags, status FROM quizzes WHERE child_id=$1", [childId1],
  );
  expect(quizRows).toHaveLength(1);
  const quiz = quizRows[0];
  expect(quiz.title).toContain("薄弱点强化");
  expect(quiz.status).toBe("pending");
  expect(quiz.tags.some((t: string) => t === "计算类" || t === "口算")).toBe(true);

  const { rows: questions } = await pool.query(
    "SELECT seq, type, options, answer FROM quiz_questions WHERE quiz_id=$1 ORDER BY seq", [quiz.id],
  );
  // 默认出 5 题；LLM 输出不确定，若数量偏离则以结构断言为准（见下）
  expect(questions.length).toBe(5);
  expect(questions.map((q) => q.seq)).toEqual([1, 2, 3, 4, 5]);
  for (const q of questions) {
    expect(["single", "multiple", "short_answer"]).toContain(q.type);
    if (q.type === "short_answer") {
      expect(q.options).toBeNull();
      expect(q.answer).toBeNull();
    } else {
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(q.answer)).toBe(true);
      expect(q.answer.length).toBeGreaterThan(0);
    }
  }
  // 卡片「N 题 · M 分」与 DB 聚合一致
  const { rows: [agg] } = await pool.query(
    "SELECT count(*)::int AS n, sum(points)::int AS p FROM quiz_questions WHERE quiz_id=$1", [quiz.id],
  );
  await expect(card.locator(".qz-card-meta")).toContainText(`${agg.n} 题 · ${agg.p} 分`);

  // llm_calls 记账 purpose='quiz'
  const { rows: calls } = await pool.query(
    "SELECT model, modality FROM llm_calls WHERE purpose='quiz' AND created_at >= $1", [since],
  );
  expect(calls.length).toBeGreaterThanOrEqual(1);
  expect(calls[0].modality).toBe("text");
});

test("t2 作答判分：选择本地判分 + 简答 AI 判分，UI/DB 逐题对账与回顾还原", async ({ page }) => {
  test.setTimeout(300_000); // 简答判分调 ollama
  const [q1, q2, q3] = questionIds2;

  await page.goto("/?view=quiz");
  await page.getByRole("button", { name: `E2E${RUN}朵朵` }).click();
  const card = page.locator(".qz-card").filter({ hasText: `E2E${RUN}数学专项` });
  await expect(card).toBeVisible();
  await expect(card.locator(".qz-card-meta")).toContainText("3 题 · 30 分");
  await expect(card.locator(".qz-badge")).toHaveText("待作答");
  await card.click();

  // cover → 开始答题
  await page.getByRole("button", { name: "开始答题" }).click();
  await expect(page.locator(".qz-progress")).toHaveText("已答 0/3");
  const submitBtn = page.getByRole("button", { name: "提交答案" });
  await expect(submitBtn).toBeDisabled();

  // 第 1 题单选选对（B）；第 2 题多选只选 A（错，漏 C）；第 3 题简答填内容
  await page.locator(".qz-question").filter({ hasText: STEM_SINGLE })
    .getByRole("button", { name: /^B\./ }).click();
  await page.locator(".qz-question").filter({ hasText: STEM_MULTI })
    .getByRole("button", { name: /^A\./ }).click();
  await page.getByLabel("第 3 题作答").fill("逐位复核");
  await expect(page.locator(".qz-progress")).toHaveText("已答 3/3");
  await expect(submitBtn).toBeEnabled();
  await submitBtn.click();

  // 判分中 → 结果页
  const banner = page.locator(".qz-banner");
  await expect(banner).toBeVisible({ timeout: 180_000 });

  // ---- DB 对账（先读 DB，再回头对 UI 横幅）----
  const { rows: attemptRows } = await pool.query(
    `SELECT a.quiz_question_id::text AS qid, a.result, a.note
     FROM attempts a WHERE a.quiz_question_id = ANY($1::uuid[]) ORDER BY a.created_at`,
    [questionIds2],
  );
  expect(attemptRows).toHaveLength(3);
  const byQid = new Map(attemptRows.map((r) => [r.qid, r]));
  // 选择题精确断言
  expect(byQid.get(q1)).toMatchObject({ result: "correct", note: "10" });
  expect(byQid.get(q2)).toMatchObject({ result: "wrong", note: "0" });
  // 简答 AI 判分：结果域 + 实得分是 0..10 整数字符串
  const short = byQid.get(q3);
  expect(["correct", "partial", "wrong"]).toContain(short.result);
  expect(short.note).toMatch(/^\d+$/);
  const shortEarned = Number(short.note);
  expect(shortEarned).toBeGreaterThanOrEqual(0);
  expect(shortEarned).toBeLessThanOrEqual(10);
  const totalEarned = 10 + 0 + shortEarned;

  const { rows: [quizRow] } = await pool.query(
    "SELECT status, submitted_at FROM quizzes WHERE id=$1", [quizId2],
  );
  expect(quizRow.status).toBe("submitted");
  expect(quizRow.submitted_at).not.toBeNull();

  // ---- UI 断言：横幅分数 = 10 + 0 + 简答得分；逐题对错卡 ----
  await expect(banner.locator(".qz-banner-score")).toHaveText(`${totalEarned}/30 分`);
  await expect(banner.locator(".qz-banner-rate")).toContainText("正确率");
  const cardQ1 = page.locator(".qz-question--correct").filter({ hasText: STEM_SINGLE });
  await expect(cardQ1.locator(".qz-verdict")).toHaveText("答对了 · 10/10 分");
  const cardQ2 = page.locator(".qz-question--wrong").filter({ hasText: STEM_MULTI });
  await expect(cardQ2.locator(".qz-verdict")).toHaveText("答错了 · 0/10 分");
  // 判分后透出正确答案与解析
  await expect(cardQ1.locator(".qz-line--answer")).toHaveText("正确答案：B. 2");
  await expect(cardQ2.locator(".qz-line--answer")).toHaveText("正确答案：A. 2、C. 4");
  await expect(page.locator(".qz-question").filter({ hasText: STEM_SHORT })
    .locator(".qz-analysis")).toContainText("解析：逐位复核");

  // ---- 已完成卡片回顾：结果由 attempts 还原 ----
  await page.getByRole("button", { name: "返回列表" }).click();
  const doneCard = page.locator(".qz-card").filter({ hasText: `E2E${RUN}数学专项` });
  await expect(doneCard.locator(".qz-badge")).toHaveText("已完成");
  await expect(doneCard.locator(".qz-card-score")).toHaveText(`得分 ${totalEarned}/30`);
  await doneCard.click();
  await expect(page.locator(".qz-banner-score")).toHaveText(`${totalEarned}/30 分`);
  await expect(page.locator(".qz-verdict")).toHaveCount(3);
  await expect(page.locator(".qz-question--correct").filter({ hasText: STEM_SINGLE })).toBeVisible();
  await expect(page.locator(".qz-question--wrong").filter({ hasText: STEM_MULTI })).toBeVisible();
});

test.afterAll(async () => {
  // 只删本 run 创建的数据：children 级联 attempts/quizzes/quiz_questions；documents 级联 items
  if (childId1 || childId2) {
    await pool.query("DELETE FROM children WHERE id = ANY($1::uuid[])", [
      [childId1, childId2].filter(Boolean),
    ]);
  }
  if (docId) await pool.query("DELETE FROM documents WHERE id=$1", [docId]);
  if (runStart) {
    await pool.query("DELETE FROM llm_calls WHERE purpose='quiz' AND created_at >= $1", [runStart]);
  }
  await pool.end();
});
