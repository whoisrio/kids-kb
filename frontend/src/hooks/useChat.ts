import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchModels,
  fetchSessionDetail,
  fetchSessions,
  streamChat,
  type ChatMessage,
  type ModelInfo,
  type SessionSummary,
} from "../api/chat";

/** 聊天产品状态：消息流 + 会话（列表/当前/回看）+ 模型选择 + SSE 流式。
    会话状态由服务端权威（JSONL），前端只持有 id 并在 session 事件/收尾时刷新列表。 */
export function useChat(fetchImpl: typeof fetch = fetch) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions(fetchImpl));
    } catch (err) {
      console.error("会话列表加载失败", err);
    }
  }, [fetchImpl]);

  // 初始加载：模型列表（首个 = 后端默认模型）+ 会话列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchModels(fetchImpl);
        if (cancelled || list.length === 0) return;
        setModels(list);
        setModel((m) => m || list[0].id);
      } catch (err) {
        console.error("模型列表加载失败", err);
      }
    })();
    void refreshSessions();
    return () => {
      cancelled = true;
    };
  }, [fetchImpl, refreshSessions]);

  // 卸载时中止进行中的流
  useEffect(() => () => abortRef.current?.abort(), []);

  const appendToLast = (text: string) =>
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, content: last.content + text };
      return copy;
    });

  /** 发送一条用户消息；session_id/model 随请求携带（无 session_id = 新会话）。 */
  const send = (content: string) => {
    const text = content.trim();
    if (!text || streaming) return;
    const withUser: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages([...withUser, { role: "assistant", content: "" }]);
    setStreaming(true);
    // 防御性 abort 上一次未完的请求（正常路径被 streaming 状态挡住）
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    void streamChat(
      withUser,
      {
        onSession: (id) => {
          setActiveSessionId(id);
          void refreshSessions();
        },
        onDelta: appendToLast,
        onDone: () => {
          setStreaming(false);
          void refreshSessions();
        },
        onError: (message) => {
          appendToLast(`（出错了：${message}）`);
          setStreaming(false);
        },
      },
      fetchImpl,
      ac.signal,
      { sessionId: activeSessionId ?? undefined, model: model || undefined },
    );
  };

  /** 回看历史会话：消息进流、id 记为当前、模型下拉同步该会话当前模型。 */
  const selectSession = async (id: string) => {
    if (id === activeSessionId) return;
    abortRef.current?.abort();
    try {
      const detail = await fetchSessionDetail(id, fetchImpl);
      setMessages(detail.messages);
      setActiveSessionId(id);
      if (detail.currentModel) setModel(detail.currentModel);
    } catch (err) {
      console.error("会话加载失败", err);
    }
  };

  /** 新对话：清空消息流与 session_id（模型选择保留）。 */
  const newChat = () => {
    abortRef.current?.abort();
    setMessages([]);
    setActiveSessionId(null);
  };

  return {
    messages,
    streaming,
    sessions,
    models,
    model,
    activeSessionId,
    send,
    selectSession,
    newChat,
    selectModel: setModel,
  };
}
