"use client";

import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import { ConfirmDialog } from "niho-ui/components/confirm-dialog";
import { usePhotoLibrary } from "../library/photo-library-context";
import {
  PHOTO_EDITING_PRESET_CROP_NOT_SAVED_TEXT,
  PHOTO_EDITING_PRESET_DIALOG_CANCEL_LABEL,
  PHOTO_EDITING_PRESET_INCLUDE_EXPOSURE_LABEL,
  PHOTO_EDITING_PRESET_INCLUDE_WHITE_BALANCE_LABEL,
  PHOTO_EDITING_PRESET_NAME_LABEL,
  PHOTO_EDITING_PRESET_NEUTRAL_SAVE_TEXT,
  PHOTO_EDITING_PRESET_RENAME_CONFIRM_LABEL,
  PHOTO_EDITING_PRESET_RENAME_LABEL,
  PHOTO_EDITING_PRESET_RENAMING_LABEL,
  PHOTO_EDITING_PRESET_SAVE_CURRENT_LABEL,
  PHOTO_EDITING_PRESET_SAVE_LABEL,
  PHOTO_EDITING_PRESET_SAVING_LABEL,
  photoEditingPresetNameTooLongText,
} from "../photo-editing-copy";

/** 保存・名前の変更の結果（失敗は、同じ名前〔入力の下に出す〕か、それ以外の理由〔ダイアログの下に出す〕）。 */
export type PhotoEditingPresetDialogResult = { ok: true } | { ok: false; nameTaken: boolean; message: string };

/** 今の補正をプリセットに保存するときの入力。 */
export type PhotoEditingPresetSaveInput = { name: string; includeExposure: boolean; includeWhiteBalance: boolean };

/**
 * メニューの項目から開いたダイアログを閉じたら、フォーカスを開いた「⋯」へ戻す（開く前にフォーカスがあった項目はメニューごと
 * 消えているので、既定のままだと body に落ちる）。戻し先が無い・消えていれば既定のまま。
 */
export function returnDialogFocus(event: Event, returnFocusRef: RefObject<HTMLElement | null> | undefined): void {
  const target = returnFocusRef?.current;
  if (!target || !target.isConnected) return;
  event.preventDefault();
  target.focus();
}

/**
 * 名前の入力の検証（前後の空白を除いて 1〜`maxChars` 文字。写真の出どころのプリセットの名前の上限。クラウドは 100）。入れた名前と、
 * 長すぎるときの 1 行。
 */
function readPresetName(text: string, maxChars: number): { name: string; tooLong: string | null } {
  const name = text.trim();
  return {
    name,
    tooLong: name.length > maxChars ? photoEditingPresetNameTooLongText(maxChars) : null,
  };
}

const NAME_INPUT_CLASS_NAME =
  "block min-h-11 w-full rounded-xl border border-niho-border bg-white px-3 text-sub text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:opacity-50";
const FIELD_LABEL_CLASS_NAME = "mb-1 block text-xs font-bold text-niho-text-sub";

