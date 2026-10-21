import type { CropBox, DevelopPerspective, DevelopSize } from "./develop-geometry";

/**
 * 遠近（`developSettings.geometry.perspective`。Lightroom の変形の 7 本。niho-photo#46）の計算（React に依存しない純粋な関数）。
 * crate の `perspective.rs` と同じモデル・同じ式（`docs/geometry-perspective.md`）で、画面が切り抜きの枠を補正後の枠の上に描き、
 * 「余白を埋める」で描かれる切り抜きの箱を出すのに使う（画は wasm が描く。ここは座標だけ）。
 *
 * - 枠（回転・反転の後）を、同じ大きさの「補正後の枠」に射影で写す。切り抜き（と角度）は補正後の枠の上の座標
 * - 枠の中心を原点・長辺 L で割った座標（y は下向き）で、写し方は 回転 → 台形（傾き）→ 縦横比 → 拡大 → 平行移動 の順
 * - Lightroom の数値の写し方は公開されておらず、実測による校正もしていない近似
 */

/** 仮想カメラの焦点距離（枠の長辺に対する比。36mm の長辺に 50mm）。crate の `FOCAL_LENGTH`。 */
export const DEVELOP_PERSPECTIVE_FOCAL_LENGTH = 50 / 36;
/** 垂直・水平の ±100 で写真の面を傾ける角度（度）。crate の `MAX_TILT_DEGREES`。 */
export const DEVELOP_PERSPECTIVE_MAX_TILT_DEGREES = 40;
/** 縦横比の ±100 で横（縦）に伸ばし縦（横）に縮める倍率。crate の `ASPECT_STRETCH`。 */
export const DEVELOP_PERSPECTIVE_ASPECT_STRETCH = 1.25;

export type DevelopPerspectiveKey = keyof DevelopPerspective;

/** 7 本の項目（並びは Lightroom の変形の並び）と範囲・恒等の値（crate の `PerspectiveField`）。 */
export const DEVELOP_PERSPECTIVE_FIELDS: ReadonlyArray<{
  key: DevelopPerspectiveKey;
  min: number;
  max: number;
  neutral: number;
}> = [
  { key: "vertical", min: -100, max: 100, neutral: 0 },
  { key: "horizontal", min: -100, max: 100, neutral: 0 },
  { key: "rotate", min: -10, max: 10, neutral: 0 },
  { key: "aspect", min: -100, max: 100, neutral: 0 },
  { key: "scale", min: 50, max: 150, neutral: 100 },
  { key: "x", min: -100, max: 100, neutral: 0 },
  { key: "y", min: -100, max: 100, neutral: 0 },
];

/** 恒等の遠近。 */
export const IDENTITY_DEVELOP_PERSPECTIVE: Readonly<DevelopPerspective> = Object.freeze({
  vertical: 0,
  horizontal: 0,
  rotate: 0,
  aspect: 0,
  scale: 100,
  x: 0,
  y: 0,
});

/** 恒等か（無いのも恒等）。 */
export function isIdentityDevelopPerspective(perspective: DevelopPerspective | null | undefined): boolean {
  if (!perspective) return true;
  return DEVELOP_PERSPECTIVE_FIELDS.every(({ key, neutral }) => perspective[key] === neutral);
}

type Vec = [number, number];
type Mat3 = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

function mul(a: Mat3, b: Mat3): Mat3 {
  const row = (i: number): [number, number, number] => [
    a[i][0] * b[0][0] + a[i][1] * b[1][0] + a[i][2] * b[2][0],
    a[i][0] * b[0][1] + a[i][1] * b[1][1] + a[i][2] * b[2][1],
    a[i][0] * b[0][2] + a[i][1] * b[1][2] + a[i][2] * b[2][2],
  ];
  return [row(0), row(1), row(2)];
}

function apply(m: Mat3, p: Vec): [number, number, number] {
  return [
    m[0][0] * p[0] + m[0][1] * p[1] + m[0][2],
    m[1][0] * p[0] + m[1][1] * p[1] + m[1][2],
    m[2][0] * p[0] + m[2][1] * p[1] + m[2][2],
  ];
}

/** これ以下の同次座標は消失線の上か向こう（写真のどの点もそこへは写らない）。 */
const W_EPSILON = 1e-6;

/** 1 つの遠近を 1 つの枠の大きさに当てた写し方（枠の画素）。 */
export type DevelopPerspectiveWarp = {
  /** 枠 → 補正後の枠 */
  forward: Mat3;
  /** 補正後の枠 → 枠 */
  inverse: Mat3;
  frame: DevelopSize;
};

