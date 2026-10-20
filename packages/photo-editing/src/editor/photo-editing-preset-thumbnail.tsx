"use client";

import { useEffect, useRef } from "react";

import { Skeleton } from "niho-ui/components/skeleton";
import type { DevelopFrame } from "../develop-engine/develop-engine-client";
import { paintDevelopFrame } from "../develop-engine/develop-frame";
import { cn } from "niho-ui/cn";

/** 行の見本（まだ描いていなければ `frame: null`。描けなかった〔当てられないプリセット・描画の失敗〕なら `failed`）。 */
export type PhotoEditingPresetThumbnailState = { frame: DevelopFrame | null; failed: boolean };

/**
 * プリセットの行の見本（ブラウザ版の右パネル。NIHO Photo 段 1 F2b 移行元設計）。描く順番と作り直しは呼ぶ側（`useBrowserPresetThumbnails`）
 * が持ち、パネルは行の要素を渡して、描けた絵を出すだけ。
 */
export type PhotoEditingPresetThumbnails = {
  /** 行の見本 */
  stateOf: (key: string) => PhotoEditingPresetThumbnailState;
  /**
   * 行の見本の要素を渡す（見えている行から描く）。`xmp` が null の行は「なし」（当てる前の補正の絵）。行が消えたら `element` を
   * null で呼ぶ
   */
  observe: (key: string, xmp: string | null, element: Element | null) => void;
};

/** 「なし」の行の見本のキー。 */
export const PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY = "none";

/**
 * 行の左の見本（48px 角・角丸・`object-cover`）。描く前は同じ大きさの薄い面（skeleton）を置き、作り直す間は前の見本を出した
 * まま（点滅させない）。読み上げない（行の名前で足りる）。
 */
export function PhotoEditingPresetThumbnail(props: {
  thumbnailKey: string;
  xmp: string | null;
  thumbnails: PhotoEditingPresetThumbnails;
  className?: string;
}) {
  const { thumbnailKey, xmp } = props;
  const { observe } = props.thumbnails;
  const elementRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    observe(thumbnailKey, xmp, element);
    return () => observe(thumbnailKey, xmp, null);
  }, [observe, thumbnailKey, xmp]);

  const state = props.thumbnails.stateOf(thumbnailKey);
  const frame = state.frame;
  useEffect(() => {
    if (frame && canvasRef.current) paintDevelopFrame(canvasRef.current, frame);
  }, [frame]);

  return (
    <span
      ref={elementRef}
      aria-hidden
      data-testid="photo-preset-thumbnail"
      data-state={frame ? "ready" : state.failed ? "failed" : "pending"}
      className={cn("block h-12 w-12 shrink-0 overflow-hidden rounded-lg", props.className)}
    >
      {frame ? (
        <canvas ref={canvasRef} className="block h-full w-full object-cover" />
      ) : state.failed ? (
        <span className="block h-full w-full bg-niho-pale" />
      ) : (
        <Skeleton className="h-full w-full rounded-lg" />
      )}
    </span>
  );
}
