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
