import { describe, expect, it } from "vitest";
import { renderRichText } from "./katex";

describe("renderRichText", () => {
  it("普通文本做 HTML 转义，防反射型 XSS", () => {
    const out = renderRichText("<img src=x onerror=alert(1)>");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("<img");
  });

  it("$...$ 行内公式正常渲染为 KaTeX HTML", () => {
    const out = renderRichText("计算 $x^2$ 的值");
    expect(out).toContain("katex");
    expect(out).toContain("计算");
  });

  it("混排：数学渲染、两侧文本转义", () => {
    const out = renderRichText("前 <b>加粗</b> 数学 $x^2$ 后 <script>alert(1)</script>");
    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("katex");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});
