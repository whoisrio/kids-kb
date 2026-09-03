# Phase 2 试卷管线 设计

2026-09-03。
上游:`2026-09-02-overall-system-design.md`(分期表 Phase 2)。

## 目标

上传孩子的试卷(PDF 或多张照片),VLM 整页拆题并预识别对错痕迹,家长在复核视图逐题确认(键盘流转),确认结果写入 `attempts` 唯一事实表,并向量匹配题库条目自动/人工关联。

## 已确认的关键决策(brainstorming 结论)

1. **UI 落点**:React 复核视图(试卷部分),上传入口在复核视图;产品 API 走 backend TS,加工走 pipeline `/internal/*`。
2. **上传格式**:PDF + 多张 JPG/PNG;backend TS 用 pdf-lib 把多图按顺序合成 PDF(每图一页),pipeline 只收 PDF。
3. **元数据**:上传表单 upfront 填孩子(下拉 `/api/children`)+ 标题(文件名预填可改)+ 科目(语文/数学/英语/其他);上传后允许修改。
4. **VLM 策略**:每页单次调用,整页输出结构化 JSON(拆题 + 作答 + 对错痕迹);误差修正走页级重识别。
5. **匹配策略**:拆题完成后 TS 预计算——混合检索(限同学科)+ rerank,top-1 余弦 ≥ 阈值(默认 0.88,env 可调)自动关联,否则复核页人工从 top-5 候选选。
6. **编排**:TS 当总指挥(状态机、匹配、确认),pipeline 是无状态工人(渲染 + VLM + 裁图 + 拆题落库);不引入消息队列。
7. **确认流**:VLM 结果预选中,1=错 2=对 3=半对、Enter=采纳并下一条;错因下拉四选(粗心/概念不清/方法不会/计算错)+ 备注自由文本;改判 = UPDATE 同一条 attempt;匹配不阻塞对错确认。

对第 4 项的一处修正:brainstorming 时说"单题重新识别"后手,细化后改为**页级重识别**。
理由:bbox 识别错了,单题裁图重识别救不回来(裁图本身就是坏的),只有重跑整页才能修;页级替换也顺带修复该页的拆题边界。

## 数据模型(migration `0011_papers.sql`,pipeline 侧)

```sql
CREATE TABLE papers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    child_id uuid NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    title text NOT NULL,
    subject text NOT NULL CHECK (subject IN ('语文','数学','英语','其他')),
    source_path text NOT NULL,                -- 绝对路径,storage/papers/<id>/source.pdf
    page_count int NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing','ready_for_review','done','failed')),
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE paper_questions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id uuid NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    page_no int NOT NULL,
    seq_in_page int NOT NULL,
    content_md text NOT NULL,                 -- VLM 识别的题干
    answer_excerpt text,                      -- 识别到的作答摘录
    mark_desc text,                           -- 批改痕迹描述(如「老师红笔 ✗」)
    recognized_result text CHECK (recognized_result IN ('correct','wrong','partial')),
    confirmed_result text CHECK (confirmed_result IN ('correct','wrong','partial')),
    error_cause text CHECK (error_cause IN ('粗心','概念不清','方法不会','计算错')),
    note text,
    bbox jsonb,                               -- [x1,y1,x2,y2] 0-1000 归一化;null=整页兜底
    image_path text,                          -- 题图裁切绝对路径
    matched_item_id uuid REFERENCES items(id) ON DELETE SET NULL,
    match_score real,                         -- 余弦相似度
    matched_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (paper_id, page_no, seq_in_page)
);
CREATE INDEX idx_paper_questions_paper ON paper_questions(paper_id);

ALTER TABLE attempts DROP CONSTRAINT attempts_item_id_check;
ALTER TABLE attempts ADD COLUMN paper_question_id uuid
    REFERENCES paper_questions(id) ON DELETE CASCADE;
ALTER TABLE attempts ADD CHECK (item_id IS NOT NULL OR paper_question_id IS NOT NULL);

ALTER TABLE llm_calls ADD COLUMN paper_id uuid REFERENCES papers(id) ON DELETE SET NULL;
```

要点:

- 排序键 = `(page_no, seq_in_page)`,不存全局题号;「第 N 题」展示时计算。
  页级重识别只动该页的行,其他页的 attempts 外键不受影响。
- `attempts` 的 `ON DELETE CASCADE`:页级重识别删除该页题目时,对应 attempt 一并撤销(重识别 = 撤销重来,重新确认会再生成)。
- 手工标记(`POST /api/attempts`,item_id 直标)不受影响,仍可多条追加。

## 编排与状态机(TS)

```
POST /api/papers ──► 建行 status=processing ──► 后台任务:
   pipeline POST /internal/ingest-paper(multipart: pdf + paper_id)
   ├─ 成功 → TS 逐题匹配 → status=ready_for_review(0 题识别 → failed)
   └─ 失败 → status=failed + error 文案
```

