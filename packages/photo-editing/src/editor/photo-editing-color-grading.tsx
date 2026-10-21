"use client";

import { useCallback, useId, useMemo, useState, type CSSProperties } from "react";

import { formatSignedInteger } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_COLOR_GRADING_AXIS_LABELS,
  PHOTO_EDITING_COLOR_GRADING_BALANCE_LABEL,
  PHOTO_EDITING_COLOR_GRADING_BLENDING_LABEL,
  PHOTO_EDITING_COLOR_GRADING_RESET_LABEL,
  PHOTO_EDITING_COLOR_GRADING_TITLE,
  PHOTO_EDITING_COLOR_GRADING_ZONE_EDITED_TEXT,
  PHOTO_EDITING_COLOR_GRADING_ZONE_LABELS,
  PHOTO_EDITING_COLOR_GRADING_ZONES_LABEL,
  PHOTO_EDITING_RESET_LABEL,
  photoEditingColorGradingSlidersLabel,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING,
  PHOTO_EDITING_COLOR_GRADING_RANGES,
  PHOTO_EDITING_COLOR_GRADING_ZONES,
  hasPhotoEditingColorGradingEdits,
  hasPhotoEditingColorGradingZoneEdits,
  photoEditingColorGradingHueColor,
  readPhotoEditingColorGrading,
  resetPhotoEditingColorGrading,
  writePhotoEditingColorGradingScalar,
  writePhotoEditingColorGradingZone,
  type PhotoEditingColorGradingAxis,
  type PhotoEditingColorGradingScalar,
  type PhotoEditingColorGradingZone,
} from "../photo-editing-color-grading";
import type { PhotoEditingSettings } from "../photo-editing-types";

import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME, PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";
import { PhotoEditingColorWheel, type PhotoEditingColorWheelValue } from "./photo-editing-color-wheel";
import { PhotoEditingSlider } from "./photo-editing-slider";

/** 線の背景に、スライダーを包む要素の `--photo-editing-grading-track` を敷く（カラーミキサーの色の帯と同じ作り）。 */
const TRACK_CLASS_NAME =
  "[&::-webkit-slider-runnable-track]:bg-[image:var(--photo-editing-grading-track)] [&::-moz-range-track]:bg-[image:var(--photo-editing-grading-track)]";

/** 色相の線: 0〜359 の環の色（エンジンが乗せる色の向き。30° ごと）。 */
const HUE_TRACK = `linear-gradient(90deg,${Array.from({ length: 13 }, (_, index) => photoEditingColorGradingHueColor(index * 30)).join(",")})`;
/** 輝度の線: 暗い → 明るい。 */
const LUMINANCE_TRACK = "linear-gradient(90deg,rgb(20 20 20),rgb(128 128 128),rgb(240 240 240))";

/**
 * 帯の 4 択（見た目の高さ 32px、押せる範囲は上下に広げて 44px）。PC の右パネル（15.5rem）と 370px 未満の幅は 2 × 2、スマホの段は
 * 1 行。「調整あり」の点は角に置き、ボタンの幅を変えない
 */
const ZONE_BUTTON_CLASS_NAME =
  "relative inline-flex h-8 min-w-0 items-center justify-center whitespace-nowrap rounded-lg border border-niho-border px-1 text-xs font-bold text-niho-text-sub transition after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-pressed:border-transparent aria-pressed:bg-niho-accent-soft aria-pressed:text-niho-accent-ink";

type ColorGradingProps = {
  /** 編集中の `developSettings`（値は `colorGrading`） */
  settings: PhotoEditingSettings;
  /** 色相環・スライダー・「初期化」を押せない（閲覧のみ・操作の途中など。帯の 4 択は見るだけなので押せる） */
  disabled: boolean;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
};

function ResetButton(props: ColorGradingProps) {
  const canReset = !props.disabled && hasPhotoEditingColorGradingEdits(props.settings);
  const onSettingsChange = props.onSettingsChange;
  return (
    <button
      type="button"
      aria-label={PHOTO_EDITING_COLOR_GRADING_RESET_LABEL}
      disabled={!canReset}
      onClick={() => onSettingsChange(resetPhotoEditingColorGrading, "commit")}
      className={PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME}
    >
      {PHOTO_EDITING_RESET_LABEL}
    </button>
  );
}

