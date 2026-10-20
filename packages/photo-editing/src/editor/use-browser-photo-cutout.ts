"use client";

import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import type { BrowserPhotoCutoutExport } from "../browser-photo-cutout-export";
import { hasDevelopGeometry, type DevelopSettings } from "../develop-engine/develop-settings";
import {
  CUTOUT_BRUSH_RADIUS_DEFAULT,
  CUTOUT_BRUSH_RADIUS_MAX,
  CUTOUT_BRUSH_RADIUS_MIN,
  addCutoutStroke,
  applyCutoutStrokes,
  createCutoutRecipe,
  cutoutFailureCode,
  cutoutMaskAlphaRgba,
  cutoutMaskSha256,
  decodeCutoutMaskPng,
  downscaleCutoutMask,
  readCutoutDetection,
  readCutoutRecipe,
  sameCutoutRecipe,
  selectCutoutSubject,
  selectedCutoutSubject,
  setCutoutBackground,
  type CutoutBackground,
  type CutoutBrushMode,
  type CutoutBrushStroke,
  type CutoutMask,
  type CutoutPoint,
  type CutoutRecipe,
  type CutoutSelection,
  type PhotoEditingCutoutHost,
} from "../photo-cutout";
import {
  PHOTO_EDITING_CUTOUT_SAVE_FAILED_TEXT,
  photoEditingCutoutFailureText,
} from "../photo-editing-copy";
import {
  canRedoEditHistory,
  canUndoEditHistory,
  createEditHistory,
  pushEditHistory,
  redoEditHistory,
  undoEditHistory,
  type EditHistory,
} from "../photo-editing-edit-history";

import { DEVELOP_PREVIEW_MAX_DIMENSION, type FooterStatus } from "./browser-photo-editing-model";

/** 開いている写真の背景除去（読み終えるまで `loaded` は false。取り消しの履歴は写真ごと）。 */
type CutoutPhotoState = {
  key: string;
  loaded: boolean;
  history: EditHistory<CutoutRecipe | null>;
};

/** プレビューの大きさに縮めたマスク（読めなかったら `mask` は null）。 */
type PreviewMaskState = { sha: string; mask: CutoutMask | null };

/** 確定したブラシを塗ったプレビューのマスク（`strokes` は塗った分。同じ参照の先頭が続く間は足りない分だけ塗り足す）。 */
type CommittedMask = { mask: CutoutMask; strokes: readonly CutoutBrushStroke[]; pixels: Uint8Array };

/** 重ねる alpha の画を作った元（同じなら作り直さない）。 */
type AlphaSource = { pixels: Uint8Array; live: CutoutBrushStroke | null };

export type BrowserPhotoCutoutBrush = { mode: CutoutBrushMode; radius: number };

/** 読んで縮めたマスクを覚えておく数（被写体を選び直して戻るときに読み直さない）。 */
const PREVIEW_MASK_CACHE_LIMIT = 2;
/** canvas の縦横比がマスクとこれ以上違えば重ねない（別の枠の画）。 */
const ASPECT_TOLERANCE = 0.01;

function isSaveFailedStatus(status: FooterStatus | null): boolean {
  return status?.kind === "error" && status.text === PHOTO_EDITING_CUTOUT_SAVE_FAILED_TEXT;
}

function isAbortError(error: unknown): boolean {
  return cutoutFailureCode(error) === "aborted";
}

/** 背景の塗り（透明は塗らない）。白は sidecar の `white` と同じ 255 の白。 */
function backgroundFill(background: CutoutBackground): string | null {
  if (background.kind === "transparent") return null;
  return background.kind === "white" ? "#ffffff" : background.color;
}

function clampBrushRadius(radius: number): number {
  return Math.min(CUTOUT_BRUSH_RADIUS_MAX, Math.max(CUTOUT_BRUSH_RADIUS_MIN, radius));
}

function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(callback, 16);
  return () => clearTimeout(handle);
}

