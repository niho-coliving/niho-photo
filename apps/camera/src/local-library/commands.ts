/**
 * この Mac の `PhotoLibrary` の native の口（src-tauri の `camera_library_*`・`camera_photo_*`・`camera_develop_*`・`camera_export*`）。
 * 公開移植前の内部構成については docs/migration/mac-client.md を参照。
 * （packages/photo-editing）はここを直に import せず、これを使う LocalPhotoLibrary（C1 の接続口の型を満たす adapter）越しに読む。
 *
 * - パスは受け取らない・渡さない。フォルダ・写真・書き出し先は不透明な ID（`folderId`・`entryId`・`photoId`・`exportFolderId`）。
 * - 失敗は {@link CameraCommandError}（`code` と画面に出せる `message`）。補正の保存の競合は `revisionConflict` と `currentRevision`。
 * - バイト列（サムネイル・作業コピー）は raw IPC で `ArrayBuffer` のまま受け取る（JSON にしない）。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  CutoutDetection,
  CutoutRecipe,
  CutoutSubject,
} from "niho-photo-editing/photo-cutout";
import type { PhotoLibraryDevelopSourceContext, PhotoLibraryPhotoInfo } from "niho-photo-editing/library/photo-library";

/** Tauri の `invoke`（`args` は JSON の引数か raw IPC のバイト列。`options.headers` は raw IPC の添え書き）。 */
export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown> | Uint8Array | ArrayBuffer,
  options?: { headers: Record<string, string> },
) => Promise<T>;

/** フォルダの一覧の写真（`kind` は crate の区分: RAW か、それ以外のラスタ）。 */
export type LibraryEntry = {
  entryId: string;
  fileName: string;
  kind: "raw" | "raster";
  sizeBytes: number;
  /** ファイルの更新日時（ISO 8601・UTC） */
  modifiedAt: string;
  /** この Mac に補正を保存した写真か（名前・大きさ・更新日時で見分ける。開けば中身の SHA-256 で補正が付いてくる） */
  hasEdits: boolean;
};

/** 追加したフォルダの木。`truncated` は上限・時間の予算で読み切っていない（選ばれたら `listFolder` で読む）。 */
export type LibraryFolder = {
  folderId: string;
  name: string;
  children: LibraryFolder[];
  photos: LibraryEntry[];
  truncated: boolean;
};

export type RememberedLibrary = {
  folders: LibraryFolder[];
  photos: LibraryEntry[];
};

export type PhotoFormat = "raw" | "jpeg" | "png" | "heic" | "tiff";

export type SavedDevelopSettings = {
  developSettings: Record<string, unknown>;
  /** 保存のたびに 1 ずつ増える版。次の保存の `expectedRevision` に渡す */
  revision: number;
  updatedAtMs: number;
};

export type OpenedPhoto = {
  photoId: string;
  entryId: string;
  fileName: string;
  format: PhotoFormat | null;
  sizeBytes: number;
  /** 中身の SHA-256（16 進の小文字 64 文字。補正の置き場の鍵・接続口の `contentSha256`） */
  contentSha256: string;
  /** ファイルの更新日時（ISO 8601・UTC。読めなければ null） */
  modifiedAt: string | null;
  /** この形式を原寸で書き出せる（同梱の sidecar が使えて、形式に入力の経路がある） */
  nativeExport: boolean;
  saved: SavedDevelopSettings | null;
};

export type OpenPhotosResult = {
  photos: OpenedPhoto[];
  failed: Array<{ entryId: string; code: string; message: string }>;
};

/** 現像の入力。`raster` はオリジナルのまま、`workingCopy` は作業コピー（`baseVersion`・`meta` つき）。 */
export type DevelopSource =
  | { kind: "raster"; byteLength: number; token: string }
  | {
      kind: "workingCopy";
      byteLength: number;
      baseVersion: string;
      meta: Record<string, unknown>;
      token: string;
    };

/**
 * 現像が使えるか（`fullSizeRaster` は HEIC / HEIF・TIFF も原寸で書き出せる、`masks` は部分補正のある設定を原寸で書き出せる。
 * どちらも古い native は返さない）。
 */
export type DevelopStatus = { available: boolean; raster: boolean; fullSizeRaster?: boolean; masks?: boolean };

/** 背景除去の sidecar が camera の lock の版で使えるか。 */
export type CutoutStatus = { available: boolean };

export type ExportResult = { saved: false } | { saved: true; fileName: string };

export type ExportFolder = { exportFolderId: string; name: string };

/** 端末への保存（`camera_save_file`）の結果。保存ダイアログを閉じたら `cancelled`。 */
export type SaveFileResult = "saved" | "cancelled";

/** この Mac のプリセット（web の拠点のプリセットと同じ形。同梱の 3 本は wasm の `builtinPresets`）。 */
export type LocalPreset = {
  id: string;
  name: string;
  xmp: string;
  /** 取り込んだ XMP（`xmp`）か、今の補正から保存したもの（`user`） */
  source: "xmp" | "user";
  createdAt: string;
};

