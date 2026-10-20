/**
 * NIHO photo のアプリの都合（編集面の `PhotoEditingHost`。packages/photo-editing/src/library/photo-library-context.tsx）。
 *
 * - 端末への保存（ブラウザで描いた JPEG・XMP など）は native の保存ダイアログ（`camera_save_file`）。「オリジナル」は library が
 *   native でファイルを写し終えているので、その結果を返すだけ（{@link takeNativeSaveResult}）
 * - 編集面の外の画面は無い（`notifyPhotosChanged` は何もしない）。スマホの面・スマホアプリの保存は無い。Mac のアプリ
 */
import type { PhotoEditingHost } from "niho-photo-editing/library/photo-library-context";

import type { CameraCommands } from "./commands";
import { takeNativeSaveResult } from "./local-photo-library";

export function createLocalPhotoEditingHost(commands: Pick<CameraCommands, "saveFile">): PhotoEditingHost {
  return {
    notifyPhotosChanged: () => undefined,
    saveFile: async ({ blob, fileName }) => {
      const saved = takeNativeSaveResult(blob);
      if (saved) return saved;
      return commands.saveFile(new Uint8Array(await blob.arrayBuffer()), fileName);
    },
    nativeFileSaveAvailable: () => false,
    isNativeViewport: () => false,
    isDesktopApp: () => true,
  };
}
