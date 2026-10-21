// @vitest-environment jsdom

import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import { MAX_HEAL_MARKS } from "../develop-engine/develop-heal";
import {
  DEFAULT_HEAL_FEATHER,
  DEFAULT_HEAL_RADIUS,
  addDevelopHealMark,
  readDevelopHeal,
} from "../develop-engine/develop-heal-editing";
import { neutralDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import { clampHealSource, defaultHealSource, healFrameDevelopSettings, healMarkFingerprint, stepHealRadius } from "../photo-editing-heal";

import type { PhotoEditingSliderPhase } from "./photo-editing-slider";
import {
  resolveBrowserPhotoHealKey,
  useBrowserPhotoHeal,
  useBrowserPhotoHealKeys,
  type BrowserPhotoHeal,
  type BrowserPhotoHealKey,
} from "./use-browser-photo-heal";

/**
 * 修復の道具の状態（niho-photo#44 後半）: 帯に出す条件（wasm の能力・PC の面・写真・段階 open の仮の入力）、入る / 出る、幾何なしの
 * 画を描き終えるまでブラシを受けない、なぞった点で印を 1 回の確定で足す、選んだ印の値を直接動かす（`drag` → `commit`）、選んでいない
 * ときは次に描く印の値、削除・すべて消す、`[` `]` `O` のキー。編集内容と取り消しの 1 単位（`commitEdit`）はテスト用の面が持つ。
 */

const PHOTO_KEY = "photo-1";
const SIZE = { width: 1000, height: 1000 };

let container: HTMLDivElement;
let root: Root;
let heal: BrowserPhotoHeal;
let settingsRef: MutableRefObject<DevelopSettings>;
let commits: DevelopSettings[];
let changes: Array<{ phase: PhotoEditingSliderPhase; settings: DevelopSettings }>;
let setCompareOriginal: ReturnType<typeof vi.fn<(compare: boolean) => void>>;
let editResetHandlerRef: MutableRefObject<(() => void) | null>;
let supportsHeal: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
/** 取り消し・やり直しの代わりに、面の編集内容を替える */
let replaceSettings: (next: DevelopSettings) => void = () => undefined;

type HarnessProps = {
  initial?: DevelopSettings;
  allowed?: boolean;
  photoKey?: string | null;
  provisional?: boolean;
  engine?: DevelopEngine | null;
};

function Harness(props: HarnessProps) {
  const mountedRef = useRef(true);
  const engineRef = useRef<DevelopEngine | null>(
    props.engine === undefined ? ({ supportsHeal: () => supportsHeal() } as unknown as DevelopEngine) : props.engine,
  );
  const resetRef = useRef<(() => void) | null>(null);
  editResetHandlerRef = resetRef;
  const [settings, setSettings] = useState(props.initial ?? neutralDevelopSettings());
  const ref = useRef(settings);
  settingsRef = ref;
  replaceSettings = (next) => {
    ref.current = next;
    setSettings(next);
  };
  heal = useBrowserPhotoHeal({
    mountedRef,
    engineRef,
    allowed: props.allowed ?? true,
    photoKey: props.photoKey === undefined ? PHOTO_KEY : props.photoKey,
    provisional: props.provisional ?? false,
    settings,
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
      changes.push({ phase, settings: next });
      if (phase === "commit") commits.push(next);
      ref.current = next;
      setSettings(next);
    },
    setCompareOriginal,
    editResetHandlerRef: resetRef,
  });
  return null;
}

async function render(props: HarnessProps = {}) {
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  // wasm が印を描けるかを確かめ終える
  await act(async () => undefined);
}

async function run(action: () => void) {
  await act(async () => {
    action();
  });
}

/** 道具に入り、面が幾何なしの画を描いた（印の入った画）ことにする。 */
async function enterAndPaint() {
  await run(() => heal.enter());
  expect(heal.active).toBe(true);
  await run(() => heal.framePainted(PHOTO_KEY, SIZE, healFrameDevelopSettings(settingsRef.current)));
  expect(heal.ready).toBe(true);
}

