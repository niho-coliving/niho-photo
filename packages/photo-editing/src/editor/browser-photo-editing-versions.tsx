"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { MoreHorizontal, Plus } from "lucide-react";

import { ConfirmDialog } from "niho-ui/components/confirm-dialog";
import { cn } from "niho-ui/cn";
import type { PhotoLibraryDevelopVersion } from "../library/photo-library";
import {
  PHOTO_EDITING_RETRY_LABEL,
  PHOTO_EDITING_VERSIONS_AUTO_BADGE,
  PHOTO_EDITING_VERSIONS_CREATE_CANCEL_LABEL,
  PHOTO_EDITING_VERSIONS_CREATE_LABEL,
  PHOTO_EDITING_VERSIONS_CREATE_SUBMIT_LABEL,
  PHOTO_EDITING_VERSIONS_CURRENT_TEXT,
  PHOTO_EDITING_VERSIONS_DELETE_CONFIRM_LABEL,
  PHOTO_EDITING_VERSIONS_DELETE_DESCRIPTION,
  PHOTO_EDITING_VERSIONS_DELETE_LABEL,
  PHOTO_EDITING_VERSIONS_EMPTY_TEXT,
  PHOTO_EDITING_VERSIONS_LIMIT_TEXT,
  PHOTO_EDITING_VERSIONS_LIST_LABEL,
  PHOTO_EDITING_VERSIONS_LOAD_FAILED_TEXT,
  PHOTO_EDITING_VERSIONS_NAME_LABEL,
  PHOTO_EDITING_VERSIONS_RELOAD_LABEL,
  PHOTO_EDITING_VERSIONS_RENAME_LABEL,
  PHOTO_EDITING_VERSIONS_SAVE_FAILED_TEXT,
  PHOTO_EDITING_VERSIONS_SELECTED_TEXT,
  photoEditingVersionDeleteTitle,
  photoEditingVersionMenuLabel,
} from "../photo-editing-copy";

import {
  PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME,
  PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME,
} from "./photo-editing-button-classes";
import { PhotoEditingMenu } from "./photo-editing-menu";
import { returnDialogFocus } from "./photo-editing-preset-dialogs";
import { PhotoEditingPresetThumbnail, type PhotoEditingPresetThumbnails } from "./photo-editing-preset-thumbnail";
import {
  developVersionsNewestFirst,
  formatDevelopVersionDate,
  PHOTO_EDITING_VERSION_NAME_MAX_CHARS,
} from "./browser-photo-editing-versions-model";
import type { BrowserPhotoVersionNameResult, BrowserPhotoVersionsStatus } from "./use-browser-photo-versions";

const NAME_INPUT_CLASS_NAME =
  "block min-h-11 w-full min-w-0 rounded-xl border border-niho-border bg-white px-3 text-sub text-niho-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink";
const CREATE_BUTTON_CLASS_NAME =
  "flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-niho-border px-3 text-sub font-bold text-niho-accent-ink transition enabled:hover:bg-niho-pale/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50";
const MORE_BUTTON_CLASS_NAME =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-muted transition hover:bg-niho-pale/60 hover:text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50";
/** 行の左の小さな見た目（幅 56px・3:2・角丸。プリセットの見本と同じ部品） */
const THUMBNAIL_CLASS_NAME = "aspect-[3/2] h-auto w-14";

/** 名前の入力欄（Enter で確定。IME の変換の Enter では確定しない。Esc で取り消す）。 */
function VersionNameInput(props: {
  value: string;
  error: string | null;
  label: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onBlur?: () => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={inputId} className="sr-only">
        {props.label}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        autoComplete="off"
        maxLength={PHOTO_EDITING_VERSION_NAME_MAX_CHARS * 2}
        value={props.value}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={props.error ? errorId : undefined}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            props.onSubmit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            // 右パネルの外の Esc（1 枚の面を閉じる）まで届かせない
            event.stopPropagation();
            props.onCancel();
          }
        }}
        onBlur={props.onBlur}
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

