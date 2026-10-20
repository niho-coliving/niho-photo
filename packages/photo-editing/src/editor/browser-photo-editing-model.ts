import { isBrowserCloudPhotoInPlace, type BrowserCloudPlace } from "../browser-photo-cloud-source";
import type { BrowserPhotoExportFormat } from "../browser-photo-export";
import {
  BROWSER_PHOTO_PREVIEW_LONG_EDGE,
  BrowserPhotoSourceError,
  describeBrowserPhotoSourceError,
  type BrowserDecodedPhoto,
} from "../browser-photo-source";
import { DevelopEngineError } from "../develop-engine/develop-engine-client";
import type { DevelopOpenSettingsSource } from "../develop-engine/develop-open-settings";
import type { DevelopSettings } from "../develop-engine/develop-settings";
import type { DevelopSettingsSaver } from "../develop-engine/develop-settings-autosave";
import {
  copyDevelopWorkingCopyInput,
  type DevelopRenderInput,
  type DevelopWorkingCopyInput,
} from "../develop-engine/develop-render-input";
import type { WorkWait } from "../develop-engine/develop-work-wait";
import type { PhotoCloudAddProgress } from "../photo-cloud-add-queue";
import {
  PHOTO_EDITING_BASE_CONTROL_KEYS,
  type PhotoEditingControlKey,
} from "../photo-editing-adjustments";
import { PHOTO_EDITING_EFFECT_KEYS } from "../photo-editing-effects";
import { PHOTO_EDITING_EXPORT_PNG_FAILED_TEXT } from "../photo-editing-copy";
import type {
  PhotoLibraryDeviceAddFailure,
  PhotoLibraryDeviceCandidate,
  PhotoLibraryErrors,
  PhotoLibraryItem,
  PhotoLibraryPhoto,
} from "../library/photo-library";
import type { PhotoEditingPhoto } from "../photo-editing-types";
import { BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS, BrowserCloudOriginalError } from "../photo-original-files";

/**
 * ブラウザ版の写真編集の型と純粋な関数（移行元設計 で `browser-photo-editing-workbench.tsx` から分けた）。面・hook の間で
 * 受け渡す形はここに置く。
 */

/** 一覧のタイル 1 枚（クラウドの写真。追加している途中の写真を含む）。 */
export type BrowserItem = {
  key: string;
  photo: PhotoLibraryItem;
  /** クラウドのプレビューを読み直すまで出す、手元で作ったプレビュー（object URL） */
  localPreviewUrl: string | null;
  /** 追加している途中（上げ終わるまで選べない） */
  adding: boolean;
};

/** このタブで追加した写真（一覧を読み直して同じ行が載るまで、先頭に出す）。 */
export type AddedPhoto = {
  photo: PhotoLibraryItem;
  previewUrl: string | null;
  adding: boolean;
};

/**
 * wasm で直す写真の入力（移行元設計 / 移行元設計）。JPEG・小さな PNG は不変のオリジナル、RAW・HEIC / HEIF・TIFF・大きな PNG と作業コピーで
 * 直す JPEG（`isDevelopWorkTarget`。K5-a 移行元設計）は作業コピー（16bit PNG か ICC 付きの 8bit JPEG・メタデータ・土台の版。
 * {@link DevelopWorkingCopyInput}）。書き出しにはコピーを渡す。
 */
export type DevelopSourceInput = { kind: "original"; file: File } | DevelopWorkingCopyInput;