/** 遠近 `perspective` を `frame` の大きさの枠に当てた写し方（恒等・無いなら null）。crate の `Warp::new`。 */
export function developPerspectiveWarp(
  perspective: DevelopPerspective | null | undefined,
  frame: DevelopSize,
): DevelopPerspectiveWarp | null {
  if (!perspective || isIdentityDevelopPerspective(perspective)) return null;
  const { width: w, height: h } = frame;
  if (!(w > 0 && h > 0)) return null;
  const l = Math.max(w, h);
  const normalize: Mat3 = [
    [1 / l, 0, -w / (2 * l)],
    [0, 1 / l, -h / (2 * l)],
    [0, 0, 1],
  ];
  const denormalize: Mat3 = [
    [l, 0, w / 2],
    [0, l, h / 2],
    [0, 0, 1],
  ];
  const theta = (perspective.rotate * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const turn: Mat3 = [
    [cos, sin, 0],
    [-sin, cos, 0],
    [0, 0, 1],
  ];
  const unturn: Mat3 = [
    [cos, -sin, 0],
    [sin, cos, 0],
    [0, 0, 1],
  ];
  const strength = Math.tan((DEVELOP_PERSPECTIVE_MAX_TILT_DEGREES * Math.PI) / 180) / DEVELOP_PERSPECTIVE_FOCAL_LENGTH;
  const ph = (-perspective.horizontal / 100) * strength;
  const pv = (-perspective.vertical / 100) * strength;
  const keystone: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [ph, pv, 1],
  ];
  const unkeystone: Mat3 = [
    [1, 0, 0],
    [0, 1, 0],
    [-ph, -pv, 1],
  ];
  const stretch = DEVELOP_PERSPECTIVE_ASPECT_STRETCH ** (perspective.aspect / 100);
  const s = perspective.scale / 100;
  const sx = stretch * s;
  const sy = s / stretch;
  const tx = (perspective.x / 100) * 0.5 * (w / l);
  const ty = (perspective.y / 100) * 0.5 * (h / l);
  const place: Mat3 = [
    [sx, 0, tx],
    [0, sy, ty],
    [0, 0, 1],
  ];
  const unplace: Mat3 = [
    [1 / sx, 0, -tx / sx],
    [0, 1 / sy, -ty / sy],
    [0, 0, 1],
  ];
  return {
    forward: mul(denormalize, mul(place, mul(keystone, mul(turn, normalize)))),
    inverse: mul(denormalize, mul(unturn, mul(unkeystone, mul(unplace, normalize)))),
    frame: { width: w, height: h },
  };
}

/** 補正後の枠の点 `q` が、枠のどこから来るか（消失線の上・向こうは null）。 */
export function perspectiveToFrame(warp: DevelopPerspectiveWarp, q: Vec): Vec | null {
  const [x, y, w] = apply(warp.inverse, q);
  return w > W_EPSILON ? [x / w, y / w] : null;
}

/** 枠の点 `p` が、補正後の枠のどこへ写るか（消失線の向こうは null）。 */
export function perspectiveToCanvas(warp: DevelopPerspectiveWarp, p: Vec): Vec | null {
  const [x, y, w] = apply(warp.forward, p);
  return w > W_EPSILON ? [x / w, y / w] : null;
}

type HalfPlane = { n: Vec; k: number };

function dot(a: Vec, b: Vec): number {
  return a[0] * b[0] + a[1] * b[1];
}

