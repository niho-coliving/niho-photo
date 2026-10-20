"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  developAspectRatio,
  developFrameSize,
  moveCropBox,
  resizeCropBox,
  setGeometryAngle,
  type CropBox,
  type CropHandle,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";
import {
  PHOTO_EDITING_CROP_FRAME_LABEL,
  PHOTO_EDITING_CROP_HANDLE_LABELS,
  photoEditingCropSizeText,
} from "../photo-editing-copy";
import {
  cropArrowDirection,
  cropKeyboardStep,
  cropOutputSize,
  cropOverlayLayout,
  cropScreenToFrameDelta,
  editingCropBox,
  geometryWithCropBox,
} from "../photo-editing-crop";
import { cn } from "niho-ui/cn";

/** つまみの並び（読み上げ・Tab の順。左上の角から時計回り）と、枠の上の位置（0〜1）。 */
const HANDLES: ReadonlyArray<{ handle: CropHandle; x: number; y: number }> = [
  { handle: "nw", x: 0, y: 0 },
  { handle: "n", x: 0.5, y: 0 },
  { handle: "ne", x: 1, y: 0 },
  { handle: "e", x: 1, y: 0.5 },
  { handle: "se", x: 1, y: 1 },
  { handle: "s", x: 0.5, y: 1 },
  { handle: "sw", x: 0, y: 1 },
  { handle: "w", x: 0, y: 0.5 },
];

/** つまみの見た目（角はかぎ形・辺は短い棒。押せる範囲 44px の中心が枠の角・辺の中点）。 */
const HANDLE_MARK_CLASS_NAMES: Readonly<Record<CropHandle, string>> = {
  nw: "left-1/2 top-1/2 h-4 w-4 border-l-[3px] border-t-[3px] border-niho-surface",
  ne: "right-1/2 top-1/2 h-4 w-4 border-r-[3px] border-t-[3px] border-niho-surface",
  se: "bottom-1/2 right-1/2 h-4 w-4 border-b-[3px] border-r-[3px] border-niho-surface",
  sw: "bottom-1/2 left-1/2 h-4 w-4 border-b-[3px] border-l-[3px] border-niho-surface",
  n: "left-1/2 top-1/2 h-[3px] w-6 -translate-x-1/2 bg-niho-surface",
  s: "bottom-1/2 left-1/2 h-[3px] w-6 -translate-x-1/2 bg-niho-surface",
  e: "right-1/2 top-1/2 h-6 w-[3px] -translate-y-1/2 bg-niho-surface",
  w: "left-1/2 top-1/2 h-6 w-[3px] -translate-y-1/2 bg-niho-surface",
};

const HANDLE_CURSOR_CLASS_NAMES: Readonly<Record<CropHandle, string>> = {
  nw: "enabled:cursor-nwse-resize",
  se: "enabled:cursor-nwse-resize",
  ne: "enabled:cursor-nesw-resize",
  sw: "enabled:cursor-nesw-resize",
  n: "enabled:cursor-ns-resize",
  s: "enabled:cursor-ns-resize",
  e: "enabled:cursor-ew-resize",
  w: "enabled:cursor-ew-resize",
};

const SHADE_CLASS_NAME = "pointer-events-none absolute inset-0 bg-niho-text/60";
const GRID_LINE_CLASS_NAME = "absolute bg-niho-surface/70";

type Gesture = {
  target: "move" | CropHandle;
  pointerId: number;
  startX: number;
  startY: number;
  startBox: CropBox;
  scale: number;
};

/** 動かしている途中の箱（どの確定済みの幾何から動かし始めたか）。 */
type Draft = { box: CropBox; geometryKey: string };

function sameBox(a: CropBox, b: CropBox): boolean {
  return a.cx === b.cx && a.cy === b.cy && a.width === b.width && a.height === b.height;
}

function rectStyle(left: number, top: number, width: number, height: number): CSSProperties {
  return { left, top, width: Math.max(0, width), height: Math.max(0, height) };
}

