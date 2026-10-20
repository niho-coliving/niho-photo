import { describe, expect, it } from "vitest";

import {
  buildPhotoLibrarySections,
  photoLibraryNeighborKey,
  photoLibraryRowOffsets,
  photoLibraryRows,
  photoLibrarySectionDate,
  photoLibraryVisibleRange,
  msUntilNextTokyoMidnight,
  tokyoDayKey,
  type PhotoLibraryRow,
} from "./photo-library-sections";

/** 2026-10-01（木）12:00 日本時間 */
const NOW = Date.parse("2026-10-01T03:00:00.000Z");

function item(key: string, sectionDate: string | null) {
  return { key, sectionDate };
}

function headings(rows: readonly PhotoLibraryRow[]): string[] {
  return rows.flatMap((row) => (row.kind === "tiles" ? [] : [`${row.kind}:${row.label}`]));
}

describe("日本時間の日付をまたぐ（開いたままの画面の「今日」「昨日」）", () => {
  it("次の午前 0 時までの時間と、日付の数字が日本時間で決まる", () => {
    // 2026-10-01 12:00 JST → 翌 0 時まで 12 時間
    expect(msUntilNextTokyoMidnight(NOW)).toBe(12 * 3_600_000);
    // 23:59:59 JST → 1 秒、ちょうど 0 時 → 24 時間
    expect(msUntilNextTokyoMidnight(Date.parse("2026-10-01T14:59:59.000Z"))).toBe(1_000);
    expect(msUntilNextTokyoMidnight(Date.parse("2026-10-01T15:00:00.000Z"))).toBe(24 * 3_600_000);
    expect(tokyoDayKey(Date.parse("2026-10-01T14:59:59.000Z"))).toBe(20261001);
    expect(tokyoDayKey(Date.parse("2026-10-01T15:00:00.000Z"))).toBe(20261002);
  });

  it("日が変わると、同じ写真が「今日」から「昨日」の見出しに変わる", () => {
    const items = [item("a", "2026-10-01T03:00:00.000Z")];
    const dayLabelAt = (now: number) => buildPhotoLibrarySections(items, now)[0]?.dayLabel;
    expect(dayLabelAt(NOW)).toBe("今日");
    expect(dayLabelAt(NOW + 24 * 3_600_000)).toBe("昨日");
  });
});

describe("photoLibrarySectionDate", () => {
  it("撮影日の並びは撮影日（無ければ追加日）、最近追加は追加日", () => {
    const captured = { capturedAt: "2026-08-15T01:00:00.000Z", createdAt: "2026-09-30T01:00:00.000Z" };
    expect(photoLibrarySectionDate(captured, "captured")).toBe("2026-08-15T01:00:00.000Z");
    expect(photoLibrarySectionDate(captured, "added")).toBe("2026-09-30T01:00:00.000Z");
    expect(photoLibrarySectionDate({ capturedAt: null, createdAt: "2026-09-30T01:00:00.000Z" }, "captured")).toBe(
      "2026-09-30T01:00:00.000Z",
    );
    expect(photoLibrarySectionDate({ createdAt: "2026-09-30T01:00:00.000Z" }, "captured")).toBe("2026-09-30T01:00:00.000Z");
  });
});

