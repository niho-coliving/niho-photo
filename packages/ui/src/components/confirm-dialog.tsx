"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { ModalActionBanner } from "./modal-action-banner";
import { cn } from "../cn";

type ConfirmDialogVariant = "default" | "danger";

const confirmButtonClasses: Record<ConfirmDialogVariant, string> = {
  default: "niho-primary-surface",
  danger: "bg-[#8C3425] text-white hover:bg-[#763023]",
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  confirmDisabled = false,
  cancelLabel = "キャンセル",
  hideCancel = false,
  isPending = false,
  dismissDisabled = false,
  onConfirm,
  alternativeLabel,
  alternativeVariant = "default",
  onAlternative,
  variant = "default",
  errorMessage,
  className,
  onCloseAutoFocus,
  container,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  confirmDisabled?: boolean;
  cancelLabel?: string;
  /** 閉じるだけの通知（ボタン1つ）にする。 */
  hideCancel?: boolean;
  isPending?: boolean;
  dismissDisabled?: boolean;
  onConfirm: () => void;
  alternativeLabel?: string;
  alternativeVariant?: ConfirmDialogVariant;
  onAlternative?: () => void;
  variant?: ConfirmDialogVariant;
  errorMessage?: ReactNode;
  className?: string;
  /** 閉じたときのフォーカスの戻し先を変える（メニューの項目から開いたときなど、開く前の要素がもう無い場合）。 */
  onCloseAutoFocus?: (event: Event) => void;
  /** ダイアログを描く先（省略時は body）。Tailwind を特定の要素に閉じているアプリ（NIHO docs）が渡す。 */
  container?: HTMLElement | null;
}) {
  const confirmClickLockedRef = useRef(false);
  const pendingRef = useRef(isPending);
  const dismissLocked = isPending || dismissDisabled;

  useEffect(() => {
    pendingRef.current = isPending;
    if (!isPending) confirmClickLockedRef.current = false;
  }, [isPending]);

  const handleConfirmClick = () => {
    if (isPending || confirmDisabled || confirmClickLockedRef.current) return;
    confirmClickLockedRef.current = true;
    onConfirm();
    window.setTimeout(() => {
      if (!pendingRef.current) confirmClickLockedRef.current = false;
    }, 0);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (dismissDisabled && !nextOpen) return;
        if (!isPending) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-busy={isPending || undefined}
        hideClose={dismissLocked}
        onEscapeKeyDown={(event) => {
          if (dismissLocked) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (dismissLocked) event.preventDefault();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        container={container}
        className={cn(
          "w-[calc(100vw-2rem)] max-w-[420px] overflow-hidden rounded-[24px] border border-[#ECECE6] bg-white p-0 shadow-[0_22px_60px_rgba(96,84,58,0.18)] backdrop-blur-[22px] duration-200 motion-reduce:duration-0",
          className
        )}
        closeButtonClassName="min-h-11 min-w-11 rounded-full"
      >
        <div className="px-6 pb-6 pt-6">
          <DialogHeader className="space-y-2 pr-8 text-left">
            <DialogTitle className="text-lg font-bold leading-7 text-[#1C1C1A]">{title}</DialogTitle>
            {description ? <DialogDescription className="text-sub leading-[1.7] text-[#77766D]">{description}</DialogDescription> : null}
          </DialogHeader>

          {children || errorMessage ? (
            <div className="mt-4 space-y-3">
              {children}
              {errorMessage ? <ModalActionBanner statusLabel="エラー" message={errorMessage} /> : null}
            </div>
          ) : null}

          {isPending ? (
            <span className="sr-only" role="status" aria-live="polite">
              {pendingLabel ?? "処理中です"}
            </span>
          ) : null}

          <div className={cn("mt-6 grid grid-cols-1 gap-2", !hideCancel && !alternativeLabel && "sm:grid-cols-2")}>
            {hideCancel ? null : (
              <button
                type="button"
                onClick={() => {
                  if (!dismissLocked) onOpenChange(false);
                }}
                disabled={dismissLocked}
                className="min-h-11 rounded-full border border-[#DDD8CC] bg-white px-4 text-sm font-bold text-niho-dark transition hover:bg-niho-pale focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cancelLabel}
              </button>
            )}
            {alternativeLabel ? (
              <button
                type="button"
                onClick={() => { if (!dismissLocked) onAlternative?.(); }}
                disabled={dismissLocked}
                className={cn(
                  "min-h-11 rounded-full border border-[#DDD8CC] px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
                  alternativeVariant === "danger" ? "border-transparent bg-[#8C3425] text-white hover:bg-[#763023]" : "bg-white text-niho-dark hover:bg-niho-pale",
                )}
              >
                {alternativeLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleConfirmClick}
              disabled={isPending || confirmDisabled}
              className={cn(
                "min-h-11 rounded-full px-4 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
                confirmButtonClasses[variant]
              )}
            >
              {isPending && pendingLabel ? pendingLabel : confirmLabel}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