export type OpenedSource = {
  key: string;
  fileName: string;
  decoded: BrowserDecodedPhoto | null;
  viewUrl: string | null;
  /** wasm の最初の画が canvas に出るまで、クラウドの仮のプレビューを見せる。 */
  previewPending?: boolean;
  /** 表示中の補正後プレビューが、開いた写真の保存済み補正と同じ版か。 */
  previewCurrent?: boolean;
  /** ブラウザで直せない理由（右パネルの代わりに 1 行）。直せる写真では null */
  lockedReason: string | null;
  /** 1024px 以上で開いた（補正の入力を確かめた）。狭い幅で開いた写真は、広げたときに読み直す */
  loadedForEditing: boolean;
  /**
   * 描き方（移行元設計）。`wasm` は段 2 の wasm で描いて写真に自動保存する、`canvas` は S1 の canvas（段 2 を用意できなかった。
   * 保存せず書き出しだけ）。閲覧だけの写真・作業コピーを待っている写真は null
   */
  mode: "wasm" | "canvas" | null;
  /** 補正の入力（オリジナルか作業コピー。wasm のときだけ。書き出しにはコピーを渡す） */
  input: DevelopSourceInput | null;
  /**
   * 作業コピーで直す写真が、作業コピーを待っている間の状態（その間はクラウドのプレビューを見せ、揃ったら 1 回だけ描いた画に
   * 差し替える。移行元設計）。ほかは null
   */
  work: WorkWait | null;
  /** 開いた時点のクラウドの写真（`download.photo`。wasm のときだけ） */
  photo: PhotoLibraryPhoto | null;
};

/**
 * オリジナル（JPEG / 小さな PNG）を wasm に開いた作業サイズ（F3 移行元設計）。切り抜きのある写真は、切り抜いてもプレビューが
 * {@link DEVELOP_PREVIEW_MAX_DIMENSION} に届く大きさで開く（wasm の `rasterDecodeSize`）。切り抜きが変わって足りなくなったら同じ
 * オリジナルを開き直し、この値を書き換える（`ensureOriginalWorkingSize`。session は ref で持つので、その場で書き換える）。
 */
export type DevelopOriginalWorking = {
  /** `engine.open` に渡した長辺 */
  maxDimension: number;
  /** オリジナルの寸法（向きは反映済み。wasm の `imageSize`。まだ読んでいなければ null） */
  originalSize: { width: number; height: number } | null;
};

/**
 * wasm で開いている 1 枚（移行元設計）。自動保存と、書き出し・補正後のプレビュー（K3 移行元設計）に使う入力と開いた時点の写真を持つ。
 * 一覧へ戻っても開いた写真と一緒に残し、別の写真を開く・場所を変える・画面を離れるときに手放す。
 */
export type DevelopSession = {
  key: string;
  photoId: string;
  spotId: string;
  /** 補正の入力（オリジナルか作業コピー） */
  input: DevelopSourceInput;
  /** オリジナルを wasm に開いた作業サイズ（作業コピーは原寸のまま持つので null） */
  working: DevelopOriginalWorking | null;
  /**
   * 作業コピーを wasm に開いた大きさ（原寸のまま持つ。読めなければ null。オリジナルは null で、寸法は `working.originalSize`）。
   * 切り抜きの道具の座標の基準と、書き出しの大きさの 1 行に使う（F3b 移行元設計）
   */
  workSize: { width: number; height: number } | null;
  /** 開いた時点のクラウドの写真（今の行を読み直す手がかり。補正後のプレビューを上げ直すかもこの行で決める） */
  photo: PhotoLibraryPhoto;
  /**
   * 開いたときに使った補正（写真 1 枚に補正 1 つ・置き場は `developSettings` の 1 つ。K1c 移行元設計）。`develop` は保存してある
   * `developSettings`、`none` は補正を保存したことが無い写真（補正なしで開いた）
   */
  settingsSource: DevelopOpenSettingsSource;
  /** 自動保存（閲覧のみの operator は null。保存も補正後のプレビューを上げることもしない） */
  saver: DevelopSettingsSaver | null;
};

/**
 * 1 枚で開いた結果（wasm で直すなら、その編集）と、開いたときの編集内容（wasm は開いたときの `developSettings`、無ければ
 * neutral。S1 の canvas・閲覧だけの写真は neutral）。
 */
export type OpenResult = { opened: OpenedSource; session: DevelopSession | null; settings: DevelopSettings };

/** 開くときに使う補正（スライダーを重ねる土台と、保存してある補正から始めたか）。扱えなければ閉じる理由。 */
export type OpenSettings =
  | { kind: "settings"; baseSettings: DevelopSettings | null; settingsSource: DevelopSession["settingsSource"] }
  | { kind: "locked"; lockedReason: string };

