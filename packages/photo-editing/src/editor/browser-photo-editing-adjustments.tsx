"use client";

import type { ReactNode } from "react";
import { MoreHorizontal, Redo2, Undo2, WandSparkles } from "lucide-react";

import type { PhotoEditingSettings } from "../photo-editing-types";
import {
  workWaitText,
  type WorkWait,
} from "../develop-engine/develop-work-wait";
import type { PhotoEditingControlKey } from "../photo-editing-adjustments";
import {
  BROWSER_PHOTO_EDITING_READ_ONLY_TEXT,
  PHOTO_EDITING_AUTO_LABEL,
  PHOTO_EDITING_AUTO_TITLE,
  PHOTO_EDITING_COPY_SETTINGS_LABEL,
  PHOTO_EDITING_COPY_SETTINGS_SHORTCUT,
  PHOTO_EDITING_GRAYSCALE_LABEL,
  PHOTO_EDITING_PASTE_SETTINGS_LABEL,
  PHOTO_EDITING_PASTE_SETTINGS_SHORTCUT,
  PHOTO_EDITING_PRESETS_TITLE,
  PHOTO_EDITING_QUICK_ACTIONS_LABEL,
  PHOTO_EDITING_REDO_LABEL,
  PHOTO_EDITING_REDO_TITLE,
  PHOTO_EDITING_RESET_DONE_TEXT,
  PHOTO_EDITING_RESET_LABEL,
  PHOTO_EDITING_RESET_UNDO_LABEL,
  PHOTO_EDITING_RETRY_LABEL,
  PHOTO_EDITING_SETTINGS_MENU_LABEL,
  PHOTO_EDITING_TOOL_ADJUST_LABEL,
  PHOTO_EDITING_TOOL_CROP_LABEL,
  PHOTO_EDITING_TOOL_CUTOUT_LABEL,
  PHOTO_EDITING_TOOL_INFO_LABEL,
  PHOTO_EDITING_UNDO_LABEL,
  PHOTO_EDITING_UNDO_TITLE,
} from "../photo-editing-copy";
import { readGrayscale, writeGrayscale } from "../photo-editing-effects";

import {
  BROWSER_WHITE_BALANCE_SOURCE,
  type BrowserPhotoAdjustPanel,
  type BrowserPhotoPresetsVariant,
  type BrowserPhotoTool,
} from "./browser-photo-editing-model";
import {
  PhotoEditingAdjustmentGroups,
  type PhotoEditingSettingsUpdate,
  type PhotoEditingSliderPhase,
} from "./photo-editing-adjustment-controls";
import { PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME } from "./photo-editing-button-classes";
import { PhotoEditingMenu } from "./photo-editing-menu";

const HISTORY_BUTTON_CLASS_NAME =
  "flex h-11 w-11 items-center justify-center rounded-full text-niho-text-sub transition hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";
const TEXT_ACTION_BUTTON_CLASS_NAME = "min-h-11 px-2 text-xs font-bold text-niho-accent-ink disabled:opacity-40";
/** 補正の面の一番上のチップ（自動 / 白黒）。押された表示は `aria-pressed` で地の色を変える */
const QUICK_CHIP_CLASS_NAME =
  "inline-flex h-7 items-center gap-1 rounded-lg border border-niho-border px-3 text-xs font-bold text-niho-text-sub transition enabled:hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink aria-pressed:border-transparent aria-pressed:bg-niho-accent-soft aria-pressed:text-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-40";
const ASIDE_CLASS_NAME =
  "hidden min-h-0 overflow-y-auto border-l border-niho-border bg-[var(--photo-editing-surface,white)] px-3 py-2 lg:block";
/** ヒストグラムを置くときは、上の余白をヒストグラムの枠（sticky）の中に持たせる（下だけ py-2 と同じ） */
const ASIDE_WITH_HISTOGRAM_CLASS_NAME =
  "hidden min-h-0 overflow-y-auto border-l border-niho-border bg-[var(--photo-editing-surface,white)] px-3 pb-2 lg:block";
