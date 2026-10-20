import syntheticFixture from "./fixtures/cutout-brush-parity.json";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  addCutoutStroke,
  applyCutoutStrokes,
  composeCutoutRgba,
  createCutoutRecipe,
  cutoutBackgroundArgument,
  cutoutBackgroundForFormat,
  cutoutFailureCode,
  cutoutMaskAlphaRgba,
  cutoutMaskSha256,
  cutoutStrokesJson,
  cutoutSubjectChoices,
  decodeCutoutMaskPng,
  downscaleCutoutMask,
  readCutoutDetection,
  readCutoutRecipe,
  sameCutoutRecipe,
  selectCutoutSubject,
  selectedCutoutSubject,
  setCutoutBackground,
  type CutoutBrushStroke,
  type CutoutDetection,
} from "./photo-cutout";
import { photoEditingCutoutFailureText, photoEditingCutoutSubjectLabel } from "./photo-editing-copy";

type ParityFixture = {
  width: number;
  height: number;
  input: number[];
  strokes: CutoutBrushStroke[];
  expected: number[];
};

const fixture = syntheticFixture as ParityFixture;

const sha = (char: string) => char.repeat(64);

function detectionJson(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    engine: "VNGenerateForegroundInstanceMaskRequest",
    engineRevision: 1,
    width: 6000,
    height: 4000,
    inputSHA256: sha("a"),
    sourceOrientation: 1,
    largest: "instance-2",
    subjects: [
      { selection: "instance-1", pixelCount: 10, mask: `${sha("1")}.png`, maskSHA256: sha("1"), maskWidth: 6000, maskHeight: 4000 },
      { selection: "instance-2", pixelCount: 90, mask: `${sha("2")}.png`, maskSHA256: sha("2"), maskWidth: 6000, maskHeight: 4000 },
      { selection: "all", pixelCount: 100, mask: `${sha("3")}.png`, maskSHA256: sha("3"), maskWidth: 6000, maskHeight: 4000 },
    ],
    durationMs: 1141,
    ...overrides,
  };
}

function detection(): CutoutDetection {
  const value = readCutoutDetection(detectionJson());
  if (!value) throw new Error("fixture detection did not parse");
  return value;
}

