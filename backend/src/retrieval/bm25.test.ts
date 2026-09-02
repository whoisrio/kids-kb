import { describe, expect, it } from "vitest";
import { tokenize, bm25Score } from "./bm25.js";

describe("tokenize（与 pipeline kb/lexical.py 一致）", () => {
  it("英数按词、CJK 按二元组", () => {
    expect(tokenize("abc 竖式谜")).toEqual(["abc", "竖式", "式谜"]);
    expect(tokenize("例1 在下面方框")).toContain("1");
  });
});

describe("bm25Score", () => {
  it("命中文档分数高于未命中", () => {
    const docs = ["三位数乘两位数的竖式计算", "阅读理解练习"];
    const hits = bm25Score("竖式", docs);
    expect(hits[0].index).toBe(0);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});