/** 作業コピーを確かめた結果（開いた・閉じた結果か、まだ待つ状態。移行元設計）。 */
export type WorkOutcome = { kind: "opened"; result: OpenResult } | { kind: "wait"; work: WorkWait };

/** 追加している 1 枚（予約が返ったらそのタイルに送った割合を重ねる）。 */
export type AddingProgress = PhotoCloudAddProgress & {
  photoId: string | null;
  fraction: number | null;
};

/** 「再試行」でもう一度入れるもの（ファイル選択・ドロップのファイルか、この Mac の写真。K2 移行元設計）。 */
export type AddRetry = { kind: "files"; files: File[] } | { kind: "mac"; photos: PhotoLibraryDeviceCandidate[] };

/** 状態欄の 1 行の後ろの文字のボタン（一括の補正の［元に戻す］。F5a-2 移行元設計）。 */
export type FooterStatusAction = { label: string; onClick: () => void };

export type FooterStatus =
  | { kind: "notice"; text: string; action?: FooterStatusAction }
  | { kind: "error"; text: string; action?: FooterStatusAction }
  | { kind: "addFailed"; text: string; retry: AddRetry };

/**
 * 書き出し・消している途中・一覧で選んだ複数枚に一括で補正を当てている途中（`bulk`。F5a-2 移行元設計）。その間はほかの操作を止める。
 */
export type BrowserPhotoOperation = {
  kind: BrowserPhotoOperationKind;
  fileName: string;
  deleting: boolean;
  /** 一括書き出しなど、ファイル名だけでは表せない進み具合。 */
  progressText?: string;
};

/** 止めている操作の種類（`operationRef` に入れる）。 */
export type BrowserPhotoOperationKind = "export" | "delete" | "bulk" | "copy";

export type BrowserViewMode = "grid" | "loupe";

/** 右パネルの道具（補正 / 切り抜き。F3b 移行元設計。背景除去は NIHO camera だけ。C4 移行元設計）。 */
export type BrowserPhotoTool = "adjust" | "crop" | "cutout";

/** 非同期の処理が終わったときに確かめる、最新の権限と拠点。 */
export type BrowserPhotoAccess = { canEdit: boolean; cloudOriginalsAllowed: boolean; spotId: string };

/** 画面を離れる前に呼ぶ確かめ（false なら離れない。開いた写真の保存・破棄の確認を済ませる）。 */
export type PhotoEditingLeaveGuard = () => Promise<boolean>;

/**
 * 離れる前の確かめを、アプリの殻の遷移（web は admin の route。`AdminRouteLeaveGuardRegistrar` と同じ形）に登録する口。null で外す。
 */
export type PhotoEditingLeaveGuardRegistrar = (guard: PhotoEditingLeaveGuard | null) => void;

export type ArrowKeyEvent = { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void };

export type BrowserNavigationApi = EventTarget & {
  currentEntry?: { key?: string | null };
  traverseTo?: (key: string) => { finished?: Promise<unknown> };
};

export type BrowserNavigationEvent = Event & {
  canIntercept?: boolean;
  navigationType?: string;
  hashChange?: boolean;
  destination?: { key?: string };
};

export const WIDE_MIN_WIDTH_PX = 1024;
export const DISCARD_DESCRIPTION = "書き出していない補正は失われます。";
/** 段 2 で描く長辺（プレビューと同じ 1280px。持っておく写真もこの大きさに縮める） */
export const DEVELOP_PREVIEW_MAX_DIMENSION = BROWSER_PHOTO_PREVIEW_LONG_EDGE;
/** 切り抜きのある写真のオリジナルを開く作業サイズの上限（crate の一発の描画の既定 `decodeCap` と同じ 4096px） */
export const DEVELOP_GEOMETRY_WORKING_CAP = 4096;
export const DEVELOP_SAVE_FAILED_TEXT = "保存できませんでした";
export const DEVELOP_SAVE_DROPPED_FALLBACK = "補正を保存できませんでした。";
/** お気に入り（♥）を付け外しできなかった（元に戻して状態欄に 1 行。F5b 移行元設計） */
export const FAVORITE_FAILED_TEXT = "お気に入りを変更できませんでした。";
export const ADD_ACCEPT = BROWSER_CLOUD_ORIGINAL_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",");

