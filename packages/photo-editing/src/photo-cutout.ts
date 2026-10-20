/**
 * 背景除去（NIHO camera だけ。`capabilities.cutout`。C4 ）の、画面の側の型と計算。
 *
 * 推論と原寸の書き出しは sidecar `niho-camera-cutout`（`packages/develop-engine/tools/niho-camera-cutout`。Apple Vision）がする:
 * `detect` が被写体ごとのマスクを不変の PNG で保存し、`compose` が保存したマスク・ブラシ・背景を当てて書き出す
 * （README「機械が読む契約」）。ここはその JSON の読み口と、編集の 1 単位（レシピ）、プレビューのためのブラシと合成。
 *
 * - レシピは `developSettings` に入れない（段 2 の wasm と web は背景除去を描かないため。camera はこの Mac の補正の隣に保存する）。
 * - マスクは EXIF の向きを当てた元画像の枠。背景除去と切り抜き・回転は同時に使わない（spec Decisions）。
 * - ブラシは sidecar の `MaskRaster.applying` と同じ計算。公開版は独立した数値fixtureで検証し、sidecarとのparity検証は別途行う。
 */

export const CUTOUT_RECIPE_VERSION = 1;
/** sidecar の `detect` の `schemaVersion`（`CutoutMaskReference.currentSchemaVersion`）。 */
export const CUTOUT_DETECTION_SCHEMA_VERSION = 1;

export type CutoutSelection = "all" | `instance-${number}`;
export type CutoutBrushMode = "erase" | "restore";
export type CutoutPoint = { readonly x: number; readonly y: number };
/** 座標は画像の左上を原点に 0〜1（写真の外へ出た点は -1〜2 まで残す）。`radius` は短い辺に対する割合。 */
export type CutoutBrushStroke = {
  readonly mode: CutoutBrushMode;
  readonly radius: number;
  readonly points: readonly CutoutPoint[];
};
export type CutoutBackground =
  | { readonly kind: "transparent" }
  | { readonly kind: "white" }
  /** `#rrggbb`（小文字） */
  | { readonly kind: "color"; readonly color: string };

export type CutoutSubject = {
  readonly selection: CutoutSelection;
  readonly pixelCount: number;
  /** `<maskSHA256>.png`（`detect` の `--masks-dir` の中の名前） */
  readonly mask: string;
  readonly maskSHA256: string;
  readonly maskWidth: number;
  readonly maskHeight: number;
};

/** `niho-camera-cutout detect` の 1 行（`durationMs` は持たない）。 */
export type CutoutDetection = {
  readonly schemaVersion: number;
  readonly engine: string;
  readonly engineRevision: number;
  /** EXIF の向きを当てた後の寸法 */
  readonly width: number;
  readonly height: number;
  readonly inputSHA256: string;
  readonly sourceOrientation: number;
  readonly largest: CutoutSelection;
  readonly subjects: readonly CutoutSubject[];
};

/** 編集の 1 単位。取り消しはこの単位で戻す（ブラシは 1 ストロークが 1 回）。 */
export type CutoutRecipe = {
  readonly v: typeof CUTOUT_RECIPE_VERSION;
  readonly detection: CutoutDetection;
  readonly selected: CutoutSelection;
  readonly background: CutoutBackground;
  readonly strokes: readonly CutoutBrushStroke[];
};

export type CutoutMask = { readonly width: number; readonly height: number; readonly pixels: Uint8Array };

/** 背景除去の口（NIHO camera だけが編集面に渡す。web は渡さない＝道具を出さない）。 */
export type PhotoEditingCutoutHost = {
  /** 保存したレシピ（無ければ null。原本が変わっていれば host が null を返す） */
  loadRecipe: (photoKey: string) => Promise<CutoutRecipe | null>;
  /** null は外す。失敗は reject */
  saveRecipe: (photoKey: string, recipe: CutoutRecipe | null) => Promise<void>;
  /** sidecar `detect`。signal で止める。失敗は `code`（sidecar の error。例 no_subjects）を持つ Error で reject、止めたら AbortError */
  detect: (photoKey: string, signal: AbortSignal) => Promise<CutoutDetection>;
  /** マスクの PNG のバイト列（`subject.mask`） */
  readMask: (photoKey: string, subject: CutoutSubject) => Promise<Uint8Array>;
  /**
   * 原寸の書き出し（camera の native: 段 2 で原寸を描き、sidecar の compose で背景除去を当てて保存ダイアログで保存）。無ければ「原寸」を出さない。
   * 保存ダイアログを閉じたら `saved: false`。失敗は `code`（sidecar の error）を持つ Error で reject（code の無い失敗は「書き出せませんでした」の 1 行）
   */
  exportFullSize?: (
    photoKey: string,
    request: { recipe: CutoutRecipe; settings: object; format: "png" | "jpeg" },
  ) => Promise<{ saved: boolean; fileName: string }>;
};

