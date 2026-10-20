import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, Loader2, RotateCcw } from "lucide-react";

import { cn } from "../cn";

type ModalActionBannerTone = "error" | "warning" | "info" | "success";

const toneClasses: Record<ModalActionBannerTone, { shell: string; icon: string; pill: string }> = {
  error: {
    shell: "border-[#F4CDC4] bg-white/75 text-[#8C3425] shadow-[0_1px_10px_rgba(140,52,37,0.08)]",
    icon: "text-[#B84532]",
    pill: "border-[#F4CDC4] bg-[#FFF5F2] text-[#8C3425]",
  },
  warning: {
    shell: "border-[#F2D9A6] bg-white/75 text-[#8A5A12] shadow-[0_1px_10px_rgba(138,90,18,0.08)]",
    icon: "text-[#A86F17]",
    pill: "border-[#F2D9A6] bg-[#FFF8E8] text-[#8A5A12]",
  },
  info: {
    shell: "border-[#C8DAF2] bg-white/75 text-[#244C8A] shadow-[0_1px_10px_rgba(36,76,138,0.08)]",
    icon: "text-[#2F65B6]",
    pill: "border-[#C8DAF2] bg-[#F1F6FF] text-[#244C8A]",
  },
  success: {
    shell: "border-[#CFE5BE] bg-white/75 text-[#2F6637] shadow-[0_1px_10px_rgba(47,102,55,0.08)]",
    icon: "text-[#3B7C43]",
    pill: "border-[#CFE5BE] bg-[#F3FAEF] text-[#2F6637]",
  },
};

const toneIcons: Record<ModalActionBannerTone, typeof AlertCircle> = {
  error: AlertCircle,
  warning: AlertCircle,
  info: Info,
  success: CheckCircle2,
};

export function ModalActionBanner({
  tone = "error",
  statusLabel,
  title,
  message,
  action,
  className,
  "data-slot": dataSlot,
}: {
  tone?: ModalActionBannerTone;
  statusLabel?: string;
  title?: string;
  message: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean };
  className?: string;
  "data-slot"?: string;
}) {
  const Icon = toneIcons[tone];
  const classes = toneClasses[tone];

  return (
    <div
      role={tone === "error" || tone === "warning" ? "alert" : "status"}
      aria-live={tone === "error" || tone === "warning" ? "assertive" : "polite"}
      data-slot={dataSlot}
      className={cn(
        "flex gap-3 rounded-[16px] border px-3.5 py-3 text-sub leading-relaxed backdrop-blur-[18px]",
        classes.shell,
        className
      )}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", classes.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {statusLabel ? (
            <span className={cn("inline-flex min-h-6 items-center rounded-full border px-2 text-xs font-extrabold", classes.pill)}>
              {statusLabel}
            </span>
          ) : null}
          {title ? <div className="text-sub font-extrabold">{title}</div> : null}
        </div>
        <div className={cn("whitespace-pre-wrap text-sub text-niho-text-sub", title || statusLabel ? "mt-1" : "")}>{message}</div>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled || action.loading}
            className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-current/20 bg-white/80 px-3 text-xs font-bold transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BCD499]/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {action.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
