"use client";

import { useEffect, useRef, useState } from "react";

import type { PhotoLibraryAddResult } from "./library/photo-library";
import { BrowserCloudOriginalError } from "./photo-original-files";
import { isPhotoEditingRawExtension, photoEditingFileExtension, photoEditingFileStem } from "./photo-editing-file-names";
import { describePhotoDropNonPhotoFiles, sumPhotoFileBytes } from "./photo-file-drop";
import { describePhotoCloudAddRawPairedJpegs } from "./photo-library-messages";

/**
 * クラウドの「写真」に 1 枚ずつ足す待ち行列（ブラウザ版の「写真を追加」移行元設計 と、面へのドラッグ＆ドロップ 移行元設計。
 * NIHO Desktop の写真編集タブのドロップも同じ）。
 *
 * - 追加している途中に落とした（選んだ）写真は待ちに足し、続けて追加する。進み具合の「N / M」の M は足した分だけ増える
 * - 止める（画面を離れる・拠点や権限が変わる・「止める」）と待ちも捨てる。容量超え・拠点が許可していないで止めたときも同じ
 * - ほかの失敗は数えて次へ進み、終わりにまとめて返す（画面が状態欄に出す）
 * - 同じ追加の中に同じ名前の RAW と JPEG があれば RAW だけを入れ、JPEG は数えて終わりに知らせる（移行元設計）
 *
 * 画面ごとの表示（ブラウザ版の追加中のタイル・Desktop 版の状態欄）は `handlers` に任せる。
 */

/** 追加できなかった写真（`retryable` は「再試行」で同じファイルをもう一度試せるか）。 */
export type PhotoCloudAddFailure = { file: File; retryable: boolean; message: string };

/** 追加している 1 枚（`index` はこの回で何枚目か、`total` はこの回の合計。待ちに足すと増える）。 */
export type PhotoCloudAddProgress = { spotId: string; fileName: string; index: number; total: number };

/** 1 回（待ちが空になるまで）の結果。 */
export type PhotoCloudAddOutcome = {
  spotId: string;
  /** 止めた（画面を離れた・拠点や権限が変わった・「止める」）。結果は画面に出さない */
  aborted: boolean;
  /** 残りを止めた理由（容量超え・拠点が許可していない） */
  stopMessage: string | null;
  failures: PhotoCloudAddFailure[];
  /** 落とした中の写真でないファイルの数（この回に足した分の合計） */
  nonPhotoCount: number;
  /** RAW と同じ写真なので入れなかった JPEG の数（この回に足した分の合計。移行元設計） */
  rawPairedJpegCount: number;
  /** 新しくクラウドに入った写真があった（一覧・使用量を読み直す） */
  storedAny: boolean;
  /** 最後に足した写真（同じ写真がもうあればその写真）。終わったら選ぶ */
  lastPhotoId: string | null;
};

export type PhotoCloudAddQueueHandlers = {
  /** 1 枚を入れる（`addBrowserCloudPhoto` を画面の表示と一緒に呼ぶ）。入れられなければ throw する */
  addPhoto: (file: File, context: { spotId: string; signal: AbortSignal }) => Promise<PhotoLibraryAddResult>;
  /** 次の 1 枚を始めてよいか（画面がある・権限・拠点の許可・拠点が同じ）。false なら止める */
  canContinue: (spotId: string) => boolean;
  /** 進み具合（終わったら null） */
  onProgress: (progress: PhotoCloudAddProgress | null) => void;
  /** 終了処理は同期で表示へ反映する。非同期の再読込は呼び出し側で待たずに始める。 */
  onFinished: (outcome: PhotoCloudAddOutcome) => void;
};

type QueueRun = {
  spotId: string;
  controller: AbortController;
  waiting: File[];
  /** 始めた枚数（追加中の 1 枚を含む） */
  started: number;
  total: number;
  currentFileName: string | null;
  nonPhotoCount: number;
  rawPairedJpegCount: number;
  /** 始めたときの使用量（分からなければ null） */
  usedBytesAtStart: number | null;
  /** この回で使う見込みのバイト（待ち・追加中・入れ終えた写真。失敗した・もうあった写真は引く） */
  pendingBytes: number;
};

/** 画面の状態欄に出す、終わりの 1 行（優先は 止めた理由 > 失敗 > 入れなかったファイル）。 */
export type PhotoCloudAddSummary =
  | { kind: "stopped"; text: string }
  | { kind: "failed"; failures: PhotoCloudAddFailure[] }
  | { kind: "notice"; text: string };

