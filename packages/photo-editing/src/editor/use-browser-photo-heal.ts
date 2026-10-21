"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import type { DevelopHealMode, DevelopHealPoint } from "../develop-engine/develop-heal";
import {
  DEFAULT_HEAL_FEATHER,
  DEFAULT_HEAL_RADIUS,
  addDevelopHealMark,
  canAddDevelopHealMark,
  clearDevelopHeal,
  readDevelopHeal,
  removeDevelopHealMark,
  updateDevelopHealMark,
  type DevelopHealImageSize,
  type DevelopHealMarkPatch,
  type DevelopHealMarkView,
} from "../develop-engine/develop-heal-editing";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import {
  clampHealSource,
  defaultHealSource,
  healMarkFingerprint,
  healStrokePointLimit,
  nextHealMarkId,
  stepHealRadius,
} from "../photo-editing-heal";
import type { PhotoEditingSettings } from "../photo-editing-types";
import {
  isPhotoEditingTypingTarget,
  isWithinPhotoEditingScope,
  type PhotoEditingShortcutKeyEvent,
} from "../use-photo-editing-shortcuts";

import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

/** ブラシの値（次に描く印・選んでいる印の値）。 */
export type BrowserPhotoHealBrush = { mode: DevelopHealMode; radius: number; feather: number };

/** 面が最後に描いた幾何なしの画（写真の key・画の大きさ・その画に入っている印の指紋）。 */
type HealPainted = { key: string; size: DevelopHealImageSize; marks: ReadonlySet<string>; signature: string };

const NO_MARKS: ReadonlySet<string> = new Set();
const DEFAULT_BRUSH: BrowserPhotoHealBrush = { mode: "remove", radius: DEFAULT_HEAL_RADIUS, feather: DEFAULT_HEAL_FEATHER };

/**
 * ブラウザ版の修復の道具（niho-photo#44 後半）の状態。右端の帯の「修復」・右パネルの修復の面・写真の上のブラシに渡す値と、印の確定を
 * 持つ。印は `developSettings.heal` の中なので、確定は `commitEdit`（取り消しの 1 単位。自動保存・↶ ↷ はそこに任せる）。
 *
 * - 出す条件（`available`）: PC の面（`allowed`。閲覧のみでない）・wasm で開いた写真を 1 枚で見ている・段階 open の仮の入力でない・
 *   wasm が印を描ける（`supportsHeal`。古い wasm には道具を出さない）
 * - 道具の間（`active`）は、面が幾何を全部外した画を描く（`healFrameDevelopSettings`。ポインタの位置 = 印の座標）。描いた画は
 *   {@link framePainted} で受け取り、その画に入っている印（指紋）を覚える（`ready` = 幾何なしの画が出ている。それまでブラシは受けない）
 * - なぞって離したら `addMark`（1 回の確定）。新しい印を選ぶ。「写す」は写し元を決めて渡す（`defaultHealSource`）
 * - 選んでいる印があれば、モード・大きさ・ぼかしはその印の値を直接動かし（`changeSettings` の drag / commit）、次に描く印の値も同じに
 *   する（Lightroom と同じく、ブラシの値は 1 つ）。選んでいなければ次に描く印の値だけ（画面の中の状態）
 * - 写真を替えた・出す条件を満たさなくなった・編集内容がまるごと入れ替わった・写真を離れたら道具を閉じる（「補正」に戻る）
 */
