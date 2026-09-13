import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {
  adoptReviewPage, approveReviewItem, approveReviewPage, commitBlockGeometry, createBlock,
  createBlockAnnotation, deleteBlockAnnotation, fetchReviewPage, mergeBlocks, pageVlm,
  deleteBlock, previewBlockGeometry, rejectReviewPage, splitBlock, updateReviewBlock,
  updateReviewPage, type ReviewPageDetail,
} from "../api/review";
import { reindexLibraryUnit } from "../api/library";
import { PageTrajectory } from "./TrajectoryPanel";
import { BlockGeometryDiff } from "./BlockGeometryDiff";

const GEOMETRY_HANDLES = [
  "left-top", "center-top", "right-top", "left-middle",
  "right-middle", "left-bottom", "center-bottom", "right-bottom",
] as const;

type GeometryHandle = (typeof GEOMETRY_HANDLES)[number];

/** 页详情（复合页）：两条解析路线是平行的上层切换——
    「分块解析」= layout 切块 + 逐块 OCR/VLM（页图 + bbox 覆层 + 块/题目/整页稿视图 + 块编辑栏）；
    「整页解析（VLM）」= layout/OCR 失效时的替代路线，VLM 直接转录整页（页图无框 + 整页稿面板）。
    头部阶段条呈现 解析 → 复核 → 索引 的处理阶段；索引过期可一键整页重建。
    框色语义互斥（优先级 聚焦>问题>已改>补画）：聚焦蓝框不带任何标题。 */
