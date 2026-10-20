/**
 * 写真の一覧（ブラウザ版の「写真」「記事の画像」。F5a-2 移行元設計）の見出しと行。日本時間の日ごとに分け、今月でない月はその月の
 * 最初の日の前に月の見出しを置く（「今日」「昨日」は月の見出しの外に置き、月の見出しはその月の日付の見出しの前に付ける）。サーバーが並べた順のまま、日が変わるたびに新しい見出しを始める（並べ直さない）。行は見出しと
 * タイルの行（列の数ずつ）に平たくし、仮想スクロールの高さ・見えている範囲・矢印キーの移り先をここで計算する。
 */

/** 一覧の並び（`added` は最近追加、`captured` は撮影日。どちらも新しい順） */
export type PhotoLibrarySort = "captured" | "added";

/** 見出しに使う日時。撮影日の並びは撮影日（無ければ追加日。サーバーの並びと同じ）、最近追加は追加日。 */
export function photoLibrarySectionDate(
  photo: { capturedAt?: string | null; createdAt: string },
  sort: PhotoLibrarySort,
): string {
  return sort === "captured" ? (photo.capturedAt ?? photo.createdAt) : photo.createdAt;
}

type TokyoDay = { year: number; month: number; day: number };

const TOKYO_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/**
 * 日本時間の日付。時差が 1 時間単位なので UTC の 1 時間の中では日付が変わらない。1 時間ごとに覚えて、数万枚でも Intl を
 * 呼ぶ回数を減らす（覚える数には上限を置く）。
 */
const tokyoDayCache = new Map<number, TokyoDay>();
const TOKYO_DAY_CACHE_LIMIT = 20_000;

function tokyoDay(time: number): TokyoDay {
  const hour = Math.floor(time / HOUR_MS);
  const cached = tokyoDayCache.get(hour);
  if (cached) return cached;
  const result: TokyoDay = { year: 0, month: 0, day: 0 };
  for (const part of TOKYO_DATE_FORMAT.formatToParts(new Date(hour * HOUR_MS))) {
    if (part.type === "year") result.year = Number(part.value);
    else if (part.type === "month") result.month = Number(part.value);
    else if (part.type === "day") result.day = Number(part.value);
  }
  if (tokyoDayCache.size >= TOKYO_DAY_CACHE_LIMIT) tokyoDayCache.clear();
  tokyoDayCache.set(hour, result);
  return result;
}

function dayNumber(day: TokyoDay): number {
  return day.year * 10_000 + day.month * 100 + day.day;
}

/** 日本時間の日付の数字（2026-10-01 → 20261001）。日が変わったかを見るのに使う。 */
export function tokyoDayKey(now: number): number {
  return dayNumber(tokyoDay(now));
}

