"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from "react";

import {
  PHOTO_ZOOM_FIT,
  clampZoom,
  fitPhotoZoomContent,
  isPhotoZoomed,
  resolveMaxZoomScale,
  toggleZoomAt,
  zoomAround,
  type PhotoZoomBounds,
  type PhotoZoomPoint,
  type PhotoZoomState,
} from "../photo-editing-zoom";

/**
 * スマホの 1 枚の編集の層の、写真の面の指の操作（NIHO Photo 段 1 F6c 移行元設計）。同じ指を取り合うので 1 か所で持つ。
 *
 * - 指 1 本の長押し（動かさない）: 補正前（押している間だけ。ボタンが正で、これは近道）。
 * - 指 2 本: ピンチで拡大（2 点の距離の比で倍率、2 点の中点の下の画を動かさない。中点の移動で送る）。始めたら長押しは取り消す。
 * - 指 1 本・拡大中: ドラッグで送る（長押しをやめる 10px を越えてから）。全体表示のときのドラッグは何もしない。
 * - ダブルタップ: 全体表示 ⇄ 100%（作業画像の 1px が CSS の 1px。小さい画でも 2 倍）。
 * - 指 1 本で別のものを描く面（マスクのブラシ。niho-photo#93）は {@link PHOTO_EDITING_ZOOM_PINCH_ONLY_ATTRIBUTE} を付ける。その面の
 *   上の指はピンチ（指 2 本）にだけ数え、指 1 本の送り・長押し・ダブルタップには使わない。
 *
 * 画への当て方: 写真の面の要素に CSS 変数 `--photo-editing-zoom` を直接書く（指を動かすたびに React を描き直さない）。
 * 1 枚の表示（`BrowserPhotoEditingLoupe`）の canvas / img がこれを `transform` に読む。React の state に持つのは
 * 「拡大しているか」だけ。写真が替わったら全体表示へ戻し、面の大きさが変わったら収め直す。
 */

const ZOOM_VARIABLE = "--photo-editing-zoom";

/**
 * 写真の面（拡大を書く要素）に付ける印。写真の上に重ねる印（マスクのつまみ・ブラシ）は、この要素の `style`（拡大）が変わったら
 * 測り直す（`usePhotoEditingTargetBox`。niho-photo#93）。
 */
export const PHOTO_EDITING_ZOOM_SURFACE_ATTRIBUTE = "data-photo-zoom-surface";
/** 指 1 本ではなく、ピンチにだけ使う面の印（その面が指 1 本の操作を持つ。マスクのブラシ）。 */
export const PHOTO_EDITING_ZOOM_PINCH_ONLY_ATTRIBUTE = "data-photo-zoom-pinch-only";

/** 長押し（補正前の近道）までの時間。 */
const PHOTO_HOLD_MS = 450;
/** これより動かしたら長押しにもタップにもしない（拡大中は、ここから送り始める）。 */
const PRESS_MOVE_TOLERANCE_PX = 10;
/** ダブルタップ: 2 回のタップの間隔と距離。 */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_DISTANCE_PX = 24;

/** 写真の面を押している指（長押しで補正前）。 */
type PhotoHold = { pointerId: number; timer: number | null; holding: boolean };
/** 指 1 本の押下（タップか、拡大中のドラッグか）。 */
type PhotoPress = { pointerId: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean };
/** ピンチの前回の 2 点（距離と中点）。 */
type PhotoPinch = { distance: number; x: number; y: number };
type PhotoTap = { x: number; y: number; time: number };
/** 面と画の寸法と、面の中央（画面の座標）。 */
type PhotoSurfaceMeasure = PhotoZoomBounds & { centerX: number; centerY: number };

/**
 * 測る面。補正前と補正後を並べている間（niho-photo#41）は、面の中に同じ大きさの半分の面（`data-photo-zoom-pane`）が 2 つあり、
 * どちらの画も同じ拡大を読む（中央を軸に同じだけ動く）ので、指の下の半分の面（指が無い・外れていれば先頭の面）を測る。
 */
