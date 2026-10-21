"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import type { DevelopEngine, DevelopMaskCapabilities, DevelopMaskPlane } from "../develop-engine/develop-engine-client";
import { readDevelopGeometry, type DevelopSize } from "../develop-engine/develop-geometry";
import {
  MAX_DEVELOP_MASKS,
  readDevelopMasks,
  writeDevelopMasks,
  type DevelopMask,
  type DevelopMaskAdjustKey,
} from "../develop-engine/develop-masks";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import { PHOTO_EDITING_MASK_EXPORT_UNSUPPORTED_TEXT, photoEditingMaskLimitText } from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_SHAPE_KINDS,
  addPhotoEditingMask,
  createPhotoEditingMask,
  createPhotoEditingMaskId,
  duplicatePhotoEditingMask,
  isPhotoEditingMaskFrameValid,
  isPhotoEditingWhiteBalanceAbsolute,
  removePhotoEditingMask,
  setPhotoEditingMaskAdjust,
  setPhotoEditingMaskFeather,
  togglePhotoEditingMaskEnabled,
  togglePhotoEditingMaskInvert,
  updatePhotoEditingMask,
  withPhotoEditingMaskShape,
  type PhotoEditingMaskFrame,
  type PhotoEditingMaskShapeKind,
} from "../photo-editing-masks";
import type { PhotoEditingShortcut } from "../use-photo-editing-shortcuts";

import { DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION, DEVELOP_PREVIEW_MAX_DIMENSION, type DevelopSession } from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";
import { readCropSource } from "./use-browser-photo-crop";

/**
 * 部分補正（マスク）を描ける wasm か（`engine.supportsMasks()`。wasm の `capabilities()`）。wasm で開いた写真を 1 枚で見ているときに
 * 1 回だけ確かめ、結果は画面を開いている間覚える（色ミキサーの `useBrowserPhotoColorPointsSupport` と同じ）。確かめている間・
 * 口の無い古い wasm・wasm を使えないときは null（道具を出さない）。
 */
