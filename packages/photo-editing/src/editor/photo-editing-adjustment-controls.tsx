"use client";

import { Fragment, useId, useState, type ReactNode } from "react";
import { ChevronDown, Info } from "lucide-react";

import type { PhotoEditingPhoto, PhotoEditingSettings } from "../photo-editing-types";
import { usePhotoEditingCollapsedAdjustmentGroups } from "../photo-editing-adjustment-groups-state";
import {
  PHOTO_EDITING_ABSOLUTE_TINT_MAX,
  PHOTO_EDITING_ABSOLUTE_TINT_MIN,
  PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX,
  PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN,
  PHOTO_EDITING_TEMPERATURE_MAX_KELVIN,
  PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
  PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS,
  formatAdjustmentValue,
  formatSignedInteger,
  formatTemperature,
  readAbsoluteWhiteBalance,
  readAdjustment,
  readRelativeWhiteBalance,
  resetAbsoluteWhiteBalance,
  resolveWhiteBalanceMode,
  sliderPositionToTemperature,
  temperatureToSliderPosition,
  visiblePhotoEditingAdjustmentGroups,
  writeAbsoluteWhiteBalance,
  writeAdjustment,
  writeRelativeWhiteBalance,
  type PhotoEditingAdjustmentControl,
  type PhotoEditingAdjustmentGroupId,
  type PhotoEditingControlKey,
} from "../photo-editing-adjustments";
import { PHOTO_EDITING_RESET_WHITE_BALANCE_LABEL } from "../photo-editing-copy";
import {
  formatEffectUnsignedValue,
  readEffectValue,
  readGrayscale,
  writeEffectValue,
  writeGrayscale,
} from "../photo-editing-effects";
import { cn } from "niho-ui/cn";

import { PhotoEditingSlider, type PhotoEditingSliderEntry, type PhotoEditingSliderPhase } from "./photo-editing-slider";

// スライダーは別のファイル（NIHO Desktop・ブラウザの面はここから読む）
export { PhotoEditingSlider, type PhotoEditingSliderPhase } from "./photo-editing-slider";

/**
 * 補正パネルの共通の部品（NIHO Photo 段 1 F0 移行元設計・F1 移行元設計）。ブラウザ版と NIHO Desktop の右パネルが同じスライダーと群を
 * 使う。入力は設定の値（Photo Bench の settings か developSettings）で、出力は変更の通知 `onSettingsChange(update, phase)` だけ。
 */

/**
 * 設定の書き換え。表示中の値ではなく、呼ばれた時点の最新の設定に当てる（ドラッグ中の入力が
 * 再描画より速く来ても、別の項目の値を古いもので上書きしない）。
 */
export type PhotoEditingSettingsUpdate = (current: PhotoEditingSettings) => PhotoEditingSettings;

/** 群・節の見出しの横の文字のボタン（「撮影時に戻す」・カーブの「初期化」）。 */
export const GROUP_ACCESSORY_BUTTON_CLASS_NAME =
  "min-h-11 rounded-full px-2.5 text-xs font-bold text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";

/**
 * 群の 1 つ。見出しは開閉のボタン（既定は開く。開閉は端末に覚える）。見出しの横のボタン（ⓘ・「撮影時に戻す」）は開閉の
 * ボタンの兄弟に置く（入れ子の操作を作らない）。ⓘ の説明は群の先頭に出す（閉じていても出す）。
 *
 * 群の間に差し込む「既定で閉じた節」（`PhotoEditingAdvancedSection`。カーブなど）も同じ見た目で使う（開閉と保存は呼ぶ側）。
 */
