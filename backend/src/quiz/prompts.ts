/** 出题/判分 prompt 模板（中文）。
    出题 prompt 改写自 openMAIC templates/quiz-content/system.md + snippets/json-output-rules.md（MIT），
    schema 以 system.md 为唯一标准；简答判分 prompt 取自 app/api/quiz-grade/route.ts 中文版。 */

export type Difficulty = "easy" | "medium" | "hard";

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: "简单（基础记忆、概念直接应用）",
  medium: "中等（需要理解和简单分析）",
  hard: "困难（需要综合、评估或复杂推理）",
};

const TYPE_LABEL: Record<string, string> = {
  single: "单选",
  multiple: "多选",
  short_answer: "简答",
};

const GENERATE_SYSTEM = `# 出题专家

你是一位专业的小学教育测评设计专家。你的任务是根据学生的薄弱知识点生成测验题，输出为 JSON 数组。

## 输出格式要求（必须严格遵守）

1. 直接输出纯 JSON，不要任何解释或说明
2. 不要用 \`\`\`json 代码块包裹
3. 不要在 JSON 前后添加任何文字
4. 确保 JSON 格式正确、可以直接解析

## 题目要求

- 题干清晰无歧义
- 选项设计合理
- 正确答案准确
- 每题必须包含 analysis（判分后展示的解析）
- 每题必须包含 points（按难度与复杂度给不同分值）
- 简答题必须包含详细的 commentPrompt（评分要点/rubric）
- 需要数学公式时用纯文本描述，不要使用 LaTeX 语法

## 题型 schema（严格按此结构，字段名不可更改）

### 单选（single）—— 只有一个正确选项

{"id":"q1","type":"single","question":"题干","options":[{"label":"选项A内容","value":"A"},{"label":"选项B内容","value":"B"},{"label":"选项C内容","value":"C"},{"label":"选项D内容","value":"D"}],"answer":["A"],"analysis":"为什么 A 对、其他选项错在哪里","points":10}

### 多选（multiple）—— 两个或以上正确选项

{"id":"q2","type":"multiple","question":"题干（选出所有正确项）","options":[{"label":"选项A内容","value":"A"},{"label":"选项B内容","value":"B"},{"label":"选项C内容","value":"C"},{"label":"选项D内容","value":"D"}],"answer":["A","C"],"analysis":"正确组合的推理","points":15}

### 简答（short_answer）—— 开放式作答，没有 options 与 answer 字段

{"id":"q3","type":"short_answer","question":"需要文字作答的题干","commentPrompt":"评分要点：(1) 关键点A - 40% (2) 关键点B - 30% (3) 表达清晰 - 30%","analysis":"参考答案/好答案应覆盖的要点","points":20}

## 设计原则

### 题干设计

- 简洁清晰，避免歧义
- 聚焦指定的薄弱知识点
- 难度符合指定级别

### 选项设计（选择题）

- 各选项长度相近
- 干扰项要"像真的"但明确错误——针对典型错误设计（如计算错、概念混淆、看错条件）
- 不用"以上都对"/"以上都不对"
- 正确答案位置随机分布

### 难度标准

| 难度 | 说明 |
| ---- | ---- |
| easy | 基础记忆、概念直接应用 |
| medium | 需要理解和简单分析 |
| hard | 需要综合、评估或复杂推理 |`;

export interface GeneratePromptInput {
  tags: string[];
  count: number;
  difficulty: Difficulty;
  types: string[];
  /** 参考例题（题库 content_md 摘录）。 */
  examples: string[];
}

export function buildGeneratePrompts(input: GeneratePromptInput): { system: string; user: string } {
  const examples = input.examples.length
    ? input.examples.map((e, i) => `${i + 1}. ${e}`).join("\n")
    : "（无）";
  const user = `薄弱知识点：${input.tags.join("、")}
题目数量：${input.count}，难度：${DIFFICULTY_LABEL[input.difficulty]}，题型：${input.types.map((t) => TYPE_LABEL[t] ?? t).join("、")}

参考例题（来自孩子做错的题库，仅供把握知识点与难度，不要照抄）：
${examples}

直接输出 JSON 数组（共 ${input.count} 道题，不要解释、不要代码块、不要 LaTeX）。`;
  return { system: GENERATE_SYSTEM, user };
}

export interface GradePromptInput {
  question: string;
  userAnswer: string;
  points: number;
  commentPrompt?: string | null;
}

/** 简答 AI 判分 prompt（输出 {"score": 0..points 整数, "comment": 一两句评语}）。 */
export function buildShortAnswerGradePrompts(input: GradePromptInput): { system: string; user: string } {
  const system = `你是一位专业的教育评估专家。请根据题目和学生答案进行评分并给出简短评语。
必须以如下 JSON 格式回复（不要包含其他内容）：
{"score": <0到${input.points}的整数>, "comment": "<一两句评语>"}`;
  const user = `题目：${input.question}
满分：${input.points}分
${input.commentPrompt ? `评分要点：${input.commentPrompt}\n` : ""}学生答案：${input.userAnswer}`;
  return { system, user };
}
