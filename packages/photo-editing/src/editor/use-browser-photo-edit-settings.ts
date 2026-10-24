"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import {
  developSettingsKey,
  developSettingsVersion,
  isDevelopSettingsVersion,
  neutralDevelopSettings,
  readDevelopSettings,
  resetDevelopSettingsColors,
  sameDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";
import {
  canRedoEditHistory,
  canUndoEditHistory,
  createEditHistory,
  pushEditHistory,
  redoEditHistory,
  undoEditHistory,
  type EditHistory,
} from "../photo-editing-edit-history";
import { usePhotoLibrary } from "../library/photo-library-context";
import type { PhotoLibraryProvisionalDraft } from "../library/photo-library";

import {
  developBaseVersion,
  type BrowserPhotoOperationKind,
  type DevelopSession,
  type OpenedSource,
} from "./browser-photo-editing-model";
import type { PhotoEditingSettingsUpdate, PhotoEditingSliderPhase } from "./photo-editing-adjustment-controls";

const NEUTRAL_SETTINGS = neutralDevelopSettings();

/**
 * ブラウザ版の開いている 1 枚の編集内容（NIHO Photo 段 1 F1 移行元設計）。状態は `developSettings` そのもので、共通の補正パネルの
 * `update` をそのまま当てる。wasm で開いた写真は変えるたびに自動保存へ渡し（800ms まとめる）、S1 の canvas は保存しない
 * （書き出していない補正として数える）。
 *
 * 取り消し・やり直しは写真を 1 枚で見ている間だけ持つ（開いた・一覧から戻ったときに今の編集内容から始め、写真を離れたら捨てる）。
 * 積むのは 1 単位の編集の確定（{@link commitEdit}: スライダーを離した・キーボードで確定した・値を直接入力した・ダブルクリック、
 * 「初期化」）だけで、ドラッグ・キーボードの途中は積まない。
 */