/** 8bit グレーの PNG（行ごとに filter を変えて書く）。 */
function grayPng(width: number, rows: number[][], filters: number[]): Uint8Array {
  const raw: number[] = [];
  rows.forEach((row, y) => {
    const filter = filters[y % filters.length]!;
    raw.push(filter);
    row.forEach((value, x) => {
      const a = x > 0 ? row[x - 1]! : 0;
      const b = y > 0 ? rows[y - 1]![x]! : 0;
      const c = y > 0 && x > 0 ? rows[y - 1]![x - 1]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!;
      raw.push((value - predictor) & 0xff);
    });
  });
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    Buffer.from(data).copy(out, 8);
    // CRC は読み手が見ないので 0 のまま
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const compressed = deflateSync(Buffer.from(raw));
  const half = Math.floor(compressed.length / 2);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("iCCP", new Uint8Array([1, 2, 3])),
      // IDAT を 2 つに分けても読める
      chunk("IDAT", compressed.subarray(0, half)),
      chunk("IDAT", compressed.subarray(half)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

describe("合成数値マスクのブラシ", () => {
  it("手計算したerase・restoreの結果と同じ値を塗る", () => {
    const input = new Uint8Array(fixture.input);
    const painted = applyCutoutStrokes(input, fixture.width, fixture.height, fixture.strokes);
    expect([...painted]).toEqual(fixture.expected);
    // 元のマスクは書き換えない
    expect([...input]).toEqual(fixture.input);
  });

  it("写真の外だけの点は何も塗らず、落ちない", () => {
    const mask = new Uint8Array(100).fill(255);
    const painted = applyCutoutStrokes(mask, 10, 10, [{ mode: "erase", radius: 0.05, points: [{ x: 1.9, y: -0.9 }] }]);
    expect([...painted]).toEqual([...mask]);
  });
});

describe("マスクの PNG", () => {
  it("合成したPNGを数のまま読む", async () => {
    const rows = Array.from({ length: fixture.height }, (_, y) => fixture.input.slice(y * fixture.width, (y + 1) * fixture.width));
    const mask = await decodeCutoutMaskPng(grayPng(fixture.width, rows, [0]));
    expect(mask.width).toBe(fixture.width);
    expect(mask.height).toBe(fixture.height);
    expect([...mask.pixels]).toEqual(fixture.input);
  });

  it("5 種類の filter・分かれた IDAT・色の chunk があっても値を変えない", async () => {
    const rows = [
      [0, 10, 200, 255, 7],
      [255, 0, 128, 64, 1],
      [3, 250, 9, 199, 100],
      [17, 18, 19, 20, 21],
      [99, 0, 255, 0, 99],
    ];
    const mask = await decodeCutoutMaskPng(grayPng(5, rows, [0, 1, 2, 3, 4]));
    expect(mask).toEqual({ width: 5, height: 5, pixels: new Uint8Array(rows.flat()) });
  });

  it("グレー 8bit でない PNG と PNG でないものは読まない", async () => {
    const rgb = grayPng(2, [[0, 0]], [0]);
    rgb[8 + 8 + 9] = 2; // IHDR の color type を RGB に
    await expect(decodeCutoutMaskPng(rgb)).rejects.toThrow(/grayscale/);
    await expect(decodeCutoutMaskPng(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PNG/);
  });
});

describe("detect の答えとレシピ", () => {
  it("detect の 1 行を読み、形の違うものは読まない", () => {
    const value = detection();
    expect(value.largest).toBe("instance-2");
    expect(value.subjects).toHaveLength(3);
    expect(readCutoutDetection(detectionJson({ schemaVersion: 2 }))).toBeNull();
    expect(readCutoutDetection(detectionJson({ largest: "instance-9" }))).toBeNull();
    expect(readCutoutDetection(detectionJson({ inputSHA256: "ABC" }))).toBeNull();
    // マスクの名前は中身の SHA-256 だけ（保存先の外を指す名前は読まない）
    const traversal = detectionJson();
    traversal.subjects[0]!.mask = "../../secret.png";
    expect(readCutoutDetection(traversal)).toBeNull();
    // マスクは画像と同じ寸法
    const smaller = detectionJson();
    smaller.subjects[1]!.maskWidth = 3000;
    expect(readCutoutDetection(smaller)).toBeNull();
  });

  it("推論の直後は最大の被写体・透明・ブラシなし。保存して読み直しても同じ", () => {
    const recipe = createCutoutRecipe(detection());
    expect(recipe.selected).toBe("instance-2");
    expect(recipe.background).toEqual({ kind: "transparent" });
    expect(selectedCutoutSubject(recipe).maskSHA256).toBe(sha("2"));
    const edited = addCutoutStroke(
      setCutoutBackground(selectCutoutSubject(recipe, "all"), { kind: "color", color: "#336699" }),
      { mode: "erase", radius: 0.04, points: [{ x: -0.2, y: 0.5 }, { x: 0.3, y: 0.5 }] },
    );
    const restored = readCutoutRecipe(JSON.parse(JSON.stringify(edited)));
    expect(restored).toEqual(edited);
    expect(sameCutoutRecipe(restored, edited)).toBe(true);
    expect(sameCutoutRecipe(recipe, edited)).toBe(false);
    expect(sameCutoutRecipe(null, null)).toBe(true);
  });

  it("壊れた・古い・範囲の外のレシピは読まない（背景除去なしで開く）", () => {
    const base = JSON.parse(JSON.stringify(createCutoutRecipe(detection())));
    expect(readCutoutRecipe({ ...base, v: 2 })).toBeNull();
    expect(readCutoutRecipe({ ...base, selected: "instance-7" })).toBeNull();
    expect(readCutoutRecipe({ ...base, background: { kind: "color", color: "#FFF" } })).toBeNull();
    for (const stroke of [
      { mode: "erase", radius: 0, points: [{ x: 0, y: 0 }] },
      { mode: "erase", radius: 0.1, points: [] },
      { mode: "paint", radius: 0.1, points: [{ x: 0, y: 0 }] },
      { mode: "restore", radius: 0.1, points: [{ x: 2.5, y: 0 }] },
    ]) {
      expect(readCutoutRecipe({ ...base, strokes: [stroke] })).toBeNull();
    }
  });

  it("同じ操作は同じレシピを返し、点の無いストロークと無い被写体は足さない", () => {
    const recipe = createCutoutRecipe(detection());
    expect(selectCutoutSubject(recipe, "instance-2")).toBe(recipe);
    expect(selectCutoutSubject(recipe, "instance-5")).toBe(recipe);
    expect(setCutoutBackground(recipe, { kind: "transparent" })).toBe(recipe);
    expect(addCutoutStroke(recipe, { mode: "erase", radius: 0.1, points: [] })).toBe(recipe);
  });

  it("被写体の並びは最大 → 番号順 → すべて。1 つだけなら「すべて」を出さない", () => {
    expect(cutoutSubjectChoices(detection())).toEqual(["instance-2", "instance-1", "all"]);
    const single = readCutoutDetection(
      detectionJson({
        largest: "instance-1",
        subjects: [
          { selection: "instance-1", pixelCount: 10, mask: `${sha("1")}.png`, maskSHA256: sha("1"), maskWidth: 6000, maskHeight: 4000 },
          { selection: "all", pixelCount: 10, mask: `${sha("1")}.png`, maskSHA256: sha("1"), maskWidth: 6000, maskHeight: 4000 },
        ],
      }),
    );
    expect(single && cutoutSubjectChoices(single)).toEqual(["instance-1"]);
    expect(photoEditingCutoutSubjectLabel("instance-2", 1)).toBe("被写体 1");
    expect(photoEditingCutoutSubjectLabel("all", 3)).toBe("すべて");
  });

  it("compose に渡す値（背景・ブラシの JSON・JPEG の透明は白）", () => {
    expect(cutoutBackgroundArgument({ kind: "transparent" })).toBe("transparent");
    expect(cutoutBackgroundArgument({ kind: "white" })).toBe("white");
    expect(cutoutBackgroundArgument({ kind: "color", color: "#102030" })).toBe("#102030");
    expect(JSON.parse(cutoutStrokesJson([{ mode: "restore", radius: 0.1, points: [{ x: 0.5, y: 0.25 }] }]))).toEqual([
      { mode: "restore", radius: 0.1, points: [{ x: 0.5, y: 0.25 }] },
    ]);
    expect(cutoutBackgroundForFormat({ kind: "transparent" }, "jpeg")).toEqual({ kind: "white" });
    expect(cutoutBackgroundForFormat({ kind: "transparent" }, "png")).toEqual({ kind: "transparent" });
    expect(cutoutBackgroundForFormat({ kind: "color", color: "#000000" }, "jpeg")).toEqual({ kind: "color", color: "#000000" });
  });
});

describe("プレビューの合成", () => {
  it("面積平均で縮め、拡大はしない", () => {
    const mask = { width: 4, height: 2, pixels: new Uint8Array([0, 255, 100, 100, 255, 0, 50, 150]) };
    expect(downscaleCutoutMask(mask, 2, 1)).toEqual({ width: 2, height: 1, pixels: new Uint8Array([128, 100]) });
    expect(downscaleCutoutMask(mask, 8, 4)).toBe(mask);
    // 割り切れない比でも平均を保つ（3 → 2）
    const ramp = downscaleCutoutMask({ width: 3, height: 1, pixels: new Uint8Array([0, 90, 180]) }, 2, 1);
    expect([...ramp.pixels]).toEqual([30, 150]);
  });

  it("透明はマスク × 元の alpha、色の背景は後ろに敷いて不透明にする", () => {
    const rgba = new Uint8ClampedArray([200, 100, 50, 255, 200, 100, 50, 128]);
    const mask = { width: 2, height: 1, pixels: new Uint8Array([128, 255]) };
    expect([...composeCutoutRgba(rgba, mask, { kind: "transparent" })]).toEqual([200, 100, 50, 128, 200, 100, 50, 128]);
    const white = composeCutoutRgba(rgba, mask, { kind: "white" });
    expect([white[3], white[7]]).toEqual([255, 255]);
    expect(white[0]).toBe(Math.round(200 * (128 / 255) + 255 * (1 - 128 / 255)));
    const blue = composeCutoutRgba(new Uint8ClampedArray([255, 0, 0, 255]), { width: 1, height: 1, pixels: new Uint8Array([0]) }, { kind: "color", color: "#0000ff" });
    expect([...blue]).toEqual([0, 0, 255, 255]);
    expect(() => composeCutoutRgba(rgba, { width: 1, height: 1, pixels: new Uint8Array([0]) }, { kind: "white" })).toThrow();
  });

  it("canvas に当てる alpha の画像", () => {
    expect([...cutoutMaskAlphaRgba({ width: 2, height: 1, pixels: new Uint8Array([0, 200]) })]).toEqual([255, 255, 255, 0, 255, 255, 255, 200]);
  });
});

describe("失敗の 1 行", () => {
  it("sidecar の error ごとに状態と次の一歩を出し、知らないものは一般の 1 行", () => {
    expect(photoEditingCutoutFailureText("no_subjects")).toBe("切り抜ける人や物が見つかりませんでした。");
    expect(photoEditingCutoutFailureText("mask_mismatch")).toContain("もう一度");
    expect(photoEditingCutoutFailureText("whatever")).toBe("背景を除去できませんでした。もう一度お試しください。");
  });

  it("マスクの PNG の SHA-256 は、sidecar の maskSHA256 と同じ小文字の 16 進（バイト列そのもの）", async () => {
    // 既知の SHA-256（空と "abc"）。subarray でも、見えている範囲だけを数える
    expect(await cutoutMaskSha256(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await cutoutMaskSha256(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const padded = new TextEncoder().encode("xabcx");
    expect(await cutoutMaskSha256(padded.subarray(1, 4))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("口の失敗から符号を読む（文字列の code・止めた・ほか）", () => {
    expect(cutoutFailureCode(Object.assign(new Error("no subjects"), { code: "no_subjects" }))).toBe("no_subjects");
    expect(cutoutFailureCode({ code: "engine_failed" })).toBe("engine_failed");
    // 空の code・文字列でない code は読まない
    expect(cutoutFailureCode(Object.assign(new Error("x"), { code: "" }))).toBe("internal_error");
    expect(cutoutFailureCode(Object.assign(new Error("x"), { code: 5 }))).toBe("internal_error");
    // DOMException の AbortError（`code` は数の 20）と、名前だけの AbortError
    expect(cutoutFailureCode(new DOMException("stopped", "AbortError"))).toBe("aborted");
    expect(cutoutFailureCode(Object.assign(new Error("stopped"), { name: "AbortError" }))).toBe("aborted");
    expect(cutoutFailureCode(new Error("boom"))).toBe("internal_error");
    expect(cutoutFailureCode("no_subjects")).toBe("internal_error");
    expect(cutoutFailureCode(null)).toBe("internal_error");
    expect(cutoutFailureCode(undefined)).toBe("internal_error");
  });
});
