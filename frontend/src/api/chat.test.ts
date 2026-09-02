import { describe, expect, it } from "vitest";
import { streamChat } from "./chat";

function sseResponse(events: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
}

describe("streamChat", () => {
  it("解析 delta 事件并回调，done 收尾", async () => {
    const events = [
      'event: delta\ndata: "你"\n\n',
      'event: delta\ndata: "好"\n\n',
      "event: done\ndata: \n\n",
    ];
    const deltas: string[] = [];
    let done = false;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => (done = true) },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual(["你", "好"]);
    expect(done).toBe(true);
  });

  it("流提前结束（无 done/error 帧）→ onError 恰好一次，onDone 未调", async () => {
    const events = ['event: delta\ndata: "你"\n\n'];
    const deltas: string[] = [];
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => done++, onError: () => err++ },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual(["你"]);
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("fetchImpl reject → onError 恰好一次", async () => {
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => {}, onDone: () => done++, onError: () => err++ },
      async () => {
        throw new Error("network down");
      },
    );
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("畸形 delta（data 不是合法 JSON）→ onError，后续帧不再处理", async () => {
    const events = [
      "event: delta\ndata: {oops\n\n",
      'event: delta\ndata: "后"\n\n',
      "event: done\ndata: \n\n",
    ];
    const deltas: string[] = [];
    let done = 0;
    let err = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: (d) => deltas.push(d), onDone: () => done++, onError: () => err++ },
      async () => new Response(sseResponse(events)),
    );
    expect(deltas).toEqual([]);
    expect(done).toBe(0);
    expect(err).toBe(1);
  });

  it("abort 后不触发任何回调", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await streamChat(
      [{ role: "user", content: "hi" }],
      { onDelta: () => calls++, onDone: () => calls++, onError: () => calls++ },
      async () => new Response(sseResponse(['event: delta\ndata: "你"\n\n'])),
      ac.signal,
    );
    expect(calls).toBe(0);
  });
});
