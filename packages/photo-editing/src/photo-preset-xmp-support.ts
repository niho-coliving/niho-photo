import {
  PHOTO_EDITING_PRESET_ITEM_SEPARATOR,
  PHOTO_EDITING_PRESET_UNSUPPORTED_LABELS as LABELS,
  photoEditingPresetImportPartialText,
  photoEditingPresetOtherItemsText,
} from "./photo-editing-copy";

/**
 * Lightroom のプリセット（XMP）のうち、NIHO の現像エンジンが使えないものの見分け（NIHO Photo 段 1 F2b 移行元設計）。
 *
 * - {@link summarizeUnsupportedPresetItems}: エンジンの `presetSettings` が返す `unsupported`（XMP の項目名。crate の
 *   `xmp.rs` の `UNSUPPORTED_KNOWN`・知らない項目・まだ描けない効果・埋め込みの Look の `Look.<項目>`・読めなかったマスクの
 *   `MaskGroupBasedCorrections.<n>.<理由>`）を、Lightroom の日本語の名前にまとめる。表に無い項目は数だけ数える。シャープ・ノイズ軽減・
 *   カラーノイズの軽減は crate 0.19.0（Issue #32）から近い式で描く（`approximate`）ので、ここに来るのは読めない値と、既定でない
 *   ノイズ軽減の細かな項目（ディテール・コントラスト・滑らかさ）だけ
 * - {@link presetUsesLightroomColorTable}: Lightroom 専用の色の表（プロファイルの LUT）を使うプリセットか
 */

type UnsupportedGroup = {
  label: string;
  /** この群の項目名（完全一致） */
  keys?: readonly string[];
  /** この群の項目名（前方一致） */
  prefixes?: readonly string[];
  /** この群の項目名（正規表現。マスクの `<一覧>.<n>.<理由>`） */
  pattern?: RegExp;
  /**
   * 群の主の項目。XMP にある主の項目がすべて「効かない値」（0 / False）なら、群ごと知らせない（Lightroom は全項目を書き出すので、
   * 量が 0 のシャープの半径などは、プリセットが持っていても何もしない）。主の項目が XMP に 1 つも無ければ、知らせる
   */
  masters?: readonly string[];
  /** 値を見ずに知らせる（エンジンが、効く値のときだけ `unsupported` に入れる項目） */
  always?: boolean;
  /** 0 / False のほかに「効かない値」とみなす値 */
  noEffect?: (value: string) => boolean;
};

/** crate がマスクを読む Lightroom の局所補正の一覧（`xmp/masks.rs` の `LOCAL_CORRECTION_LISTS`）。 */
const CORRECTION_LISTS = [
  "MaskGroupBasedCorrections",
  "GradientBasedCorrections",
  "CircularGradientBasedCorrections",
  "PaintBasedCorrections",
] as const;

/** 読めなかったマスクの項目（`<一覧>.<n>.<理由か Local の項目>`）の正規表現。 */
function maskItems(details: readonly string[]): RegExp {
  return new RegExp(`^(?:${CORRECTION_LISTS.join("|")})\\.\\d+\\.(?:${details.join("|")})$`, "u");
}

/**
 * マスクの群。crate はマスクの理由を、効く（値が既定でない）ときだけ `unsupported` に入れるので、値を見ずに知らせる。結果の
 * マスクを画面で読めなかったとき（`develop-engine-results.ts` の `UNREADABLE_PRESET_MASKS_ITEM`）も「読めないマスク」。
 */