/** 凸多角形 `poly` の `n·x <= k` の側（Sutherland–Hodgman。無ければ空）。 */
function clip(poly: readonly Vec[], n: Vec, k: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = dot(n, a) - k;
    const db = dot(n, b) - k;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

function area2(poly: readonly Vec[]): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** 補正後の枠の上で、切り抜きが収まるべき半平面（枠の 4 辺と、補正した写真の 4 辺）と、その共通部分。 */
function validRegion(warp: DevelopPerspectiveWarp): { planes: HalfPlane[]; region: Vec[] } | null {
  const { width: w, height: h } = warp.frame;
  const corners: Vec[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const outline: Vec[] = [];
  for (const corner of corners) {
    const q = perspectiveToCanvas(warp, corner);
    if (!q) return null;
    outline.push(q);
  }
  const orientation = area2(outline);
  if (!(Math.abs(orientation) > 0)) return null;
  const planes: HalfPlane[] = [
    { n: [-1, 0], k: 0 },
    { n: [1, 0], k: w },
    { n: [0, -1], k: 0 },
    { n: [0, 1], k: h },
  ];
  for (let i = 0; i < 4; i += 1) {
    const a = outline[i];
    const b = outline[(i + 1) % 4];
    const e: Vec = [b[0] - a[0], b[1] - a[1]];
    const n: Vec = orientation > 0 ? [e[1], -e[0]] : [-e[1], e[0]];
    planes.push({ n, k: dot(n, a) });
  }
  let region: Vec[] = corners;
  for (const plane of planes.slice(4)) {
    region = clip(region, plane.n, plane.k);
    if (region.length === 0) return null;
  }
  return Math.abs(area2(region)) > 2e-9 * w * h ? { planes, region } : null;
}

/** 補正した写真が補正後の枠の上で占める凸多角形（枠との共通部分。面積が無ければ null）。 */
export function perspectiveValidPolygon(warp: DevelopPerspectiveWarp): Vec[] | null {
  return validRegion(warp)?.region ?? null;
}

function nearestOnBoundary(poly: readonly Vec[], p: Vec): Vec {
  let best = poly[0];
  let bestDistance = Infinity;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const e: Vec = [b[0] - a[0], b[1] - a[1]];
    const length2 = dot(e, e);
    const t = length2 > 0 ? Math.min(1, Math.max(0, dot([p[0] - a[0], p[1] - a[1]], e) / length2)) : 0;
    const c: Vec = [a[0] + t * e[0], a[1] + t * e[1]];
    const distance = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

/**
 * 「余白を埋める」: 切り抜きの箱（補正後の枠の上。角度 `angle` で回った箱）を、補正した写真の中に収める（crate の
 * `constrain_corners`）。角度と縦横比は保ち、収まる最大の倍率（1 以下）にしてから、中心を元の中心にいちばん近い所へ置く。すでに
 * 収まっていればそのまま。収める先が無い・ほとんど残らないときもそのまま返す。
 */
export function constrainCropBoxToPerspective(box: CropBox, angle: number, warp: DevelopPerspectiveWarp): CropBox {
  const valid = validRegion(warp);
  if (!valid) return box;
  const { planes, region } = valid;
  const { width: w, height: h } = warp.frame;
  const theta = (angle * Math.PI) / 180;
  const u: Vec = [Math.cos(theta), Math.sin(theta)];
  const v: Vec = [-u[1], u[0]];
  const across: Vec = [box.width * u[0], box.width * u[1]];
  const down: Vec = [box.height * v[0], box.height * v[1]];
  const center: Vec = [box.cx, box.cy];
  const reach = planes.map((plane) => (Math.abs(dot(plane.n, across)) + Math.abs(dot(plane.n, down))) / 2);
  const fits = (point: Vec, s: number) => planes.every((plane, i) => dot(plane.n, point) <= plane.k - s * reach[i]);
  if (fits(center, 1)) return box;
  const centers = (s: number): Vec[] => {
    let poly: Vec[] = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ];
    for (let i = 0; i < planes.length && poly.length > 0; i += 1) {
      poly = clip(poly, planes[i].n, planes[i].k - s * reach[i]);
    }
    return poly;
  };
  let scale = 1;
  let at = centers(1);
  if (at.length === 0) {
    let lo = 0;
    let hi = 1;
    at = region;
    for (let i = 0; i < 60; i += 1) {
      const mid = 0.5 * (lo + hi);
      const poly = centers(mid);
      if (poly.length === 0) hi = mid;
      else {
        lo = mid;
        at = poly;
      }
    }
    scale = lo;
  }
  if (!(scale > 1e-6)) return box;
  const moved = fits(center, scale) ? center : nearestOnBoundary(at, center);
  return { cx: moved[0], cy: moved[1], width: box.width * scale, height: box.height * scale };
}

/**
 * 表示される結果を 90° 回す・鏡映したときの遠近（結果の見た目が回る・鏡映するように、変形もいっしょに写す。crate の写し方
 * `F' = M F M⁻¹`）。`turn` は時計回り・反時計回りの 90°、`flip` は左右・上下の鏡映。
 */
export function transformDevelopPerspective(
  perspective: DevelopPerspective,
  move: "clockwise" | "counterClockwise" | "flipHorizontal" | "flipVertical",
): DevelopPerspective {
  const p = perspective;
  const n = (value: number) => -value + 0;
  switch (move) {
    case "clockwise":
      return { ...p, horizontal: n(p.vertical), vertical: p.horizontal, aspect: n(p.aspect), x: n(p.y), y: p.x };
    case "counterClockwise":
      return { ...p, horizontal: p.vertical, vertical: n(p.horizontal), aspect: n(p.aspect), x: p.y, y: n(p.x) };
    case "flipHorizontal":
      return { ...p, horizontal: n(p.horizontal), rotate: n(p.rotate), x: n(p.x) };
    case "flipVertical":
      return { ...p, vertical: n(p.vertical), rotate: n(p.rotate), y: n(p.y) };
  }
}
