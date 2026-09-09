import { describe, expect, it } from "vitest";
import { resolveStoragePath } from "./storagePath.js";

describe("resolveStoragePath", () => {
  it("相对路径以 storageRoot（KB_STORAGE_DIR）为基准", () => {
    expect(resolveStoragePath("/root/storage", "d1/pages/p0001.png"))
      .toBe("/root/storage/d1/pages/p0001.png");
  });
  it("绝对路径原样透传（兼容存量 source_path 等）", () => {
    expect(resolveStoragePath("/root/storage", "/abs/x.png")).toBe("/abs/x.png");
  });
});
