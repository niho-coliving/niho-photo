// @vitest-environment jsdom

import { act, useRef, useState, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DevelopEngine, DevelopMaskCapabilities } from "../develop-engine/develop-engine-client";
import { readDevelopMasks, writeDevelopMasks, type DevelopSurfaceMask } from "../develop-engine/develop-masks";
import { neutralDevelopSettings, readDevelopSettings, type DevelopSettings } from "../develop-engine/develop-settings";
import type { PhotoEditingMaskSurfaceData } from "../photo-editing-mask-brush";
import type { PhotoEditingSettings } from "../photo-editing-types";

import type { DevelopSession } from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { useBrowserPhotoMasks, type BrowserPhotoMaskTool, type PhotoEditingMaskSurfaceIssue } from "./use-browser-photo-masks";

/**
 * ブラシのマスク（M4 #68）の状態: 出す条件、足す（空の面を保存して 1 単位）、1 ストロークが 1 単位、保存中の次のストローク、esc・道具の
 * 切り替え・写真の切り替えで捨てる、取り消しで古い面から続ける、読めない面の理由と読み直し、全体を塗る / 消す、E。
 */

const SOURCE = { width: 3000, height: 2000 };
const PHOTO_KEY = "photo-1";
const SUPPORT: DevelopMaskCapabilities = { kinds: ["linear", "radial", "brush", "subject", "sky"], max: 8, maskPlane: true, surfaces: true };
const SURFACE = { width: 1024, height: 683 };

/** テスト用の面の PNG: 幅・高さ（各 2 byte）と値。id は中身から決める（同じ中身は同じ id）。 */
function fakePng(width: number, height: number, data: Uint8Array): Uint8Array {
  const png = new Uint8Array(4 + data.length);
  png.set([width & 0xff, width >> 8, height & 0xff, height >> 8]);
  png.set(data, 4);
  return png;
}

async function fakeDecode(png: Uint8Array): Promise<PhotoEditingMaskSurfaceData> {
  const width = png[0]! | (png[1]! << 8);
  const height = png[2]! | (png[3]! << 8);
  return { width, height, data: png.slice(4) };
}

function contentId(png: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of png) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return (hash.toString(16).padStart(8, "0") + png.length.toString(16)).padStart(64, "0");
}

let container: HTMLDivElement;
let root: Root;
let tool: BrowserPhotoMaskTool;
let settingsRef: MutableRefObject<DevelopSettings>;
let commits: number;
let history: DevelopSettings[];
let setOuterSettings: (settings: DevelopSettings) => void;
/** 置き場（id → PNG） */
let stored: Map<string, Uint8Array>;
let encoded: Uint8Array[];
let saveGate: Promise<void> | null;

const maskSurfacePng = vi.fn(async (id: string) => stored.get(id) ?? null);
const retryMaskSurfaces = vi.fn();
const engine = {
  imageSize: async () => SOURCE,
  encodeMaskSurface: async (width: number, height: number, data: Uint8Array) => {
    encoded.push(data.slice());
    const png = fakePng(width, height, data);
    return { id: contentId(png), png };
  },
  maskSurfacePng,
  retryMaskSurfaces,
} as unknown as DevelopEngine;
const session = {
  key: PHOTO_KEY,
  photoId: "photo-id-1",
  input: { kind: "workingCopy" },
  working: null,
  workSize: SOURCE,
} as unknown as DevelopSession;

const saveMaskSurface = vi.fn(async (_photoId: string, png: Uint8Array) => {
  if (saveGate) await saveGate;
  const id = contentId(png);
  stored.set(id, png);
  return { id };
});

type HarnessProps = {
  initial: DevelopSettings;
  support?: DevelopMaskCapabilities | null;
  photoKey?: string;
  canSave?: boolean;
  surfaceIssue?: PhotoEditingMaskSurfaceIssue | null;
};

