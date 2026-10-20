"use client";

import { useId, type MutableRefObject } from "react";

import type { PhotoEditingBuiltinPreset } from "../photo-editing-types";
import {
  DEVELOP_XMP_DEFAULT_GROUPS,
  type DevelopEngine,
  type DevelopXmpGroup,
} from "../develop-engine/develop-engine-client";
import { isNeutralDevelopColors, type DevelopSettings } from "../develop-engine/develop-settings";
import { PHOTO_EDITING_PRESET_AMOUNT_LABEL } from "../photo-editing-copy";

import type { PhotoEditingPresetSaveInput } from "./photo-editing-preset-dialogs";
import { PhotoEditingPresetsPanel, type PhotoEditingPresetSaveCurrent } from "./photo-editing-presets-panel";
import { PhotoEditingSlider } from "./photo-editing-slider";
import type { BrowserPhotoPresetSupport } from "./use-browser-photo-preset-support";
import {
  BROWSER_PRESET_AMOUNT_DEFAULT,
  BROWSER_PRESET_AMOUNT_MAX,
  type BrowserPhotoPresets,
} from "./use-browser-photo-presets";
import { useBrowserPresetThumbnails } from "./use-browser-preset-thumbnails";

/** 今の補正を書き出す群（crate の既定に、選んだ露光量・ホワイトバランスを足す）。 */
function presetXmpGroups(input: PhotoEditingPresetSaveInput): DevelopXmpGroup[] {
  return [
    ...(input.includeExposure ? (["exposure"] as const) : []),
    ...(input.includeWhiteBalance ? (["whiteBalance"] as const) : []),
    ...DEVELOP_XMP_DEFAULT_GROUPS,
  ];
}

/**
 * ブラウザ版の右パネルの「プリセット」（NIHO Photo 段 1 F2b 移行元設計）。プリセットパネルに、段 2 の wasm
 * にある口の分だけ足す（公開済みの wasm に無い口の機能は出さない）:
 *
 * - 見本（`supportsPresetThumbnails()`）: 各行の左に、開いている写真にそのプリセットを当てた小さな絵（`useBrowserPresetThumbnails`）
 * - 適用量（`supportsPresetAmount()`）: プリセットが選ばれている間だけ、一覧の下に 0〜150% のスライダー
 * - 今の補正をプリセットに保存（`supportsSettingsToXmp()`）: 見出しの右の「⋯」のメニューから
 */
export function BrowserPhotoEditingPresets(props: {
  spotId: string;
  canEdit: boolean;
  builtinPresets: { queryKey: readonly unknown[]; load: () => Promise<PhotoEditingBuiltinPreset[]> };
  presets: BrowserPhotoPresets;
  /** 別の端末の補正を読み直している（当てない。読み直した補正が入る） */
  staleReloading: boolean;
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  /** 今の補正 */
  settings: DevelopSettings;
  /** 補正のスライダーを動かしている */
  dragging: boolean;
  /** 暫定入力の間は見本生成を待ち、編集の描画を優先する。 */
  provisional?: boolean;
  /** wasm にある口（面が 1 回確かめて覚える。`useBrowserPhotoPresetSupport`） */
  support: BrowserPhotoPresetSupport;
}) {
  const { presets, settings, engineRef, support } = props;
  const amountSliderId = useId();
  const canApplyAmount = presets.canApply && !props.staleReloading && presets.applyingPresetKey === null;
  const canApplyPreset = canApplyAmount && !presets.amountActive;
  const thumbnails = useBrowserPresetThumbnails({
    mountedRef: props.mountedRef,
    engineRef,
    supported: support.thumbnails,
    photoKey: props.photoKey,
    // 選ばれているプリセットがあれば当てる前の補正、無ければ今の補正に当てた絵
    base: presets.selectedBase ?? settings,
    paused: props.provisional === true || props.dragging || presets.amountActive || presets.applyingPresetKey !== null,
    resolvePreset: presets.resolvePreset,
  });

  const amount = presets.amount;
  const amountSlider =
    support.amount && amount !== null ? (
      <div className="px-3 pb-1 pt-2">
        <PhotoEditingSlider
          id={amountSliderId}
          label={PHOTO_EDITING_PRESET_AMOUNT_LABEL}
          min={0}
          max={BROWSER_PRESET_AMOUNT_MAX}
          step={1}
          value={amount}
          valueText={`${amount}%`}
          disabled={!canApplyAmount}
          onChange={presets.changeAmount}
          onReset={() => presets.changeAmount(BROWSER_PRESET_AMOUNT_DEFAULT, "commit")}
        />
      </div>
    ) : null;

  const saveCurrent: PhotoEditingPresetSaveCurrent = {
    available: canApplyPreset,
    neutral: isNeutralDevelopColors(settings),
    writeXmp: async (input) => {
      const engine = engineRef.current;
      if (!engine) throw new Error("develop engine is not available");
      return engine.settingsToXmp(settings, { name: input.name, groups: presetXmpGroups(input) });
    },
  };

  return (
    <PhotoEditingPresetsPanel
      spotId={props.spotId}
      canEdit={props.canEdit}
      builtinPresets={props.builtinPresets}
      canApply={canApplyPreset}
      appliedPresetKey={presets.appliedPresetKey}
      applyingPresetKey={presets.applyingPresetKey}
      applyError={presets.applyError}
      onApply={(preset) => void presets.apply(preset)}
      none={{ canClear: presets.canClear && !props.staleReloading && !presets.amountActive, onClear: presets.clear }}
      readPreset={presets.readPreset}
      onPreview={presets.requestPreview}
      thumbnails={thumbnails}
      belowList={amountSlider}
      saveCurrent={support.settingsToXmp ? saveCurrent : undefined}
      onSpotPresetKeysChange={presets.reconcileSpotPresetKeys}
    />
  );
}
