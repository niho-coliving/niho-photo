import {
  cropBoxFromGeometry,
  cropFromBox,
  developAspectRatio,
  fitCropBox,
  maxCropBox,
  readDevelopGeometry,
  swapDevelopAspect,
  writeDevelopGeometry,
  type CropBox,
  type DevelopGeometry,
  type DevelopSize,
} from "./develop-engine/develop-geometry";
import type { DevelopSettings } from "./develop-engine/develop-settings";
import {
  PHOTO_EDITING_CROP_ASPECT_FREE_LABEL,
  PHOTO_EDITING_CROP_ASPECT_ORIGINAL_LABEL,
} from "./photo-editing-copy";

/**
 * 切り抜きの道具の画面（NIHO Photo 段 1 F3b 移行元設計）の計算（React に依存しない純粋な関数。枠の部品・道具の部品と、ブラウザの面・
 * スマホの編集面〔F6c 移行元設計〕が使う）。幾何そのものの計算（切り抜きの箱・回転・反転）は `develop-engine/develop-geometry.ts`。
 *
 * 見せ方: 切り抜きの枠は画面でまっすぐ立ち、写真（枠全体）の方が回る。角度 a のとき、写真を −a 度回して置き、回した写真の外接の
 * 長方形が表示の領域（まわりの余白の内側）に収まる倍率にする（倍率は切り抜きの箱によらないので、枠を動かしても写真は動かない）。
 */

/** 道具に並べる縦横比（`geometry.aspect` の値と表示名。入れ替えた比率〔`5:4`・`originalSwapped`〕は元のチップを選ばれた表示にする）。 */
export const PHOTO_EDITING_CROP_ASPECTS: ReadonlyArray<{ aspect: string; label: string }> = [
  { aspect: "original", label: PHOTO_EDITING_CROP_ASPECT_ORIGINAL_LABEL },
  { aspect: "free", label: PHOTO_EDITING_CROP_ASPECT_FREE_LABEL },
  { aspect: "1:1", label: "1:1" },
  { aspect: "4:5", label: "4:5" },
  { aspect: "3:4", label: "3:4" },
  { aspect: "2:3", label: "2:3" },
  { aspect: "9:16", label: "9:16" },
];

/** 角度補正のスライダーの範囲と刻み（度）。 */
export const PHOTO_EDITING_CROP_ANGLE_MIN = -45;
export const PHOTO_EDITING_CROP_ANGLE_MAX = 45;
export const PHOTO_EDITING_CROP_ANGLE_STEP = 0.1;
/** 写真のまわりに空ける余白（px）。 */
export const PHOTO_EDITING_CROP_VIEW_MARGIN = 24;
/** 書き出し（記事用の画像・JPEG）の長辺と、JPEG / PNG のオリジナルを書き出すときに読む長辺の上限。 */
export const PHOTO_EDITING_CROP_EXPORT_LONG_EDGE = 2048;
export const PHOTO_EDITING_CROP_EXPORT_DECODE_CAP = 4096;

/** 今の縦横比（無いのは `original`）。 */
export function cropAspectOf(geometry: Pick<DevelopGeometry, "aspect">): string {
  return geometry.aspect ?? "original";
}

/** そのチップを選ばれた表示にするか（同じ比率か、その縦横を入れ替えた比率）。 */
export function isCropAspectSelected(current: string, chip: string): boolean {
  return current === chip || swapDevelopAspect(current) === chip;
}

/** 縦横を入れ替えられる比率か（`free`・`1:1`・読めない値は入れ替えても同じ）。 */
export function canSwapCropAspect(current: string): boolean {
  return swapDevelopAspect(current) !== current;
}

/** 角度の表示（「+1.5°」「0°」「-0.3°」）。 */
export function formatCropAngle(angle: number): string {
  const rounded = Number((Number.isFinite(angle) ? angle : 0).toFixed(1));
  if (rounded === 0) return "0°";
  return `${rounded > 0 ? "+" : "-"}${Math.abs(rounded)}°`;
}

/** 寸法として読める値だけを返す（wasm の返り値。幅と高さが正の有限の数でなければ null）。 */
export function readDevelopSize(value: unknown): DevelopSize | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 切り抜きの道具の間に canvas に描く編集内容: 切り抜きと角度を外した枠全体（`rotate` と反転だけを当てた・今の色の補正のまま）。
 * 枠と角度は画面が CSS で重ねるので、切り抜きを動かすたびに wasm で描き直さない。
 */
export function cropFrameDevelopSettings(settings: DevelopSettings): DevelopSettings {
  const geometry = readDevelopGeometry(settings);
  return writeDevelopGeometry(settings, {
    rotate: geometry.rotate,
    flipH: geometry.flipH,
    flipV: geometry.flipV,
    angle: 0,
    crop: { left: 0, top: 0, right: 1, bottom: 1 },
  });
}

/**
 * 画面に見せる切り抜きの箱（描かれるのと同じ箱: 角が枠から出る保存値は中心の回りに縮めて収める。長方形にならない値は、その角度・
 * 縦横比で内接する最大の箱）。`frame` は `developFrameSize(source, geometry.rotate)`。
 */
export function editingCropBox(geometry: DevelopGeometry, frame: DevelopSize): CropBox {
  const raw = cropBoxFromGeometry(geometry, frame);
  if (!raw) return maxCropBox(frame, geometry.angle, developAspectRatio(geometry.aspect, frame));
  return fitCropBox(raw, geometry.angle, frame);
}

