/**
 * NIHO photo の `PhotoEditingCutoutHost`。共通編集面の写真 key（entryId）を、LocalPhotoLibrary が開いて保持する native の
 * photoId へ解決してから Tauri command を呼ぶ。パスは受けない・返さない。
 */
import type { PhotoEditingCutoutHost } from "niho-photo-editing/photo-cutout";

import { CameraCommandError, type CameraCommands } from "./commands";

export type WithStablePhoto = <T>(photoKey: string, run: (photoId: string) => Promise<T>) => Promise<T>;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") return new DOMException("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

let operationSequence = 0;
function operationId(): string {
  operationSequence += 1;
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now()}-${operationSequence}`;
  return `detect-${random}`;
}

export function createLocalPhotoCutoutHost(
  commands: Pick<
    CameraCommands,
    "cutoutLoadRecipe" | "cutoutSaveRecipe" | "cutoutDetect" | "cutoutCancel" | "cutoutReadMask" | "cutoutExport"
  >,
  withPhoto: WithStablePhoto,
): PhotoEditingCutoutHost {
  // 共通編集面はこの Mac の写真も cloudKey(entryId) で識別する。native の一覧 ID へ戻すのは、この接続境界だけ。
  const withEditorPhoto: WithStablePhoto = async (photoKey, run) => {
    const prefix = "cloud:";
    if (!photoKey.startsWith(prefix) || photoKey.length === prefix.length) {
      throw new CameraCommandError("invalidRequest", "写真を開き直してからお試しください。");
    }
    return withPhoto(photoKey.slice(prefix.length), run);
  };
  return {
    loadRecipe: (photoKey) => withEditorPhoto(photoKey, (photoId) => commands.cutoutLoadRecipe(photoId)),
    saveRecipe: (photoKey, recipe) => withEditorPhoto(photoKey, (photoId) => commands.cutoutSaveRecipe(photoId, recipe)),
    detect: (photoKey, signal) => {
      if (signal.aborted) return Promise.reject(abortError(signal));
      const id = operationId();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (run: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          run();
        };
        const onAbort = () => {
          // native がまだ photoId を開いている途中でも、下の signal の確認で detect を始めない。既に走っていればプロセスグループを止める。
          void commands.cutoutCancel(id).catch(() => undefined);
          finish(() => reject(abortError(signal)));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void withEditorPhoto(photoKey, (photoId) => {
          if (signal.aborted) throw abortError(signal);
          return commands.cutoutDetect(photoId, id);
        }).then(
          (detection) => finish(() => resolve(detection)),
          (error) => finish(() => reject(signal.aborted ? abortError(signal) : error)),
        );
      });
    },
    readMask: (photoKey, subject) => withEditorPhoto(photoKey, (photoId) => commands.cutoutReadMask(photoId, subject)),
    exportFullSize: async (photoKey, request) => {
      const result = await withEditorPhoto(photoKey, (photoId) =>
        commands.cutoutExport(photoId, request.recipe, request.settings, request.format),
      );
      return result.saved ? result : { saved: false, fileName: "" };
    },
  };
}
