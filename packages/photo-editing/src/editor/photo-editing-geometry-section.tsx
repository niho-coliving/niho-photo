"use client";

import { useId, type ReactNode } from "react";

import {
  developGeometryPerspective,
  hasGeometryPerspectiveEdits,
  resetGeometryPerspective,
  type DevelopGeometry,
  type DevelopPerspective,
} from "../develop-engine/develop-geometry";
import { DEVELOP_PERSPECTIVE_FIELDS, type DevelopPerspectiveKey } from "../develop-engine/develop-perspective";
import {
  PHOTO_EDITING_GEOMETRY_CONSTRAIN_HINT,
  PHOTO_EDITING_GEOMETRY_CONSTRAIN_LABEL,
  PHOTO_EDITING_GEOMETRY_LABELS,
  PHOTO_EDITING_GEOMETRY_RESET_LABEL,
  PHOTO_EDITING_GEOMETRY_TITLE,
  PHOTO_EDITING_RESET_LABEL,
} from "../photo-editing-copy";

import { AdjustmentSwitch } from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME, PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";
import { PhotoEditingSlider, type PhotoEditingSliderPhase } from "./photo-editing-slider";

/** 幾何を今の幾何から作り直す関数（`drag` の間は描き直すだけ、`commit` で取り消しの 1 単位）。 */
export type PhotoEditingGeometryChange = (
  update: (current: DevelopGeometry) => DevelopGeometry,
  phase: PhotoEditingSliderPhase,
) => void;

/** スライダーの刻み（Lightroom と同じ: 回転と X・Y オフセットは 0.1、ほかは 1）。 */
const STEPS: Readonly<Record<DevelopPerspectiveKey, number>> = {
  vertical: 1,
  horizontal: 1,
  rotate: 0.1,
  aspect: 1,
  scale: 1,
  x: 0.1,
  y: 0.1,
};

/** 範囲外・数でない保存値は、表示のために範囲に収めて読む（保存値は書き換えない）。 */
function shownValue(value: number, min: number, max: number, neutral: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : neutral;
}

/** 表示の値（「+12」「0」「-3.5」。回転は「°」、拡大・縮小は「%」を付ける）。 */
export function formatGeometryValue(key: DevelopPerspectiveKey, value: number): string {
  const decimals = STEPS[key] < 1 ? 1 : 0;
  const rounded = Number(value.toFixed(decimals));
  if (key === "scale") return `${rounded.toFixed(decimals)}%`;
  const text = rounded === 0 ? (0).toFixed(decimals) : `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(decimals)}`;
  return key === "rotate" ? `${text}°` : text;
}

function withField(geometry: DevelopGeometry, key: DevelopPerspectiveKey, value: number): DevelopGeometry {
  const perspective: DevelopPerspective = { ...developGeometryPerspective(geometry), [key]: value };
  return { ...geometry, perspective };
}

/**
 * 切り抜きの道具の「ジオメトリ」の節（niho-photo#46。Lightroom の切り抜きパネルの中の変形。既定は閉じる。開閉は端末に覚える）。
 *
 * - 遠近の 7 本のスライダー（垂直方向・水平方向・回転・縦横比・拡大・縮小・X / Y オフセット。範囲・単位は XMP の `Perspective*`
 *   どおり）。ドラッグの間は `drag`、離したら `commit`（取り消しの 1 単位）。ダブルクリックで既定値（拡大・縮小は 100%、ほかは 0）
 * - 「余白を埋める」のスイッチ（補正で空いた余白が写らないよう、切り抜きを写真の中に収める）
 * - 見出しの横の「初期化」は遠近と「余白を埋める」と Upright だけを既定に戻す（角度・反転・回転・切り抜きは触らない）
 * - `leading` は節の先頭に差し込む要素（後半で足す Upright の 自動 / 水平 / 垂直 / フル のボタンの置き場）
 */
export function PhotoEditingGeometrySection(props: {
  geometry: DevelopGeometry;
  disabled: boolean;
  onChange: PhotoEditingGeometryChange;
  leading?: ReactNode;
}) {
  const { geometry, disabled, onChange } = props;
  const idPrefix = useId();
  const perspective = developGeometryPerspective(geometry);
  return (
    <PhotoEditingAdvancedSection
      id="geometry"
      title={PHOTO_EDITING_GEOMETRY_TITLE}
      accessory={
        <button
          type="button"
          aria-label={PHOTO_EDITING_GEOMETRY_RESET_LABEL}
          disabled={disabled || !hasGeometryPerspectiveEdits(geometry)}
          onClick={() => onChange(resetGeometryPerspective, "commit")}
          className={PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME}
        >
          {PHOTO_EDITING_RESET_LABEL}
        </button>
      }
    >
      <div data-testid="photo-geometry-section">
        {props.leading}
        {DEVELOP_PERSPECTIVE_FIELDS.map(({ key, min, max, neutral }) => {
          const value = shownValue(perspective[key], min, max, neutral);
          return (
            <div key={key} data-geometry-field={key}>
              <PhotoEditingSlider
                id={`${idPrefix}-geometry-${key}`}
                label={PHOTO_EDITING_GEOMETRY_LABELS[key]}
                min={min}
                max={max}
                step={STEPS[key]}
                value={value}
                valueText={formatGeometryValue(key, value)}
                disabled={disabled}
                changed={value !== neutral}
                onChange={(next, phase) => onChange((current) => withField(current, key, next), phase)}
                onReset={() => onChange((current) => withField(current, key, neutral), "commit")}
              />
            </div>
          );
        })}
        <div className="mt-1">
          <AdjustmentSwitch
            id={`${idPrefix}-geometry-constrain`}
            label={PHOTO_EDITING_GEOMETRY_CONSTRAIN_LABEL}
            checked={geometry.constrain === true}
            disabled={disabled}
            onChange={(checked) => onChange((current) => ({ ...current, constrain: checked }), "commit")}
          />
          <p className="pb-1 text-xs leading-relaxed text-niho-text-sub">{PHOTO_EDITING_GEOMETRY_CONSTRAIN_HINT}</p>
        </div>
      </div>
    </PhotoEditingAdvancedSection>
  );
}