/**
 * S1 の canvas（段 2 の wasm を使えない）の右パネルに出す項目（露光量・コントラスト・彩度と、相対の色温度・色かぶり補正）。
 * wasm で開いた写真は 13 項目を全部出す（NIHO Photo 段 1 F1 移行元設計）。
 */
export const BROWSER_CANVAS_ADJUSTMENT_KEYS: ReadonlyArray<PhotoEditingControlKey> = [
  "exposure",
  "contrast",
  "saturation",
  "relativeTemperature",
  "relativeTint",
];
/**
 * 効果のある設定（v: 3）を読める wasm（`engine.supportsEffects()`）で開いた写真の右パネルに出す項目: 基本の 13 項目と、白黒・
 * 周辺光量補正・粒子・粒子のサイズ（NIHO Photo 段 1 E1b 移行元設計）。読めない wasm は効果のある設定（v: 3）の描画を断る（保存しても描けない写真ができる）
 * ので、確かめられるまで・描けない wasm では 13 項目のまま（`visibleKeys` を渡さない）。粒子のサイズ（`grainSize`）は PC だけの項目
 * （今の右パネルは 1024px 以上でしか出ないので常に入る。スマホの面〔F6c〕はこのキーを外して渡す）。
 */
export const BROWSER_EFFECTS_ADJUSTMENT_KEYS: ReadonlyArray<PhotoEditingControlKey> = [
  ...PHOTO_EDITING_BASE_CONTROL_KEYS,
  ...PHOTO_EDITING_EFFECT_KEYS,
];
/** ブラウザは RAW も相対で直すので、絶対の白は使わない（撮影時の白を渡さない。RAW の K 表示は S11 の後の別の slice）。 */
export const BROWSER_WHITE_BALANCE_SOURCE: Pick<PhotoEditingPhoto, "asShotWhiteBalance"> = { asShotWhiteBalance: null };

export function cloudKey(photoId: string): string {
  return `cloud:${photoId}`;
}

export function toListedPhoto(
  photo: PhotoLibraryPhoto,
  previewUrl: string | null = null,
): PhotoLibraryItem {
  // 準備・入れ終わりの photo には URL が付かない（記事用の画像の URL は次に一覧を読んだときに入る）
  return { ...photo, previewUrl };
}

/**
 * 木のその場所に出すか（場所の決まりは {@link isBrowserCloudPhotoInPlace} の 1 か所）。追加している途中の写真は「写真」だけ
 * （記事の画像へオリジナルを足している途中も）。
 */
export function isBrowserItemInPlace(item: BrowserItem, place: BrowserCloudPlace): boolean {
  return item.adding ? place === "photos" : isBrowserCloudPhotoInPlace(item.photo, place);
}

export function isWideWindow(): boolean {
  return typeof window === "undefined" || window.innerWidth >= WIDE_MIN_WIDTH_PX;
}

