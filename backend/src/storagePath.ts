/** DB 里的图片路径一律相对 pipeline storage 根（KB_STORAGE_DIR，spec §7.1）。
    绝对路径原样透传，兼容 source_path 与迁移前的存量行。 */
import { isAbsolute, join } from "node:path";

export function resolveStoragePath(storageRoot: string, p: string): string {
  return isAbsolute(p) ? p : join(storageRoot, p);
}
