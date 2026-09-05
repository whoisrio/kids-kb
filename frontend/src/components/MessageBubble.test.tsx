import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageBubble } from "./MessageBubble";
import type { ChatMessage } from "../api/chat";

const msg = (over: Partial<ChatMessage> & { role?: "user" | "assistant" }): ChatMessage => ({
  role: "assistant",
  content: "答案",
  ...over,
} as ChatMessage);

describe("MessageBubble", () => {
  it("assistant 消息渲染 markdown：GFM 表格/列表 + LaTeX 数学", () => {
    render(<MessageBubble
      message={msg({ content: "- 要点一\n- 要点二\n\n$3+4=7$\n\n| a | b |\n| - | - |\n| 1 | 2 |" })}
      index={0} isLast={false} streaming={false}
    />);
    expect(screen.getAllByText(/要点/)).toHaveLength(2);
    expect(document.querySelector(".bubble .katex")).not.toBeNull();
    expect(document.querySelectorAll("table")).toHaveLength(1);
  });

  it("user 消息保持纯文本转义（无 markdown/HTML 注入）", () => {
    render(<MessageBubble
      message={msg({ role: "user", content: "<b>加粗</b> *不是斜体*" })}
      index={0} isLast={false} streaming={false}
    />);
    expect(screen.getByText("<b>加粗</b> *不是斜体*")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("无 thinking 的消息不渲染面板；有 thinking 的历史轮默认折叠，点击头部展开", () => {
    const { rerender } = render(<MessageBubble
      message={msg({ thinking: "想了想" })} index={0} isLast={false} streaming={false}
    />);
    expect(screen.getByRole("button", { name: /思考过程/ })).toBeInTheDocument();
    expect(screen.queryByText("想了想")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /思考过程/ }));
    expect(screen.getByText("想了想")).toBeVisible();
    rerender(<MessageBubble message={msg({})} index={0} isLast={false} streaming={false} />);
    expect(screen.queryByText("思考过程")).toBeNull();
  });

  it("当前轮 thinking 输出期间展开，收到首个 delta 自动折叠", () => {
    const { rerender } = render(<MessageBubble
      message={msg({ content: "", thinking: "想" })} index={0} isLast={true} streaming={true}
    />);
    expect(screen.getByText("想")).toBeVisible();
    rerender(<MessageBubble
      message={msg({ content: "答案", thinking: "想" })} index={0} isLast={true} streaming={true}
    />);
    expect(screen.queryByText("想")).toBeNull();
  });

  it("hover 工具条：复制/编辑（user）/rewind/重新生成按 props 出现，编辑态保存回调", () => {
    const onEdit = vi.fn();
    const { rerender } = render(<MessageBubble
      message={msg({ role: "user", content: "原问题", entryId: "e0" })} index={0} isLast={false} streaming={false}
      actions={{ onEdit, onRewind: vi.fn(), onCopy: vi.fn() }}
    />);
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "改后" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onEdit).toHaveBeenCalledWith(0, "改后");
    rerender(<MessageBubble
      message={msg({ entryId: "e1" })} index={1} isLast={true} streaming={false}
      actions={{ onRegenerate: vi.fn(), onRewind: vi.fn(), onCopy: vi.fn() }}
    />);
    expect(screen.getByRole("button", { name: "重新生成" })).toBeInTheDocument();
  });
});
