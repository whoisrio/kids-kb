import { describe, expect, it } from "vitest";
import { fetchRouter, jsonResponse } from "../test/support";
import { fetchStatsOverview, fetchUsageOverview, recordCorrection } from "./stats";

describe("api/stats", () => {
  it("fetchStatsOverview 拼 child_id；fetchUsageOverview 无参", async () => {
    let seen = "";
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen = String(input);
      return jsonResponse({ hero: {}, causes: [], weakTags: [], trend: [], pendingList: [] });
    };
    await fetchStatsOverview("c1", fetchImpl);
    expect(seen).toBe("/api/stats/overview?child_id=c1");
    await fetchUsageOverview(fetchImpl);
    expect(seen).toBe("/api/usage/overview");
  });

  it("recordCorrection：item 题 → POST /api/attempts；试卷题 → PUT confirm", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({ id: "x" });
    };
    await recordCorrection(
      { id: "i1", kind: "item", content: "", source: "", errorCause: null, lastAt: "" },
      "c1",
      fetchImpl,
    );
    await recordCorrection(
      { id: "pq1", kind: "paper", content: "", source: "", errorCause: null, lastAt: "" },
      "c1",
      fetchImpl,
    );
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/attempts",
        body: { child_id: "c1", item_id: "i1", result: "correct" },
      },
      {
        method: "PUT",
        url: "/api/paper-questions/pq1/confirm",
        body: { result: "correct" },
      },
    ]);
  });

  it("非 2xx 抛错（message 取 body.error）", async () => {
    const fetchImpl = fetchRouter({
      "/api/stats/overview?child_id=nope": () => jsonResponse({ error: "child_id 不存在" }, 404),
    });
    await expect(fetchStatsOverview("nope", fetchImpl)).rejects.toThrow("child_id 不存在");
  });
});