function withMark(settings: DevelopSettings, id: string, extra: Partial<Parameters<typeof addDevelopHealMark>[1]> = {}) {
  return addDevelopHealMark(settings, { id, mode: "remove", radius: 0.02, feather: 0.5, points: [[0.3, 0.4]], ...extra });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  commits = [];
  changes = [];
  setCompareOriginal = vi.fn();
  supportsHeal = vi.fn(async () => true);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("帯に出す条件", () => {
  it("PC の面で wasm の写真を 1 枚で見ていて、wasm が印を描けるときだけ出す", async () => {
    await render();
    expect(supportsHeal).toHaveBeenCalledTimes(1);
    expect(heal.available).toBe(true);
    expect(heal.active).toBe(false);
  });

  it("古い wasm（印を描けない・確かめる口が無い・確かめに失敗）には出さない", async () => {
    supportsHeal.mockResolvedValue(false);
    await render();
    expect(heal.available).toBe(false);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ engine: {} as DevelopEngine });
    expect(heal.available).toBe(false);

    await act(async () => root.unmount());
    root = createRoot(container);
    supportsHeal.mockRejectedValue(new Error("worker"));
    await render();
    expect(heal.available).toBe(false);
  });

  it("スマホの層・閲覧のみ（allowed: false）・写真を開いていない・段階 open の仮の入力では出さない（確かめもしない）", async () => {
    await render({ allowed: false });
    expect(heal.available).toBe(false);
    expect(supportsHeal).not.toHaveBeenCalled();
    await render({ allowed: true, photoKey: null });
    expect(heal.available).toBe(false);
    expect(supportsHeal).not.toHaveBeenCalled();
    await render({ provisional: true });
    expect(heal.available).toBe(false);
    // 正式な入力に替われば出す
    await render({ provisional: false });
    expect(heal.available).toBe(true);
  });
});

describe("入る・出る", () => {
  it("入ると「補正前」を外し、幾何なしの画を描くまでブラシを受けない（ready）", async () => {
    await render();
    await run(() => heal.enter());
    expect(heal.active).toBe(true);
    expect(setCompareOriginal).toHaveBeenCalledWith(false);
    expect(heal.ready).toBe(false);
    await run(() => heal.framePainted("other-photo", SIZE, settingsRef.current));
    expect(heal.ready).toBe(false);
    await run(() => heal.framePainted(PHOTO_KEY, SIZE, settingsRef.current));
    expect(heal.ready).toBe(true);
    await run(() => heal.leave());
    expect(heal.active).toBe(false);
    expect(heal.ready).toBe(false);
  });

  it("写真を替えた・出す条件を満たさなくなった・編集内容がまるごと入れ替わったら閉じる", async () => {
    await render();
    await run(() => heal.enter());
    await render({ photoKey: "photo-2" });
    expect(heal.active).toBe(false);
    // 元の写真に戻っても、自分では開き直さない
    await render({ photoKey: PHOTO_KEY });
    expect(heal.active).toBe(false);

    await run(() => heal.enter());
    expect(heal.active).toBe(true);
    await render({ allowed: false });
    expect(heal.active).toBe(false);
    await render({ allowed: true });
    expect(heal.active).toBe(false);

    await run(() => heal.enter());
    await run(() => editResetHandlerRef.current?.());
    expect(heal.active).toBe(false);
  });

  it("描いた画に入っている印を指紋で覚える（描き直す前の印・値を変えた印は入っていない）", async () => {
    await render({ initial: withMark(neutralDevelopSettings(), "a") });
    await enterAndPaint();
    const [first] = heal.marks;
    expect(heal.paintedMarks.has(healMarkFingerprint(first))).toBe(true);
    await run(() => heal.select("a"));
    await run(() => heal.setRadius(0.05, "commit"));
    const [changed] = heal.marks;
    expect(heal.paintedMarks.has(healMarkFingerprint(changed))).toBe(false);
  });
});

