"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Spinner } from "niho-ui/components/spinner";
import {
  CUTOUT_BRUSH_RADIUS_DEFAULT,
  CUTOUT_BRUSH_RADIUS_MAX,
  CUTOUT_BRUSH_RADIUS_MIN,
  cutoutSubjectChoices,
  type CutoutBackground,
  type CutoutBrushMode,
  type CutoutRecipe,
  type CutoutSelection,
} from "../photo-cutout";
import {
  PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_LABEL,
  PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_PICKER_LABEL,
  PHOTO_EDITING_CUTOUT_BACKGROUND_TITLE,
  PHOTO_EDITING_CUTOUT_BACKGROUND_TRANSPARENT_LABEL,
  PHOTO_EDITING_CUTOUT_BACKGROUND_WHITE_LABEL,
  PHOTO_EDITING_CUTOUT_BLOCKED_BY_GEOMETRY_TEXT,
  PHOTO_EDITING_CUTOUT_BRUSH_ERASE_LABEL,
  PHOTO_EDITING_CUTOUT_BRUSH_HINT,
  PHOTO_EDITING_CUTOUT_BRUSH_RESTORE_LABEL,
  PHOTO_EDITING_CUTOUT_BRUSH_SIZE_LABEL,
  PHOTO_EDITING_CUTOUT_BRUSH_TITLE,
  PHOTO_EDITING_CUTOUT_CANCEL_LABEL,
  PHOTO_EDITING_CUTOUT_REMOVE_LABEL,
  PHOTO_EDITING_CUTOUT_RUN_HINT,
  PHOTO_EDITING_CUTOUT_RUN_LABEL,
  PHOTO_EDITING_CUTOUT_RUNNING_TEXT,
  PHOTO_EDITING_CUTOUT_SUBJECT_TITLE,
  photoEditingCutoutSubjectLabel,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import {
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";
import { PhotoEditingSlider } from "./photo-editing-slider";

const FOCUS_RING_CLASS_NAME = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
/** 選ぶ札（切り抜きの道具の縦横比のチップと同じ見た目。押せる範囲は見た目の 32px。design-guide §8） */
const PILL_CLASS_NAME = cn(
  "inline-flex min-h-8 items-center rounded-full border px-3 text-sub font-bold transition disabled:cursor-not-allowed disabled:opacity-50",
  FOCUS_RING_CLASS_NAME,
);
const PILL_SELECTED_CLASS_NAME = "border-transparent bg-niho-accent-soft text-niho-accent-ink";
const PILL_IDLE_CLASS_NAME = "border-niho-border text-niho-text enabled:hover:bg-niho-pale/60";
const SECTION_TITLE_CLASS_NAME = "text-xs font-bold text-niho-text-muted";
/** 説明・理由の 1 行（読める濃さ） */
const NOTE_CLASS_NAME = "text-xs leading-relaxed text-niho-text-sub";
/** ブラシの大きさのスライダー（表示は短い辺に対する %） */
const BRUSH_PERCENT_MIN = CUTOUT_BRUSH_RADIUS_MIN * 100;
const BRUSH_PERCENT_MAX = CUTOUT_BRUSH_RADIUS_MAX * 100;
const BRUSH_PERCENT_STEP = 0.5;
/** 「背景除去を外す」（字だけの副ボタン。字の左端を上の行に揃える） */
const REMOVE_BUTTON_CLASS_NAME = cn(PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME, "-ml-3 disabled:cursor-not-allowed disabled:opacity-50");
/** 「色」を初めて選んだときの背景の色（白の背景と対になる黒） */
const DEFAULT_BACKGROUND_COLOR = "#000000";

function formatBrushPercent(value: number): string {
  return `${Number(value.toFixed(1))}%`;
}

function Pill(props: { label: string; pressed: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onPress}
      className={cn(PILL_CLASS_NAME, props.pressed ? PILL_SELECTED_CLASS_NAME : PILL_IDLE_CLASS_NAME)}
    >
      {props.label}
    </button>
  );
}

/** 背景の色を選ぶ欄。選んでいる間（`input`）は手元だけを替え、閉じて決まったとき（`change`）に 1 回確定する。 */
function BackgroundColorPicker(props: { color: string; disabled: boolean; onCommit: (color: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(props.color);
  const onCommitRef = useRef(props.onCommit);
  onCommitRef.current = props.onCommit;
  // 確定した色が替わった（取り消しなど）ら、手元の色も合わせる
  useEffect(() => {
    setDraft(props.color);
  }, [props.color]);
  // React の onChange は input のたびに来るので、決まったときの change は別に聞く
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => onCommitRef.current(input.value.toLowerCase());
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  return (
    <input
      ref={inputRef}
      type="color"
      aria-label={PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_PICKER_LABEL}
      value={draft}
      disabled={props.disabled}
      onChange={(event) => setDraft(event.currentTarget.value)}
      className={cn(
        "h-8 w-11 cursor-pointer rounded-full border border-niho-border bg-white p-1 disabled:cursor-not-allowed disabled:opacity-50",
        FOCUS_RING_CLASS_NAME,
      )}
    />
  );
}

/**
 * 背景除去の道具（NIHO camera だけ。C4 移行元設計）: 右パネルの「背景除去」の間、プリセットの節と群の代わりに出す。切り抜きの道具と
 * 同じく、押すたびに確定する（取り消しの 1 単位。保存と履歴は呼ぶ側）。「完了」のボタンは置かない。
 *
 * - 切り抜き・回転のある写真: 理由と次の一歩の 1 行だけ（背景除去と切り抜き・回転は同時に使わない）
 * - まだ除去していない: 説明の 1 行と「背景を除去」。失敗したらその上に状態と次の一歩の 1 行を出し、同じボタンでやり直す
 *   （保存していたマスクを読めなかったときも同じ。「背景除去を外す」も出す）
 * - 推論の途中: 「人や物を探しています…」と「やめる」
 * - 除去した後: 被写体（2 つ以上見つかったときだけ）→ 背景（透明 / 白 / 色。色は決まったときに確定）→ ブラシ（消す / 戻す・
 *   大きさ・説明）→「背景除去を外す」（取り消せるので確かめない）
 */
export function PhotoEditingCutoutTools(props: {
  recipe: CutoutRecipe | null;
  running: boolean;
  /** 推論・読み込みの失敗の 1 行（無ければ null） */
  failureText: string | null;
  /** 保存していたマスクを読めなかった（やり直しのボタンを出す） */
  maskFailed: boolean;
  blockedByGeometry: boolean;
  disabled: boolean;
  brush: { mode: CutoutBrushMode; radius: number };
  onRun: () => void;
  onCancel: () => void;
  onSelectSubject: (selection: CutoutSelection) => void;
  onBackgroundChange: (background: CutoutBackground) => void;
  onBrushModeChange: (mode: CutoutBrushMode) => void;
  onBrushRadiusChange: (radius: number) => void;
  onRemove: () => void;
}) {
  const { recipe, running } = props;
  const subjectTitleId = useId();
  const backgroundTitleId = useId();
  const brushTitleId = useId();
  const brushSizeId = useId();
  const locked = props.disabled || running;
  // 「色」を選び直したときに使う、最後に選んだ色（このパネルを開いている間）
  const [lastColor, setLastColor] = useState(DEFAULT_BACKGROUND_COLOR);
  const background = recipe?.background ?? null;
  const currentColor = background?.kind === "color" ? background.color : null;
  useEffect(() => {
    if (currentColor) setLastColor(currentColor);
  }, [currentColor]);

  if (props.blockedByGeometry) {
    return (
      <div className="pt-1">
        <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_CUTOUT_BLOCKED_BY_GEOMETRY_TEXT}</p>
      </div>
    );
  }

  if (running) {
    return (
      <div className="pt-1">
        <div role="status" className="flex min-h-8 items-center gap-2">
          <Spinner size="sm" />
          <p className="min-w-0 text-xs font-bold text-niho-text-sub">{PHOTO_EDITING_CUTOUT_RUNNING_TEXT}</p>
        </div>
        <button type="button" onClick={props.onCancel} className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-3")}>
          {PHOTO_EDITING_CUTOUT_CANCEL_LABEL}
        </button>
      </div>
    );
  }

  const failure = props.failureText ? (
    <p role="alert" className="mb-2 text-xs font-bold leading-relaxed text-niho-text-sub">
      {props.failureText}
    </p>
  ) : null;

  if (!recipe || props.maskFailed) {
    return (
      <div className="pt-1">
        {failure}
        {!recipe ? <p className={NOTE_CLASS_NAME}>{PHOTO_EDITING_CUTOUT_RUN_HINT}</p> : null}
        <button type="button" disabled={locked} onClick={props.onRun} className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "mt-3")}>
          {PHOTO_EDITING_CUTOUT_RUN_LABEL}
        </button>
        {recipe ? (
          <div className="mt-2">
            <button type="button" disabled={locked} onClick={props.onRemove} className={REMOVE_BUTTON_CLASS_NAME}>
              {PHOTO_EDITING_CUTOUT_REMOVE_LABEL}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const choices = cutoutSubjectChoices(recipe.detection);
  const brushPercent = props.brush.radius * 100;
  const backgroundKind = recipe.background.kind;

  return (
    <div className="pt-1">
      {failure}
      {choices.length > 1 ? (
        <section className="mb-4">
          <h4 id={subjectTitleId} className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>
            {PHOTO_EDITING_CUTOUT_SUBJECT_TITLE}
          </h4>
          <div role="group" aria-labelledby={subjectTitleId} className="flex flex-wrap gap-1.5">
            {choices.map((selection, index) => (
              <Pill
                key={selection}
                label={photoEditingCutoutSubjectLabel(selection, index + 1)}
                pressed={recipe.selected === selection}
                disabled={locked}
                onPress={() => props.onSelectSubject(selection)}
              />
            ))}
          </div>
        </section>
      ) : null}
      <section className="mb-4">
        <h4 id={backgroundTitleId} className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>
          {PHOTO_EDITING_CUTOUT_BACKGROUND_TITLE}
        </h4>
        <div role="group" aria-labelledby={backgroundTitleId} className="flex flex-wrap items-center gap-1.5">
          <Pill
            label={PHOTO_EDITING_CUTOUT_BACKGROUND_TRANSPARENT_LABEL}
            pressed={backgroundKind === "transparent"}
            disabled={locked}
            onPress={() => props.onBackgroundChange({ kind: "transparent" })}
          />
          <Pill
            label={PHOTO_EDITING_CUTOUT_BACKGROUND_WHITE_LABEL}
            pressed={backgroundKind === "white"}
            disabled={locked}
            onPress={() => props.onBackgroundChange({ kind: "white" })}
          />
          <Pill
            label={PHOTO_EDITING_CUTOUT_BACKGROUND_COLOR_LABEL}
            pressed={backgroundKind === "color"}
            disabled={locked}
            onPress={() => props.onBackgroundChange({ kind: "color", color: currentColor ?? lastColor })}
          />
          {currentColor ? (
            <BackgroundColorPicker
              color={currentColor}
              disabled={locked}
              onCommit={(color) => props.onBackgroundChange({ kind: "color", color })}
            />
          ) : null}
        </div>
      </section>
      <section>
        <h4 id={brushTitleId} className={cn(SECTION_TITLE_CLASS_NAME, "mb-1.5")}>
          {PHOTO_EDITING_CUTOUT_BRUSH_TITLE}
        </h4>
        <div role="group" aria-labelledby={brushTitleId} className="flex flex-wrap gap-1.5">
          <Pill
            label={PHOTO_EDITING_CUTOUT_BRUSH_ERASE_LABEL}
            pressed={props.brush.mode === "erase"}
            disabled={locked}
            onPress={() => props.onBrushModeChange("erase")}
          />
          <Pill
            label={PHOTO_EDITING_CUTOUT_BRUSH_RESTORE_LABEL}
            pressed={props.brush.mode === "restore"}
            disabled={locked}
            onPress={() => props.onBrushModeChange("restore")}
          />
        </div>
        <div className="mt-3">
          <PhotoEditingSlider
            id={brushSizeId}
            label={PHOTO_EDITING_CUTOUT_BRUSH_SIZE_LABEL}
            min={BRUSH_PERCENT_MIN}
            max={BRUSH_PERCENT_MAX}
            step={BRUSH_PERCENT_STEP}
            value={brushPercent}
            valueText={formatBrushPercent(brushPercent)}
            disabled={locked}
            // 筆の大きさは編集内容ではないので、動かしている間も替える（写真の上の輪が付いてくる）
            onChange={(value) => props.onBrushRadiusChange(value / 100)}
            onReset={() => props.onBrushRadiusChange(CUTOUT_BRUSH_RADIUS_DEFAULT)}
          />
        </div>
        <p className={cn(NOTE_CLASS_NAME, "mt-2")}>{PHOTO_EDITING_CUTOUT_BRUSH_HINT}</p>
      </section>
      <div className="mt-4">
        <button type="button" disabled={locked} onClick={props.onRemove} className={REMOVE_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_CUTOUT_REMOVE_LABEL}
        </button>
      </div>
    </div>
  );
}
