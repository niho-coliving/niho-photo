"use client";

import { useEffect, useState } from "react";

import type { PhotoEditingSettingsAutosave } from "./photo-editing-settings-autosave";

/**
 * 写真編集の作業中は、ページを離れる・閉じる前に確かめる（移行元設計、`beforeunload`）。作業中とは
 *
 * - 自動保存の待ち（送り終えていない保存・「初期化」がある。`getAutosave()` の `hasPendingWork`）
 * - クラウドへ入れている途中・一括の書き出し中・記事に入れている途中（呼び出し側が `working` で渡す）
 *
 * 作業中の間だけ handler を登録し、作業が無くなったら外す（ほかの画面の未保存ガードと同じ書き方）。NIHO Desktop は
 * ウィンドウを閉じる前に `beforeunload` を合成して、登録されている handler で判定する（移行元設計）。
 * 閉じるときに待っている保存を送り切るのは今までどおり `pagehide`（workbench の release）。
 */
export function usePhotoEditingUnloadGuard(options: {
  getAutosave: () => PhotoEditingSettingsAutosave;
  working: boolean;
}): void {
  const { getAutosave, working } = options;
  const [savesPending, setSavesPending] = useState(false);

  useEffect(() => {
    const autosave = getAutosave();
    const sync = () => setSavesPending(autosave.hasPendingWork());
    sync();
    return autosave.subscribe(sync);
  }, [getAutosave]);

  const guarded = working || savesPending;
  useEffect(() => {
    if (!guarded) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [guarded]);
}
