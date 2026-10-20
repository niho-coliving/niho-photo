"use client";

import { useEffect, useRef } from "react";

import { workPollIntervalMs } from "./develop-work-wait";

/**
 * 作業コピーを待っている写真を、1 枚で見ている間だけ確かめ直す（移行元設計・W1 移行元設計）。ブラウザ版と NIHO Desktop（移行元設計 S7b）の
 * 両方が使う。
 *
 * - 間隔は {@link workPollIntervalMs} の列（最初は 2 秒ごと）。`pollKey` が変わる（1 枚で見始めた・別の写真を開いた・一覧へ戻った・
 *   再試行で待ちに戻った）と、最初の間隔から数え直す
 * - `checkedAt` が変わる（確かめ直した）たびに次を予約する（確かめている間は次を予約しない）
 * - タブを隠している間は確かめない（戻したら、その回の間隔を空けて確かめる）
 *
 * `pollKey` は待っている写真を 1 枚で見ている間だけその写真の key、ほかは null。
 */
export function useDevelopWorkPoll(
  pollKey: string | null,
  checkedAt: number | null,
  refreshRef: { readonly current: (key: string, signal: AbortSignal) => Promise<void> },
): void {
  // 待ち始めてから確かめ直した回数（写真ごと。見ていない間は数えない）
  const checksRef = useRef<{ key: string | null; checks: number }>({ key: null, checks: 0 });
  useEffect(() => {
    if (pollKey === null) {
      checksRef.current = { key: null, checks: 0 };
      return;
    }
    if (checksRef.current.key !== pollKey) checksRef.current = { key: pollKey, checks: 0 };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null || document.visibilityState === "hidden") return;
      timer = setTimeout(() => {
        checksRef.current = { key: pollKey, checks: checksRef.current.checks + 1 };
        void refreshRef.current(pollKey, controller.signal);
      }, workPollIntervalMs(checksRef.current.checks));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        schedule();
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [checkedAt, pollKey, refreshRef]);
}