/**
 * ブラウザ版の編集面の背景除去の道具（NIHO camera だけ。`capabilities.cutout`。C4 移行元設計）の状態。右パネルの切り替えの
 * 「背景除去」・道具の部品と写真の上のブラシに渡す値・確定と保存・プレビューへの重ね方を持つ。
 *
 * - 入口を出す条件（`available`）: camera が口（`host`）を渡した・1024px 以上・wasm で開いた写真を 1 枚で見ている。web は口を
 *   渡さないので、道具も重ねる係も出さない
 * - 写真を開くたびに保存したレシピを読む（`host.loadRecipe`。世代番号で古い答えを捨てる）。取り消しの履歴は写真ごとの
 *   `EditHistory<CutoutRecipe | null>` で、補正（`developSettings`）の履歴とは別。確定の 1 単位（推論の結果・被写体・背景・ブラシの
 *   1 ストローク・外す）ごとに積んで `host.saveRecipe` で保存し、取り消し・やり直しも保存する（送る順に並べる）。保存の失敗は
 *   状態欄に 1 行（次に保存できたら消す）。送り終えていない保存がある間は `saving`（閉じる前の確かめに含める）で、離れる前は
 *   `flush` が送り終えるのを待つ（失敗が残っていれば 1 回だけ送り直す。保存できなければ false）
 * - 「背景を除去」は `host.detect` を 1 回だけ回す（押している間は二度押せない。「やめる」で止め、止めたときは何も出さない）。
 *   失敗は sidecar の error ごとの 1 行（`photoEditingCutoutFailureText`）。推論の間に押せなくなった（閲覧のみに変わった・
 *   書き出しや離れる処理が始まった）なら、答えは確定せず捨てる（開始時の確認だけでは足りない）
 * - プレビュー: 選んだ被写体のマスクを読み（`host.readMask` → PNG の SHA-256 をレシピの `maskSHA256` と照合する → PNG を数のまま
 *   読む → 段 2 の長辺に縮める。中身の SHA-256 で覚える。同じ寸法でも別の中身なら当てない = 原寸の sidecar の照合と同じ）、
 *   確定したブラシと動かしている途中のブラシ（`setLiveStroke`。描き直しは 1 フレームに 1 回）を塗って、alpha の画にしておく。
 *   面が wasm の画を描くたびに `applyToCanvas` が重ねる（`destination-in` で切り抜き、白・色は後ろに敷く）。マスクを読めなければ
 *   1 行を出し、重ねずに描く
 * - 背景除去と切り抜き・回転は同時に使わない（spec Decisions）: 幾何のある写真（`blockedByGeometry`）は重ねず、道具には理由だけを
 *   出す。canvas の縦横比がマスクと 1% を超えて違う画にも重ねない
 * - 写真を離れた・出す条件を満たさなくなったら、道具を閉じ（`active`）、回している推論を止める
 * - 書き出し（`exportable`）: 写真に重ねている間だけ、レシピ・選んだ被写体・原寸のマスクの読み口・camera の原寸の書き出しの口を
 *   渡す（書き出すのシートが PNG を足し、JPEG / PNG に背景除去を当てる。`useBrowserPhotoExportAndDelete` の `runExport`）
 */
