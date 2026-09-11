import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { fetchQuiz, fetchQuizzes, generateQuiz, submitQuiz } from "./quizzes";

const SUMMARY = {
  id: "q1",
  child_id: "c1",
  title: "薄弱点专项练习",
  tags: ["计算类"],
  status: "pending",
  created_at: "2026-09-10T00:00:00Z",
  submitted_at: null,
  question_count: 3,
  total_points: 30,
  earned_points: null,
};

describe("api/quizzes", () => {
  it("generateQuiz：POST /api/quizzes/generate，body 带 child_id 与可选参数", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({ quiz: SUMMARY });
    };
    const quiz = await generateQuiz("c1", { count: 5 }, fetchImpl);
    expect(quiz.id).toBe("q1");
    expect(calls).toEqual([
      { method: "POST", url: "/api/quizzes/generate", body: { child_id: "c1", count: 5 } },
    ]);
    await generateQuiz("c1", undefined, fetchImpl);
    expect(calls[1].body).toEqual({ child_id: "c1" });
  });

  it("generateQuiz：409 no_weak_tags 抛错，message 取 body.error", async () => {
    const fetchImpl = fetchRouter({
      "/api/quizzes/generate": () => jsonResponse({ error: "no_weak_tags" }, 409),
    });
    await expect(generateQuiz("c1", undefined, fetchImpl)).rejects.toThrow("no_weak_tags");
  });

  it("fetchQuizzes：GET /api/quizzes?child_id= 拼 query", async () => {
    let seen = "";
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ quizzes: [SUMMARY] });
    };
    const quizzes = await fetchQuizzes("c 1", fetchImpl);
    expect(seen).toBe(`/api/quizzes?child_id=${encodeURIComponent("c 1")}`);
    expect(quizzes).toHaveLength(1);
  });

  it("fetchQuiz：GET /api/quizzes/:id 返回详情", async () => {
    const fetchImpl = fetchRouter({
      "/api/quizzes/q1": () => jsonResponse({ quiz: { ...SUMMARY, questions: [] } }),
    });
    const detail = await fetchQuiz("q1", fetchImpl);
    expect(detail.questions).toEqual([]);
  });

  it("submitQuiz：POST /api/quizzes/:id/submit，body 为 answers 映射", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({
        quiz: { ...SUMMARY, status: "submitted", earned_points: 20 },
        results: [
          { question_id: "qu1", result: "correct", earned: 10, points: 10, comment: null },
        ],
      });
    };
    const out = await submitQuiz("q1", { qu1: "B", qu2: ["A", "C"], qu3: "复核一遍" }, fetchImpl);
    expect(out.quiz.earned_points).toBe(20);
    expect(out.results[0].result).toBe("correct");
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/quizzes/q1/submit",
        body: { answers: { qu1: "B", qu2: ["A", "C"], qu3: "复核一遍" } },
      },
    ]);
  });

  it("submitQuiz：409 already_submitted 抛错", async () => {
    const fetchImpl = fetchRouter({
      "/api/quizzes/q1/submit": () => jsonResponse({ error: "already_submitted" }, 409),
    });
    await expect(submitQuiz("q1", {}, fetchImpl)).rejects.toThrow("already_submitted");
  });
});
