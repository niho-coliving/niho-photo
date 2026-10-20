import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { X } from "lucide-react";
import icon from "../src-tauri/icons/128x128.png";

import { BrowserPhotoEditingWorkbench } from "niho-photo-editing/editor/browser-photo-editing-workbench";
import { PhotoLibraryProvider } from "niho-photo-editing/library/photo-library-context";
import { readLocalStorageItemSafely, writeLocalStorageItemSafely } from "niho-ui/local-storage-safe";
import { AppDialogHost } from "niho-ui/components/app-dialog-host";

import { readAppInfo, type CameraAppInfo } from "./camera-bridge";
import { CameraHeaderBreadcrumb } from "./camera-header-breadcrumb";
import { CameraUpdateNotice, type WatchUpdate } from "./camera-update-notice";
import { createCameraCommands, type CameraCommands } from "./local-library/commands";
import { createLocalPhotoEditingHost } from "./local-library/local-photo-editing-host";
import { createLocalPhotoCutoutHost } from "./local-library/local-photo-cutout-host";
import { createLocalPhotoLibrary } from "./local-library/local-photo-library";

/** 初回の案内（旧 NIHO camera の補正は引き継がない）を閉じたことを、この端末に覚える鍵。 */
export const PHOTO_BENCH_NOTICE_DISMISSED_KEY = "niho-camera:photo-bench-notice-dismissed";
export const PHOTO_BENCH_NOTICE_TEXT =
  "旧 NIHO camera（Photo Bench）で保存した補正は引き継がれません。写真はそのまま開いて直せます。";

type AppProps = {
  /** native のコマンド（テストで差し替える。既定は Tauri の invoke） */
  commands?: CameraCommands;
  /** テストで差し替える（既定は native の camera_app_info）。 */
  loadAppInfo?: () => Promise<CameraAppInfo | null>;
  /** テストで差し替える（既定は native の自動更新の状態。camera_update_status と update-staged の event）。 */
  watchUpdate?: WatchUpdate;
};

let defaultCommands: CameraCommands | null = null;
function cameraCommands(): CameraCommands {
  defaultCommands ??= createCameraCommands();
  return defaultCommands;
}

function createQueryClient(): QueryClient {
  // この Mac の native の呼び出しは通信ではないので、失敗をすぐ見せる（やり直しは 1 回だけ）
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/**
 * 初回の案内（spec「データ（この Mac）」）: 旧 NIHO camera（Photo Bench）の補正がこの Mac にあれば、閉じるまで 1 行出す。閉じたら
 * この端末に覚えて二度と出さない（覚えられない環境では、その起動の間だけ消す）。
 */
function usePhotoBenchNotice(commands: Pick<CameraCommands, "photoBenchEditsFound">) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (readLocalStorageItemSafely(PHOTO_BENCH_NOTICE_DISMISSED_KEY) !== null) return;
    let active = true;
    commands.photoBenchEditsFound().then(
      (found) => {
        if (active && found) setShown(true);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [commands]);
  const dismiss = () => {
    writeLocalStorageItemSafely(PHOTO_BENCH_NOTICE_DISMISSED_KEY, new Date().toISOString());
    setShown(false);
  };
  return { shown, dismiss };
}

/**
 * NIHO photo の画面（spec「画面」）。共通の編集面（packages/photo-editing の `BrowserPhotoEditingWorkbench`）を、この Mac の
 * `PhotoLibrary`（native のフォルダ・写真・現像）と同梱の wasm で動かす。左にフォルダ、中央に写真、右に補正（どれも編集面の部品）。
 * 窓のタイトルバーにアイコンと名前を一度だけ表示し、その下の帯は表示中の場所（編集面のパンくず）に使う。
 * 版は下の目立たない 1 行。自動更新で新しい版を入れたときだけ、その下に 1 行の案内。
 */
export function App({ commands, loadAppInfo = readAppInfo, watchUpdate }: AppProps) {
  const native = commands ?? cameraCommands();
  const library = useMemo(() => createLocalPhotoLibrary(native), [native]);
  const host = useMemo(() => createLocalPhotoEditingHost(native), [native]);
  const cutout = useMemo(() => createLocalPhotoCutoutHost(native, library.withStablePhoto), [library, native]);
  const [queryClient] = useState(createQueryClient);
  const [appInfo, setAppInfo] = useState<CameraAppInfo | null>(null);
  const notice = usePhotoBenchNotice(native);

  useEffect(() => {
    let active = true;
    void loadAppInfo().then((info) => {
      if (active) setAppInfo(info);
    });
    return () => {
      active = false;
    };
  }, [loadAppInfo]);

  return (
    <QueryClientProvider client={queryClient}>
      <AppDialogHost />
      <div className="flex h-full flex-col">
        <div className="photo-titlebar" data-tauri-drag-region>
          <img src={icon} alt="" draggable={false} />
          <h1 data-tauri-drag-region>NIHO photo</h1>
        </div>
        <header
          className="flex h-11 shrink-0 select-none items-center gap-3 border-b border-niho-border px-3 sm:px-4"
          data-tauri-drag-region
        >
          <div className="min-w-0 flex-1" data-tauri-drag-region>
            <CameraHeaderBreadcrumb />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-auto px-4 pt-3">
          <CameraUpdateNotice watch={watchUpdate} />
          {notice.shown ? (
            <div
              role="status"
              className="mb-3 flex items-center gap-3 rounded-xl border border-niho-border bg-white px-4 py-2.5 text-sm text-niho-text-sub"
            >
              <p className="min-w-0 flex-1">{PHOTO_BENCH_NOTICE_TEXT}</p>
              <button
                type="button"
                aria-label="案内を閉じる"
                onClick={notice.dismiss}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
          <PhotoLibraryProvider library={library} host={host}>
            <BrowserPhotoEditingWorkbench
              spotId="local"
              actorId="local"
              canEdit
              cloudOriginalsAllowed={false}
              active
              openCloudPhotoId={null}
              onOpenCloudPhotoHandled={() => undefined}
              disableCloudDelete
              cutout={cutout}
            />
          </PhotoLibraryProvider>
        </main>
        <footer className="flex h-7 shrink-0 items-center justify-end px-4 text-xs text-niho-text-muted">
          {appInfo ? <span>版 {appInfo.appVersion}</span> : null}
        </footer>
      </div>
    </QueryClientProvider>
  );
}
