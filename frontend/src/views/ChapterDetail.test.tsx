import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChapterDetail } from "./ChapterDetail";

describe("ChapterDetail", () => {
  it("renders chapter markdown and shows index status", () => {
    render(<ChapterDetail
      docId="d1"
      chapters={[{ id: "ch1", chapter_no: 1, title: "第一章",
        content_md: "# 第一章 内容", review_status: "auto_passed", index_status: "indexed" }]}
      onExit={() => {}}
    />);
    expect(screen.getByText("第一章")).toBeInTheDocument();
    expect(screen.getByText("已索引")).toBeInTheDocument();
    expect(screen.getByText(/第一章 内容/)).toBeInTheDocument();
  });
});
