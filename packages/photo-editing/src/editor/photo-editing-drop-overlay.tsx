import { CloudUpload } from "lucide-react";

import { PHOTO_DROP_HEADLINE, PHOTO_DROP_HINT, PHOTO_DROP_QUEUED_HINT } from "../photo-file-drop";
import type { PhotoFileDropZoneState } from "../use-photo-file-drop-zone";
import { cn } from "niho-ui/cn";

/**
 * Finder などから写真をドラッグしている間、中央の一覧の上に出す幕 1 枚（移行元設計・owner 決定 2026-09-29）。破線の枠・雲の
 * アイコン・見出し 1 行＋補足 1 行。受けられないときは薄くして理由だけ出す。押せるものは置かず（ドラッグの邪魔をしない）、
 * 読み上げない（落とした結果は状態欄が伝える）。
 */
export function PhotoEditingDropOverlay(props: { state: PhotoFileDropZoneState | null }) {
  const { state } = props;
  if (!state) return null;
  const accept = state.kind === "accept";
  return (
    <div
      aria-hidden
      data-testid="photo-drop-overlay"
      data-drop-state={state.kind}
      className="pointer-events-none absolute inset-0 z-20 flex p-3 animate-in fade-in-0 duration-150 motion-reduce:animate-none"
    >
      <div
        className={cn(
          "flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 text-center transition-colors motion-reduce:transition-none",
          accept
            ? "border-niho-accent-ink bg-niho-accent-soft/90 text-niho-accent-ink"
            : "border-niho-text-muted/60 bg-white/85 text-niho-text-muted",
        )}
      >
        <CloudUpload className="h-10 w-10" strokeWidth={1.5} aria-hidden />
        {accept ? (
          <>
            <p className="text-body font-bold">{PHOTO_DROP_HEADLINE}</p>
            <p className="text-xs font-bold text-niho-text-sub">{state.queued ? PHOTO_DROP_QUEUED_HINT : PHOTO_DROP_HINT}</p>
          </>
        ) : (
          <p className="text-sub font-bold">{state.reason}</p>
        )}
      </div>
    </div>
  );
}
