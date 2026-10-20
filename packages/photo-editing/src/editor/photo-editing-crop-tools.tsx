"use client";

import { useId } from "react";
import { ArrowRightLeft, FlipHorizontal2, RotateCw } from "lucide-react";

import {
  developFrameSize,
  flipGeometryHorizontal,
  rotateGeometryClockwise,
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
  PHOTO_EDITING_CROP_FLIP_LABEL,
  PHOTO_EDITING_CROP_ROTATE_LABEL,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingCropExportLimitText,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_CROP_ANGLE_MAX,
  PHOTO_EDITING_CROP_ANGLE_MIN,
  PHOTO_EDITING_CROP_ANGLE_STEP,
  PHOTO_EDITING_CROP_ASPECTS,
  canSwapCropAspect,
  cropAspectOf,
  formatCropAngle,
  isCropAspectSelected,
} from "../photo-editing-crop";
import { cn } from "niho-ui/cn";

import { PhotoEditingSlider, type PhotoEditingSliderPhase } from "./photo-editing-slider";
import { PhotoEditingRuler } from "./photo-editing-ruler";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const CHIP_CLASS_NAME = cn(
  "inline-flex min-h-11 items-center rounded-full border px-3 text-sub font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const ACTION_BUTTON_CLASS_NAME = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-niho-border px-3 text-sub font-bold text-niho-text transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);

/**
 * 切り抜きの道具（NIHO Photo 段 1 F3b 移行元設計）: 縦横比のチップと「縦横の入れ替え」・角度補正のスライダー・「90° 回転」
 * 「左右の反転」・書き出しの大きさの 1 行。右パネルに依存しない独立の部品で、ブラウザの面の右パネルとスマホの編集面
 * （F6c 移行元設計）が同じものを使う。
 *
 * - 押すたびに新しい幾何を `onCommit` に渡す（取り消しの 1 単位。保存と履歴は呼ぶ側）。「完了」のボタンは置かない
 * - 角度補正は、つまみを動かしている間は手元の角度だけを `onLiveAngleChange` に知らせ（枠の部品が写真を回してグリッドを出す）、
 *   離したら `setGeometryAngle` の結果を確定する。ダブルクリックで 0、値は直接入力できる
 * - 入れ替えた比率（`5:4`・`originalSwapped`）のときは元のチップを選ばれた表示にし、そのチップを押すと今の向きのまま最大の
 *   箱に置き直す
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
}) {
  const { geometry, source, disabled } = props;
  const headingId = useId();
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

  return (
    <div className="pt-1">
      <div className="flex min-h-11 items-center justify-between gap-2">
        <h4 id={headingId} className="text-xs font-bold text-niho-text-muted">
          {PHOTO_EDITING_CROP_ASPECT_TITLE}
        </h4>
        <button
          type="button"
          aria-label={PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL}
          title={PHOTO_EDITING_CROP_ASPECT_SWAP_LABEL}
          disabled={disabled || !canSwapCropAspect(aspect)}
          onClick={() => props.onCommit(setGeometryAspect(geometry, swapDevelopAspect(aspect), frame))}
          className={cn(
            "-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-sub transition enabled:hover:bg-niho-pale/60 disabled:cursor-not-allowed disabled:opacity-40",
            FOCUS_RING_CLASS_NAME,
          )}
        >
          <ArrowRightLeft className="h-[18px] w-[18px]" aria-hidden />
        </button>
      </div>
      <div role="group" aria-labelledby={headingId} className="flex flex-wrap gap-1.5">
        {PHOTO_EDITING_CROP_ASPECTS.map((chip) => {
          const selected = isCropAspectSelected(aspect, chip.aspect);
          return (
            <button
              key={chip.aspect}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              // 選ばれているチップは、今の向き（入れ替えた比率）のまま置き直す
              onClick={() => props.onCommit(setGeometryAspect(geometry, selected ? aspect : chip.aspect, frame))}
              className={cn(
                CHIP_CLASS_NAME,
                selected
                  ? "border-transparent bg-niho-accent-soft text-niho-accent-ink"
                  : "border-niho-border text-niho-text enabled:hover:bg-niho-pale/60",
              )}
            >
              {chip.label}
            </button>
          );
        })}
      </div>
      <div className="mt-4">
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
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => props.onCommit(rotateGeometryClockwise(geometry, source))}
          className={ACTION_BUTTON_CLASS_NAME}
        >
          <RotateCw className="h-4 w-4 shrink-0" aria-hidden />
          {PHOTO_EDITING_CROP_ROTATE_LABEL}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => props.onCommit(flipGeometryHorizontal(geometry, source))}
          className={ACTION_BUTTON_CLASS_NAME}
        >
          <FlipHorizontal2 className="h-4 w-4 shrink-0" aria-hidden />
          {PHOTO_EDITING_CROP_FLIP_LABEL}
        </button>
      </div>
      {props.exportLongEdge !== null ? (
        <p className="mt-3 text-xs leading-relaxed text-niho-text-sub">{photoEditingCropExportLimitText(props.exportLongEdge)}</p>
      ) : null}
    </div>
  );
}
