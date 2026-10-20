import type { PhotoLibraryItem, PhotoLibraryWorkingCopyResult } from "../library/photo-library";

import { isBrowserCloudRawPhoto } from "../browser-photo-cloud-source";

import { isDevelopWorkTarget, type DevelopWorkTargetPhoto } from "./develop-work-target";

/**
 * 作業コピー（段 1 の出力。移行時の設計文書「作業コピー」）で直す写真の、作業コピーが揃うまでの状態と
 * 1 行（移行元設計）。ブラウザ版と NIHO Desktop（移行元設計 S7b）の両方が同じ文言・間隔で出す。待ちの文言で「現像」を使うのは RAW だけで、
 * ほか（HEIC / HEIF・TIFF・大きな PNG・ブラウザで読めない JPEG）は「編集の準備」（W1 移行元設計・Epic 移行元設計 の決めごと 6）。
 */

/** 作業コピーを待っている間の 1 行。 */
export function workPreparingText(raw: boolean): string {
  return raw ? "RAW の現像を準備中" : "編集の準備中";
}

/** 待ち始めてから {@link WORK_SLOW_AFTER_MS} を超えたとき。 */
export function workSlowText(raw: boolean): string {
  return raw ? "RAW の現像に時間がかかっています" : "準備に時間がかかっています";
}

/** 作れなかった（「再試行」を添える）。 */
export function workFailedText(raw: boolean): string {
  return raw ? "RAW の現像の準備ができませんでした" : "編集の準備ができませんでした";
}

/** 書き出しの JPEG の副文（作業コピーがまだ無い写真）。 */
export function workExportWaitingText(raw: boolean): string {
  return raw ? "RAW の現像の準備ができると書き出せます" : "編集の準備ができると書き出せます";
}

/** 「時間がかかっています」にするまで。 */
export const WORK_SLOW_AFTER_MS = 10 * 60_000;

/**
 * 確かめ直す間隔の列（W1 移行元設計）。最初の 20 秒は 2 秒ごと（10 回）、次の 20 秒は 5 秒ごと（4 回）、次の 30 秒は 15 秒ごと（2 回）、
 * 以後は {@link WORK_POLL_LAST_INTERVAL_MS} ごと。ワーカーは 2 秒ごとに claim するので、追加してすぐ開いた写真は、でき上がってから
 * 2 秒ほどで気づく。
 */
const WORK_POLL_STEPS: readonly { intervalMs: number; times: number }[] = [
  { intervalMs: 2_000, times: 10 },
  { intervalMs: 5_000, times: 4 },
  { intervalMs: 15_000, times: 2 },
];
const WORK_POLL_LAST_INTERVAL_MS = 30_000;

/**
 * 待ち始めてから（その写真を 1 枚で見始めた・再試行した・一覧に準備中の写真が増えた）`checks` 回確かめ直した後、次に確かめ直すまでの
 * 間隔。1 枚で見ている写真の `work/download` と、一覧の読み直しの両方が使う。
 */
export function workPollIntervalMs(checks: number): number {
  let remaining = Math.max(0, Math.floor(checks));
  for (const step of WORK_POLL_STEPS) {
    if (remaining < step.times) return step.intervalMs;
    remaining -= step.times;
  }
  return WORK_POLL_LAST_INTERVAL_MS;
}

/**
 * 作業コピーが揃うまでの状態。`opening` は確かめている途中（右パネルは薄いスライダーだけ）、`preparing` はワーカーが作っている
 * （「RAW の現像を準備中」／「編集の準備中」。10 分を超えたら「…時間がかかっています」）、`failed` は作れなかった
 * （「…準備ができませんでした」＋「再試行」）。
 */
export type WorkWait =
  | { phase: "opening" }
  | { phase: "preparing"; slow: boolean; checkedAt: number }
  | { phase: "failed"; retrying: boolean };

/** 作業コピーを待ち始めてから 10 分を超えたか。 */
export function isWorkSlow(queuedAt: string | null, now: number): boolean {
  const queuedTime = queuedAt ? Date.parse(queuedAt) : Number.NaN;
  return Number.isFinite(queuedTime) && now - queuedTime > WORK_SLOW_AFTER_MS;
}

/** まだできていない作業コピーの状態（作れなかった / 作っている）。 */
export function workWaitOf(result: Extract<PhotoLibraryWorkingCopyResult, { kind: "notReady" }>): WorkWait {
  if (result.workStatus === "failed") return { phase: "failed", retrying: false };
  const now = Date.now();
  return { phase: "preparing", slow: isWorkSlow(result.workQueuedAt, now), checkedAt: now };
}

/** 作業コピーを待っている間の 1 行（確かめている途中は出さない）。`raw` は RAW の写真か。 */
export function workWaitText(work: WorkWait, raw: boolean): string | null {
  if (work.phase === "preparing") return work.slow ? workSlowText(raw) : workPreparingText(raw);
  if (work.phase === "failed") return workFailedText(raw);
  return null;
}

type PendingWorkPhoto = DevelopWorkTargetPhoto & Pick<PhotoLibraryItem, "workStatus" | "workQueuedAt">;

/**
 * 一覧の写真のうち、作業コピーで直す写真（{@link isDevelopWorkTarget}）で、作業コピーを待っている（待ち・作っている）もの。
 * プレビューを作らせるために待ちに入った JPEG は、オリジナルから直接開けるので数えない（K5-a 移行元設計）。
 */
export function isWorkPending(photo: PendingWorkPhoto): boolean {
  return isDevelopWorkTarget(photo) && (photo.workStatus === "queued" || photo.workStatus === "rendering");
}

/** 一覧で作業コピーを待っている写真の枚数と、全部 RAW か・10 分を超えて待っている写真があるか。 */
export type PendingWorkSummary = { count: number; allRaw: boolean; slow: boolean };

export function summarizePendingWork(photos: readonly PendingWorkPhoto[], now: number): PendingWorkSummary {
  let count = 0;
  let allRaw = true;
  let slow = false;
  for (const photo of photos) {
    if (!isWorkPending(photo)) continue;
    count += 1;
    if (!isBrowserCloudRawPhoto(photo)) allRaw = false;
    if (isWorkSlow(photo.workQueuedAt ?? null, now)) slow = true;
  }
  return { count, allRaw: count > 0 && allRaw, slow };
}

/**
 * 一覧に準備中の写真がある間の状態欄の 1 行（「RAW の現像を準備中（あと N 枚）」。RAW 以外が混ざれば「編集の準備中（あと N 枚）」、
 * 10 分を超えて待っている写真があれば「…時間がかかっています（あと N 枚）」）。準備中の写真が無ければ null。
 */
export function pendingWorkStatusText(summary: PendingWorkSummary): string | null {
  if (summary.count === 0) return null;
  const text = summary.slow ? workSlowText(summary.allRaw) : workPreparingText(summary.allRaw);
  return `${text}（あと ${summary.count} 枚）`;
}
