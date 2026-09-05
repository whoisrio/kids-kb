import { useState } from "react";
import {
  approveReviewItem, rejectReviewItem, updateReviewItem, type ReviewItemDetail,
} from "../api/review";

/** 条目详情：LLM 拆条结果的核对——内容编辑、grounding 溯源块（裁图+转录）、确认（即时向量化）、打回。 */
export function ItemDetail({ item, onReload, onExit, onError, fetchImpl = fetch }: {
  item: ReviewItemDetail;
  onReload: () => Promise<void> | void;
  onExit: () => void;
  onError: (e: string) => void;
  fetchImpl?: typeof fetch;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content_md ?? "");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); after?.(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="item-detail">
      <div className="pd-head">
        <button className="ghost" onClick={onExit}>← 返回条目</button>
        <span>《{item.doc_title}》{item.chapter ? ` ${item.chapter} · ` : ""}{item.label ?? item.content_type}</span>
        <button className="primary" disabled={busy}
                onClick={() => void act(() => approveReviewItem(item.id, fetchImpl), onExit)}>
          ✓ 确认
        </button>
        <button className="ghost" disabled={busy} onClick={() => setRejecting(!rejecting)}>✗ 打回</button>
      </div>
      {rejecting && (
        <div className="pd-reject">
          <input aria-label="打回原因" placeholder="打回原因，如「串章/漏题」"
                 value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <button className="primary" disabled={busy || !rejectReason.trim()}
                  onClick={() => void act(async () => {
                    await rejectReviewItem(item.id, rejectReason.trim(), fetchImpl);
                  }, () => { setRejecting(false); setRejectReason(""); void onReload(); })}>
            提交打回
          </button>
        </div>
      )}
      <div className="id-body">
        <div className="id-content">
          <div className="meta">
            {item.taxonomy ?? "（无分类）"} · {(item.tags ?? []).join(" / ") || "（无标签）"}
            {item.source_model ? ` · ${item.source_model}` : ""}
          </div>
          {editing ? (
            <>
              <textarea aria-label="编辑条目" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <div className="row">
                <button className="primary" disabled={busy}
                        onClick={() => void act(async () => {
                          await updateReviewItem(item.id, draft, fetchImpl);
                        }, () => { setEditing(false); void onReload(); })}>
                  保存
                </button>
                <button className="ghost" onClick={() => setEditing(false)}>取消</button>
              </div>
            </>
          ) : (
            <>
              <pre>{item.content_md ?? "（空）"}</pre>
              <div className="row">
                <button className="ghost" onClick={() => { setDraft(item.content_md ?? ""); setEditing(true); }}>✎ 编辑</button>
              </div>
            </>
          )}
          {item.reviews.length > 0 && (
            <div className="id-reviews">
              {item.reviews.map((r) => (
                <div key={r.id} className={r.status}>
                  <span className="badge">{r.status === "pending" ? "待复核" : r.status}</span> {r.reason}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="id-blocks">
          {item.blocks.length === 0 && <div className="hint">无溯源块（docx/整页路径）。</div>}
          {item.blocks.map((b) => (
            <div key={b.id} className={`blockitem role-${b.role}`}>
              <div className="bt">{b.role} · {b.block_type}</div>
              <img src={b.crop_url} alt={`块 ${b.id}`} loading="lazy" />
              <div className="bc">{b.content_md ?? "（空）"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