/** native が返す失敗。 */
export class CameraCommandError extends Error {
  readonly code: string;
  readonly currentRevision: number | null;

  constructor(code: string, message: string, currentRevision: number | null = null) {
    super(message);
    this.name = "CameraCommandError";
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

const FALLBACK_MESSAGE = "予期しないエラーが起きました。もう一度お試しください。";

/** invoke の失敗（native の `{ code, message, currentRevision? }`・ACL の拒否の文字列など）を {@link CameraCommandError} にする。 */
export function toCameraCommandError(error: unknown): CameraCommandError {
  if (error instanceof CameraCommandError) return error;
  if (typeof error === "object" && error !== null) {
    const { code, message, currentRevision } = error as { code?: unknown; message?: unknown; currentRevision?: unknown };
    if (typeof code === "string" && typeof message === "string") {
      return new CameraCommandError(code, message, typeof currentRevision === "number" ? currentRevision : null);
    }
  }
  return new CameraCommandError("internal", FALLBACK_MESSAGE);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  // 古い IPC の形（数の配列）でも受ける
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new CameraCommandError("internal", FALLBACK_MESSAGE);
}

/** native のコマンドを呼ぶ口（テストでは invoke を差し替える）。 */
export function createCameraCommands(invoke: Invoke = tauriInvoke) {
  const call = async <T>(command: string, request?: Record<string, unknown>): Promise<T> => {
    try {
      return await invoke<T>(command, request === undefined ? undefined : { request });
    } catch (error) {
      throw toCameraCommandError(error);
    }
  };

  return {
    /** フォルダの選択ダイアログで選んだフォルダを足す。閉じたら null。 */
    addFolder: async () => (await call<{ folder: LibraryFolder | null }>("camera_library_add_folder")).folder,
    /** 写真の選択ダイアログで選んだ写真を足す。閉じたら空。 */
    addPhotos: async () => (await call<{ photos: LibraryEntry[] }>("camera_library_add_photos")).photos,
    /** 覚えたフォルダ・写真のうち、いまあるもの。 */
    remembered: () => call<RememberedLibrary>("camera_library_remembered"),
    /** 「選んだ写真」だけを読み直す（覚えたフォルダは再走査しない）。 */
    selectedPhotos: async () => (await call<{ photos: LibraryEntry[] }>("camera_library_selected_photos")).photos,
    listFolder: async (folderId: string) =>
      (await call<{ folder: LibraryFolder }>("camera_library_list_folder", { folderId })).folder,
    /** 覚えたフォルダを一覧から外す（フォルダと写真は消さない）。 */
    forgetFolder: async (folderId: string) => {
      await call<Record<string, never>>("camera_library_forget_folder", { folderId });
    },
    /** 「選んだ写真」の参照をすべて一覧から外す。 */
    forgetPhotos: async () => {
      await call<Record<string, never>>("camera_library_forget_photos");
    },
    openPhotos: (entryIds: string[]) => call<OpenPhotosResult>("camera_photo_open", { entryIds }),
    closePhotos: async (photoIds: string[]) => {
      await call<Record<string, never>>("camera_photo_close", { photoIds });
    },
    /** 開いた写真の情報（撮影条件・カメラ・レンズ・撮影日時・寸法・場所。読めない項目は null。右パネルの「情報」）。 */
    photoInfo: async (photoId: string) =>
      (await call<{ info: PhotoLibraryPhotoInfo }>("camera_photo_info", { photoId })).info,
    /** 補正を保存する（新しい版）。画面が知っている版と違えば `revisionConflict`。 */
    saveSettings: async (photoId: string, developSettings: Record<string, unknown>, expectedRevision: number) =>
      (
        await call<{ revision: number }>("camera_photo_save_settings", {
          photoId,
          developSettings,
          expectedRevision,
        })
      ).revision,
    developStatus: () => call<DevelopStatus>("camera_develop_status"),
    cutoutStatus: () => call<CutoutStatus>("camera_cutout_status"),
    /** 現像の入力（作業コピーが要れば作る。RAW は数秒かかる）。 */
    developSource: (
      photoId: string,
      options: { forceWorkingCopy?: boolean; sourceContext?: PhotoLibraryDevelopSourceContext } = {},
    ) =>
      call<DevelopSource>("camera_develop_source", {
        photoId,
        ...(options.forceWorkingCopy ? { forceWorkingCopy: true } : {}),
        ...(options.sourceContext ? { sourceContext: options.sourceContext } : {}),
      }),
    /** `developSource` の `token` のバイト列（1 回限り）。 */
    developSourceBytes: async (photoId: string, token: string) =>
      toBytes(await call<unknown>("camera_develop_source_bytes", { photoId, token })),
    /** canonical とは別の QuickLook / ImageIO 系プレビュー（raw IPC、長辺 1280〜2048px）。 */
    interactivePreview: async (
      entryId: string,
      maxDimension: number,
      requestId: string,
      priority: "selected" | "prefetch",
    ) => toBytes(await call<unknown>("camera_photo_interactive_preview", { entryId, maxDimension, requestId, priority })),
    cancelInteractivePreview: async (requestId: string) => {
      await call<Record<string, never>>("camera_photo_cancel_interactive_preview", { requestId });
    },
    /** 原寸の JPEG を保存ダイアログで選んだ場所へ書き出す。 */
    exportPhoto: (
      photoId: string,
      developSettings: Record<string, unknown>,
      context: Pick<PhotoLibraryDevelopSourceContext, "hasSavedDevelopSettings" | "hasDevelopEdits">,
      suggestedFileName?: string,
    ) =>
      call<ExportResult>("camera_export", {
        photoId,
        developSettings,
        ...context,
        ...(suggestedFileName ? { suggestedFileName } : {}),
      }),
    chooseExportFolder: async () =>
      (await call<{ exportFolder: ExportFolder | null }>("camera_choose_export_folder")).exportFolder,
    /** 選んだフォルダへ原寸の JPEG を書き出す（同じ名前があれば `-2`…。書いた名前を返す）。 */
    exportToFolder: async (
      exportFolderId: string,
      photoId: string,
      developSettings: Record<string, unknown>,
      context: Pick<PhotoLibraryDevelopSourceContext, "hasSavedDevelopSettings" | "hasDevelopEdits">,
      suggestedFileName?: string,
    ) =>
      (
        await call<{ fileName: string }>("camera_export_to_folder", {
          exportFolderId,
          photoId,
          developSettings,
          ...context,
          ...(suggestedFileName ? { suggestedFileName } : {}),
        })
      ).fileName,
    /** この Mac のプリセット（作った順）。 */
    listPresets: async () => (await call<{ presets: LocalPreset[] }>("camera_presets_list")).presets,
    /** 取り込んだ XMP・今の補正の XMP をプリセットにする（同じ名前は `presetNameTaken`）。 */
    createPreset: async (name: string, xmp: string, source: LocalPreset["source"]) =>
      (await call<{ preset: LocalPreset }>("camera_presets_create", { name, xmp, source })).preset,
    renamePreset: async (id: string, name: string) =>
      (await call<{ preset: LocalPreset }>("camera_presets_rename", { id, name })).preset,
    deletePreset: async (id: string) => {
      await call<Record<string, never>>("camera_presets_delete", { id });
    },
    /**
     * オリジナル（開いた写真のファイルそのもの）を保存ダイアログで選んだ場所へ写す（元の写真には上書きしない。バイト列は画面へ
     * 運ばない）。
     */
    exportOriginal: (photoId: string, suggestedFileName?: string) =>
      call<ExportResult>("camera_export_original", {
        photoId,
        ...(suggestedFileName ? { suggestedFileName } : {}),
      }),
    cutoutLoadRecipe: async (photoId: string) =>
      (await call<{ recipe: CutoutRecipe | null }>("camera_cutout_load_recipe", { photoId })).recipe,
    cutoutSaveRecipe: async (photoId: string, recipe: CutoutRecipe | null) => {
      await call<Record<string, never>>("camera_cutout_save_recipe", { photoId, recipe });
    },
    cutoutDetect: async (photoId: string, operationId: string) =>
      (await call<{ detection: CutoutDetection }>("camera_cutout_detect", { photoId, operationId })).detection,
    cutoutCancel: async (operationId: string) => {
      await call<Record<string, never>>("camera_cutout_cancel", { operationId });
    },
    cutoutReadMask: async (photoId: string, subject: CutoutSubject) =>
      toBytes(await call<unknown>("camera_cutout_read_mask", { photoId, subject })),
    cutoutExport: (
      photoId: string,
      recipe: CutoutRecipe,
      developSettings: object,
      format: "png" | "jpeg",
    ) => call<ExportResult>("camera_cutout_export", { photoId, recipe, developSettings, format }),
    /**
     * 画面が描いたファイル（JPEG・PNG・XMP）を保存ダイアログで選んだ場所へ書く。バイト列は raw IPC で送り、名前は
     * `x-niho-file-name` に URL エンコードして添える。
     */
    saveFile: async (bytes: Uint8Array, fileName: string): Promise<SaveFileResult> => {
      try {
        const answer = await invoke<{ result?: unknown }>("camera_save_file", bytes, {
          headers: { "x-niho-file-name": encodeURIComponent(fileName) },
        });
        return answer?.result === "saved" ? "saved" : "cancelled";
      } catch (error) {
        throw toCameraCommandError(error);
      }
    },
    /** 旧 NIHO camera（Photo Bench）の保存した補正がこの Mac にあるか（写さない。初回の案内 1 行のため）。 */
    photoBenchEditsFound: async () => (await call<{ found: boolean }>("camera_photo_bench_edits")).found,
  };
}

export type CameraCommands = ReturnType<typeof createCameraCommands>;