/** 並びの基準の日時（撮影日順は撮影日時、無ければ追加した日時。サーバーの `capturedOrStoredAt` と同じ）。 */
function browserItemSortTime(photo: PhotoLibraryItem): number {
  const time = Date.parse(photo.capturedAt ?? photo.createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/**
 * 一覧（読み込んだ分）の前に、このタブで追加した写真と、URL で開いた写真（一覧の先頭のページに無いとき）を並べる。
 * 追加日順（既定）は、追加した写真がいちばん新しいので先頭。撮影日順は、追加中の写真だけを先頭に出し、追加し終えた写真は
 * 読み込んだ一覧の撮影日順の位置に入れる（古い撮影日の写真を追加して、先頭に居座らせない）。
 */
export function buildBrowserItems(
  addedPhotos: readonly AddedPhoto[],
  photos: readonly PhotoLibraryItem[],
  deepLinkedPhoto: PhotoLibraryItem | null,
  sort: "added" | "captured" = "added",
): BrowserItem[] {
  const listedById = new Map(photos.map((photo) => [photo.id, photo]));
  const seen = new Set<string>();
  const result: BrowserItem[] = [];
  const settled: BrowserItem[] = [];
  for (const added of addedPhotos) {
    if (seen.has(added.photo.id)) continue;
    seen.add(added.photo.id);
    const listed = listedById.get(added.photo.id);
    (sort === "captured" && !added.adding ? settled : result).push({
      key: cloudKey(added.photo.id),
      // URL は一覧の行にだけ付く（追加の応答の補正後のプレビューは URL が null）ので、載っていれば一覧の方を使う
      photo: {
        ...added.photo,
        previewUrl: listed?.previewUrl ?? added.photo.previewUrl,
        editedPreview: listed?.editedPreview ?? added.photo.editedPreview,
      },
      localPreviewUrl: added.previewUrl,
      adding: added.adding,
    });
  }
  if (deepLinkedPhoto && !seen.has(deepLinkedPhoto.id) && !listedById.has(deepLinkedPhoto.id)) {
    seen.add(deepLinkedPhoto.id);
    result.push({ key: cloudKey(deepLinkedPhoto.id), photo: deepLinkedPhoto, localPreviewUrl: null, adding: false });
  }
  const listedItems: BrowserItem[] = [];
  for (const photo of photos) {
    if (seen.has(photo.id)) continue;
    seen.add(photo.id);
    listedItems.push({ key: cloudKey(photo.id), photo, localPreviewUrl: null, adding: false });
  }
  // 追加し終えた写真（撮影日順のとき）は、読み込んだ一覧の撮影日順（新しい順）の位置へ（同じ日時なら、今追加した方を前に）
  // 同じ日時の写真は、新しく足した順（`addedPhotos` は新しい順）を保つよう、古い方から入れる
  for (const item of [...settled].reverse()) {
    const time = browserItemSortTime(item.photo);
    const index = listedItems.findIndex((listed) => browserItemSortTime(listed.photo) <= time);
    listedItems.splice(index === -1 ? listedItems.length : index, 0, item);
  }
  return [...result, ...listedItems];
}

/**
 * 「クラウドから消す」の確かめの本文。記事で使っている数が読めたら、残る画像の文の代わりに添える。記事の画像のうち補正
 * （`developSettings`）を保存してある写真は、クラウドの補正の内容も消えることを添える（K1c 移行元設計。旧エンジンの `hasSettings` は無い）。
 */
export function describeDeleteConfirm(photo: PhotoLibraryItem, articleUsage: string | null): string {
  const contents = photo.hasOriginal
    ? "オリジナルと補正の内容も消えます。"
    : photo.hasDevelopSettings
      ? "補正の内容も消えます。"
      : "";
  return `${photo.fileName} を消します。${contents}${articleUsage ?? "記事の本文で使っている画像は残ります。"}`;
}

/** 追加できなかった写真（状態欄。もう一度試せる写真があれば「再試行」を添える）。 */
export function describeAddFailures(
  failures: readonly { file: File; retryable: boolean; message: string }[],
): FooterStatus {
  return describeFailedAdds(
    failures.map((failure) => ({
      fileName: failure.file.name,
      message: failure.message,
      retry: failure.retryable ? failure.file : null,
    })),
    (files) => ({ kind: "files", files }),
  );
}

/** この Mac から追加できなかった写真（K2 移行元設計。ファイルの追加と同じ 1 行。「再試行」は入れ直せる写真だけ）。 */
export function describeMacAddFailures(failures: readonly PhotoLibraryDeviceAddFailure[]): FooterStatus {
  return describeFailedAdds(failures, (photos) => ({ kind: "mac", photos }));
}

function describeFailedAdds<T>(
  failures: readonly { fileName: string; message: string; retry: T | null }[],
  toRetry: (items: T[]) => AddRetry,
): FooterStatus {
  const [first] = failures;
  if (!first) return { kind: "error", text: "" };
  const names = failures.length === 1 ? first.fileName : `${first.fileName} ほか ${failures.length - 1} 枚`;
  const retryItems = failures.flatMap((failure) => (failure.retry === null ? [] : [failure.retry]));
  if (retryItems.length === 0) {
    return {
      kind: "error",
      text: failures.length === 1 && first.message ? `${names} を追加できませんでした。${first.message}` : `${names} を追加できませんでした`,
    };
  }
  return { kind: "addFailed", text: `${names} を追加できませんでした`, retry: toRetry(retryItems) };
}

/**
 * 書き出せなかった理由の 1 行。置き場（クラウドは API）が断った失敗は写真の出どころの言い方（`errors.describeStorageError`。移行元設計）。
 */
export function describeExportFailure(
  error: unknown,
  format: BrowserPhotoExportFormat,
  errors: Pick<PhotoLibraryErrors, "describeStorageError">,
): string {
  if (error instanceof BrowserCloudOriginalError) return error.message;
  // PNG は背景除去を当てた書き出しだけ（NIHO camera。C4 移行元設計）
  const encodeFailed =
    format === "png" ? PHOTO_EDITING_EXPORT_PNG_FAILED_TEXT : "JPEG を書き出せませんでした。もう一度お試しください。";
  if (error instanceof BrowserPhotoSourceError) {
    return error.reason === "encode_failed" ? encodeFailed : describeBrowserPhotoSourceError(error);
  }
  const fallback =
    format === "original" ? "オリジナルをダウンロードできませんでした。もう一度お試しください。" : encodeFailed;
  const storage = errors.describeStorageError(error, fallback);
  if (storage !== null) return storage;
  // 段 2 の wasm の失敗（英語の理由）は画面に出さない
  if (error instanceof DevelopEngineError) return fallback;
  return error instanceof Error && error.message ? error.message : fallback;
}

/** 開いている写真の入力を、Worker へ渡すコピーにする（Worker は受け取った bytes を手放す）。 */
export async function copyDevelopInput(input: DevelopSourceInput): Promise<DevelopRenderInput> {
  return input.kind === "workingCopy"
    ? copyDevelopWorkingCopyInput(input)
    : { kind: "original", bytes: await input.file.arrayBuffer() };
}

/** 作業コピーの上で直している写真の土台の版（オリジナルから直接描く写真は null。`developSettings.base` と同じ）。 */
export function developBaseVersion(input: DevelopSourceInput | null): string | null {
  return input?.kind === "workingCopy" ? input.baseVersion : null;
}

/**
 * 一覧のタイルの画（K3 移行元設計）。補正後のプレビューのタイル（今の補正の画。切り抜き・回転も入っている）、無ければ補正前の
 * プレビュー（クラウドのもの、読み直すまでは手元で作ったもの）。補正前のプレビューには保存済みの幾何を CSS で当てる
 * （`photoEditingTileGeometry`。補正後のプレビューのタイルを出す写真には当てない）。
 */
export function browserPhotoTileUrl(item: BrowserItem): string | null {
  // 補正の置き場は developSettings の 1 つなので、旧エンジンの settings の日時とは比べない（K1c 移行元設計）
  const editedPreview = item.photo.editedPreview;
  return editedPreview?.thumbUrl ?? item.photo.previewUrl ?? item.localPreviewUrl;
}

/**
 * 作業コピーで直す写真を開いた瞬間（補正後のプレビューがあれば今の補正の画、無ければクラウドのプレビューを見せ、作業コピーを
 * 確かめる。描いた画が揃ったら差し替えるので、補正後のプレビューなら見た目が跳ねない。K3 移行元設計）。
 */
export function workPreviewOpened(item: BrowserItem): OpenedSource {
  const editedPreview = item.photo.editedPreview;
  return {
    key: item.key,
    fileName: item.photo.fileName,
    decoded: null,
    viewUrl: editedPreview?.url ?? item.photo.previewUrl ?? item.localPreviewUrl,
    lockedReason: null,
    loadedForEditing: true,
    mode: null,
    input: null,
    photo: null,
    work: { phase: "opening" },
  };
}
