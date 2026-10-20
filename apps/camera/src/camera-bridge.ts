/**
 * NIHO photo の画面から native（src-tauri）のアプリの情報と自動更新の状態を読む口。Tauri の import はこのファイルと、この Mac の
 * PhotoLibrary の native の口（local-library/commands.ts）だけに置く（編集面の packages/photo-editing は Tauri を import しない。spec 決まりごと 6）。
 * コマンドの許可は src-tauri/permissions/camera.toml と capabilities/default.json。
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** Tauri の event の購読（戻り値で購読をやめる）。 */
export type Listen = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

export type CameraAppInfo = {
  appVersion: string;
};

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** `camera_app_info` の答えを確かめて返す。形が違えば null（版の 1 行を出さないだけで、画面は止めない）。 */
export async function readAppInfo(invoke: Invoke = tauriInvoke): Promise<CameraAppInfo | null> {
  try {
    const info = await invoke<unknown>("camera_app_info");
    if (typeof info !== "object" || info === null) return null;
    const appVersion = (info as { appVersion?: unknown }).appVersion;
    return typeof appVersion === "string" && VERSION_RE.test(appVersion) ? { appVersion } : null;
  } catch {
    return null;
  }
}

/**
 * 自動更新の状態（src-tauri/src/updater.rs）。起動時の確認が新しい版を取得して差し替えると stagedVersion が入り、
 * 次に開いたときにその版になる。enabled が false（updater の公開鍵が未設定・開発ビルド・E2E）なら画面には何も出さない。
 */
export type UpdateStatus = { enabled: boolean; stagedVersion: string | null };

/** updater.rs の STAGED_EVENT（差し替えたときに native が送る）。 */
export const UPDATE_STAGED_EVENT = "update-staged";

function parseUpdateStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const { enabled, stagedVersion } = value as { enabled?: unknown; stagedVersion?: unknown };
  if (typeof enabled !== "boolean") return null;
  if (stagedVersion !== null && !(typeof stagedVersion === "string" && VERSION_RE.test(stagedVersion))) return null;
  return { enabled, stagedVersion };
}

/**
 * 自動更新の状態を受ける（今の状態と、新しい版を差し替えたとき）。形の違う答えは捨てる。戻り値で購読をやめる。
 * 先に購読してから今の状態を読む（読むまでのあいだに差し替わっても取りこぼさない）。
 */
export async function watchUpdate(
  handler: (status: UpdateStatus) => void,
  { invoke = tauriInvoke, listen = tauriListen }: { invoke?: Invoke; listen?: Listen } = {},
): Promise<() => void> {
  const unlisten = await listen<unknown>(UPDATE_STAGED_EVENT, (event) => {
    const status = parseUpdateStatus(event.payload);
    if (status) handler(status);
  });
  try {
    const status = parseUpdateStatus(await invoke<unknown>("camera_update_status"));
    if (status) handler(status);
  } catch (error) {
    unlisten();
    throw error;
  }
  return unlisten;
}
