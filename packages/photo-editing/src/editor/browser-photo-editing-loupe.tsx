"use client";

import { useEffect, useState, type CSSProperties, type MutableRefObject } from "react";

import { Spinner } from "niho-ui/components/spinner";
import type { DevelopGeometry, DevelopSize } from "../develop-engine/develop-geometry";
import type { CutoutPoint } from "../photo-cutout";
import {
  PHOTO_EDITING_COMPARE_ORIGINAL_LABEL,
  photoEditingPresetPreviewLabel,
} from "../photo-editing-copy";
import { cn } from "niho-ui/cn";

import { DEVELOP_PREVIEW_MAX_DIMENSION, type OpenedSource } from "./browser-photo-editing-model";
import { BrowserPhotoFavoriteButton, type BrowserPhotoFavoriteControl } from "./browser-photo-editing-favorite-button";
import { PhotoEditingCropOverlay } from "./photo-editing-crop-overlay";
import { PhotoEditingCutoutBrushOverlay } from "./photo-editing-cutout-brush-overlay";

/** 写真の左上の札（「補正前」・プリセットの仮の表示）。 */
const LOUPE_BADGE_CLASS_NAME =
  "pointer-events-none absolute left-3 top-3 rounded-full bg-niho-text/70 px-2.5 py-1 text-xs font-bold leading-none text-niho-surface lg:left-4 lg:top-4";

/**
 * 画（canvas・閲覧用の img）の拡大。スマホの 1 枚の編集の層が、写真の面に CSS 変数 `--photo-editing-zoom`
 * （`translate(…) scale(…)`）を書く（`usePhotoEditingZoom`。F6c 移行元設計）。変数が無い PC の面では none のまま。
 */
const ZOOMABLE_CLASS_NAME = "origin-center [transform:var(--photo-editing-zoom,none)]";

/**
 * 背景を透明にした写真の後ろの市松模様（背景除去。C4 移行元設計）。白と、本文の色を薄く混ぜた灰の 16px 角（色は globals.css の
 * token から作る。1 枚の模様は 2 × 2 の升なので 32px）。canvas の地に敷くので、写真の透明なところだけに見える。
 */
const CUTOUT_CHECKERBOARD_STYLE: CSSProperties = {
  backgroundColor: "white",
  backgroundImage:
    "repeating-conic-gradient(color-mix(in srgb, var(--niho-text) 10%, white) 0% 25%, transparent 0% 50%)",
  backgroundSize: "32px 32px",
};

/**
 * ブラウザ版の 1 枚の表示（段 2 の wasm・S1 の canvas で描く画、閲覧だけのプレビュー、直せない理由と読み込めなかったときの
 * 「もう一度読み込む」）。描くのは面の hook（canvas は `canvasRef` で渡す）。補正前を見せている間は左上に「補正前」の札
 * （読み上げは canvas の名前の切り替えに任せる）。拡大するのは画だけで、札・直せない理由・「もう一度読み込む」は拡大しない。
 * プリセットを仮に見せている間は、同じ場所に「<プリセット名> のプレビュー」の札。
 *
 * 切り抜きの道具の間（`crop`。F3b 移行元設計）は、canvas（面が枠全体を描く）を切り抜きの枠の部品の中に置く（枠はまっすぐ立ち、
 * 写真の方が回る）。道具を切り替えると canvas は置き直され、面が描き終えるまで前の道具の画を見せない。
 *
 * NIHO camera が背景除去の口を渡した面（`cutout`。C4 移行元設計。PC の面だけ）は、canvas をブラシの部品の中に置く（道具を開いて
 * いない間も同じ入れ物のまま。canvas を置き直さない）。背景を透明にした写真は、canvas の地に市松模様を敷く。
 */