function photoZoomArea(surface: HTMLElement, point?: PhotoZoomPoint): HTMLElement {
  const panes = Array.from(surface.querySelectorAll<HTMLElement>("[data-photo-zoom-pane]"));
  if (point) {
    const hit = panes.find((pane) => {
      const rect = pane.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    });
    if (hit) return hit;
  }
  return panes[0] ?? surface;
}

function photoZoomPanes(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>("[data-photo-zoom-pane]"));
}

/**
 * 面の中の canvas（無ければ img）から、今の寸法を読む。`offsetWidth` / `offsetHeight` は transform の影響を受けない。
 * 画がまだ無い・大きさが 0 なら null（拡大しない）。`point` は指の位置（並べている間に、指の下の半分の面を測る）。
 */
export function measurePhotoSurface(surface: HTMLElement, point?: PhotoZoomPoint): PhotoSurfaceMeasure | null {
  const area = photoZoomArea(surface, point);
  const canvas = area.querySelector("canvas");
  const image = canvas ? null : area.querySelector("img");
  const box = canvas ?? image;
  if (!box) return null;
  const intrinsicWidth = canvas ? canvas.width : image ? image.naturalWidth : 0;
  const intrinsicHeight = canvas ? canvas.height : image ? image.naturalHeight : 0;
  const content = fitPhotoZoomContent({
    boxWidth: box.offsetWidth,
    boxHeight: box.offsetHeight,
    intrinsicWidth,
    intrinsicHeight,
  });
  if (!(content.width > 0) || !(content.height > 0)) return null;
  const rect = area.getBoundingClientRect();
  return {
    areaWidth: area.clientWidth,
    areaHeight: area.clientHeight,
    contentWidth: content.width,
    contentHeight: content.height,
    maxScale: resolveMaxZoomScale({ contentWidth: content.width, intrinsicWidth }),
    centerX: rect.left + rect.width / 2,
    centerY: rect.top + rect.height / 2,
  };
}