/**
 * 口の失敗（{@link PhotoEditingCutoutHost} の reject）を、画面の 1 行（`photoEditingCutoutFailureText`）を選ぶ符号にする:
 * `code` が空でない文字列ならそれ（sidecar の error）、止めた（AbortError）なら `aborted`、ほかは `internal_error`。
 */
export function cutoutFailureCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    // DOMException の `code` は数（ABORT_ERR = 20）なので、文字列の `code` だけを sidecar の error として読む
    const code: unknown = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    if ((error as { name?: unknown }).name === "AbortError") return "aborted";
  }
  return "internal_error";
}

/** ブラシの大きさの既定と範囲（短い辺に対する割合）。 */
export const CUTOUT_BRUSH_RADIUS_DEFAULT = 0.04;
export const CUTOUT_BRUSH_RADIUS_MIN = 0.005;
export const CUTOUT_BRUSH_RADIUS_MAX = 0.25;
/** sidecar の `compose` が受け付ける点の範囲。 */
const CUTOUT_POINT_MIN = -1;
const CUTOUT_POINT_MAX = 2;

const SHA256_RE = /^[0-9a-f]{64}$/;
const SELECTION_RE = /^(all|instance-[1-9][0-9]*)$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readSelection(value: unknown): CutoutSelection | null {
  return typeof value === "string" && SELECTION_RE.test(value) ? (value as CutoutSelection) : null;
}

function readSubject(value: unknown): CutoutSubject | null {
  if (!isRecord(value)) return null;
  const selection = readSelection(value.selection);
  const maskSHA256 = typeof value.maskSHA256 === "string" && SHA256_RE.test(value.maskSHA256) ? value.maskSHA256 : null;
  const maskWidth = positiveInteger(value.maskWidth);
  const maskHeight = positiveInteger(value.maskHeight);
  const pixelCount = typeof value.pixelCount === "number" && Number.isInteger(value.pixelCount) && value.pixelCount >= 0 ? value.pixelCount : null;
  if (!selection || !maskSHA256 || !maskWidth || !maskHeight || pixelCount === null) return null;
  // マスクの名前は中身の SHA-256（ほかの名前は、保存先の外を指しうるので読まない）
  if (value.mask !== `${maskSHA256}.png`) return null;
  return { selection, pixelCount, mask: value.mask, maskSHA256, maskWidth, maskHeight };
}

/** sidecar の `detect` の答え（または保存したレシピの `detection`）を確かめて読む。形が違えば null。 */
export function readCutoutDetection(value: unknown): CutoutDetection | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== CUTOUT_DETECTION_SCHEMA_VERSION) return null;
  const width = positiveInteger(value.width);
  const height = positiveInteger(value.height);
  const engineRevision = positiveInteger(value.engineRevision);
  const sourceOrientation = positiveInteger(value.sourceOrientation);
  const largest = readSelection(value.largest);
  if (!width || !height || !engineRevision || !sourceOrientation || !largest) return null;
  if (typeof value.engine !== "string" || value.engine.length === 0) return null;
  if (typeof value.inputSHA256 !== "string" || !SHA256_RE.test(value.inputSHA256)) return null;
  if (!Array.isArray(value.subjects)) return null;
  const subjects: CutoutSubject[] = [];
  for (const entry of value.subjects) {
    const subject = readSubject(entry);
    // マスクは画像と同じ寸法（Vision が画像の大きさに合わせる）
    if (!subject || subject.maskWidth !== width || subject.maskHeight !== height) return null;
    subjects.push(subject);
  }
  if (!subjects.some((subject) => subject.selection === largest)) return null;
  return {
    schemaVersion: CUTOUT_DETECTION_SCHEMA_VERSION,
    engine: value.engine,
    engineRevision,
    width,
    height,
    inputSHA256: value.inputSHA256,
    sourceOrientation,
    largest,
    subjects,
  };
}

function readBackground(value: unknown): CutoutBackground | null {
  if (!isRecord(value)) return null;
  if (value.kind === "transparent" || value.kind === "white") return { kind: value.kind };
  if (value.kind === "color" && typeof value.color === "string" && COLOR_RE.test(value.color)) {
    return { kind: "color", color: value.color };
  }
  return null;
}

