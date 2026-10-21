"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { fillPhotoEditingClipOverlay, type PhotoEditingClipMask } from "../photo-editing-histogram";

type OverlayBox = { left: number; top: number; width: number; height: number };

/** 位置の誤差（px）。これ以下の違いでは測り直した値に置き換えない（置き換えると再描画が止まらない） */
const BOX_EPSILON = 0.5;

function sameBox(a: OverlayBox | null, b: OverlayBox): boolean {
  return (
    a !== null &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/**
 * 写真の上に重ねる、クリップ領域の印（niho-photo#36。黒つぶれ = 青 / 白飛び = 赤。Lightroom の J）。写真の canvas（`targetRef`）と
 * 同じ大きさ・同じ位置に置く透明な canvas で、押せない（`pointer-events-none`）・読み上げない（`aria-hidden`）。
 * canvas の置かれ方（中央寄せ・縮小）に依らないよう、描く位置は写真の canvas の実測で決め、大きさが変わったら（窓・パネルの
 * 幅・写真の差し替え）測り直す。重ねるのは、親（写真の面。`position: absolute` の入れ物）の中。
 */
export function PhotoEditingClipOverlay(props: {
  /** 写真の canvas */
  targetRef: RefObject<HTMLCanvasElement | null>;
  mask: PhotoEditingClipMask;
  shadows: boolean;
  highlights: boolean;
}) {
  const { targetRef, mask, shadows, highlights } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState<OverlayBox | null>(null);

  // 印を画素にして描く（見せる側が変わった・印が替わったときだけ）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || mask.width <= 0 || mask.height <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    if (canvas.width !== mask.width) canvas.width = mask.width;
    if (canvas.height !== mask.height) canvas.height = mask.height;
    const image = context.createImageData(mask.width, mask.height);
    fillPhotoEditingClipOverlay(image.data, mask, { shadows, highlights });
    context.putImageData(image, 0, 0);
  }, [mask, shadows, highlights]);

  // 写真の canvas の実測に合わせる（変わっていなければ state を替えない）
  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    const target = targetRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !target || !parent) return;
    const measured = target.getBoundingClientRect();
    const origin = parent.getBoundingClientRect();
    const next: OverlayBox = {
      left: measured.left - origin.left - parent.clientLeft,
      top: measured.top - origin.top - parent.clientTop,
      width: measured.width,
      height: measured.height,
    };
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [targetRef]);

  // 描画のたびに測る（写真の差し替えで canvas の大きさが変わるのはここで拾う）
  useLayoutEffect(() => {
    measure();
  });

  // 描画を伴わない大きさの変化（窓・パネルの幅）も拾う
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = targetRef.current;
    const parent = canvasRef.current?.parentElement;
    if (observer && target) observer.observe(target);
    if (observer && parent) observer.observe(parent);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, targetRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      data-testid="photo-clip-overlay"
      className="pointer-events-none absolute"
      style={
        box
          ? { left: box.left, top: box.top, width: box.width, height: box.height }
          : { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" }
      }
    />
  );
}
