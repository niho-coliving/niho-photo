import { afterEach, describe, expect, it } from "vitest";

import type { DevelopSettings } from "./develop-settings";

import { rememberDevelopOriginalTooLarge, resetDevelopOriginalTooLargeForTest } from "./develop-work-target";
import {
  isWorkPending,
  pendingWorkStatusText,
  summarizePendingWork,
  workExportWaitingText,
  workFailedText,
  workPollIntervalMs,
  workPreparingText,
  workSlowText,
  workWaitText,
} from "./develop-work-wait";

// W1 移行元設計: 作業コピーを待つ間の確かめ直しの間隔と、待ちの文言（RAW だけ「現像」、ほかは「編集の準備」。Epic 移行元設計 の
// 決めごと 6）、一覧の準備中の写真の数え方。

const MiB = 1024 ** 2;
const NOW = Date.parse("2026-09-30T00:10:00.000Z");

function listed(
  fileExtension: string,
  workStatus: "queued" | "rendering" | "ready" | "failed" | null,
  overrides: {
    id?: string;
    sizeBytes?: number;
    hasOriginal?: boolean;
    workQueuedAt?: string | null;
    developSettings?: DevelopSettings | null;
  } = {},
) {
  return {
    id: overrides.id ?? `photo-${fileExtension}`,
    developSettings: overrides.developSettings ?? null,
    fileExtension,
    sizeBytes: overrides.sizeBytes ?? 30 * MiB,
    hasOriginal: overrides.hasOriginal ?? true,
    workStatus,
    workQueuedAt: overrides.workQueuedAt ?? "2026-09-30T00:09:00.000Z",
  };
}

describe("確かめ直す間隔（workPollIntervalMs）", () => {
  it("2 秒を 10 回（最初の 20 秒）→ 5 秒を 4 回 → 15 秒を 2 回 → 以後 30 秒", () => {
    const intervals = Array.from({ length: 20 }, (_, checks) => workPollIntervalMs(checks));
    expect(intervals).toEqual([
      ...Array<number>(10).fill(2_000),
      ...Array<number>(4).fill(5_000),
      ...Array<number>(2).fill(15_000),
      ...Array<number>(4).fill(30_000),
    ]);
    // 積み上げると 20 秒・40 秒・70 秒で次の段へ移る
    const elapsed = (checks: number) => intervals.slice(0, checks).reduce((sum, ms) => sum + ms, 0);
    expect([elapsed(10), elapsed(14), elapsed(16)]).toEqual([20_000, 40_000, 70_000]);
    expect(workPollIntervalMs(1_000)).toBe(30_000);
    expect(workPollIntervalMs(-1)).toBe(2_000);
  });
});

describe("待ちの文言（RAW だけ「現像」）", () => {
  it("準備中・10 分超・失敗・書き出しの副文", () => {
    expect([workPreparingText(true), workPreparingText(false)]).toEqual(["RAW の現像を準備中", "編集の準備中"]);
    expect([workSlowText(true), workSlowText(false)]).toEqual([
      "RAW の現像に時間がかかっています",
      "準備に時間がかかっています",
    ]);
    expect([workFailedText(true), workFailedText(false)]).toEqual([
      "RAW の現像の準備ができませんでした",
      "編集の準備ができませんでした",
    ]);
    expect([workExportWaitingText(true), workExportWaitingText(false)]).toEqual([
      "RAW の現像の準備ができると書き出せます",
      "編集の準備ができると書き出せます",
    ]);
  });

  it("状態ごとの 1 行（確かめている途中は出さない）", () => {
    expect(workWaitText({ phase: "preparing", slow: false, checkedAt: NOW }, true)).toBe("RAW の現像を準備中");
    expect(workWaitText({ phase: "preparing", slow: true, checkedAt: NOW }, false)).toBe("準備に時間がかかっています");
    expect(workWaitText({ phase: "failed", retrying: false }, false)).toBe("編集の準備ができませんでした");
    expect(workWaitText({ phase: "opening" }, true)).toBeNull();
  });
});

describe("一覧の準備中の写真（isWorkPending・summarizePendingWork・pendingWorkStatusText）", () => {
  afterEach(() => {
    resetDevelopOriginalTooLargeForTest();
  });

  it("作業コピーで直す写真の待ち・作っている request だけを数える", () => {
    expect(isWorkPending(listed("rw2", "queued"))).toBe(true);
    expect(isWorkPending(listed("heic", "rendering"))).toBe(true);
    expect(isWorkPending(listed("rw2", "ready"))).toBe(false);
    expect(isWorkPending(listed("rw2", "failed"))).toBe(false);
    expect(isWorkPending(listed("rw2", null))).toBe(false);
    // 作業コピーを作らない写真（小さな PNG・オリジナルの無い行）は、状態が残っていても数えない
    expect(isWorkPending(listed("png", "queued", { sizeBytes: 2 * MiB }))).toBe(false);
    expect(isWorkPending(listed("rw2", "queued", { hasOriginal: false }))).toBe(false);
  });

  it("プレビューを作らせるために待ちに入った JPEG は、オリジナルから直接開けるので数えない（K5-a #17153）", () => {
    expect(isWorkPending(listed("jpg", "queued", { sizeBytes: 2 * MiB }))).toBe(false);
    expect(isWorkPending(listed("jpeg", "rendering", { sizeBytes: 12 * MiB }))).toBe(false);
    // 作業コピーの上で直した JPEG・大きすぎた JPEG は作業コピーを待っているので数える
    const onWorkingCopy: DevelopSettings = { v: 1, engine: "niho-1", base: "raster.apple.d1.p1.e1" };
    expect(isWorkPending(listed("jpg", "queued", { developSettings: onWorkingCopy }))).toBe(true);
    rememberDevelopOriginalTooLarge("photo-big");
    expect(isWorkPending(listed("jpg", "queued", { id: "photo-big", sizeBytes: 12 * MiB }))).toBe(true);
  });

  it("全部 RAW なら「RAW の現像を準備中（あと N 枚）」、ほかが混ざれば「編集の準備中（あと N 枚）」、無ければ出さない", () => {
    const raws = [listed("rw2", "queued"), listed("ARW", "rendering"), listed("rw2", "ready")];
    expect(summarizePendingWork(raws, NOW)).toEqual({ count: 2, allRaw: true, slow: false });
    expect(pendingWorkStatusText(summarizePendingWork(raws, NOW))).toBe("RAW の現像を準備中（あと 2 枚）");

    const mixed = [...raws, listed("heic", "queued")];
    expect(pendingWorkStatusText(summarizePendingWork(mixed, NOW))).toBe("編集の準備中（あと 3 枚）");

    expect(summarizePendingWork([listed("rw2", "ready")], NOW)).toEqual({ count: 0, allRaw: false, slow: false });
    expect(pendingWorkStatusText(summarizePendingWork([], NOW))).toBeNull();
  });

  it("10 分を超えて待っている写真があれば「…時間がかかっています（あと N 枚）」", () => {
    const slowRaw = listed("rw2", "queued", { workQueuedAt: "2026-09-29T23:59:00.000Z" });
    expect(pendingWorkStatusText(summarizePendingWork([slowRaw, listed("rw2", "rendering")], NOW))).toBe(
      "RAW の現像に時間がかかっています（あと 2 枚）",
    );
    expect(pendingWorkStatusText(summarizePendingWork([slowRaw, listed("tif", "queued")], NOW))).toBe(
      "準備に時間がかかっています（あと 2 枚）",
    );
  });
});