export function useBrowserPhotoMasksSupport(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
}): DevelopMaskCapabilities | null {
  const { mountedRef, engineRef, photoKey } = params;
  const [supported, setSupported] = useState<DevelopMaskCapabilities | null | undefined>(undefined);
  const wanted = photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== undefined) return;
    const engine = engineRef.current;
    if (!engine) return;
    if (!engine.supportsMasks) {
      setSupported(null);
      return;
    }
    let cancelled = false;
    engine.supportsMasks().then(
      (value) => {
        if (!cancelled && mountedRef.current) setSupported(value ?? null);
      },
      () => {
        if (!cancelled && mountedRef.current) setSupported(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [engineRef, mountedRef, photoKey, supported, wanted]);
  return supported ?? null;
}

/**
 * 原寸の書き出しの描画がマスクを描けないか（足すのを止めて理由を出す）。この Mac の原寸の書き出し（`nativeExport`・更新が要る
 * `nativeExportUpdateRequired`）があるのに `nativeExportMasks` が true でない（`PhotoLibraryCapabilities` の「省略 = 描けない」）
 * とき。原寸の書き出しの無い出どころ（ブラウザのクラウド）は wasm が描くので止めない。
 */
export function photoEditingMaskExportBlocked(capabilities: {
  nativeExport: boolean;
  nativeExportUpdateRequired: boolean;
  nativeExportMasks?: boolean;
}): boolean {
  return (capabilities.nativeExport || capabilities.nativeExportUpdateRequired) && capabilities.nativeExportMasks !== true;
}

/** 足せる種類（wasm が描ける種類のうち、画面で形を作れるもの。ブラシは M4）。 */
function shapeKinds(support: DevelopMaskCapabilities | null): PhotoEditingMaskShapeKind[] {
  if (!support) return [];
  return PHOTO_EDITING_MASK_SHAPE_KINDS.filter((kind) => support.kinds.includes(kind));
}

/**
 * ブラウザ版の右パネルのマスクの道具（部分補正。Epic #31 M3 #67。契約は `docs/local-adjustments.md`）の状態。
 *
 * - 出す条件（`available`）: PC の幅・wasm で開いて 1 枚で見ている写真・描ける種類のある wasm（`useBrowserPhotoMasksSupport`）。
 *   スマホの面には出さない
 * - 入るとき（`enter`）に座標の基準（作業画像の大きさ。切り抜きと同じ `readCropSource`）を読む。読めるまで足すボタンは押せない
 * - 編集はすべて `changeSettings(update, phase)` を通す（`drag` は速い描き方で履歴に積まず、`commit` が取り消しの 1 単位。自動保存・
 *   下書きの退避・取り消しはそのまま効く）。`update` は呼ばれた時点の最新の設定のマスクに当てる
 * - 選んでいるマスクは id で覚える（取り消しで無くなれば選んでいない扱い）。写真を替える・出す条件を満たさなくなる・切り抜き /
 *   背景除去の道具に移ると「補正」に戻す
 */
export function useBrowserPhotoMasks(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  developSessionRef: MutableRefObject<DevelopSession | null>;
  /** PC の幅（スマホの面には出さない） */
  wide: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  support: DevelopMaskCapabilities | null;
  /** 原寸の書き出しがマスクを描けない（{@link photoEditingMaskExportBlocked}） */
  exportBlocked: boolean;
  /** 切り抜き・背景除去の道具を使っている（道具は 1 つずつ） */
  otherToolActive: boolean;
  /** 押せない（閲覧のみ・操作の途中など。右パネルの `controlsDisabled`） */
  disabled: boolean;
  settings: DevelopSettings;
  settingsRef: MutableRefObject<DevelopSettings>;
  changeSettings: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
  /** 取り消しの 1 単位として確定する（「初期化」で使う） */
  commitEdit: (next: DevelopSettings, options?: { resetDone?: boolean }) => boolean;
  /** id の乱数（テスト用） */
  random?: () => number;
}) {
  const { mountedRef, engineRef, developSessionRef, wide, photoKey, support, settings, settingsRef, changeSettings, commitEdit } =
    params;
  const random = params.random ?? Math.random;
  const available = wide && photoKey !== null && shapeKinds(support).length > 0;
  const [active, setActive] = useState(false);
  const [source, setSource] = useState<{ key: string; size: DevelopSize } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 選んでいるマスクの範囲を赤く重ねる（O。写真を替えても保つ） */
  const [overlayVisible, setOverlayVisible] = useState(false);
  /** 写真の上のつまみを動かしている間（範囲を重ねて見せる） */
  const [shapeDragging, setShapeDragging] = useState(false);
  const generationRef = useRef(0);

  const leave = useCallback(() => {
    generationRef.current += 1;
    setActive(false);
    setShapeDragging(false);
  }, []);

  // 写真を替えた・出す条件を満たさなくなった・ほかの道具に移ったら「補正」に戻す（選択も捨てる）
  useEffect(() => {
    leave();
    setSelectedId(null);
    setSource(null);
  }, [leave, photoKey]);
  useEffect(() => {
    if (!available || params.otherToolActive) leave();
  }, [available, leave, params.otherToolActive]);

  const enter = useCallback(() => {
    if (!available || photoKey === null) return;
    setActive(true);
    if (source?.key === photoKey) return;
    const generation = ++generationRef.current;
    const engine = engineRef.current;
    const session = developSessionRef.current;
    if (!engine || !session) return;
    void readCropSource(engine, session).then(
      (read) => {
        if (!mountedRef.current || generation !== generationRef.current || !read) return;
        setSource({ key: photoKey, size: read.source });
      },
      () => undefined,
    );
  }, [available, developSessionRef, engineRef, mountedRef, photoKey, source?.key]);

  const masks = useMemo(() => readDevelopMasks(settings), [settings]);
  const geometry = useMemo(() => readDevelopGeometry(settings), [settings]);
  const sourceSize = source && source.key === photoKey ? source.size : null;
  const frame = useMemo<PhotoEditingMaskFrame | null>(
    () => (sourceSize ? { geometry, source: sourceSize } : null),
    [geometry, sourceSize],
  );
  const frameValid = isPhotoEditingMaskFrameValid(frame);
  const selected = masks.find((mask) => mask.id === selectedId) ?? null;
  const kinds = shapeKinds(support);
  const max = Math.min(support?.max ?? MAX_DEVELOP_MASKS, MAX_DEVELOP_MASKS);
  const whiteBalanceAbsolute = isPhotoEditingWhiteBalanceAbsolute(settings);
  const addBlockedReason = params.exportBlocked
    ? PHOTO_EDITING_MASK_EXPORT_UNSUPPORTED_TEXT
    : masks.length >= max
      ? photoEditingMaskLimitText(max)
      : null;
  const canAdd = active && !params.disabled && addBlockedReason === null && frameValid;

  /** 最新の設定のマスクを書き換える（壊れる・変わらない書き換えは設定を返したまま）。 */
  const changeMasks = useCallback(
    (update: (masks: DevelopMask[], current: DevelopSettings) => DevelopMask[], phase: PhotoEditingSliderPhase) => {
      changeSettings((current) => {
        const develop = current as DevelopSettings;
        try {
          return writeDevelopMasks(develop, update(readDevelopMasks(develop), develop));
        } catch {
          return current;
        }
      }, phase);
    },
    [changeSettings],
  );

  const add = (kind: PhotoEditingMaskShapeKind) => {
    if (!canAdd || !kinds.includes(kind) || !frame) return;
    const id = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
    changeMasks((current, develop) => {
      if (current.length >= max) return current;
      const mask = createPhotoEditingMask(kind, { geometry: readDevelopGeometry(develop), source: frame.source }, id);
      return mask ? addPhotoEditingMask(current, mask) : current;
    }, "commit");
    setSelectedId(id);
  };

  const duplicate = (id: string) => {
    if (params.disabled || addBlockedReason !== null) return;
    const newId = createPhotoEditingMaskId(readDevelopMasks(settingsRef.current), random);
    changeMasks(
      (current, develop) =>
        current.length >= max
          ? current
          : duplicatePhotoEditingMask(current, id, frame ? { geometry: readDevelopGeometry(develop), source: frame.source } : null, newId),
      "commit",
    );
    setSelectedId(newId);
  };

  const remove = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => removePhotoEditingMask(current, id), "commit");
    setSelectedId((current) => (current === id ? null : current));
  };

  const toggleEnabled = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => updatePhotoEditingMask(current, id, togglePhotoEditingMaskEnabled), "commit");
  };

  const toggleInvert = (id: string) => {
    if (params.disabled) return;
    changeMasks((current) => updatePhotoEditingMask(current, id, togglePhotoEditingMaskInvert), "commit");
  };

  const changeAdjust = (id: string, key: DevelopMaskAdjustKey, value: number, phase: PhotoEditingSliderPhase) => {
    changeMasks(
      (current, develop) =>
        updatePhotoEditingMask(current, id, (mask) =>
          setPhotoEditingMaskAdjust(mask, key, value, { whiteBalanceAbsolute: isPhotoEditingWhiteBalanceAbsolute(develop) }),
        ),
      phase,
    );
  };

  const changeFeather = (id: string, value: number, phase: PhotoEditingSliderPhase) => {
    changeMasks((current) => updatePhotoEditingMask(current, id, (mask) => setPhotoEditingMaskFeather(mask, value)), phase);
  };

  /** 写真の上で動かした形（`drag` は途中、`commit` は離した・キーを離した＝取り消しの 1 単位）。 */
  const changeShape = (mask: DevelopMask, phase: "drag" | "commit") => {
    changeMasks((current) => updatePhotoEditingMask(current, mask.id, (previous) => withPhotoEditingMaskShape(previous, mask)), phase);
  };

  /** 「初期化」（マスクの道具の間はマスクだけを外す。取り消しの 1 単位で「初期化しました」を出す）。 */
  const canReset = masks.length > 0;
  const reset = () => {
    if (params.disabled) return;
    setSelectedId(null);
    try {
      commitEdit(writeDevelopMasks(settingsRef.current, []), { resetDone: true });
    } catch {
      // 書けない設定は変えない
    }
  };

  /**
   * 写真の編集のキー（`usePhotoEditingShortcuts`）のうち、マスクの道具の間に先に扱うもの。Esc は選択を外す（選んでいなければ
   * 扱わない＝「補正」に戻る）、⌫ / Delete は選んでいるマスクを削除する（選んでいなくても写真は消さない）。扱ったら true。
   */
  const handleShortcut = (shortcut: PhotoEditingShortcut, event: Pick<KeyboardEvent, "preventDefault">): boolean => {
    if (!active) return false;
    if (shortcut === "escape") {
      if (selectedId === null) return false;
      event.preventDefault();
      setSelectedId(null);
      return true;
    }
    if (shortcut === "delete") {
      event.preventDefault();
      if (selected) remove(selected.id);
      return true;
    }
    return false;
  };

  return {
    available,
    active,
    enter,
    leave,
    engineRef,
    photoKey,
    disabled: params.disabled,
    frame: frameValid ? frame : null,
    masks,
    selected,
    select: setSelectedId,
    kinds,
    max,
    canAdd,
    addBlockedReason,
    whiteBalanceAbsolute,
    overlayVisible,
    setOverlayVisible,
    shapeDragging,
    setShapeDragging,
    settings,
    add,
    duplicate,
    remove,
    toggleEnabled,
    toggleInvert,
    changeAdjust,
    changeFeather,
    changeShape,
    canReset,
    reset,
    handleShortcut,
  };
}