- `processing → ready_for_review → done`(全部题 confirmed 后由确认接口推进);`failed` 可重试。
- **幂等**:pipeline 每次全量替换该卷的 paper_questions(先删后插),重跑安全。
- **韧性**:backend 启动时把滞留 `processing` 的卷重新驱动;failed 卷在复核视图给重试按钮(同一条重驱动路径)。
- **并发**:每卷一个进程内后台任务,多卷并行,不做队列。
- 处理期间进度只到卷粒度(转圈 + 总页数),不做逐页进度。
- 匹配在 TS 等 pipeline 返回后同步执行(每题一次混合检索,几秒内完成)。

## 文件与路径

```
pipeline/storage/papers/<paper_id>/source.pdf
pipeline/storage/papers/<paper_id>/pages/p0001.png          # DPI 200,复用 render 组件
pipeline/storage/papers/<paper_id>/questions/p0001_q01.png  # 按 bbox 从页图裁切
```

- TS 收上传后合成 PDF,**以 multipart 字节流发给 pipeline**,pipeline 负责一切文件写入(目录布局归 pipeline 所有)。
- TS 只读文件:复核视图的页图/题图由 backend API 从文件系统直读回传。
  backend 配置 `KB_STORAGE_ROOT`(默认仓库内 `../pipeline/storage`),同机部署假设显式化。
- DB 内路径一律绝对路径(与 render.py 现有约定一致)。

## VLM 拆题识别(pipeline)

`POST /internal/ingest-paper`:存 source.pdf → 渲染页图 → 每页一次 VLM → 裁题图 → 全量替换写入 paper_questions → 返回 `{pages, questions}`。

每页 prompt 要点(骨架):

- 角色:试卷解析。输出**纯 JSON**,不要 markdown 代码围栏。
- `{"questions": [{"seq_in_page": 1, "bbox": [x1,y1,x2,y2], "content_md": "题干(LaTeX 公式)",
  "answer_excerpt": "作答内容摘录", "result": "wrong|correct|partial|null", "mark_desc": "痕迹描述"}]}`
- bbox 用 0-1000 归一化坐标;判定规则:明确 ✓ → correct,✗/红圈/扣分 → wrong,半对 → partial,无痕迹或没把握 → null。
- 忽略页眉页脚、姓名、分数栏;题目按阅读顺序;正文公式用 LaTeX。

健壮性:

- JSON 解析失败或校验不过 → 携带错误信息重试一次;再失败该卷 failed。
- bbox 缺失/越界 → clamp 到页面;仍非法 → null,题图兜底整页。
- VLM 调用计量 `llm_calls(purpose='paper_vlm', modality='image', paper_id=<id>)`,复用 `record_llm_call`。
- 单页 VLM 超时 5 分钟;internal HTTP 总超时 10 分钟。
- 测试沿用 `vlm_client` 注入假实现的既有模式。

**页级重识别**:`POST /internal/recognize-page {paper_id, page_no}`——删该页题目、重跑该页 VLM 与裁图、重插。
TS 侧随后对该页新题重跑匹配;若卷已是 done,退回 ready_for_review。

## 题库匹配(TS,检索主链路)

- 前置小改造:`hybridSearch` 的 hit 贯通**向量余弦分**(`vec_score`,RRF 融合前保留),供阈值判定。
  需要的话顺手把 BM25 命中行无 `vec_score` 视为不满足阈值。
- 每题匹配:`hybridSearch(content_md, topK=10, filters={subject})` + rerank。
- 自动关联:rerank 排序后的第 1 名 `vec_score ≥ MATCH_THRESHOLD`(env `KB_MATCH_THRESHOLD`,默认 0.88)→ 写 `matched_item_id + match_score + matched_at`。
  宁缺勿滥:错关联比漏关联伤害大。
- 未自动关联的题:复核页点「待匹配」时**实时检索** top-5 候选展示(不落库),人工点选后写 matched_item_id。
- 匹配不阻塞对错确认;`matched_item_id` 可随时设置/清除,变更同步 attempt 的 `item_id`。

## 确认流(TS + 前端)

- `PUT /api/paper-questions/:id/confirm {result, error_cause?, note?}`:
  更新 paper_questions 的 confirmed/error_cause/note;
  upsert attempt——已有该 paper_question_id 的行则 UPDATE(result/error_cause/note/item_id 同步 matched_item_id),否则 INSERT(child_id 取自卷,item_id 取 matched_item_id)。
- 全部题 confirmed → `papers.status='done'`(确认接口内推进)。
- 前端键盘:1=错 2=对 3=半对(立即确认并跳下一条),Enter=采纳预选并跳;焦点在错因/备注输入框时数字键不触发判定。
- VLM 的 recognized_result 在 UI 预选中;改判随时可做(UPDATE 语义)。