/** 状態欄の「<名前> を追加中…（N / M）」（1 枚だけのときは「N / M」を付けない）。 */
export function describePhotoCloudAddProgress(progress: Pick<PhotoCloudAddProgress, "fileName" | "index" | "total">): string {
  return `${progress.fileName} を追加中…${progress.total > 1 ? `（${progress.index} / ${progress.total}）` : ""}`;
}

/** 入れなかったファイル（写真でないファイル・RAW と同じ写真の JPEG）の 1 行。どちらも無ければ null。 */
function describeSkippedFiles(outcome: Pick<PhotoCloudAddOutcome, "nonPhotoCount" | "rawPairedJpegCount">): string | null {
  const { nonPhotoCount, rawPairedJpegCount } = outcome;
  if (nonPhotoCount > 0 && rawPairedJpegCount > 0) {
    return `写真でないファイル ${nonPhotoCount} 件と、RAW と同じ写真の JPEG ${rawPairedJpegCount} 枚は入れませんでした`;
  }
  if (nonPhotoCount > 0) return describePhotoDropNonPhotoFiles(nonPhotoCount);
  if (rawPairedJpegCount > 0) return describePhotoCloudAddRawPairedJpegs(rawPairedJpegCount);
  return null;
}

/** 終わりに状態欄へ出すもの（出すものが無ければ null）。 */
export function summarizePhotoCloudAddOutcome(outcome: PhotoCloudAddOutcome): PhotoCloudAddSummary | null {
  if (outcome.stopMessage) return { kind: "stopped", text: outcome.stopMessage };
  if (outcome.failures.length > 0) return { kind: "failed", failures: outcome.failures };
  const skipped = describeSkippedFiles(outcome);
  return skipped ? { kind: "notice", text: skipped } : null;
}

const PAIRED_JPEG_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg"]);

/** RAW と JPEG を組にする名前（フォルダごと選んだ・落としたときは同じフォルダの中だけ。拡張子を除き、大文字・小文字を問わない）。 */
function rawJpegPairKey(file: File): string {
  const relativePath = typeof file.webkitRelativePath === "string" ? file.webkitRelativePath : "";
  const folder = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/") + 1) : "";
  return `${folder}${photoEditingFileStem(file.name).toLowerCase()}`;
}

/**
 * 同じ追加（1 回に選んだ・落とした写真）の中に同じ名前の RAW と JPEG があれば JPEG を外す（移行元設計。カメラの RAW+JPEG 記録の
 * JPEG は同じ写真の撮って出しなので、クラウドに 2 枚にしない。Lightroom の取り込みと同じ）。外した JPEG は数だけ返す。
 */
export function dropJpegsPairedWithRaw(files: readonly File[]): { files: File[]; rawPairedJpegCount: number } {
  const rawKeys = new Set(
    files.filter((file) => isPhotoEditingRawExtension(photoEditingFileExtension(file.name))).map(rawJpegPairKey),
  );
  if (rawKeys.size === 0) return { files: [...files], rawPairedJpegCount: 0 };
  const kept = files.filter(
    (file) => !(PAIRED_JPEG_EXTENSIONS.has(photoEditingFileExtension(file.name)) && rawKeys.has(rawJpegPairKey(file))),
  );
  return { files: kept, rawPairedJpegCount: files.length - kept.length };
}

function isStopError(error: unknown): error is BrowserCloudOriginalError {
  return error instanceof BrowserCloudOriginalError && (error.reason === "quota" || error.reason === "originals_disabled");
}

export class PhotoCloudAddQueue {
  private current: QueueRun | null = null;

  constructor(private readonly handlers: () => PhotoCloudAddQueueHandlers) {}

  /** 追加している途中か（止めた後は、今の 1 枚が終わる前でも false）。 */
  get running(): boolean {
    return this.current !== null && !this.current.controller.signal.aborted;
  }

