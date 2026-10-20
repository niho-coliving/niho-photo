"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";

import { ConfirmDialog } from "./confirm-dialog";
import {
  getAppDialogSnapshot,
  registerAppDialogHost,
  subscribeAppDialogRequests,
  type AppConfirmWithCheckboxOptions,
  type AppConfirmWithCheckboxResult,
  type AppDialogSnapshot,
  type AppPromptOptions,
} from "../app-dialog";

const SERVER_SNAPSHOT: AppDialogSnapshot = { active: null, shown: null };
const getServerSnapshot = () => SERVER_SNAPSHOT;

/**
 * appDialog の依頼を表示する共有 host。各アプリのルートに1つだけ置く（移行元設計）。
 * 見た目は共通の ConfirmDialog。閉じたあとも直前の依頼を描き続け、閉じるアニメーションを残す。
 *
 * `container` を渡すと、ダイアログをその要素の中に描く（Tailwind の utilities を特定の要素の中に閉じているアプリ。例: NIHO docs の
 * `.docs-account`）。省略時は従来どおり body。
 */
export function AppDialogHost({ container }: { container?: HTMLElement | null } = {}) {
  const { active, shown } = useSyncExternalStore(subscribeAppDialogRequests, getAppDialogSnapshot, getServerSnapshot);

  useEffect(() => registerAppDialogHost(), []);

  if (!shown) return null;
  const open = active !== null && active.id === shown.id;

  switch (shown.kind) {
    case "confirm": {
      const { options } = shown;
      return (
        <ConfirmDialog
          key={shown.id}
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) shown.settle(false);
          }}
          title={options.title}
          description={options.description}
          confirmLabel={options.confirmLabel}
          cancelLabel={options.cancelLabel}
          variant={options.variant}
          onConfirm={() => shown.settle(true)}
          container={container}
        />
      );
    }
    case "confirmWithCheckbox":
      return (
        <AppConfirmWithCheckboxDialog
          key={shown.id}
          open={open}
          options={shown.options}
          onSettle={shown.settle}
          container={container}
        />
      );
    case "prompt":
      return (
        <AppPromptDialog
          key={shown.id}
          open={open}
          options={shown.options}
          onSettle={shown.settle}
          container={container}
        />
      );
    case "choose": {
      const { options } = shown;
      const [first, second] = options.choices;
      return (
        <ConfirmDialog
          key={shown.id}
          open={open}
          onOpenChange={(nextOpen) => { if (!nextOpen) shown.settle(null); }}
          title={options.title}
          description={options.description}
          confirmLabel={first.label}
          variant={first.variant}
          onConfirm={() => shown.settle(first.value)}
          alternativeLabel={second.label}
          alternativeVariant={second.variant}
          onAlternative={() => shown.settle(second.value)}
          cancelLabel={options.cancelLabel ?? "閉じる"}
          container={container}
        />
      );
    }
    case "alert": {
      const { options } = shown;
      return (
        <ConfirmDialog
          key={shown.id}
          open={open}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) shown.settle();
          }}
          title={options.title}
          // 失敗の通知は title に短い要約、description に API の詳しい文言を渡す。API の文言が無く要約と同じなら出さない。
          description={options.description === options.title ? undefined : options.description}
          confirmLabel={options.closeLabel ?? "閉じる"}
          hideCancel
          onConfirm={() => shown.settle()}
          container={container}
        />
      );
    }
  }
}

/**
 * チェックの欄つきの確認（`appDialog.confirmWithCheckbox`）。native の checkbox を label で包み（文字も押せる）、
 * 説明は欄の下に置いて `aria-describedby` で結ぶ。チェックは既定でオフ。
 */
function AppConfirmWithCheckboxDialog({
  open,
  options,
  onSettle,
  container,
}: {
  open: boolean;
  options: AppConfirmWithCheckboxOptions;
  onSettle: (result: AppConfirmWithCheckboxResult) => void;
  container?: HTMLElement | null;
}) {
  const checkboxId = useId();
  const descriptionId = useId();
  const [checked, setChecked] = useState(false);
  const { checkbox } = options;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onSettle(null);
      }}
      title={options.title}
      description={options.description}
      confirmLabel={options.confirmLabel}
      cancelLabel={options.cancelLabel}
      variant={options.variant}
      onConfirm={() => onSettle({ checked })}
      container={container}
    >
      <div className="rounded-2xl border border-niho-border bg-niho-surface-subtle px-3 py-2" data-app-dialog-checkbox>
        <label htmlFor={checkboxId} className="flex cursor-pointer items-center gap-3 py-1.5 text-body font-bold text-niho-text">
          <input
            id={checkboxId}
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
            aria-describedby={checkbox.description ? descriptionId : undefined}
            className="h-5 w-5 shrink-0 cursor-pointer accent-niho-accent-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink focus-visible:ring-offset-2"
          />
          <span>{checkbox.label}</span>
        </label>
        {checkbox.description ? (
          <p id={descriptionId} className="pb-1 pl-8 text-sub leading-[1.7] text-niho-text-sub">
            {checkbox.description}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

function AppPromptDialog({
  open,
  options,
  onSettle,
  container,
}: {
  open: boolean;
  options: AppPromptOptions;
  onSettle: (value: string | null) => void;
  container?: HTMLElement | null;
}) {
  const inputId = useId();
  const [value, setValue] = useState(options.defaultValue ?? "");
  const canConfirm = options.canConfirm ? options.canConfirm(value) : true;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onSettle(null);
      }}
      title={options.title}
      description={options.description}
      confirmLabel={options.confirmLabel}
      cancelLabel={options.cancelLabel}
      variant={options.variant}
      confirmDisabled={!canConfirm}
      onConfirm={() => onSettle(value)}
      container={container}
    >
      <form
        className="space-y-2"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (canConfirm) onSettle(value);
        }}
      >
        <label htmlFor={inputId} className="block text-sub font-bold text-niho-dark">
          {options.inputLabel}
        </label>
        <input
          id={inputId}
          type={options.inputType ?? "text"}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={options.placeholder}
          autoFocus
          autoComplete="off"
          className="min-h-11 w-full rounded-xl border border-[#E6E6E0] bg-white px-3 text-body text-[#1C1C1A] transition focus:border-[#BCD499] focus:outline-none focus:ring-2 focus:ring-[#BCD499]/40"
        />
      </form>
    </ConfirmDialog>
  );
}
