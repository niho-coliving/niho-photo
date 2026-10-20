import { afterEach, describe, expect, it } from "vitest";

import type { DevelopSettings } from "./develop-settings";

import { BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS } from "../photo-original-files";
import { BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES, BrowserPhotoSourceError } from "../browser-photo-source";
import {
  DEVELOP_WORK_DIRECT_PNG_MAX_BYTES,
  canOpenDevelopWorkInstead,
  isClientWorkCopyTarget,
  isDevelopWorkTarget,
  rememberDevelopOriginalTooLarge,
  resetDevelopOriginalTooLargeForTest,
} from "./develop-work-target";

const MiB = 1024 ** 2;

function photo(
  fileExtension: string,
  sizeBytes = 2 * MiB,
  hasOriginal = true,
  developSettings: DevelopSettings | null = null,
) {
  return {
    id: `photo-${fileExtension}`,
    fileExtension,
    sizeBytes,
    hasOriginal,
    developSettings,
  };
}

const onWorkingCopy: DevelopSettings = {
  v: 1,
  engine: "niho-1",
  look: "niho-look-1",
  base: "raster.apple.d1.p1.e1",
};
const onOriginal: DevelopSettings = { v: 1, engine: "niho-1", look: "niho-look-1", base: null, exposure: 0.3 };

afterEach(() => {
  resetDevelopOriginalTooLargeForTest();
});

describe("isDevelopWorkTarget（サーバーの isPhotoCloudWorkApplicable と、JPEG は補正の土台で決める。K5-a #17153）", () => {
  it("RAW・HEIC / HEIF・TIFF は大きさによらず作業コピーで直す", () => {
    for (const extension of ["rw2", "ARW", "dng", "cr3", "nef", "raf", "heic", "heif", "tif", "tiff"]) {
      expect(isDevelopWorkTarget(photo(extension, 1))).toBe(true);
    }
  });

  it("PNG は 10MiB を超えるときだけ（10MiB ちょうどはオリジナルから直接描く）", () => {
    expect(DEVELOP_WORK_DIRECT_PNG_MAX_BYTES).toBe(10 * MiB);
    for (const extension of ["png", "PNG"]) {
      expect(isDevelopWorkTarget(photo(extension, 10 * MiB))).toBe(false);
      expect(isDevelopWorkTarget(photo(extension, 10 * MiB + 1))).toBe(true);
    }
  });

  it("JPEG は大きさによらずオリジナルから直接描く（補正なし・オリジナルの上の補正）", () => {
    for (const extension of ["jpg", "jpeg", "JPG"]) {
      expect(isDevelopWorkTarget(photo(extension, 10 * MiB + 1))).toBe(false);
      expect(isDevelopWorkTarget(photo(extension, 40 * MiB))).toBe(false);
      expect(isDevelopWorkTarget(photo(extension, 40 * MiB, true, onOriginal))).toBe(false);
    }
  });

  it("作業コピーの上で直した補正（base が文字列）のある JPEG は、大きさによらず作業コピーで直す（決まりごと 4）", () => {
    expect(isDevelopWorkTarget(photo("jpg", 2 * MiB, true, onWorkingCopy))).toBe(true);
    expect(isDevelopWorkTarget(photo("jpeg", 12 * MiB, true, onWorkingCopy))).toBe(true);
    // 補正が新しい版の NIHO のもの（形が読めなくても）でも、base が文字列なら作業コピー
    const newer = { v: 2, engine: "niho-9", base: "raster.x" } as unknown as DevelopSettings;
    expect(isDevelopWorkTarget(photo("jpg", 2 * MiB, true, newer))).toBe(true);
  });

  it("64MiB を超える JPEG はブラウザで読まないので作業コピーで直す", () => {
    expect(BROWSER_PHOTO_MAX_JPEG_ORIGINAL_BYTES).toBe(64 * MiB);
    expect(isDevelopWorkTarget(photo("jpg", 64 * MiB))).toBe(false);
    expect(isDevelopWorkTarget(photo("jpg", 64 * MiB + 1))).toBe(true);
  });

  it("オリジナルが大きすぎた（4,000 万画素を超える）と覚えた JPEG は、このタブの間は作業コピーで直す", () => {
    const big = photo("jpg", 12 * MiB);
    expect(isDevelopWorkTarget(big)).toBe(false);
    rememberDevelopOriginalTooLarge(big.id);
    expect(isDevelopWorkTarget(big)).toBe(true);
    // ほかの写真には効かない
    expect(isDevelopWorkTarget({ ...big, id: "photo-other" })).toBe(false);
  });

  it("写真置き場の一覧に無い拡張子（WebP など）とオリジナルの無い行は作らない", () => {
    expect(isDevelopWorkTarget(photo("webp", 20 * MiB))).toBe(false);
    expect(isDevelopWorkTarget(photo("gif"))).toBe(false);
    expect(isDevelopWorkTarget(photo(""))).toBe(false);
    expect(isDevelopWorkTarget(photo("rw2", 30 * MiB, false))).toBe(false);
    expect(isDevelopWorkTarget(photo("jpg", 2 * MiB, false, onWorkingCopy))).toBe(false);
  });

  it("写真置き場の拡張子は、JPEG / PNG 以外すべて対象（サーバーの一覧と同じ）", () => {
    const targets = BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS.filter((extension) => isDevelopWorkTarget(photo(extension)));
    expect(targets).toEqual(
      BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS.filter((extension) => !["jpg", "jpeg", "png"].includes(extension)),
    );
  });
});