/** 枠の外の幕: 表示の領域いっぱいの 1 枚から、切り抜きの枠の所だけをくり抜く（継ぎ目を作らない）。 */
function shadeStyle(box: { left: number; top: number; width: number; height: number }): CSSProperties {
  const left = `${box.left}px`;
  const top = `${box.top}px`;
  const right = `${box.left + box.width}px`;
  const bottom = `${box.top + box.height}px`;
  return {
    clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left} ${top}, ${right} ${top}, ${right} ${bottom}, ${left} ${bottom}, ${left} ${top})`,
  };
}

/**
 * 写真の上の切り抜きの枠（NIHO Photo 段 1 F3b 移行元設計）。`children` は枠全体（切り抜きと角度を外した画）を描いた canvas で、
 * 切り抜きの枠は画面でまっすぐ立ち、写真の方を CSS で回して重ねる（wasm は枠を動かすたびに描かない）。右パネルに依存しない
 * 独立の部品で、ブラウザの面の 1 枚の表示とスマホの編集面（F6c 移行元設計）が同じものを使う。
 *
 * - 枠の外は暗い幕。枠の線と、動かしている間・角度補正を動かしている間（`liveAngle`）だけ 3 分割のグリッド
 * - 角 4・辺 4 のつまみ（押せる範囲 44px）で大きさを変え（縦横比を守る比率のときは比率を保つ）、枠の中を押して動かすと枠が
 *   動く。マウスでも指でも同じ（pointer capture・`touch-action: none`）。動かしている間は手元の箱だけを変え、離したら 1 回
 *   `onCommit`（取り消しの 1 単位）。写真（枠）からは出ない
 * - キーボード: 枠そのものに矢印で移動、各つまみ（ボタン）に矢印で伸縮（1 回で写真の短辺の 1%、⇧ で 5%）。キーを離したら・
 *   フォーカスが外れたら確定（押し続けている間は 1 単位）
 * - 確定済みの切り抜きの大きさを、読み上げ用の領域に出す（確定のたびに変わる）
 *
 * 表示の領域の大きさは自分の要素を測る（`viewport` を渡せばそれを使う）。回転・倍率の変化にアニメーションは付けない。
 */
export function PhotoEditingCropOverlay(props: {
  /** 確定している幾何 */
  geometry: DevelopGeometry;
  /** 作業画像（向きは反映済み・幾何を当てる前）の大きさ */
  source: DevelopSize;
  /** 角度補正のつまみを動かしている間の手元の角度（無ければ null） */
  liveAngle: number | null;
  disabled: boolean;
  /** 表示の領域の大きさ（省略時は自分の要素を測る） */
  viewport?: DevelopSize;
  /** 写真の長辺を画面で何 px までにするか（canvas の画素を超えて引き伸ばさない。省略時は領域いっぱい） */
  maxLongEdge?: number;
  onCommit: (geometry: DevelopGeometry) => void;
  /** 枠全体を描いた canvas（写真の場所いっぱいに置く） */
  children: ReactNode;
}) {
  const { geometry, source, disabled } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = useState<DevelopSize | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  /** キーボードで動かしている途中（キーを離したら確定する） */
  const keyboardRef = useRef(false);

  const measuredByParent = props.viewport !== undefined;
  useLayoutEffect(() => {
    if (measuredByParent) return;
    const element = rootRef.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setMeasured((current) => (current && current.width === next.width && current.height === next.height ? current : next));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measuredByParent]);

  const frame = developFrameSize(source, geometry.rotate);
  const geometryKey = JSON.stringify(geometry);
  const committedBox = editingCropBox(geometry, frame);
  const liveAngle = props.liveAngle;
  // 角度補正を動かしている間は、その角度にしたときの幾何（切り抜きの箱も付いてくる）を見せる
  const shown = liveAngle === null ? geometry : setGeometryAngle(geometry, liveAngle, frame);
  const angle = shown.angle;
  // 確定済みの幾何が変わった（取り消しなど）ら、動かしている途中の箱は捨てる
  const activeDraft = liveAngle === null && draft !== null && draft.geometryKey === geometryKey ? draft : null;
  const box = activeDraft ? activeDraft.box : liveAngle === null ? committedBox : editingCropBox(shown, frame);
  const viewport = props.viewport ?? measured;
  const layout = viewport ? cropOverlayLayout({ frame, box, angle, viewport, maxLongEdge: props.maxLongEdge }) : null;
  const interactive = !disabled && liveAngle === null && layout !== null;
  const showGrid = activeDraft !== null || liveAngle !== null;
  const outputSize = cropOutputSize(committedBox);

  const setDraftBox = (next: CropBox | null) => {
    const value = next ? { box: next, geometryKey } : null;
    draftRef.current = value;
    setDraft(value);
  };

  /** 動かしている途中の箱を確定する（変わっていなければ何もしない）。 */
  const commitDraft = () => {
    const current = draftRef.current;
    setDraftBox(null);
    if (!current || current.geometryKey !== geometryKey || sameBox(current.box, committedBox)) return;
    props.onCommit(geometryWithCropBox(geometry, current.box, frame));
  };

  const startGesture = (event: ReactPointerEvent<HTMLElement>, target: "move" | CropHandle) => {
    if (!interactive || !layout || gestureRef.current || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    keyboardRef.current = false;
    gestureRef.current = {
      target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startBox: box,
      scale: layout.scale,
    };
    setDraftBox(box);
  };

  const moveGesture = (event: ReactPointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    // 画面の動き（枠がまっすぐ立って見える向き＝切り抜きの自分の軸）を、枠の画素に直す
    const dx = (event.clientX - gesture.startX) / gesture.scale;
    const dy = (event.clientY - gesture.startY) / gesture.scale;
    if (gesture.target === "move") {
      const [frameDx, frameDy] = cropScreenToFrameDelta(dx, dy, angle);
      setDraftBox(moveCropBox(gesture.startBox, frameDx, frameDy, angle, frame));
      return;
    }
    setDraftBox(
      resizeCropBox(gesture.startBox, gesture.target, dx, dy, angle, frame, developAspectRatio(geometry.aspect, frame)),
    );
  };

  const endGesture = (event: ReactPointerEvent<HTMLElement>, commit: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (commit) commitDraft();
    else setDraftBox(null);
  };

  /** 矢印キーで動かす（`target` が `move` なら枠を移動、つまみなら伸縮）。確定はキーを離したとき。 */
  const nudge = (event: ReactKeyboardEvent<HTMLElement>, target: "move" | CropHandle) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const direction = cropArrowDirection(event.key);
    if (!direction) return;
    // 矢印は枠・つまみのもの（写真の切り替えなど、面のキーに渡さない）
    event.preventDefault();
    event.stopPropagation();
    if (disabled || liveAngle !== null || gestureRef.current) return;
    const step = cropKeyboardStep(frame, event.shiftKey);
    const dx = direction[0] * step;
    const dy = direction[1] * step;
    const pending = draftRef.current;
    const current = pending && pending.geometryKey === geometryKey ? pending.box : committedBox;
    keyboardRef.current = true;
    if (target === "move") {
      const [frameDx, frameDy] = cropScreenToFrameDelta(dx, dy, angle);
      setDraftBox(moveCropBox(current, frameDx, frameDy, angle, frame));
      return;
    }
    setDraftBox(resizeCropBox(current, target, dx, dy, angle, frame, developAspectRatio(geometry.aspect, frame)));
  };

  const finishKeyboard = () => {
    if (!keyboardRef.current) return;
    keyboardRef.current = false;
    commitDraft();
  };

  const releaseKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (cropArrowDirection(event.key)) finishKeyboard();
  };

  const boxRect = layout?.box ?? null;
  return (
    <div ref={rootRef} data-testid="photo-crop-overlay" className="absolute inset-0 select-none overflow-hidden">
      <div
        data-testid="photo-crop-photo"
        className="absolute"
        style={
          layout
            ? { ...rectStyle(layout.photo.left, layout.photo.top, layout.photo.width, layout.photo.height), transform: `rotate(${layout.rotate}deg)` }
            : rectStyle(0, 0, 0, 0)
        }
      >
        {props.children}
      </div>
      {boxRect ? (
        <>
          <div aria-hidden data-testid="photo-crop-shade" className={SHADE_CLASS_NAME} style={shadeStyle(boxRect)} />
          <div
            role="group"
            aria-label={PHOTO_EDITING_CROP_FRAME_LABEL}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? -1 : 0}
            data-dragging={activeDraft !== null || undefined}
            className={cn(
              "absolute touch-none border border-niho-surface outline outline-1 outline-niho-text/40 focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
              interactive ? "cursor-move" : null,
            )}
            style={rectStyle(boxRect.left, boxRect.top, boxRect.width, boxRect.height)}
            onPointerDown={(event) => startGesture(event, "move")}
            onPointerMove={moveGesture}
            onPointerUp={(event) => endGesture(event, true)}
            onPointerCancel={(event) => endGesture(event, false)}
            onLostPointerCapture={(event) => endGesture(event, false)}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget) nudge(event, "move");
            }}
            onKeyUp={releaseKey}
            onBlur={finishKeyboard}
          >
            {showGrid ? (
              <div aria-hidden data-testid="photo-crop-grid" className="pointer-events-none absolute inset-0">
                <span className={cn(GRID_LINE_CLASS_NAME, "inset-y-0 left-1/3 w-px")} />
                <span className={cn(GRID_LINE_CLASS_NAME, "inset-y-0 left-2/3 w-px")} />
                <span className={cn(GRID_LINE_CLASS_NAME, "inset-x-0 top-1/3 h-px")} />
                <span className={cn(GRID_LINE_CLASS_NAME, "inset-x-0 top-2/3 h-px")} />
              </div>
            ) : null}
            {HANDLES.map(({ handle, x, y }) => (
              <button
                key={handle}
                type="button"
                aria-label={PHOTO_EDITING_CROP_HANDLE_LABELS[handle]}
                disabled={disabled}
                data-crop-handle={handle}
                className={cn(
                  "absolute h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
                  // 小さな枠では角のつまみを辺のつまみより上に置く
                  handle.length === 2 ? "z-[2]" : "z-[1]",
                  HANDLE_CURSOR_CLASS_NAMES[handle],
                )}
                style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
                onPointerDown={(event) => startGesture(event, handle)}
                onKeyDown={(event) => nudge(event, handle)}
              >
                <span aria-hidden className={cn("pointer-events-none absolute drop-shadow-sm", HANDLE_MARK_CLASS_NAMES[handle])} />
              </button>
            ))}
          </div>
        </>
      ) : null}
      <p aria-live="polite" data-testid="photo-crop-size" className="sr-only">
        {photoEditingCropSizeText(outputSize.width, outputSize.height)}
      </p>
    </div>
  );
}
