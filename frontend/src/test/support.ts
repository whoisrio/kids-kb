/** 组件/hook 测试共用的 fetch 桩与响应构造。 */

export function sseResponse(events: string[]): Response {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
      },
    }),
  );
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 按 URL 精确路由的 fetch 桩；未匹配 URL 返回 404。 */
export function fetchRouter(routes: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const handler = Object.entries(routes).find(([prefix]) => url === prefix)?.[1];
    if (!handler) return new Response(`no route for ${url}`, { status: 404 });
    return handler(init);
  };
}
