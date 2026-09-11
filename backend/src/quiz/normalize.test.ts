/** AI 出题输出归一化（移植自 openMAIC scene-generator.ts 的 normalizeQuizOptions/normalizeQuizAnswer）。 */
import { describe, expect, it } from "vitest";
import {
  normalizeGeneratedQuestions,
  normalizeQuizAnswer,
  normalizeQuizOptions,
} from "./normalize.js";

describe("normalizeQuizOptions", () => {
  it("string options → {value: A..Z, label}", () => {
    expect(normalizeQuizOptions(["甲", "乙", "丙"])).toEqual([
      { value: "A", label: "甲" },
      { value: "B", label: "乙" },
      { value: "C", label: "丙" },
    ]);
  });
  it("对象 options 保留 value/label；缺 label 兜底 value → text → 字母", () => {
    expect(normalizeQuizOptions([{ label: "甲", value: "X" }])).toEqual([{ value: "X", label: "甲" }]);
    expect(normalizeQuizOptions([{ value: "B" }])).toEqual([{ value: "B", label: "B" }]);
    expect(normalizeQuizOptions([{ text: "文本" }])).toEqual([{ value: "A", label: "文本" }]);
    expect(normalizeQuizOptions([{}])).toEqual([{ value: "A", label: "A" }]);
  });
  it("非数组 → undefined", () => {
    expect(normalizeQuizOptions(undefined)).toBeUndefined();
    expect(normalizeQuizOptions("nope")).toBeUndefined();
  });
});

describe("normalizeQuizAnswer", () => {
  it("answer ?? correctAnswer ?? correct_answer", () => {
    expect(normalizeQuizAnswer({ answer: ["A"] })).toEqual(["A"]);
    expect(normalizeQuizAnswer({ correctAnswer: "B" })).toEqual(["B"]);
    expect(normalizeQuizAnswer({ correct_answer: "C" })).toEqual(["C"]);
    expect(normalizeQuizAnswer({ answer: ["A"], correctAnswer: "B" })).toEqual(["A"]);
  });
  it("string → [string]，数组元素转 string，缺省 → undefined", () => {
    expect(normalizeQuizAnswer({ answer: "A" })).toEqual(["A"]);
    expect(normalizeQuizAnswer({ answer: [1, 2] })).toEqual(["1", "2"]);
    expect(normalizeQuizAnswer({})).toBeUndefined();
  });
});

describe("normalizeGeneratedQuestions", () => {
  it("合法混合题型 → 清洗后的 QuizQuestion[]", () => {
    const out = normalizeGeneratedQuestions([
      { id: "q1", type: "single", question: "1+1=?", options: ["1", "2"], correctAnswer: "B", analysis: "算数", points: 10 },
      { id: "q2", type: "multiple", question: "选偶数", options: [{ label: "2", value: "A" }, { label: "3", value: "B" }], answer: ["A"], analysis: "定义", points: 15 },
      { id: "q3", type: "short_answer", question: "说说为什么", commentPrompt: "要点", analysis: "参考", points: 20 },
    ]);
    expect(out).toHaveLength(3);
    expect(out![0]).toMatchObject({
      id: "q1", type: "single", answer: ["B"], points: 10,
      options: [{ value: "A", label: "1" }, { value: "B", label: "2" }],
    });
    expect(out![2]).toMatchObject({ id: "q3", type: "short_answer", commentPrompt: "要点", points: 20 });
  });

  it("short_answer 清掉 options/answer（即使模型给了）", () => {
    const out = normalizeGeneratedQuestions([
      { id: "q3", type: "short_answer", question: "说说", options: ["x"], answer: ["A"], commentPrompt: "r", points: 10 },
    ]);
    expect(out![0].options).toBeNull();
    expect(out![0].answer).toBeNull();
  });

  it("缺 id 自动补；points 缺省 10", () => {
    const out = normalizeGeneratedQuestions([
      { type: "single", question: "1+1=?", options: ["1", "2"], answer: ["B"] },
    ]);
    expect(out![0].id).toBeTruthy();
    expect(out![0].points).toBe(10);
  });

  it("非法输出 → null：非数组/空数组/选择题缺 options/缺 answer/未知 type/缺 question", () => {
    expect(normalizeGeneratedQuestions("not json")).toBeNull();
    expect(normalizeGeneratedQuestions([])).toBeNull();
    expect(normalizeGeneratedQuestions([{ type: "single", question: "q", answer: ["A"] }])).toBeNull();
    expect(normalizeGeneratedQuestions([{ type: "single", question: "q", options: ["a", "b"] }])).toBeNull();
    expect(normalizeGeneratedQuestions([{ type: "single", question: "q", options: ["a"], answer: ["A"] }])).toBeNull();
    expect(normalizeGeneratedQuestions([{ type: "fill_blank", question: "q" }])).toBeNull();
    expect(normalizeGeneratedQuestions([{ type: "single", options: ["a", "b"], answer: ["A"] }])).toBeNull();
  });
});
