import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleteLibraryDoc } = vi.hoisted(() => ({
  deleteLibraryDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../api/library", () => ({
  fetchLibraryDocs: vi.fn().mockResolvedValue([
    { id: "d1", title: "数学练习册", subject: "数学", file_type: "pdf",
      parse_status: "parsed", review_status: "pending", uploaded_by: null,
      created_at: "2026-01-01", pending_pages: 2, total_pages: 10, indexed_pages: 8 },
  ]),
  deleteLibraryDoc,
}));

import { LibraryView } from "./LibraryView";

describe("LibraryView", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("renders document cards grouped by subject", async () => {
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    expect(screen.getByText(/待复核/)).toBeInTheDocument();
  });

  it("deletes document on confirm", async () => {
    const user = userEvent.setup();
    render(<LibraryView />);
    await waitFor(() => expect(screen.getByText("数学练习册")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await user.click(screen.getByText("确认删除"));
    await waitFor(() => expect(deleteLibraryDoc).toHaveBeenCalledWith("d1", expect.anything()));
  });
});
