"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { cn } from "niho-ui/cn";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "niho-ui/components/dialog";

import type { CloudClient, CloudResourceRef, ShareListItem } from "../cloud-sharing-contract";
import {
  PhotoCloudShareController,
  type PhotoCloudSharingAccess,
  type PhotoCloudShareState,
} from "../cloud-sharing-controller";

import {
  PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME,
  PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
  PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";

export interface BrowserPhotoCloudSharingBinding {
  readonly client: CloudClient;
  readonly access: PhotoCloudSharingAccess;
  /** Trusted host selector only. The server must still authorize every field. */
  readonly selectResource: (photoId: string) => CloudResourceRef | null;
}

const EXPIRY_OPTIONS = [
  { days: 1, label: "24時間" },
  { days: 7, label: "7日間" },
  { days: 30, label: "30日間" },
] as const;

const PANEL_CLASS_NAME = "rounded-2xl border border-niho-border bg-niho-pale/30 p-4";

function formatExpiry(expiresAt: string): string {
  const value = Date.parse(expiresAt);
  if (!Number.isFinite(value)) return "有効期限を確認できません";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function shareStatus(item: ShareListItem): { label: string; inactive: boolean } {
  if (item.revokedAt) return { label: "停止済み", inactive: true };
  if (Date.parse(item.expiresAt) <= Date.now()) return { label: "期限切れ", inactive: true };
  return { label: `${formatExpiry(item.expiresAt)}まで`, inactive: false };
}

function StateNotice(props: { state: PhotoCloudShareState }) {
  const { state } = props;
  if (!state.message) return null;
  const error = [
    "retryable-failure",
    "nonretryable-failure",
    "offline",
    "signed-out",
    "not-found-permission",
    "quota",
    "expired",
  ].includes(state.phase);
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "rounded-xl px-3 py-2 text-sm font-bold leading-relaxed",
        error ? "bg-niho-danger/10 text-niho-danger" : "bg-niho-pale/60 text-niho-text-sub",
      )}
    >
      {state.message}
    </p>
  );
}

