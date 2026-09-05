import { useEffect, useRef, useState } from "react";
import {
  adoptReviewPage, approveReviewPage, fetchReviewPage, pageVlm, rejectReviewPage,
  updateReviewBlock, type ReviewPageDetail,
} from "../api/review";

/** 页详情：页图 + bbox 覆层（按图片自然尺寸百分比定位）+ 块面板（编辑/待复核高亮）
    + 整页通过/打回/远端整页解析/采用版本。 */
export function PageDetail({ pageId, fetchImpl = fetch, onExit, onError }: {
  pageId: string; fetchImpl?: typeof fetch; onExit: () => void; onError: (e: string) => void;
}) {
  const [data, setData] = useState<ReviewPageDetail | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const reload = async () => {
    try { setData(await fetchReviewPage(pageId, fetchImpl)); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void reload(); }, [pageId]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); after?.(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const saveBlock = (blockId: string) =>
    act(async () => { await updateReviewBlock(blockId, draft, fetchImpl); }, () => { setEditing(null); void reload(); });

  if (!data) return <div className="page-detail"><div className="chat-empty">加载中…</div></div>;
  const pendingBlockIds = new Set(data.blocks.flatMap((b) => b.pending.map(() => b.id)));

  return (
    <div className="page-detail">
      <div className="pd-head">
        <button className="ghost" onClick={onExit}>← 返回列表</button>
        <span>《{data.doc_title}》第 {data.page_no} 页</span>
        <button className="primary" disabled={busy}
                onClick={() => void act(async () => { await approveReviewPage(pageId, fetchImpl); }, onExit)}>
          ✓ 整页通过
        </button>
        <button className="ghost" disabled={busy} onClick={() => setRejecting(!rejecting)}>✗ 打回本页</button>
      </div>
      {data.page_pending.length > 0 && (
        <div className="pd-pending">页级待复核：{data.page_pending.map((r) => r.reason).join("、")}</div>
      )}
      {rejecting && (
        <div className="pd-reject">
          <input aria-label="打回原因" placeholder="打回原因，如「缺题/版面歪斜」"
                 value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <button className="primary" disabled={busy || !rejectReason.trim()}
                  onClick={() => void act(async () => {
                    await rejectReviewPage(pageId, rejectReason.trim(), fetchImpl);
                  }, () => { setRejecting(false); setRejectReason(""); })}>
            提交打回
          </button>
        </div>
      )}
      <div className="pd-body">
        <div className="pd-image">
          <img ref={imgRef} src={data.image_url} alt={`第 ${data.page_no} 页`}
               onLoad={() => setImgSize({ w: imgRef.current?.naturalWidth ?? 0, h: imgRef.current?.naturalHeight ?? 0 })} />
          {imgSize && data.blocks.map((b) => b.bbox && (
            <button key={b.id}
              className={`bbox${pendingBlockIds.has(b.id) ? " has-issue" : ""}${selected === b.id ? " selected" : ""}`}
              style={{
                left: `${(b.bbox[0] / imgSize.w) * 100}%`,
                top: `${(b.bbox[1] / imgSize.h) * 100}%`,
                width: `${((b.bbox[2] - b.bbox[0]) / imgSize.w) * 100}%`,
                height: `${((b.bbox[3] - b.bbox[1]) / imgSize.h) * 100}%`,
              }}
              onClick={() => setSelected(b.id)}
              aria-label={`块 ${b.id}`}
            />
          ))}
        </div>
        <div className="pd-panel">
          <div className="pd-pagemd">
            <div className="meta">整页转录（{data.page_md_model ?? "-"}）</div>
            {data.page_md
              ? <pre>{data.page_md.slice(0, 500)}</pre>
              : <div className="hint">本页还没有整页转录。</div>}
            <button className="ghost" disabled={busy}
                    onClick={() => void act(async () => { await pageVlm(pageId, fetchImpl); }, () => void reload())}>
              🔄 {data.page_md ? "重新" : ""}远端整页解析
            </button>
            {data.page_md && (data.adopted_source === "blocks"
              ? <button className="primary" disabled={busy}
                  onClick={() => void act(async () => { await adoptReviewPage(pageId, "page_md", fetchImpl); }, () => void reload())}>
                  ✓ 采用整页版
                </button>
              : <><button className="ghost" disabled={busy}
                  onClick={() => void act(async () => { await adoptReviewPage(pageId, "blocks", fetchImpl); }, () => void reload())}>
                  改用切块版
                </button><span className="hint">当前采用：整页转录</span></>)}
          </div>
          <div className="pd-blocks">
            {data.blocks.map((b) => (
              <div key={b.id}
                   className={`blockitem${pendingBlockIds.has(b.id) ? " has-issue" : ""}${selected === b.id ? " selected" : ""}`}
                   onClick={() => setSelected(b.id)}>
                <div className="bt">{b.block_type}{b.source_model ? ` · ${b.source_model}` : ""}</div>
                {editing === b.id ? (
                  <>
                    <textarea aria-label="编辑转录" value={draft} onChange={(e) => setDraft(e.target.value)} />
                    <div className="row">
                      <button className="primary" disabled={busy} onClick={() => void saveBlock(b.id)}>保存</button>
                      <button className="ghost" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <div className="bc">{b.content_md ?? "（空）"}</div>
                )}
                {b.pending.length > 0 && <div className="badges">{b.pending.map((r) => <span key={r.id} className="badge">{r.reason}</span>)}</div>}
                {editing !== b.id && (
                  <div className="row">
                    <button className="ghost" onClick={(e) => {
                      e.stopPropagation();
                      setDraft(b.content_md ?? "");
                      setEditing(b.id);
                    }}>✎ 编辑</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
