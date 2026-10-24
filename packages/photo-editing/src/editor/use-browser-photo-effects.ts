"use client";

import { useEffect, useState, type MutableRefObject } from "react";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";

/**
 * ブラウザ版の右パネルに効果の項目（白黒・周辺光量補正・粒子。NIHO Photo 段 1 E1b 移行元設計）を出せるか。
 *
 * 効果のある設定は `v: 3` で保存する。`v: 3` を読めない wasm は描画を断る（保存しても描けない写真ができる。移行元設計）ので、
 * wasm で開いた写真を 1 枚で見ているときに 1 回だけ確かめ（`engine.supportsEffects()`）、読めると分かってから出す。確かめている
 * 間・読めない wasm・wasm を使えないときは false（右パネルは今までの 13 項目のまま）。結果は画面を開いている間覚える（engine は
 * 面に 1 つで、読み込む版は変わらない。次の写真を開いている途中も true のままにして、右パネルの行を出し入れしない）。
 */
export function useBrowserPhotoEffectsSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
}): boolean {
  const { mountedRef, engineRef, photoKey } = params;
  /** 効果を描ける wasm か（確かめるまで null） */
  const [supported, setSupported] = useState<boolean | null>(null);

  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    engine.supportsEffects().then(
      (value) => {
        if (!cancelled && mountedRef.current) setSupported(value === true);
      },
      () => {
        if (!cancelled && mountedRef.current) setSupported(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // 写真が替わっても（`photoKey`）、まだ確かめていなければ確かめる
  }, [engineRef, mountedRef, photoKey, supported, wanted]);

  return supported === true;
}

/** v4 の色ミキサーを描ける wasm と確認できた写真だけに操作を出す。 */
export function useBrowserPhotoColorPointsSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
}): boolean {
  return useEngineSupport(params, "colorPoints");
}

/**
 * ディテール（シャープ・ノイズ軽減。Issue #32）の項目を出せるか。ディテールのある設定は `v: 6` で保存するので、効果と同じく
 * 起こした wasm が読めると確かめてから出す（確かめている間・読めない wasm・wasm を使えないときは false）。
 */
export function useBrowserPhotoDetailSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
}): boolean {
  return useEngineSupport(params, "detail");
}

/**
 * 「レンズ」の節（レンズ補正。niho-photo#45）を出せるか。レンズ補正のある設定は `v: 9` で保存するので、ディテールと同じく起こした
 * wasm が読めると確かめてから出す（確かめている間・読めない wasm・wasm を使えないときは false）。
 */
export function useBrowserPhotoLensSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
}): boolean {
  return useEngineSupport(params, "lens");
}

/** 写真を 1 枚で見ているときに 1 回だけ wasm の口を確かめ、画面を開いている間覚える。 */
function useEngineSupport(
  params: {
    mountedRef: MutableRefObject<boolean>;
    engineRef: MutableRefObject<DevelopEngine | null>;
    photoKey: string | null;
  },
  capability: "colorPoints" | "detail" | "lens",
): boolean {
  const { mountedRef, engineRef, photoKey } = params;
  const [supported, setSupported] = useState<boolean | null>(null);
  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    // レンズの口は新しいので、確かめられない engine（口の無い差し替え）は使えない扱い（編集は止めない）
    const check =
      capability === "lens"
        ? Promise.resolve().then(() => engine.supportsLens())
        : capability === "detail"
          ? engine.supportsDetail()
          : engine.supportsColorPoints();
    check.then(
      (value) => {
        if (!cancelled && mountedRef.current) setSupported(value === true);
      },
      () => {
        if (!cancelled && mountedRef.current) setSupported(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [capability, engineRef, mountedRef, photoKey, supported, wanted]);
  return supported === true;
}
