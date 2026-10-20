"use client";

import { useCallback, useRef, useState, type MutableRefObject } from "react";

import type { DevelopSettings } from "../develop-engine/develop-settings";

import { ensureOriginalWorkingSize } from "./browser-photo-editing-open-flow";
import type { BrowserPhotoDevelop } from "./use-browser-photo-develop";

/**
 * 開いている写真の wasm の作業サイズを、編集内容の切り抜きに合わせる（F3 移行元設計）。オリジナル（JPEG / 小さな PNG）は、切り抜いても
 * プレビューの大きさに届く作業サイズで wasm に開く。編集内容がまるごと入れ替わった（別の端末の補正を読み直した）・切り抜きを
 * 確定した後に {@link ensureDevelopWorkingSize} を呼ぶと、要る作業サイズが今より大きいときだけ、持っている同じオリジナルを開き直す
 * （今以下・幾何が無い・作業コピー・wasm が古いなら何もしない）。
 *
 * - 開き直したら、小さい作業サイズで描いた画（丁寧な画・「補正前」）を捨て、`workingEpoch` を進める（描画の effect が描き直す）
 * - 開き直せなかった（寸法を読めない・wasm が開けない）ら、今の開き直しの経路（`openItem(item, { reload: true })`）に任せる
 * - 続けて呼ばれたら順に処理する（開き直しを重ねない）。途中で別の写真に替わったら何もしない
 *
 * 返り値は「その編集内容を今の wasm の写真で描いてよいか」（false: 別の写真に替わった・開き直しの経路に任せた）。
 */
export function useBrowserPhotoWorkingSize(params: {
  mountedRef: MutableRefObject<boolean>;
  develop: Pick<BrowserPhotoDevelop, "engineRef" | "developSessionRef" | "frameCacheRef" | "beforeFrameRef">;
  /** 開き直せなかった写真を、今の開き直しの経路で開き直す（`openItem` は後で作るので ref 越し） */
  reopenRef: MutableRefObject<(key: string) => void>;
}) {
  const { mountedRef, reopenRef } = params;
  const { engineRef, developSessionRef, frameCacheRef, beforeFrameRef } = params.develop;
  /** 開き直した回数（描画の effect の依存に入れ、開き直した写真を描き直す） */
  const [workingEpoch, setWorkingEpoch] = useState(0);
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  const ensureDevelopWorkingSize = useCallback(
    (settings: DevelopSettings): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const session = developSessionRef.current;
        const engine = engineRef.current;
        if (!session || !engine || !mountedRef.current) return false;
        // 補正の読み直しは session を作り直すが、入力（と作業サイズ）は同じものを持ち続ける
        const isStale = () => !mountedRef.current || developSessionRef.current?.input !== session.input;
        const result = await ensureOriginalWorkingSize(engine, session, settings, isStale);
        if (result === "failed") {
          reopenRef.current(session.key);
          return false;
        }
        if (result === "reopened") {
          if (frameCacheRef.current?.key === session.key) frameCacheRef.current = null;
          if (beforeFrameRef.current?.key === session.key) beforeFrameRef.current = null;
          if (mountedRef.current) setWorkingEpoch((epoch) => epoch + 1);
          return !isStale();
        }
        return result === "kept";
      };
      const next = chainRef.current.then(run);
      chainRef.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    [beforeFrameRef, developSessionRef, engineRef, frameCacheRef, mountedRef, reopenRef],
  );

  return { ensureDevelopWorkingSize, workingEpoch };
}
