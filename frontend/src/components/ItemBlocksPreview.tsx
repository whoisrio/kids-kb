import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { ItemBlock } from "../api/papers";

/** 公式/图/表块用原书裁图呈现（重排 LaTeX 对竖式等必翻车）；文字块渲染 Markdown。 */
const IMAGE_TYPES = new Set(["formula", "figure", "table"]);

function BlockImage({ block }: { block: ItemBlock }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    // 裁图 404/丢失时回退块文本，不让对照区开天窗
    return <div className="ibp-md"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}>{block.content_md ?? ""}</ReactMarkdown></div>;
  }
  return <img className="ibp-crop" src={block.crop_url} alt={`题库块 ${block.block_id}`}
              onError={() => setFailed(true)} />;
}

/** 题目级混合呈现：文字块渲染 Markdown，公式/图/表块用裁图（原比例只缩不放）。 */
export function ItemBlocksPreview({ blocks }: { blocks: ItemBlock[] }) {
  return (
    <div className="ibp">
      {blocks.map((b) => (
        <div key={b.block_id} className="ibp-block">
          {IMAGE_TYPES.has(b.block_type) ? (
            <BlockImage block={b} />
          ) : (
            <div className="ibp-md"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}>{b.content_md ?? ""}</ReactMarkdown></div>
          )}
        </div>
      ))}
    </div>
  );
}