describe("印を描く", () => {
  it("なぞった点で印を 1 回の確定で足し、その印を選ぶ（既定の値は 半径 2%・ぼかし 50%・消す）", async () => {
    await render();
    await enterAndPaint();
    const points: [number, number][] = [
      [0.1, 0.5],
      [0.2, 0.5],
    ];
    let added = false;
    await run(() => {
      added = heal.addMark(points, SIZE);
    });
    expect(added).toBe(true);
    expect(commits).toHaveLength(1);
    expect(readDevelopHeal(commits[0])).toEqual([
      { id: "h1", mode: "remove", radius: DEFAULT_HEAL_RADIUS, feather: DEFAULT_HEAL_FEATHER, points, source: null },
    ]);
    expect(commits[0].v).toBe(8);
    expect(heal.selectedId).toBe("h1");
    expect(heal.selectedOrder).toBe(1);
  });

  it("「写す」は写し元を決めて渡す（既定の写し元）", async () => {
    await render();
    await enterAndPaint();
    await run(() => heal.setMode("clone"));
    expect(changes).toHaveLength(0);
    await run(() => {
      heal.addMark([[0.5, 0.5]], SIZE);
    });
    const [mark] = readDevelopHeal(settingsRef.current);
    expect(mark.mode).toBe("clone");
    expect(mark.source).toEqual(defaultHealSource([[0.5, 0.5]], DEFAULT_HEAL_RADIUS, SIZE));
  });

  it("道具の外・点が無い・上限（印 64 個）では足さない", async () => {
    let full = neutralDevelopSettings();
    for (let index = 0; index < MAX_HEAL_MARKS; index += 1) full = withMark(full, `m${index}`);
    await render({ initial: full });
    let added = true;
    await run(() => {
      added = heal.addMark([[0.5, 0.5]], SIZE);
    });
    expect(added).toBe(false);
    await enterAndPaint();
    expect(heal.canAdd).toBe(false);
    expect(heal.pointLimit).toBe(0);
    await run(() => {
      added = heal.addMark([[0.5, 0.5]], SIZE);
    });
    expect(added).toBe(false);
    await run(() => {
      added = heal.addMark([], SIZE);
    });
    expect(added).toBe(false);
    expect(commits).toHaveLength(0);
  });
});

