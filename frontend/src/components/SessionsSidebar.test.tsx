import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../api/chat";
import { SessionsSidebar } from "./SessionsSidebar";

const SESSIONS: SessionSummary[] = [
  { id: "s1", title: "口算题", model: "qwen3:4b", createdAt: 1, modifiedAt: 2 },
  { id: "s2", title: "英语语法错因", model: "deepseek-v3", createdAt: 3, modifiedAt: 4 },
];

describe("SessionsSidebar", () => {
  it("渲染会话列表（标题 + 模型），当前会话高亮标记", () => {
    render(
      <SessionsSidebar sessions={SESSIONS} activeId="s1" onSelect={() => {}} onNew={() => {}} onDelete={() => {}} />,
    );
    expect(screen.getByText("口算题")).toBeInTheDocument();
    expect(screen.getByText("英语语法错因")).toBeInTheDocument();
    expect(screen.getByText("qwen3:4b")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    // 当前会话标记
    expect(screen.getByText("口算题").closest("button")).toHaveClass("active");
    expect(screen.getByText("英语语法错因").closest("button")).not.toHaveClass("active");
  });

  it("点击会话 → onSelect(id)；「新对话」→ onNew", () => {
    const onSelect = vi.fn();
    const onNew = vi.fn();
    render(
      <SessionsSidebar sessions={SESSIONS} activeId="s1" onSelect={onSelect} onNew={onNew} onDelete={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("英语语法错因"));
    expect(onSelect).toHaveBeenCalledWith("s2");
    expect(onSelect).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "＋ 新对话" }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("无会话时空态提示", () => {
    render(<SessionsSidebar sessions={[]} activeId={null} onSelect={() => {}} onNew={() => {}} onDelete={() => {}} />);
    expect(screen.getByText("还没有历史会话")).toBeInTheDocument();
  });

  it("meta 行显示模型与修改时间（MM-DD HH:mm）", () => {
    render(
      <SessionsSidebar sessions={SESSIONS} activeId="s1" onSelect={() => {}} onNew={() => {}} onDelete={() => {}} />,
    );
    const meta = screen.getByText("qwen3:4b").closest(".m");
    expect(meta).not.toBeNull();
    const time = meta!.querySelector("span:not(.model)");
    expect(time?.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
