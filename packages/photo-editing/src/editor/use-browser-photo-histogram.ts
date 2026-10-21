"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { DevelopFrame } from "../develop-engine/develop-engine-client";
import { computePhotoEditingHistogram, type PhotoEditingHistogram } from "../photo-editing-histogram";

/**
 * 画面に描いた 1 枚の画（develop-engine が返した sRGB 8bit RGBA）を受け取る口。`useBrowserPhotoOpen` が canvas に描くたびに
 * （写真の key と一緒に）呼ぶ。画を渡すだけで、数えるのは {@link useBrowserPhotoHistogram}。
 */
export type PhotoEditingFrameSink = (key: string, frame: DevelopFrame) => void;

/**
 * 数え直す間隔の下限（ms）。つまみを動かしている間は画が次々に来るので、最新の 1 枚だけを間隔を空けて数える（遅れても画面の
 * 描画は止めない。1280px の画は数 ms で数え終わるので、つまみを動かして 200ms 以内には追いつく）。
 */
export const PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS = 50;

export type BrowserPhotoClipState = { shadows: boolean; highlights: boolean };

/**
 * 右パネルのヒストグラム（niho-photo#36）の持ち主。`sinkRef` に入れた口で最新の画を受け取り、`enabled` の間だけ数えて
 * `histogram` に出す（画は写真の key ごとに持ち、今の写真〔`photoKey`〕の分だけ返す）。写真を替えた・閉じたら捨てる。
 *
 * クリップ領域の印を写真に重ねるか（`clip`。黒つぶれ / 白飛び）もここで持つ。表示の状態であって補正値ではないので、履歴・
 * 自動保存・`developSettings` には触れず、写真を替えても保つ（再読み込みで戻る）。どちらかが ON の間だけ、重ねる印も数える。
 */
export function useBrowserPhotoHistogram(params: {
  sinkRef: MutableRefObject<PhotoEditingFrameSink | null>;
  /** 今開いている写真の key（無ければ null） */
  photoKey: string | null;
  /** 数えてよい（PC の右パネルにヒストグラムを出している間） */
  enabled: boolean;
}) {
  const { sinkRef, photoKey, enabled } = params;
  const [clip, setClip] = useState<BrowserPhotoClipState>({ shadows: false, highlights: false });
  const [counted, setCounted] = useState<{ key: string; histogram: PhotoEditingHistogram } | null>(null);
  const wantMask = clip.shadows || clip.highlights;

  const latestRef = useRef<{ key: string; frame: DevelopFrame } | null>(null);
  /** 数え終えた画（同じ画・同じ印の要否なら数え直さない） */
  const countedRef = useRef<{ frame: DevelopFrame; mask: boolean } | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastRunAtRef = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const wantMaskRef = useRef(wantMask);
  wantMaskRef.current = wantMask;
  const photoKeyRef = useRef(photoKey);
  photoKeyRef.current = photoKey;

  const run = useCallback(() => {
    timerRef.current = null;
    const latest = latestRef.current;
    if (!latest || !enabledRef.current || latest.key !== photoKeyRef.current) return;
    const mask = wantMaskRef.current;
    const done = countedRef.current;
    if (done && done.frame === latest.frame && done.mask === mask) return;
    lastRunAtRef.current = Date.now();
    const histogram = computePhotoEditingHistogram(latest.frame.rgba, latest.frame.width, latest.frame.height, { mask });
    countedRef.current = { frame: latest.frame, mask };
    setCounted({ key: latest.key, histogram });
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    const wait = Math.max(0, lastRunAtRef.current + PHOTO_EDITING_HISTOGRAM_MIN_INTERVAL_MS - Date.now());
    timerRef.current = window.setTimeout(run, wait);
  }, [run]);

  // 口を渡す。画は常に最新の 1 枚だけ覚える（数えるのは `enabled` の間だけ）
  useEffect(() => {
    sinkRef.current = (key, frame) => {
      latestRef.current = { key, frame };
      if (enabledRef.current) schedule();
    };
    return () => {
      sinkRef.current = null;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [schedule, sinkRef]);

  // 写真を替えた・閉じた: 前の写真の画と分布を捨てる（先に来ていた新しい写真の画は、写真の key が追いついたので数える）
  useEffect(() => {
    if (latestRef.current && latestRef.current.key !== photoKey) {
      latestRef.current = null;
      countedRef.current = null;
    } else if (latestRef.current && enabledRef.current) {
      schedule();
    }
    setCounted((current) => (current && current.key === photoKey ? current : null));
  }, [photoKey, schedule]);

  // 出し始めた・印を重ね始めた / やめた: 覚えている最新の画から数える（次の描画を待たない）
  useEffect(() => {
    if (enabled) {
      schedule();
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [enabled, wantMask, schedule]);

  const toggleShadows = useCallback(() => setClip((current) => ({ ...current, shadows: !current.shadows })), []);
  const toggleHighlights = useCallback(() => setClip((current) => ({ ...current, highlights: !current.highlights })), []);
  /** J: どちらかが ON なら両方 OFF、両方 OFF なら両方 ON */
  const toggleBoth = useCallback(
    () => setClip((current) => (current.shadows || current.highlights ? { shadows: false, highlights: false } : { shadows: true, highlights: true })),
    [],
  );

  return {
    /** 今の写真の分布（まだ数えていない・出していない間は null） */
    histogram: counted && counted.key === photoKey ? counted.histogram : null,
    clip,
    toggleShadows,
    toggleHighlights,
    toggleBoth,
  };
}