/** 見出し行の名前（道具の名前。「補正」の間はプリセットの面なら「プリセット」） */
const TOOL_LABELS: Readonly<Record<BrowserPhotoTool, string>> = {
  adjust: PHOTO_EDITING_TOOL_ADJUST_LABEL,
  crop: PHOTO_EDITING_TOOL_CROP_LABEL,
  cutout: PHOTO_EDITING_TOOL_CUTOUT_LABEL,
};

/*
 * 右端の道具の帯（niho-photo#51）で変わった点（下の説明より優先する）: 道具の切り替え（補正 / 切り抜き / 背景除去のピル）は右パネルに
 * 置かず、右端の帯（`BrowserPhotoEditingToolRail`。並べるのは呼ぶ側）で右パネルを丸ごと入れ替える。一番上は見出し行（左に今の面の
 * 名前、右に ↶ ↷ ⋯ と「初期化」）。「補正」の面は 見出し行 → 自動 / 白黒のチップ → プリセットの行 → ライト / カラー / 効果、
 * 「プリセット」の面は 見出し行 → プリセットの一覧。白黒は群の中に描かず、チップで切り替える。
 *
 * ヒストグラム（niho-photo#36。`histogram` を渡したときだけ）は、どの道具・面のときも見出し行の上、パネルの一番上に置く
 * （パネルを送っても上端に残す）。
 *
 * 「情報」の面（niho-photo#43。`panel` が `info` で `info` を渡したとき）は 見出し行（名前だけ）→ 情報の群。写真を直す面ではないので、
 * ↶ ↷ ⋯・「初期化」・作業コピーの状態・閲覧のみの 1 行は出さない（キーの取り消し・やり直しは今までどおり効く）。ヒストグラムは
 * ほかの面と同じく一番上に残す（撮影条件と分布を一緒に見る。白飛び・黒つぶれの印の切り替えも消さない）。
 */

/**
 * ブラウザ版の右パネル（NIHO Photo 段 1 F1 移行元設計）。スライダーは NIHO Desktop と共通の群の部品（ライト／カラー／効果）で描き、
 * wasm で開いた写真は 13 項目を全部、S1 の canvas は 5 項目（露光量・コントラスト・彩度と相対の色温度・色かぶり補正）だけを
 * 見せる。効果を描ける wasm で開いた写真は、白黒・周辺光量補正・粒子・粒子のサイズも見せる（E1b 移行元設計。出し分けは呼ぶ側）。見出しは置かず（群名が兼ねる）、一番上の行の左に取り消す・やり直すと ⋯（補正のメニュー: 補正をコピー / 貼り付け。F5a-2 移行元設計）、右に「初期化」（押した後は「初期化しました」と「元に戻す」）。作業コピーを待っている間はその下に状態と「再試行」。その下（群の上）にプリセットの節（wasm で開く写真だけ。F2b 移行元設計）。
 *
 * 切り抜きの道具を使える写真（F3b 移行元設計）は、一番上に「補正 / 切り抜き」の切り替えを置く。「切り抜き」の間は、プリセットの節と
 * 群の代わりに切り抜きの道具（`cropTools`）を出す（↶ ↷ はどちらでも効く。「初期化」は切り抜きだけを戻す。出し分けは呼ぶ側）。
 * NIHO camera が背景除去の口を渡した写真（C4 移行元設計）は、切り替えに「背景除去」を足し、その間は同じ場所に背景除去の道具
 * （`cutoutTools`）を出す。切り替えに並べるのは、その写真で使える道具だけ（`tool.tools`。出し分けは呼ぶ側）。
 *
 * 「自動」（F4b 移行元設計。`auto` を渡したときだけ）はライトの群の見出しの横の小さな文字のボタン。押された表示（当てた結果のまま）は
 * `aria-pressed` と地の色で示し、もう一度押すと押す前に戻す。
 */
