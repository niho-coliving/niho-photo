"use client";

import { useId } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  FlipHorizontal2,
  RotateCcw,
  RotateCw,
  TrianglesCenterlineDashedHorizontal,
  TrianglesCenterlineDashedVertical,
} from "lucide-react";

import {
  developFrameSize,
  flipGeometryHorizontal,
  flipGeometryVertical,
  rotateGeometryClockwise,
  rotateGeometryCounterClockwise,
  setGeometryAngle,
  setGeometryAspect,
  swapDevelopAspect,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";
import {
  PHOTO_EDITING_CROP_ANGLE_LABEL,
  PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL,
  PHOTO_EDITING_CROP_ASPECT_TITLE,
  PHOTO_EDITING_CROP_CANCEL_KEY_HINT,
  PHOTO_EDITING_CROP_CANCEL_LABEL,
  PHOTO_EDITING_CROP_DONE_KEY_HINT,
  PHOTO_EDITING_CROP_DONE_LABEL,
  PHOTO_EDITING_CROP_FLIP_LABEL,
  PHOTO_EDITING_CROP_FLIP_VERTICAL_LABEL,
  PHOTO_EDITING_CROP_ROTATE_LABEL,
  PHOTO_EDITING_CROP_ROTATE_LEFT_LABEL,
  PHOTO_EDITING_CROP_ROTATE_RIGHT_LABEL,
  PHOTO_EDITING_CROP_TRANSFORM_TITLE,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingCropExportLimitText,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_CROP_ANGLE_MAX,
  PHOTO_EDITING_CROP_ANGLE_MIN,
  PHOTO_EDITING_CROP_ANGLE_STEP,
  PHOTO_EDITING_CROP_ASPECTS,
  canSwapCropAspect,
  cropAspectLabel,
  cropAspectOf,
  formatCropAngle,
  isCropAspectSelected,
} from "../photo-editing-crop";
import { cn } from "niho-ui/cn";

import { PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";
import { PhotoEditingMenu, type PhotoEditingMenuItem } from "./photo-editing-menu";
import { PhotoEditingSlider, type PhotoEditingSliderPhase } from "./photo-editing-slider";
import { PhotoEditingRuler } from "./photo-editing-ruler";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";

/**
 * 切り抜きの道具（NIHO Photo 段 1 F3b 移行元設計）。右パネルに依存しない独立の部品で、ブラウザの面の右パネルとスマホの編集面
 * （F6c 移行元設計。`mobile`）が同じものを使う。
 *
 * - PC（Lightroom の並び。#52）: 縦横比の行（今の比率の名前 ▾ のメニューと、右端に「縦横の入れ替え」）→ 角度補正のスライダー →
 *   「反転と回転」の 4 つの icon（左に 90° 回転・右に 90° 回転・左右の反転・上下の反転）→ 書き出しの大きさの 1 行 →［完了］
 *   ［キャンセル］（`onDone` / `onCancel` を渡したときだけ。Enter / Esc は面のキーで同じものを呼ぶ）
 * - スマホ: 縦横比のチップ・入れ替え・90° 回転・左右の反転・「初期化」の帯と、角度補正の目盛り
 * - 押すたびに新しい幾何を `onCommit` に渡す（取り消しの 1 単位。保存と履歴は呼ぶ側）
 * - 角度補正は、つまみを動かしている間は手元の角度だけを `onLiveAngleChange` に知らせ（枠の部品が写真を回してグリッドを出す）、
 *   離したら `setGeometryAngle` の結果を確定する。ダブルクリックで 0、値は直接入力できる
 * - 入れ替えた比率（`5:4`・`originalSwapped`）のときは元の比率を選んでいる表示にし、それを選ぶと今の向きのまま最大の箱に
 *   置き直す
 */
export function PhotoEditingCropTools(props: {
  /** 確定している幾何 */
  geometry: DevelopGeometry;
  /** 作業画像（向きは反映済み・幾何を当てる前）の大きさ */
  source: DevelopSize;
  disabled: boolean;
  /** 角度補正のつまみを動かしている間の手元の角度（無ければ null） */
  liveAngle: number | null;
  /** 書き出しの長辺（切り抜きで 2048px に届かなくなるときだけ。ほかは null） */
  exportLongEdge: number | null;
  onLiveAngleChange: (angle: number | null) => void;
  onCommit: (geometry: DevelopGeometry) => void;
  /** スマホの段 A + movement-based ruler の配置。 */
  mobile?: boolean;
  bandClassName?: string;
  onReset?: () => void;
  /** PC の［完了］（補正へ戻る。幾何は押すたびに確定済み） */
  onDone?: () => void;
  /** PC の［キャンセル］（入ったときの幾何に戻して補正へ戻る） */
  onCancel?: () => void;
}) {
  const { geometry, source, disabled } = props;
  const headingId = useId();
  const aspectValueId = useId();
  const transformId = useId();
  const angleId = useId();
  const frame = developFrameSize(source, geometry.rotate);
  const aspect = cropAspectOf(geometry);
  const angle = props.liveAngle ?? geometry.angle;

  const commitAngle = (value: number) => {
    props.onLiveAngleChange(null);
    if (value === geometry.angle) return;
    props.onCommit(setGeometryAngle(geometry, value, frame));
  };

  const changeAngle = (value: number, phase: PhotoEditingSliderPhase) => {
    if (phase === "commit") commitAngle(value);
    else props.onLiveAngleChange(value);
  };

  if (props.mobile) {
    return (
      <div className={props.bandClassName}>
        <div
          role="toolbar"
          aria-label={PHOTO_EDITING_CROP_ASPECT_TITLE}
          className="flex h-11 items-center gap-1 overflow-x-auto overscroll-x-contain px-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {PHOTO_EDITING_CROP_ASPECTS.map((chip) => {
            const selected = isCropAspectSelected(aspect, chip.aspect);
            return (
              <button
                key={chip.aspect}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => props.onCommit(setGeometryAspect(geometry, selected ? aspect : chip.aspect, frame))}
                className={cn(
                  "inline-flex h-8 min-w-11 shrink-0 items-center justify-center rounded-full px-3 text-sub font-bold",
                  FOCUS_RING_CLASS_NAME,
                  selected ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text-sub",
                )}
              >
                {chip.label}
              </button>
            );
          })}
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-niho-border" />
          {[
            {
              label: PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL,
              disabled: disabled || !canSwapCropAspect(aspect),
              icon: ArrowRightLeft,
              action: () => props.onCommit(setGeometryAspect(geometry, swapDevelopAspect(aspect), frame)),
            },
            {
              label: PHOTO_EDITING_CROP_ROTATE_LABEL,
              disabled,
              icon: RotateCw,
              action: () => props.onCommit(rotateGeometryClockwise(geometry, source)),
            },
            {
              label: PHOTO_EDITING_CROP_FLIP_LABEL,
              disabled,
              icon: FlipHorizontal2,
              action: () => props.onCommit(flipGeometryHorizontal(geometry, source)),
            },
          ].map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.label}
                type="button"
                aria-label={action.label}
                title={action.label}
                disabled={action.disabled}
                onClick={action.action}
                className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub", FOCUS_RING_CLASS_NAME)}
              >
                <Icon className="h-[18px] w-[18px]" aria-hidden />
              </button>
            );
          })}
          {props.onReset ? (
            <button
              type="button"
              disabled={disabled}
              onClick={props.onReset}
              className={cn("inline-flex h-8 min-w-11 shrink-0 items-center rounded-full px-3 text-sub font-bold text-niho-accent-ink", FOCUS_RING_CLASS_NAME)}
            >
              {PHOTO_EDITING_RESET_LABEL}
            </button>
          ) : null}
        </div>
        <PhotoEditingRuler
          id={angleId}
          label={PHOTO_EDITING_CROP_ANGLE_LABEL}
          min={PHOTO_EDITING_CROP_ANGLE_MIN}
          max={PHOTO_EDITING_CROP_ANGLE_MAX}
          step={PHOTO_EDITING_CROP_ANGLE_STEP}
          value={angle}
          valueText={formatCropAngle(angle)}
          disabled={disabled}
          onChange={changeAngle}
          onReset={() => commitAngle(0)}
        />
        {props.exportLongEdge !== null ? (
          <p className="px-3 pb-2 text-xs leading-relaxed text-niho-text-sub">{photoEditingCropExportLimitText(props.exportLongEdge)}</p>
        ) : null}
      </div>
    );
  }

  const aspectItems: PhotoEditingMenuItem[] = PHOTO_EDITING_CROP_ASPECTS.map((chip) => {
    const selected = isCropAspectSelected(aspect, chip.aspect);
    return {
      key: chip.aspect,
      label: chip.label,
      checked: selected,
      // 選んでいる比率は、今の向き（入れ替えた比率）のまま置き直す
      onSelect: () => props.onCommit(setGeometryAspect(geometry, selected ? aspect : chip.aspect, frame)),
    };
  });
  // 反転の icon は形の名前で選ぶ（lucide 1.60 の `FlipHorizontal2` は横の中心線と上下の三角 = 上下の反転の形）
  const transforms = [
    { label: PHOTO_EDITING_CROP_ROTATE_LEFT_LABEL, icon: RotateCcw, next: rotateGeometryCounterClockwise },
    { label: PHOTO_EDITING_CROP_ROTATE_RIGHT_LABEL, icon: RotateCw, next: rotateGeometryClockwise },
    { label: PHOTO_EDITING_CROP_FLIP_LABEL, icon: TrianglesCenterlineDashedVertical, next: flipGeometryHorizontal },
    { label: PHOTO_EDITING_CROP_FLIP_VERTICAL_LABEL, icon: TrianglesCenterlineDashedHorizontal, next: flipGeometryVertical },
  ];

  return (
    <div className="pt-1">
      <div className="flex h-9 items-center gap-2">
        <span id={headingId} className="shrink-0 text-xs font-bold text-niho-text-muted">
          {PHOTO_EDITING_CROP_ASPECT_TITLE}
        </span>
        <PhotoEditingMenu items={aspectItems} variant="browser">
          <button
            type="button"
            aria-haspopup="menu"
            aria-labelledby={`${headingId} ${aspectValueId}`}
            disabled={disabled}
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs font-bold text-niho-text transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-50",
              FOCUS_RING_CLASS_NAME,
            )}
          >
            <span id={aspectValueId} className="truncate">
              {cropAspectLabel(aspect)}
            </span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-niho-text-muted" aria-hidden />
          </button>
        </PhotoEditingMenu>
        <button
          type="button"
          aria-label={PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL}
          title={PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL}
          disabled={disabled || !canSwapCropAspect(aspect)}
          onClick={() => props.onCommit(setGeometryAspect(geometry, swapDevelopAspect(aspect), frame))}
          className={cn(
            "-mr-1 ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-sub transition enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text disabled:cursor-not-allowed disabled:opacity-40",
            FOCUS_RING_CLASS_NAME,
          )}
        >
          <ArrowRightLeft className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="mt-2">
        <PhotoEditingSlider
          id={angleId}
          label={PHOTO_EDITING_CROP_ANGLE_LABEL}
          min={PHOTO_EDITING_CROP_ANGLE_MIN}
          max={PHOTO_EDITING_CROP_ANGLE_MAX}
          step={PHOTO_EDITING_CROP_ANGLE_STEP}
          value={angle}
          valueText={formatCropAngle(angle)}
          disabled={disabled}
          onChange={changeAngle}
          onReset={() => commitAngle(0)}
        />
      </div>
      <h4 id={transformId} className="mt-4 text-xs font-bold text-niho-text-muted">
        {PHOTO_EDITING_CROP_TRANSFORM_TITLE}
      </h4>
      <div role="group" aria-labelledby={transformId} className="mt-2 flex gap-1.5">
        {transforms.map((transform) => {
          const Icon = transform.icon;
          return (
            <button
              key={transform.label}
              type="button"
              aria-label={transform.label}
              title={transform.label}
              disabled={disabled}
              onClick={() => props.onCommit(transform.next(geometry, source))}
              className={cn(
                "flex h-9 w-11 items-center justify-center rounded-lg border border-niho-border bg-white text-niho-text-sub transition enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text disabled:cursor-not-allowed disabled:opacity-50",
                FOCUS_RING_CLASS_NAME,
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          );
        })}
      </div>
      {props.exportLongEdge !== null ? (
        <p className="mt-3 text-xs leading-relaxed text-niho-text-sub">{photoEditingCropExportLimitText(props.exportLongEdge)}</p>
      ) : null}
      {props.onDone || props.onCancel ? (
        <div className="mt-4 flex flex-col gap-1.5">
          {props.onDone ? (
            <button
              type="button"
              aria-keyshortcuts="Enter"
              disabled={disabled}
              onClick={props.onDone}
              className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-9 w-full justify-center rounded-lg")}
            >
              {PHOTO_EDITING_CROP_DONE_LABEL}
              <span aria-hidden className="text-xs opacity-75">
                {PHOTO_EDITING_CROP_DONE_KEY_HINT}
              </span>
            </button>
          ) : null}
          {props.onCancel ? (
            <button
              type="button"
              aria-keyshortcuts="Escape"
              disabled={disabled}
              onClick={props.onCancel}
              onKeyDown={(event) => {
                // この上の Enter は［キャンセル］を押す（面の Enter =［完了］に渡さない）
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                props.onCancel?.();
              }}
              className={cn(
                "inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg text-sub font-bold text-niho-text-sub transition enabled:hover:bg-niho-pale/60 enabled:hover:text-niho-text disabled:cursor-not-allowed disabled:opacity-50",
                FOCUS_RING_CLASS_NAME,
              )}
            >
              {PHOTO_EDITING_CROP_CANCEL_LABEL}
              <span aria-hidden className="text-xs text-niho-text-muted">
                {PHOTO_EDITING_CROP_CANCEL_KEY_HINT}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
