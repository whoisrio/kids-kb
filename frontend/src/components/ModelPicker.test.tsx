import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../api/chat";
import { ModelPicker } from "./ModelPicker";

const MODELS: ModelInfo[] = [
  { provider: "chat", id: "qwen3:4b", name: "qwen3:4b" },
  { provider: "chat", id: "deepseek-v3", name: "deepseek-v3" },
];

describe("ModelPicker", () => {
  it("渲染全部模型选项，当前值选中", () => {
    render(<ModelPicker models={MODELS} value="qwen3:4b" onChange={() => {}} />);
    const select = screen.getByRole("combobox", { name: "选择模型" });
    expect(select).toHaveValue("qwen3:4b");
    expect(screen.getByRole("option", { name: "deepseek-v3" })).toBeInTheDocument();
  });

  it("切换选项 → onChange(新模型 id)", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={MODELS} value="qwen3:4b" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), {
      target: { value: "deepseek-v3" },
    });
    expect(onChange).toHaveBeenCalledWith("deepseek-v3");
  });

  it("模型列表为空（未加载/不可用）→ 不渲染", () => {
    const { container } = render(<ModelPicker models={[]} value="" onChange={() => {}} />);
    expect(container.querySelector(".model-select")).toBeNull();
  });
});
