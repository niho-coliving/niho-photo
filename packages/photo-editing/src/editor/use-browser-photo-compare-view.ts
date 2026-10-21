"use client";

import { useState } from "react";

/**
 * 補正前と補正後を見比べる表示（niho-photo#41）。`off` = 今までどおりの 1 枚、`side` = 並べる（PC の面は左右、狭い幅・スマホの
 * 1 枚の編集の層は上下。補正前が左 / 上）、`split` = 1 枚を境界で分ける（PC の面だけ。境界の左が補正前）。
 *
 * 表示の状態だけを画面の中に持つ（補正の内容・取り消しの履歴・自動保存・端末の保存には触れない）。押している間だけの「補正前」
 * （`compareOriginal`）とは別の状態で、比較の間は「補正前」を使わない（面が止める）。
 */
export type BrowserPhotoCompareMode = "off" | "side" | "split";

/** 分割の境界の初めの位置（写真の幅に対する左からの %）。 */
export const BROWSER_PHOTO_COMPARE_SPLIT_INITIAL = 50;

/** キーで次に見せる表示（`Y` = 並べる ⇄ 戻す、`Shift+Y` = 分割 ⇄ 戻す。比較の間の `Y` はどちらからも戻す）。 */
export function nextBrowserPhotoCompareMode(
  current: BrowserPhotoCompareMode,
  key: "side" | "split",
): BrowserPhotoCompareMode {
  if (key === "side") return current === "off" ? "side" : "off";
  return current === "split" ? "off" : "split";
}

/** 境界の位置を 0〜100 の % に収める（数でなければ初めの位置）。 */
export function clampBrowserPhotoCompareSplit(value: number): number {
  if (!Number.isFinite(value)) return BROWSER_PHOTO_COMPARE_SPLIT_INITIAL;
  return Math.min(100, Math.max(0, value));
}

type CompareState = { scopeKey: string | null; mode: BrowserPhotoCompareMode; split: number };

const CLOSED: CompareState = { scopeKey: null, mode: "off", split: BROWSER_PHOTO_COMPARE_SPLIT_INITIAL };

/**
 * 比較の表示の状態。`scopeKey` は見比べている対象（開いている写真と、それを出している面）で、替わったら閉じる。`available` が
 * false の間（1 枚で直せる写真を開いていない・切り抜き / 背景除去の道具の間）は閉じ、使えるように戻っても自分では開き直さない。
 * 境界の位置は、並べる ⇄ 分割を行き来しても保ち、閉じたら初めの位置へ戻す。
 */
export function useBrowserPhotoCompareView(options: { scopeKey: string | null; available: boolean }) {
  const { scopeKey, available } = options;
  const [state, setState] = useState<CompareState>(CLOSED);
  const mode: BrowserPhotoCompareMode =
    available && scopeKey !== null && state.scopeKey === scopeKey ? state.mode : "off";
  // 閉じた（写真・面が替わった・使えなくなった）ら覚えている表示も捨てる（後から開き直さない）
  if (state.mode !== "off" && mode === "off") setState(CLOSED);

  const change = (next: BrowserPhotoCompareMode) => {
    if (next === "off") {
      setState(CLOSED);
      return;
    }
    if (!available || scopeKey === null) return;
    setState((current) => ({
      scopeKey,
      mode: next,
      split: current.mode !== "off" && current.scopeKey === scopeKey ? current.split : BROWSER_PHOTO_COMPARE_SPLIT_INITIAL,
    }));
  };

  return {
    mode,
    /** 分割の境界の位置（写真の幅に対する左からの %） */
    split: mode === "off" ? BROWSER_PHOTO_COMPARE_SPLIT_INITIAL : state.split,
    /** 見せ方を替える（メニュー・スマホの切り替え。`off` で閉じる） */
    change,
    /** キー（`Y` / `Shift+Y`）の切り替え */
    toggle: (key: "side" | "split") => change(nextBrowserPhotoCompareMode(mode, key)),
    /** 分割の境界を動かす（比較の間だけ） */
    setSplit: (value: number) =>
      setState((current) => (current.mode === "off" ? current : { ...current, split: clampBrowserPhotoCompareSplit(value) })),
  };
}

export type BrowserPhotoCompareView = ReturnType<typeof useBrowserPhotoCompareView>;