function readStroke(value: unknown): CutoutBrushStroke | null {
  if (!isRecord(value)) return null;
  if (value.mode !== "erase" && value.mode !== "restore") return null;
  const radius = value.radius;
  if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0 || radius > 1) return null;
  if (!Array.isArray(value.points) || value.points.length === 0) return null;
  const points: CutoutPoint[] = [];
  for (const point of value.points) {
    if (!isRecord(point)) return null;
    const { x, y } = point;
    if (typeof x !== "number" || typeof y !== "number") return null;
    if (!(x >= CUTOUT_POINT_MIN && x <= CUTOUT_POINT_MAX && y >= CUTOUT_POINT_MIN && y <= CUTOUT_POINT_MAX)) return null;
    points.push({ x, y });
  }
  return { mode: value.mode, radius, points };
}

/** 保存したレシピを読む。版や形が違えば null（背景除去なしとして開く）。 */
export function readCutoutRecipe(value: unknown): CutoutRecipe | null {
  if (!isRecord(value) || value.v !== CUTOUT_RECIPE_VERSION) return null;
  const detection = readCutoutDetection(value.detection);
  const selected = readSelection(value.selected);
  const background = readBackground(value.background);
  if (!detection || !selected || !background || !Array.isArray(value.strokes)) return null;
  if (!detection.subjects.some((subject) => subject.selection === selected)) return null;
  const strokes: CutoutBrushStroke[] = [];
  for (const entry of value.strokes) {
    const stroke = readStroke(entry);
    if (!stroke) return null;
    strokes.push(stroke);
  }
  return { v: CUTOUT_RECIPE_VERSION, detection, selected, background, strokes };
}

/** 推論の直後のレシピ: 面積が最大の被写体・透明の背景・ブラシなし。 */
export function createCutoutRecipe(detection: CutoutDetection): CutoutRecipe {
  return { v: CUTOUT_RECIPE_VERSION, detection, selected: detection.largest, background: { kind: "transparent" }, strokes: [] };
}

/** 被写体を選び直す（ブラシは画像の座標なので残す）。無い被写体なら同じレシピを返す。 */
export function selectCutoutSubject(recipe: CutoutRecipe, selection: CutoutSelection): CutoutRecipe {
  if (selection === recipe.selected) return recipe;
  if (!recipe.detection.subjects.some((subject) => subject.selection === selection)) return recipe;
  return { ...recipe, selected: selection };
}

export function setCutoutBackground(recipe: CutoutRecipe, background: CutoutBackground): CutoutRecipe {
  return sameCutoutBackground(recipe.background, background) ? recipe : { ...recipe, background };
}

/** ブラシの 1 ストロークを足す（点の無いストロークは足さない）。 */
export function addCutoutStroke(recipe: CutoutRecipe, stroke: CutoutBrushStroke): CutoutRecipe {
  return stroke.points.length === 0 ? recipe : { ...recipe, strokes: [...recipe.strokes, stroke] };
}

export function selectedCutoutSubject(recipe: CutoutRecipe): CutoutSubject {
  return recipe.detection.subjects.find((subject) => subject.selection === recipe.selected) ?? recipe.detection.subjects[0]!;
}

function sameCutoutBackground(a: CutoutBackground, b: CutoutBackground): boolean {
  return a.kind === b.kind && (a.kind !== "color" || a.color === (b as { color: string }).color);
}

