"use client";

import { useEffect, useState, type MutableRefObject } from "react";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";

/** プリセットの適用量・今の補正の保存・見本を出せる wasm か（F2a 移行元設計 の口）。 */
export type BrowserPhotoPresetSupport = { amount: boolean; settingsToXmp: boolean; thumbnails: boolean };

const UNSUPPORTED: BrowserPhotoPresetSupport = { amount: false, settingsToXmp: false, thumbnails: false };

/** 確かめる（無い口・失敗は false。古い engine で関数が無くても投げない）。 */
function check(read: () => Promise<boolean>): Promise<boolean> {
  return Promise.resolve()
    .then(read)
    .then(
      (value) => value === true,
      () => false,
    );
}

/**
 * ブラウザ版の右パネルのプリセットに、適用量・「今の補正をプリセットに保存」・見本を出せるか（NIHO Photo 段 1 F2b 移行元設計）。
 *
 * 口は公開済みの wasm に無いことがある（crate 0.5.0 から）。wasm で開いた写真を 1 枚で見ているときに 1 回だけ確かめ、使えると
 * 分かってから出す。確かめている間・使えない wasm・wasm を使えないときは全部 false（今の行のまま）。結果は画面を開いている間
 * 覚える（engine は面に 1 つで、読み込む版は変わらない。次の写真を開いている途中も行の形を変えない）。
 */
export function useBrowserPhotoPresetSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
}): BrowserPhotoPresetSupport {
  const { mountedRef, engineRef, photoKey } = params;
  const [support, setSupport] = useState<BrowserPhotoPresetSupport | null>(null);

  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || support !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    void Promise.all([
      check(() => engine.supportsPresetAmount()),
      check(() => engine.supportsSettingsToXmp()),
      check(() => engine.supportsPresetThumbnails()),
    ]).then(([amount, settingsToXmp, thumbnails]) => {
      if (!cancelled && mountedRef.current) setSupport({ amount, settingsToXmp, thumbnails });
    });
    return () => {
      cancelled = true;
    };
    // 写真が替わっても（`photoKey`）、まだ確かめていなければ確かめる
  }, [engineRef, mountedRef, photoKey, support, wanted]);

  return support ?? UNSUPPORTED;
}