describe("ブラシの値", () => {
  it("印を選んでいなければ、次に描く印の値だけを替える（編集内容は変えない）", async () => {
    await render({ initial: withMark(neutralDevelopSettings(), "a") });
    await enterAndPaint();
    await run(() => heal.setRadius(0.04, "drag"));
    await run(() => heal.setRadius(0.05, "commit"));
    await run(() => heal.setFeather(0.2, "commit"));
    await run(() => heal.setMode("clone"));
    expect(changes).toHaveLength(0);
    expect(commits).toHaveLength(0);
    expect(heal.brush).toEqual({ mode: "clone", radius: 0.05, feather: 0.2 });
    expect(heal.newBrush).toEqual(heal.brush);
    await run(() => {
      heal.addMark([[0.7, 0.7]], SIZE);
    });
    expect(readDevelopHeal(settingsRef.current)[1]).toMatchObject({ mode: "clone", radius: 0.05, feather: 0.2 });
  });

  it("印を選んでいれば、その印の値を直接動かす（drag は描き直すだけ、commit で 1 単位）。次に描く印の値も同じにする", async () => {
    await render({ initial: withMark(withMark(neutralDevelopSettings(), "a"), "b", { radius: 0.03 }) });
    await enterAndPaint();
    await run(() => heal.select("a"));
    expect(heal.brush.radius).toBe(0.02);
    await run(() => heal.setRadius(0.035, "drag"));
    await run(() => heal.setRadius(0.04, "commit"));
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(commits).toHaveLength(1);
    const marks = readDevelopHeal(settingsRef.current);
    expect(marks.map((mark) => mark.radius)).toEqual([0.04, 0.03]);
    expect(heal.brush.radius).toBe(0.04);
    expect(heal.newBrush.radius).toBe(0.04);

    await run(() => heal.setFeather(0.9, "commit"));
    expect(readDevelopHeal(settingsRef.current)[0].feather).toBe(0.9);
    // 「消す」→「写す」は写し元を決めて渡す
    await run(() => heal.setMode("clone"));
    const [clone] = readDevelopHeal(settingsRef.current);
    expect(clone.mode).toBe("clone");
    expect(clone.source).toEqual(defaultHealSource(clone.points, clone.radius, SIZE));
    expect(commits).toHaveLength(3);
  });

  it("選んだ印のブラシを次の印へ引き継ぎ、写す半径を大きくしたら写し元を押し戻す", async () => {
    const initial = withMark(
      withMark(neutralDevelopSettings(), "remove"),
      "clone",
      { mode: "clone", radius: 0.02, feather: 0.3, points: [[0.5, 0.5]], source: [0.48, 0] },
    );
    await render({ initial });
    await enterAndPaint();
    await run(() => heal.select("clone"));
    expect(heal.newBrush).toEqual({ mode: "clone", radius: 0.02, feather: 0.3 });

    await run(() => heal.setRadius(0.05, "commit"));
    const clone = readDevelopHeal(settingsRef.current).find((mark) => mark.id === "clone");
    expect(clone?.source).toEqual(clampHealSource([[0.5, 0.5]], 0.05, [0.48, 0], SIZE));

    await run(() => heal.addMark([[0.7, 0.7]], SIZE));
    const added = readDevelopHeal(settingsRef.current).find((mark) => mark.id !== "remove" && mark.id !== "clone");
    expect(added).toMatchObject({ mode: "clone", radius: 0.05, feather: 0.3 });
  });

  it("[ ] は 1 段ずつ（選んでいる印があればその印も）", async () => {
    await render({ initial: withMark(neutralDevelopSettings(), "a") });
    await enterAndPaint();
    await run(() => heal.stepRadius(1));
    expect(heal.newBrush.radius).toBe(stepHealRadius(DEFAULT_HEAL_RADIUS, 1));
    expect(commits).toHaveLength(0);
    await run(() => heal.select("a"));
    await run(() => heal.stepRadius(-1));
    expect(readDevelopHeal(settingsRef.current)[0].radius).toBe(stepHealRadius(0.02, -1));
    expect(commits).toHaveLength(1);
  });

  it("写し元を動かす（drag → commit）", async () => {
    await render({ initial: withMark(neutralDevelopSettings(), "a", { mode: "clone", source: [0.1, 0] }) });
    await enterAndPaint();
    await run(() => heal.changeSource("a", [0.12, 0.01], "drag"));
    await run(() => heal.changeSource("a", [0.15, 0.02], "commit"));
    expect(changes.map((change) => change.phase)).toEqual(["drag", "commit"]);
    expect(readDevelopHeal(settingsRef.current)[0].source).toEqual([0.15, 0.02]);
  });
});