const MASK_GROUPS: readonly UnsupportedGroup[] = [
  { label: LABELS.maskBrush, pattern: maskItems(["brush"]), always: true },
  { label: LABELS.maskAi, pattern: maskItems(["aiMask"]), always: true },
  { label: LABELS.maskRange, pattern: maskItems(["rangeMask"]), always: true },
  {
    label: LABELS.maskRadialShape,
    pattern: maskItems(["rotatedRadial", "radialRoundness", "radialMidpoint", "radialFlipped", "radialVersion"]),
    always: true,
  },
  { label: LABELS.maskCombined, pattern: maskItems(["multipleMasks", "maskBlend"]), always: true },
  { label: LABELS.maskOpacity, pattern: maskItems(["maskValue"]), always: true },
  { label: LABELS.maskLimit, pattern: maskItems(["tooMany"]), always: true },
  { label: LABELS.maskColor, pattern: maskItems(["LocalHue", "LocalToningSaturation"]), always: true },
  {
    label: LABELS.maskDetail,
    pattern: maskItems(["LocalSharpness", "LocalLuminanceNoise", "LocalMoire", "LocalDefringe"]),
    always: true,
  },
  {
    label: LABELS.maskLegacy,
    pattern: maskItems(["LocalBrightness", "LocalExposure", "LocalContrast", "LocalClarity"]),
    always: true,
  },
  { label: LABELS.maskWhiteBalance, pattern: maskItems(["LocalTemperature", "LocalTint"]), always: true },
  // 旧形式の一覧（GradientBasedCorrections など）は、実物の XMP で形を確かめるまで読まない
  { label: LABELS.maskLegacyList, pattern: maskItems(["legacyList"]), always: true },
  {
    label: LABELS.maskUnreadable,
    keys: ["MaskGroupBasedCorrections"],
    pattern: maskItems(["outOfRange", "invalid", "unknownMask"]),
    always: true,
  },
];

/** 並びは知らせに出す順。 */
const UNSUPPORTED_GROUPS: readonly UnsupportedGroup[] = [
  {
    label: LABELS.sharpen,
    keys: ["Sharpness", "SharpenRadius", "SharpenDetail", "SharpenEdgeMasking"],
    masters: ["Sharpness"],
  },
  { label: LABELS.noiseReduction, keys: ["LuminanceSmoothing"], masters: ["LuminanceSmoothing"] },
  {
    label: LABELS.noiseReductionDetail,
    keys: ["LuminanceNoiseReductionDetail", "LuminanceNoiseReductionContrast"],
    masters: ["LuminanceSmoothing"],
  },
  { label: LABELS.colorNoiseReduction, keys: ["ColorNoiseReduction"], masters: ["ColorNoiseReduction"] },
  {
    label: LABELS.colorNoiseReductionDetail,
    prefixes: ["ColorNoiseReduction"],
    masters: ["ColorNoiseReduction"],
  },
  { label: LABELS.chromaticAberration, keys: ["AutoLateralCA"] },
  { label: LABELS.defringe, prefixes: ["Defringe"], masters: ["DefringePurpleAmount", "DefringeGreenAmount"] },
  {
    label: LABELS.lensCorrection,
    prefixes: ["LensProfile", "LensManual"],
    masters: ["LensProfileEnable", "LensManualDistortionAmount"],
  },
  { label: LABELS.incrementalWhiteBalance, keys: ["IncrementalTemperature", "IncrementalTint"] },
  { label: LABELS.blackAndWhite, keys: ["ConvertToGrayscale"], prefixes: ["GrayMixer"], masters: ["ConvertToGrayscale"] },
  {
    label: LABELS.vignette,
    keys: ["VignetteAmount", "VignetteMidpoint"],
    prefixes: ["PostCropVignette"],
    masters: ["PostCropVignetteAmount", "VignetteAmount"],
  },
  { label: LABELS.grain, prefixes: ["Grain"], masters: ["GrainAmount"] },
  // カラーグレーディングの中間調・全体の輝度（`ColorGradeMidtoneLum` / `ColorGradeGlobalLum`）は、エンジン 0.19.0 から描く
  // （niho-photo#39。crate は `unsupported` に入れない）ので、ここには置かない
  { label: LABELS.curveSaturation, keys: ["CurveRefineSaturation"], always: true },
  { label: LABELS.pointColors, keys: ["PointColors"], always: true },
  // 変形の手動のスライダー（`Perspective*`）と「切り抜きを制限」（`CropConstrainToWarp`）は、エンジン 0.20.0 から描く（niho-photo#46。
  // crate は `unsupported` に入れない）。残るのは Upright の自動計算（`PerspectiveUpright` がオンのときの `Upright*`）だけ
  {
    label: LABELS.upright,
    keys: ["PerspectiveUpright"],
    prefixes: ["Upright"],
    masters: ["PerspectiveUpright"],
  },
  // 既定のプロファイル（Default Color など）は写真のルックを変えない
  { label: LABELS.profile, keys: ["CameraProfile"], noEffect: (value) => /^default\b/i.test(value.trim()) },
  ...MASK_GROUPS,
];