export function AdjustmentGroup(props: {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  info?: { label: string; open: boolean; onToggle: () => void; items: ReadonlyArray<{ label: string; text: string }> };
  accessory?: ReactNode;
  children: ReactNode;
}) {
  const bodyId = `${props.id}-body`;
  const infoId = `${props.id}-info`;
  const info = props.info;
  return (
    <div className="pt-1">
      <div className="flex min-h-11 items-center gap-1">
        <h4 className="min-w-0">
          <button
            type="button"
            aria-expanded={props.expanded}
            aria-controls={bodyId}
            onClick={props.onToggle}
            className="-ml-1 flex min-h-11 items-center gap-1 rounded-full pl-1 pr-2 text-xs font-bold text-niho-text-muted transition hover:text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
          >
            <ChevronDown
              className={cn("h-4 w-4 shrink-0 motion-safe:transition-transform", props.expanded ? null : "-rotate-90")}
              aria-hidden
            />
            {props.title}
          </button>
        </h4>
        {info ? (
          <button
            type="button"
            aria-label={info.label}
            aria-expanded={info.open}
            aria-controls={infoId}
            onClick={info.onToggle}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
              info.open ? "text-niho-accent-ink" : "text-niho-text-muted",
            )}
          >
            <Info className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {props.accessory ? <div className="ml-auto shrink-0">{props.accessory}</div> : null}
      </div>
      {info?.open ? (
        <ul id={infoId} className="mb-2 space-y-1 rounded-xl bg-niho-pale/60 px-3 py-2">
          {info.items.map((item) => (
            <li key={item.label} className="text-xs leading-relaxed text-niho-text-sub">
              <span className="font-bold text-niho-text">{item.label}</span>
              <span className="ml-2">{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div id={bodyId} hidden={!props.expanded} className="pb-1">
        {props.expanded ? props.children : null}
      </div>
    </div>
  );
}

function controlLabel(control: PhotoEditingAdjustmentControl): string {
  return control.kind === "adjustment" || control.kind === "effect" ? control.definition.label : control.label;
}

/**
 * 群の中の切り替えの行（「白黒」。E1b 移行元設計）。行全体が 1 つのスイッチ（高さ 44px）で、名前は左のラベル。見た目はスライダーの
 * 行のラベルにそろえ、右に小さなつまみを置く。
 */
function AdjustmentSwitch(props: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      className="flex min-h-11 w-full items-center justify-between gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink enabled:cursor-pointer disabled:cursor-not-allowed"
    >
      <span className="text-xs font-bold text-niho-text-sub">{props.label}</span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full motion-safe:transition-colors",
          props.checked ? "bg-niho-accent-ink" : "bg-niho-text-muted/50",
          props.disabled ? "opacity-40" : null,
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm motion-safe:transition-transform",
            props.checked ? "translate-x-4" : "translate-x-0",
          )}
        />
      </span>
    </button>
  );
}

/**
 * 色温度・色かぶり補正の線の薄い色の帯（Lightroom と同じ。L6 #55）。色温度は 青 → 黄、色かぶり補正は 緑 → 赤紫。真ん中は線の色に
 * 近い中間の色にして、帯の端だけ色を見せる。
 */
const WHITE_BALANCE_TRACK_CLASS_NAMES: Record<"temperature" | "tint", string> = {
  temperature:
    "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(90deg,#9CBBF0,#E4E0D8_50%,#F0C978)] [&::-moz-range-track]:bg-[linear-gradient(90deg,#9CBBF0,#E4E0D8_50%,#F0C978)]",
  tint: "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(90deg,#A9D59A,#E4E0D8_50%,#EBA6DB)] [&::-moz-range-track]:bg-[linear-gradient(90deg,#A9D59A,#E4E0D8_50%,#EBA6DB)]",
};

/** 白黒の間は描画に効かない項目（値は保つ。白黒をオフに戻すと元の値で効く）。 */
const GRAYSCALE_INACTIVE_KEYS: ReadonlySet<PhotoEditingControlKey> = new Set<PhotoEditingControlKey>(["vibrance", "saturation"]);
/**
 * 1 項目のスライダーに渡す値。PC の `PhotoEditingSlider` とスマホの目盛り（`PhotoEditingRuler`。F6c 移行元設計）が同じものを使う。
 */
export type PhotoEditingControlSliderProps = {
  key: string;
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  valueText: string;
  disabled: boolean;
  onChange: (value: number, phase: PhotoEditingSliderPhase) => void;
  onReset: () => void;
  entry?: PhotoEditingSliderEntry;
  /** 既定値のまま（スマホのチップに値を添えない・PC の値を太字にしない）。補正と相対の白は 0、絶対の白は撮影時の値のとき */
  isDefault: boolean;
};

/**
 * 群の項目 → スライダーに渡す値（React に依らない）。白は撮影時の白がある写真を絶対の色温度・色かぶり補正で、ほかを相対で
 * 返す（{@link resolveWhiteBalanceMode}）。`resetWhiteBalance` はカラーの「撮影時に戻す」を出せるときの操作（出せなければ null）。
 */
export function resolvePhotoEditingControlSliders(props: {
  settings: PhotoEditingSettings | null;
  photo: Pick<PhotoEditingPhoto, "asShotWhiteBalance"> | null;
  disabled: boolean;
  idPrefix: string;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
}): {
  sliderFor: (control: PhotoEditingAdjustmentControl) => PhotoEditingControlSliderProps;
  resetWhiteBalance: (() => void) | null;
} {
  const idPrefix = props.idPrefix;
  const photo = props.photo;
  const settings = props.settings ?? {};
  const disabled = props.disabled;
  const change = props.onSettingsChange;

  const asShot = photo?.asShotWhiteBalance ?? null;
  // developSettings の RAW に相対の補正が残っていれば、その写真は相対で見せる（今の画と表示を合わせる。移行元設計 S7b）
  const absolute = photo !== null && asShot !== null && resolveWhiteBalanceMode(photo, props.settings) === "absolute";
  const absoluteView = asShot ? readAbsoluteWhiteBalance(settings, asShot) : null;

  const sliderFor = (control: PhotoEditingAdjustmentControl): PhotoEditingControlSliderProps => {
    if (control.kind === "adjustment") {
      const definition = control.definition;
      const value = readAdjustment(settings, definition.key);
      return {
        key: definition.key,
        id: `${idPrefix}-${definition.key}`,
        label: definition.label,
        min: definition.min,
        max: definition.max,
        step: definition.step,
        value,
        valueText: formatAdjustmentValue(definition.key, value),
        disabled,
        onChange: (next, phase) => change((current) => writeAdjustment(current, definition.key, next), phase),
        onReset: () => change((current) => writeAdjustment(current, definition.key, 0), "commit"),
        isDefault: value === 0,
      };
    }
    if (control.kind === "toggle" || control.kind === "effect") {
      throw new Error("toggle/effect controls do not have a PhotoEditingSlider representation");
    }
    if (absolute && asShot && absoluteView) {
      if (control.channel === "temperature") {
        return {
          key: "temperature",
          id: `${idPrefix}-temperature`,
          label: control.label,
          min: 0,
          max: PHOTO_EDITING_TEMPERATURE_SLIDER_STEPS,
          step: 1,
          value: temperatureToSliderPosition(absoluteView.temperature),
          valueText: formatTemperature(absoluteView.temperature),
          disabled,
          onChange: (position, phase) =>
            change(
              (current) =>
                writeAbsoluteWhiteBalance(current, {
                  temperature: sliderPositionToTemperature(position),
                  tint: readAbsoluteWhiteBalance(current, asShot).tint,
                }),
              phase,
            ),
          onReset: () => change(resetAbsoluteWhiteBalance, "commit"),
          // 直接入力は表示と同じ K で受ける（つまみの位置に丸めない）
          entry: {
            min: PHOTO_EDITING_TEMPERATURE_MIN_KELVIN,
            max: PHOTO_EDITING_TEMPERATURE_MAX_KELVIN,
            step: 1,
            commit: (kelvin) =>
              change(
                (current) =>
                  writeAbsoluteWhiteBalance(current, {
                    temperature: kelvin,
                    tint: readAbsoluteWhiteBalance(current, asShot).tint,
                  }),
                "commit",
              ),
          },
          isDefault: absoluteView.temperature === asShot.temperature,
        };
      }
      return {
        key: "tint",
        id: `${idPrefix}-tint`,
        label: control.label,
        min: PHOTO_EDITING_ABSOLUTE_TINT_MIN,
        max: PHOTO_EDITING_ABSOLUTE_TINT_MAX,
        step: 1,
        value: absoluteView.tint,
        valueText: formatSignedInteger(absoluteView.tint),
        disabled,
        onChange: (next, phase) =>
          change(
            (current) =>
              writeAbsoluteWhiteBalance(current, {
                temperature: readAbsoluteWhiteBalance(current, asShot).temperature,
                tint: next,
              }),
            phase,
          ),
        onReset: () => change(resetAbsoluteWhiteBalance, "commit"),
        isDefault: absoluteView.tint === asShot.tint,
      };
    }
    const key = control.key;
    const value = readRelativeWhiteBalance(settings, key);
    return {
      key,
      id: `${idPrefix}-${key}`,
      label: control.label,
      min: PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MIN,
      max: PHOTO_EDITING_RELATIVE_WHITE_BALANCE_MAX,
      step: 1,
      value,
      valueText: formatSignedInteger(value),
      disabled,
      onChange: (next, phase) => change((current) => writeRelativeWhiteBalance(current, key, next), phase),
      onReset: () => change((current) => writeRelativeWhiteBalance(current, key, 0), "commit"),
      isDefault: value === 0,
    };
  };

  return {
    sliderFor,
    resetWhiteBalance:
      absolute && absoluteView && !absoluteView.asShot && !disabled
        ? () => change(resetAbsoluteWhiteBalance, "commit")
        : null,
  };
}

/**
 * 補正の群（ライト → カラー → 効果。定義は `PHOTO_EDITING_ADJUSTMENT_GROUPS`）。`visibleKeys` で見せる項目を絞り
 * （省略時は全部）、項目が 1 つも無い群は見出しごと出さない。群は見出しで開閉でき（端末に覚える）、効果の群名の横の ⓘ で
 * 項目ごとの説明を出す。白は撮影時の白がある写真（Adobe のカメラプロファイルで開いた RAW）を絶対の色温度・色かぶり補正で、
 * ほかを相対で見せる（{@link resolveWhiteBalanceMode}）。「撮影時に戻す」はカラーの群の見出しの横。
 *
 * 効果の項目（白黒・周辺光量補正・粒子・粒子のサイズ。E1b 移行元設計）は `visibleKeys` に入れた面にだけ出る（省いた面＝NIHO Desktop
 * には出ない）。「白黒」はカラーの先頭の切り替え（押すたびに `commit`）で、オンの間は自然な彩度・彩度を薄くして押せなくする
 * （値は保つ）。「粒子のサイズ」は粒子が 0 の間は薄くして押せない（行は出したまま）。
 *
 * `lightAccessory` を渡した面だけ、ライトの群の見出しの横に置く（ブラウザ版の「自動」。F4b 移行元設計）。見出しの兄弟に置くので、群を
 * 閉じていても出る。省いた面（NIHO Desktop）は今のまま。
 *
 * `afterGroup` を渡した面だけ、その群の直後（次の群の前）に要素を差し込む（ブラウザ版の PC の「カーブ」の節。niho-photo#37。後続の
 * 節も同じ口を使う）。群を出さない（見せる項目が無い）ときは差し込みも出さない。省いた面の DOM は今のまま。
 */
export function PhotoEditingAdjustmentGroups(props: {
  /** 設定の値（Photo Bench の settings か developSettings）。無ければ 0（白は撮影時の値）で見せる */
  settings: PhotoEditingSettings | null;
  /** 白の絶対 / 相対を決める材料（撮影時の白。写真が無い・撮影時の白が無ければ相対） */
  photo: Pick<PhotoEditingPhoto, "asShotWhiteBalance"> | null;
  disabled: boolean;
  /** 見せる項目（省略時は全部） */
  visibleKeys?: ReadonlyArray<PhotoEditingControlKey>;
  /** スライダーの id の頭（省略時はここで作る） */
  idPrefix?: string;
  /** ライトの群の見出しの横に置く要素（省略時は何も置かない） */
  lightAccessory?: ReactNode;
  /**
   * 「白黒」の切り替えの置き場（`visibleKeys` に `grayscale` を入れた面だけ）。`group`（既定）はカラーの群の先頭の行、`hidden` は
   * 群の中に描かない（ブラウザ版は補正の面の一番上のチップに置く。niho-photo#51）。どちらでも、白黒の間は自然な彩度・彩度を押せない
   */
  grayscaleToggle?: "group" | "hidden";
  /** 群の直後に差し込む要素（群の id ごと。省略時は何も差し込まない） */
  afterGroup?: Partial<Record<PhotoEditingAdjustmentGroupId, ReactNode>>;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
}) {
  const ownIdPrefix = useId();
  const idPrefix = props.idPrefix ?? ownIdPrefix;
  const [collapsedGroups, toggleGroup] = usePhotoEditingCollapsedAdjustmentGroups();
  const [openInfoGroup, setOpenInfoGroup] = useState<PhotoEditingAdjustmentGroupId | null>(null);
  const settings = props.settings ?? {};
  const disabled = props.disabled;
  const change = props.onSettingsChange;
  const { sliderFor, resetWhiteBalance } = resolvePhotoEditingControlSliders({
    settings: props.settings,
    photo: props.photo,
    disabled: props.disabled,
    idPrefix,
    onSettingsChange: props.onSettingsChange,
  });

  const groups = visiblePhotoEditingAdjustmentGroups(props.visibleKeys);
  // 白黒の切り替えを出せる面（群の定義に切り替えがある）だけ、白黒の間の彩度を押せなくする（出せない面の見た目は変えない）。
  // 切り替えを群の外に置く面（`grayscaleToggle: "hidden"`）も同じ
  const togglePresent = groups.some((group) => group.controls.some((control) => control.kind === "toggle"));
  const grayscale = readGrayscale(settings) && togglePresent;
  const toggleHidden = props.grayscaleToggle === "hidden";

  const renderControl = (control: PhotoEditingAdjustmentControl) => {
    if (control.kind === "toggle") {
      return (
        <AdjustmentSwitch
          key={control.key}
          id={`${idPrefix}-${control.key}`}
          label={control.label}
          checked={readGrayscale(settings)}
          disabled={disabled}
          onChange={(next) => change((current) => writeGrayscale(current, next), "commit")}
        />
      );
    }
    if (control.kind === "effect") {
      const definition = control.definition;
      const value = readEffectValue(settings, definition.key);
      return (
        <PhotoEditingSlider
          key={definition.key}
          id={`${idPrefix}-${definition.key}`}
          label={definition.label}
          min={definition.min}
          max={definition.max}
          step={definition.step}
          value={value}
          valueText={definition.signed ? formatSignedInteger(value) : formatEffectUnsignedValue(value)}
          // 粒子のサイズは、粒子が 0 の間は効かない（行は出したまま押せなくする）
          disabled={disabled || (definition.key === "grainSize" && readEffectValue(settings, "grainAmount") === 0)}
          onChange={(next, phase) => change((current) => writeEffectValue(current, definition.key, next), phase)}
          onReset={() => change((current) => writeEffectValue(current, definition.key, definition.defaultValue), "commit")}
          changed={value !== definition.defaultValue}
        />
      );
    }
    // `isDefault` はスマホのチップ（値を添えるか）と PC の値の「変更あり」の目印（L6 #55）が使う
    const slider = sliderFor(control);
    return (
      <PhotoEditingSlider
        key={slider.key}
        id={slider.id}
        label={slider.label}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={slider.value}
        valueText={slider.valueText}
        disabled={slider.disabled || (control.kind === "adjustment" && grayscale && GRAYSCALE_INACTIVE_KEYS.has(control.definition.key))}
        onChange={slider.onChange}
        onReset={slider.onReset}
        entry={slider.entry}
        changed={!slider.isDefault}
        trackClassName={control.kind === "whiteBalance" ? WHITE_BALANCE_TRACK_CLASS_NAMES[control.channel] : undefined}
      />
    );
  };

  const resetWhiteBalanceButton =
    resetWhiteBalance ? (
      <button
        type="button"
        onClick={resetWhiteBalance}
        className={GROUP_ACCESSORY_BUTTON_CLASS_NAME}
      >
        {PHOTO_EDITING_RESET_WHITE_BALANCE_LABEL}
      </button>
    ) : null;

  return (
    <>
      {groups.map((group) => {
        // 白黒を群の外に置く面は、群の中の切り替えの行を描かない（描く項目が残らない群は見出しごと出さない）
        const controls: ReadonlyArray<PhotoEditingAdjustmentControl> = toggleHidden
          ? group.controls.filter((control) => control.kind !== "toggle")
          : group.controls;
        if (controls.length === 0) return null;
        const after = props.afterGroup?.[group.id];
        const info = group.info;
        const infoItems = info
          ? controls.flatMap((control) => {
              const text = info.descriptions[control.key];
              return text ? [{ label: controlLabel(control), text }] : [];
            })
          : [];
        const groupElement = (
          <AdjustmentGroup
            key={group.id}
            id={`${idPrefix}-group-${group.id}`}
            title={group.title}
            expanded={!collapsedGroups.has(group.id)}
            onToggle={() => toggleGroup(group.id)}
            info={
              info && infoItems.length > 0
                ? {
                    label: info.label,
                    open: openInfoGroup === group.id,
                    onToggle: () => setOpenInfoGroup((current) => (current === group.id ? null : group.id)),
                    items: infoItems,
                  }
                : undefined
            }
            accessory={
              group.id === "color" ? resetWhiteBalanceButton : group.id === "light" ? props.lightAccessory : undefined
            }
          >
            {controls.map(renderControl)}
          </AdjustmentGroup>
        );
        // 差し込みの有無で群の要素の種類が替わらないよう、いつも Fragment で包む（差し込みが現れる・消えるときに群を作り直さない）
        return (
          <Fragment key={group.id}>
            {groupElement}
            {after}
          </Fragment>
        );
      })}
    </>
  );
}