type SliderSpec = {
  key: PhotoEditingColorGradingAxis | PhotoEditingColorGradingScalar;
  label: string;
  value: number;
  /** ダブルクリックで戻す値（既定値） */
  defaultValue: number;
  valueText: string;
  track?: string;
  write: (current: PhotoEditingSettings, value: number) => PhotoEditingSettings;
};

/**
 * カラーグレーディング（niho-photo#39）の中身。PC の右パネルの節とスマホの編集の層の道具が同じものを使う（1 つの縦の並び。Issue の
 * 「狭い幅は 3 つを縦に並べる」は、縦に 3 つの環を並べると段の高さに収まらないので、狭い幅でもこの 4 択の切り替えで満たす）。
 *
 * - 上に帯の 4 択（シャドウ / 中間調 / ハイライト / 全体）。既定でない値がある帯のボタンには小さな点（読み上げは「調整あり」）
 * - 選んだ帯の色相環（ドラッグで色相と彩度）と、その下に色相・彩度・輝度のスライダー（数値の入力と読み上げの正）
 * - 最下段にブレンド・バランス（4 つの帯に共通）
 * - スライダーはドラッグの間 `drag`・離して `commit`、ダブルクリックで既定値。色相環も同じ（{@link PhotoEditingColorWheel}）
 * - `reset` を渡した面（スマホの道具）だけ、色相環の右上に「初期化」を置く（PC は節の見出しの横）。`compact` は環を少し小さくする
 */