/** 「今の補正を版にする」（押すと既定の名前の入った入力が開き、Enter か「保存」で作る）。 */
function CreateVersion(props: {
  defaultName: string;
  disabled: boolean;
  onCreate: (name: string) => BrowserPhotoVersionNameResult;
}) {
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  // 入力を閉じたら、フォーカスを「今の補正を版にする」へ戻す（入力ごと消えるので、既定のままだと body に落ちる）
  const refocusRef = useRef(false);
  const close = () => {
    refocusRef.current = true;
    setName(null);
    setError(null);
  };
  const submit = () => {
    if (name === null) return;
    const result = props.onCreate(name);
    if (result.ok) close();
    else if (result.message) setError(result.message);
  };
  // 押せなくなったら（操作の途中・写真を替えた）入力を閉じる
  useEffect(() => {
    if (!props.disabled) return;
    setName(null);
    setError(null);
  }, [props.disabled]);
  useEffect(() => {
    if (name !== null || !refocusRef.current) return;
    refocusRef.current = false;
    openButtonRef.current?.focus();
  }, [name]);
  if (name === null) {
    return (
      <button
        ref={openButtonRef}
        type="button"
        disabled={props.disabled}
        onClick={() => {
          setError(null);
          setName(props.defaultName);
        }}
        className={CREATE_BUTTON_CLASS_NAME}
      >
        <Plus className="h-4 w-4" aria-hidden />
        {PHOTO_EDITING_VERSIONS_CREATE_LABEL}
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-niho-border p-2">
      <VersionNameInput
        value={name}
        error={error}
        label={PHOTO_EDITING_VERSIONS_NAME_LABEL}
        onChange={(value) => {
          setName(value);
          setError(null);
        }}
        onSubmit={submit}
        onCancel={close}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={close} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_VERSIONS_CREATE_CANCEL_LABEL}
        </button>
        <button type="button" onClick={submit} className={PHOTO_EDITING_SECONDARY_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_VERSIONS_CREATE_SUBMIT_LABEL}
        </button>
      </div>
    </div>
  );
}

function VersionThumbnail(props: { version: PhotoLibraryDevelopVersion; thumbnails?: PhotoEditingPresetThumbnails }) {
  // 見本は (写真, 版の補正の JSON) で覚える（名前を変えても描き直さない）
  const settingsJson = useMemo(() => JSON.stringify(props.version.developSettings), [props.version.developSettings]);
  if (!props.thumbnails) return <span aria-hidden className={cn("block shrink-0 rounded-lg bg-niho-pale", THUMBNAIL_CLASS_NAME)} />;
  return (
    <PhotoEditingPresetThumbnail
      thumbnailKey={props.version.id}
      xmp={settingsJson}
      thumbnails={props.thumbnails}
      className={THUMBNAIL_CLASS_NAME}
    />
  );
}