export function PageDetail({ pageId, fetchImpl = fetch, onExit, onError }: {
  pageId: string; fetchImpl?: typeof fetch; onExit: () => void; onError: (e: string) => void;
}) {
  const [data, setData] = useState<ReviewPageDetail | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [blockView, setBlockView] = useState<"rendered" | "raw">("rendered");
  const [rightView, setRightView] = useState<"blocks" | "questions" | "fullpage">("blocks");
  const [routeView, setRouteView] = useState<"blocks" | "page" | null>(null);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [chunkPreview, setChunkPreview] = useState<{ seq: number; content_preview: string; source_block_ids: string[] }[] | null>(null);
  const [annotationDrafts, setAnnotationDrafts] = useState<Record<string, string>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState<string | null>(null);
  const [showTrajectory, setShowTrajectory] = useState(false);
  const [geometryDraft, setGeometryDraft] = useState<number[] | null>(null);
  const [geometryPreview, setGeometryPreview] = useState<{ text: string; source_model: string; staging: string } | null>(null);
  const [creatingBlock, setCreatingBlock] = useState(false);
  const [draw, setDraw] = useState<{ x0: number; y0: number; x1: number; y1: number; sx: number; sy: number } | null>(null);
  const [status, setStatus] = useState("");
  const splitTextareaRef = useRef<HTMLTextAreaElement>(null);
  const resizeRef = useRef<{ handle: GeometryHandle; x: number; y: number; bbox: number[] } | null>(null);

  const reload = async () => {
    try { setData(await fetchReviewPage(pageId, fetchImpl)); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void reload(); }, [pageId]);
  // 换页时路线视图回落到该页的采用来源；切分预览属上一页，一并清掉
  useEffect(() => {
    setRouteView(null); setSelected(null); setHovered(null); setChunkPreview(null);
  }, [pageId]);
  // 退出补画模式时丢弃未完成的拖拽框
  useEffect(() => { if (!creatingBlock) setDraw(null); }, [creatingBlock]);
  // 块操作菜单：点菜单外任意处或 Esc 关闭
  useEffect(() => {
    if (!menuFor) return;
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.(".blockmenu")) setMenuFor(null);
    };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuFor(null); };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [menuFor]);
  const selectBlock = (block: ReviewPageDetail["blocks"][number]) => {
    setSelected(block.id);
    setSelectedIds([]);
    setGeometryDraft(block.bbox ? [...block.bbox] : null);
    setGeometryPreview(null);
  };
  const route = routeView ?? (data?.adopted_source === "page_md" ? "page" : "blocks");
  // 左右联动（组件内作用域查询）：选中块在右栏列表与左图覆层里都滚进可视区；
  // 题目视图下滚动到所属题目卡（.has-focus）并高亮。
  useEffect(() => {
    if (!selected) return;
    const root = rootRef.current;
    if (!root) return;
    if (rightView === "questions") {
      root.querySelector(".itemcard.has-focus")
        ?.scrollIntoView?.({ block: "nearest" });
    } else {
      root.querySelector(`.blockitem[data-block-id="${selected}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
    root.querySelector(".pd-image .bbox.focus")
      ?.scrollIntoView?.({ block: "center" });
  }, [selected, rightView]);
  useEffect(() => {
    if (!creatingBlock) return;
    const exitCreateMode = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCreatingBlock(false);
    };
    window.addEventListener("keydown", exitCreateMode);
    return () => window.removeEventListener("keydown", exitCreateMode);
  }, [creatingBlock]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (creatingBlock) return;
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void act(async () => { await approveReviewPage(pageId, fetchImpl); }, onExit);
        return;
      }
      if (route !== "blocks") return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const active = document.activeElement;
      if (active?.closest("input, textarea, select, [contenteditable=true], .dialog-mask")) return;
      if (active instanceof HTMLButtonElement && active.classList.contains("bbox")) return;
      if (!data || data.blocks.length === 0) return;
      event.preventDefault();
      const current = data.blocks.findIndex((block) => block.id === selected);
      const next = event.key === "ArrowDown"
        ? (current + 1 + data.blocks.length) % data.blocks.length
        : (current - 1 + data.blocks.length) % data.blocks.length;
      const block = data.blocks[next];
      selectBlock(block);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [creatingBlock, data, selected, pageId, onExit, route]);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); after?.(); }
    catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(message);
      onError(message);
    }
    finally { setBusy(false); }
  };

  const saveBlock = (blockId: string) =>
    act(async () => { await updateReviewBlock(blockId, draft, fetchImpl); }, () => { setEditing(null); void reload(); });

  /** 事件 client 坐标 → 页图自然像素（每次事件取当时的 frame rect，拖拽中滚动不漂）。 */
  const toNatural = (frame: HTMLElement, clientX: number, clientY: number) => {
    const rect = frame.getBoundingClientRect();
    const sx = imgSize && rect.width > 0 ? imgSize.w / rect.width : 1;
    const sy = imgSize && rect.height > 0 ? imgSize.h / rect.height : 1;
    return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy, sx, sy };
  };

  const previewGeometry = (blockId: string, bbox: number[]) =>
    act(async () => {
      setStatus("重裁 + 重识别中…");
      setGeometryPreview(await previewBlockGeometry(blockId, bbox, fetchImpl));
    });

  const previewIndex = () => act(async () => {
    const res = await fetchImpl(`/api/review/pages/${encodeURIComponent(pageId)}/index-preview`, { method: "POST" });
    if (!res.ok) throw new Error(`${res.status}`);
    const payload = await res.json() as { chunks: typeof chunkPreview };
    setChunkPreview(payload.chunks);
  });

  if (!data) return <div className="page-detail"><div className="chat-empty">加载中…</div></div>;
  const pendingBlockIds = new Set(data.blocks.flatMap((b) => b.pending.map(() => b.id)));
  const focusedBlock = data.blocks.find((block) => block.id === selected);
  const activeGeometry = geometryDraft ?? focusedBlock?.bbox ?? null;

  // 处理阶段条：解析 → 复核 → 索引（索引完即完成；内容被修改则过期，需整页重建）
  const pendingCount = data.page_pending.length
    + data.blocks.reduce((n, b) => n + b.pending.length, 0);
  const parseStage = data.parse_status === "parsed" ? { cls: "done", label: "完成" }
    : data.parse_status === "failed" ? { cls: "err", label: "失败" }
    : { cls: "warn", label: "进行中" };
  const reviewStage = data.manual_review_status === "approved" ? { cls: "done", label: "已通过" }
    : pendingCount > 0 ? { cls: "warn", label: `待处理 ${pendingCount}` }
    : { cls: "idle", label: "未复核" };
  const indexStage = data.excluded_from_index ? { cls: "idle", label: "已排除" }
    : data.index_error ? { cls: "err", label: "失败" }
    : data.index_status === "indexed" ? { cls: "done", label: "已完成" }
    : data.index_status === "stale" ? { cls: "warn", label: "已过期" }
    : { cls: "idle", label: "未索引" };
  // 页级重建索引只有 flat 文档支持（pipeline embed_flat_pages）；toc/exam 文档随条目确认向量化
  const canReindex = !data.excluded_from_index && data.struct_mode === "flat"
    && data.index_status !== "indexed";

  return (
    <div className="page-detail" ref={rootRef}>
      <div className="pd-head">
        <button className="btn-ghost" onClick={onExit}>← 返回列表</button>
        <span>《{data.doc_title}》第 {data.page_no} 页</span>
        <div className="pd-stages" role="group" aria-label="处理阶段">
          <span className={`stage-chip ${parseStage.cls}`}>解析 · {parseStage.label}</span>
          <span className="stage-arrow">→</span>
          <span className={`stage-chip ${reviewStage.cls}`}>复核 · {reviewStage.label}</span>
          <span className="stage-arrow">→</span>
          <span className={`stage-chip ${indexStage.cls}`}>索引 · {indexStage.label}</span>
          {canReindex && (
            <button className="btn-ghost" disabled={busy}
                    onClick={() => void act(async () => {
                      await reindexLibraryUnit(data.doc_id, "page", pageId, fetchImpl);
                    }, () => void reload())}>
              {data.index_status === "stale" ? "重建索引" : "建立索引"}
            </button>
          )}
          {!canReindex && !data.excluded_from_index && data.struct_mode !== "flat"
            && data.index_status !== "indexed" && (
            <span className="hint">条目确认后自动向量化</span>
          )}
          {data.index_error && <span className="stage-error">索引出错：{data.index_error}</span>}
        </div>
        <button className="btn-primary" disabled={busy}
                onClick={() => void act(async () => { await approveReviewPage(pageId, fetchImpl); }, onExit)}>
          ✓ 整页通过
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => setRejecting(!rejecting)}>✗ 打回本页</button>
      </div>
      {data.page_pending.length > 0 && (
        <div className="pd-pending">页级待复核：{data.page_pending.map((r) => r.reason).join("、")}</div>
      )}
      <div className="pd-toolbar">
        <div className="seg" aria-label="解析路线">
          <button className={route === "blocks" ? "active" : ""} onClick={() => setRouteView("blocks")}>
            分块解析{data.adopted_source === "blocks" ? " ✓采用" : ""}
          </button>
          <button className={route === "page" ? "active" : ""} onClick={() => setRouteView("page")}>
            整页解析（VLM）{data.adopted_source === "page_md" ? " ✓采用" : ""}
          </button>
        </div>
        {route === "blocks" && (
          <>
            <span className="sep-v"></span>
            <button className={blockView === "rendered" ? "btn-primary" : "btn-ghost"} onClick={() => setBlockView("rendered")}>Markdown</button>
            <button className={blockView === "raw" ? "btn-primary" : "btn-ghost"} onClick={() => setBlockView("raw")}>原始文本</button>
            <span className="sep-v"></span>
            <button className={rightView === "blocks" ? "btn-primary" : "btn-ghost"} onClick={() => setRightView("blocks")}>块视图</button>
            <button className={rightView === "questions" ? "btn-primary" : "btn-ghost"} onClick={() => setRightView("questions")}>题目视图</button>
            <button className={rightView === "fullpage" ? "btn-primary" : "btn-ghost"} onClick={() => setRightView("fullpage")}>整页稿</button>
            <button className={chunkPreview ? "btn-primary" : "btn-ghost"} aria-expanded={!!chunkPreview}
                    onClick={() => (chunkPreview ? setChunkPreview(null) : void previewIndex())}>
              {chunkPreview ? "收起切分预览" : "预览切分"}
            </button>
          </>
        )}
        <button className={showTrajectory ? "btn-primary" : "btn-ghost"}
                aria-expanded={showTrajectory}
                onClick={() => setShowTrajectory(!showTrajectory)}>
          {showTrajectory ? "收起本页日志" : "本页日志"}
        </button>
      </div>
      {showTrajectory && (
        <section className="pd-log" aria-label="本页处理日志">
          <PageTrajectory pageId={pageId} fetchImpl={fetchImpl} />
        </section>
      )}
      {rejecting && (
        <div className="pd-reject">
          <input aria-label="打回原因" placeholder="打回原因，如「缺题/版面歪斜」"
                 value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <button className="btn-primary" disabled={busy || !rejectReason.trim()}
                  onClick={() => void act(async () => {
                    await rejectReviewPage(pageId, rejectReason.trim(), fetchImpl);
                  }, () => { setRejecting(false); setRejectReason(""); })}>
            提交打回
          </button>
        </div>
      )}
      <div className="pd-body">
        <div className="pd-image">
          <div
            className="img-frame"
            onPointerDown={(event) => {
              if (route !== "blocks" || !creatingBlock || !imgSize) return;
              const point = toNatural(event.currentTarget, event.clientX, event.clientY);
              setDraw({ x0: point.x, y0: point.y, x1: point.x, y1: point.y, sx: point.sx, sy: point.sy });
              try { event.currentTarget.setPointerCapture(event.pointerId); }
              catch { /* jsdom 等环境无 pointer capture，拖拽出界时 up 事件可能丢 */ }
            }}
            onPointerUp={() => {
              const resize = resizeRef.current;
              if (resize && focusedBlock?.bbox) {
                resizeRef.current = null;
                const next = geometryDraft ?? [...resize.bbox];
                setGeometryDraft(next);
                setGeometryPreview(null);
                return;
              }
              if (route !== "blocks" || !creatingBlock || !draw) return;
              const bbox = [
                Math.min(draw.x0, draw.x1),
                Math.min(draw.y0, draw.y1),
                Math.max(draw.x0, draw.x1),
                Math.max(draw.y0, draw.y1),
              ].map((value) => Math.max(0, value));
              setDraw(null);
              if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) {
                setStatus("框太小，已忽略（单击不会补画）");
                return;
              }
              void act(async () => {
                const created = await createBlock(pageId, bbox, "text", fetchImpl);
                setSelected(created.block.id);
                setSelectedIds([]);
                setGeometryDraft(null);
                setGeometryPreview(null);
              }, () => { setCreatingBlock(false); setStatus("已补画新块"); void reload(); });
            }}
            onPointerMove={(event) => {
              const resize = resizeRef.current;
              if (!resize) {
                if (route === "blocks" && draw && imgSize) {
                  const point = toNatural(event.currentTarget, event.clientX, event.clientY);
                  setDraw({ ...draw, x1: point.x, y1: point.y, sx: point.sx, sy: point.sy });
                }
                return;
              }
              if (!imgSize) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              if (bounds.width === 0 || bounds.height === 0) return;
              const scaleX = imgSize.w / bounds.width;
              const scaleY = imgSize.h / bounds.height;
              const dx = (event.clientX - resize.x) * scaleX;
              const dy = (event.clientY - resize.y) * scaleY;
              const [x0, y0, x1, y1] = resize.bbox;
              const neighbors = data.blocks
                .filter((block) => block.id !== focusedBlock?.id && block.bbox)
                .map((block) => block.bbox!);
              const snap = (value: number, axis: "x" | "y") => {
                const scale = axis === "x" ? scaleX : scaleY;
                const candidates = neighbors.flatMap((bbox) =>
                  axis === "x" ? [bbox[0], bbox[2]] : [bbox[1], bbox[3]]);
                const nearest = candidates
                  .map((candidate) => ({ candidate, gap: Math.abs(value - candidate) / scale }))
                  .sort((a, b) => a.gap - b.gap)[0];
                return nearest && nearest.gap <= 4 ? nearest.candidate : value;
              };
              const next = [...resize.bbox];
              if (resize.handle.includes("left")) next[0] = snap(Math.min(x0 + dx, x1 - 1), "x");
              if (resize.handle.includes("right")) next[2] = snap(Math.max(x1 + dx, x0 + 1), "x");
              if (resize.handle.includes("top")) next[1] = snap(Math.min(y0 + dy, y1 - 1), "y");
              if (resize.handle.includes("bottom")) next[3] = snap(Math.max(y1 + dy, y0 + 1), "y");
              setGeometryDraft(next);
            }}
          >
          <img ref={imgRef} src={data.image_url} alt={`第 ${data.page_no} 页`} draggable={false}
               onLoad={() => setImgSize({ w: imgRef.current?.naturalWidth ?? 0, h: imgRef.current?.naturalHeight ?? 0 })}
               className={creatingBlock && route === "blocks" ? "creating" : ""} />
          {route === "blocks" && imgSize && data.blocks.map((b) => b.bbox ? (() => {
            const renderedGeometry = selected === b.id && activeGeometry ? activeGeometry : b.bbox;
            // 框色语义互斥（优先级 聚焦>问题>已改>补画），同一时刻只命中一种
            const stateCls = selected === b.id ? "focus"
              : pendingBlockIds.has(b.id) ? "has-issue"
              : ((b.geometry_revision ?? 1) > 1 || (b.origin && !["layout", "manual"].includes(b.origin))) ? "edited"
              : b.origin === "manual" ? "manual"
              : "";
            return (
            <button key={b.id}
              className={["bbox", stateCls, hovered === b.id && stateCls !== "focus" ? "hover" : ""]
                .filter(Boolean).join(" ")}
              style={{
                left: `${(renderedGeometry[0] / imgSize.w) * 100}%`,
                top: `${(renderedGeometry[1] / imgSize.h) * 100}%`,
                width: `${((renderedGeometry[2] - renderedGeometry[0]) / imgSize.w) * 100}%`,
                height: `${((renderedGeometry[3] - renderedGeometry[1]) / imgSize.h) * 100}%`,
              }}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) {
                    setSelectedIds((current) => current.includes(b.id)
                      ? current.filter((id) => id !== b.id)
                      : [...current, b.id]);
                    return;
                  }
                  selectBlock(b);
                }}
                onMouseEnter={() => setHovered(b.id)}
                onMouseLeave={() => setHovered((cur) => (cur === b.id ? null : cur))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setCreatingBlock(false); return; }
                  if (!activeGeometry || !imgSize) return;
                  const step = event.shiftKey ? 10 : 1;
                  if (event.key === "ArrowLeft") activeGeometry[0] = Math.max(0, activeGeometry[0] - step);
                  else if (event.key === "ArrowRight") activeGeometry[0] = Math.min(imgSize.w, activeGeometry[0] + step);
                  else if (event.key === "ArrowUp") activeGeometry[1] = Math.max(0, activeGeometry[1] - step);
                  else if (event.key === "ArrowDown") activeGeometry[1] = Math.min(imgSize.h, activeGeometry[1] + step);
                  else return;
                  event.preventDefault();
                  const next = [...activeGeometry];
                  setGeometryDraft(next);
                  setGeometryPreview(null);
                }}
                onMouseDown={(event) => {
                  // 只给「已选中」的块初始化拖拽草稿：未选中块的 mousedown 若改写
                  // geometryDraft，会把当前选中框（含控制点）传送到光标下的块位置，
                  // mouseup 落在传送过来的控制点上 → 点击丢失（只有第一次点选生效的根因）
                  if (!creatingBlock && selected === b.id) setGeometryDraft(b.bbox ? [...b.bbox] : null);
                  event.currentTarget.dataset.dragStart = `${event.clientX},${event.clientY}`;
                }}
	                onMouseUp={(event) => {
	                  const [startX, startY] = (event.currentTarget.dataset.dragStart ?? "0,0").split(",").map(Number);
	                  if (Math.abs(event.clientX - startX) < 1 && Math.abs(event.clientY - startY) < 1) return;
	                  setGeometryPreview(null);
	                }}
              aria-label={`块 ${b.id}`}
            >
                  {b.origin === "manual" && (
                    <span className="bbox-tag manual-tag">补画</span>
                  )}
                  {selected === b.id && GEOMETRY_HANDLES.map((handle) => (
                    <span key={handle} className="geometry-handle" data-handle={handle}
                          onPointerDown={(event) => {
                            if (creatingBlock || busy) return;
                            event.stopPropagation();
                            event.preventDefault();
                            resizeRef.current = {
                              handle, x: event.clientX, y: event.clientY,
                              bbox: [...(activeGeometry ?? b.bbox ?? [])],
                            };
                          }} style={{
                      left: handle.startsWith("right") ? "calc(100% - 3px)"
                        : handle.startsWith("center") ? "calc(50% - 3px)" : 0,
                      top: handle.endsWith("bottom") ? "calc(100% - 3px)"
                        : handle.endsWith("middle") ? "calc(50% - 3px)" : 0,
                    }} />
                  ))}
                </button>
            );
          })() : null)}
          {route === "blocks" && draw && (
            <div data-testid="creating-bbox" className="creating-bbox" style={{
              left: `${Math.min(draw.x0, draw.x1) / draw.sx}px`,
              top: `${Math.min(draw.y0, draw.y1) / draw.sy}px`,
              width: `${Math.abs(draw.x1 - draw.x0) / draw.sx}px`,
              height: `${Math.abs(draw.y1 - draw.y0) / draw.sy}px`,
            }} />
          )}
          </div>
        </div>
        <div className="pd-panel">
          {route === "page" ? (
            <div className="pd-pagemd">
              <div className="meta">整页解析（VLM）{data.page_md_model ? `（${data.page_md_model}）` : ""}</div>
              <div className="hint">layout 切块 / OCR 失效时的替代解析路线：VLM 直接转录整页，与分块解析二选一采用。</div>
              {pageEditing ? (
                <div className="page-editor">
                  <textarea aria-label="编辑整页稿" value={pageDraft} onChange={(e) => setPageDraft(e.target.value)} />
                  <div className="row">
                    <button className="btn-primary" disabled={busy} onClick={() => void act(
                      async () => { await updateReviewPage(pageId, pageDraft, fetchImpl); },
                      () => { setPageEditing(false); void reload(); },
                    )}>保存并过期索引</button>
                    <button className="btn-ghost" onClick={() => setPageEditing(false)}>取消</button>
                  </div>
                </div>
              ) : data.page_md ? (
                <div className="md">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {data.page_md}
                  </ReactMarkdown>
                  <button className="btn-ghost" onClick={() => { setPageDraft(data.page_md ?? ""); setPageEditing(true); }}>✎ 编辑整页稿</button>
                </div>
              ) : <div className="hint">本页还没有整页解析结果。</div>}
              <button className={data.page_md ? "btn-ghost" : "btn-primary"} disabled={busy}
                      onClick={() => void act(async () => { await pageVlm(pageId, fetchImpl); }, () => void reload())}>
                🔄 {data.page_md ? "重新" : ""}远端整页解析
              </button>
              {data.page_md && (data.adopted_source === "blocks"
                ? <button className="btn-primary" disabled={busy}
                    onClick={() => void act(async () => { await adoptReviewPage(pageId, "page_md", fetchImpl); }, () => void reload())}>
                    ✓ 采用整页版
                  </button>
                : <><button className="btn-ghost" disabled={busy}
                    onClick={() => void act(async () => { await adoptReviewPage(pageId, "blocks", fetchImpl); }, () => void reload())}>
                    改用切块版
                  </button><span className="hint">当前采用：整页解析</span></>)}
            </div>
          ) : (
            <>
          {chunkPreview && (
            <section className="chunk-preview" aria-label="切分预览">
              <div className="meta">
                <span>切分预览 · {chunkPreview.length} 段</span>
                <button className="btn-ghost cp-close" aria-label="关闭切分预览"
                        onClick={() => setChunkPreview(null)}>✕</button>
              </div>
              <ol className="chunk-line">
                {chunkPreview.map((chunk) => (
                  <li key={chunk.seq}>
                    <span className="chunk-no">{String(chunk.seq).padStart(2, "0")}</span>
                    <span className="chunk-source">B{chunk.source_block_ids.length || "整页"}</span>
                    <span className="chunk-text">{chunk.content_preview}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          <div className="pd-blocks">
            {rightView === "blocks" && data.blocks.map((b) => (
              <div key={b.id}
                   data-block-id={b.id}
                   className={`blockitem${pendingBlockIds.has(b.id) ? " has-issue" : ""}${selected === b.id ? " selected" : ""}${hovered === b.id ? " hover" : ""}`}
                   onClick={(event) => {
                     if (event.metaKey || event.ctrlKey) {
                       setSelectedIds((current) => current.includes(b.id)
                         ? current.filter((id) => id !== b.id)
                         : [...current, b.id]);
                       return;
                     }
                     selectBlock(b);
                   }}
                   onMouseEnter={() => setHovered(b.id)}
                   onMouseLeave={() => setHovered((cur) => (cur === b.id ? null : cur))}>
                <div className="bt">
                  <span className="bt-label">
                    {b.block_type}{b.source_model ? ` · ${b.source_model}` : ""}
                    {(b.origin && b.origin !== "layout") && <span className="badge edited-tag">{b.origin}</span>}
                    {b.block_type_origin === "vlm" && <span className="badge edited-tag">VLM改判</span>}
                    {b.block_type === "title" && b.title_level != null &&
                      <span className="badge edited-tag">{`H${b.title_level}`}</span>}
                  </span>
                  {editing !== b.id && (
                    <div className="blockmenu">
                      <button className="bt-more" aria-label={`块操作 ${b.id}`} aria-expanded={menuFor === b.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuFor((cur) => (cur === b.id ? null : b.id));
                              }}>⋯</button>
                      {menuFor === b.id && (
                        <div className="menu" role="menu">
                          <button role="menuitem" onClick={(e) => {
                            e.stopPropagation();
                            setAnnotating(b.id);
                            setMenuFor(null);
                          }}>添加批注</button>
                          <button role="menuitem" onClick={(e) => {
                            e.stopPropagation();
                            setDraft(b.content_md ?? "");
                            setEditing(b.id);
                            setMenuFor(null);
                          }}>✎ 编辑</button>
                          <button role="menuitem" className="danger" disabled={busy} onClick={(e) => {
                            e.stopPropagation();
                            setMenuFor(null);
                            void act(async () => { await deleteBlock(b.id, fetchImpl); },
                              () => { setSelected(null); setGeometryDraft(null); setStatus("块已删除"); void reload(); });
                          }}>删除块</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {editing === b.id ? (
                  <>
                    <textarea ref={splitTextareaRef} aria-label="编辑转录" value={draft}
                              onChange={(e) => setDraft(e.target.value)} />
                    <div className="row">
                      <button className="btn-primary" disabled={busy} onClick={() => void saveBlock(b.id)}>保存</button>
                      <button className="btn-ghost" onClick={() => void act(async () => {
                        const cursor = splitTextareaRef.current?.selectionStart ?? draft.length;
                        const lineIndex = (draft.slice(0, cursor).match(/\n/g) ?? []).length + 1;
                        await splitBlock(b.id, lineIndex, fetchImpl);
                      }, () => { setStatus("已按光标行拆分"); void reload(); })}>拆分块</button>
                      <button className="btn-ghost" onClick={() => setEditing(null)}>取消</button>
                    </div>
                  </>
                ) : (
                  <div className="bc">
                    {b.block_type === "figure" && b.crop_url && (
                      <img src={b.crop_url} alt={`块图 ${b.id}`} className="block-crop" />
                    )}
                    {blockView === "rendered" ? (
                      <div className="md">
                        <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                          {b.content_md ?? "（空）"}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <pre>{b.content_md ?? "（空）"}</pre>
                    )}
                  </div>
                )}
                {b.pending.length > 0 && <div className="badges">{b.pending.map((r) => <span key={r.id} className="badge">{r.reason}</span>)}</div>}
                {(b.annotations ?? []).map((a) => (
                  <div key={a.id} className="annotation">
                    <span>{a.author}：</span>{a.body}
                    <button className="btn-ghost" onClick={(e) => {
                      e.stopPropagation();
                      void act(async () => { await deleteBlockAnnotation(a.id, fetchImpl); }, reload);
                    }}>删除</button>
                  </div>
                ))}
                {annotating === b.id && (
                  <div className="row annotation-editor">
                    <input aria-label={`批注 ${b.id}`} placeholder="添加 OCR 批注" value={annotationDrafts[b.id] ?? ""}
                           onClick={(e) => {
                             e.stopPropagation();
                             // 输入框不是点击死区：点批注框同样选中所属块（联动左图聚焦）
                             if (selected !== b.id) selectBlock(b);
                           }}
                           onKeyDown={(e) => { if (e.key === "Escape") setAnnotating(null); }}
                           onChange={(e) => setAnnotationDrafts((current) => ({ ...current, [b.id]: e.target.value }))} />
                    <button className="btn-ghost" disabled={busy || !(annotationDrafts[b.id] ?? "").trim()}
                            onClick={(e) => {
                              e.stopPropagation();
                              void act(async () => {
                                await createBlockAnnotation(b.id, annotationDrafts[b.id].trim(), fetchImpl);
                                setAnnotationDrafts((current) => ({ ...current, [b.id]: "" }));
                                setAnnotating(null);
                              }, reload);
                            }}>添加批注</button>
                    <button className="btn-ghost" onClick={(e) => { e.stopPropagation(); setAnnotating(null); }}>取消</button>
                  </div>
                )}
              </div>
            ))}
            {rightView === "questions" && data.questions?.map((item) => {
              const itemBlockIds = [...new Set([...item.block_ids, ...(item.answer?.block_ids ?? [])])];
              const hasFocus = selected !== null && itemBlockIds.includes(selected);
              // 点题卡任意处联动选中首个关联块（mini-block 点击 stopPropagation 不被覆盖）
              const selectFirstBlock = () => {
                const first = itemBlockIds
                  .map((bid) => data.blocks.find((b) => b.id === bid))
                  .find(Boolean);
                if (first) selectBlock(first);
              };
              return (
              <div key={item.id} className={`itemcard${item.qc_status === "approved" ? " approved" : item.qc_status === "rejected" ? " rejected" : ""}${hasFocus ? " has-focus" : ""}`}
                   onClick={selectFirstBlock}>
                <div className="bt">
                  {item.content_type === "answer" ? "解析" : item.content_type === "example" ? "例题" : "题目"}
                  {item.label ? ` · ${item.label}` : ""}
                  <span className={`badge qc-${item.qc_status}`}>{item.qc_status}</span>
                  {item.qc_status !== "approved" && (
                    <button className="btn-ghost" disabled={busy} aria-label={`确认条目 ${item.id}`}
                            onClick={(e) => {
                              // 题卡整体有点击联动选中，确认按钮不冒泡
                              e.stopPropagation();
                              void act(async () => {
                                await approveReviewItem(item.id, fetchImpl);
                              }, () => void reload());
                            }}>
                      ✓ 确认
                    </button>
                  )}
                </div>
                <div className="bc">
                  {item.block_crops?.filter(Boolean).map((crop: string, i: number) => (
                    <img key={i} src={crop} alt={`条目图 ${i}`} className="block-crop" />
                  ))}
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {item.content_md ?? "（无内容）"}
                    </ReactMarkdown>
                  </div>
                </div>
                {item.content_type !== "answer" && item.answer && (
                  <div className="question-answer">
                    <div className="qa-label">解析</div>
                    <div className="md">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                        {item.answer.content_md ?? "（无解析）"}
                      </ReactMarkdown>
                    </div>
                  </div>
                )}
                <div className="blocks-in-item">
                  {itemBlockIds.map((bid) => {
                    const block = data.blocks.find((b) => b.id === bid);
                    return block && (
                      <span key={bid} className={`mini-block${selected === bid ? " selected" : ""}`}
                            onClick={(e) => { e.stopPropagation(); selectBlock(block); }}>
                        {block.block_type}
                      </span>
                    );
                  })}
                </div>
              </div>
              );
            })}
            {rightView === "questions" && !data.questions?.length && (
              <div className="hint">本页没有关联题目。</div>
            )}
            {rightView === "fullpage" && (
              <section className="pd-fullpage" aria-label="整页稿">
                <div className="meta">
                  整页稿（{data.adopted_source === "page_md" ? "整页解析（VLM）" : "由切块拼装"}）
                </div>
                {data.content_md.trim() ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {data.content_md}
                    </ReactMarkdown>
                  </div>
                ) : <div className="hint">本页没有可呈现的整页内容。</div>}
                <div className="hint">
                  {data.adopted_source === "page_md"
                    ? "这是索引进知识库的整页内容；编辑请到「整页解析（VLM）」路线。"
                    : "这是索引进知识库的整页内容，由各块拼装；编辑请回块视图逐块修改。"}
                </div>
              </section>
            )}
          </div>
            </>
          )}
        </div>
      </div>
      {route === "blocks" && (
        <div className="pd-edit-bar">
          <span className="legend">
            <span>聚焦</span><span className="legend-swatch focus" />
            <span>问题</span><span className="legend-swatch issue" />
            <span>已改</span><span className="legend-swatch edited" />
            <span>补画</span><span className="legend-swatch manual" />
          </span>
          <button className={creatingBlock ? "btn-primary" : "btn-ghost"}
                  onClick={() => setCreatingBlock(!creatingBlock)}>补画新框</button>
          <button className="btn-ghost" disabled={!selected || busy}
                  onClick={() => selected && void act(async () => { await deleteBlock(selected, fetchImpl); },
                    () => { setSelected(null); setGeometryDraft(null); setStatus("块已删除"); void reload(); })}>
            删除选中块
          </button>
          <button className="btn-ghost" disabled={!selected || busy}
                  onClick={() => focusedBlock && activeGeometry &&
                    void previewGeometry(focusedBlock.id, activeGeometry)}>
            预览新框识别
          </button>
          <button className="btn-primary" disabled={selectedIds.length < 2 || busy}
                  onClick={() => void act(async () => { await mergeBlocks(selectedIds, fetchImpl); },
                    () => { setSelectedIds([]); setStatus(`合并 ${selectedIds.length} 块成功`); void reload(); })}>
            合并选中块
          </button>
          {status && <span className="hint">{status}</span>}
        </div>
      )}
      {route === "blocks" && creatingBlock && <div className="hint">在页图上拖出新框，Esc 退出；画错可选中后点「删除选中块」。</div>}
      {geometryPreview && focusedBlock && activeGeometry && (
        <BlockGeometryDiff
          oldText={focusedBlock.content_md ?? ""}
          newText={geometryPreview.text}
          onCancel={() => setGeometryPreview(null)}
          onConfirm={(text) => void act(async () => {
            await commitBlockGeometry(
              focusedBlock.id, activeGeometry, geometryPreview.staging, text,
              geometryPreview.source_model, fetchImpl,
            );
          }, () => {
            setGeometryPreview(null);
            setGeometryDraft(null);
            setStatus("已应用调框结果");
            void reload();
          })}
        />
      )}
    </div>
  );
}
