import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { watchUpdate as watchNativeUpdate, type UpdateStatus } from "./camera-bridge";

export type WatchUpdate = (handler: (status: UpdateStatus) => void) => Promise<() => void>;

export function updateNoticeText(version: string): string {
  return `新しい版 ${version} を入れました。閉じて開き直すと切り替わります。`;
}

/**
 * 自動更新の案内（C5 #18393。新しい版は起動時に native が裏で取得し、アプリを閉じるときに差し替えて、次に開いたときに
 * 切り替わる。起動中は差し替えない・updater.rs）。取得したときだけ、窓の上に 1 行出す（閉じられる・再起動はしない）。自動更新を使っていない（updater の公開鍵が
 * 未設定・開発ビルド・E2E）ときは何も出さない。
 */
export function CameraUpdateNotice({ watch = watchNativeUpdate }: { watch?: WatchUpdate }) {
  const [staged, setStaged] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    watch((status) => {
      // 差し替えた版だけを拾う（今の状態の読み出しが event より後に届いても、差し替え前へ戻さない）
      if (status.enabled && status.stagedVersion) setStaged(status.stagedVersion);
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      })
      // 案内が出ないだけ（更新そのものは native の側で済んでいる）
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [watch]);

  if (!staged || dismissed === staged) return null;
  return (
    <div
      role="status"
      className="mb-3 flex items-center gap-3 rounded-xl border border-niho-border bg-white px-4 py-2.5 text-sm text-niho-text-sub"
    >
      <p className="min-w-0 flex-1">{updateNoticeText(staged)}</p>
      <button
        type="button"
        aria-label="更新の案内を閉じる"
        onClick={() => setDismissed(staged)}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-niho-text-muted transition hover:bg-niho-pale/60 hover:text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
