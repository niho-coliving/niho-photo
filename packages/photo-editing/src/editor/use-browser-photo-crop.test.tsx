// @vitest-environment jsdom

import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import {
  flipGeometryHorizontal,
  readDevelopGeometry,
  rotateGeometryClockwise,
  setGeometryAspect,
  writeDevelopGeometry,
  type DevelopGeometry,
  type DevelopSize,
} from "../develop-engine/develop-geometry";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { DevelopUprightEstimate, DevelopUprightMode } from "../develop-engine/develop-upright";

import type { DevelopSession } from "./browser-photo-editing-model";
import { useBrowserPhotoCrop, type BrowserPhotoCrop } from "./use-browser-photo-crop";

/**
 * 面の切り抜きの道具の状態（F3b 移行元設計）の、［完了］と［キャンセル］（#52）。編集内容と取り消しの 1 単位（`commitEdit`）は小さな
 * テスト用の面が持ち、確定した編集内容を順に記録する（取り消しの履歴は `commitEdit` の 1 回 = 1 単位）。
 *
 * - ［完了］・Enter・ほかの道具へ移る（`leave`）: 「補正」に戻るだけ。幾何は押すたびに確定済みなので何も積まない
 * - ［キャンセル］・Esc（`cancel`）: 入ったときの幾何と違えば、それに戻す 1 単位を積んでから戻る（↶ でキャンセルの前に戻せる）
 */

const SOURCE: DevelopSize = { width: 3000, height: 2000 };
const PHOTO_KEY = "photo-1";

let container: HTMLDivElement;
let root: Root;
let crop: BrowserPhotoCrop;
let settingsRef: MutableRefObject<DevelopSettings>;
let commits: DevelopSettings[];
let ensureDevelopWorkingSize: ReturnType<typeof vi.fn<(settings: DevelopSettings) => Promise<boolean>>>;

/** Upright（niho-photo#46 後半）を推定できる wasm か、と推定の中身（テストごとに差し替える）。 */
let uprightSupported = true;
let estimateUpright: ReturnType<typeof vi.fn<DevelopEngine["estimateUpright"]>>;

const engine = {
  supportsGeometry: async () => true,
  supportsPerspective: async () => true,
  supportsUpright: async () => uprightSupported,
  estimateUpright: (settings: object, mode: DevelopUprightMode) => estimateUpright(settings, mode),
  imageSize: async () => SOURCE,
  geometryOutputSize: async () => null,
} as unknown as DevelopEngine;

/** 作業コピーを開いた写真（座標の基準は開いた大きさ）。 */
const session = { key: PHOTO_KEY, input: { kind: "workingCopy" }, working: null, workSize: SOURCE } as unknown as DevelopSession;

function Harness(props: { initial: DevelopSettings }) {
  const mountedRef = useRef(true);
  const engineRef = useRef<DevelopEngine | null>(engine);
  const developSessionRef = useRef<DevelopSession | null>(session);
  const editResetHandlerRef = useRef<(() => void) | null>(null);
  const [settings, setSettings] = useState(props.initial);
  const ref = useRef(props.initial);
  settingsRef = ref;
  crop = useBrowserPhotoCrop({
    mountedRef,
    engineRef,
    developSessionRef,
    rollout: true,
    wide: true,
    photoKey: PHOTO_KEY,
    settings,
    settingsKey: JSON.stringify(settings),
    settingsRef: ref,
    commitEdit: (next) => {
      commits.push(next);
      ref.current = next;
      setSettings(next);
      return true;
    },
    // 補正のスライダーと同じ口: `drag` は手元の編集内容だけを替え、`commit` で 1 単位を積む
    changeSettings: (update, phase) => {
      const next = update(ref.current) as DevelopSettings;
      if (phase === "commit") commits.push(next);
      ref.current = next;
      setSettings(next);
    },
    setCompareOriginal: () => undefined,
    ensureDevelopWorkingSize,
    editResetHandlerRef,
  });
  return null;
}