export function useBrowserPhotoHeal(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** PC の面で直せる（スマホの層・閲覧のみは false） */
  allowed: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  /** 段階 open の仮の入力を見ている（正式な入力に替わるまで道具を出さない） */
  provisional: boolean;
  settings: DevelopSettings;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 取り消しの 1 単位として編集内容を確定する（直せなければ false） */
  commitEdit: (next: DevelopSettings) => boolean;
  /** 補正のスライダーと同じ変更の口（`drag` は履歴に積まず描き直し、`commit` で 1 単位に確定する） */
  changeSettings: (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => void;
  setCompareOriginal: (compare: boolean) => void;
  /** 編集内容がまるごと入れ替わった・写真を離れたときに呼ばれる係を入れる先 */
  editResetHandlerRef: MutableRefObject<(() => void) | null>;
}) {
  const { mountedRef, engineRef, allowed, photoKey, provisional, settings, settingsRef } = params;
  const { commitEdit, changeSettings, setCompareOriginal } = params;
  /** wasm が印を描けるか（確かめるまで null） */
  const [supported, setSupported] = useState<boolean | null>(null);
  const wanted = allowed && photoKey !== null;
  useEffect(() => {
    if (!wanted || supported !== null) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    // 確かめられない engine（口の無い差し替え）は、使えない扱い（編集は止めない）
    void Promise.resolve()
      .then(() => engine.supportsHeal())
      .then(
        (value) => {
          if (!cancelled && mountedRef.current) setSupported(value === true);
        },
        () => {
          if (!cancelled && mountedRef.current) setSupported(false);
        },
      );
    return () => {
      cancelled = true;
    };
    // 写真が替わっても（`photoKey`）、まだ確かめていなければ確かめる
  }, [engineRef, mountedRef, photoKey, supported, wanted]);

  const available = wanted && !provisional && supported === true;
  /** 道具を開いている写真（開いていなければ null） */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const active = available && activeKey !== null && activeKey === photoKey;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 次に描く印の値（写真を替えても保つ） */
  const [brush, setBrush] = useState<BrowserPhotoHealBrush>(DEFAULT_BRUSH);
  /** 印を写真に重ねて見せる（`O` で切り替える） */
  const [showMarks, setShowMarks] = useState(true);
  const [painted, setPainted] = useState<HealPainted | null>(null);

  const marks = useMemo(() => readDevelopHeal(settings), [settings]);
  const selected: DevelopHealMarkView | null = active ? (marks.find((mark) => mark.id === selectedId) ?? null) : null;
  useEffect(() => {
    if (!selected) return;
    setBrush((current) =>
      current.mode === selected.mode && current.radius === selected.radius && current.feather === selected.feather
        ? current
        : { mode: selected.mode, radius: selected.radius, feather: selected.feather },
    );
  }, [selected?.feather, selected?.mode, selected?.radius]);
  const ready = active && painted !== null && painted.key === photoKey;
  const paintedSize = ready && painted ? painted.size : null;

  const latestRef = useRef({ available, active, photoKey, selected, brush, paintedSize });
  latestRef.current = { available, active, photoKey, selected, brush, paintedSize };

  const enter = () => {
    const { available: canEnter, photoKey: key } = latestRef.current;
    if (!canEnter || key === null) return;
    setCompareOriginal(false);
    setPainted(null);
    setSelectedId(null);
    setActiveKey(key);
  };
  const leave = () => {
    setActiveKey(null);
    setSelectedId(null);
    setPainted(null);
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  // 編集内容がまるごと入れ替わった・写真を離れた
  params.editResetHandlerRef.current = leave;
  // 写真を替えた・出す条件を満たさなくなったら閉じる
  const stale = activeKey !== null && !active;
  useEffect(() => {
    if (stale) leaveRef.current();
  }, [stale]);

  /** 面が幾何なしの画を描いた（その画の大きさと、入っている印を覚える。同じなら state を替えない）。 */
  const framePainted = useCallback(
    (key: string, frame: { width: number; height: number }, frameSettings: DevelopSettings) => {
      const fingerprints = readDevelopHeal(frameSettings).map(healMarkFingerprint);
      const signature = `${key}\n${frame.width}x${frame.height}\n${fingerprints.join("\n")}`;
      setPainted((current) =>
        current?.signature === signature
          ? current
          : { key, size: { width: frame.width, height: frame.height }, marks: new Set(fingerprints), signature },
      );
    },
    [],
  );

  /** 選んでいる印を `patch` で直す（`drag` は描き直すだけ、`commit` で 1 単位）。 */
  const changeMark = (id: string, patch: DevelopHealMarkPatch, phase: PhotoEditingSliderPhase) => {
    changeSettings(
      (current) => updateDevelopHealMark(current as DevelopSettings, id, patch) as PhotoEditingSettings,
      phase,
    );
  };

  /** なぞった点で新しい印を足す（1 回の確定）。足せたら、その印を選ぶ。 */
  const addMark = (points: readonly DevelopHealPoint[], size: DevelopHealImageSize | null) => {
    if (!latestRef.current.active || points.length === 0) return false;
    const current = settingsRef.current;
    if (!canAddDevelopHealMark(current)) return false;
    const { mode, radius, feather } = latestRef.current.brush;
    const id = nextHealMarkId(current);
    const next = addDevelopHealMark(current, {
      id,
      mode,
      radius,
      feather,
      points,
      source: mode === "clone" ? defaultHealSource(points, radius, size ?? latestRef.current.paintedSize) : null,
    });
    if (next === current || !commitEdit(next)) return false;
    setSelectedId(id);
    return true;
  };

  const remove = (id: string) => {
    const current = settingsRef.current;
    const next = removeDevelopHealMark(current, id);
    if (next === current || !commitEdit(next)) return;
    setSelectedId((value) => (value === id ? null : value));
  };

  const removeSelected = () => {
    const target = latestRef.current.selected;
    if (target) remove(target.id);
  };

  const clear = () => {
    const current = settingsRef.current;
    const next = clearDevelopHeal(current);
    if (next !== current) commitEdit(next);
    setSelectedId(null);
  };

  const setMode = (mode: DevelopHealMode) => {
    setBrush((current) => (current.mode === mode ? current : { ...current, mode }));
    const target = latestRef.current.selected;
    if (!target || target.mode === mode) return;
    const patch: DevelopHealMarkPatch = { mode };
    // 写し元の無い印を「写す」にするときは、写し元を決めて渡す（エンジンに選ばせない。つまみで動かせる）
    if (mode === "clone" && target.source === null) {
      patch.source = defaultHealSource(target.points, target.radius, latestRef.current.paintedSize);
    }
    changeMark(target.id, patch, "commit");
  };

  const setRadius = (radius: number, phase: PhotoEditingSliderPhase) => {
    if (!Number.isFinite(radius)) return;
    setBrush((current) => (current.radius === radius ? current : { ...current, radius }));
    const target = latestRef.current.selected;
    if (target) {
      const patch: DevelopHealMarkPatch = { radius };
      if (target.mode === "clone" && target.source !== null) {
        patch.source = clampHealSource(target.points, radius, target.source, latestRef.current.paintedSize);
      }
      changeMark(target.id, patch, phase);
    }
  };

  const setFeather = (feather: number, phase: PhotoEditingSliderPhase) => {
    if (!Number.isFinite(feather)) return;
    setBrush((current) => (current.feather === feather ? current : { ...current, feather }));
    const target = latestRef.current.selected;
    if (target) changeMark(target.id, { feather }, phase);
  };

  /** `[`（-1）・`]`（+1）: ブラシを 1 段小さく / 大きく（選んでいる印があればその印も）。 */
  const stepRadius = (direction: -1 | 1) => {
    const base = latestRef.current.selected?.radius ?? latestRef.current.brush.radius;
    setRadius(stepHealRadius(base, direction), "commit");
  };

  const changeSource = (id: string, source: DevelopHealPoint, phase: PhotoEditingSliderPhase) => {
    changeMark(id, { source }, phase);
  };

  const shownBrush: BrowserPhotoHealBrush = selected
    ? { mode: selected.mode, radius: selected.radius, feather: selected.feather }
    : brush;
  // 番号は描いた順（一覧と同じ）
  const selectedOrder = selected ? marks.findIndex((mark) => mark.id === selected.id) + 1 : null;

  return {
    /** 右端の帯に「修復」を出す */
    available,
    /** 修復の道具を開いている */
    active,
    /** 幾何なしの画が出ている（ブラシを受けてよい） */
    ready,
    /** 描いた順の印（見せる値） */
    marks,
    /** 選んでいる印（無ければ null） */
    selectedId: selected?.id ?? null,
    selectedOrder,
    /** 右パネルに見せる値（選んでいる印があればその値） */
    brush: shownBrush,
    /** 次に描く印の値（写真の上のブラシの輪） */
    newBrush: brush,
    showMarks,
    /** 面が最後に描いた画に入っている印の指紋（入っていない印 = まだ埋まっていない） */
    paintedMarks: ready && painted ? painted.marks : NO_MARKS,
    /** もう 1 つ印を足せる */
    canAdd: canAddDevelopHealMark(settings),
    /** 新しく描く印に使える点の数（足せなければ 0） */
    pointLimit: healStrokePointLimit(settings),
    enter,
    leave,
    select: (id: string | null) => {
      const target = id === null ? null : marks.find((mark) => mark.id === id) ?? null;
      setSelectedId(target?.id ?? null);
      if (target) setBrush({ mode: target.mode, radius: target.radius, feather: target.feather });
    },
    addMark,
    remove,
    removeSelected,
    clear,
    setMode,
    setRadius,
    setFeather,
    stepRadius,
    changeSource,
    setShowMarks,
    toggleShowMarks: () => setShowMarks((value) => !value),
    framePainted,
  };
}

export type BrowserPhotoHeal = ReturnType<typeof useBrowserPhotoHeal>;

/** 修復の道具の間のキー（`[` = 小さく、`]` = 大きく、`O` = 印の表示）。 */
export type BrowserPhotoHealKey = "smaller" | "larger" | "marks";

/**
 * 押されたキーが修復の道具のどのキーか（扱わなければ null）。文字を打つ欄・IME の変換中・ほかの処理が使ったキー・⌘ ⌃ ⌥ つきは
 * 扱わない（⌘Z などは今までどおり）。`O` は Shift なしだけ。
 */
export function resolveBrowserPhotoHealKey(
  event: PhotoEditingShortcutKeyEvent,
  target: { typing: boolean },
): BrowserPhotoHealKey | null {
  if (event.defaultPrevented || event.isComposing || target.typing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "[") return "smaller";
  if (event.key === "]") return "larger";
  if ((event.key === "o" || event.key === "O") && !event.shiftKey) return "marks";
  return null;
}

/**
 * 修復の道具の間だけ `[` `]` `O` を聞く（document の keydown。画面の中か、どこにもフォーカスが無いときだけ）。押しっぱなしの
 * 繰り返しは扱わない（大きさの 1 段ごとに確定するため）。Delete・Esc は画面のキー（`usePhotoEditingShortcuts`）が修復の間だけ
 * 印の削除・選択の解除に読み替える。
 */
export function useBrowserPhotoHealKeys(options: {
  rootRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  onKey: (key: BrowserPhotoHealKey) => void;
}): void {
  const { rootRef, enabled } = options;
  const onKeyRef = useRef(options.onKey);
  onKeyRef.current = options.onKey;
  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || !isWithinPhotoEditingScope(root, event.target)) return;
      const key = resolveBrowserPhotoHealKey(event, { typing: isPhotoEditingTypingTarget(event.target) });
      if (key === null) return;
      event.preventDefault();
      if (event.repeat) return;
      onKeyRef.current(key);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, rootRef]);
}