/** 版の 1 行（行全体が切り替えのボタン。右の「⋯」で名前を変える・削除。名前を変える間は入力）。 */
function VersionRow(props: {
  version: PhotoLibraryDevelopVersion;
  selected: boolean;
  disabled: boolean;
  manageDisabled: boolean;
  renaming: boolean;
  thumbnails?: PhotoEditingPresetThumbnails;
  onSwitch: () => void;
  onStartRename: () => void;
  onRename: (name: string) => BrowserPhotoVersionNameResult;
  onEndRename: () => void;
  onDelete: (trigger: HTMLButtonElement | null) => void;
}) {
  const { version } = props;
  const auto = version.kind === "auto";
  const [draft, setDraft] = useState(version.name);
  const [error, setError] = useState<string | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  // Enter・Esc で閉じた後の blur では何もしない
  const finishedRef = useRef(false);
  useEffect(() => {
    if (!props.renaming) return;
    finishedRef.current = false;
    setDraft(version.name);
    setError(null);
  }, [props.renaming, version.name]);
  /** 名前の入力を閉じる（Enter・Esc で閉じたときは、フォーカスを行の「⋯」へ戻す） */
  const finish = (refocus: boolean) => {
    finishedRef.current = true;
    props.onEndRename();
    if (refocus) moreButtonRef.current?.focus();
  };
  const submit = () => {
    const result = props.onRename(draft);
    if (result.ok) finish(true);
    else if (result.message) setError(result.message);
  };
  const date = formatDevelopVersionDate(version.createdAt);
  return (
    <li className="flex items-center gap-1">
      {props.renaming ? (
        <div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-1 pl-1">
          <VersionThumbnail version={version} thumbnails={props.thumbnails} />
          <VersionNameInput
            value={draft}
            error={error}
            label={PHOTO_EDITING_VERSIONS_NAME_LABEL}
            onChange={(value) => {
              setDraft(value);
              setError(null);
            }}
            onSubmit={submit}
            onCancel={() => finish(true)}
            onBlur={() => {
              if (finishedRef.current) return;
              // 外を押したら、入れた名前で確定する（空・長すぎる名前は元のまま）
              props.onRename(draft);
              finish(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={props.onSwitch}
          disabled={props.disabled}
          aria-current={props.selected ? "true" : undefined}
          className={cn(
            "flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-xl py-1 pl-1 pr-2 text-left transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
            props.selected ? "bg-niho-accent-soft" : "enabled:hover:bg-niho-pale/60",
            // 選んでいる版は押せない間も薄くしない（印を読めるように）
            props.selected ? "disabled:cursor-default" : "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <VersionThumbnail version={version} thumbnails={props.thumbnails} />
          {/* 名前は行の幅いっぱい（右パネルは狭い）。日時と印（選択中・自動）は下の行に小さく */}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span
              className={cn(
                "truncate text-sub leading-snug",
                auto ? "font-medium text-niho-text-sub" : "font-bold text-niho-text",
                props.selected && !auto ? "text-niho-accent-ink" : null,
              )}
            >
              {version.name}
            </span>
            {date ? <span className="whitespace-nowrap text-xs leading-tight text-niho-text-muted">{date}</span> : null}
            {props.selected || auto ? (
              <span className="flex flex-wrap items-center gap-1 text-xs leading-tight">
                {props.selected ? (
                  <span className="font-bold text-niho-accent-ink">{PHOTO_EDITING_VERSIONS_SELECTED_TEXT}</span>
                ) : null}
                {auto ? (
                  <span className="rounded border border-niho-border px-1 font-medium text-niho-text-sub">
                    {PHOTO_EDITING_VERSIONS_AUTO_BADGE}
                  </span>
                ) : null}
              </span>
            ) : null}
          </span>
        </button>
      )}
      <PhotoEditingMenu
        variant="browser"
        align="end"
        items={[
          {
            key: "rename",
            label: PHOTO_EDITING_VERSIONS_RENAME_LABEL,
            disabled: props.manageDisabled,
            // 入力へフォーカスを移すので、閉じたときに「⋯」へ戻さない
            opensDialog: true,
            onSelect: props.onStartRename,
          },
          {
            key: "delete",
            label: PHOTO_EDITING_VERSIONS_DELETE_LABEL,
            danger: true,
            disabled: props.manageDisabled,
            opensDialog: true,
            onSelect: () => props.onDelete(moreButtonRef.current),
          },
        ]}
      >
        <button
          ref={moreButtonRef}
          type="button"
          aria-label={photoEditingVersionMenuLabel(version.name)}
          aria-haspopup="menu"
          className={MORE_BUTTON_CLASS_NAME}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
        </button>
      </PhotoEditingMenu>
    </li>
  );
}

/**
 * 右パネルの「版」の面の中身（niho-photo#42。Lightroom の「バージョン」）。上に「今の補正を版にする」、その下に版の一覧（新しい順。
 * 名前つきと自動を同じ一覧に、自動は控えめな字と「自動」の印）。
 *
 * - 行全体が切り替えのボタン（押せる範囲 56px）。今の補正と同じ版に「選択中」の印（`aria-current`）。どの版とも違えば一覧の先頭に
 *   「いまの補正（版にしていません）」の行
 * - 行の「⋯」から名前を変える（その場の入力。Enter で確定・Esc で取り消し・空は拒否）・削除（確かめてから。写真の補正は変えない）
 * - 読み込み中は `aria-busy` の空き、読めなければ控えめな 1 行と「再読み込み」。保存の失敗も控えめな 1 行と「再試行」（画面の版は
 *   そのまま）
 * - 押せない間（閲覧のみ・操作の途中）は切り替え・作成を押せない。名前の変更・削除は `manageDisabled`（閲覧のみ）のときだけ押せない
 */
export function BrowserPhotoEditingVersions(props: {
  status: BrowserPhotoVersionsStatus;
  /** 作った順（古いものが先） */
  versions: readonly PhotoLibraryDevelopVersion[];
  selectedId: string | null;
  defaultName: string;
  /** 名前つきの版が上限 */
  full: boolean;
  /** 切り替え・作成を押せない */
  disabled: boolean;
  /** 名前の変更・削除を押せない（閲覧のみ） */
  manageDisabled: boolean;
  saveFailed: boolean;
  /** 行の小さな見た目（見本を描ける wasm のときだけ。無ければ薄い面） */
  thumbnails?: PhotoEditingPresetThumbnails;
  onCreate: (name: string) => BrowserPhotoVersionNameResult;
  onRename: (id: string, name: string) => BrowserPhotoVersionNameResult;
  onDelete: (id: string) => void;
  onSwitch: (id: string) => void;
  onRetrySave: () => void;
  onReload: () => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PhotoLibraryDevelopVersion | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const ready = props.status === "ready";
  const rows = useMemo(() => developVersionsNewestFirst(props.versions), [props.versions]);

  let body;
  if (props.status === "loading") {
    body = <div aria-busy="true" className="min-h-14" />;
  } else if (props.status === "failed") {
    body = (
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="min-w-0 text-xs text-niho-text-sub">
          {PHOTO_EDITING_VERSIONS_LOAD_FAILED_TEXT}
        </p>
        <button type="button" onClick={props.onReload} className={PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME}>
          {PHOTO_EDITING_VERSIONS_RELOAD_LABEL}
        </button>
      </div>
    );
  } else if (rows.length === 0) {
    body = <p className="text-xs leading-relaxed text-niho-text-sub">{PHOTO_EDITING_VERSIONS_EMPTY_TEXT}</p>;
  } else {
    body = (
      <ul aria-label={PHOTO_EDITING_VERSIONS_LIST_LABEL} className="space-y-0.5">
        {props.selectedId === null ? (
          <li aria-current="true" className="flex min-h-14 items-center gap-3 rounded-xl bg-niho-accent-soft py-1 pl-1 pr-2">
            <span aria-hidden className={cn("block shrink-0 rounded-lg border border-dashed border-niho-border", THUMBNAIL_CLASS_NAME)} />
            <span className="min-w-0 flex-1 text-sub font-bold text-niho-accent-ink">{PHOTO_EDITING_VERSIONS_CURRENT_TEXT}</span>
          </li>
        ) : null}
        {rows.map((version) => (
          <VersionRow
            key={version.id}
            version={version}
            selected={version.id === props.selectedId}
            disabled={props.disabled}
            manageDisabled={props.manageDisabled}
            renaming={renamingId === version.id}
            thumbnails={props.thumbnails}
            onSwitch={() => props.onSwitch(version.id)}
            onStartRename={() => setRenamingId(version.id)}
            onRename={(name) => props.onRename(version.id, name)}
            onEndRename={() => setRenamingId((current) => (current === version.id ? null : current))}
            onDelete={(trigger) => {
              deleteTriggerRef.current = trigger;
              setDeleteTarget(version);
              setDeleteOpen(true);
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-2 pb-2 pt-1">
      <CreateVersion defaultName={props.defaultName} disabled={props.disabled || !ready || props.full} onCreate={props.onCreate} />
      {ready && props.full ? (
        <p className="text-xs leading-relaxed text-niho-text-sub">{PHOTO_EDITING_VERSIONS_LIMIT_TEXT}</p>
      ) : null}
      {props.saveFailed ? (
        <div className="flex items-center justify-between gap-2">
          <p role="status" className="min-w-0 text-xs text-niho-text-sub">
            {PHOTO_EDITING_VERSIONS_SAVE_FAILED_TEXT}
          </p>
          <button type="button" onClick={props.onRetrySave} className={PHOTO_EDITING_RETRY_TEXT_BUTTON_CLASS_NAME}>
            {PHOTO_EDITING_RETRY_LABEL}
          </button>
        </div>
      ) : null}
      {body}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={photoEditingVersionDeleteTitle(deleteTarget?.name ?? "")}
        description={PHOTO_EDITING_VERSIONS_DELETE_DESCRIPTION}
        confirmLabel={PHOTO_EDITING_VERSIONS_DELETE_CONFIRM_LABEL}
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) props.onDelete(deleteTarget.id);
          setDeleteOpen(false);
        }}
        onCloseAutoFocus={(event) => returnDialogFocus(event, deleteTriggerRef)}
      />
    </div>
  );
}