async function render(initial: DevelopGeometry | null = null) {
  const base = neutralDevelopSettings();
  await act(async () => {
    root.render(<Harness initial={initial ? writeDevelopGeometry(base, initial) : base} />);
  });
  // wasm に幾何の口があるかを確かめ終える
  await act(async () => undefined);
  expect(crop.available).toBe(true);
}

/** 1 つのイベントの中で操作を呼び、続く非同期の処理（座標を読む・作業サイズを合わせる）まで待つ。 */
async function run(action: () => void) {
  await act(async () => {
    action();
  });
  await act(async () => undefined);
}

async function enter() {
  await run(() => crop.enter());
  expect(crop.active).toBe(true);
  expect(crop.source).toEqual(SOURCE);
}

function currentGeometry(): DevelopGeometry {
  return readDevelopGeometry(settingsRef.current);
}

/** 保存したときの幾何（切り抜きの値は保存で丸まる）。 */
function stored(geometry: DevelopGeometry): DevelopGeometry {
  return readDevelopGeometry(writeDevelopGeometry(neutralDevelopSettings(), geometry));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  commits = [];
  ensureDevelopWorkingSize = vi.fn(async () => true);
  uprightSupported = true;
  estimateUpright = vi.fn<DevelopEngine["estimateUpright"]>(async () => {
    throw new Error("estimateUpright is not set");
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("［完了］（Enter・ほかの道具へ移る）", () => {
  it("「補正」に戻り、幾何はそのまま残す（何も積まない）", async () => {
    await render();
    await enter();
    const rotated = rotateGeometryClockwise(crop.geometry, SOURCE);
    await run(() => crop.commit(rotated));
    expect(commits).toHaveLength(1);

    await run(() => crop.leave());
    expect(crop.active).toBe(false);
    expect(commits).toHaveLength(1);
    expect(currentGeometry()).toEqual(stored(rotated));
    // 切り抜きに合わせて作業サイズを確かめ直す
    expect(ensureDevelopWorkingSize).toHaveBeenCalledWith(settingsRef.current);
  });
});

describe("［キャンセル］（Esc）", () => {
  it("入ったときの幾何に戻す 1 単位を積んでから「補正」に戻る（↶ でキャンセルの前に戻せる）", async () => {
    const entry = setGeometryAspect(
      { rotate: 0, flipH: false, flipV: false, angle: 0, crop: { left: 0, top: 0, right: 1, bottom: 1 } },
      "1:1",
      SOURCE,
    );
    await render(entry);
    await enter();
    expect(crop.geometry).toEqual(stored(entry));

    const rotated = rotateGeometryClockwise(crop.geometry, SOURCE);
    await run(() => crop.commit(rotated));
    const flipped = flipGeometryHorizontal(rotated, SOURCE);
    await run(() => crop.commit(flipped));
    expect(commits).toHaveLength(2);

    await run(() => crop.cancel());
    expect(crop.active).toBe(false);
    // 戻すのは 1 回の確定（取り消しの 1 単位）。その前（キャンセルの前）は反転まで当てた幾何
    expect(commits).toHaveLength(3);
    expect(readDevelopGeometry(commits[1])).toEqual(stored(flipped));
    expect(currentGeometry()).toEqual(stored(entry));
    // 戻した編集内容で作業サイズを確かめ直す
    expect(ensureDevelopWorkingSize).toHaveBeenLastCalledWith(settingsRef.current);
  });

  it("入ったときから変えていなければ何も積まずに戻る（幾何の無い写真は幾何の無いまま）", async () => {
    await render();
    await enter();
    await run(() => crop.cancel());
    expect(crop.active).toBe(false);
    expect(commits).toEqual([]);
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);

    // 変えてから戻すと、幾何の無い編集内容に戻る
    await enter();
    await run(() => crop.commit(rotateGeometryClockwise(crop.geometry, SOURCE)));
    await run(() => crop.cancel());
    expect(commits).toHaveLength(2);
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);
  });

  it("［完了］で出て入り直すと、入り直したときの幾何に戻す", async () => {
    await render();
    await enter();
    const rotated = rotateGeometryClockwise(crop.geometry, SOURCE);
    await run(() => crop.commit(rotated));
    await run(() => crop.leave());

    await enter();
    await run(() => crop.commit(flipGeometryHorizontal(rotated, SOURCE)));
    await run(() => crop.cancel());
    expect(currentGeometry()).toEqual(stored(rotated));
    expect(commits).toHaveLength(3);
  });

  it("切り抜きを開いていない間は何もしない", async () => {
    await render();
    await run(() => crop.cancel());
    expect(commits).toEqual([]);
    expect(crop.active).toBe(false);
    expect(ensureDevelopWorkingSize).not.toHaveBeenCalled();
  });
});

describe("ジオメトリの節（遠近。niho-photo#46）", () => {
  const vertical = (value: number) => (current: DevelopGeometry): DevelopGeometry => ({
    ...current,
    perspective: { vertical: value, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 },
  });

  it("遠近を描ける wasm で切り抜きを開いている間だけ節を出す", async () => {
    await render();
    expect(crop.perspective).toBe(false);
    await enter();
    expect(crop.perspective).toBe(true);
    await run(() => crop.leave());
    expect(crop.perspective).toBe(false);
  });

  it("drag は積まずに編集内容だけを替え、commit で 1 単位を積む（形の版は 7）", async () => {
    await render();
    await enter();
    await run(() => crop.changeGeometry(vertical(-10), "drag"));
    await run(() => crop.changeGeometry(vertical(-20), "drag"));
    expect(commits).toEqual([]);
    expect(currentGeometry().perspective?.vertical).toBe(-20);
    await run(() => crop.changeGeometry(vertical(-20), "commit"));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.v).toBe(7);
    expect(readDevelopGeometry(commits[0]).perspective?.vertical).toBe(-20);
  });

  it("［キャンセル］は入ったときの遠近（無し）に戻す", async () => {
    await render();
    await enter();
    await run(() => crop.changeGeometry(vertical(-35), "commit"));
    await run(() => crop.changeGeometry((current) => ({ ...current, constrain: true }), "commit"));
    await run(() => crop.cancel());
    expect(crop.active).toBe(false);
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);
    expect(settingsRef.current.v).toBe(1);
  });

  it("切り抜きを開いていない間は何もしない", async () => {
    await render();
    await run(() => crop.changeGeometry(vertical(-35), "commit"));
    expect(commits).toEqual([]);
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);
  });
});