describe("buildPhotoLibrarySections", () => {
  it("日本時間の日で分ける（UTC の 9/30 15:30 は日本時間の 10/1）。並びはそのまま、日が変わるたびに新しい見出し", () => {
    const sections = buildPhotoLibrarySections(
      [
        item("a", "2026-09-30T15:30:00.000Z"),
        item("b", "2026-10-01T02:00:00.000Z"),
        item("c", "2026-09-30T14:59:00.000Z"),
        item("d", "2026-09-30T00:00:00.000Z"),
      ],
      NOW,
    );
    expect(sections).toEqual([
      { monthLabel: null, dayLabel: "今日", keys: ["a", "b"] },
      // 昨日が前の月でも、月の見出しは昨日の前に付けない（その月の日付の見出しの前に付ける）
      { monthLabel: null, dayLabel: "昨日", keys: ["c", "d"] },
    ]);
  });

  it("日の見出しは「今日」「昨日」「9月28日（月）」、今年でなければ年を付ける。今月でない月は最初の日（今日・昨日を除く）の前に月の見出し", () => {
    const sections = buildPhotoLibrarySections(
      [
        item("today", "2026-10-01T00:30:00.000Z"),
        item("sep30", "2026-09-30T03:00:00.000Z"),
        item("sep28", "2026-09-28T03:00:00.000Z"),
        item("sep28b", "2026-09-28T01:00:00.000Z"),
        item("aug15", "2026-08-15T03:00:00.000Z"),
        item("last-year", "2025-09-28T03:00:00.000Z"),
        item("new-year-eve", "2025-12-31T03:00:00.000Z"),
      ],
      NOW,
    );
    expect(sections.map((section) => [section.monthLabel, section.dayLabel, section.keys.length])).toEqual([
      [null, "今日", 1],
      [null, "昨日", 1],
      ["9月", "9月28日（月）", 2],
      ["8月", "8月15日（土）", 1],
      ["2025年9月", "2025年9月28日（日）", 1],
      ["2025年12月", "2025年12月31日（水）", 1],
    ]);
  });

  it("今月の写真には月の見出しを付けない（今日が無くても）", () => {
    const sections = buildPhotoLibrarySections([item("a", "2026-10-01T00:00:00.000Z")], Date.parse("2026-10-05T03:00:00.000Z"));
    expect(sections).toEqual([{ monthLabel: null, dayLabel: "10月1日（木）", keys: ["a"] }]);
  });

  it("日時の無い写真（追加している途中）は今日に入れる", () => {
    const sections = buildPhotoLibrarySections(
      [item("adding", null), item("added", "2026-10-01T01:00:00.000Z"), item("old", "2026-09-29T01:00:00.000Z")],
      NOW,
    );
    expect(sections.map((section) => [section.dayLabel, section.keys])).toEqual([
      ["今日", ["adding", "added"]],
      ["9月29日（火）", ["old"]],
    ]);
  });
});

