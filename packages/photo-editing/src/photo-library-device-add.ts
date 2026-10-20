import type { PhotoLibraryDeviceAddFailure, PhotoLibraryDeviceCandidate } from "./library/photo-library";
import { describePhotoCloudAddRawPairedJpegs } from "./photo-library-messages";

/**
 * この Mac の写真を足す（接続口 `PhotoLibrary` の `device`。K2 移行元設計）の、編集面が状態欄に出す 1 行と空きの事前確認（NIHO camera
 * C1 移行元設計 で web の desktop-cloud-add から移した。足す流れそのものは写真の出どころが持つ）。
 */

/** 状態欄に出す、終わりの 1 行（優先は 止めた理由 > 失敗 > 入れなかった写真）。 */
export type MacCloudAddSummary =
  | { kind: "stopped"; text: string }
  | { kind: "failed"; failures: PhotoLibraryDeviceAddFailure[] }
  | { kind: "notice"; text: string };

/** フォルダが上限を超え、読めた分だけを追加した（NIHO Desktop の面の木の「表示しきれないフォルダ・写真があります」と同じ言い方）。 */
export const MAC_FOLDER_TRUNCATED_NOTICE = "追加しきれないフォルダ・写真がありました";
/** この Mac の写真を追加している途中は、面に落とした写真を受けない（ファイルの追加と同時には走らせない）。 */
export const MAC_PHOTOS_ADDING_DROP_REASON = "この Mac の写真を追加し終わってから追加できます";

/** 足す写真の合計バイト（空きの事前確認。大きさの分からない写真は数えない）。 */
export function sumMacCloudAddBytes(candidates: readonly Pick<PhotoLibraryDeviceCandidate, "sizeBytes">[]): number {
  return candidates.reduce(
    (total, candidate) =>
      total + (candidate.sizeBytes !== null && Number.isFinite(candidate.sizeBytes) && candidate.sizeBytes > 0 ? candidate.sizeBytes : 0),
    0,
  );
}

/**
 * 終わりに状態欄へ出すもの（出すものが無ければ null）。選ぶときに開けなかった写真も失敗に入れる。入れなかった写真は、フォルダの
 * 上限を超えた分と RAW と同じ写真の JPEG。
 */
export function summarizeMacCloudAdd(result: {
  stopMessage: string | null;
  failures: readonly PhotoLibraryDeviceAddFailure[];
  rawPairedJpegCount: number;
  truncated: boolean;
}): MacCloudAddSummary | null {
  if (result.stopMessage) return { kind: "stopped", text: result.stopMessage };
  if (result.failures.length > 0) return { kind: "failed", failures: [...result.failures] };
  const notices: string[] = [];
  if (result.truncated) notices.push(MAC_FOLDER_TRUNCATED_NOTICE);
  if (result.rawPairedJpegCount > 0) notices.push(describePhotoCloudAddRawPairedJpegs(result.rawPairedJpegCount));
  return notices.length > 0 ? { kind: "notice", text: notices.join("。") } : null;
}