/** 次の日本時間の午前 0 時までの時間（ミリ秒。ちょうど 0 時なら 1 日）。 */
export function msUntilNextTokyoMidnight(now: number): number {
  const JST_OFFSET_MS = 9 * HOUR_MS;
  return DAY_MS - (((now + JST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

function monthNumber(day: TokyoDay): number {
  return day.year * 100 + day.month;
}

/** 「今日」「昨日」「9月28日（日）」。今年でなければ年を付ける（「2025年9月28日（日）」） */
function dayLabel(day: TokyoDay, today: TokyoDay, yesterday: TokyoDay): string {
  if (dayNumber(day) === dayNumber(today)) return "今日";
  if (dayNumber(day) === dayNumber(yesterday)) return "昨日";
  const weekday = WEEKDAYS[new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()];
  const label = `${day.month}月${day.day}日（${weekday}）`;
  return day.year === today.year ? label : `${day.year}年${label}`;
}

/** 「8月」。今年でなければ年を付ける（「2025年8月」） */
function monthLabel(day: TokyoDay, today: TokyoDay): string {
  return day.year === today.year ? `${day.month}月` : `${day.year}年${day.month}月`;
}

/** 見出しで分ける 1 枚。`sectionDate` が null（追加している途中など、まだ日時の無い写真）は今として扱う */
export type PhotoLibraryDatedItem = { key: string; sectionDate: string | null };

/** 日ごとのまとまり。月の見出しは、今月でない月の最初の日（「今日」「昨日」を除く）の前だけ */
export type PhotoLibrarySection = { monthLabel: string | null; dayLabel: string; keys: string[] };

export function buildPhotoLibrarySections(
  items: readonly PhotoLibraryDatedItem[],
  now: number,
): PhotoLibrarySection[] {
  const today = tokyoDay(now);
  const yesterday = tokyoDay(now - DAY_MS);
  const relativeDays = new Set([dayNumber(today), dayNumber(yesterday)]);
  const sections: PhotoLibrarySection[] = [];
  // 最後に見出しを置いた月（今月は置かない）。1 日前に昨日が前の月でも、その月の見出しは昨日より前の日の前に付ける
  let headedMonth = monthNumber(today);
  let current: { section: PhotoLibrarySection; day: number } | null = null;
  for (const item of items) {
    const parsed = item.sectionDate === null ? Number.NaN : Date.parse(item.sectionDate);
    const day = tokyoDay(Number.isFinite(parsed) ? parsed : now);
    const dayKey = dayNumber(day);
    if (current && current.day === dayKey) {
      current.section.keys.push(item.key);
      continue;
    }
    const month = monthNumber(day);
    const headed = !relativeDays.has(dayKey) && month !== headedMonth;
    if (headed) headedMonth = month;
    const section: PhotoLibrarySection = {
      monthLabel: headed ? monthLabel(day, today) : null,
      dayLabel: dayLabel(day, today, yesterday),
      keys: [item.key],
    };
    sections.push(section);
    current = { section, day: dayKey };
  }
  return sections;
}

/** 一覧の 1 行（月の見出し・日の見出し・タイルの行） */
export type PhotoLibraryRow =
  | { kind: "month"; key: string; label: string }
  | { kind: "day"; key: string; label: string }
  | { kind: "tiles"; key: string; keys: string[] };

/**
 * 見出しとタイルの行に平たくする。タイルは `columns` 枚ずつ（`Infinity` なら日ごとに 1 行。幅を測れない環境で CSS に
 * 並べさせるとき）。
 */
export function photoLibraryRows(sections: readonly PhotoLibrarySection[], columns: number): PhotoLibraryRow[] {
  const step = Math.max(1, Math.floor(columns));
  const rows: PhotoLibraryRow[] = [];
  for (const section of sections) {
    const first = section.keys[0];
    if (first === undefined) continue;
    if (section.monthLabel !== null) rows.push({ kind: "month", key: `month:${first}`, label: section.monthLabel });
    rows.push({ kind: "day", key: `day:${first}`, label: section.dayLabel });
    for (let index = 0; index < section.keys.length; index += step) {
      rows.push({ kind: "tiles", key: `tiles:${section.keys[index]}`, keys: section.keys.slice(index, index + step) });
    }
  }
  return rows;
}

/** 行の高さ（px）。見出しは決まった高さ、タイルの行は幅から計算した高さ（下の間を含む） */
export type PhotoLibraryRowHeights = Record<PhotoLibraryRow["kind"], number>;

/** 各行の上端（一覧の先頭から）と、全体の高さ */
export function photoLibraryRowOffsets(
  rows: readonly PhotoLibraryRow[],
  heights: PhotoLibraryRowHeights,
): { offsets: number[]; total: number } {
  const offsets = new Array<number>(rows.length);
  let top = 0;
  rows.forEach((row, index) => {
    offsets[index] = top;
    top += heights[row.kind];
  });
  return { offsets, total: top };
}

/**
 * `top` から `height` の範囲に重なる行に、上下 `overscan` ずつ足した範囲（`end` は含まない）。`top` は一覧の先頭からの位置。
 */
export function photoLibraryVisibleRange(
  offsets: readonly number[],
  total: number,
  top: number,
  height: number,
  overscan: number,
): { start: number; end: number } {
  const count = offsets.length;
  const from = top - overscan;
  const to = top + height + overscan;
  const bottomOf = (index: number) => (index + 1 < count ? offsets[index + 1] : total);
  // 下端が from より下にある最初の行
  let low = 0;
  let high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (bottomOf(middle) > from) high = middle;
    else low = middle + 1;
  }
  const start = low;
  // 上端が to 以上の最初の行（そこから先は描かない）
  high = count;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (offsets[middle] >= to) high = middle;
    else low = middle + 1;
  }
  return { start, end: Math.max(start, low) };
}

/**
 * 矢印キーの移り先。←→ は並びの前後、↑↓ は見出しを飛ばして上下のタイルの行の同じ列（行が短ければその行の最後）。`selectable`
 * で選べない写真（追加している途中）は飛ばす。端・見つからない・矢印キーでなければ null。
 */
export function photoLibraryNeighborKey(
  rows: readonly PhotoLibraryRow[],
  fromKey: string,
  arrowKey: string,
  selectable: (key: string) => boolean = () => true,
): string | null {
  const tileRows: (readonly string[])[] = [];
  for (const row of rows) if (row.kind === "tiles") tileRows.push(row.keys);
  let rowIndex = -1;
  let column = -1;
  for (let index = 0; index < tileRows.length; index += 1) {
    column = tileRows[index].indexOf(fromKey);
    if (column >= 0) {
      rowIndex = index;
      break;
    }
  }
  if (rowIndex < 0) return null;
  if (arrowKey === "ArrowLeft" || arrowKey === "ArrowRight") {
    const step = arrowKey === "ArrowRight" ? 1 : -1;
    let row = rowIndex;
    let index = column + step;
    while (row >= 0 && row < tileRows.length) {
      while (index >= 0 && index < tileRows[row].length) {
        const key = tileRows[row][index];
        if (selectable(key)) return key;
        index += step;
      }
      row += step;
      index = step > 0 ? 0 : (tileRows[row]?.length ?? 0) - 1;
    }
    return null;
  }
  if (arrowKey === "ArrowUp" || arrowKey === "ArrowDown") {
    const step = arrowKey === "ArrowDown" ? 1 : -1;
    for (let row = rowIndex + step; row >= 0 && row < tileRows.length; row += step) {
      const keys = tileRows[row];
      const key = keys[Math.min(column, keys.length - 1)];
      if (key !== undefined && selectable(key)) return key;
    }
    return null;
  }
  return null;
}