/** 切り抜きの箱を幾何に書く（角度・回転・反転・縦横比はそのまま）。 */
export function geometryWithCropBox(geometry: DevelopGeometry, box: CropBox, frame: DevelopSize): DevelopGeometry {
  return { ...geometry, crop: cropFromBox(box, geometry.angle, frame) };
}

/** 切り抜いた結果の画素（作業画像の大きさからの概算。読み上げに使う）。 */
export function cropOutputSize(box: CropBox): DevelopSize {
  return { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
}

/** 寸法を長辺 `cap` に収める（収まっていればそのまま）。JPEG / PNG のオリジナルを書き出すときに読む大きさ。 */
export function fitDevelopSize(size: DevelopSize, cap: number): DevelopSize {
  const long = Math.max(size.width, size.height);
  if (!(cap > 0) || long <= cap) return { width: size.width, height: size.height };
  const scale = cap / long;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * 「書き出しは長辺 <数>px まで」に出す数。切り抜いた結果の書き出し（`output` は wasm の `geometryOutputSize`）が、切り抜かない
 * ときの長辺（書き出しの入力の長辺と 2048px の小さい方）に届かないときだけ返す。
 */
export function cropExportLimitLongEdge(output: DevelopSize, exportInput: DevelopSize): number | null {
  const long = Math.max(output.width, output.height);
  const whole = Math.min(PHOTO_EDITING_CROP_EXPORT_LONG_EDGE, Math.max(exportInput.width, exportInput.height));
  return long < whole ? long : null;
}

/** キーボードで枠・つまみを動かす 1 回の量（枠〔写真〕の短辺の 1%。⇧ を押しながらは 5%）。枠の画素。 */
export function cropKeyboardStep(frame: DevelopSize, large: boolean): number {
  return Math.min(frame.width, frame.height) * (large ? 0.05 : 0.01);
}

/** 矢印キーの向き（画面の軸。ほかのキーは null）。 */
export function cropArrowDirection(key: string): [number, number] | null {
  switch (key) {
    case "ArrowLeft":
      return [-1, 0];
    case "ArrowRight":
      return [1, 0];
    case "ArrowUp":
      return [0, -1];
    case "ArrowDown":
      return [0, 1];
    default:
      return null;
  }
}

/**
 * 画面の軸の動き（切り抜きの自分の軸と同じ。枠がまっすぐ立って見える向き）を、枠の軸に直す（`moveCropBox` に渡す）。写真は画面で
 * −a 度回っているので、a 度回し戻す。
 */
export function cropScreenToFrameDelta(dx: number, dy: number, angle: number): [number, number] {
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [dx * cos - dy * sin, dx * sin + dy * cos];
}

export type CropViewRect = { left: number; top: number; width: number; height: number };

/** 枠の部品の置き方（表示の領域の左上を原点にした CSS の px）。 */
export type CropOverlayLayout = {
  /** 枠の 1 画素が画面で何 px か */
  scale: number;
  /** 写真（枠全体）を置く長方形（回す前。中心の回りに `rotate` 度回す） */
  photo: CropViewRect;
  /** 写真を回す角度（CSS の `rotate`。度。時計回りが正） */
  rotate: number;
  /** 切り抜きの枠（画面でまっすぐ立つ） */
  box: CropViewRect;
};

/**
 * 枠の部品の置き方を決める。回した写真の外接の長方形を、表示の領域の余白の内側に収めて中央に置く（写真を引き伸ばさないよう、
 * `maxLongEdge` があれば写真の長辺をそこで止める）。表示の領域が余白より小さい・寸法が読めないなら null。
 */
export function cropOverlayLayout(params: {
  frame: DevelopSize;
  box: CropBox;
  angle: number;
  viewport: DevelopSize;
  margin?: number;
  maxLongEdge?: number;
}): CropOverlayLayout | null {
  const { frame, box, angle, viewport } = params;
  const margin = params.margin ?? PHOTO_EDITING_CROP_VIEW_MARGIN;
  const availableWidth = viewport.width - margin * 2;
  const availableHeight = viewport.height - margin * 2;
  if (!(frame.width > 0 && frame.height > 0 && availableWidth > 0 && availableHeight > 0)) return null;
  const theta = (angle * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const boundsWidth = frame.width * Math.abs(cos) + frame.height * Math.abs(sin);
  const boundsHeight = frame.width * Math.abs(sin) + frame.height * Math.abs(cos);
  let scale = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);
  if (params.maxLongEdge !== undefined && params.maxLongEdge > 0) {
    scale = Math.min(scale, params.maxLongEdge / Math.max(frame.width, frame.height));
  }
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  // 枠の点を画面へ: 枠の中心の回りに −a 度回す
  const offsetX = (box.cx - frame.width / 2) * scale;
  const offsetY = (box.cy - frame.height / 2) * scale;
  const boxCenterX = centerX + offsetX * cos + offsetY * sin;
  const boxCenterY = centerY - offsetX * sin + offsetY * cos;
  const boxWidth = box.width * scale;
  const boxHeight = box.height * scale;
  return {
    scale,
    photo: {
      left: centerX - (frame.width * scale) / 2,
      top: centerY - (frame.height * scale) / 2,
      width: frame.width * scale,
      height: frame.height * scale,
    },
    rotate: -angle + 0,
    box: { left: boxCenterX - boxWidth / 2, top: boxCenterY - boxHeight / 2, width: boxWidth, height: boxHeight },
  };
}
