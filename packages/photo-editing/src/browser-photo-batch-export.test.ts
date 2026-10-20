import { describe, expect, it } from "vitest";

import {
  BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES,
  browserPhotoBatchArchiveFileName,
  browserPhotoBatchArchiveNames,
  browserPhotoBatchFailureNames,
  resolveBrowserPhotoBatchExportLimit,
} from "./browser-photo-batch-export";
import { createBrowserPhotoExportZip } from "./browser-photo-export-zip";

describe("browser photo batch export", () => {
  it("50 枚・合計 500MB までは許可し、超える選択には必要な回数を案内する", () => {
    expect(resolveBrowserPhotoBatchExportLimit(Array.from({ length: 50 }, () => ({ sizeBytes: 10_000_000 })))).toEqual({
      allowed: true,
      batchCount: 1,
    });
    expect(resolveBrowserPhotoBatchExportLimit([{ sizeBytes: BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES }])).toEqual({
      allowed: true,
      batchCount: 1,
    });
    expect(resolveBrowserPhotoBatchExportLimit([{ sizeBytes: BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES + 1 }])).toMatchObject({
      allowed: false,
      batchCount: 2,
    });
    expect(resolveBrowserPhotoBatchExportLimit([{ sizeBytes: Number.NaN }])).toMatchObject({
      allowed: false,
      message: "写真の大きさを確認できませんでした。ページを読み込み直してください。",
    });
    expect(resolveBrowserPhotoBatchExportLimit(Array.from({ length: 51 }, () => ({ sizeBytes: 1 })))).toEqual({
      allowed: false,
      batchCount: 2,
      message: "一度に書き出せるのは 50 枚・合計 500MB までです。選択を 2 回以上に分けてください。",
    });
    expect(
      resolveBrowserPhotoBatchExportLimit([
        { sizeBytes: BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES - 1 },
        { sizeBytes: 2 },
        { sizeBytes: BROWSER_PHOTO_BATCH_EXPORT_MAX_BYTES },
      ]),
    ).toMatchObject({ allowed: false, batchCount: 3 });
  });

  it("ZIP の同名を選択順に避け、JPEG は元の拡張子を jpg にする", () => {
    expect(
      browserPhotoBatchArchiveNames(
        [{ fileName: "trip.JPG" }, { fileName: "trip.RW2" }, { fileName: "folder/trip.jpg" }],
        "jpeg",
      ),
    ).toEqual(["trip.jpg", "trip (2).jpg", "folder_trip.jpg"]);
    expect(browserPhotoBatchArchiveNames([{ fileName: "A.JPG" }, { fileName: "a.jpg" }], "original")).toEqual([
      "A.JPG",
      "a (2).jpg",
    ]);
  });

  it("ZIP 名と失敗名を利用者向けにまとめる", () => {
    expect(browserPhotoBatchArchiveFileName(new Date(2026, 9, 1, 15, 7))).toBe("NIHO写真_20261001_1507.zip");
    expect(browserPhotoBatchFailureNames([{ fileName: "A.RW2" }, { fileName: "B.JPG" }])).toBe("A.RW2・B.JPG");
  });

  it("UTF-8 の名前と内容を store 形式の ZIP に入れる", async () => {
    const zip = await createBrowserPhotoExportZip(
      [
        { name: "鎌倉.jpg", blob: new Blob([new Uint8Array([1, 2, 3])]) },
        { name: "B.RW2", blob: new Blob([new Uint8Array([4, 5])]) },
      ],
      { modifiedAt: new Date(2026, 9, 1, 12, 0) },
    );
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(zip.type).toBe("application/zip");
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint32(14, true)).toBe(0x55bc801d);
    const firstNameLength = view.getUint16(26, true);
    expect(new TextDecoder().decode(bytes.slice(30, 30 + firstNameLength))).toBe("鎌倉.jpg");
    expect(Array.from(bytes.slice(30 + firstNameLength, 30 + firstNameLength + 3))).toEqual([1, 2, 3]);
    expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(bytes.length - 12, true)).toBe(2);
  });
});