## API 一览(backend TS)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/papers` | multipart:files[] + child_id/title/subject;合成 PDF、建行、触发加工 |
| GET | `/api/papers?child_id=` | 列表:元数据 + status + 确认进度(n/m) |
| GET | `/api/papers/:id` | 详情:元数据 + 全部题目(全字段) |
| PATCH | `/api/papers/:id` | 改 title/subject/child_id |
| POST | `/api/papers/:id/retry` | failed → processing,重驱动 |
| POST | `/api/papers/:id/re-recognize` | `{page_no}` 页级重识别 |
| PUT | `/api/paper-questions/:id/confirm` | 确认对错(见上) |
| PUT | `/api/paper-questions/:id/match` | `{item_id\|null}` 人工设置/清除匹配 |
| GET | `/api/paper-questions/:id/candidates` | 实时混合检索 top-5 候选 |
| GET | `/api/paper-questions/:id/image` | 题图裁切回传 |
| GET | `/api/papers/:id/pages/:n/image` | 页图回传 |

children(`GET /api/children`)与手工 attempts API(Phase 1)不变。

## 前端(复核视图)

- Rail 的「复核」按钮启用,进入 ReviewView;视觉沿用原型令牌(作业本+红笔)。
- 布局(试卷中心,原型的逐题队列是 Phase 3 统一后的形态):
  左列 = 试卷列表(标题/孩子/科目/状态 badge/确认进度 n/m)+ 顶部「上传试卷」按钮;
  右侧 = 选中卷的当前题详情(原卷裁图 | 识别内容双栏,判定按钮 ✓/✗/½,错因下拉 + 备注,匹配信息行)+ 底部小导航(该卷题目缩略序列,跳题)。
- 上传弹层:孩子/标题/科目 + 文件多选(accept: pdf/jpg/png,可拖放);提交后列表出现 processing 卷,前端 2s 轮询至状态稳定。
- 待匹配题显示 badge;点开候选浮层(top-5:相似度 + 书名·章节·题号)点选关联。
- done 卷可回看、可改判与改匹配（不影响状态）；键盘连转停用;failed 卷显示错误信息 + 重试按钮。
- SSE/流式不涉及;沿用现有 api 层模式,fetch 注入保持可测。

## 明确不做(本期)

- 逐页/逐题处理进度百分比(只到卷粒度转圈)。
- HEIC 等非 JPG/PNG 图片格式(前端 accept 挡住)。
- 复核队列与资料解析复核的统一(Phase 3 迁移时合并);统计页消费 attempts(Phase 3)。
- 试卷删除(级联语义牵扯 attempts 审计,留待需要时设计)。
- VLM 预填错因(错因是教育判断,留给家长)。

## 风险与待验证点

- **bbox 精度**:VLM 归一化坐标可能偏;题图仅辅助展示,bbox null 有整页兜底;实现时用真实试卷校验。
- **JSON 输出可靠性**:25 题长输出可能被截断/夹带围栏;重试一次 + 容错解析;max_tokens 给足。
- **阈值 0.88 是拍脑袋初值**:实现后拿真实题对标定(同题直录 ≈0.99+,改写 ≈0.9+,同题型不同题 ≈0.75-0.85),env 可调不停服。
- 远端 VLM 限流/延迟:整卷串行页处理,家用规模可接受;失败有重试闭环。

## 测试与验收

分层:

- **pipeline(pytest)**:ingest-paper 幂等(重跑全量替换)、VLM JSON 解析容错(假 client 注入)、bbox clamp、裁图落盘、recognize-page 只动目标页、计量行 paper_vlm+paper_id。
- **backend(vitest)**:papers 路由(上传校验/状态流转/元数据修改/重试)、合成 PDF(pdf-lib,JPG/PNG 多图)、后台任务与启动重驱动(假 pipeline HTTP)、匹配(vec_score 阈值/auto 与人工路径/hybridSearch 贯通改造)、confirm upsert attempt(含改判 UPDATE、匹配变更同步 item_id、全确认推进 done)、图片回传(路径安全)。
- **frontend(vitest)**:复核视图组件与上传表单、键盘流转(焦点守卫)、轮询、候选浮层。
- **E2E(Playwright,e2e/ 新 spec)**:用脚本生成合成试卷 PDF(3 题,红 ✗/✓/无痕迹),种子一条同文题库 item(ollama bge-m3 算 embedding 直插 chunks);走完整链路——上传 → processing → ready_for_review → 题目数与 recognized_result 断言 → 键盘确认(含错因) → `attempts` 行逐字段核对 → 自动匹配断言 → done 状态。
  合成试卷的生成脚本进 `e2e/fixtures/`,可重复使用。

验收标准(用户路径):

1. 拍 3 张照片顺序上传,合成 PDF,处理完出现在复核视图,题目拆分正确、对错预识别正确。
2. 键盘 1/2/3 + Enter 连续确认,`attempts` 与 `paper_questions` 数据逐字段正确。
3. 同题已在题库的卷,拆题后自动关联;不满足阈值的题,人工从候选里选上。
4. 改判与元数据修改即时生效;页级重识别重置该页;failed 卷可重试。
5. 全栈测试绿:pipeline + backend + frontend + Playwright E2E。
