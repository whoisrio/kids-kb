import type { ReviewItemDetail as ItemDetailData } from "../api/review";

export function ItemDetail(_props: {
  item: ItemDetailData;
  onReload: () => Promise<void>;
  onExit: () => void;
  onError: (e: string) => void;
  fetchImpl?: typeof fetch;
}) {
  return <div className="item-detail">（Task 10 实现）</div>;
}