function Harness(props: HarnessProps) {
  const mountedRef = useRef(true);
  const engineRef = useRef<DevelopEngine | null>(engine);
  const developSessionRef = useRef<DevelopSession | null>(session);
  const [settings, setSettings] = useState(props.initial);
  const ref = useRef(props.initial);
  settingsRef = ref;
  setOuterSettings = (next) => {
    ref.current = next;
    setSettings(next);
  };
  let seed = 0;
  tool = useBrowserPhotoMasks({
    mountedRef,
    engineRef,
    developSessionRef,
    wide: true,
    photoKey: props.photoKey ?? PHOTO_KEY,
    support: props.support === undefined ? SUPPORT : props.support,
    exportBlocked: false,
    otherToolActive: false,
    disabled: false,
    settings,
    settingsRef: ref,
    changeSettings: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => {
      const next = readDevelopSettings(update(ref.current as PhotoEditingSettings));
      if (!next) return;
      if (phase === "commit") {
        commits += 1;
        history.push(ref.current);
      }
      ref.current = next;
      setSettings(next);
    },
    commitEdit: (next) => {
      commits += 1;
      history.push(ref.current);
      ref.current = next;
      setSettings(next);
      return true;
    },
    saveMaskSurface: props.canSave === false ? null : saveMaskSurface,
    surfaceIssue: props.surfaceIssue ?? null,
    onRetrySurfaces: vi.fn(),
    random: () => {
      seed += 0.137;
      return seed % 1;
    },
    decodeMaskSurface: fakeDecode,
  });
  return null;
}

async function render(props: Partial<HarnessProps> = {}) {
  await act(async () => {
    root.render(<Harness initial={neutralDevelopSettings()} {...props} />);
  });
}

async function settle() {
  for (let index = 0; index < 4; index += 1) await act(async () => undefined);
}

async function enterAndAddBrush() {
  await act(async () => tool.enter());
  await settle();
  await act(async () => tool.add("brush"));
  await settle();
  expect(tool.brush.status).toBe("ready");
}

function brushMask(): DevelopSurfaceMask {
  const mask = readDevelopMasks(settingsRef.current).find((candidate) => candidate.kind === "brush");
  if (!mask || mask.kind !== "brush") throw new Error("brush mask expected");
  return mask;
}

