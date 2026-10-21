"use client";

import { useId, useMemo } from "react";

import { formatSignedInteger } from "../photo-editing-adjustments";
import {
  PHOTO_EDITING_LENS_CHROMATIC_ABERRATION_LABEL,
  PHOTO_EDITING_LENS_DEFRINGE_HEADING,
  PHOTO_EDITING_LENS_PROFILE_TEXT,
  PHOTO_EDITING_LENS_RESET_LABEL,
  PHOTO_EDITING_LENS_SLIDER_LABELS,
  PHOTO_EDITING_LENS_TITLE,
  PHOTO_EDITING_RESET_LABEL,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_LENS_RANGES,
  hasPhotoEditingLensEdits,
  readPhotoEditingLens,
  resetPhotoEditingLens,
  writePhotoEditingLens,
  writePhotoEditingLensChromaticAberration,
  type PhotoEditingLensProfileState,
  type PhotoEditingLensSliderKey,
} from "../photo-editing-lens";
import type { PhotoEditingSettings } from "../photo-editing-types";

import {
  AdjustmentSwitch,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME, PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";
import { PhotoEditingSlider } from "./photo-editing-slider";

type LensProps = {
  /** 編集中の `developSettings`（値は `lens`） */
  settings: PhotoEditingSettings;
  /** スライダー・スイッチ・「初期化」を押せない（閲覧のみ・操作の途中など） */
  disabled: boolean;
  /**
   * 作業コピーに焼き込まれたプロファイル補正（`_source.lensCorrection.mode`）。作業コピーでない・読めない写真は null（状態を出さない）
   */
  profile: PhotoEditingLensProfileState | null;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
};

function ResetButton(props: LensProps) {
  const canReset = !props.disabled && hasPhotoEditingLensEdits(props.settings);
  const onSettingsChange = props.onSettingsChange;
  return (
    <button
      type="button"
      aria-label={PHOTO_EDITING_LENS_RESET_LABEL}
      disabled={!canReset}
      onClick={() => onSettingsChange(resetPhotoEditingLens, "commit")}
      className={PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME}
    >
      {PHOTO_EDITING_RESET_LABEL}
    </button>
  );
}

/**
 * 「レンズ」の節の中身（niho-photo#45）。上から、作業コピーに焼き込まれたプロファイル補正の状態（読み取り専用の 1 行。あれば）、
 * 歪み・周辺光量・中点のスライダー、「色収差を除去」のスイッチ、「フリンジ」の見出しの下に紫・緑のスライダー。
 *
 * - スライダーは補正の部品のまま（ドラッグの間は `drag`、離したら `commit`。ダブルクリックで既定。既定でない値は「変更あり」の目印）
 * - 中点は周辺光量が 0 の間は効かないので押せない（行は出したまま。粒子のサイズと同じ）
 * - 「色収差を除去」は写真から自動で推定して除く（`commit`）。補正するものが見つからない写真でも何も起きないだけ（注記は出さない）
 * - フリンジの色相の範囲（XMP の `Defringe*HueLo / Hi`）はスライダーに出さず、入ったまま保つ
 */
export function PhotoEditingLens(props: LensProps) {
  const { settings, disabled, onSettingsChange } = props;
  const idPrefix = useId();
  const values = useMemo(() => readPhotoEditingLens(settings), [settings]);

  const slider = (key: PhotoEditingLensSliderKey, extraDisabled = false) => {
    const range = PHOTO_EDITING_LENS_RANGES[key];
    const value = values[key];
    return (
      <PhotoEditingSlider
        key={key}
        id={`${idPrefix}-lens-${key}`}
        label={PHOTO_EDITING_LENS_SLIDER_LABELS[key]}
        min={range.min}
        max={range.max}
        step={1}
        value={value}
        valueText={range.signed ? formatSignedInteger(value) : String(Math.round(value))}
        disabled={disabled || extraDisabled}
        onChange={(next, phase) => onSettingsChange((current) => writePhotoEditingLens(current, key, next), phase)}
        onReset={() => onSettingsChange((current) => writePhotoEditingLens(current, key, range.defaultValue), "commit")}
        changed={value !== range.defaultValue}
      />
    );
  };

  return (
    <div data-testid="photo-lens">
      {props.profile ? (
        <p data-testid="photo-lens-profile" className="pb-1.5 pt-0.5 text-xs leading-relaxed text-niho-text-sub">
          {PHOTO_EDITING_LENS_PROFILE_TEXT[props.profile]}
        </p>
      ) : null}
      {slider("distortion")}
      {slider("vignetting")}
      {slider("vignettingMidpoint", values.vignetting === 0)}
      <AdjustmentSwitch
        id={`${idPrefix}-lens-chromatic-aberration`}
        label={PHOTO_EDITING_LENS_CHROMATIC_ABERRATION_LABEL}
        checked={values.removeChromaticAberration}
        disabled={disabled}
        onChange={(next) => onSettingsChange((current) => writePhotoEditingLensChromaticAberration(current, next), "commit")}
      />
      <div role="group" aria-labelledby={`${idPrefix}-lens-defringe`}>
        <p id={`${idPrefix}-lens-defringe`} className="pb-0.5 pt-2 text-xs font-bold text-niho-text-sub">
          {PHOTO_EDITING_LENS_DEFRINGE_HEADING}
        </p>
        {slider("defringePurple")}
        {slider("defringeGreen")}
      </div>
    </div>
  );
}

/**
 * 効果の群の下の「レンズ」の節（niho-photo#45。既定は閉じる。開閉は端末に覚える）。見出しの横の「初期化」はレンズ補正の全部（中点・
 * フリンジの色相の範囲も）を既定に戻して `commit` する（取り消しの 1 単位。既定のまま・押せない間は押せない表示）。
 */
export function PhotoEditingLensSection(props: LensProps) {
  return (
    <PhotoEditingAdvancedSection id="lens" title={PHOTO_EDITING_LENS_TITLE} accessory={<ResetButton {...props} />}>
      <PhotoEditingLens {...props} />
    </PhotoEditingAdvancedSection>
  );
}
