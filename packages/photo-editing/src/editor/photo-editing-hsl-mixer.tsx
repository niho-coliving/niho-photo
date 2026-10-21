"use client";

import { useId, useMemo, useState, type CSSProperties } from "react";

import { formatSignedInteger } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_HSL_AXES_LABEL,
  PHOTO_EDITING_HSL_AXIS_EDITED_TEXT,
  PHOTO_EDITING_HSL_AXIS_LABELS,
  PHOTO_EDITING_HSL_BAND_LABELS,
  PHOTO_EDITING_HSL_RESET_LABEL,
  PHOTO_EDITING_HSL_TITLE,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingHslSlidersLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_HSL_AXES,
  PHOTO_EDITING_HSL_BANDS,
  PHOTO_EDITING_HSL_MAX,
  PHOTO_EDITING_HSL_MIN,
  PHOTO_EDITING_HSL_STEP,
  hasPhotoEditingHslAxisEdits,
  hasPhotoEditingHslEdits,
  readPhotoEditingHsl,
  resetPhotoEditingHsl,
  writePhotoEditingHsl,
  type PhotoEditingHslAxis,
  type PhotoEditingHslBand,
} from "../photo-editing-hsl";
import type { PhotoEditingSettings } from "../photo-editing-types";

import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME, PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";
import { PhotoEditingSlider } from "./photo-editing-slider";

/**
 * 8 色の見本の色相（CSS の `hsl()` の角度。Lightroom のカラーミキサーの丸と同じ並びの見た目）。テーマの token には「その色そのもの」
 * の色が無いので、丸と線の色の帯の色はここ 1 か所でこの角度から作る（画の計算には使わない。エンジンの色の境目は crate の
 * `HSL_CENTERS`）。
 */
const BAND_HUES: Readonly<Record<PhotoEditingHslBand, number>> = {
  red: 0,
  orange: 30,
  yellow: 55,
  green: 120,
  aqua: 180,
  blue: 220,
  purple: 270,
  magenta: 315,
};

function swatchColor(hue: number, saturation = 75, lightness = 52): string {
  const angle = ((hue % 360) + 360) % 360;
  return `hsl(${angle} ${saturation}% ${lightness}%)`;
}

/** 隣の色との真ん中の色相（`direction` が 1 なら次の色、-1 なら前の色の側）。 */
function neighborHue(band: PhotoEditingHslBand, direction: 1 | -1): number {
  const bands = PHOTO_EDITING_HSL_BANDS;
  const index = bands.indexOf(band);
  const neighbor = bands[(index + direction + bands.length) % bands.length];
  const hue = BAND_HUES[band];
  const gap = (((BAND_HUES[neighbor] - hue) * direction) % 360 + 360) % 360;
  return hue + (direction * gap) / 2;
}

/**
 * 線の色の帯（Lightroom と同じ）: 色相は前の色の側 → その色 → 次の色の側（+ で次の色へ回す）、彩度は灰 → その色 → 濃い色、輝度は
 * 暗い色 → その色 → 明るい色。
 */
function trackGradient(band: PhotoEditingHslBand, axis: PhotoEditingHslAxis): string {
  const hue = BAND_HUES[band];
  const stops =
    axis === "hue"
      ? [swatchColor(neighborHue(band, -1)), swatchColor(hue), swatchColor(neighborHue(band, 1))]
      : axis === "saturation"
        ? [swatchColor(hue, 0, 55), swatchColor(hue, 45, 54), swatchColor(hue, 90, 50)]
        : [swatchColor(hue, 60, 20), swatchColor(hue, 75, 52), swatchColor(hue, 70, 84)];
  return `linear-gradient(90deg,${stops.join(",")})`;
}

/** 線の背景に、スライダーを包む要素の `--photo-editing-hsl-track`（{@link trackGradient}）を敷く。 */
const TRACK_CLASS_NAME =
  "[&::-webkit-slider-runnable-track]:bg-[image:var(--photo-editing-hsl-track)] [&::-moz-range-track]:bg-[image:var(--photo-editing-hsl-track)]";

/** 「調整」の切り替え（見た目の高さ 32px、押せる範囲は上下に広げて 44px） */
const AXIS_BUTTON_CLASS_NAME =
  "relative inline-flex h-8 min-w-0 items-center justify-center gap-1 rounded-lg border border-niho-border px-2 text-xs font-bold text-niho-text-sub transition after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-pressed:border-transparent aria-pressed:bg-niho-accent-soft aria-pressed:text-niho-accent-ink";

type HslMixerProps = {
  /** 編集中の `developSettings`（値は `hsl`） */
  settings: PhotoEditingSettings;
  /** スライダー・「初期化」を押せない（閲覧のみ・操作の途中など。「調整」の切り替えは見るだけなので押せる） */
  disabled: boolean;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
};