describe("photoLibraryRows", () => {
  const sections = buildPhotoLibrarySections(
    [
      ...["a1", "a2", "a3", "a4"].map((key) => item(key, "2026-10-01T01:00:00.000Z")),
      ...["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((key) => item(key, "2026-09-28T01:00:00.000Z")),
    ],
    NOW,
  );

  it("3 列: 見出しの後に 3 枚ずつの行", () => {
    const rows = photoLibraryRows(sections, 3);
    expect(rows.map((row) => (row.kind === "tiles" ? row.keys.join(",") : `${row.kind}:${row.label}`))).toEqual([
      "day:今日",
      "a1,a2,a3",
      "a4",
      "month:9月",
      "day:9月28日（月）",
      "b1,b2,b3",
      "b4,b5,b6",
      "b7",
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it("5 列と、測れないとき（Infinity）の日ごとに 1 行", () => {
    expect(photoLibraryRows(sections, 5).flatMap((row) => (row.kind === "tiles" ? [row.keys.length] : []))).toEqual([4, 5, 2]);
    const unmeasured = photoLibraryRows(sections, Number.POSITIVE_INFINITY);
    expect(unmeasured.flatMap((row) => (row.kind === "tiles" ? [row.keys.length] : []))).toEqual([4, 7]);
    expect(headings(unmeasured)).toEqual(["day:今日", "month:9月", "day:9月28日（月）"]);
  });
});

describe("photoLibraryRowOffsets / photoLibraryVisibleRange", () => {
  // day(36) tiles(100) tiles(100) month(52) day(36) tiles(100) tiles(100) tiles(100)
  const rows: PhotoLibraryRow[] = [
    { kind: "day", key: "d1", label: "今日" },
    { kind: "tiles", key: "t1", keys: ["a"] },
    { kind: "tiles", key: "t2", keys: ["b"] },
    { kind: "month", key: "m2", label: "9月" },
    { kind: "day", key: "d2", label: "9月28日（月）" },
    { kind: "tiles", key: "t3", keys: ["c"] },
    { kind: "tiles", key: "t4", keys: ["d"] },
    { kind: "tiles", key: "t5", keys: ["e"] },
  ];
  const { offsets, total } = photoLibraryRowOffsets(rows, { month: 52, day: 36, tiles: 100 });

  it("行の上端と全体の高さ", () => {
    expect(offsets).toEqual([0, 36, 136, 236, 288, 324, 424, 524]);
    expect(total).toBe(624);
  });

  it("見えている範囲に重なる行と、上下の余分", () => {
    expect(photoLibraryVisibleRange(offsets, total, 0, 100, 0)).toEqual({ start: 0, end: 2 });
    // 下端がちょうど上端に触れる行は含めない
    expect(photoLibraryVisibleRange(offsets, total, 136, 100, 0)).toEqual({ start: 2, end: 3 });
    expect(photoLibraryVisibleRange(offsets, total, 300, 100, 0)).toEqual({ start: 4, end: 6 });
    expect(photoLibraryVisibleRange(offsets, total, 300, 100, 100)).toEqual({ start: 2, end: 7 });
    // 一覧の上（右上の行の分、負）から・下の外
    expect(photoLibraryVisibleRange(offsets, total, -48, 100, 0)).toEqual({ start: 0, end: 2 });
    expect(photoLibraryVisibleRange(offsets, total, 700, 100, 0)).toEqual({ start: 8, end: 8 });
    expect(photoLibraryVisibleRange([], 0, 0, 100, 100)).toEqual({ start: 0, end: 0 });
  });
});

describe("photoLibraryNeighborKey", () => {
  // 今日: a1 a2 a3 / a4、9月28日: b1 b2 b3 / b4 b5 b6 / b7
  const rows = photoLibraryRows(
    buildPhotoLibrarySections(
      [
        ...["a1", "a2", "a3", "a4"].map((key) => item(key, "2026-10-01T01:00:00.000Z")),
        ...["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((key) => item(key, "2026-09-28T01:00:00.000Z")),
      ],
      NOW,
    ),
    3,
  );

  it("↑↓ は見出しを飛ばして上下の行の同じ列。行が短ければその行の最後", () => {
    expect(photoLibraryNeighborKey(rows, "a2", "ArrowDown")).toBe("a4");
    expect(photoLibraryNeighborKey(rows, "a4", "ArrowDown")).toBe("b1");
    expect(photoLibraryNeighborKey(rows, "b3", "ArrowUp")).toBe("a4");
    expect(photoLibraryNeighborKey(rows, "b6", "ArrowDown")).toBe("b7");
    expect(photoLibraryNeighborKey(rows, "b5", "ArrowUp")).toBe("b2");
  });

  it("←→ は並びの前後（見出しをまたぐ）", () => {
    expect(photoLibraryNeighborKey(rows, "a3", "ArrowRight")).toBe("a4");
    expect(photoLibraryNeighborKey(rows, "a4", "ArrowRight")).toBe("b1");
    expect(photoLibraryNeighborKey(rows, "b1", "ArrowLeft")).toBe("a4");
    expect(photoLibraryNeighborKey(rows, "b4", "ArrowLeft")).toBe("b3");
  });

  it("端・見つからない・矢印でなければ null。選べない写真（追加している途中）は飛ばす", () => {
    expect(photoLibraryNeighborKey(rows, "a1", "ArrowLeft")).toBeNull();
    expect(photoLibraryNeighborKey(rows, "a2", "ArrowUp")).toBeNull();
    expect(photoLibraryNeighborKey(rows, "b7", "ArrowRight")).toBeNull();
    expect(photoLibraryNeighborKey(rows, "b7", "ArrowDown")).toBeNull();
    expect(photoLibraryNeighborKey(rows, "zz", "ArrowDown")).toBeNull();
    expect(photoLibraryNeighborKey(rows, "a1", "Enter")).toBeNull();

    const adding = new Set(["a1", "a2"]);
    const selectable = (key: string) => !adding.has(key);
    expect(photoLibraryNeighborKey(rows, "a3", "ArrowLeft", selectable)).toBeNull();
    expect(photoLibraryNeighborKey(rows, "a4", "ArrowUp", selectable)).toBeNull();
    expect(photoLibraryNeighborKey(rows, "b2", "ArrowUp", selectable)).toBe("a4");
    expect(photoLibraryNeighborKey(rows, "b1", "ArrowUp", selectable)).toBe("a4");
  });
});
