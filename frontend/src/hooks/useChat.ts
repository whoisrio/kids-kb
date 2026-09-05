import { useCallback, useEffect, useRef, useState } from "react";
import {
  deleteSession,
  fetchModels,
  fetchSessionDetail,
  fetchSessions,
  streamChat,
  type ChatMessage,
  type LaneInfo,
  type ModelInfo,
  type SessionSummary,
} from "../api/chat";

export function useChat(fetchImpl: typeof fetch = fetch) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [currentLane, setCurrentLane] = useState("main");
  const [lanes, setLanes] = useState<LaneInfo[]>([{ id: "main", forkEntryId: null, fromLaneId: null }]);
  const [rewindTo, setRewindTo] = useState<{ index: number; entryId: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<{ id: string | null; lane: string }>({ id: null, lane: "main" });
  const activeSessionIdRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  activeSessionIdRef.current = activeSessionId;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions(fetchImpl));
    } catch (err) {
      console.error("会话列表加载失败", err);
    }
  }, [fetchImpl]);

  const loadDetail = useCallback(async (id: string, lane?: string) => {
    const requestId = ++detailRequestRef.current;
    try {
      const detail = await fetchSessionDetail(id, fetchImpl, lane);
      if (requestId !== detailRequestRef.current) return;
      setMessages(detail.messages);
      setActiveSessionId(id);
      setCurrentLane(detail.currentLane);
      setLanes(detail.lanes);
      setRewindTo(null);
      if (detail.currentModel) setModel(detail.currentModel);
      cursorRef.current = { id, lane: detail.currentLane };
    } catch (err) {
      console.error("会话加载失败", err);
    }
  }, [fetchImpl]);

  const refreshDetail = useCallback(async () => {
    const { id, lane } = cursorRef.current;
    if (!id || id !== activeSessionIdRef.current) return;
    await loadDetail(id, lane);
  }, [loadDetail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchModels(fetchImpl);
        if (cancelled || list.length === 0) return;
        setModels(list);
        setModel((current) => current || list[0].id);
      } catch (err) {
        console.error("模型列表加载失败", err);
      }
    })();
    void refreshSessions();
    return () => { cancelled = true; };
  }, [fetchImpl, refreshSessions]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const appendToLast = (text: string) =>
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, content: last.content + text };
      return copy;
    });

  const appendThinkingToLast = (text: string) =>
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, thinking: (last.thinking ?? "") + text };
      return copy;
    });

  const send = (content: string, options: { branchAt?: string | null; keepUntil?: number } = {}) => {
    const text = content.trim();
    if (!text || streaming) return;
    const branchAt = options.branchAt !== undefined ? options.branchAt
      : rewindTo ? rewindTo.entryId : undefined;
    const keepUntil = options.keepUntil !== undefined ? options.keepUntil
      : rewindTo ? rewindTo.index + 1 : undefined;
    const base = keepUntil !== undefined ? messages.slice(0, keepUntil) : messages;
    const withUser: ChatMessage[] = [...base, { role: "user", content: text }];
    setMessages([...withUser, { role: "assistant", content: "" }]);
    setStreaming(true);
    setRewindTo(null);
    abortRef.current?.abort();
    const abortController = new AbortController();
    abortRef.current = abortController;
    void streamChat(
      withUser,
      {
        onSession: (id, lane) => {
          setActiveSessionId(id);
          setCurrentLane(lane);
          cursorRef.current = { id, lane };
          void refreshSessions();
        },
        onThinking: appendThinkingToLast,
        onDelta: appendToLast,
        onDone: () => {
          setStreaming(false);
          void refreshSessions();
          void refreshDetail();
        },
        onError: (message) => {
          appendToLast(`（出错了：${message}）`);
          setStreaming(false);
        },
      },
      fetchImpl,
      abortController.signal,
      {
        sessionId: activeSessionId ?? undefined,
        model: model || undefined,
        laneId: branchAt === undefined && activeSessionId ? currentLane : undefined,
        branchAt,
      },
    );
  };

  const editMessage = (index: number, content: string) => {
    const branchAt = index === 0 ? null : messages[index - 1].entryId ?? null;
    send(content, { branchAt, keepUntil: index });
  };

  const regenerate = () => {
    const lastIndex = messages.length - 1;
    if (streaming || lastIndex < 1 || messages[lastIndex].role !== "assistant") return;
    const userMessage = messages[lastIndex - 1];
    if (userMessage.role !== "user" || !userMessage.entryId) return;
    send(userMessage.content, { branchAt: userMessage.entryId, keepUntil: lastIndex - 1 });
  };

  const setRewind = (index: number) => {
    if (streaming) return;
    const message = messages[index];
    if (!message.entryId) return;
    setRewindTo({ index, entryId: message.entryId });
  };
  const cancelRewind = () => setRewindTo(null);

  const selectSession = async (id: string) => {
    if (id === activeSessionId) return;
    abortRef.current?.abort();
    await loadDetail(id);
  };

  const selectLane = async (lane: string) => {
    if (!activeSessionId || lane === currentLane) return;
    await loadDetail(activeSessionId, lane);
  };

  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setActiveSessionId(null);
    setCurrentLane("main");
    setLanes([{ id: "main", forkEntryId: null, fromLaneId: null }]);
    setRewindTo(null);
    cursorRef.current = { id: null, lane: "main" };
  };

  const deleteSessionById = async (id: string) => {
    if (id === activeSessionId) abortRef.current?.abort();
    try {
      const ok = await deleteSession(id, fetchImpl);
      if (!ok) return;
    } catch (err) {
      console.error("会话删除失败", err);
      return;
    }
    if (id === activeSessionId) newChat();
    void refreshSessions();
  };

  return {
    messages,
    streaming,
    sessions,
    models,
    model,
    activeSessionId,
    currentLane,
    lanes,
    rewindTo,
    send,
    editMessage,
    regenerate,
    setRewind,
    cancelRewind,
    selectSession,
    selectLane,
    newChat,
    deleteSession: deleteSessionById,
    selectModel: setModel,
  };
}