export function BrowserPhotoEditingAdjustments(props: {
  canEdit: boolean;
  /** 何か当てている（「初期化」を出す） */
  canReset: boolean;
  /** 「初期化」を押した直後（「初期化しました」と「元に戻す」を出す） */
  resetDone: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** スライダー・取り消し・「初期化」を押せない（閲覧のみ・入力を開けていない・書き出し / 消している途中・離れる処理の途中） */
  controlsDisabled: boolean;
  /** 書き出し・消している途中 */
  busy: boolean;
  /** 作業コピーを待っている間の状態 */
  work: WorkWait | null;
  /** RAW の写真か（待ち文言の語彙を切り替える） */
  raw: boolean;
  /** スライダーに見せる値（編集中の `developSettings`） */
  settings: PhotoEditingSettings;
  /** 見せる項目（省略時は基本の 13 項目。S1 の canvas は 5 項目、効果を描ける wasm の写真は効果の項目も入れて渡す） */
  visibleKeys?: ReadonlyArray<PhotoEditingControlKey>;
  /** Oklch の独立した色ミキサー（対応する wasm の写真だけ）。 */
  colorMixer?: ReactNode;
  /**
   * 一番上のヒストグラム（niho-photo#36。画を描ける wasm の写真だけ渡す）。道具・面〔補正 / プリセット / 切り抜き / 背景除去〕に
   * 依らず見出し行の上に出し、パネルを送っても上端に残す
   */
  histogram?: ReactNode;
  /**
   * プリセットの部品（S1 の canvas の写真には渡さない）。補正の面では群の上の 1 行（`row`。押すと `onOpenPresets`）、プリセットの面
   * では一覧（`panel`）として、どちらか一方だけを描く
   */
  presets?: (view: { variant: BrowserPhotoPresetsVariant; onOpenPanel?: () => void }) => ReactNode;
  /** 今の道具（右端の帯で選ぶ。省略時は補正） */
  tool?: BrowserPhotoTool;
  /** 道具が「補正」の間に出す面（省略時は補正の面。プリセットの部品が無い写真は補正の面だけ） */
  panel?: BrowserPhotoAdjustPanel;
  /** 「情報」の面の中身（niho-photo#43。`panel` が `info` の間だけ描く。渡さなければ情報の面は出さない） */
  info?: ReactNode;
  /** プリセットの行から、プリセットの面を開く */
  onOpenPresets?: () => void;
  /** 切り抜きの道具（「切り抜き」の間、プリセットの節と群の代わりに出す） */
  cropTools?: ReactNode;
  /** 背景除去の道具（「背景除去」の間、プリセットの節と群の代わりに出す。NIHO camera だけ） */
  cutoutTools?: ReactNode;
  /** 「自動」（口のある wasm で開いた写真だけ渡す。省くとボタンを出さない） */
  auto?: { pressed: boolean; disabled: boolean; onToggle: () => void; onWarm?: () => void };
  /** 補正のコピー / 貼り付け（⋯ のメニュー。wasm で開いた写真だけ渡す。写せない・当てられない項目は押せない） */
  clipboard?: { canCopy: boolean; canPaste: boolean; onCopy: () => void; onPaste: () => void };
  onReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRetryWork: () => void;
  onSettingsChange: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
}) {
  const work = props.work;
  const workText = work ? workWaitText(work, props.raw) : null;
  const tool = props.tool ?? "adjust";
  const cropping = tool === "crop" && props.cropTools !== undefined;
  const cutting = tool === "cutout" && props.cutoutTools !== undefined;
  const presets = props.presets;
  // プリセットの部品が無い写真（S1 の canvas）は、補正の面だけ
  const showPresetsPanel = !cropping && !cutting && presets !== undefined && props.panel === "presets";
  if (!cropping && !cutting && props.info !== undefined && props.panel === "info") {
    // 情報の面: 見出し行は名前だけ（ヒストグラムの置き方は下の補正の面と同じ）
    return (
      <aside
        aria-label={PHOTO_EDITING_TOOL_INFO_LABEL}
        className={props.histogram ? ASIDE_WITH_HISTOGRAM_CLASS_NAME : ASIDE_CLASS_NAME}
      >
        {props.histogram ? (
          <div className="sticky top-0 z-10 -mx-3 bg-[var(--photo-editing-surface,white)] px-3 pb-1 pt-2">{props.histogram}</div>
        ) : null}
        <div className="flex min-h-11 items-center gap-1">
          <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-niho-text">{PHOTO_EDITING_TOOL_INFO_LABEL}</h2>
        </div>
        {props.info}
      </aside>
    );
  }
  const heading = cropping
    ? TOOL_LABELS.crop
    : cutting
      ? TOOL_LABELS.cutout
      : showPresetsPanel
        ? PHOTO_EDITING_PRESETS_TITLE
        : TOOL_LABELS.adjust;
  const auto = props.auto;
  // 白黒のチップは、効果を描ける wasm の写真（`visibleKeys` に白黒が入っている）だけ
  const grayscaleChip = props.visibleKeys?.includes("grayscale") === true;
  const grayscalePressed = readGrayscale(props.settings);
  const quickRow =
    auto || grayscaleChip ? (
      <div role="group" aria-label={PHOTO_EDITING_QUICK_ACTIONS_LABEL} className="mb-1 flex gap-1.5">
        {auto ? (
          <button
            type="button"
            aria-pressed={auto.pressed}
            title={PHOTO_EDITING_AUTO_TITLE}
            disabled={auto.disabled}
            onClick={auto.onToggle}
            // 押す前に結果の計算を始める（押して 300ms 以内に画を変える）
            onPointerEnter={auto.onWarm}
            onPointerDown={auto.onWarm}
            onFocus={auto.onWarm}
            className={QUICK_CHIP_CLASS_NAME}
          >
            <WandSparkles className="h-3.5 w-3.5" aria-hidden />
            {PHOTO_EDITING_AUTO_LABEL}
          </button>
        ) : null}
        {grayscaleChip ? (
          <button
            type="button"
            aria-pressed={grayscalePressed}
            disabled={props.controlsDisabled}
            onClick={() => props.onSettingsChange((current) => writeGrayscale(current, !grayscalePressed), "commit")}
            className={QUICK_CHIP_CLASS_NAME}
          >
            {PHOTO_EDITING_GRAYSCALE_LABEL}
          </button>
        ) : null}
      </div>
    ) : null;
  return (
    <aside aria-label="補正" className={props.histogram ? ASIDE_WITH_HISTOGRAM_CLASS_NAME : ASIDE_CLASS_NAME}>
      {props.histogram ? (
        // パネルの上端に固定する（補正しながら見る。下の群を送っても残る）。sticky の上端がパネルの上の余白に左右されないよう、
        // パネルの上の余白（py-2 の上）は持たず、ここの pt-2 に置く
        <div className="sticky top-0 z-10 -mx-3 bg-[var(--photo-editing-surface,white)] px-3 pb-1 pt-2">{props.histogram}</div>
      ) : null}
      {/* 見出し行: 左に今の面の名前、右に ↶ ↷ ⋯ と「初期化」 */}
      <div className="flex min-h-11 items-center gap-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-niho-text">{heading}</h2>
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={PHOTO_EDITING_UNDO_LABEL}
            title={PHOTO_EDITING_UNDO_TITLE}
            disabled={props.controlsDisabled || !props.canUndo}
            onClick={props.onUndo}
            className={HISTORY_BUTTON_CLASS_NAME}
          >
            <Undo2 className="h-[18px] w-[18px]" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={PHOTO_EDITING_REDO_LABEL}
            title={PHOTO_EDITING_REDO_TITLE}
            disabled={props.controlsDisabled || !props.canRedo}
            onClick={props.onRedo}
            className={HISTORY_BUTTON_CLASS_NAME}
          >
            <Redo2 className="h-[18px] w-[18px]" aria-hidden />
          </button>
          {props.clipboard ? (
            <PhotoEditingMenu
              items={[
                {
                  key: "copy",
                  label: PHOTO_EDITING_COPY_SETTINGS_LABEL,
                  shortcut: PHOTO_EDITING_COPY_SETTINGS_SHORTCUT,
                  disabled: !props.clipboard.canCopy,
                  onSelect: props.clipboard.onCopy,
                },
                {
                  key: "paste",
                  label: PHOTO_EDITING_PASTE_SETTINGS_LABEL,
                  shortcut: PHOTO_EDITING_PASTE_SETTINGS_SHORTCUT,
                  disabled: !props.clipboard.canPaste,
                  onSelect: props.clipboard.onPaste,
                },
              ]}
            >
              <button
                type="button"
                aria-label={PHOTO_EDITING_SETTINGS_MENU_LABEL}
                aria-haspopup="menu"
                title={PHOTO_EDITING_SETTINGS_MENU_LABEL}
                className={HISTORY_BUTTON_CLASS_NAME}
              >
                <MoreHorizontal className="h-[18px] w-[18px]" aria-hidden />
              </button>
            </PhotoEditingMenu>
          ) : null}
        </div>
        {props.resetDone ? (
          <div className="flex min-w-0 items-center gap-1">
            <p role="status" className="min-w-0 truncate text-xs font-bold text-niho-text-sub">
              {PHOTO_EDITING_RESET_DONE_TEXT}
            </p>
            <button
              type="button"
              disabled={props.controlsDisabled || !props.canUndo}
              onClick={props.onUndo}
              className={TEXT_ACTION_BUTTON_CLASS_NAME}
            >
              {PHOTO_EDITING_RESET_UNDO_LABEL}
            </button>
          </div>
        ) : props.canReset ? (
          <button
            type="button"
            disabled={props.controlsDisabled}
            onClick={props.onReset}
            className={TEXT_ACTION_BUTTON_CLASS_NAME}
          >
            {PHOTO_EDITING_RESET_LABEL}
          </button>
        ) : null}
      </div>
      {work?.phase === "preparing" && workText ? (
        <p role="status" className="py-2 text-xs font-bold text-niho-text-sub">
          {workText}
        </p>
      ) : null}
      {work?.phase === "failed" && workText ? (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="min-w-0 text-xs font-bold text-niho-text-sub">{workText}</p>
          <button
            type="button"
            disabled={!props.canEdit || work.retrying || props.busy}
            onClick={props.onRetryWork}
            className={PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME}
          >
            {PHOTO_EDITING_RETRY_LABEL}
          </button>
        </div>
      ) : null}
      {cropping ? (
        props.cropTools
      ) : cutting ? (
        props.cutoutTools
      ) : showPresetsPanel ? (
        presets?.({ variant: "panel" })
      ) : (
        <>
          {quickRow}
          {presets?.({ variant: "row", onOpenPanel: props.onOpenPresets })}
          <PhotoEditingAdjustmentGroups
            settings={props.settings}
            photo={BROWSER_WHITE_BALANCE_SOURCE}
            disabled={props.controlsDisabled}
            visibleKeys={props.visibleKeys}
            // 白黒は一番上のチップで切り替える（群の中には描かない。白黒の間に彩度を押せなくするのは群のまま）
            grayscaleToggle="hidden"
            onSettingsChange={props.onSettingsChange}
          />
          {props.colorMixer}
        </>
      )}
      {!props.canEdit ? <p className="mt-3 text-xs text-niho-text-muted">{BROWSER_PHOTO_EDITING_READ_ONLY_TEXT}</p> : null}
    </aside>
  );
}