  /**
   * 写真を足す。同じ拠点で追加している途中なら待ちに足して「N / M」の M を増やし（`queued`）、そうでなければ新しく始める
   * （`started`。止めた回が残っていれば捨てる）。写真が無く、写真でないファイルだけのときは、追加している途中なら数えるだけ
   * （`queued`）、そうでなければ何もしない（`ignored`。画面が「入れられる写真がありませんでした」を出す）。
   * 同じ追加の中の RAW と同じ名前の JPEG は入れず、数えて終わりに知らせる（{@link dropJpegsPairedWithRaw}）。
   */
  add(
    spotId: string,
    added: readonly File[],
    options: { nonPhotoCount?: number; usedBytes?: number | null } = {},
  ): "started" | "queued" | "ignored" {
    const nonPhotoCount = options.nonPhotoCount ?? 0;
    const { files, rawPairedJpegCount } = dropJpegsPairedWithRaw(added);
    const current = this.current;
    if (current && !current.controller.signal.aborted && current.spotId === spotId) {
      current.waiting.push(...files);
      current.total += files.length;
      current.nonPhotoCount += nonPhotoCount;
      current.rawPairedJpegCount += rawPairedJpegCount;
      current.pendingBytes += sumPhotoFileBytes(files);
      if (files.length > 0 && current.currentFileName !== null) {
        this.handlers().onProgress({
          spotId,
          fileName: current.currentFileName,
          index: current.started,
          total: current.total,
        });
      }
      return "queued";
    }
    if (files.length === 0) return "ignored";
    current?.controller.abort();
    const run: QueueRun = {
      spotId,
      controller: new AbortController(),
      waiting: [...files],
      started: 0,
      total: files.length,
      currentFileName: null,
      nonPhotoCount,
      rawPairedJpegCount,
      usedBytesAtStart: options.usedBytes ?? null,
      pendingBytes: sumPhotoFileBytes(files),
    };
    this.current = run;
    void this.drive(run);
    return "started";
  }

  /** 止める（追加中の 1 枚を止め、待ちも捨てる）。 */
  abort(): void {
    const run = this.current;
    if (!run) return;
    run.waiting.length = 0;
    run.controller.abort();
  }

  /**
   * 待っている・追加中・入れ終えたがまだ使用量に入っていない分（空きの事前確認で使用量に足す）。`usedBytes` は今の使用量。
   * 始めたときの使用量にこの回の見込みを足した値から今の使用量を引く（途中で使用量を読み直しても二重に数えない）。
   */
  reservedBytes(usedBytes: number): number {
    const run = this.current;
    if (!run || run.controller.signal.aborted) return 0;
    const base = run.usedBytesAtStart ?? usedBytes;
    return Math.max(0, base + run.pendingBytes - usedBytes);
  }

  private async drive(run: QueueRun): Promise<void> {
    const { signal } = run.controller;
    const failures: PhotoCloudAddFailure[] = [];
    let lastPhotoId: string | null = null;
    let storedAny = false;
    let stopMessage: string | null = null;
    try {
      for (let file = run.waiting.shift(); file !== undefined; file = run.waiting.shift()) {
        if (signal.aborted) break;
        if (!this.handlers().canContinue(run.spotId)) {
          run.controller.abort();
          break;
        }
        run.started += 1;
        run.currentFileName = file.name;
        this.handlers().onProgress({ spotId: run.spotId, fileName: file.name, index: run.started, total: run.total });
        try {
          const result = await this.handlers().addPhoto(file, { spotId: run.spotId, signal });
          storedAny = storedAny || !result.alreadyStored;
          if (result.alreadyStored) run.pendingBytes -= sumPhotoFileBytes([file]);
          // 止めた後に届いた結果は反映しない（クラウドに入った分は一覧を読み直して出す）
          if (signal.aborted) break;
          lastPhotoId = result.photo.id;
        } catch (error) {
          run.pendingBytes -= sumPhotoFileBytes([file]);
          if (signal.aborted) break;
          if (isStopError(error)) {
            stopMessage = error.message;
            break;
          }
          failures.push({
            file,
            retryable: !(error instanceof BrowserCloudOriginalError && error.reason === "invalid"),
            message: error instanceof Error ? error.message : "",
          });
        }
      }
    } finally {
      // 止めた・残りを止めたときは待ちも捨てる
      run.waiting.length = 0;
      if (this.current === run) {
        this.current = null;
        this.handlers().onProgress(null);
      }
    }
    this.handlers().onFinished({
      spotId: run.spotId,
      aborted: signal.aborted,
      stopMessage,
      failures,
      nonPhotoCount: run.nonPhotoCount,
      rawPairedJpegCount: run.rawPairedJpegCount,
      storedAny,
      lastPhotoId,
    });
  }
}

/**
 * {@link PhotoCloudAddQueue} を画面に 1 つ持つ。`handlers` は描くたびに新しいものを使う（古い描画の関数を呼ばない）。
 * 画面を外したら止める。
 */
export function usePhotoCloudAddQueue(handlers: PhotoCloudAddQueueHandlers): PhotoCloudAddQueue {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [queue] = useState(() => new PhotoCloudAddQueue(() => handlersRef.current));
  useEffect(() => () => queue.abort(), [queue]);
  return queue;
}