export function useBrowserPhotoCutout(params: {
  mountedRef: MutableRefObject<boolean>;
  /** NIHO camera の背景除去の口（web は渡さない） */
  host?: PhotoEditingCutoutHost;
  /** 1024px 以上（PC の面。camera にスマホの面は無い） */
  wide: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null） */
  photoKey: string | null;
  settings: DevelopSettings;
  /** 押せない（閲覧のみ・入力を開けていない・書き出し / 消している途中・離れる処理・読み直しの途中） */
  disabled: boolean;
  setStatus: Dispatch<SetStateAction<FooterStatus | null>>;
  /** 最後に描いた画を描き直して重ね直す（`useBrowserPhotoOpen` の `repaintLastFrame`） */
  repaint: () => void;
}) {
  const { mountedRef, wide, photoKey, settings, disabled, setStatus } = params;
  // 口は camera が 1 回渡すもの（入れ物が替わっても読み直さない）。web は渡さない
  const hasHost = params.host !== undefined;
  const hostRef = useRef(params.host);
  hostRef.current = params.host;
  const available = hasHost && wide && photoKey !== null;
  const enabledKey = available ? photoKey : null;
  const blockedByGeometry = hasDevelopGeometry(settings);

  const [photoState, setPhotoState] = useState<CutoutPhotoState | null>(null);
  const photoStateRef = useRef<CutoutPhotoState | null>(null);
  /** 道具を開いている写真（開いていなければ null） */
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  /** 推論・読み込みの失敗の 1 行（マスクを読めなかったときの 1 行は下で導く） */
  const [failure, setFailure] = useState<string | null>(null);
  const [brush, setBrush] = useState<BrowserPhotoCutoutBrush>({ mode: "erase", radius: CUTOUT_BRUSH_RADIUS_DEFAULT });
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const [previewMask, setPreviewMask] = useState<PreviewMaskState | null>(null);
  /** 推論をやり直した回数（読めなかったマスクを、同じ名前でも読み直す） */
  const [maskEpoch, setMaskEpoch] = useState(0);
  /** 写真の世代（開き直した・離れたら進め、遅れて届いた読み込み・推論の答えを捨てる） */
  const generationRef = useRef(0);
  /** 推論の世代（「やめる」で進め、止まりきらなかった答えを捨てる） */
  const runGenerationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const maskCacheRef = useRef(new Map<string, CutoutMask>());
  const committedMaskRef = useRef<CommittedMask | null>(null);
  const alphaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const alphaSourceRef = useRef<AlphaSource | null>(null);
  /** ポインタを押している間のブラシ（離したら null） */
  const liveRef = useRef<CutoutBrushStroke | null>(null);
  const cancelFrameRef = useRef<(() => void) | null>(null);
  /** 保存を送った順に並べる（後の保存が先に終わって古いレシピが残らないように） */
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  /** 送り終えていない保存の数（`saving` はこれが 0 でない間） */
  const pendingSavesRef = useRef(0);
  const [saving, setSaving] = useState(false);
  /** 最後に失敗した保存（同じ写真の後の保存が成功したら消す。`flush` が 1 回だけ送り直す） */
  const failedSaveRef = useRef<{ key: string; recipe: CutoutRecipe | null } | null>(null);
  const repaintRef = useRef(params.repaint);
  repaintRef.current = params.repaint;

  const replacePhotoState = (next: CutoutPhotoState | null) => {
    photoStateRef.current = next;
    setPhotoState(next);
  };
  const setRunningState = (next: boolean) => {
    runningRef.current = next;
    setRunning(next);
  };

  const current = photoState !== null && photoState.key === enabledKey ? photoState : null;
  const loaded = current?.loaded === true;
  const recipe = current?.history.present ?? null;
  const subject = recipe ? selectedCutoutSubject(recipe) : null;
  const maskSha = subject?.maskSHA256 ?? null;
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  // 読んで縮めたマスク（覚えている被写体に選び直したら、読み終えるのを待たずにすぐ使う）
  const mask =
    maskSha === null
      ? null
      : previewMask?.sha === maskSha
        ? previewMask.mask
        : (maskCacheRef.current.get(maskSha) ?? null);
  const maskFailed = maskSha !== null && previewMask?.sha === maskSha && previewMask.mask === null;
  /** マスクを読んでいる途中（前の画のまま待つ） */
  const maskPending = maskSha !== null && mask === null && !maskFailed;
  /** 写真に重ねている（重ねる係が alpha を当てる） */
  const composited = recipe !== null && mask !== null && !blockedByGeometry;
  const active = available && activeKey !== null && activeKey === photoKey;

  const latestRef = useRef({ enabledKey, recipe, mask, blockedByGeometry, disabled, loaded });
  latestRef.current = { enabledKey, recipe, mask, blockedByGeometry, disabled, loaded };

  // 写真を開いた・替えた・離れた: 前の写真の道具・推論・失敗の 1 行を捨て、保存したレシピを読む
  useEffect(() => {
    if (!hasHost) return;
    const generation = ++generationRef.current;
    runGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunningState(false);
    setFailure(null);
    setActiveKey(null);
    liveRef.current = null;
    const host = hostRef.current;
    if (!host || enabledKey === null) {
      replacePhotoState(null);
      return;
    }
    const key = enabledKey;
    replacePhotoState({ key, loaded: false, history: createEditHistory(null) });
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    void Promise.resolve()
      .then(() => host.loadRecipe(key))
      .then(
        (value) => {
          if (!isCurrent()) return;
          // 口の答えも形を確かめる（版や形が違えば背景除去なしで開く）
          replacePhotoState({ key, loaded: true, history: createEditHistory(readCutoutRecipe(value)) });
        },
        () => {
          if (!isCurrent()) return;
          replacePhotoState({ key, loaded: true, history: createEditHistory(null) });
          setFailure(photoEditingCutoutFailureText("corrupt_mask"));
        },
      );
    // `mountedRef` は面が開いている間同じ
  }, [enabledKey, hasHost, mountedRef]);

  // 閉じるときは推論と描き直しの予約を止める
  useEffect(
    () => () => {
      abortRef.current?.abort();
      cancelFrameRef.current?.();
    },
    [],
  );

  // 選んだ被写体のマスクを読んで、プレビューの大きさに縮める（中身の SHA-256 で覚える）
  useEffect(() => {
    const target = subjectRef.current;
    const host = hostRef.current;
    if (!host || enabledKey === null || maskSha === null || !target) return;
    if (maskCacheRef.current.has(maskSha)) return;
    let cancelled = false;
    const sha = maskSha;
    void Promise.resolve()
      .then(() => host.readMask(enabledKey, target))
      .then(async (bytes) => {
        // レシピの SHA-256 と同じ中身かを、読む前に確かめる（置き換わった・壊れたマスクをキャッシュしない）
        if ((await cutoutMaskSha256(bytes)) !== sha) throw new Error("cutout mask: sha256 mismatch");
        return decodeCutoutMaskPng(bytes);
      })
      .then((decoded) => {
        if (cancelled || !mountedRef.current) return;
        // detect の答えと違う寸法のマスクは当てない（別の写真のマスク）
        if (decoded.width !== target.maskWidth || decoded.height !== target.maskHeight) throw new Error("cutout mask: size mismatch");
        const scale = Math.min(1, DEVELOP_PREVIEW_MAX_DIMENSION / Math.max(decoded.width, decoded.height));
        const preview = downscaleCutoutMask(decoded, decoded.width * scale, decoded.height * scale);
        const cache = maskCacheRef.current;
        cache.delete(sha);
        cache.set(sha, preview);
        while (cache.size > PREVIEW_MASK_CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
        setPreviewMask({ sha, mask: preview });
      })
      .catch(() => {
        if (cancelled || !mountedRef.current) return;
        setPreviewMask({ sha, mask: null });
      });
    return () => {
      cancelled = true;
    };
    // `maskEpoch`: 推論をやり直したら、読めなかったマスクも読み直す
  }, [enabledKey, maskEpoch, maskSha, mountedRef]);

  // 重ねる中身（被写体・背景・ブラシ・重ねるか）が変わったら、最後の画を描き直す（wasm には描かせない）。マスクを読んでいる
  // 途中は前の画のまま待つ
  const compositeSignature = composited && recipe ? recipe : null;
  const lastSignatureRef = useRef<CutoutRecipe | null>(null);
  useEffect(() => {
    if (maskPending || lastSignatureRef.current === compositeSignature) return;
    lastSignatureRef.current = compositeSignature;
    repaintRef.current();
  }, [compositeSignature, maskPending]);

  /** 確定したブラシを塗ったプレビューのマスク（足したストロークの分だけ塗り足す）。 */
  const committedPixels = (target: CutoutMask, strokes: readonly CutoutBrushStroke[]): Uint8Array => {
    const cached = committedMaskRef.current;
    if (cached && cached.mask === target) {
      if (cached.strokes === strokes) return cached.pixels;
      const prefix = cached.strokes.length <= strokes.length && cached.strokes.every((stroke, index) => strokes[index] === stroke);
      if (prefix) {
        const pixels = applyCutoutStrokes(cached.pixels, target.width, target.height, strokes.slice(cached.strokes.length));
        committedMaskRef.current = { mask: target, strokes, pixels };
        return pixels;
      }
    }
    const pixels = applyCutoutStrokes(target.pixels, target.width, target.height, strokes);
    committedMaskRef.current = { mask: target, strokes, pixels };
    return pixels;
  };

  /** 重ねる alpha の画（確定したブラシ＋動かしている途中のブラシ）。2D の context が無ければ null。 */
  const alphaCanvas = (target: CutoutMask, strokes: readonly CutoutBrushStroke[]): HTMLCanvasElement | null => {
    const committed = committedPixels(target, strokes);
    const live = liveRef.current;
    const source = alphaSourceRef.current;
    const existing = alphaCanvasRef.current;
    if (existing && source && source.pixels === committed && source.live === live) return existing;
    const pixels = live ? applyCutoutStrokes(committed, target.width, target.height, [live]) : committed;
    const canvas = existing ?? document.createElement("canvas");
    alphaCanvasRef.current = canvas;
    if (canvas.width !== target.width) canvas.width = target.width;
    if (canvas.height !== target.height) canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.putImageData(
      new ImageData(cutoutMaskAlphaRgba({ width: target.width, height: target.height, pixels }), target.width, target.height),
      0,
      0,
    );
    alphaSourceRef.current = { pixels: committed, live };
    return canvas;
  };

  /**
   * 面が wasm の画を canvas に描いた直後に呼ぶ: レシピがあり・マスクを読めて・幾何が恒等で・canvas の縦横比がマスクと合えば、
   * 被写体の外を透明にし（`destination-in`）、白・色の背景はその後ろに敷く（`destination-over`）。
   */
  const applyToCanvas = (canvas: HTMLCanvasElement) => {
    const latest = latestRef.current;
    if (latest.enabledKey === null || !latest.recipe || !latest.mask || latest.blockedByGeometry) return;
    if (canvas.width === 0 || canvas.height === 0) return;
    const { detection } = latest.recipe;
    if (Math.abs(canvas.width / canvas.height / (detection.width / detection.height) - 1) > ASPECT_TOLERANCE) return;
    const alpha = alphaCanvas(latest.mask, latest.recipe.strokes);
    const context = canvas.getContext("2d");
    if (!alpha || !context) return;
    context.globalCompositeOperation = "destination-in";
    context.drawImage(alpha, 0, 0, canvas.width, canvas.height);
    const fill = backgroundFill(latest.recipe.background);
    if (fill) {
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = fill;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.globalCompositeOperation = "source-over";
  };

  /**
   * 今の写真のレシピを保存する（送った順に）。失敗は状態欄に 1 行、次に保存できたら消す。送り終えるまでは `saving`（閉じる前の
   * 確かめ）で、失敗は同じ写真の後の保存が成功するまで覚えておく（`flush` が送り直す）。
   */
  const save = (key: string, next: CutoutRecipe | null) => {
    const host = hostRef.current;
    if (!host) return;
    const send = () => host.saveRecipe(key, next);
    pendingSavesRef.current += 1;
    if (mountedRef.current) setSaving(true);
    const settle = () => {
      pendingSavesRef.current -= 1;
      if (mountedRef.current && pendingSavesRef.current === 0) setSaving(false);
    };
    saveChainRef.current = saveChainRef.current.then(send, send).then(
      () => {
        settle();
        if (failedSaveRef.current?.key === key) failedSaveRef.current = null;
        if (mountedRef.current) setStatus((status) => (isSaveFailedStatus(status) ? null : status));
      },
      () => {
        settle();
        failedSaveRef.current = { key, recipe: next };
        if (mountedRef.current) setStatus({ kind: "error", text: PHOTO_EDITING_CUTOUT_SAVE_FAILED_TEXT });
      },
    );
  };

  /**
   * 送り終えていない保存を待つ（画面を離れる前）。失敗した保存が残っていれば 1 回だけ送り直す。全部保存できたら true、できなければ
   * false（離れない。状態欄に失敗が出ている。離れようとするたびに送り直す）。
   */
  const flush = async (): Promise<boolean> => {
    await saveChainRef.current;
    const failed = failedSaveRef.current;
    if (!failed) return true;
    save(failed.key, failed.recipe);
    await saveChainRef.current;
    return failedSaveRef.current === null;
  };

  /** 履歴を替えて、今の値を保存する（変わらなければ何もしない）。 */
  const replaceHistory = (update: (history: EditHistory<CutoutRecipe | null>) => EditHistory<CutoutRecipe | null>) => {
    const state = photoStateRef.current;
    if (!state || !state.loaded || state.key !== latestRef.current.enabledKey) return;
    const history = update(state.history);
    if (history === state.history) return;
    replacePhotoState({ ...state, history });
    save(state.key, history.present);
  };

  /** 1 単位の編集を確定する（取り消しの 1 単位。同じレシピなら何もしない）。 */
  const commit = (next: CutoutRecipe | null) => {
    replaceHistory((history) => pushEditHistory(history, next, sameCutoutRecipe));
  };

  const canEdit = () => available && !latestRef.current.disabled && latestRef.current.loaded && !runningRef.current;

  const editRecipe = (edit: (recipe: CutoutRecipe) => CutoutRecipe) => {
    const present = photoStateRef.current?.history.present ?? null;
    if (!canEdit() || !present) return;
    commit(edit(present));
  };

  /** 「背景を除去」: 推論を 1 回回し、結果を最大の被写体・透明・ブラシなしのレシピとして確定する。 */
  const run = () => {
    const host = hostRef.current;
    const key = latestRef.current.enabledKey;
    if (!host || key === null || !canEdit() || latestRef.current.blockedByGeometry) return;
    const generation = generationRef.current;
    const runGeneration = ++runGenerationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setFailure(null);
    setRunningState(true);
    const isCurrent = () =>
      mountedRef.current && generation === generationRef.current && runGeneration === runGenerationRef.current;
    void Promise.resolve()
      .then(() => host.detect(key, controller.signal))
      .then(
        (value) => {
          if (!isCurrent()) return;
          abortRef.current = null;
          setRunningState(false);
          // 推論の間に押せなくなった（閲覧のみに変わった・書き出しや離れる処理が始まった）なら確定しない（写真と世代は上で確かめた）
          if (latestRef.current.disabled) return;
          const detection = readCutoutDetection(value);
          if (!detection) {
            setFailure(photoEditingCutoutFailureText("internal_error"));
            return;
          }
          commit(createCutoutRecipe(detection));
          // 推論はマスクを書き直すので、読めなかったマスクも読み直す
          setPreviewMask((value) => (value && value.mask === null ? null : value));
          setMaskEpoch((value) => value + 1);
        },
        (error: unknown) => {
          if (!isCurrent()) return;
          abortRef.current = null;
          setRunningState(false);
          if (controller.signal.aborted || isAbortError(error)) return;
          setFailure(photoEditingCutoutFailureText(cutoutFailureCode(error)));
        },
      );
  };

  /** 「やめる」: 回している推論を止める（何も出さない）。 */
  const cancel = () => {
    if (!runningRef.current) return;
    runGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setRunningState(false);
  };

  const undo = () => {
    if (!canEdit()) return;
    replaceHistory(undoEditHistory);
  };
  const redo = () => {
    if (!canEdit()) return;
    replaceHistory(redoEditHistory);
  };

  /** 動かしている途中のブラシ（null で捨てる）。描き直しは 1 フレームに 1 回。 */
  const setLiveStroke = (points: CutoutPoint[] | null) => {
    const { mode, radius } = brushRef.current;
    liveRef.current = points && points.length > 0 ? { mode, radius, points } : null;
    if (cancelFrameRef.current) return;
    cancelFrameRef.current = scheduleFrame(() => {
      cancelFrameRef.current = null;
      if (mountedRef.current) repaintRef.current();
    });
  };

  /** 離したブラシを 1 ストロークとして確定する。 */
  const commitStroke = (points: CutoutPoint[]) => {
    const { mode, radius } = brushRef.current;
    liveRef.current = null;
    // 予約していた途中の描き直しは捨てる（確定した画は、レシピが替わったら描き直す）
    cancelFrameRef.current?.();
    cancelFrameRef.current = null;
    if (points.length === 0) {
      setLiveStroke(null);
      return;
    }
    const before = photoStateRef.current?.history;
    editRecipe((present) => addCutoutStroke(present, { mode, radius, points }));
    // 確定できなかった（押せない間など）なら、途中の画を消すために描き直す
    if (photoStateRef.current?.history === before) setLiveStroke(null);
  };

  const enter = () => {
    if (!available || photoKey === null) return;
    setActiveKey(photoKey);
  };
  const leave = () => {
    liveRef.current = null;
    setActiveKey(null);
  };

  const history = current?.history ?? null;
  /** 書き出しに背景除去を当てる写真（写真に重ねている間だけ）。原寸のマスクと原寸の書き出しは口へ（写真の key を閉じ込める） */
  const exportable = (() => {
    const host = hostRef.current;
    if (!host || !composited || !recipe || !subject || enabledKey === null) return null;
    const key = enabledKey;
    const exportFullSize = host.exportFullSize;
    const value: BrowserPhotoCutoutExport = {
      photoKey: key,
      recipe,
      subject,
      readMask: async () => {
        const bytes = await host.readMask(key, subject);
        // 書き出しも画面と同じく、レシピの SHA-256 と同じ中身のマスクだけを当てる（重ねたあとに置き換わっても 1 行で止める）
        if ((await cutoutMaskSha256(bytes)) !== subject.maskSHA256) throw new Error("cutout mask: sha256 mismatch");
        return bytes;
      },
      ...(exportFullSize ? { exportFullSize: (request) => exportFullSize.call(host, key, request) } : {}),
    };
    return value;
  })();
  return {
    /** 切り替えに「背景除去」を出す */
    available,
    /** 背景除去の道具を開いている */
    active,
    /** 保存したレシピを読んでいる間（道具は押せない） */
    loading: available && !loaded,
    /** 今のレシピ（無ければ null） */
    recipe,
    running,
    /** 推論・読み込み・マスクの失敗の 1 行（無ければ null） */
    failureText: failure ?? (maskFailed ? photoEditingCutoutFailureText("corrupt_mask") : null),
    /** 選んだ被写体のマスクを読めなかった（重ねずに描いている） */
    maskFailed,
    /** 切り抜き・回転のある写真（重ねない・道具は理由だけ） */
    blockedByGeometry,
    /** 写真の上でブラシを使える（レシピがあり・マスクを読めて・幾何が恒等） */
    canBrush: composited,
    /** 背景が透明のまま写真に重ねている（面は写真の後ろに市松模様を出す） */
    transparent: composited && recipe !== null && recipe.background.kind === "transparent",
    /** 書き出しに背景除去を当てる（レシピがあり・マスクを読めて・幾何が恒等で、写真に重ねている間だけ。ほかは null） */
    exportable,
    /** 送り終えていない保存がある（閉じる前に確かめる） */
    saving,
    flush,
    brush,
    setBrushMode: (mode: CutoutBrushMode) => setBrush((value) => (value.mode === mode ? value : { ...value, mode })),
    setBrushRadius: (radius: number) => {
      const next = clampBrushRadius(radius);
      setBrush((value) => (value.radius === next ? value : { ...value, radius: next }));
    },
    canUndo: history !== null && canUndoEditHistory(history),
    canRedo: history !== null && canRedoEditHistory(history),
    enter,
    leave,
    run,
    cancel,
    selectSubject: (selection: CutoutSelection) => editRecipe((present) => selectCutoutSubject(present, selection)),
    setBackground: (background: CutoutBackground) => editRecipe((present) => setCutoutBackground(present, background)),
    /** 「背景除去を外す」（取り消せる。確かめない） */
    remove: () => {
      if (!canEdit() || !photoStateRef.current?.history.present) return;
      commit(null);
    },
    undo,
    redo,
    setLiveStroke,
    commitStroke,
    applyToCanvas,
  };
}

export type BrowserPhotoCutout = ReturnType<typeof useBrowserPhotoCutout>;
