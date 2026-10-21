"use client";

import { useMemo } from "react";

import type { DevelopMask, DevelopMaskHslBand } from "../develop-engine/develop-masks";
import { PHOTO_EDITING_HSL_TITLE, PHOTO_EDITING_MASK_HSL_RESET_LABEL, PHOTO_EDITING_RESET_LABEL } from "../photo-editing-copy";
import type { PhotoEditingHslAxis } from "../photo-editing-hsl";
import { hasPhotoEditingMaskHslEdits, readPhotoEditingMaskHsl } from "../photo-editing-masks";

import type { PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME, PhotoEditingAdvancedSection } from "./photo-editing-advanced-section";
import { PhotoEditingHslMixerView } from "./photo-editing-hsl-mixer";

/** 選んだマスクの局所のカラーミキサー（PC の節とスマホの段が同じ値を使う）。 */
export type PhotoEditingMaskHslProps = {
  mask: DevelopMask;
  /** 押せない（閲覧のみ・操作の途中など） */
  disabled: boolean;
  /** 全体が白黒（全体のカラーミキサーと同じく、スライダーと「初期化」を押せない） */
  grayscale: boolean;
  onChange: (id: string, band: DevelopMaskHslBand, axis: PhotoEditingHslAxis, value: number, phase: PhotoEditingSliderPhase) => void;
  onReset: (id: string) => void;
};

/** 局所のカラーミキサーの値と、「初期化」を押せるか。 */
export function usePhotoEditingMaskHsl(props: PhotoEditingMaskHslProps) {
  const { mask } = props;
  const values = useMemo(() => readPhotoEditingMaskHsl(mask), [mask]);
  const locked = props.disabled || props.grayscale;
  return {
    values,
    sliderDisabled: locked,
    canReset: !locked && hasPhotoEditingMaskHslEdits(mask),
    onChange: (band: DevelopMaskHslBand, axis: PhotoEditingHslAxis, value: number, phase: PhotoEditingSliderPhase) =>
      props.onChange(mask.id, band, axis, value, phase),
    onReset: () => props.onReset(mask.id),
  };
}

/**
 * スマホの段の局所のカラーミキサー（niho-photo#93）。全体のカラーミキサーと同じ「調整」の切り替えと 8 本のスライダーで、切り替えの
 * 右に「初期化」を置く。値は全体への差分（−100〜100。0 の値・色は書かない）。
 */
export function PhotoEditingMaskHslMixer(props: PhotoEditingMaskHslProps) {
  const hsl = usePhotoEditingMaskHsl(props);
  return (
    <PhotoEditingHslMixerView
      // マスクを替えたら別のミキサーとして作り直す（入力の途中の状態を、別のマスクの値に持ち越さない）
      key={props.mask.id}
      values={hsl.values}
      disabled={hsl.sliderDisabled}
      onChange={hsl.onChange}
      onResetAll={hsl.onReset}
      canReset={hsl.canReset}
      resetLabel={PHOTO_EDITING_MASK_HSL_RESET_LABEL}
    />
  );
}

/**
 * 右パネルの選んだマスクの補正の、カラーの群の後ろの「カラーミキサー」の節（niho-photo#93。全体の節と同じく既定は閉じ、開閉は端末に
 * 覚える）。見出しの横の「初期化」はこのマスクの 24 の値だけを 0 に戻す（取り消しの 1 単位）。
 */
export function PhotoEditingMaskHslSection(props: PhotoEditingMaskHslProps) {
  const hsl = usePhotoEditingMaskHsl(props);
  return (
    <PhotoEditingAdvancedSection
      id="maskHsl"
      title={PHOTO_EDITING_HSL_TITLE}
      accessory={
        <button
          type="button"
          aria-label={PHOTO_EDITING_MASK_HSL_RESET_LABEL}
          disabled={!hsl.canReset}
          onClick={hsl.onReset}
          className={PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME}
        >
          {PHOTO_EDITING_RESET_LABEL}
        </button>
      }
    >
      <PhotoEditingHslMixerView
        key={props.mask.id}
        values={hsl.values}
        disabled={hsl.sliderDisabled}
        onChange={hsl.onChange}
        canReset={hsl.canReset}
      />
    </PhotoEditingAdvancedSection>
  );
}
