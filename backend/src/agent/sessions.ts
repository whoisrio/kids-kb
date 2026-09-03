/** 聊天会话持久化：窄接口 SessionStore + JsonlSessionRepo 实现。
    设计要点（对 pi-agent-core@0.84.4 源码核实）：
    - appendMessage/appendEntry 走 "main" lane，lane 不存在会抛错 → 首次写前 ensureLane。
    - JsonlSessionRepo.open() 无写者锁 → 进程内 id→Session 缓存，避免同会话多写者交错。
    - user/assistant 的 message_end 都会触发（agent-loop.js），toolResult 不落盘。 */
import { fileURLToPath } from "node:url";
import {
  JsonlSessionRepo,
  uuidv7,
  type AgentMessage,
  type JsonlSessionMetadata,
  type MessageEntry,
  type ModelChangeEntry,
  type Session,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

export interface StoredChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  modifiedAt: number;
}

export interface SessionHandle {
  readonly id: string;
  /** 会话标题（创建时 metadata.title）。 */
  readonly title: string;
  /** 当前模型：最近一次 model_change，否则创建时 metadata.model。 */
  currentModel(): Promise<string>;
  /** 规范化后的历史消息（仅 user/assistant，text 段拼接；空 text 与其他角色跳过）。 */
  messages(): Promise<StoredChatMessage[]>;
  appendMessage(message: AgentMessage): Promise<void>;
  markModelChange(modelId: string): Promise<void>;
}

export interface SessionStore {
  create(opts: { title: string; model: string }): Promise<SessionHandle>;
  open(id: string): Promise<SessionHandle | null>;
  list(): Promise<SessionSummary[]>;
}

/** src/ 与 dist/ 深度相同，同 db.ts 的 migrations 路径手法。 */
export function defaultSessionsRoot(): string {
  return fileURLToPath(new URL("../../storage/sessions", import.meta.url));
}

function messageText(m: AgentMessage): string | null {
  if (m.role === "user") {
    if (typeof m.content === "string") return m.content;
    return m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  if (m.role === "assistant") {
    return m.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  }
  return null;
}

class JsonlSessionHandle implements SessionHandle {
  constructor(
    readonly id: string,
    readonly title: string,
    private readonly session: Session<JsonlSessionMetadata>,
    private readonly createdModel: string,
  ) {}

  private async ensureLane() {
    const lanes = await this.session.getLanes();
    if (!lanes.some((l) => l.lane === "main")) await this.session.createLane("main", null);
  }

  async currentModel(): Promise<string> {
    const [change] = (await this.session.findEntries({
      type: "model_change", order: "newestFirst", limit: 1,
    })) as ModelChangeEntry[];
    return change?.modelId ?? this.createdModel;
  }

  async messages(): Promise<StoredChatMessage[]> {
    const entries = (await this.session.findEntries({
      type: "message", order: "oldestFirst",
    })) as MessageEntry[];
    const out: StoredChatMessage[] = [];
    for (const e of entries) {
      // 读端 role 白名单：toolResult 等其他角色不进历史（不写脏数据，也不靠强转）
      const role = e.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = messageText(e.message);
      if (!text) continue;
      out.push({ role, content: text });
    }
    return out;
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    await this.ensureLane();
    await this.session.appendMessage(message);
  }

  async markModelChange(modelId: string): Promise<void> {
    await this.ensureLane();
    await this.session.appendEntry(
      { type: "model_change", id: uuidv7(), provider: "chat", modelId },
      "main",
    );
  }
}

export class JsonlSessionStore implements SessionStore {
  private readonly repo: JsonlSessionRepo;
  private readonly cwd: string;
  /** 进程内单写者缓存：open() 无锁，同 id 必须共享一个 Session 实例。
      存 Promise 消除并发 open 的 check-then-set 竞态；null（未找到）/失败即刻清出缓存。 */
  private readonly cache = new Map<string, Promise<SessionHandle | null>>();

  constructor(opts: { sessionsRoot?: string; cwd?: string } = {}) {
    this.cwd = opts.cwd ?? fileURLToPath(new URL("../..", import.meta.url));
    const env = new NodeExecutionEnv({ cwd: this.cwd });
    this.repo = new JsonlSessionRepo({
      fs: env,
      sessionsRoot: opts.sessionsRoot ?? defaultSessionsRoot(),
    });
  }

  async create(opts: { title: string; model: string }): Promise<SessionHandle> {
    const session = await this.repo.create({
      cwd: this.cwd,
      metadata: { title: opts.title, model: opts.model },
    });
    const meta = await session.getMetadata();
    const handle = new JsonlSessionHandle(
      meta.id, String(meta.metadata?.title ?? ""), session, String(meta.metadata?.model ?? ""),
    );
    this.cache.set(meta.id, Promise.resolve(handle));
    return handle;
  }

  async open(id: string): Promise<SessionHandle | null> {
    let cached = this.cache.get(id);
    if (!cached) {
      cached = this.load(id);
      this.cache.set(id, cached);
    }
    try {
      const handle = await cached;
      if (!handle) this.cache.delete(id);
      return handle;
    } catch (err) {
      this.cache.delete(id);
      throw err;
    }
  }

  private async load(id: string): Promise<SessionHandle | null> {
    const meta = (await this.repo.list()).find((m) => m.id === id);
    if (!meta) return null;
    const session = await this.repo.open(meta);
    return new JsonlSessionHandle(
      id, String(meta.metadata?.title ?? ""), session, String(meta.metadata?.model ?? ""),
    );
  }

  async list(): Promise<SessionSummary[]> {
    const all = await this.repo.list();
    return all.map((m) => ({
      id: m.id,
      title: String(m.metadata?.title ?? ""),
      model: String(m.metadata?.model ?? ""),
      createdAt: m.createdAt,
      modifiedAt: m.modifiedAt,
    }));
  }
}
