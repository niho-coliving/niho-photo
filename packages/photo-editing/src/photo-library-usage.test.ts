import { describe, expect, it } from "vitest";

import { formatPhotoCloudGigabytes, formatPhotoCloudUsage, formatPhotoCloudUsageBreakdown } from "./photo-library-usage";

const GB = 1024 ** 3;

describe("使用量の表示", () => {
  it("上限の 5GiB を「5 GB」にし、使用量は 1 以上なら小数 1 桁、1 未満なら 2 桁で出す", () => {
    expect(formatPhotoCloudUsage({ usedBytes: 1.2 * GB, quotaBytes: 5 * GB })).toBe("1.2 / 5 GB");
    expect(formatPhotoCloudUsage({ usedBytes: 0, quotaBytes: 5 * GB })).toBe("0 / 5 GB");
    expect(formatPhotoCloudUsage({ usedBytes: 12.25 * GB, quotaBytes: 100 * GB })).toBe("12.3 / 100 GB");
    // RAW 1 枚（約 36MB）でも 0 と出さない
    expect(formatPhotoCloudGigabytes(36_000_000)).toBe("0.03");
    expect(formatPhotoCloudGigabytes(100)).toBe("0.01");
    expect(formatPhotoCloudGigabytes(0.5 * GB)).toBe("0.5");
    expect(formatPhotoCloudGigabytes(4.96 * GB)).toBe("5");
  });

  it("内訳はオリジナルと残り（サムネイルと記事の画像）で、足すと使用量になる。内訳の無い古い API・0 のときは出さない（#17128）", () => {
    expect(formatPhotoCloudUsageBreakdown({ usedBytes: 3.4 * GB, originalBytes: 3.1 * GB })).toBe(
      "オリジナル 3.1 GB・サムネイルと記事の画像 0.3 GB",
    );
    // 元の写真を置かない拠点（記事の画像だけ）
    expect(formatPhotoCloudUsageBreakdown({ usedBytes: 0.2 * GB, originalBytes: 0 })).toBe(
      "オリジナル 0 GB・サムネイルと記事の画像 0.2 GB",
    );
    expect(formatPhotoCloudUsageBreakdown({ usedBytes: 1.2 * GB })).toBeNull();
    expect(formatPhotoCloudUsageBreakdown({ usedBytes: 0, originalBytes: 0 })).toBeNull();
  });
});
