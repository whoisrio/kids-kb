import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BlockGeometryDiff } from "./BlockGeometryDiff";

describe("BlockGeometryDiff", () => {
  it("行级差异高亮 + 三个操作按钮回调", () => {
    const onConfirm = vi.fn();
    render(<BlockGeometryDiff
      oldText={"旧行\n共同\n旧增"}
      newText={"新行\n共同\n新增"}
      onConfirm={onConfirm} onCancel={vi.fn()}
    />);
    expect(screen.getByText("旧行")).toHaveClass("removed");
    expect(screen.getByText("旧增")).toHaveClass("removed");
    expect(screen.getAllByText("共同").every((line) => !line.classList.contains("removed"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "采用新文本" }));
    expect(onConfirm).toHaveBeenCalledWith("新行\n共同\n新增");
    fireEvent.click(screen.getByRole("button", { name: "保留原文本" }));
    expect(onConfirm).toHaveBeenCalledWith("旧行\n共同\n旧增");
    fireEvent.click(screen.getByRole("button", { name: "手动改" }));
    fireEvent.change(screen.getByRole("textbox", { name: "手动改文本" }), { target: { value: "手改" } });
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    expect(onConfirm).toHaveBeenCalledWith("手改");
  });

  it("新识别结果按 Markdown 渲染数学公式", () => {
    render(<BlockGeometryDiff
      oldText="原文"
      newText={"**加粗**\n\n$$1+1=2$$"}
      onConfirm={vi.fn()} onCancel={vi.fn()}
    />);

    expect(screen.getByText("加粗").tagName).toBe("STRONG");
    expect(screen.getByText("加粗").closest(".md")).toHaveClass("block-geometry-markdown");
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
    expect(document.querySelector(".block-geometry-markdown .katex")).not.toBeNull();
  });
});