export function useBrowserPhotoEditSettings(params: {
  canEdit: boolean;
  openedRef: MutableRefObject<OpenedSource | null>;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  leavingRef: MutableRefObject<Promise<boolean> | null>;
  developSessionRef: MutableRefObject<DevelopSession | null>;
  setStatus: (status: { kind: "error"; text: string } | null) => void;
  setCompareOriginal: (compare: boolean) => void;
  /**
   * 編集内容がまるごと入れ替わった（開いた・手放した・別の端末の補正を読み直した）・写真を離れた（一覧へ戻った）ときに呼ぶ係
   * （`useBrowserPhotoPresets` が入れる。覚えているプリセットを捨てる）
   */
  editResetHandlerRef?: MutableRefObject<(() => void) | null>;
}) {
  const { canEdit, openedRef, operationRef, leavingRef, developSessionRef, setCompareOriginal, setStatus, editResetHandlerRef } = params;
  const library = usePhotoLibrary();
  const [settings, setSettings] = useState<DevelopSettings>(NEUTRAL_SETTINGS);
  const settingsRef = useRef(settings);
  const settingsKey = useMemo(() => developSettingsKey(settings), [settings]);
  // S1 の canvas で最後に書き出した（か開いた）ときの編集内容（違えば、離れる前に破棄を確かめる）
  const [savedSettingsKey, setSavedSettingsKey] = useState(() => developSettingsKey(NEUTRAL_SETTINGS));
  // スライダーのつまみを動かしている間（段 2 は速い描き方にする）
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<EditHistory<DevelopSettings> | null>(null);
  const historyRef = useRef(history);
  // 「初期化」を押した直後（「初期化しました」と「元に戻す」を出す。次の変更・取り消し・やり直し・写真を離れるまで）
  const [resetDone, setResetDone] = useState(false);

  const replaceHistory = useCallback((next: EditHistory<DevelopSettings> | null) => {
    historyRef.current = next;
    setHistory(next);
  }, []);

  /**
   * 開いた・手放した写真の編集内容に置き換える（保存しない。書き出していない補正としても数えない）。`history` なら取り消しの
   * 履歴をその編集内容から始め、でなければ捨てる。
   */
  const loadSettings = useCallback(
    (next: DevelopSettings, options: { history: boolean }) => {
      settingsRef.current = next;
      setSettings(next);
      setSavedSettingsKey(developSettingsKey(next));
      setDragging(false);
      setResetDone(false);
      replaceHistory(options.history ? createEditHistory(next) : null);
      editResetHandlerRef?.current?.();
    },
    [editResetHandlerRef, replaceHistory],
  );

  /** canonical handoff 時に履歴cursorを保ったまま、全entryを同じcanonical metadataへ結び直す。 */
  const rebaseSettings = useCallback((rebase: (value: DevelopSettings) => DevelopSettings): DevelopSettings => {
    const next = rebase(settingsRef.current);
    settingsRef.current = next;
    setSettings(next);
    setSavedSettingsKey((current) => {
      try {
        const parsed = readDevelopSettings(JSON.parse(current) as unknown);
        return parsed ? developSettingsKey(rebase(parsed)) : current;
      } catch {
        return current;
      }
    });
    const currentHistory = historyRef.current;
    if (currentHistory) {
      replaceHistory({
        past: currentHistory.past.map(rebase),
        present: rebase(currentHistory.present),
        future: currentHistory.future.map(rebase),
      });
    }
    return next;
  }, [replaceHistory]);

  /** 開いたままの写真を 1 枚で見始める（一覧から戻った）。履歴は今の編集内容から始める。 */
  const startHistory = useCallback(() => {
    setResetDone(false);
    replaceHistory(createEditHistory(settingsRef.current));
  }, [replaceHistory]);

  /** 写真を離れる（一覧へ戻る）。履歴と「初期化しました」を捨てる。 */
  const dropHistory = useCallback(() => {
    setResetDone(false);
    replaceHistory(null);
    editResetHandlerRef?.current?.();
  }, [editResetHandlerRef, replaceHistory]);

  /** 切り抜きと補正の道具を切り替えたら、直前の「初期化しました」を残さない。 */
  const clearResetDone = useCallback(() => setResetDone(false), []);

  /** provisional 1 session 専用の直列保存係。flush は最後の入力の失敗を呼び出し側へ返す。 */
  const createProvisionalDraftWriter = useCallback(
    (
      photoId: string,
      contentSha256: string,
      initial: PhotoLibraryProvisionalDraft | null,
    ): NonNullable<DevelopSession["provisionalDraft"]> | undefined => {
      if (!library.saveProvisionalDraft) return undefined;
      let pending = Promise.resolve<PhotoLibraryProvisionalDraft | null>(initial);
      const writer: NonNullable<DevelopSession["provisionalDraft"]> = {
        schedule(next) {
          pending = pending
            .catch(() => null)
            .then(() => library.saveProvisionalDraft!(photoId, contentSha256, next));
          void pending.catch(() => {
            if (developSessionRef.current?.provisionalDraft === writer) {
              setStatus({
                kind: "error",
                text: "未保存の補正をこの端末に退避できません。もう一度操作してください。",
              });
            }
          });
        },
        flush: () => pending,
      };
      return writer;
    },
    [developSessionRef, library, setStatus],
  );

  /** 今の写真を直せるなら返す（閲覧のみ・入力を開けていない・書き出し / 消している途中・離れる処理の途中は直さない）。 */
  const editableOpened = (): OpenedSource | null => {
    const current = openedRef.current;
    if (!canEdit || !current || operationRef.current || leavingRef.current) return null;
    if (current.mode !== "wasm" && !current.decoded) return null;
    return current;
  };

  /** 状態に入れ、補正前の表示をやめる。wasm は写真へ自動保存する（800ms まとめる）。S1 の canvas は保存しない。 */
  const applySettings = (next: DevelopSettings, current: OpenedSource) => {
    const versioned = { ...next, v: developSettingsVersion(next) };
    settingsRef.current = versioned;
    setSettings(versioned);
    setCompareOriginal(false);
    if (current.mode !== "wasm") return;
    const session = developSessionRef.current;
    if (session?.input.kind === "provisional") {
      session.provisionalDraft?.schedule(versioned);
      return;
    }
    session?.saver?.schedule(versioned);
  };

  /**
   * 1 単位の編集を確定する（取り消しの履歴に積む唯一の入口。スライダーの確定と「初期化」。F2/F4 のプリセット・貼り付け・自動も
   * ここを通す）。変わっていれば状態に入れて自動保存に渡し、今の編集内容を履歴に積む（ドラッグの後の確定は、ドラッグで変えた
   * 編集内容を積む）。直せなければ false。
   */
  const commitEdit = (next: DevelopSettings, options: { resetDone?: boolean } = {}): boolean => {
    const current = editableOpened();
    if (!current) return false;
    if (!sameDevelopSettings(next, settingsRef.current)) {
      applySettings(next, current);
      setResetDone(options.resetDone === true);
    }
    const previous = historyRef.current;
    if (previous) {
      const pushed = pushEditHistory(previous, settingsRef.current, sameDevelopSettings);
      if (pushed !== previous) replaceHistory(pushed);
    }
    return true;
  };

  /**
   * 右パネルのスライダーの変更（共通の補正パネルの通知）。`drag` の間は速い描き方にし、`commit` で丁寧に描き直して履歴に積む。
   * 同じ値（離したときの commit・既定値でのダブルクリック）は状態も保存も変えない。
   */
  const changeSettings = (update: PhotoEditingSettingsUpdate, phase: PhotoEditingSliderPhase) => {
    if (phase === "drag") setDragging(true);
    else if (phase === "commit") setDragging(false);
    const current = editableOpened();
    if (!current) return;
    const candidate = update(settingsRef.current);
    if (!isDevelopSettingsVersion(candidate.v)) return;
    // 画面内の項目追加で必要版が上がる。外部データのreaderを緩めず、検証前に既知の版だけ昇格する。
    const updated = readDevelopSettings({ ...candidate, v: Math.max(candidate.v, developSettingsVersion(candidate)) });
    if (!updated) return;
    if (phase === "commit") {
      commitEdit(updated);
      return;
    }
    if (sameDevelopSettings(updated, settingsRef.current)) return;
    applySettings(updated, current);
    setResetDone(false);
  };

  /**
   * 「初期化」。wasm は neutral を保存する（編集内容を消さない。作業コピーの上で直している写真は、その版の neutral）。色だけを戻し、
   * 切り抜き・回転は保つ（F3 移行元設計。移行元設計）。
   */
  const resetSettings = () => {
    const current = editableOpened();
    if (!current) return;
    setDragging(false);
    commitEdit(resetDevelopSettingsColors(settingsRef.current, developBaseVersion(current.input)), { resetDone: true });
  };

  /** 取り消し・やり直しで移った編集内容を状態に入れ、自動保存に渡し、丁寧に描く。 */
  const moveHistory = (moved: EditHistory<DevelopSettings>, current: OpenedSource) => {
    replaceHistory(moved);
    setDragging(false);
    setResetDone(false);
    if (!sameDevelopSettings(moved.present, settingsRef.current)) applySettings(moved.present, current);
  };

  /** 取り消す（確定していない変更があれば、先にそれを 1 単位として積んでから戻す）。 */
  const undo = () => {
    const current = editableOpened();
    const previous = historyRef.current;
    if (!current || !previous) return;
    const committed = pushEditHistory(previous, settingsRef.current, sameDevelopSettings);
    const moved = undoEditHistory(committed);
    if (moved !== committed) moveHistory(moved, current);
  };

  /** やり直す（確定していない変更がある間はやり直さない）。 */
  const redo = () => {
    const current = editableOpened();
    const previous = historyRef.current;
    if (!current || !previous || !sameDevelopSettings(previous.present, settingsRef.current)) return;
    const moved = redoEditHistory(previous);
    if (moved !== previous) moveHistory(moved, current);
  };

  const historyPresentKey = useMemo(() => (history ? developSettingsKey(history.present) : null), [history]);
  const pendingChange = historyPresentKey !== null && historyPresentKey !== settingsKey;
  const canUndo = history !== null && (pendingChange || canUndoEditHistory(history));
  const canRedo = history !== null && !pendingChange && canRedoEditHistory(history);

  // つまみをスライダーの外で離しても、ドラッグを終える（離したら丁寧に描き直す）
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [dragging]);

  return {
    settings,
    settingsRef,
    settingsKey,
    savedSettingsKey,
    setSavedSettingsKey,
    dragging,
    setDragging,
    loadSettings,
    rebaseSettings,
    createProvisionalDraftWriter,
    startHistory,
    dropHistory,
    commitEdit,
    changeSettings,
    resetSettings,
    undo,
    redo,
    canUndo,
    canRedo,
    resetDone,
    clearResetDone,
  };
}

export type BrowserPhotoEditSettings = ReturnType<typeof useBrowserPhotoEditSettings>;