export function PhotoEditingColorGrading(props: ColorGradingProps & { reset?: boolean; compact?: boolean }) {
  const { settings, disabled, onSettingsChange } = props;
  const [zone, setZone] = useState<PhotoEditingColorGradingZone>("shadow");
  const idPrefix = useId();
  const values = useMemo(() => readPhotoEditingColorGrading(settings), [settings]);
  const band = values[zone];
  const zoneLabel = PHOTO_EDITING_COLOR_GRADING_ZONE_LABELS[zone];

  const onWheelChange = useCallback(
    (next: PhotoEditingColorWheelValue, phase: PhotoEditingSliderPhase) =>
      onSettingsChange((current) => writePhotoEditingColorGradingZone(current, zone, next), phase),
    [onSettingsChange, zone],
  );

  const zoneSliders: SliderSpec[] = [
    {
      key: "hue",
      label: PHOTO_EDITING_COLOR_GRADING_AXIS_LABELS.hue,
      value: band.hue,
      defaultValue: 0,
      valueText: `${band.hue}°`,
      track: HUE_TRACK,
      write: (current, value) => writePhotoEditingColorGradingZone(current, zone, { hue: value }),
    },
    {
      key: "saturation",
      label: PHOTO_EDITING_COLOR_GRADING_AXIS_LABELS.saturation,
      value: band.saturation,
      defaultValue: 0,
      valueText: String(band.saturation),
      track: `linear-gradient(90deg,rgb(255 255 255),${photoEditingColorGradingHueColor(band.hue)})`,
      write: (current, value) => writePhotoEditingColorGradingZone(current, zone, { saturation: value }),
    },
    {
      key: "luminance",
      label: PHOTO_EDITING_COLOR_GRADING_AXIS_LABELS.luminance,
      value: band.luminance,
      defaultValue: 0,
      valueText: formatSignedInteger(band.luminance),
      track: LUMINANCE_TRACK,
      write: (current, value) => writePhotoEditingColorGradingZone(current, zone, { luminance: value }),
    },
  ];
  const sharedSliders: SliderSpec[] = [
    {
      key: "blending",
      label: PHOTO_EDITING_COLOR_GRADING_BLENDING_LABEL,
      value: values.blending,
      defaultValue: PHOTO_EDITING_COLOR_GRADING_DEFAULT_BLENDING,
      valueText: String(values.blending),
      write: (current, value) => writePhotoEditingColorGradingScalar(current, "blending", value),
    },
    {
      key: "balance",
      label: PHOTO_EDITING_COLOR_GRADING_BALANCE_LABEL,
      value: values.balance,
      defaultValue: 0,
      valueText: formatSignedInteger(values.balance),
      write: (current, value) => writePhotoEditingColorGradingScalar(current, "balance", value),
    },
  ];

  const renderSlider = (spec: SliderSpec, scope: string) => {
    const range = PHOTO_EDITING_COLOR_GRADING_RANGES[spec.key];
    const slider = (
      <PhotoEditingSlider
        id={`${idPrefix}-grading-${scope}-${spec.key}`}
        label={spec.label}
        min={range.min}
        max={range.max}
        step={1}
        value={spec.value}
        valueText={spec.valueText}
        disabled={disabled}
        onChange={(next, phase) => onSettingsChange((current) => spec.write(current, next), phase)}
        onReset={() => onSettingsChange((current) => spec.write(current, spec.defaultValue), "commit")}
        changed={spec.value !== spec.defaultValue}
        trackClassName={spec.track ? TRACK_CLASS_NAME : undefined}
      />
    );
    return (
      // 帯を替えたら別のスライダーとして作り直す（入力の途中の状態を、別の帯の値に持ち越さない）
      <div
        key={`${scope}-${spec.key}`}
        data-color-grading-slider={spec.key}
        style={spec.track ? ({ "--photo-editing-grading-track": spec.track } as CSSProperties) : undefined}
      >
        {slider}
      </div>
    );
  };

  return (
    <div data-testid="photo-color-grading">
      <div className="pb-1.5 pt-0.5">
        <div
          role="group"
          aria-label={PHOTO_EDITING_COLOR_GRADING_ZONES_LABEL}
          className="grid grid-cols-2 gap-1 min-[370px]:grid-cols-4 lg:grid-cols-2"
        >
          {PHOTO_EDITING_COLOR_GRADING_ZONES.map((item) => {
            const edited = hasPhotoEditingColorGradingZoneEdits(values, item);
            return (
              <button
                key={item}
                type="button"
                aria-pressed={item === zone}
                data-color-grading-zone={item}
                onClick={() => setZone(item)}
                className={ZONE_BUTTON_CLASS_NAME}
              >
                {PHOTO_EDITING_COLOR_GRADING_ZONE_LABELS[item]}
                {edited ? (
                  <>
                    <span
                      aria-hidden
                      data-testid="photo-color-grading-zone-edited"
                      className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-current"
                    />
                    <span className="sr-only">{PHOTO_EDITING_COLOR_GRADING_ZONE_EDITED_TEXT}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      <div className="relative py-2">
        <PhotoEditingColorWheel
          zoneLabel={zoneLabel}
          hue={band.hue}
          saturation={band.saturation}
          disabled={disabled}
          compact={props.compact}
          onChange={onWheelChange}
        />
        {/* スマホの道具の「初期化」は、色相環の右上の空いたところ（4 択の幅を削らない） */}
        {props.reset ? (
          <div className="absolute right-0 top-2">
            <ResetButton settings={settings} disabled={disabled} onSettingsChange={onSettingsChange} />
          </div>
        ) : null}
      </div>
      <div role="group" aria-label={photoEditingColorGradingSlidersLabel(zoneLabel)}>
        {zoneSliders.map((spec) => renderSlider(spec, zone))}
      </div>
      <div className="mt-1 border-t border-niho-border pt-1">{sharedSliders.map((spec) => renderSlider(spec, "shared"))}</div>
    </div>
  );
}

/**
 * カラーミキサーの下の「カラーグレーディング」の節（niho-photo#39。既定は閉じる。開閉は端末に覚える）。見出しの横の「初期化」は
 * 4 つの帯の値とブレンド・バランスだけを既定に戻して `commit` する（取り消しの 1 単位。どれも既定・押せない間は押せない表示）。
 */
export function PhotoEditingColorGradingSection(props: ColorGradingProps) {
  return (
    <PhotoEditingAdvancedSection
      id="colorGrading"
      title={PHOTO_EDITING_COLOR_GRADING_TITLE}
      accessory={<ResetButton {...props} />}
    >
      <PhotoEditingColorGrading {...props} />
    </PhotoEditingAdvancedSection>
  );
}