export type BrowserPhotoMaskTool = ReturnType<typeof useBrowserPhotoMasks>;

// ---------------------------------------------------------------------------
// マスクの範囲の重ね表示（赤い面）

/** 面を求める要求（`key` が同じなら同じ面。`target` は写真とマスク。別の target の遅れた応答は捨てる）。 */
export type PhotoEditingMaskPlaneRequest = {
  key: string;
  target: string;
  settings: object;
  maskId: string;
  maxDimension: number;
};

/**
 * 重ね表示の面を取りに行く係（React に依らない）。欲しい面が変わったら次の描画の前（`schedule`。rAF）に 1 回だけ取りに行き、
 * 取りに行っている間に変わったら、終わってから最新の 1 つだけを取りに行く（同時に 1 つ）。応答は、今欲しい面と同じ写真・マスク
 * のもので、出した中で一番新しいものだけを `onPlane` に渡す（古い応答・別のマスクの応答は捨てる。形を動かしている間は、少し前の
 * 面を見せ続ける）。`want(null)` で消す。
 */
export function createPhotoEditingMaskPlaneLoader(deps: {
  request: (request: PhotoEditingMaskPlaneRequest) => Promise<DevelopMaskPlane | null>;
  schedule: (callback: () => void) => () => void;
  onPlane: (plane: DevelopMaskPlane | null) => void;
}) {
  let wanted: PhotoEditingMaskPlaneRequest | null = null;
  let requestedKey: string | null = null;
  let inFlight = false;
  let cancelScheduled: (() => void) | null = null;
  let sequence = 0;
  let shownSequence = 0;
  let shownTarget: string | null = null;
  let disposed = false;

  const flush = () => {
    cancelScheduled = null;
    if (disposed || inFlight || !wanted || wanted.key === requestedKey) return;
    const request = wanted;
    const mine = ++sequence;
    requestedKey = request.key;
    inFlight = true;
    const done = (plane: DevelopMaskPlane | null | undefined) => {
      inFlight = false;
      if (disposed) return;
      // 今欲しい写真・マスクの、出した中で一番新しい応答だけを見せる
      if (plane && wanted && wanted.target === request.target && mine > shownSequence) {
        shownSequence = mine;
        shownTarget = request.target;
        deps.onPlane(plane);
      }
      if (wanted && wanted.key !== requestedKey) schedule();
    };
    deps.request(request).then(done, () => done(null));
  };

  const schedule = () => {
    if (cancelScheduled || disposed) return;
    cancelScheduled = deps.schedule(flush);
  };

  return {
    want(next: PhotoEditingMaskPlaneRequest | null) {
      if (disposed) return;
      if (!next) {
        wanted = null;
        requestedKey = null;
        cancelScheduled?.();
        cancelScheduled = null;
        shownTarget = null;
        shownSequence = sequence;
        deps.onPlane(null);
        return;
      }
      if (shownTarget !== null && shownTarget !== next.target) {
        // 別の写真・マスクに移った: 前の面は見せない
        shownTarget = null;
        shownSequence = sequence;
        deps.onPlane(null);
      }
      wanted = next;
      if (next.key === requestedKey) return;
      schedule();
    },
    dispose() {
      disposed = true;
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}

/** 面の値（0〜255）を、赤の半透明の重ね（`alpha = data / 255 · 0.5`）の RGBA にする。 */
export function fillPhotoEditingMaskOverlay(rgba: Uint8ClampedArray, data: Uint8Array): void {
  for (let index = 0; index < data.length; index += 1) {
    const offset = index * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 48;
    rgba[offset + 2] = 48;
    rgba[offset + 3] = Math.round(data[index]! * 0.5);
  }
}

/** 面の寸法・形を決める値（補正の差分・`enabled` は面を変えないので入れない）。 */
function planeShapeKey(mask: DevelopMask): string {
  const { adjust: _adjust, enabled: _enabled, ...shape } = mask;
  return JSON.stringify(shape);
}

/**
 * 選んでいるマスクの面（重ね表示）。`enabled` の間、選んでいるマスクの形・幾何・寸法が変わるたびに取りに行く（rAF でまとめ、
 * 同時に 1 つ。{@link createPhotoEditingMaskPlaneLoader}）。形を動かしている間は 640px（drag の画と同じ）、離したら画と同じ長辺で
 * 取り直す。面の口の無い wasm では null。
 */
export function useBrowserPhotoMaskPlane(params: {
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
  settings: DevelopSettings;
  mask: DevelopMask | null;
  enabled: boolean;
  dragging: boolean;
}): DevelopMaskPlane | null {
  const { engineRef, photoKey, settings, mask, enabled, dragging } = params;
  const [plane, setPlane] = useState<DevelopMaskPlane | null>(null);
  const loaderRef = useRef<ReturnType<typeof createPhotoEditingMaskPlaneLoader> | null>(null);

  useEffect(() => {
    const loader = createPhotoEditingMaskPlaneLoader({
      request: async (request) => {
        const engine = engineRef.current;
        if (!engine?.maskPlane) return null;
        return engine.maskPlane(request.settings, request.maskId, { maxDimension: request.maxDimension });
      },
      schedule: (callback) => {
        if (typeof requestAnimationFrame !== "function") {
          const timer = setTimeout(callback, 0);
          return () => clearTimeout(timer);
        }
        const frame = requestAnimationFrame(callback);
        return () => cancelAnimationFrame(frame);
      },
      onPlane: setPlane,
    });
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [engineRef]);

  const shapeKey = mask ? planeShapeKey(mask) : null;
  const geometryKey = JSON.stringify(settings.geometry ?? null);
  const maxDimension = dragging ? DEVELOP_COLOR_POINT_DRAG_MAX_DIMENSION : DEVELOP_PREVIEW_MAX_DIMENSION;
  const latestSettingsRef = useRef(settings);
  latestSettingsRef.current = settings;
  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) return;
    if (!enabled || !mask || photoKey === null || shapeKey === null || (mask.kind !== "linear" && mask.kind !== "radial")) {
      loader.want(null);
      return;
    }
    loader.want({
      key: `${photoKey}\n${shapeKey}\n${geometryKey}\n${maxDimension}`,
      target: `${photoKey}\n${mask.id}`,
      settings: latestSettingsRef.current,
      maskId: mask.id,
      maxDimension,
    });
    // 面を変えるのは形・幾何・寸法だけ（補正の差分では取り直さない）
  }, [enabled, geometryKey, mask, maxDimension, photoKey, shapeKey]);

  return enabled ? plane : null;
}