export function BrowserPhotoEditingLoupe(props: {
  opened: OpenedSource | null;
  opening: boolean;
  /** 1 枚で見せる写真がある（読み込み中はスピナー。作業コピーを待つ写真は開いた瞬間からプレビュー） */
  openedVisible: boolean;
  /** opt-in性能計測: 閲覧用プレビューの読み込みが終わった写真を通知する。 */
  previewGeneration?: number | null;
  onPreviewLoaded?: (key: string, generation: number | null, element: HTMLImageElement) => void;
  onPreviewFailed?: (key: string, element: HTMLImageElement) => void;
  /** 保存済み補正と同じ版の補正後プレビューを表示している。 */
  previewAccurate?: boolean;
  compareOriginal: boolean;
  /** 仮に見せているプリセットの名前（無ければ null。F2b 移行元設計） */
  presetPreviewName: string | null;
  /** 切り抜きの道具を開いている間の、枠の部品に渡す値（開いていなければ null） */
  crop?: {
    geometry: DevelopGeometry;
    source: DevelopSize;
    liveAngle: number | null;
    disabled: boolean;
    onCommit: (geometry: DevelopGeometry) => void;
  } | null;
  /** 背景除去（NIHO camera が口を渡した面だけ。web は渡さない） */
  cutout?: {
    /** 写真をなぞれる（背景除去の道具を開いていて、レシピとマスクがある） */
    brushing: boolean;
    /** 背景を透明にして重ねている（市松模様を敷く） */
    transparent: boolean;
    /** 筆の半径（写真の短い辺に対する割合） */
    radius: number;
    disabled: boolean;
    onLiveStroke: (points: CutoutPoint[] | null) => void;
    onCommitStroke: (points: CutoutPoint[]) => void;
  } | null;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  lockedReason: string | null;
  sourceError: string | null;
  /** 読み込み直す（選んでいる写真が無ければ null） */
  onReload: (() => void) | null;
  /** 編集レイヤーを使わない狭幅loupeにも置く（お気に入りだけ可能な閲覧状態） */
  favorite?: BrowserPhotoFavoriteControl | null;
  /**
   * スマホの 1 枚の編集の層（F6c 移行元設計）では、拡大した画を層の写真の面の端まで見せるので、ここでは切り抜かない
   * （切り抜くのは層の写真の面）。地はどちらも白
   */
  unclipped?: boolean;
}) {
  const { opened, opening, openedVisible } = props;
  const [showCanonicalPending, setShowCanonicalPending] = useState(false);
  useEffect(() => {
    setShowCanonicalPending(false);
    if (!opened?.canonicalPending) return;
    const timer = window.setTimeout(() => setShowCanonicalPending(true), 300);
    return () => window.clearTimeout(timer);
  }, [opened?.canonicalPending, opened?.key]);
  const drawn = openedVisible && opened !== null && (Boolean(opened.decoded) || opened.mode === "wasm");
  const crop = props.crop ?? null;
  const cutout = props.cutout ?? null;
  const canvas =
    opened && !crop ? (
      <canvas
        ref={props.canvasRef}
        aria-label={props.compareOriginal ? `${opened.fileName} の補正前` : `${opened.fileName} のプレビュー`}
        className={cn("max-h-full max-w-full object-contain", ZOOMABLE_CLASS_NAME, opened.previewPending && "absolute inset-0 h-full w-full invisible")}
        style={cutout?.transparent ? CUTOUT_CHECKERBOARD_STYLE : undefined}
      />
    ) : null;
  return (
    <section
      aria-label="写真プレビュー"
      className={cn("absolute inset-0 flex items-center justify-center bg-white", props.unclipped ? null : "overflow-hidden")}
    >
      {opening && !openedVisible ? <Spinner size="lg" label="写真を読み込み中" /> : null}
      {drawn && opened && crop ? (
        <PhotoEditingCropOverlay
          geometry={crop.geometry}
          source={crop.source}
          liveAngle={crop.liveAngle}
          disabled={crop.disabled}
          maxLongEdge={Math.min(DEVELOP_PREVIEW_MAX_DIMENSION, Math.max(crop.source.width, crop.source.height))}
          onCommit={crop.onCommit}
        >
          <canvas ref={props.canvasRef} aria-label={`${opened.fileName} のプレビュー`} className={cn("block h-full w-full", opened.previewPending && "invisible")} />
        </PhotoEditingCropOverlay>
      ) : null}
      {drawn && canvas && cutout ? (
        <PhotoEditingCutoutBrushOverlay
          enabled={cutout.brushing}
          radius={cutout.radius}
          disabled={cutout.disabled}
          targetRef={props.canvasRef}
          onLiveStroke={cutout.onLiveStroke}
          onCommitStroke={cutout.onCommitStroke}
        >
          {canvas}
        </PhotoEditingCutoutBrushOverlay>
      ) : null}
      {drawn && canvas && !cutout ? canvas : null}
      {drawn && !opened?.previewPending && props.compareOriginal ? (
        <span aria-hidden data-testid="photo-compare-original-badge" className={LOUPE_BADGE_CLASS_NAME}>
          {PHOTO_EDITING_COMPARE_ORIGINAL_LABEL}
        </span>
      ) : null}
      {drawn && !opened?.previewPending && !props.compareOriginal && props.presetPreviewName !== null ? (
        <span aria-hidden data-testid="photo-preset-preview-badge" className={LOUPE_BADGE_CLASS_NAME}>
          {photoEditingPresetPreviewLabel(props.presetPreviewName)}
        </span>
      ) : null}
      {openedVisible && opened && !opened.decoded && (opened.mode !== "wasm" || opened.previewPending) && opened.viewUrl ? (
        // 閲覧だけに使う画像（プレビュー・記事用の画像）。補正の入力にはしない。作業コピーを待っている間のプレビュー
        // （長辺 1024px）は、差し替える画（長辺 1280px）と同じ大きさに見せる（差し替えで大きさが跳ねない）
        <img
          src={opened.viewUrl}
          onLoad={(event) => props.onPreviewLoaded?.(opened.key, props.previewGeneration ?? null, event.currentTarget)}
          onError={(event) => props.onPreviewFailed?.(opened.key, event.currentTarget)}
          alt={props.previewAccurate ? `${opened.fileName} の補正後プレビュー` : opened.previewPending ? `${opened.fileName} の仮のプレビュー（調整はまだ反映されていません）` : `${opened.fileName} の閲覧用プレビュー`}
          className={cn("max-h-full max-w-full object-contain", ZOOMABLE_CLASS_NAME, (opened.work || opened.previewPending) && "h-[1280px] w-[1280px]")}
        />
      ) : null}
      {openedVisible && opened?.previewPending && !props.previewAccurate ? (
        <span role="status" className={LOUPE_BADGE_CLASS_NAME}>補正を反映中</span>
      ) : null}
      {openedVisible && showCanonicalPending && opened?.canonicalPending ? (
        <span role="status" className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-white/90 px-3 py-1.5 text-xs font-bold text-niho-text-sub shadow-sm">
          高画質表示を準備中
        </span>
      ) : null}
      {openedVisible && opened && !opened.decoded && (opened.mode !== "wasm" || opened.previewPending) && !opened.viewUrl ? (
        <p className="break-all px-6 text-center text-body font-bold text-niho-text-muted">{opened.fileName}</p>
      ) : null}
      {!opening && props.lockedReason ? (
        <p className={cn("absolute left-3 top-3 w-fit max-w-full rounded-2xl bg-white/95 px-3 py-2 text-xs font-bold leading-relaxed text-niho-text-sub shadow-sm lg:left-4 lg:top-4", props.favorite ? "right-16" : "right-3")}>
          {props.lockedReason}
        </p>
      ) : null}
      {props.favorite ? (
        <BrowserPhotoFavoriteButton
          {...props.favorite}
          className="absolute right-3 top-3 z-10 bg-white/95 shadow-sm lg:hidden"
        />
      ) : null}
      {!opening && props.sourceError ? (
        <div className="absolute inset-x-4 bottom-4 rounded-xl bg-white/95 p-3 shadow-sm">
          <p role="alert" className="text-sub font-bold text-niho-danger">{props.sourceError}</p>
          {props.onReload ? (
            <button
              type="button"
              onClick={props.onReload}
              className="mt-2 min-h-11 text-sub font-bold text-niho-accent-ink"
            >
              もう一度読み込む
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
