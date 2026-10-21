"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

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
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [elementRef, measure, targetRef]);
  return box;
}
