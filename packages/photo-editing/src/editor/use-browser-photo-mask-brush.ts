"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import type { DevelopEngine } from "../develop-engine/develop-engine-client";
import { readDevelopMasks, type DevelopMask, type DevelopSurfaceMask } from "../develop-engine/develop-masks";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import {
  PHOTO_EDITING_MASK_BRUSH_SAVE_FAILED_TEXT,
  photoEditingMaskSurfaceUnreadableText,
} from "../photo-editing-copy";
import {
  PHOTO_EDITING_MASK_BRUSH_DEFAULT,
  PHOTO_EDITING_MASK_BRUSH_FLOW_MIN,
  clampPhotoEditingMaskBrushSize,
  createPhotoEditingMaskStroke,
  filledPhotoEditingMaskSurface,
  photoEditingMaskBrushDab,
  stepPhotoEditingMaskBrushSize,
  type PhotoEditingMaskBrush,
  type PhotoEditingMaskSurfaceData,
} from "../photo-editing-mask-brush";
import { decodePhotoEditingMaskSurfacePng } from "../photo-editing-mask-surface-png";
import { updatePhotoEditingMask, type PhotoEditingMaskFrame, type Vec2 } from "../photo-editing-masks";

/**
 * ブラシのマスク（部分補正。Epic #31 M4 #68）を写真に塗る状態（`useBrowserPhotoMasks` が使う）。
 *
 * - 塗るのは選んでいるブラシのマスクの面（作業画像の上の `width × height` の値）。選ぶと「塗る」になり（esc でやめる。マスクは
 *   残す）、面の PNG（エンジンが覚えた PNG か写真の出どころ）を値に戻してから塗れる。読めない面には塗らず、理由を出す
 * - 1 ストローク（押してから離すまで）は手元の値に重ね（エンジンでは描かない）、離したら面の PNG にして（wasm）写真の出どころに
 *   保存し、マスクの `surface` を 1 回だけ確定する（取り消しの 1 単位）。保存の途中に次のストロークを塗ってよく、確定は順に行う
 *   （それぞれ 1 単位）。保存できない・取り消しなどで面が先に替わった確定は捨て、今の設定の面から読み直す
 * - 写真を替えると塗っている途中のストロークと待っている確定を捨てる。道具を離れる・esc・選ぶマスクを替える・面が替わると、塗って
 *   いる途中のストロークだけ捨てる（確定した分は残る）
 * - 取り消し・やり直しで面が替わったら、その面を読み直して続きを塗る（古い面はエンジンが id で読み直す）
 */

export type PhotoEditingMaskSurfaceSaver = (png: Uint8Array) => Promise<{ id: string }>;

export type PhotoEditingMaskBrushStatus = "idle" | "loading" | "ready" | "unreadable";

/** 1 ストロークの口（写真の上の塗る面が使う）。 */
export type PhotoEditingMaskStrokeHandle = {
  /** 出力の位置（0〜1）に dab を 1 つ置く */
  dab: (output: Vec2, viewport?: { width: number; height: number }) => void;
  /** 終える（`commit` で確定に回す。確定に回したら true） */
  finish: (commit: boolean) => boolean;
  readonly erase: boolean;
};

type Buffer = PhotoEditingMaskSurfaceData & {
  maskId: string;
  /** この値の面の id（確定待ちの塗りの上は null） */
  surfaceId: string | null;
  version: number;
};

type CommitQueue = { chain: Promise<void>; pending: number; ok: boolean; lastId: string | null };

function newQueue(): CommitQueue {
  return { chain: Promise.resolve(), pending: 0, ok: true, lastId: null };
}

function brushMaskOf(mask: DevelopMask | null): DevelopSurfaceMask | null {
  return mask && mask.kind === "brush" ? mask : null;
}