function ResetButton(props: HslMixerProps) {
  const canReset = !props.disabled && hasPhotoEditingHslEdits(props.settings);
  const onSettingsChange = props.onSettingsChange;
  return (
    <button
      type="button"
      aria-label={PHOTO_EDITING_HSL_RESET_LABEL}
      disabled={!canReset}
      onClick={() => onSettingsChange(resetPhotoEditingHsl, "commit")}
      className={PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME}
    >
      {PHOTO_EDITING_RESET_LABEL}
    </button>
  );
}

/**
 * カラーミキサー（HSL。niho-photo#38）の中身。PC の右パネルの節とスマホの編集の層の道具が同じものを使う（1 つの縦の並び）。
 *
 * - 上に「調整」の切り替え（色相 / 彩度 / 輝度）。その軸に 0 でない色があるボタンには小さな点（読み上げは「調整あり」）
 * - 下に 8 色のスライダーを縦に（赤 → マゼンタ）。名前は色の名前で、左に色の丸（飾り）。線には軸ごとの色の帯。値は -100〜100
 *   （既定 0。ダブルクリックで 0）で、0 でない値は「変更あり」の目印。ドラッグの間は `drag`、離したら `commit`（スライダーの部品のまま）
 * - `reset` を渡した面（スマホの道具）だけ、切り替えの右に「初期化」を置く（PC は節の見出しの横）
 * - 写真の上を押して色を選ぶ操作（Lightroom のターゲット調整）は第 2 段（ここには無い）
 */
export function PhotoEditingHslMixer(props: HslMixerProps & { reset?: boolean }) {
  const { settings, disabled, onSettingsChange } = props;
  const [axis, setAxis] = useState<PhotoEditingHslAxis>("hue");
  const idPrefix = useId();
  const values = useMemo(() => readPhotoEditingHsl(settings), [settings]);

  return (
    <div data-testid="photo-hsl-mixer">
      <div className="flex items-center gap-1 pb-1.5 pt-0.5">
        <div role="group" aria-label={PHOTO_EDITING_HSL_AXES_LABEL} className="grid min-w-0 flex-1 grid-cols-3 gap-1">
          {PHOTO_EDITING_HSL_AXES.map((item) => {
            const edited = hasPhotoEditingHslAxisEdits(values, item);
            return (
              <button
                key={item}
                type="button"
                aria-pressed={item === axis}
                data-hsl-axis={item}
                onClick={() => setAxis(item)}
                className={AXIS_BUTTON_CLASS_NAME}
              >
                {PHOTO_EDITING_HSL_AXIS_LABELS[item]}
                {edited ? (
                  <>
                    <span aria-hidden data-testid="photo-hsl-axis-edited" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
                    <span className="sr-only">{PHOTO_EDITING_HSL_AXIS_EDITED_TEXT}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
        {props.reset ? (
          <div className="shrink-0">
            <ResetButton settings={settings} disabled={disabled} onSettingsChange={onSettingsChange} />
          </div>
        ) : null}
      </div>
      <div role="group" aria-label={photoEditingHslSlidersLabel(PHOTO_EDITING_HSL_AXIS_LABELS[axis])}>
        {PHOTO_EDITING_HSL_BANDS.map((band) => {
          const value = values[band][axis];
          return (
            // 軸を替えたら別のスライダーとして作り直す（入力の途中の状態を、別の軸の値に持ち越さない）
            <div
              key={`${axis}-${band}`}
              data-hsl-band={band}
              style={{ "--photo-editing-hsl-track": trackGradient(band, axis) } as CSSProperties}
            >
              <PhotoEditingSlider
                id={`${idPrefix}-hsl-${axis}-${band}`}
                label={PHOTO_EDITING_HSL_BAND_LABELS[band]}
                labelPrefix={
                  <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: swatchColor(BAND_HUES[band]) }} />
                }
                min={PHOTO_EDITING_HSL_MIN}
                max={PHOTO_EDITING_HSL_MAX}
                step={PHOTO_EDITING_HSL_STEP}
                value={value}
                valueText={formatSignedInteger(value)}
                disabled={disabled}
                onChange={(next, phase) => onSettingsChange((current) => writePhotoEditingHsl(current, band, axis, next), phase)}
                onReset={() => onSettingsChange((current) => writePhotoEditingHsl(current, band, axis, 0), "commit")}
                changed={value !== 0}
                trackClassName={TRACK_CLASS_NAME}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * カラーの群の下の「カラーミキサー」の節（niho-photo#38。既定は閉じる。開閉は端末に覚える）。見出しの横の「初期化」は 8 色 × 3 の
 * 値だけを 0 に戻して `commit` する（取り消しの 1 単位。どれも 0・押せない間は押せない表示）。
 */
export function PhotoEditingHslMixerSection(props: HslMixerProps) {
  return (
    <PhotoEditingAdvancedSection id="colorMixer" title={PHOTO_EDITING_HSL_TITLE} accessory={<ResetButton {...props} />}>
      <PhotoEditingHslMixer {...props} />
    </PhotoEditingAdvancedSection>
  );
}
