import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ItemBlocksPreview } from "./ItemBlocksPreview";

const BLOCKS = [
  { block_id: "b1", block_type: "text", content_md: "在下面方框填上 $1+1$", crop_url: "/api/review/blocks/b1/crop" },
  { block_id: "b2", block_type: "formula", content_md: "$$x$$", crop_url: "/api/review/blocks/b2/crop" },
];

describe("ItemBlocksPreview", () => {
  it("文字块渲染 Markdown（含 KaTeX），公式块用原书裁图", () => {
    const { container } = render(<ItemBlocksPreview blocks={BLOCKS} />);
    expect(container.querySelector(".katex")).not.toBeNull();  // 文字块里的 $1+1$
    const img = container.querySelector('img[src="/api/review/blocks/b2/crop"]');
    expect(img).not.toBeNull();  // 公式块走裁图
  });

  it("裁图加载失败回退渲染块文本", () => {
    const { container } = render(<ItemBlocksPreview blocks={BLOCKS} />);
    const img = container.querySelector('img[src="/api/review/blocks/b2/crop"]')!;
    fireEvent.error(img);
    expect(container.querySelector(".ibp-block .katex")).not.toBeNull();  // $$x$$ 回退为 KaTeX 文本
    expect(container.querySelector('img[src="/api/review/blocks/b2/crop"]')).toBeNull();
  });
});
