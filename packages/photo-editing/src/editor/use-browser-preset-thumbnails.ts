"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import type {
  DevelopEngine,
  DevelopFrame,
  DevelopPresetResult,
} from "../develop-engine/develop-engine-client";
import {
  developSettingsKey,
  presetDevelopSettings,
  type DevelopSettings,
} from "../develop-engine/develop-settings";

import type {
  PhotoEditingPresetThumbnailState,
  PhotoEditingPresetThumbnails,
} from "./photo-editing-preset-thumbnail";
import type { PhotoEditingPresetTarget } from "./photo-editing-presets-panel";

/** 見本 1 枚の長辺（48px の行の 2 倍。スマホの段も同じ）。 */
export const BROWSER_PRESET_THUMBNAIL_MAX_DIMENSION = 96;
/** 升の 2 列（ブラウザ版の右パネル。L4 #53）の見本 1 枚の長辺（升の幅 ≈ 100px の 2 倍）。 */
export const BROWSER_PRESET_GRID_THUMBNAIL_MAX_DIMENSION = 192;
/** 土台の設定が変わってから見本を作り直すまでの待ち（スライダーを続けて動かす間は作り直さない）。 */
export const BROWSER_PRESET_THUMBNAIL_REBUILD_DELAY_MS = 400;
/** 描画を捨てられた（写真を開き直した途中など）ときに描き直すまでの待ちと回数。 */
const RETRY_DELAY_MS = 400;
const RETRY_LIMIT = 3;
/** 見えている行を先に読んでおく余白。 */
const OBSERVER_ROOT_MARGIN = "48px 0px";

const EMPTY_STATE: PhotoEditingPresetThumbnailState = { frame: null, failed: false };

type Row = { xmp: string | null; element: Element; visible: boolean };
type Drawn = { baseKey: string; xmp: string | null; frame: DevelopFrame | null; failed: boolean };
/** 見本を描く写真と土台（選ばれているプリセットがあれば当てる前の補正、無ければ今の補正）。 */
type Target = { photoKey: string; baseKey: string; base: DevelopSettings };

