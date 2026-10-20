"use client"

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { X } from "lucide-react"

import { cn } from "../cn"
import { useDismissLayer } from "../dismiss-layers"

const Dialog = ({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) => {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [controlledOpen, onOpenChange])

  useDismissLayer(open, () => handleOpenChange(false))

  return <DialogPrimitive.Root {...props} open={open} onOpenChange={handleOpenChange} />
}
Dialog.displayName = DialogPrimitive.Root.displayName

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // Keep dialogs above both default sheets (z-50) and living module panels (up to z-[131]).
      // This prevents nested detail modals from opening behind a menu-owned page sheet.
      "fixed inset-0 z-[150] bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

type DialogContentProps = React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> & {
  hideClose?: boolean
  closeButtonClassName?: string
  overlayClassName?: string
  /**
   * モバイルで near-full-height にするダイアログ向けの opt-in。中央寄せ(100dvh)を
   * やめて `--niho-safe-area-*`(+12px) の間に top/bottom をピン留めし、ステータス
   * バー/ノッチ裏に閉じるボタン(top-4)や上下端が食い込むのを防ぐ。sm 以上は従来の
   * 中央寄せへ戻る。呼び出し側は desktop 高さ(`sm:h-[...]`)と `overflow`/`flex` 等
   * だけを渡せばよい。詳細は design-guide §5 Safe Area。
   */
  mobileSafeArea?: boolean
  /** Portal の描き先（省略時は body）。Tailwind を特定の要素の中に閉じているアプリ（NIHO docs の `.docs-account`）が渡す。 */
  container?: HTMLElement | null
}

type DialogContentVariantProps = DialogContentProps & {
  variant?: "default" | "slidein-left"
}

const DEFAULT_DIALOG_CONTENT_SCROLL_CLASS =
  "max-h-[85dvh] overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"

function shouldUseDefaultDialogContentScroll(className: string | undefined): boolean {
  if (!className) return true
  const classTokens = className.split(/\s+/).filter(Boolean)
  return !classTokens.some(
    (token) =>
      token.startsWith("max-h-") ||
      token.startsWith("h-") ||
      token.startsWith("min-h-") ||
      token.startsWith("overflow-"),
  )
}

// `mobileSafeArea` の実体。モバイルは中央寄せ(base の top-50%/translate-y-[-50%])を
// やめ、safe-area inset(+12px) の間に top/bottom をピン留めして高さを top/bottom の差
// から導出する(`100dvh` はステータスバー/ノッチ裏まで及ぶため、中央寄せだと既定の
// 閉じるボタン(top-4)や上下端が被り領域に入る)。sm 以上で従来の中央寄せへ戻す。
// twMerge(cn) により base の `top-[50%]`/`translate-y-[-50%]` を後勝ちで上書きする。
// 実値は native バイナリ注入の `--niho-safe-area-*` を正とし、未注入(ブラウザ/PWA/
// テスト)では `env(...,0px)` にフォールバックする(design-guide §5 Safe Area)。
const MOBILE_SAFE_AREA_DIALOG_CONTENT_CLASS =
  "top-[calc(var(--niho-safe-area-top,env(safe-area-inset-top,0px))+12px)] bottom-[calc(var(--niho-safe-area-bottom,env(safe-area-inset-bottom,0px))+12px)] translate-y-0 sm:top-[50%] sm:bottom-auto sm:translate-y-[-50%]"

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentVariantProps
>(({ className, children, hideClose, closeButtonClassName, overlayClassName, variant = "default", mobileSafeArea, container, ...props }, ref) => {
  // `mobileSafeArea` は自前で高さ/overflow を管理する(top/bottom ピン留め)ため、
  // 既定の `max-h-[85dvh]` スクロールクラスは付与しない(bottom ピンと競合させない)。
  const defaultScrollClass =
    !mobileSafeArea && shouldUseDefaultDialogContentScroll(className)
      ? DEFAULT_DIALOG_CONTENT_SCROLL_CLASS
      : undefined

  return (
    <DialogPortal container={container ?? undefined}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          // z-[150] matches DialogOverlay and stays above living menu/module sheets.
          variant === "slidein-left"
            ? "fixed left-[50%] top-[50%] z-[150] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg"
            : "fixed left-[50%] top-[50%] z-[150] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
          mobileSafeArea && MOBILE_SAFE_AREA_DIALOG_CONTENT_CLASS,
          defaultScrollClass,
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            className={cn(
              "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground",
              closeButtonClassName
            )}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
})
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-body text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
