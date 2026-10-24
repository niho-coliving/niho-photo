"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { PHOTO_EDITING_ZOOM_SURFACE_ATTRIBUTE } from "./use-photo-editing-zoom";

/** 重ねる入れ物（親）の中での、写真の canvas の位置と大きさ（px）。 */
export type PhotoEditingTargetBox = { left: number; top: number; width: number; height: number };

/** 位置の誤差（px）。これ以下の違いでは測り直した値に置き換えない（置き換えると再描画が止まらない） */
const BOX_EPSILON = 0.5;

function sameBox(a: PhotoEditingTargetBox | null, b: PhotoEditingTargetBox): boolean {
  return (
    a !== null &&
    Math.abs(a.left - b.left) < BOX_EPSILON &&
    Math.abs(a.top - b.top) < BOX_EPSILON &&
    Math.abs(a.width - b.width) < BOX_EPSILON &&
    Math.abs(a.height - b.height) < BOX_EPSILON
  );
}

/**
 * 写真の canvas（`targetRef`）の、重ねる入れ物（`elementRef` の親）の中での位置と大きさ（クリップ領域の印と同じ測り方）。マスクの
 * つまみ（M3 #67）とブラシの面（M4 #68）が使う。描くたび・窓と canvas・親の大きさが変わるたびに測り直す。
 *
 * スマホの編集の層の拡大（ピンチ・送り。niho-photo#93）は写真の面の `style` に CSS 変数を直接書くので React は描き直さず、大きさも
 * 変わらない（transform）。写真の面（`data-photo-zoom-surface`）の `style` の変化を見て、次の描画の前（rAF。1 フレームに 1 回）に測り
 * 直す（`getBoundingClientRect` は transform の後の位置）。
 */
export function usePhotoEditingTargetBox(
  targetRef: RefObject<HTMLCanvasElement | null>,
  elementRef: RefObject<HTMLElement | null>,
): PhotoEditingTargetBox | null {
  const [box, setBox] = useState<PhotoEditingTargetBox | null>(null);
  const measure = useCallback(() => {
    const element = elementRef.current;
    const target = targetRef.current;
    const parent = element?.parentElement;
    if (!element || !target || !parent) return;
    const measured = target.getBoundingClientRect();
    const origin = parent.getBoundingClientRect();
    const next: PhotoEditingTargetBox = {
      left: measured.left - origin.left - parent.clientLeft,
      top: measured.top - origin.top - parent.clientTop,
      width: measured.width,
      height: measured.height,
    };
    setBox((current) => (sameBox(current, next) ? current : next));
  }, [elementRef, targetRef]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const target = targetRef.current;
    const parent = elementRef.current?.parentElement;
    if (observer && target) observer.observe(target);
    if (observer && parent) observer.observe(parent);
    // 拡大（写真の面の style）が変わったら、1 フレームに 1 回だけ測り直す
    let frame: number | null = null;
    const scheduleMeasure = () => {
      if (frame !== null) return;
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    const surface = elementRef.current?.closest(`[${PHOTO_EDITING_ZOOM_SURFACE_ATTRIBUTE}]`) ?? null;
    const zoomObserver =
      surface && typeof MutationObserver !== "undefined" ? new MutationObserver(scheduleMeasure) : null;
    if (zoomObserver && surface) zoomObserver.observe(surface, { attributes: true, attributeFilter: ["style"] });
    return () => {
      observer?.disconnect();
      zoomObserver?.disconnect();
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
    };
  }, [elementRef, measure, targetRef]);
  return box;
}