function ShareList(props: {
  state: PhotoCloudShareState;
  confirmingShareId: string | null;
  onConfirmingShareIdChange: (shareId: string | null) => void;
  onRevoke: (shareId: string) => void;
  onRefresh: () => void;
  onLoadMore: () => void;
}) {
  const busy = props.state.phase === "listing" || props.state.phase === "revoking" || props.state.mutationInFlight || props.state.listLoadingMore;
  return (
    <section aria-labelledby="photo-cloud-share-list-heading" className={PANEL_CLASS_NAME}>
      <div className="flex items-center justify-between gap-3">
        <h3 id="photo-cloud-share-list-heading" className="text-sm font-bold text-niho-text">
          共有中のリンク
        </h3>
        <button
          type="button"
          disabled={busy}
          onClick={props.onRefresh}
          className={PHOTO_EDITING_TEXT_BUTTON_CLASS_NAME}
        >
          更新
        </button>
      </div>
      {props.state.phase === "listing" ? (
        <p role="status" className="mt-2 text-sm text-niho-text-sub">共有一覧を読み込み中…</p>
      ) : props.state.items.length === 0 ? (
        <p className="mt-2 text-sm text-niho-text-muted">
          {props.state.nextCursor
            ? "さらに表示すると、他の共有を確認できます。"
            : props.state.phase === "target-confirmation" || props.state.reconciliationNeeded
            ? "更新すると、現在の共有を確認できます。"
            : "共有中のリンクはありません。"}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {props.state.items.map((item) => {
            const status = shareStatus(item);
            const confirming = props.confirmingShareId === item.shareId;
            const revoking = props.state.phase === "revoking" && props.state.pendingRevokeShareId === item.shareId;
            return (
              <li key={item.shareId} className="rounded-xl border border-niho-border bg-white px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className={cn("text-sm font-bold", status.inactive ? "text-niho-text-muted" : "text-niho-text")}>{status.label}</p>
                  {!status.inactive ? (
                    <button
                      type="button"
                      disabled={busy}
                      aria-expanded={confirming}
                      onClick={() => props.onConfirmingShareIdChange(confirming ? null : item.shareId)}
                      className={PHOTO_EDITING_DANGER_GHOST_BUTTON_CLASS_NAME}
                    >
                      {revoking ? "停止中…" : "共有を停止"}
                    </button>
                  ) : null}
                </div>
                {confirming ? (
                  <div role="group" aria-label="共有停止の確認" className="mt-3 border-t border-niho-border pt-3">
                    <p className="text-sm leading-relaxed text-niho-text-sub">このリンクは使えなくなります。共有を停止しますか？</p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => props.onConfirmingShareIdChange(null)}
                        className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}
                      >
                        やめる
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => props.onRevoke(item.shareId)}
                        className="inline-flex h-11 items-center rounded-full bg-niho-danger px-4 text-sm font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-50"
                      >
                        停止する
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {props.state.nextCursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={props.onLoadMore}
          className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-3 h-11")}
        >
          {props.state.listLoadingMore ? "読み込み中…" : "さらに表示"}
        </button>
      ) : null}
    </section>
  );
}

export function BrowserPhotoCloudShareSheet(props: {
  binding: BrowserPhotoCloudSharingBinding;
  photoId: string;
  onClose: () => void;
}) {
  const target = useMemo(() => props.binding.selectResource(props.photoId), [props.binding, props.photoId]);
  const controller = useMemo(() => new PhotoCloudShareController({
    client: props.binding.client,
    access: "unavailable",
    target: null,
  }), [props.binding.client]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [expiryDays, setExpiryDays] = useState(7);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [confirmingShareId, setConfirmingShareId] = useState<string | null>(null);

  useEffect(() => {
    setCopyStatus(null);
    setConfirmingShareId(null);
    controller.setAccess(props.binding.access);
    controller.setTarget(target);
  }, [controller, props.binding.access, target]);

  useEffect(() => () => controller.dispose(), [controller]);

  const close = () => {
    controller.close();
    props.onClose();
  };
  const create = () => {
    setCopyStatus(null);
    controller.create(new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString());
  };
  const available = props.binding.access === "available" && target !== null;
  const mutationBusy = state.phase === "creating" || state.phase === "revoking";
  const showCreate = available && !state.reconciliationNeeded && (state.phase === "target-confirmation" || state.phase === "ready");
  const showList = available && ["target-confirmation", "created", "listing", "ready", "revoking", "cancelled"].includes(state.phase);
  const canRefreshRecovery = available && ["quota", "expired", "nonretryable-failure"].includes(state.phase);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent
        mobileSafeArea
        onEscapeKeyDown={(event) => { if (mutationBusy) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (mutationBusy) event.preventDefault(); }}
        hideClose={mutationBusy}
        className="flex w-[calc(100vw-1.5rem)] max-w-[520px] flex-col gap-0 overflow-hidden rounded-[24px] border border-niho-border bg-white p-0 shadow-xl sm:max-h-[min(760px,calc(100dvh-3rem))] sm:translate-y-[-50%]"
      >
        <DialogHeader className="shrink-0 border-b border-niho-border px-5 pb-4 pt-5 pr-14 text-left">
          <DialogTitle className="text-lg font-bold text-niho-text">写真をリンクで共有</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-niho-text-sub">
            選んだクラウド写真を共有します。リンクを知っている人は写真を見ることができます。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <StateNotice state={state} />

          {showCreate ? (
            <section aria-labelledby="photo-cloud-share-create-heading" className={PANEL_CLASS_NAME}>
              <h3 id="photo-cloud-share-create-heading" className="text-sm font-bold text-niho-text">共有する写真を確認</h3>
              <p className="mt-1 text-sm leading-relaxed text-niho-text-sub">今選んでいる1枚の写真です。写真や利用者の情報は入力しません。</p>
              <label className="mt-4 block text-xs font-bold text-niho-text-sub" htmlFor="photo-cloud-share-expiry">
                有効期限
              </label>
              <select
                id="photo-cloud-share-expiry"
                value={expiryDays}
                onChange={(event) => setExpiryDays(Number(event.currentTarget.value))}
                className="mt-1 h-11 w-full rounded-xl border border-niho-border bg-white px-3 text-sm font-bold text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
              >
                {EXPIRY_OPTIONS.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
              </select>
              <button
                type="button"
                disabled={state.mutationInFlight}
                onClick={create}
                className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "mt-4 h-11 w-full justify-center")}
              >
                共有リンクを作る
              </button>
            </section>
          ) : null}

          {state.phase === "creating" ? (
            <section aria-busy className={PANEL_CLASS_NAME}>
              <p role="status" className="text-sm font-bold text-niho-text">共有リンクを作成中…</p>
              <p className="mt-1 text-sm leading-relaxed text-niho-text-sub">画面を閉じずにお待ちください。</p>
              <button
                type="button"
                onClick={() => controller.cancel()}
                className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-4 h-11")}
              >
                待機を中止
              </button>
            </section>
          ) : null}

          {state.phase === "revoking" ? (
            <section aria-busy className={PANEL_CLASS_NAME}>
              <p role="status" className="text-sm font-bold text-niho-text">共有を停止中…</p>
              <p className="mt-1 text-sm leading-relaxed text-niho-text-sub">停止の結果を確認しています。</p>
              <button
                type="button"
                onClick={() => controller.cancel()}
                className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-4 h-11")}
              >
                待機を中止
              </button>
            </section>
          ) : null}

          {state.phase === "created" && state.shareUrl ? (
            <section aria-labelledby="photo-cloud-share-created-heading" className={PANEL_CLASS_NAME}>
              <h3 id="photo-cloud-share-created-heading" className="text-sm font-bold text-niho-text">共有リンクができました</h3>
              <p className="mt-1 text-sm leading-relaxed text-niho-text-sub">このリンクは後から再表示できません。画面を閉じる前にコピーしてください。</p>
              <label htmlFor="photo-cloud-share-url" className="mt-3 block text-xs font-bold text-niho-text-sub">共有リンク</label>
              <input
                id="photo-cloud-share-url"
                readOnly
                value={state.shareUrl}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-1 h-11 w-full rounded-xl border border-niho-border bg-white px-3 text-sm text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
              />
              <button
                type="button"
                onClick={() => {
                  const url = state.shareUrl;
                  if (!url) return;
                  void navigator.clipboard.writeText(url).then(
                    () => setCopyStatus("共有リンクをコピーしました。"),
                    () => setCopyStatus("コピーできませんでした。リンクを選んでコピーしてください。"),
                  );
                }}
                className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "mt-3 h-11 w-full justify-center")}
              >
                リンクをコピー
              </button>
              {copyStatus ? <p role="status" className="mt-2 text-sm font-bold text-niho-text-sub">{copyStatus}</p> : null}
            </section>
          ) : null}

          {state.phase === "retryable-failure" ? (
            <button type="button" onClick={() => controller.retry()} className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-11")}>
              もう一度試す
            </button>
          ) : null}

          {canRefreshRecovery ? (
            <button type="button" onClick={() => controller.refresh()} className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-11")}>
              共有一覧を更新
            </button>
          ) : null}

          {state.phase === "cancelled" ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => controller.refresh()} className={cn(PHOTO_EDITING_PRIMARY_BUTTON_CLASS_NAME, "h-11")}>
                共有一覧を更新
              </button>
              {state.resumableMutation ? (
                <button
                  type="button"
                  disabled={state.mutationInFlight}
                  onClick={() => controller.resumeMutation()}
                  className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11")}
                >
                  処理を再開
                </button>
              ) : null}
            </div>
          ) : null}

          {showList ? (
            <ShareList
              state={state}
              confirmingShareId={confirmingShareId}
              onConfirmingShareIdChange={setConfirmingShareId}
              onRevoke={(shareId) => {
                setConfirmingShareId(null);
                controller.revoke(shareId);
              }}
              onRefresh={() => controller.refresh()}
              onLoadMore={() => controller.loadMore()}
            />
          ) : null}

          {state.phase === "ready" && state.reconciliationNeeded && state.resumableMutation ? (
            <div className={PANEL_CLASS_NAME}>
              <p className="text-sm leading-relaxed text-niho-text-sub">
                一覧で完了を確認できない場合は、同じ操作として安全に再開できます。
              </p>
              <button
                type="button"
                disabled={state.mutationInFlight}
                onClick={() => controller.resumeMutation()}
                className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "mt-3 h-11")}
              >
                処理を再開
              </button>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-niho-border px-5 py-3">
          <button
            type="button"
            disabled={mutationBusy}
            onClick={close}
            className={cn(PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME, "h-11 w-full")}
          >
            閉じる
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