export function useBrowserPhotoMaskBrush(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  photoKey: string | null;
  /** マスクの道具を使っている */
  active: boolean;
  disabled: boolean;
  /** 選んでいるマスク */
  mask: DevelopMask | null;
  /** 選んでいるマスクの名前（理由の 1 行に使う） */
  maskName: string | null;
  frame: PhotoEditingMaskFrame | null;
  /** 面を今の写真に保存する口（無ければ塗れない） */
  saveSurface: PhotoEditingMaskSurfaceSaver | null;
  settingsRef: MutableRefObject<DevelopSettings>;
  /** 最新の設定のマスクを書き換える（`commit` が取り消しの 1 単位） */
  changeMasks: (update: (masks: DevelopMask[], current: DevelopSettings) => DevelopMask[], phase: "commit") => void;
  /** 面の PNG を値に戻す（テスト用） */
  decode?: (png: Uint8Array) => Promise<PhotoEditingMaskSurfaceData>;
}) {
  const { mountedRef, engineRef, photoKey, active, frame } = params;
  const mask = brushMaskOf(params.mask);
  const decode = params.decode ?? decodePhotoEditingMaskSurfacePng;
  const [brush, setBrush] = useState<PhotoEditingMaskBrush>(PHOTO_EDITING_MASK_BRUSH_DEFAULT);
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const [paintMode, setPaintMode] = useState(true);
  const [status, setStatus] = useState<PhotoEditingMaskBrushStatus>("idle");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const bufferRef = useRef<Buffer | null>(null);
  const versionRef = useRef(0);
  /** 写真の世代（替わったら待っている確定も捨てる） */
  const generationRef = useRef(0);
  /** ストロークの世代（替わったら塗っている途中のストロークを捨てる） */
  const strokeGenerationRef = useRef(0);
  const queueRef = useRef<CommitQueue>(newQueue());
  const latestRef = useRef(params);
  latestRef.current = params;
  const maskNameRef = useRef(params.maskName);
  maskNameRef.current = params.maskName;

  const discardStroke = useCallback(() => {
    strokeGenerationRef.current += 1;
  }, []);

  // 写真を替えたら、塗っている途中・待っている確定・手元の値を捨てる
  useEffect(() => {
    generationRef.current += 1;
    strokeGenerationRef.current += 1;
    queueRef.current = newQueue();
    bufferRef.current = null;
    setSaving(false);
    setNotice(null);
    setStatus("idle");
  }, [photoKey]);
  useEffect(
    () => () => {
      generationRef.current += 1;
      strokeGenerationRef.current += 1;
    },
    [],
  );

  // 選ぶマスクを替えたら「塗る」から始める
  const maskId = mask?.id ?? null;
  useEffect(() => {
    strokeGenerationRef.current += 1;
    setPaintMode(true);
    setNotice(null);
  }, [maskId]);
  // 道具を離れた・押せなくなったら、塗っている途中のストロークを捨てる
  useEffect(() => {
    if (!active || params.disabled) strokeGenerationRef.current += 1;
  }, [active, params.disabled]);

  // 選んでいるブラシのマスクの面を値に戻す（確定を待っている間は、確定し終えてから）
  const surfaceId = mask?.surface.id ?? null;
  const surfaceWidth = mask?.surface.width ?? 0;
  const surfaceHeight = mask?.surface.height ?? 0;
  useEffect(() => {
    if (!active || maskId === null || surfaceId === null) {
      setStatus("idle");
      return;
    }
    if (queueRef.current.pending > 0) {
      // 確定し終えたら読み直す（`drained`）。別のマスクの値はまだ使わない
      if (bufferRef.current?.maskId !== maskId) setStatus("loading");
      return;
    }
    const current = bufferRef.current;
    if (current && current.maskId === maskId && current.surfaceId === surfaceId) {
      setStatus("ready");
      return;
    }
    // 面が替わった（取り消し・別のマスク）: 塗っている途中のストロークは前の面の上なので捨てる
    strokeGenerationRef.current += 1;
    bufferRef.current = null;
    setStatus("loading");
    const generation = generationRef.current;
    let cancelled = false;
    void (async () => {
      const engine = engineRef.current;
      const png = engine?.maskSurfacePng ? await engine.maskSurfacePng(surfaceId) : null;
      if (!png) throw new Error("mask surface is not readable");
      const decoded = await decode(png);
      if (decoded.width !== surfaceWidth || decoded.height !== surfaceHeight || decoded.data.length !== surfaceWidth * surfaceHeight) {
        throw new Error("mask surface has another size");
      }
      return decoded;
    })().then(
      (decoded) => {
        if (cancelled || !mountedRef.current || generation !== generationRef.current) return;
        bufferRef.current = { ...decoded, maskId, surfaceId, version: ++versionRef.current };
        setStatus("ready");
        setNotice(null);
      },
      () => {
        if (cancelled || !mountedRef.current || generation !== generationRef.current) return;
        setStatus("unreadable");
        setNotice(photoEditingMaskSurfaceUnreadableText(maskNameRef.current ?? ""));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, decode, engineRef, maskId, mountedRef, reloadToken, surfaceHeight, surfaceId, surfaceWidth]);

  /** 待っている確定がすべて終わった（捨てた・失敗したら、今の設定の面から読み直す）。 */
  const drained = useCallback((queue: CommitQueue) => {
    const broken = !queue.ok;
    queue.ok = true;
    queue.lastId = null;
    if (!mountedRef.current) return;
    setSaving(false);
    if (broken || bufferRef.current?.surfaceId === null) bufferRef.current = null;
    // 今の設定の面と手元の値を照らし直す（同じなら読み直さない）
    setReloadToken((token) => token + 1);
  }, [mountedRef]);

  /**
   * 塗った値を確定に回す（面の PNG にして保存し、マスクの `surface` を 1 回だけ書き換える）。前の確定を待ってから順に行う。
   */
  const queueCommit = useCallback(
    (data: Uint8Array) => {
      const buffer = bufferRef.current;
      if (!buffer) return;
      const queue = queueRef.current;
      // 前の確定を待っているなら、その確定の面の上の塗り（確定するときに、その面のままかを確かめる）
      const baseId = queue.pending > 0 ? null : buffer.surfaceId;
      const version = ++versionRef.current;
      bufferRef.current = { ...buffer, data, surfaceId: null, version };
      const generation = generationRef.current;
      const { maskId: targetId, width, height } = buffer;
      queue.pending += 1;
      setSaving(true);
      queue.chain = queue.chain
        .then(async () => {
          if (generation !== generationRef.current || !queue.ok) return;
          const expected = baseId ?? queue.lastId;
          const current = readDevelopMasks(latestRef.current.settingsRef.current).find((candidate) => candidate.id === targetId);
          if (
            !current ||
            current.kind !== "brush" ||
            current.surface.id !== expected ||
            current.surface.width !== width ||
            current.surface.height !== height
          ) {
            // 取り消し・削除などで面が先に替わった: この塗りは捨てる（今の設定の面から読み直す）
            queue.ok = false;
            return;
          }
          const engine = engineRef.current;
          const save = latestRef.current.saveSurface;
          if (!engine?.encodeMaskSurface || !save) throw new Error("mask surfaces cannot be saved");
          const encoded = await engine.encodeMaskSurface(width, height, data);
          if (generation !== generationRef.current) return;
          const saved = await save(encoded.png);
          if (generation !== generationRef.current) return;
          if (saved.id !== encoded.id) throw new Error("saved mask surface has another id");
          latestRef.current.changeMasks(
            (masks) =>
              updatePhotoEditingMask(masks, targetId, (target) =>
                target.kind === "brush" && target.surface.id === expected
                  ? { ...target, surface: { id: encoded.id, width, height } }
                  : null,
              ),
            "commit",
          );
          queue.lastId = encoded.id;
          const latest = bufferRef.current;
          if (latest && latest.version === version && latest.maskId === targetId) {
            bufferRef.current = { ...latest, surfaceId: encoded.id };
          }
        })
        .catch(() => {
          if (generation !== generationRef.current) return;
          queue.ok = false;
          if (mountedRef.current) setNotice(PHOTO_EDITING_MASK_BRUSH_SAVE_FAILED_TEXT);
        })
        .finally(() => {
          if (generation !== generationRef.current) return;
          queue.pending -= 1;
          if (queue.pending === 0) drained(queue);
        });
    },
    [drained, engineRef, mountedRef],
  );

  const canPaint =
    active && !params.disabled && mask !== null && paintMode && status === "ready" && frame !== null && params.saveSurface !== null;

  /** ストロークを始める（塗れないときは null）。`erase` は消しゴム（⌥ を押している間も）。 */
  const startStroke = (erase: boolean): PhotoEditingMaskStrokeHandle | null => {
    const buffer = bufferRef.current;
    if (!canPaint || !buffer || !mask || buffer.maskId !== mask.id || !frame) return null;
    const strokeGeneration = ++strokeGenerationRef.current;
    const settings = brushRef.current;
    const stroke = createPhotoEditingMaskStroke(buffer, { feather: settings.feather, flow: settings.flow, erase });
    const size = settings.size;
    const strokeFrame = frame;
    const baseVersion = buffer.version;
    let finished = false;
    const live = () => !finished && strokeGeneration === strokeGenerationRef.current && bufferRef.current?.version === baseVersion;
    return {
      erase,
      dab(output, viewport) {
        if (!live()) return;
        const dab = photoEditingMaskBrushDab(strokeFrame, buffer, output, size, viewport);
        if (dab) stroke.addDab(dab);
      },
      finish(commit) {
        if (!live()) {
          finished = true;
          return false;
        }
        finished = true;
        if (!commit) return false;
        const result = stroke.result();
        if (!result) return false;
        queueCommit(result);
        return true;
      },
    };
  };

  /** 面を全部 `value` にする（「全体を消す」は 0、「全体を塗る」は 255。取り消しの 1 単位）。 */
  const fillWith = (value: number) => {
    const buffer = bufferRef.current;
    if (!active || params.disabled || !mask || status !== "ready" || !buffer || buffer.maskId !== mask.id || !params.saveSurface) return;
    const data = filledPhotoEditingMaskSurface(buffer.width, buffer.height, value);
    if (data.every((byte, index) => byte === buffer.data[index])) return;
    discardStroke();
    queueCommit(data);
  };

  return {
    /** 塗れる写真の出どころ（面を保存できる） */
    available: params.saveSurface !== null,
    /** 選んでいるブラシのマスク */
    mask,
    brush,
    setSize: (size: number) => setBrush((current) => ({ ...current, size: clampPhotoEditingMaskBrushSize(size) })),
    stepSize: (direction: 1 | -1) => setBrush((current) => ({ ...current, size: stepPhotoEditingMaskBrushSize(current.size, direction) })),
    setFeather: (feather: number) =>
      setBrush((current) => ({ ...current, feather: Math.round(Math.min(100, Math.max(0, feather))) })),
    setFlow: (flow: number) =>
      setBrush((current) => ({ ...current, flow: Math.round(Math.min(100, Math.max(PHOTO_EDITING_MASK_BRUSH_FLOW_MIN, flow))) })),
    setErase: (erase: boolean) => setBrush((current) => ({ ...current, erase })),
    toggleErase: () => setBrush((current) => ({ ...current, erase: !current.erase })),
    paintMode,
    /** 塗るのをやめる（esc。マスクは残す） */
    leavePaint: () => {
      discardStroke();
      setPaintMode(false);
    },
    resumePaint: () => setPaintMode(true),
    /** 写真の上に塗る面を出す（選んでいるブラシのマスクがあり「塗る」の間） */
    layerVisible: active && mask !== null && paintMode,
    /** 塗れる（面を読めた・押せる） */
    canPaint,
    status,
    saving,
    notice,
    frame,
    startStroke,
    discardStroke,
    clear: () => fillWith(0),
    fill: () => fillWith(255),
    /** 読めなかった面を読み直す */
    retry: () => {
      engineRef.current?.retryMaskSurfaces?.();
      bufferRef.current = null;
      setNotice(null);
      setReloadToken((token) => token + 1);
    },
  };
}

export type BrowserPhotoMaskBrush = ReturnType<typeof useBrowserPhotoMaskBrush>;