function pinchSample(pointers: ReadonlyMap<number, PhotoZoomPoint>): PhotoPinch | null {
  const points = Array.from(pointers.values());
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  return {
    distance: Math.hypot(first.x - second.x, first.y - second.y),
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function roundTo(value: number, unit: number): number {
  return Math.round(value * unit) / unit;
}

function zoomTransform(state: PhotoZoomState): string {
  return `translate(${roundTo(state.x, 100)}px, ${roundTo(state.y, 100)}px) scale(${roundTo(state.scale, 1000)})`;
}

export function usePhotoEditingZoom(options: {
  /** 開いている写真（替わったら全体表示へ戻す） */
  photoKey: string;
  /** 切り抜きなど、写真の拡大表示が使われない道具を開いている */
  enabled?: boolean;
  /** 長押しで補正前を見せられる */
  holdEnabled: boolean;
  /** 長押しで補正前を見せる / やめる */
  onHoldChange: (holding: boolean) => void;
}): {
  /** 写真の面（画を切り抜く要素）に付ける */
  surfaceRef: MutableRefObject<HTMLDivElement | null>;
  /** 拡大している */
  zoomed: boolean;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  /** 指が外れた・取り消された（タップにしない） */
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
} {
  const { photoKey, holdEnabled, onHoldChange, enabled = true } = options;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<PhotoZoomState>(PHOTO_ZOOM_FIT);
  const pointersRef = useRef(new Map<number, PhotoZoomPoint>());
  const holdRef = useRef<PhotoHold | null>(null);
  const pressRef = useRef<PhotoPress | null>(null);
  const pinchRef = useRef<PhotoPinch | null>(null);
  const lastTapRef = useRef<PhotoTap | null>(null);

  // 拡大しているかどうかだけ state に持つ（どの写真で拡大したかで持ち、写真が替わったら拡大していない扱い）
  const [zoomedKey, setZoomedKey] = useState<string | null>(null);
  if (zoomedKey !== null && zoomedKey !== photoKey) setZoomedKey(null);
  const zoomed = zoomedKey === photoKey;
  const zoomedRef = useRef(false);
  const photoKeyRef = useRef(photoKey);

  const onHoldChangeRef = useRef(onHoldChange);
  useEffect(() => {
    onHoldChangeRef.current = onHoldChange;
  });

  const applyZoom = useCallback((next: PhotoZoomState) => {
    zoomRef.current = next;
    const nextZoomed = isPhotoZoomed(next);
    const surface = surfaceRef.current;
    if (surface) {
      if (nextZoomed) surface.style.setProperty(ZOOM_VARIABLE, zoomTransform(next));
      else surface.style.removeProperty(ZOOM_VARIABLE);
    }
    if (zoomedRef.current === nextZoomed) return;
    zoomedRef.current = nextZoomed;
    setZoomedKey(nextZoomed ? photoKeyRef.current : null);
  }, []);

  const endHold = useCallback((pointerId?: number) => {
    const hold = holdRef.current;
    if (!hold || (pointerId !== undefined && hold.pointerId !== pointerId)) return;
    holdRef.current = null;
    if (hold.timer !== null) window.clearTimeout(hold.timer);
    if (hold.holding) onHoldChangeRef.current(false);
  }, []);

  // 層を閉じたら、長押しで見せていた補正前をやめる
  useEffect(() => () => endHold(), [endHold]);

  // 切り抜き中は overlay が zoom transform を読まないため、ジェスチャーを止めて全体表示へ戻す。
  useEffect(() => {
    if (enabled) return;
    pointersRef.current.clear();
    pressRef.current = null;
    pinchRef.current = null;
    lastTapRef.current = null;
    endHold();
    applyZoom(PHOTO_ZOOM_FIT);
  }, [applyZoom, enabled, endHold]);

  // 写真が替わったら全体表示へ戻す（途中のピンチ・ダブルタップの 1 回目も捨てる）
  useEffect(() => {
    photoKeyRef.current = photoKey;
    zoomRef.current = PHOTO_ZOOM_FIT;
    zoomedRef.current = false;
    pinchRef.current = null;
    lastTapRef.current = null;
    surfaceRef.current?.style.removeProperty(ZOOM_VARIABLE);
  }, [photoKey]);

  // 面の大きさや比較paneの集合が変わったら、今の拡大位置を新しい bounds に収め直す。画が無くなっていたら全体表示へ
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const reclamp = () => {
      const current = zoomRef.current;
      if (!isPhotoZoomed(current)) return;
      const measure = measurePhotoSurface(surface);
      applyZoom(measure ? clampZoom(current, measure) : PHOTO_ZOOM_FIT);
    };
    let panes = photoZoomPanes(surface);
    const paneObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
      const nextPanes = photoZoomPanes(surface);
      if (nextPanes.length === panes.length && nextPanes.every((pane, index) => pane === panes[index])) return;
      panes = nextPanes;
      reclamp();
    });
    paneObserver?.observe(surface, {
      attributes: true,
      attributeFilter: ["data-photo-zoom-pane"],
      childList: true,
      subtree: true,
    });
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", reclamp);
      return () => {
        window.removeEventListener("resize", reclamp);
        paneObserver?.disconnect();
      };
    }
    const observer = new ResizeObserver(reclamp);
    observer.observe(surface);
    return () => {
      observer.disconnect();
      paneObserver?.disconnect();
    };
  }, [applyZoom]);

  const measure = (point: PhotoZoomPoint): PhotoSurfaceMeasure | null => {
    const surface = surfaceRef.current;
    return surface ? measurePhotoSurface(surface, point) : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    // 写真の面の上の操作（「もう一度読み込む」）は、その操作のもの
    if (event.target instanceof Element && event.target.closest("button, a[href]")) return;
    const pointers = pointersRef.current;
    // 最初の指（primary）が降りたのに前の指が残っているのは、離した通知が届かなかったとき。持ち越さない
    if (event.isPrimary && pointers.size > 0) {
      pointers.clear();
      pressRef.current = null;
      pinchRef.current = null;
      endHold();
    }
    // 3 本目からは数えない
    if (pointers.size >= 2 || pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2) {
      // 指 2 本はピンチ。長押し（補正前）とタップは取り消す
      endHold();
      pressRef.current = null;
      lastTapRef.current = null;
      pinchRef.current = pinchSample(pointers);
      return;
    }
    // 指 1 本の操作を持つ面（ブラシ）の上は、ピンチの 1 本目として数えるだけ（送り・長押し・タップにしない）
    if (event.target instanceof Element && event.target.closest(`[${PHOTO_EDITING_ZOOM_PINCH_ONLY_ATTRIBUTE}]`)) {
      lastTapRef.current = null;
      return;
    }

    pressRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    };
    if (!holdEnabled) return;
    const hold: PhotoHold = { pointerId: event.pointerId, timer: null, holding: false };
    hold.timer = window.setTimeout(() => {
      if (holdRef.current !== hold) return;
      hold.timer = null;
      hold.holding = true;
      onHoldChangeRef.current(true);
    }, PHOTO_HOLD_MS);
    holdRef.current = hold;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const pointers = pointersRef.current;
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    const pinch = pinchRef.current;
    if (pinch) {
      const next = pinchSample(pointers);
      if (!next) return;
      pinchRef.current = next;
      const bounds = measure(next);
      if (!bounds || !(pinch.distance > 0) || !(next.distance > 0)) return;
      const current = zoomRef.current;
      const scale = Math.min(Math.max(current.scale * (next.distance / pinch.distance), 1), bounds.maxScale);
      // 中点が動いた分だけ送ってから、中点の下の画を動かさずに倍率を変える
      const moved: PhotoZoomState = {
        scale: current.scale,
        x: current.x + (next.x - pinch.x),
        y: current.y + (next.y - pinch.y),
      };
      const focal: PhotoZoomPoint = { x: next.x - bounds.centerX, y: next.y - bounds.centerY };
      applyZoom(clampZoom(zoomAround(moved, focal, scale), bounds));
      return;
    }

    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    // 長押しで補正前を見せている間は、指を動かしても送らない
    const hold = holdRef.current;
    if (hold !== null && hold.holding) return;
    if (!press.moved) {
      if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) <= PRESS_MOVE_TOLERANCE_PX) return;
      // 指を動かしたら長押しにもタップにもしない。拡大中は、ここから送り始める
      press.moved = true;
      endHold(event.pointerId);
      press.lastX = event.clientX;
      press.lastY = event.clientY;
      return;
    }
    const dx = event.clientX - press.lastX;
    const dy = event.clientY - press.lastY;
    press.lastX = event.clientX;
    press.lastY = event.clientY;
    const current = zoomRef.current;
    if (!isPhotoZoomed(current)) return;
    const bounds = measure({ x: event.clientX, y: event.clientY });
    if (!bounds) return;
    applyZoom(clampZoom({ scale: current.scale, x: current.x + dx, y: current.y + dy }, bounds));
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>, tap: boolean) => {
    if (!enabled) return;
    const pointers = pointersRef.current;
    const tracked = pointers.delete(event.pointerId);
    const hold = holdRef.current;
    const wasHolding = hold !== null && hold.pointerId === event.pointerId && hold.holding;
    endHold(event.pointerId);
    if (!tracked) return;

    if (pinchRef.current) {
      pinchRef.current = null;
      // 残った指は、続けて送れる（タップにはしない）
      const rest = Array.from(pointers.entries())[0];
      pressRef.current = rest
        ? { pointerId: rest[0], startX: rest[1].x, startY: rest[1].y, lastX: rest[1].x, lastY: rest[1].y, moved: true }
        : null;
      return;
    }

    const press = pressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    pressRef.current = null;
    if (!tap || press.moved || wasHolding) {
      lastTapRef.current = null;
      return;
    }
    const now = Date.now();
    const last = lastTapRef.current;
    const double =
      last !== null &&
      now - last.time <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <= DOUBLE_TAP_DISTANCE_PX;
    if (!double) {
      lastTapRef.current = { x: event.clientX, y: event.clientY, time: now };
      return;
    }
    lastTapRef.current = null;
    const bounds = measure({ x: event.clientX, y: event.clientY });
    if (!bounds) return;
    const focal: PhotoZoomPoint = { x: event.clientX - bounds.centerX, y: event.clientY - bounds.centerY };
    applyZoom(clampZoom(toggleZoomAt(zoomRef.current, focal, bounds.maxScale), bounds));
  };

  return {
    surfaceRef,
    zoomed,
    onPointerDown,
    onPointerMove,
    onPointerUp: (event) => finishPointer(event, true),
    onPointerCancel: (event) => finishPointer(event, false),
  };
}