describe("印の一覧", () => {
  it("選ぶ・選んだ印を消す・ほかの印を消す・すべて消す（どれも 1 単位）", async () => {
    await render({ initial: withMark(withMark(withMark(neutralDevelopSettings(), "a"), "b"), "c") });
    await enterAndPaint();
    await run(() => heal.select("b"));
    expect(heal.selectedId).toBe("b");
    expect(heal.selectedOrder).toBe(2);
    await run(() => heal.removeSelected());
    expect(heal.marks.map((mark) => mark.id)).toEqual(["a", "c"]);
    expect(heal.selectedId).toBeNull();
    // 選んでいなければ Delete は何もしない
    await run(() => heal.removeSelected());
    expect(commits).toHaveLength(1);
    await run(() => heal.select("c"));
    await run(() => heal.remove("a"));
    expect(heal.marks.map((mark) => mark.id)).toEqual(["c"]);
    expect(heal.selectedId).toBe("c");
    await run(() => heal.clear());
    expect(heal.marks).toEqual([]);
    expect(settingsRef.current.heal).toBeUndefined();
    expect(heal.selectedId).toBeNull();
    expect(commits).toHaveLength(3);
  });

  it("取り消しで選んでいた印が無くなったら選んでいない扱い（Delete・スライダーは何も消さない・替えない）", async () => {
    const marked = withMark(neutralDevelopSettings(), "a");
    await render({ initial: marked });
    await enterAndPaint();
    await run(() => heal.select("a"));
    await run(() => replaceSettings(neutralDevelopSettings()));
    expect(heal.selectedId).toBeNull();
    await run(() => heal.removeSelected());
    await run(() => heal.setRadius(0.05, "commit"));
    expect(commits).toHaveLength(0);
    expect(changes).toHaveLength(0);
    // やり直しで戻れば、また選んでいる
    await run(() => replaceSettings(marked));
    expect(heal.selectedId).toBe("a");
  });

  it("印の表示の切り替え", async () => {
    await render();
    expect(heal.showMarks).toBe(true);
    await run(() => heal.toggleShowMarks());
    expect(heal.showMarks).toBe(false);
    await run(() => heal.setShowMarks(true));
    expect(heal.showMarks).toBe(true);
  });
});

describe("修復の道具のキー", () => {
  const keyEvent = (key: string, init: Partial<KeyboardEvent> = {}) => ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    defaultPrevented: false,
    ...init,
  });

  it("[ = 小さく、] = 大きく、O = 印の表示。修飾キーつき・文字を打つ欄・使われたキーは扱わない", () => {
    expect(resolveBrowserPhotoHealKey(keyEvent("["), { typing: false })).toBe("smaller");
    expect(resolveBrowserPhotoHealKey(keyEvent("]"), { typing: false })).toBe("larger");
    expect(resolveBrowserPhotoHealKey(keyEvent("o"), { typing: false })).toBe("marks");
    expect(resolveBrowserPhotoHealKey(keyEvent("O"), { typing: false })).toBe("marks");
    expect(resolveBrowserPhotoHealKey(keyEvent("O", { shiftKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("]", { metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("z", { metaKey: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("["), { typing: true })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("[", { defaultPrevented: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("[", { isComposing: true }), { typing: false })).toBeNull();
    expect(resolveBrowserPhotoHealKey(keyEvent("Delete"), { typing: false })).toBeNull();
  });

  it("道具の間だけ document のキーを聞き、画面の外・押しっぱなしの繰り返しは扱わない", async () => {
    const onKey = vi.fn<(key: BrowserPhotoHealKey) => void>();
    const screen = document.createElement("section");
    const outside = document.createElement("input");
    document.body.append(screen, outside);
    function Keys(props: { enabled: boolean }) {
      const rootRef = useRef<HTMLElement | null>(screen);
      useBrowserPhotoHealKeys({ rootRef, enabled: props.enabled, onKey });
      return null;
    }
    const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    await act(async () => root.render(<Keys enabled={false} />));
    press(screen, "]");
    expect(onKey).not.toHaveBeenCalled();
    await act(async () => root.render(<Keys enabled />));
    const event = press(screen, "]");
    expect(onKey).toHaveBeenLastCalledWith("larger");
    expect(event.defaultPrevented).toBe(true);
    press(document.body, "o");
    expect(onKey).toHaveBeenLastCalledWith("marks");
    press(screen, "[", { repeat: true });
    expect(onKey).toHaveBeenCalledTimes(2);
    press(outside, "[");
    expect(onKey).toHaveBeenCalledTimes(2);
    screen.remove();
    outside.remove();
  });
});
