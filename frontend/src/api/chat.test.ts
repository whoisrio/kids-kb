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
});