/** 名前の入力欄（ラベル・入力・その下の 1 行）。Enter で確定する（IME の変換の Enter では確定しない）。 */
function PresetNameField(props: {
  value: string;
  disabled: boolean;
  error: string | null;
  selectOnFocus?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const inputId = useId();
  const errorId = useId();
  return (
    <div>
      <label htmlFor={inputId} className={FIELD_LABEL_CLASS_NAME}>
        {PHOTO_EDITING_PRESET_NAME_LABEL}
      </label>
      <input
        id={inputId}
        type="text"
        autoFocus
        autoComplete="off"
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errorId : undefined}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onFocus={props.selectOnFocus ? (event) => event.currentTarget.select() : undefined}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          props.onSubmit();
        }}
        className={NAME_INPUT_CLASS_NAME}
      />
      {props.error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs leading-relaxed text-niho-danger">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 「今の補正をプリセットに保存」（ブラウザ版の右パネル。NIHO Photo 段 1 F2b 移行元設計）。名前（必須）と、露光量・ホワイトバランスを
 * 含めるか（既定はオフ）。何も当てていない補正（`neutral`）は保存できない。開くたびに `key` を変えて入力を空から始める。
 */
export function PhotoEditingPresetSaveDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  neutral: boolean;
  onSave: (input: PhotoEditingPresetSaveInput) => Promise<PhotoEditingPresetDialogResult>;
  /** 閉じたらフォーカスを戻す要素（開いた「⋯」） */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const presetNameMaxChars = usePhotoLibrary().presets.nameMaxChars;
  const [text, setText] = useState("");
  const [includeExposure, setIncludeExposure] = useState(false);
  const [includeWhiteBalance, setIncludeWhiteBalance] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { name, tooLong } = readPresetName(text, presetNameMaxChars);
  const canSave = !props.neutral && name.length > 0 && tooLong === null && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setNameError(null);
    const result = await props.onSave({ name, includeExposure, includeWhiteBalance });
    setSaving(false);
    if (result.ok) {
      props.onOpenChange(false);
      return;
    }
    if (result.nameTaken) setNameError(result.message);
    else setError(result.message);
  };

  const checkbox = (label: string, checked: boolean, onChange: (checked: boolean) => void) => (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sub text-niho-text">
      <input
        type="checkbox"
        checked={checked}
        disabled={saving}
        onChange={(event) => onChange(event.currentTarget.checked)}
        className="h-4 w-4 shrink-0 accent-niho-accent-ink"
      />
      {label}
    </label>
  );

  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={PHOTO_EDITING_PRESET_SAVE_CURRENT_LABEL}
      confirmLabel={PHOTO_EDITING_PRESET_SAVE_LABEL}
      pendingLabel={PHOTO_EDITING_PRESET_SAVING_LABEL}
      cancelLabel={PHOTO_EDITING_PRESET_DIALOG_CANCEL_LABEL}
      confirmDisabled={!canSave}
      isPending={saving}
      errorMessage={error}
      onConfirm={() => void save()}
      onCloseAutoFocus={(event) => returnDialogFocus(event, props.returnFocusRef)}
    >
      <PresetNameField
        value={text}
        disabled={saving}
        error={nameError ?? tooLong}
        onChange={(value) => {
          setText(value);
          setNameError(null);
        }}
        onSubmit={() => void save()}
      />
      <div>
        {checkbox(PHOTO_EDITING_PRESET_INCLUDE_EXPOSURE_LABEL, includeExposure, setIncludeExposure)}
        {checkbox(PHOTO_EDITING_PRESET_INCLUDE_WHITE_BALANCE_LABEL, includeWhiteBalance, setIncludeWhiteBalance)}
      </div>
      <p className="text-xs leading-relaxed text-niho-text-sub">{PHOTO_EDITING_PRESET_CROP_NOT_SAVED_TEXT}</p>
      {props.neutral ? (
        <p className="text-xs font-bold leading-relaxed text-niho-text-sub">{PHOTO_EDITING_PRESET_NEUTRAL_SAVE_TEXT}</p>
      ) : null}
    </ConfirmDialog>
  );
}

/**
 * 拠点のプリセットの「名前を変更」（ブラウザ版の右パネル）。今の名前を入れて全選択で始める。同じ名前のままは変えない。開くたびに
 * `key` を変えて今の名前から始める。
 */
export function PhotoEditingPresetRenameDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentName: string;
  onRename: (name: string) => Promise<PhotoEditingPresetDialogResult>;
  /** 閉じたらフォーカスを戻す要素（開いた「⋯」） */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const presetNameMaxChars = usePhotoLibrary().presets.nameMaxChars;
  const [text, setText] = useState(props.currentName);
  const [renaming, setRenaming] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { name, tooLong } = readPresetName(text, presetNameMaxChars);
  const canRename = name.length > 0 && name !== props.currentName.trim() && tooLong === null && !renaming;

  const rename = async () => {
    if (!canRename) return;
    setRenaming(true);
    setError(null);
    setNameError(null);
    const result = await props.onRename(name);
    setRenaming(false);
    if (result.ok) {
      props.onOpenChange(false);
      return;
    }
    if (result.nameTaken) setNameError(result.message);
    else setError(result.message);
  };

  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={PHOTO_EDITING_PRESET_RENAME_LABEL}
      confirmLabel={PHOTO_EDITING_PRESET_RENAME_CONFIRM_LABEL}
      pendingLabel={PHOTO_EDITING_PRESET_RENAMING_LABEL}
      cancelLabel={PHOTO_EDITING_PRESET_DIALOG_CANCEL_LABEL}
      confirmDisabled={!canRename}
      isPending={renaming}
      errorMessage={error}
      onConfirm={() => void rename()}
      onCloseAutoFocus={(event) => returnDialogFocus(event, props.returnFocusRef)}
    >
      <PresetNameField
        value={text}
        disabled={renaming}
        error={nameError ?? tooLong}
        selectOnFocus
        onChange={(value) => {
          setText(value);
          setNameError(null);
        }}
        onSubmit={() => void rename()}
      />
    </ConfirmDialog>
  );
}