describe("Upright（niho-photo#46 後半）", () => {
  const PERSPECTIVE = { vertical: -31.5, horizontal: 0, rotate: 1.2, aspect: 0, scale: 100, x: 0, y: 0 };
  const FOUND: DevelopUprightEstimate = {
    perspective: PERSPECTIVE,
    mode: 3,
    confidence: 0.9,
    lines: { vertical: 14, horizontal: 3 },
    reason: null,
  };
  const NOT_FOUND: DevelopUprightEstimate = {
    perspective: { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, x: 0, y: 0 },
    mode: 1,
    confidence: 0,
    lines: { vertical: 0, horizontal: 0 },
    reason: "noLines",
  };

  /** 推定を待たせる（`resolve` / `reject` で返す）。 */
  function deferEstimate() {
    let resolve!: (estimate: DevelopUprightEstimate) => void;
    let reject!: (error: unknown) => void;
    estimateUpright.mockImplementation(
      () =>
        new Promise<DevelopUprightEstimate>((onResolve, onReject) => {
          resolve = onResolve;
          reject = onReject;
        }),
    );
    return {
      resolve: (estimate: DevelopUprightEstimate) => act(async () => resolve(estimate)),
      reject: (error: unknown) => act(async () => reject(error)),
    };
  }

  const tilted: DevelopGeometry = {
    rotate: 0,
    flipH: false,
    flipV: false,
    angle: 1.5,
    crop: { left: 0.1, top: 0, right: 0.9, bottom: 1 },
    perspective: { vertical: 0, horizontal: 0, rotate: 0, aspect: 20, scale: 110, x: 0, y: 0 },
  };

  it("Upright を推定できる wasm で切り抜きを開いている間だけボタンを出す", async () => {
    await render();
    expect(crop.upright).toBeNull();
    await enter();
    expect(crop.upright).toMatchObject({ pressed: 0, busy: false, status: null });
    await run(() => crop.leave());
    expect(crop.upright).toBeNull();
  });

  it("推定できない wasm（古い公開物）ではボタンを出さない", async () => {
    uprightSupported = false;
    await render();
    await enter();
    expect(crop.perspective).toBe(true);
    expect(crop.upright).toBeNull();
  });

  it("押すと今の設定で推定し（その間は押せない）、遠近・upright・余白を埋めるを 1 回の確定で書く（↶ で 1 回戻る）", async () => {
    await render(tilted);
    await enter();
    const estimate = deferEstimate();
    await run(() => crop.upright?.run(3));
    expect(estimateUpright).toHaveBeenCalledWith(settingsRef.current, 3);
    expect(crop.upright?.busy).toBe(true);
    // 推定の間にもう一度押しても、もう 1 回は推定しない
    await run(() => crop.upright?.run(1));
    expect(estimateUpright).toHaveBeenCalledTimes(1);

    await estimate.resolve(FOUND);
    expect(crop.upright?.busy).toBe(false);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.v).toBe(7);
    // 縦横比・拡大は既定に戻し、角度・切り抜きは残す
    expect(currentGeometry()).toEqual(stored({ ...tilted, perspective: PERSPECTIVE, upright: 3, constrain: true }));
    expect(crop.upright).toMatchObject({ pressed: 3, status: { kind: "applied", mode: 3 } });
  });

  it("押しているボタンをもう一度押すと切る（遠近を恒等に戻す 1 単位。余白を埋めるは残す）", async () => {
    await render({ ...tilted, perspective: PERSPECTIVE, upright: 2, constrain: true });
    await enter();
    expect(crop.upright?.pressed).toBe(2);
    await run(() => crop.upright?.run(2));
    expect(estimateUpright).not.toHaveBeenCalled();
    expect(commits).toHaveLength(1);
    const { perspective: _perspective, ...rest } = tilted;
    expect(currentGeometry()).toEqual(stored({ ...rest, constrain: true }));
    expect(crop.upright?.pressed).toBe(0);
  });

  it("線が見つからなければ書かずに知らせ、次に編集内容が変わると知らせを消す", async () => {
    await render();
    await enter();
    estimateUpright.mockResolvedValue(NOT_FOUND);
    await run(() => crop.upright?.run(1));
    expect(commits).toEqual([]);
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);
    expect(crop.upright?.status).toEqual({ kind: "notFound" });
    await run(() => crop.changeGeometry((current) => ({ ...current, constrain: true }), "commit"));
    expect(crop.upright?.status).toBeNull();
  });

  it("推定に失敗したら書かずに知らせる", async () => {
    await render();
    await enter();
    const estimate = deferEstimate();
    await run(() => crop.upright?.run(4));
    await estimate.reject(new Error("develop engine cannot estimate upright"));
    expect(commits).toEqual([]);
    expect(crop.upright).toMatchObject({ busy: false, status: { kind: "failed" } });
  });

  it("推定の間に切り抜きを出た・90° 回した枠には、遅れて返った結果を当てない", async () => {
    await render();
    await enter();
    let estimate = deferEstimate();
    await run(() => crop.upright?.run(3));
    await run(() => crop.leave());
    await estimate.resolve(FOUND);
    expect(commits).toEqual([]);

    await enter();
    estimate = deferEstimate();
    await run(() => crop.upright?.run(3));
    const rotated = rotateGeometryClockwise(crop.geometry, SOURCE);
    await run(() => crop.commit(rotated));
    await estimate.resolve(FOUND);
    expect(commits).toHaveLength(1);
    expect(currentGeometry()).toEqual(stored(rotated));
    expect(crop.upright?.busy).toBe(false);
  });

  it("［キャンセル］は Upright も入ったときに戻す", async () => {
    await render();
    await enter();
    estimateUpright.mockResolvedValue(FOUND);
    await run(() => crop.upright?.run(3));
    expect(commits).toHaveLength(1);
    await run(() => crop.cancel());
    expect(Object.hasOwn(settingsRef.current, "geometry")).toBe(false);
    expect(settingsRef.current.v).toBe(1);
  });
});