/** 写真の左上から右下へ 1 本塗る（出力の 0〜1）。 */
function stroke(points: Array<[number, number]>, erase = false): boolean {
  const handle = tool.brush.startStroke(erase);
  if (!handle) return false;
  for (const point of points) handle.dab(point);
  return handle.finish(true);
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  commits = 0;
  history = [];
  stored = new Map();
  encoded = [];
  saveGate = null;
  maskSurfacePng.mockClear();
  retryMaskSurfaces.mockClear();
  saveMaskSurface.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ブラシ（useBrowserPhotoMasks の brush）", () => {
  it("面を受け渡せる wasm で、面を保存できる出どころのときだけ「ブラシ」を足せる", async () => {
    await render();
    expect(tool.kinds).toEqual(["linear", "radial", "brush"]);
    await render({ canSave: false });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: { ...SUPPORT, surfaces: undefined } });
    expect(tool.kinds).toEqual(["linear", "radial"]);
    await render({ support: { kinds: ["brush"], max: 8, maskPlane: true, surfaces: true }, canSave: false });
    expect(tool.available).toBe(false);
  });

  it("足すと作業画像の縦横比の空の面（長辺 1024・全部 0）を保存し、1 単位で足して選び、塗れる", async () => {
    await render();
    await enterAndAddBrush();
    expect(commits).toBe(1);
    expect(saveMaskSurface).toHaveBeenCalledOnce();
    expect(saveMaskSurface.mock.calls[0]![0]).toBe("photo-id-1");
    expect(encoded[0]!.length).toBe(SURFACE.width * SURFACE.height);
    expect(encoded[0]!.every((value) => value === 0)).toBe(true);
    const mask = brushMask();
    expect(mask).toMatchObject({ kind: "brush", adjust: {}, surface: { ...SURFACE, id: contentId(fakePng(1024, 683, encoded[0]!)) } });
    expect(tool.selected?.id).toBe(mask.id);
    expect(tool.brush.layerVisible).toBe(true);
    expect(tool.brush.canPaint).toBe(true);
    expect(readDevelopSettings(JSON.parse(JSON.stringify(settingsRef.current)) as unknown)).not.toBeNull();
  });

  it("1 ストロークは面を保存してマスクの surface を 1 回だけ確定する（取り消しの 1 単位）", async () => {
    await render();
    await enterAndAddBrush();
    const before = brushMask().surface.id;
    commits = 0;
    await act(async () => {
      expect(stroke([[0.2, 0.3], [0.25, 0.3], [0.3, 0.32]])).toBe(true);
    });
    await settle();
    expect(commits).toBe(1);
    const after = brushMask().surface;
    expect(after.id).not.toBe(before);
    expect(after).toMatchObject(SURFACE);
    expect(stored.has(after.id)).toBe(true);
    expect(tool.brush.saving).toBe(false);
    // 塗った所だけ 0 でない
    const data = encoded.at(-1)!;
    const at = (x: number, y: number) => data[Math.floor(y * SURFACE.height) * SURFACE.width + Math.floor(x * SURFACE.width)]!;
    expect(at(0.25, 0.3)).toBeGreaterThan(0);
    expect(at(0.8, 0.8)).toBe(0);
    // 何も変えないストローク（面の外）は確定しない
    await act(async () => {
      expect(stroke([[5, 5]])).toBe(false);
    });
    await settle();
    expect(commits).toBe(1);
  });

  it("保存の途中の次のストロークは前の塗りの上に塗り、確定は順に 1 単位ずつ", async () => {
    await render();
    await enterAndAddBrush();
    commits = 0;
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      stroke([[0.2, 0.2]]);
    });
    await settle();
    expect(tool.brush.saving).toBe(true);
    await act(async () => {
      expect(stroke([[0.6, 0.6]])).toBe(true);
    });
    expect(commits).toBe(0);
    saveGate = null;
    await act(async () => release());
    await settle();
    expect(commits).toBe(2);
    expect(tool.brush.saving).toBe(false);
    // 2 本目の面は 1 本目の塗りを含む
    const second = encoded.at(-1)!;
    const at = (x: number, y: number) => second[Math.floor(y * SURFACE.height) * SURFACE.width + Math.floor(x * SURFACE.width)]!;
    expect(at(0.2, 0.2)).toBeGreaterThan(0);
    expect(at(0.6, 0.6)).toBeGreaterThan(0);
    expect(brushMask().surface.id).toBe(contentId(fakePng(1024, 683, second)));
  });

  it("esc は塗るのをやめ（マスクは選んだまま。もう一度で選択を外す）、塗っている途中のストロークを捨てる", async () => {
    await render();
    await enterAndAddBrush();
    commits = 0;
    const handle = tool.brush.startStroke(false)!;
    handle.dab([0.5, 0.5]);
    const preventDefault = vi.fn();
    await act(async () => {
      expect(tool.handleShortcut("escape", { preventDefault })).toBe(true);
    });
    expect(handle.finish(true)).toBe(false);
    await settle();
    expect(commits).toBe(0);
    expect(tool.brush.layerVisible).toBe(false);
    expect(tool.selected).not.toBeNull();
    await act(async () => tool.brush.resumePaint());
    expect(tool.brush.layerVisible).toBe(true);
    await act(async () => {
      tool.handleShortcut("escape", { preventDefault });
    });
    await act(async () => {
      tool.handleShortcut("escape", { preventDefault });
    });
    expect(tool.selected).toBeNull();
  });

  it("道具を離れると塗っている途中のストロークを捨てる。写真を替えると待っている確定も捨てる", async () => {
    await render();
    await enterAndAddBrush();
    commits = 0;
    const handle = tool.brush.startStroke(false)!;
    handle.dab([0.5, 0.5]);
    await act(async () => tool.leave());
    expect(handle.finish(true)).toBe(false);
    await settle();
    expect(commits).toBe(0);

    await act(async () => tool.enter());
    await settle();
    await act(async () => tool.select(brushMask().id));
    await settle();
    let release!: () => void;
    saveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () => {
      stroke([[0.4, 0.4]]);
    });
    await settle();
    await render({ photoKey: "photo-2" });
    saveGate = null;
    await act(async () => release());
    await settle();
    expect(commits).toBe(0);
  });

  it("取り消しで面が替わったら、その面を読み直して続きを塗る（古い面の id）", async () => {
    await render();
    await enterAndAddBrush();
    const blank = brushMask().surface.id;
    await act(async () => {
      stroke([[0.3, 0.3]]);
    });
    await settle();
    expect(brushMask().surface.id).not.toBe(blank);
    maskSurfacePng.mockClear();
    // 取り消し（1 つ前の設定に戻す）
    await act(async () => setOuterSettings(history.at(-1)!));
    await settle();
    expect(brushMask().surface.id).toBe(blank);
    expect(maskSurfacePng).toHaveBeenCalledWith(blank);
    expect(tool.brush.status).toBe("ready");
    await act(async () => {
      stroke([[0.7, 0.7]]);
    });
    await settle();
    // 続きは古い面（空）の上: 取り消した塗りは入らない
    const data = encoded.at(-1)!;
    const at = (x: number, y: number) => data[Math.floor(y * SURFACE.height) * SURFACE.width + Math.floor(x * SURFACE.width)]!;
    expect(at(0.3, 0.3)).toBe(0);
    expect(at(0.7, 0.7)).toBeGreaterThan(0);
  });

  it("読めない面には塗らず、マスクの名前つきの理由を出す。読み直すと読める", async () => {
    const id = "f".repeat(64);
    const initial = writeDevelopMasks(neutralDevelopSettings(), [
      { id: "mask-b", kind: "brush", enabled: true, invert: false, surface: { id, ...SURFACE }, adjust: {} },
    ]);
    await render({ initial });
    await act(async () => tool.enter());
    await settle();
    await act(async () => tool.select("mask-b"));
    await settle();
    expect(tool.brush.status).toBe("unreadable");
    expect(tool.brush.canPaint).toBe(false);
    expect(tool.brush.startStroke(false)).toBeNull();
    expect(tool.notice).toBe("マスクの面を読めません（ブラシ 1）。もう一度読み込むか、このマスクを削除してください。");
    expect(tool.canRetrySurfaces).toBe(true);
    stored.set(id, fakePng(1024, 683, new Uint8Array(1024 * 683)));
    await act(async () => tool.retrySurfaces());
    await settle();
    expect(retryMaskSurfaces).toHaveBeenCalled();
    expect(tool.brush.status).toBe("ready");
    expect(tool.notice).toBeNull();
  });

  it("寸法の合わない面も読めない扱い", async () => {
    const id = "e".repeat(64);
    stored.set(id, fakePng(10, 10, new Uint8Array(100)));
    const initial = writeDevelopMasks(neutralDevelopSettings(), [
      { id: "mask-b", kind: "brush", enabled: true, invert: false, surface: { id, ...SURFACE }, adjust: {} },
    ]);
    await render({ initial });
    await act(async () => tool.enter());
    await settle();
    await act(async () => tool.select("mask-b"));
    await settle();
    expect(tool.brush.status).toBe("unreadable");
  });

  it("描画が面を読めなかったマスクを名前で出す（被写体・空も）", async () => {
    const initial = writeDevelopMasks(neutralDevelopSettings(), [
      { id: "mask-s", kind: "subject", enabled: true, invert: false, surface: { id: "c".repeat(64), ...SURFACE }, adjust: { exposure: 1 } },
      { id: "mask-k", kind: "sky", enabled: true, invert: false, surface: { id: "d".repeat(64), ...SURFACE }, adjust: { exposure: -1 } },
    ]);
    await render({ initial, surfaceIssue: { photoKey: PHOTO_KEY, maskIds: ["mask-s", "mask-k"] } });
    expect(tool.notice).toBe("マスクの面を読めません（被写体 1・空 2）。もう一度読み込むか、このマスクを削除してください。");
    await render({ initial, surfaceIssue: { photoKey: "other", maskIds: ["mask-s"] } });
    expect(tool.notice).toBeNull();
    // 被写体・空は塗らない
    await act(async () => tool.enter());
    await settle();
    await act(async () => tool.select("mask-s"));
    expect(tool.brush.layerVisible).toBe(false);
    expect(tool.brush.startStroke(false)).toBeNull();
  });

  it("全体を塗る / 全体を消すは 1 単位ずつ（同じ面なら何もしない）。E は消しゴムの切り替え", async () => {
    await render();
    await enterAndAddBrush();
    commits = 0;
    await act(async () => tool.brush.clear());
    await settle();
    expect(commits).toBe(0);
    await act(async () => tool.brush.fill());
    await settle();
    expect(commits).toBe(1);
    expect(encoded.at(-1)!.every((value) => value === 255)).toBe(true);
    await act(async () => tool.brush.clear());
    await settle();
    expect(commits).toBe(2);
    expect(encoded.at(-1)!.every((value) => value === 0)).toBe(true);

    const preventDefault = vi.fn();
    expect(tool.brush.brush.erase).toBe(false);
    await act(async () => {
      expect(tool.handleShortcut("loupe", { preventDefault })).toBe(true);
    });
    expect(tool.brush.brush.erase).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    // 消しゴムで塗る
    await act(async () => tool.brush.fill());
    await settle();
    await act(async () => {
      stroke([[0.5, 0.5]], true);
    });
    await settle();
    const data = encoded.at(-1)!;
    expect(data[Math.floor(0.5 * SURFACE.height) * SURFACE.width + Math.floor(0.5 * SURFACE.width)]).toBeLessThan(255);
    expect(data[0]).toBe(255);
  });

  it("大きさ・ぼかし・流量は範囲に収める", async () => {
    await render();
    await act(async () => tool.brush.setSize(100));
    expect(tool.brush.brush.size).toBe(30);
    await act(async () => tool.brush.stepSize(-1));
    expect(tool.brush.brush.size).toBe(24);
    await act(async () => tool.brush.setFlow(0));
    expect(tool.brush.brush.flow).toBe(1);
    await act(async () => tool.brush.setFeather(150));
    expect(tool.brush.brush.feather).toBe(100);
  });
});