/** 取り消しの履歴の「同じか」。レシピは置き換えで作るので、中身で比べる。 */
export function sameCutoutRecipe(a: CutoutRecipe | null, b: CutoutRecipe | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 被写体の並び: 最大 → 番号順 → 「すべて」（`all` は被写体が 2 つ以上のときだけ選ぶ意味がある）。 */
export function cutoutSubjectChoices(detection: CutoutDetection): CutoutSelection[] {
  const instances = detection.subjects
    .filter((subject) => subject.selection !== "all")
    .map((subject) => subject.selection)
    .sort((a, b) => (a === detection.largest ? -1 : b === detection.largest ? 1 : instanceNumber(a) - instanceNumber(b)));
  return instances.length > 1 && detection.subjects.some((subject) => subject.selection === "all") ? [...instances, "all"] : instances;
}

function instanceNumber(selection: CutoutSelection): number {
  return selection === "all" ? Number.POSITIVE_INFINITY : Number(selection.slice("instance-".length));
}

/** `compose --background` の値。 */
export function cutoutBackgroundArgument(background: CutoutBackground): string {
  return background.kind === "color" ? background.color : background.kind;
}

/** `compose --strokes` のファイルの中身（sidecar の `CutoutBrushStroke` と同じ名前）。 */
export function cutoutStrokesJson(strokes: readonly CutoutBrushStroke[]): string {
  return JSON.stringify(strokes.map((stroke) => ({ mode: stroke.mode, radius: stroke.radius, points: stroke.points.map(({ x, y }) => ({ x, y })) })));
}

/** 書き出しの形式ごとの背景（JPEG は透明を持てないので、透明は白にする。sidecar と同じ）。 */
export function cutoutBackgroundForFormat(background: CutoutBackground, format: "png" | "jpeg"): CutoutBackground {
  return format === "jpeg" && background.kind === "transparent" ? { kind: "white" } : background;
}

// --- ブラシ（sidecar の MaskRaster.applying と同じ計算） -------------------------------

/**
 * ブラシを順に塗った新しいマスク（`pixels` は書き換えない）。0 = 背景・255 = 被写体。消すは被写体を減らし、戻すは元の画素へ戻す。
 * 筆は点の間を半径の 0.35 倍（1px 以上）の間隔で補い、中心から半径の 72% までは全部・その外は縁へ向けて薄く塗る。
 */
export function applyCutoutStrokes(
  pixels: Uint8Array,
  width: number,
  height: number,
  strokes: readonly CutoutBrushStroke[],
): Uint8Array {
  const result = new Uint8Array(pixels);
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const radius = Math.max(0.5, stroke.radius * Math.min(width, height));
    const samples: CutoutPoint[] = [];
    stroke.points.forEach((point, index) => {
      if (index === 0) {
        samples.push(point);
        return;
      }
      const previous = stroke.points[index - 1]!;
      const dx = (point.x - previous.x) * width;
      const dy = (point.y - previous.y) * height;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / Math.max(1, radius * 0.35)));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        samples.push({ x: previous.x + (point.x - previous.x) * t, y: previous.y + (point.y - previous.y) * t });
      }
    });
    for (const point of samples) {
      paintDab(result, width, height, point.x * (width - 1), point.y * (height - 1), radius, stroke.mode);
    }
  }
  return result;
}

function paintDab(
  base: Uint8Array,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  mode: CutoutBrushMode,
) {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  if (minX > maxX || minY > maxY) return;
  const featherStart = radius * 0.72;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > radius) continue;
      const coverage = distance <= featherStart ? 1 : 1 - (distance - featherStart) / Math.max(0.001, radius - featherStart);
      const index = y * width + x;
      const current = base[index]! / 255;
      const updated = mode === "erase" ? current * (1 - coverage) : current + (1 - current) * coverage;
      base[index] = Math.max(0, Math.min(255, Math.round(updated * 255)));
    }
  }
}

// --- プレビュー -------------------------------------------------------------------

/**
 * マスクを面積平均で縮める（プレビューの大きさへ。1 回だけ。ブラシは縮めた後に同じ計算で塗る）。拡大はしない（同じ寸法ならそのまま）。
 */
export function downscaleCutoutMask(mask: CutoutMask, targetWidth: number, targetHeight: number): CutoutMask {
  const width = Math.max(1, Math.min(mask.width, Math.round(targetWidth)));
  const height = Math.max(1, Math.min(mask.height, Math.round(targetHeight)));
  if (width === mask.width && height === mask.height) return mask;
  const sums = new Float64Array(width * height);
  const weights = new Float64Array(width * height);
  const scaleX = width / mask.width;
  const scaleY = height / mask.height;
  for (let sy = 0; sy < mask.height; sy += 1) {
    const top = sy * scaleY;
    const bottom = (sy + 1) * scaleY;
    for (let sx = 0; sx < mask.width; sx += 1) {
      const left = sx * scaleX;
      const right = (sx + 1) * scaleX;
      const value = mask.pixels[sy * mask.width + sx]!;
      // 元の 1 画素が掛かる縮めた先の画素へ、重なった面積で配る
      for (let dy = Math.floor(top); dy < Math.min(height, Math.ceil(bottom)); dy += 1) {
        const overlapY = Math.min(bottom, dy + 1) - Math.max(top, dy);
        if (overlapY <= 0) continue;
        for (let dx = Math.floor(left); dx < Math.min(width, Math.ceil(right)); dx += 1) {
          const overlap = (Math.min(right, dx + 1) - Math.max(left, dx)) * overlapY;
          if (overlap <= 0) continue;
          sums[dy * width + dx]! += value * overlap;
          weights[dy * width + dx]! += overlap;
        }
      }
    }
  }
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = weights[index]! > 0 ? Math.round(sums[index]! / weights[index]!) : 0;
  }
  return { width, height, pixels };
}

