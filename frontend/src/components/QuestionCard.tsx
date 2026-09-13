import { useEffect, useState } from "react";
import { questionImageUrl, pageImageUrl, type ItemBlock, type PaperQuestion } from "../api/papers";
import { fetchReviewItem } from "../api/review";
import { ItemBlocksPreview } from "./ItemBlocksPreview";

/** 裁图三态:bbox 缺失/裁图丢失时裁图 404 → 回退整页图;整页也没有才隐藏提示。 */
type Stage = "crop" | "page" | "missing";

/** 当前题双栏:原卷裁图(缺失回退整页图) | 识别内容(题干/作答/痕迹/匹配行)。 */
export function QuestionCard({ question }: { question: PaperQuestion }) {
  const [stage, setStage] = useState<Stage>("crop");
  const [itemBlocks, setItemBlocks] = useState<ItemBlock[] | null>(null);
  // 换题(未重挂载)时回到裁图态,不把上一题的回退结果带到下一题
  useEffect(() => { setStage("crop"); }, [question.id]);
  // 已匹配题库条目时拉取其原书块裁图，供「裁图对照」呈现；失败不阻断主流程
  useEffect(() => {
    setItemBlocks(null);
    if (!question.matched_item_id) return;
    let alive = true;
    fetchReviewItem(question.matched_item_id).then((d) => {
      if (alive) {
        setItemBlocks(d.blocks.map((b) => ({
          block_id: b.id, block_type: b.block_type,
          content_md: b.content_md, crop_url: b.crop_url,
        })));
      }
    }).catch(() => { /* 对照区加载失败时保持文本摘要，不报错 */ });
    return () => { alive = false; };
  }, [question.id, question.matched_item_id]);
  const src = stage === "crop"
    ? questionImageUrl(question.id)
    : pageImageUrl(question.paper_id, question.page_no);
  const label = stage === "crop" ? `第 ${question.seq} 题裁图` : `第 ${question.page_no} 页原卷`;
  return (
    <div className="qcard-paper">
      <div className="pane">
        <h3>原卷裁图</h3>
        <div className="crop-box">
          {stage === "missing" ? (
            <p className="placeholder">题图缺失（裁图与整页均不可用）</p>
          ) : (
            <img src={src} alt={label}
                 onError={() => setStage((s) => (s === "crop" ? "page" : "missing"))} />
          )}
        </div>
      </div>
      <div className="pane">
        <h3>识别出的题目</h3>
        <div className="content">
          <p className="stem">{question.content_md}</p>
          {question.answer_excerpt && (
            <p className="muted">识别到的作答：{question.answer_excerpt}</p>
          )}
          {question.mark_desc && <p className="muted">批改痕迹：{question.mark_desc}</p>}
          {question.matched_doc_title ? (
            <p className="match-line">
              题库匹配：{question.matched_doc_title}
              {question.matched_chapter ? ` · ${question.matched_chapter}` : ""}
              {question.matched_label ? ` · ${question.matched_label}` : ""}
              {question.match_score != null && ` · ${(question.match_score).toFixed(2)}`}
            </p>
          ) : null}
          {question.matched_item_id && itemBlocks?.length ? (
            <div className="match-compare">
              <h4>题库原题对照</h4>
              <ItemBlocksPreview blocks={itemBlocks} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
