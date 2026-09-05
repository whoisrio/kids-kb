import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";
import type { ChatMessage, LaneInfo } from "../api/chat";

const LANES: LaneInfo[] = [
  { id: "main", forkEntryId: null, fromLaneId: null },
  { id: "br-1", forkEntryId: "e0", fromLaneId: "main" },
];
const MSGS: ChatMessage[] = [
  { role: "user", content: "q1", entryId: "e0" },
  { role: "assistant", content: "a1", entryId: "e1" },
];

describe("ChatView", () => {
  it("‹i/n› 切换器：同一父消息下有分叉时出现，点击切到对应 lane", () => {
    const onSwitchLane = vi.fn();
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="br-1"
      rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={onSwitchLane} onToast={vi.fn()}
    />);
    expect(screen.getByText("2/2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "‹" }));
    expect(onSwitchLane).toHaveBeenCalledWith("main");
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="main" rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={onSwitchLane} onToast={vi.fn()}
    />);
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("rewind：截断显示 + 提示条；取消恢复", () => {
    render(<ChatView
      messages={MSGS} streaming={false} lanes={LANES} currentLane="main"
      rewindTo={{ index: 0, entryId: "e0" }}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={vi.fn()} onToast={vi.fn()}
    />);
    expect(screen.queryByText("a1")).toBeNull();
    expect(screen.getByText(/后续内容保留在原分支/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消回退" }));
    expect(screen.getByRole("button", { name: "取消回退" })).toBeInTheDocument();
  });

  it("无分叉的消息无切换器；复制走 onCopy 消息原文", () => {
    const onToast = vi.fn();
    const onCopy = vi.fn();
    render(<ChatView
      messages={[{ role: "user", content: "单分支", entryId: "e0" }]}
      streaming={false}
      lanes={[LANES[0]]} currentLane="main" rewindTo={null}
      onSend={vi.fn()} onEdit={vi.fn()} onRewind={vi.fn()} onCancelRewind={vi.fn()}
      onRegenerate={vi.fn()} onSwitchLane={vi.fn()} onToast={onToast}
    />);
    expect(screen.queryByText("1/1")).toBeNull();
  });
});