function backgroundRgb(background: CutoutBackground): [number, number, number] | null {
  if (background.kind === "transparent") return null;
  if (background.kind === "white") return [255, 255, 255];
  const raw = Number.parseInt(background.color.slice(1), 16);
  return [(raw >> 16) & 0xff, (raw >> 8) & 0xff, raw & 0xff];
}

/**
 * 描いた RGBA（ストレートの alpha）にマスク（同じ寸法）と背景を当てた RGBA を返す（`rgba` は書き換えない）。sidecar の合成と同じ順:
 * まず元の alpha × マスクで切り抜き、色の背景はその後ろに敷いて不透明にする（元が透明な画素で背景に穴を開けない）。
 */
export function composeCutoutRgba(
  rgba: Uint8ClampedArray,
  mask: CutoutMask,
  background: CutoutBackground,
): Uint8ClampedArray<ArrayBuffer> {
  if (rgba.length !== mask.width * mask.height * 4) throw new Error("cutout: the image and the mask differ in size");
  const out = new Uint8ClampedArray(rgba.length);
  const fill = backgroundRgb(background);
  for (let index = 0; index < mask.pixels.length; index += 1) {
    const offset = index * 4;
    const alpha = (rgba[offset + 3]! / 255) * (mask.pixels[index]! / 255);
    if (!fill) {
      out[offset] = rgba[offset]!;
      out[offset + 1] = rgba[offset + 1]!;
      out[offset + 2] = rgba[offset + 2]!;
      out[offset + 3] = Math.round(alpha * 255);
      continue;
    }
    out[offset] = Math.round(rgba[offset]! * alpha + fill[0] * (1 - alpha));
    out[offset + 1] = Math.round(rgba[offset + 1]! * alpha + fill[1] * (1 - alpha));
    out[offset + 2] = Math.round(rgba[offset + 2]! * alpha + fill[2] * (1 - alpha));
    out[offset + 3] = 255;
  }
  return out;
}

/** canvas の `destination-in` に使う、alpha = マスクの RGBA（色は白。そのまま `ImageData` に渡せる）。 */
export function cutoutMaskAlphaRgba(mask: CutoutMask): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(mask.pixels.length * 4);
  for (let index = 0; index < mask.pixels.length; index += 1) {
    const offset = index * 4;
    out[offset] = 255;
    out[offset + 1] = 255;
    out[offset + 2] = 255;
    out[offset + 3] = mask.pixels[index]!;
  }
  return out;
}

// --- マスクの PNG ---------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * マスクの PNG のバイト列の SHA-256（小文字の 16 進）。sidecar の `maskSHA256`（`detect` が書いた PNG のファイルそのものの
 * SHA-256）と同じ値になる。口から読んだ PNG が、レシピの被写体のマスクと同じ中身かを、画に当てる前に確かめるのに使う。
 */
export async function cutoutMaskSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * sidecar が書いたマスクの PNG（8bit グレー・インターレースなし）を、色の管理をせずに数のまま読む。ブラウザの画像の読み込みは
 * グレーの PNG に色の変換（ICC・gAMA）を掛けうるので使わない。形が違えば例外。
 */
export async function decodeCutoutMaskPng(bytes: Uint8Array): Promise<CutoutMask> {
  if (bytes.length < 8 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("cutout mask: not a PNG");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error("cutout mask: truncated PNG");
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const [bitDepth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (bitDepth !== 8 || colorType !== 0 || interlace !== 0) {
        throw new Error("cutout mask: expected an 8-bit grayscale, non-interlaced PNG");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error("cutout mask: missing IHDR or IDAT");
  const compressed = new Uint8Array(idat.reduce((total, chunk) => total + chunk.length, 0));
  let cursor = 0;
  for (const chunk of idat) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }
  const inflated = new Uint8Array(
    await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer(),
  );
  const stride = width;
  if (inflated.length !== (stride + 1) * height) throw new Error("cutout mask: unexpected image data size");
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (stride + 1)]!;
    const row = inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * width, (y + 1) * width);
    const up = y > 0 ? pixels.subarray((y - 1) * width, y * width) : null;
    for (let x = 0; x < width; x += 1) {
      const a = x > 0 ? out[x - 1]! : 0;
      const b = up ? up[x]! : 0;
      const c = up && x > 0 ? up[x - 1]! : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`cutout mask: unknown PNG filter ${filter}`);
      }
      out[x] = (row[x]! + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
}
