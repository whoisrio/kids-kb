import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../test/support";
import { LibraryUploadDialog } from "./LibraryUploadDialog";

function pickFile(name: string) {
  const file = new File(["x"], name, { type: "application/pdf" });
  fireEvent.change(screen.getByLabelText("文件"), { target: { files: [file] } });
  return file;
}

describe("LibraryUploadDialog", () => {
  it("选文件后标题自动填文件名（去扩展名）", () => {
    render(<LibraryUploadDialog onDone={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("标题")).toHaveValue("");
    pickFile("四年级数学学霸题中题.pdf");
    expect(screen.getByLabelText("标题")).toHaveValue("四年级数学学霸题中题");
  });

  it("标题手改后再选文件不再覆盖", () => {
    render(<LibraryUploadDialog onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "我的资料" } });
    pickFile("某试卷.docx");
    expect(screen.getByLabelText("标题")).toHaveValue("我的资料");
  });

  it("提交发 multipart 到 /api/library/docs（file/title/subject/doc_type）", async () => {
    const calls: { url: string; method?: string; form: FormData }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, form: init?.body as FormData });
      return jsonResponse({ id: "d1", title: "寒假计算大通关" }, 201);
    }) as typeof fetch;
    const onDone = vi.fn();
    render(<LibraryUploadDialog onDone={onDone} onClose={vi.fn()} fetchImpl={fetchImpl} />);
    const file = pickFile("寒假计算大通关.pdf");
    fireEvent.change(screen.getByLabelText("类型"), { target: { value: "exam" } });
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: "d1" })));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/library/docs");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form.get("title")).toBe("寒假计算大通关");
    expect(calls[0].form.get("subject")).toBe("数学");
    expect(calls[0].form.get("doc_type")).toBe("exam");
    expect(calls[0].form.get("file")).toBe(file);
  });

  it("文件/标题缺失时不提交并报错", () => {
    const onDone = vi.fn();
    render(<LibraryUploadDialog onDone={onDone} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getByText(/必填/)).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("提交失败在弹窗内显示错误", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "bad" }, 422)) as typeof fetch;
    render(<LibraryUploadDialog onDone={vi.fn()} onClose={vi.fn()} fetchImpl={fetchImpl} />);
    pickFile("a.pdf");
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() => expect(screen.getByText("bad")).toBeInTheDocument());
  });
});