describe("isClientWorkCopyTarget（サーバーの isPhotoCloudWorkClientUploadSupported と同じ区分。W2b-2 / W2c-2 #17145）", () => {
  const raw = { raster: false };
  const raster = { raster: true };

  it("RAW は大きさによらず、v21（raster: false）でも上げる", () => {
    for (const extension of ["rw2", "ARW", "dng", "cr3"]) {
      expect(isClientWorkCopyTarget(photo(extension, 1), raw), extension).toBe(true);
      expect(isClientWorkCopyTarget(photo(extension, 80 * MiB), raster), extension).toBe(true);
    }
  });

  it("HEIC / HEIF・TIFF は大きさによらず、v22（raster: true）だけ上げる", () => {
    for (const extension of ["heic", "HEIF", "tif", "tiff"]) {
      expect(isClientWorkCopyTarget(photo(extension, 1), raster), extension).toBe(true);
      expect(isClientWorkCopyTarget(photo(extension, 1), raw), extension).toBe(false);
    }
  });

  it("PNG は 10MiB を超えるときだけ、v22 だけ上げる（10MiB ちょうどは上げない）", () => {
    expect(isClientWorkCopyTarget(photo("png", DEVELOP_WORK_DIRECT_PNG_MAX_BYTES + 1), raster)).toBe(true);
    expect(isClientWorkCopyTarget(photo("png", DEVELOP_WORK_DIRECT_PNG_MAX_BYTES), raster)).toBe(false);
    expect(isClientWorkCopyTarget(photo("png", DEVELOP_WORK_DIRECT_PNG_MAX_BYTES + 1), raw)).toBe(false);
  });

  it("JPEG は大きさによらず上げない（求められたときだけワーカーが作る）。写真置き場に無い拡張子も上げない", () => {
    for (const extension of ["jpg", "JPEG"]) {
      expect(isClientWorkCopyTarget(photo(extension, 80 * MiB), raster), extension).toBe(false);
    }
    expect(isClientWorkCopyTarget(photo("webp", 20 * MiB), raster)).toBe(false);
    expect(isClientWorkCopyTarget(photo("", 20 * MiB), raster)).toBe(false);
  });
});

describe("canOpenDevelopWorkInstead（オリジナルが大きすぎたら作業コピーで開き直すか）", () => {
  const tooLarge = new BrowserPhotoSourceError("too_large");

  it("オリジナルのある JPEG が too_large のときだけ", () => {
    expect(canOpenDevelopWorkInstead(photo("jpg"), tooLarge)).toBe(true);
    expect(canOpenDevelopWorkInstead(photo("JPEG"), tooLarge)).toBe(true);
    // PNG はサーバーが作業コピーを作らない（10MiB 以下）ので、読めなかった理由を出す
    expect(canOpenDevelopWorkInstead(photo("png"), tooLarge)).toBe(false);
    expect(canOpenDevelopWorkInstead(photo("jpg", 2 * MiB, false), tooLarge)).toBe(false);
    expect(canOpenDevelopWorkInstead(photo("jpg"), new BrowserPhotoSourceError("decode_failed"))).toBe(false);
    expect(canOpenDevelopWorkInstead(photo("jpg"), new Error("too_large"))).toBe(false);
  });
});
