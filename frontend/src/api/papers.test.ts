import { describe, expect, it } from "vitest";
import { confirmQuestion, fetchPapers, uploadPaper } from "./papers";

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("papers api", () => {
  it("uploadPaper:multipart 携带文件与字段", async () => {
    let captured: FormData | null = null;
    const paper = await uploadPaper(
      { child_id: "c1", title: "期中卷", subject: "数学", files: [new File([new Uint8Array([1])], "a.png")] },
      async (_url, init) => {
        captured = init?.body as FormData;
        return jsonResp({ id: "p1", status: "processing" }, 201);
      });
    expect(paper.id).toBe("p1");
    expect(captured!.get("child_id")).toBe("c1");
    expect(captured!.get("subject")).toBe("数学");
    expect((captured!.getAll("files")[0] as File).name).toBe("a.png");
  });

  it("fetchPapers:GET /api/papers?child_id=", async () => {
    let url = "";
    const { papers } = await fetchPapers("c1", async (input) => {
      url = String(input);
      return jsonResp({ papers: [{ id: "p1", status: "done" }] });
    });
    expect(url).toBe("/api/papers?child_id=c1");
    expect(papers[0].id).toBe("p1");
  });

  it("confirmQuestion:PUT body + 返回 paper_status;非 2xx 抛错", async () => {
    let captured = "";
    const out = await confirmQuestion("q1", { result: "wrong", error_cause: "计算错" }, async (_input, init) => {
      captured = String(init?.body);
      return jsonResp({ id: "q1", paper_status: "done" });
    });
    expect(out.paper_status).toBe("done");
    expect(JSON.parse(captured)).toEqual({ result: "wrong", error_cause: "计算错" });
    await expect(confirmQuestion("q1", { result: "wrong" }, async () => jsonResp({}, 422)))
      .rejects.toThrow("请求失败: 422");
  });
});
