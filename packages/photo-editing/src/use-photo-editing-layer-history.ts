"use client";

import { useEffect, useRef } from "react";

/**
 * スマホの 1 枚の編集の層を、端末の「戻る」で閉じる（NIHO Photo 段 1 F6c 移行元設計）。
 *
 * 層が出ている間だけ、履歴に層の分を 1 つ積む（URL は変えない。`use-entrance-tab-url.ts` と同じく生の History API で、Next は
 * これを検知して追従する。Next が state に持つ中身はそのまま残す）。
 *
 * - 「戻る」で層の分が外れたら、同じ分を積み直してから `onBack` を呼ぶ（保存に失敗して層が残っても「戻る」が効き続ける）。
 * - 層が閉じたら（‹・Esc・幅を広げた）、積んだ分を `history.back()` で外す。別のページへ移った後は外さない。
 * - 印はこの文書（ページを読み込むごとに別）のもの。読み込み直す前の印が state に残っていても、それは自分の分にしない
 *   （その下の履歴は前の文書のもので、外すとページを読み込み直してしまう）。
 * - 外すのは層が閉じた次の microtask（同じ tick で開き直したら取り消す。開発時の StrictMode は effect を 2 回実行する）。
 *   外している途中（`history.back()` の popstate を待っている間）に次の層が開いたら、その popstate は「戻る」にせず積み直す。
 */

const LAYER_MARK = "nihoPhotoEditingLayer";

/** この文書の印（state に残った、読み込み直す前の印と区別する）。 */
const DOCUMENT_MARK = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** 今出ている層の「戻る」（層は同時に 1 つ）。 */
let activeBack: { current: () => void } | null = null;
/** 層が閉じて、積んだ分を外す `history.back()` の popstate を待っている。 */
let unwinding = false;
/** 層が閉じた直後の「外す」の予約（同じ tick で開き直したら取り消す）。 */
let pendingUnwind: object | null = null;
let listening = false;

function historyStateRecord(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
}

/** 今の履歴が、この文書で積んだ層の分か。 */
export function hasPhotoEditingLayerHistoryEntry(): boolean {
  if (typeof window === "undefined") return false;
  return historyStateRecord()[LAYER_MARK] === DOCUMENT_MARK;
}

function pushLayerEntry(): void {
  window.history.pushState({ ...historyStateRecord(), [LAYER_MARK]: DOCUMENT_MARK }, "");
}

function onPopState(): void {
  if (unwinding) {
    // 自分で外した分。外している間に次の層が開いていたら、その層の分を積み直す
    unwinding = false;
    if (activeBack && !hasPhotoEditingLayerHistoryEntry()) pushLayerEntry();
    return;
  }
  const back = activeBack;
  if (!back || hasPhotoEditingLayerHistoryEntry()) return;
  pushLayerEntry();
  back.current();
}

export function usePhotoEditingLayerHistory(onBack: () => void, enabled = true): void {
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  });

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (!listening) {
      listening = true;
      window.addEventListener("popstate", onPopState);
    }
    pendingUnwind = null;
    activeBack = onBackRef;
    // 自分の分が残っていれば積まない（外している途中なら、その popstate で積み直す）
    if (!hasPhotoEditingLayerHistoryEntry()) {
      unwinding = false;
      pushLayerEntry();
    }
    return () => {
      if (activeBack === onBackRef) activeBack = null;
      const token = {};
      pendingUnwind = token;
      void Promise.resolve().then(() => {
        if (pendingUnwind !== token) return;
        pendingUnwind = null;
        if (unwinding || !hasPhotoEditingLayerHistoryEntry()) return;
        unwinding = true;
        window.history.back();
      });
    };
  }, [enabled]);
}
