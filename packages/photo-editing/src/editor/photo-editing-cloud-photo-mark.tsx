import { Cloud } from "lucide-react";

import { cn } from "niho-ui/cn";

/**
 * クラウドの写真の印（グリッドのタイル・フィルムストリップのセルと、ヘッダーのパンくずの写真名の横。この Mac の写真の
 * うち中身の同じクラウドの写真があるものに付け、クラウドの中では付けない）。読み上げは「クラウドの写真」。
 * ヘッダー（admin-client）からも読むので、写真編集の画面本体とは別のファイルに置く。
 */
export function CloudPhotoMark(props: { className?: string }) {
  return <Cloud role="img" aria-label="クラウドの写真" className={cn("h-4 w-4 shrink-0", props.className)} />;
}
