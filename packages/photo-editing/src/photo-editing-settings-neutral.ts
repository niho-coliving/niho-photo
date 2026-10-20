/**
 * Photo Bench の `EditSettings`（クラウドの写真の編集内容）が、何も当てていない状態（neutral）か（移行元設計）。
 *
 * ブラウザ版の写真編集は、Desktop の補正が neutral か無い写真だけをオリジナルから補正できる（補正済みの写真に重ねると
 * Desktop の補正が外れるため。移行時の設計文書「入力と補正」）。エンジンの `EditSettings.neutral` は
 * NIHO Desktop が写真を開いたときにしか返らないので、ここで既知のキーを既定値と比べる。分からないキー・値があれば neutral と
 * みなさない（安全側。補正済みとして閲覧・書き出しだけにする）。
 */

/** 0 が既定の数値の調整項目（露光量・階調・外観・相対の色温度 / 色かぶり補正）。 */
const ZERO_NUMBER_KEYS: ReadonlySet<string> = new Set([
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "texture",
  "clarity",
  "dehaze",
  "vibrance",
  "saturation",
  "relativeTemperature",
  "relativeTint",
]);

/** 0 が既定の数値の調整項目（無いのと 0 は同じ。編集内容が同じかを比べるときに使う）。 */
export const PHOTO_EDITING_ZERO_DEFAULT_KEYS: ReadonlySet<string> = ZERO_NUMBER_KEYS;

/** 既定では何も当てない入れ物（HSL・キャリブレーション・カラーグレーディング）。中の数値がすべて 0 なら neutral。 */
const ZERO_TREE_KEYS: ReadonlySet<string> = new Set(["hsl", "calibration", "colorGrading"]);

/** 値に意味の無い付帯情報（形式の版）。 */
const METADATA_KEYS: ReadonlySet<string> = new Set(["version"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 中の数値がすべて 0（真偽値は false、null・空の入れ物は可）。文字列など分からない値があれば false。 */
function isZeroTree(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (Array.isArray(value)) return value.every(isZeroTree);
  if (isRecord(value)) return Object.values(value).every(isZeroTree);
  return false;
}

function isIdentityPoint(point: unknown): boolean {
  if (Array.isArray(point) && point.length === 2) {
    const [x, y] = point;
    return typeof x === "number" && typeof y === "number" && x === y;
  }
  if (isRecord(point)) {
    return Object.keys(point).length === 2 && "x" in point && "y" in point &&
      typeof point.x === "number" && typeof point.y === "number" && point.x === point.y;
  }
  return false;
}

const TONE_CURVE_CHANNELS: ReadonlySet<string> = new Set(["master", "rgb", "red", "green", "blue"]);

/** 既知の曲線チャンネルで、指定が無いか入力と出力が同じ点だけ（直線）なら neutral。 */
function isIdentityToneCurves(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((curve) => {
    if (!isRecord(curve)) return false;
    if (Object.keys(curve).some((key) => key !== "channel" && key !== "points")) return false;
    if (typeof curve.channel !== "string" || !TONE_CURVE_CHANNELS.has(curve.channel)) return false;
    if (!("points" in curve)) return true;
    return Array.isArray(curve.points) && curve.points.every(isIdentityPoint);
  });
}

/** 撮影時のまま（`{ mode: "asShot" }`）なら neutral。 */
function isAsShotWhiteBalance(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return isRecord(value) && value.mode === "asShot";
}

export function isNeutralPhotoEditingSettings(settings: unknown): boolean {
  if (settings === null || settings === undefined) return true;
  if (!isRecord(settings)) return false;
  return Object.entries(settings).every(([key, value]) => {
    if (METADATA_KEYS.has(key)) return true;
    if (ZERO_NUMBER_KEYS.has(key)) return value === null || value === undefined || value === 0;
    if (ZERO_TREE_KEYS.has(key)) return isZeroTree(value);
    if (key === "whiteBalance") return isAsShotWhiteBalance(value);
    if (key === "toneCurves" || key === "toneCurve") return isIdentityToneCurves(value);
    if (key === "look") return value === null || value === undefined;
    return false;
  });
}