/** 行の要素を文書の順に並べる（上の行から描く）。 */
function byDocumentOrder(a: Element, b: Element): number {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

/**
 * ブラウザ版の右パネルのプリセットの見本（NIHO Photo 段 1 F2b 移行元設計。`supportsPresetThumbnails()` の wasm だけ）。
 *
 * - 見本 1 枚 ＝ 土台の設定にプリセットを 100% で当てた結果（`resolvePreset`。仮の表示と同じ覚え）を、wasm の見本用の別の session
 *   で丁寧に描いた絵（長辺 `maxDimension`。省くと 96px、升の 2 列は 192px）。「なし」の行は土台そのもの
 * - 見えている行（IntersectionObserver。節を閉じている間は行が無いので描かない）から上の順に 1 枚ずつ、描画の preview の枠で描く
 *   （編集の描画を待たせない）。スライダー・適用量を動かしている間（`paused`）は新しい見本を出さない
 * - 土台の key が変わったら 400ms 待ってから見えている行を作り直し、その間は前の見本を出したまま。写真が変わったら見本を捨てる
 * - 使えない wasm（`supported` が false）では undefined（パネルは見本の無い行のまま）
 * - 版の見本（niho-photo#42）も同じ仕組みで描く: 行の `xmp` に版の補正の JSON を渡し、`settingsOf` でそれを土台（今の補正の
 *   数式・ルック・作業コピーの版だけ）に載せた補正にする。見本は行ごとに (土台の key, 行の値) で覚え、写真が変わったら捨てる
 */
export function useBrowserPresetThumbnails(params: {
  mountedRef: MutableRefObject<boolean>;
  engineRef: MutableRefObject<DevelopEngine | null>;
  /** 見本を描ける wasm か */
  supported: boolean;
  /** wasm で開いて 1 枚で見ている写真の key（ほかは null。描かない） */
  photoKey: string | null;
  /** 見本の土台 */
  base: DevelopSettings;
  /** スライダー・適用量を動かしている（新しい見本を出さない） */
  paused: boolean;
  /** 見本 1 枚の長辺（省くと {@link BROWSER_PRESET_THUMBNAIL_MAX_DIMENSION}） */
  maxDimension?: number;
  /** プリセットを土台に当てる（`settingsOf` を渡したときは使わない） */
  resolvePreset?: (preset: PhotoEditingPresetTarget, base: DevelopSettings) => Promise<DevelopPresetResult>;
  /** 行の値（`xmp`）から描く補正を決める（版の見本。null は描けない）。省くとプリセット（`xmp` を土台に当てる） */
  settingsOf?: (row: { key: string; xmp: string | null }, base: DevelopSettings) => DevelopSettings | null;
}): PhotoEditingPresetThumbnails | undefined {
  const { mountedRef, engineRef, supported, photoKey, base, paused } = params;
  const maxDimension = params.maxDimension ?? BROWSER_PRESET_THUMBNAIL_MAX_DIMENSION;
  const baseKey = useMemo(() => developSettingsKey(base), [base]);
  const rowsRef = useRef(new Map<string, Row>());
  const drawnRef = useRef(new Map<string, Drawn>());
  const targetRef = useRef<Target | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const pumpingRef = useRef(false);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, setVersion] = useState(0);
  const latest = {
    supported,
    photoKey,
    paused,
    base,
    baseKey,
    maxDimension,
    resolvePreset: params.resolvePreset,
    settingsOf: params.settingsOf,
  };
  const latestRef = useRef(latest);
  latestRef.current = latest;

  /** 描き直す見本のうち、見えている一番上の行（無ければ null）。 */
  const nextRow = (target: Target): { key: string; xmp: string | null } | null => {
    const stale = Array.from(rowsRef.current.entries()).filter(([key, row]) => {
      if (!row.visible) return false;
      const drawn = drawnRef.current.get(key);
      return !drawn || drawn.baseKey !== target.baseKey || drawn.xmp !== row.xmp;
    });
    if (stale.length === 0) return null;
    stale.sort(([, a], [, b]) => byDocumentOrder(a.element, b.element));
    const [key, row] = stale[0]!;
    return { key, xmp: row.xmp };
  };

  /** 見本を 1 枚描く（描画を捨てられたら "retry"、当てられない・描けなければ "failed"）。 */
  const drawOne = async (
    engine: DevelopEngine,
    row: { key: string; xmp: string | null },
    target: Target,
  ): Promise<DevelopFrame | "failed" | "retry"> => {
    try {
      let settings = target.base;
      const { settingsOf, resolvePreset } = latestRef.current;
      if (settingsOf) {
        const resolved = settingsOf(row, target.base);
        if (!resolved) return "failed";
        settings = resolved;
      } else if (row.xmp !== null) {
        if (!resolvePreset) return "failed";
        const result = await resolvePreset({ key: row.key, name: "", xmp: row.xmp }, target.base);
        if (!result.converted) return "failed";
        settings = presetDevelopSettings(target.base, result.settings);
      }
      const frame = await engine.renderPresetThumbnail(settings, latestRef.current.maxDimension);
      return frame ?? "retry";
    } catch {
      return "failed";
    }
  };

  const pumpRef = useRef<() => void>(() => undefined);
  const schedule = useCallback(() => pumpRef.current(), []);

  const scheduleRetry = () => {
    if (retriesRef.current >= RETRY_LIMIT || retryTimerRef.current !== null) return;
    retriesRef.current += 1;
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (mountedRef.current) schedule();
    }, RETRY_DELAY_MS);
  };

  /** 見えている行の見本を上から 1 枚ずつ描く（描いている間に呼ばれても、ループが次の行を拾う）。 */
  pumpRef.current = () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        for (;;) {
          const latest = latestRef.current;
          const target = targetRef.current;
          const engine = engineRef.current;
          if (!mountedRef.current || !latest.supported || latest.paused || !engine) return;
          if (!target || latest.photoKey !== target.photoKey) return;
          const row = nextRow(target);
          if (!row) return;
          const outcome = await drawOne(engine, row, target);
          if (!mountedRef.current) return;
          // 描いている間に写真が変わった（捨てた見本の結果は使わない）
          if (targetRef.current?.photoKey !== target.photoKey) continue;
          if (outcome === "retry") {
            scheduleRetry();
            return;
          }
          retriesRef.current = 0;
          const previous = drawnRef.current.get(row.key);
          // 描けなかった見本は同じ土台では描き直さない（前の見本があれば出したまま）
          drawnRef.current.set(
            row.key,
            outcome === "failed"
              ? { baseKey: target.baseKey, xmp: row.xmp, frame: previous?.frame ?? null, failed: true }
              : { baseKey: target.baseKey, xmp: row.xmp, frame: outcome, failed: false },
          );
          setVersion((current) => current + 1);
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  };

  const ensureObserver = (): IntersectionObserver | null => {
    if (observerRef.current) return observerRef.current;
    if (typeof IntersectionObserver === "undefined") return null;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          for (const row of rowsRef.current.values()) {
            if (row.element === entry.target) row.visible = entry.isIntersecting;
          }
        }
        schedule();
      },
      { rootMargin: OBSERVER_ROOT_MARGIN },
    );
    return observerRef.current;
  };
  const ensureObserverRef = useRef(ensureObserver);
  ensureObserverRef.current = ensureObserver;

  const observe = useCallback(
    (key: string, xmp: string | null, element: Element | null) => {
      const rows = rowsRef.current;
      const previous = rows.get(key);
      if (previous && previous.element !== element) {
        observerRef.current?.unobserve(previous.element);
        rows.delete(key);
      }
      if (!element) return;
      if (previous?.element === element) {
        previous.xmp = xmp;
      } else {
        const observer = ensureObserverRef.current();
        // IntersectionObserver の無い環境では、全部の行を見えているものとして描く
        rows.set(key, { xmp, element, visible: observer === null });
        observer?.observe(element);
      }
      schedule();
    },
    [schedule],
  );

  const stateOf = useCallback((key: string): PhotoEditingPresetThumbnailState => {
    const target = targetRef.current;
    if (!target || target.photoKey !== latestRef.current.photoKey) return EMPTY_STATE;
    const drawn = drawnRef.current.get(key);
    return drawn ? { frame: drawn.frame, failed: drawn.failed && drawn.frame === null } : EMPTY_STATE;
  }, []);

  // 描く写真と土台: 写真が変わったら見本を捨ててすぐ描き、同じ写真で土台が変わったら 400ms 待ってから作り直す
  useEffect(() => {
    if (!supported || photoKey === null) return;
    const target = targetRef.current;
    if (target?.photoKey === photoKey && target.baseKey === baseKey) return;
    if (target === null || target.photoKey !== photoKey) {
      drawnRef.current.clear();
      retriesRef.current = 0;
      targetRef.current = { photoKey, baseKey, base: latestRef.current.base };
      setVersion((current) => current + 1);
      schedule();
      return;
    }
    const timer = setTimeout(() => {
      const latest = latestRef.current;
      if (latest.photoKey !== photoKey) return;
      retriesRef.current = 0;
      targetRef.current = { photoKey, baseKey: latest.baseKey, base: latest.base };
      schedule();
    }, BROWSER_PRESET_THUMBNAIL_REBUILD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [baseKey, photoKey, schedule, supported]);

  // 動かし終えたら続きを描く
  useEffect(() => {
    if (!paused) schedule();
  }, [paused, schedule]);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
    },
    [],
  );

  return useMemo(
    () => (supported ? { stateOf, observe, version } : undefined),
    [observe, stateOf, supported, version],
  );
}