/**
 * 知らせない項目。埋め込みの Look（`Look.<項目>`）は、Adobe Color（既定）なら NIHO の標準ルックで置き換え、ほかのプロファイルは
 * 取り込む前の確認（{@link presetUsesLightroomColorTable}）で伝える。
 */
const IGNORED_PREFIXES: readonly string[] = ["Look."];
const IGNORED_KEYS: ReadonlySet<string> = new Set(["CameraProfileDigest"]);

function matchesGroup(group: UnsupportedGroup, key: string): boolean {
  return (
    (group.keys?.includes(key) ?? false) ||
    (group.prefixes?.some((prefix) => key.startsWith(prefix)) ?? false) ||
    (group.pattern?.test(key) ?? false)
  );
}

const LOOK_BLOCK_PATTERN = /<crs:Look\b[^>]*?(?:\/>|>[\s\S]*?<\/crs:Look\s*>)/g;
/** 局所補正の一覧（マスクごとに `crs:Version` などの同じ名前の値を持つので、根の値として読まない）。 */
const CORRECTION_BLOCK_PATTERN = new RegExp(
  `<crs:(${CORRECTION_LISTS.join("|")})\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/crs:\\1\\s*>)`,
  "g",
);
const CRS_ATTRIBUTE_PATTERN = /\bcrs:([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const CRS_ELEMENT_PATTERN = /<crs:([A-Za-z0-9_]+)\s*>([^<]*)<\/crs:\1\s*>/g;

/** XMP の根の Camera Raw の値（属性と単純な要素。埋め込みの Look と局所補正の一覧の中は読まない）。 */
function readRootCrsValues(xmp: string): Map<string, string> {
  const root = xmp.replace(LOOK_BLOCK_PATTERN, "").replace(CORRECTION_BLOCK_PATTERN, "");
  const values = new Map<string, string>();
  for (const match of root.matchAll(CRS_ATTRIBUTE_PATTERN)) values.set(match[1], match[2] ?? match[3] ?? "");
  for (const match of root.matchAll(CRS_ELEMENT_PATTERN)) {
    if (!values.has(match[1])) values.set(match[1], match[2]);
  }
  return values;
}

/** 0（`+0`・`0.0` を含む）と False は、何もしない値。 */
function isZeroOrFalse(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  if (/^false$/i.test(trimmed)) return true;
  const number = Number(trimmed.replace(/^\+/, ""));
  return Number.isFinite(number) && number === 0;
}

export type UnsupportedPresetSummary = {
  /** Lightroom の日本語の名前（表の順・重複なし） */
  labels: string[];
  /** 表に無い項目の数 */
  otherCount: number;
};

/**
 * `unsupported` を Lightroom の日本語の名前にまとめる。`xmp` を渡すと、プリセットが持っていても何もしない値（0 / False。
 * Lightroom はチェックした項目を値が既定でも全部書き出す）の項目を外す。渡さなければ、名前だけでまとめる。
 */
export function summarizeUnsupportedPresetItems(unsupported: readonly string[], xmp?: string): UnsupportedPresetSummary {
  const values = xmp === undefined ? null : readRootCrsValues(xmp);
  const hasEffect = (key: string, group: UnsupportedGroup | null): boolean => {
    const value = values?.get(key);
    // XMP から値を読めなかった項目は、外さない
    if (value === undefined) return true;
    return !(isZeroOrFalse(value) || group?.noEffect?.(value) === true);
  };
  const reported = new Set<UnsupportedGroup>();
  const others = new Set<string>();
  for (const key of unsupported) {
    if (IGNORED_KEYS.has(key) || IGNORED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    const group = UNSUPPORTED_GROUPS.find((candidate) => matchesGroup(candidate, key)) ?? null;
    if (!group) {
      if (hasEffect(key, null)) others.add(key);
      continue;
    }
    if (reported.has(group)) continue;
    if (group.always || values === null) {
      reported.add(group);
      continue;
    }
    const masters = (group.masters ?? []).filter((master) => values.has(master));
    const active = masters.length > 0 ? masters.some((master) => hasEffect(master, group)) : hasEffect(key, group);
    if (active) reported.add(group);
  }
  const labels: string[] = [];
  for (const group of UNSUPPORTED_GROUPS) {
    if (reported.has(group) && !labels.includes(group.label)) labels.push(group.label);
  }
  return { labels, otherCount: others.size };
}

/**
 * 取り込んだプリセットの「使えない項目」の知らせ（1 行。例「シャープ・ノイズ軽減は使えないので、それ以外を取り込みました」）。
 * 知らせる項目が無ければ null。
 */
export function describeUnsupportedPresetItems(unsupported: readonly string[], xmp?: string): string | null {
  const { labels, otherCount } = summarizeUnsupportedPresetItems(unsupported, xmp);
  const items = [...labels];
  if (otherCount > 0) items.push(photoEditingPresetOtherItemsText(otherCount, labels.length > 0));
  if (items.length === 0) return null;
  return photoEditingPresetImportPartialText(items.join(PHOTO_EDITING_PRESET_ITEM_SEPARATOR));
}

/** NIHO の標準ルックで置き換えるプロファイル（crate の `CameraProfile` の扱いと同じ。色の表の確認を出さない）。 */
const STANDARD_LOOK_NAMES: ReadonlySet<string> = new Set(["adobe color", "adobe standard"]);

const REQUIRES_RGB_TABLES_PATTERN = /\bcrs:RequiresRGBTables\s*(?:=\s*["']\s*true\s*["']|>\s*true\s*<)/i;
/** 表への参照（`crs:RGBTable="<id>"`・`crs:LookTable="<id>"`。空でない値） */
const TABLE_REFERENCE_PATTERN = /\bcrs:(?:RGBTable|LookTable)\s*(?:=\s*(?:"[^"]+"|'[^']+')|>\s*[^<\s])/;
/** 埋め込みの表の中身（`crs:Table_<id>`） */
const TABLE_DATA_PATTERN = /\bcrs:Table_[0-9A-Za-z]+/;
const LOOK_NAME_ATTRIBUTE_PATTERN = /\bcrs:Name\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const LOOK_NAME_ELEMENT_PATTERN = /<crs:Name\s*>(?:\s*<rdf:Alt>\s*<rdf:li[^>]*>)?([^<]*)</;

function hasColorTable(text: string): boolean {
  return REQUIRES_RGB_TABLES_PATTERN.test(text) || TABLE_REFERENCE_PATTERN.test(text) || TABLE_DATA_PATTERN.test(text);
}

function lookName(block: string): string {
  const attribute = LOOK_NAME_ATTRIBUTE_PATTERN.exec(block);
  if (attribute) return (attribute[1] ?? attribute[2] ?? "").trim();
  return (LOOK_NAME_ELEMENT_PATTERN.exec(block)?.[1] ?? "").trim();
}

/**
 * Lightroom 専用の色の表（プロファイルの LUT）を使うプリセットか。NIHO は表を当てないので、取り込んでも同じ見た目にはならない。
 *
 * - 根に RGB の表・Look の表への参照か中身がある（`crs:RGBTable`・`crs:LookTable`・`crs:Table_<id>`）、または
 *   `crs:RequiresRGBTables="True"`
 * - 埋め込みの Look（`crs:Look`）が、Adobe Color / Adobe Standard 以外のプロファイル（名前だけの参照でも、中身は Lightroom の
 *   色の表）か、表の中身を持つ。Adobe Color / Adobe Standard の Look は NIHO の標準ルックで置き換えるので数えない（古い
 *   Lightroom が書く `crs:LookTable` の参照だけなら数えない）
 */
export function presetUsesLightroomColorTable(xmp: string): boolean {
  for (const match of xmp.matchAll(LOOK_BLOCK_PATTERN)) {
    const block = match[0];
    const name = lookName(block).toLowerCase();
    if (STANDARD_LOOK_NAMES.has(name)) {
      if (TABLE_DATA_PATTERN.test(block)) return true;
      continue;
    }
    if (name !== "" || hasColorTable(block)) return true;
  }
  return hasColorTable(xmp.replace(LOOK_BLOCK_PATTERN, ""));
}
