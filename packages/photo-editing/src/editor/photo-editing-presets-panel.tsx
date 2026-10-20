"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, MoreHorizontal } from "lucide-react";

import { ConfirmDialog } from "niho-ui/components/confirm-dialog";
import { Skeleton } from "niho-ui/components/skeleton";
import { Spinner } from "niho-ui/components/spinner";
import type { PhotoEditingBuiltinPreset } from "../photo-editing-types";
import { usePhotoEditingPresetsSectionCollapsed } from "../photo-editing-adjustment-groups-state";
import type { DevelopSettingsXmp } from "../develop-engine/develop-engine-client";
import {
  PHOTO_EDITING_PRESETS_TITLE,
  PHOTO_EDITING_PRESET_ACTIONS_LABEL,
  PHOTO_EDITING_PRESET_DELETE_MENU_LABEL,
  PHOTO_EDITING_PRESET_IMPORT_MENU_LABEL,
  PHOTO_EDITING_PRESET_RENAME_ERROR,
  PHOTO_EDITING_PRESET_RENAME_LABEL,
  PHOTO_EDITING_PRESET_SAVE_CURRENT_LABEL,
  photoEditingPresetNotWrittenError,
  PHOTO_EDITING_PRESET_WRITE_ERROR,
  PHOTO_EDITING_PRESET_COLOR_TABLE_CANCEL_LABEL,
  PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_DESCRIPTION,
  PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_LABEL,
  PHOTO_EDITING_PRESET_DNG_NO_XMP_MESSAGE,
  PHOTO_EDITING_PRESET_DNG_TOO_LARGE_MESSAGE,
  PHOTO_EDITING_PRESET_IMPORTING_LABEL,
  PHOTO_EDITING_PRESET_NONE_LABEL,
  PHOTO_EDITING_SPOT_PRESETS_TITLE,
  photoEditingPresetColorTableConfirmTitle,
  photoEditingPresetRowActionsLabel,
  PHOTO_PRESET_NAME_TAKEN_RENAME_MESSAGE,
  PHOTO_PRESET_XMP_INVALID_MESSAGE,
  PHOTO_PRESET_XMP_TOO_LARGE_MESSAGE,
} from "../photo-editing-copy";
import { resolveImportedPhotoPresetName } from "../photo-editing-file-names";
import type { PhotoLibraryPreset, PhotoLibraryPresets } from "../library/photo-library";
import { usePhotoLibrary } from "../library/photo-library-context";
import { describePhotoEditingPresetReadError } from "../photo-library-messages";
import { builtinPhotoPresetDisplayName } from "../photo-editing-preset-names";
import {
  PHOTO_PRESET_DNG_MAX_BYTES,
  extractXmpFromDng,
  isPhotoPresetDngFileName,
} from "../photo-preset-dng";
import {
  describeUnsupportedPresetItems,
  presetUsesLightroomColorTable,
} from "../photo-preset-xmp-support";
import { photoEditingQueryKeys } from "../photo-editing-query-keys";
import { appDialog } from "niho-ui/app-dialog";
import { cn } from "niho-ui/cn";

import { PhotoEditingMenu, type PhotoEditingMenuItem } from "./photo-editing-menu";
import {
  PhotoEditingPresetRenameDialog,
  PhotoEditingPresetSaveDialog,
  returnDialogFocus,
  type PhotoEditingPresetDialogResult,
  type PhotoEditingPresetSaveInput,
} from "./photo-editing-preset-dialogs";
import {
  PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY,
  PhotoEditingPresetThumbnail,
  type PhotoEditingPresetThumbnails,
} from "./photo-editing-preset-thumbnail";

/** 同梱のプリセットと拠点のプリセットを同じ一覧で見分けるキー。 */
export function builtinPhotoPresetKey(id: string): string {
  return `builtin:${id}`;
}

export function spotPhotoPresetKey(id: string): string {
  return `spot:${id}`;
}

/** 一覧の 1 行（当てる・仮に見せるときに渡す。`name` は画面に出している名前）。 */
export type PhotoEditingPresetTarget = { key: string; name: string; xmp: string };

/** 取り込む前に読めるかを確かめた結果（名前は XMP の `crs:Name`、`unsupported` は使えない XMP の項目名）。 */
export type PhotoEditingPresetReadResult = { name: string; unsupported: string[] };

const XMP_ROOT_ELEMENT_MARKER = "x:xmpmeta";
const PRESET_FILE_ACCEPT = ".xmp,.dng";
const SPOT_PRESETS_LOAD_ERROR = "拠点のプリセットを読み込めませんでした。通信を確かめて、もう一度お試しください。";
const SPOT_PRESET_SAVE_ERROR = "プリセットを保存できませんでした。通信を確かめて、もう一度お試しください。";
const SPOT_PRESET_DELETE_ERROR = "プリセットを削除できませんでした。通信を確かめて、もう一度お試しください。";

/** 「今の補正をプリセットに保存」（ブラウザ版）。 */
export type PhotoEditingPresetSaveCurrent = {
  /** 押せる（写真を直せる）。今の補正を XMP にできない wasm では、この props ごと渡さない（メニューに項目を出さない） */
  available: boolean;
  /** 何も当てていない補正（保存を押せない） */
  neutral: boolean;
  /** 今の補正を Lightroom のプリセット（XMP）にする（できなければ reject） */
  writeXmp: (input: PhotoEditingPresetSaveInput) => Promise<DevelopSettingsXmp>;
};

const MORE_BUTTON_CLASS_NAME =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-niho-text-muted transition hover:bg-niho-pale/60 hover:text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink disabled:cursor-not-allowed disabled:opacity-50";

/** 保存・名前の変更の失敗（同じ名前は入力の下、ほかは写真の出どころの理由か `fallback`）。 */
function presetDialogFailure(
  presets: Pick<PhotoLibraryPresets, "isNameTaken" | "describeError">,
  error: unknown,
  fallback: string,
): PhotoEditingPresetDialogResult {
  return presets.isNameTaken(error)
    ? { ok: false, nameTaken: true, message: PHOTO_PRESET_NAME_TAKEN_RENAME_MESSAGE }
    : { ok: false, nameTaken: false, message: presets.describeError(error, fallback) };
}

/** 行・見出しの右の「⋯」（押すとメニュー。ブラウザ版）。 */
function MoreMenu(props: {
  label: string;
  items: PhotoEditingMenuItem[];
  /** メニューを開いた（項目から開くダイアログを閉じたら、この「⋯」へフォーカスを戻すために覚える） */
  onOpenMenu?: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <PhotoEditingMenu variant="browser" align="end" items={props.items}>
      <button
        type="button"
        aria-label={props.label}
        aria-haspopup="menu"
        onClick={(event) => props.onOpenMenu?.(event.currentTarget)}
        className={MORE_BUTTON_CLASS_NAME}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>
    </PhotoEditingMenu>
  );
}

type ImportMessage = { fileName: string; message: string };
type ImportOutcome =
  | { kind: "imported"; notice: string | null }
  | { kind: "failed"; message: string }
  /** 色の表の確認で「やめる」（保存しない・失敗としても出さない） */
  | { kind: "cancelled" };

function PresetRow(props: {
  name: string;
  applied: boolean;
  applying: boolean;
  disabled: boolean;
  /** 選ばれた表示のまま押せない行（「なし」。薄くしない） */
  locked?: boolean;
  /** 行の左の見本（ブラウザ版で、見本を描ける wasm のときだけ。行の高さは 56px） */
  thumbnail?: ReactNode;
  onApply: () => void;
  /** 行の右の操作（拠点のプリセットの「⋯」） */
  actions?: ReactNode;
  /** マウスを載せた・キーボードのフォーカスが来た（true）／離れた（false） */
  onPreviewChange?: (previewing: boolean) => void;
}) {
  const onPreviewChange = props.onPreviewChange;
  // 押して来たフォーカス（マウス・タッチ）では仮の表示を起こさない（キーボードで来たフォーカスだけ）
  const pressedRef = useRef(false);
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={props.onApply}
        disabled={props.disabled || props.locked === true}
        aria-current={props.applied ? "true" : undefined}
        onPointerDown={
          onPreviewChange
            ? () => {
                pressedRef.current = true;
              }
            : undefined
        }
        onPointerEnter={
          onPreviewChange
            ? (event) => {
                // タッチでは起こさない（押したら当たる）
                if (event.pointerType === "mouse") onPreviewChange(true);
              }
            : undefined
        }
        onPointerLeave={
          onPreviewChange
            ? (event) => {
                if (event.pointerType === "mouse") onPreviewChange(false);
              }
            : undefined
        }
        onFocus={
          onPreviewChange
            ? () => {
                if (!pressedRef.current) onPreviewChange(true);
              }
            : undefined
        }
        onBlur={
          onPreviewChange
            ? () => {
                pressedRef.current = false;
                onPreviewChange(false);
              }
            : undefined
        }
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-xl px-3 text-left text-sub font-bold transition",
          "min-h-11",
          props.thumbnail ? "min-h-14 gap-3 py-1 pl-1" : null,
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink",
          props.locked === true && !props.disabled
            ? "disabled:cursor-default"
            : "disabled:cursor-not-allowed disabled:opacity-50",
          props.applied ? "bg-niho-accent-soft text-niho-accent-ink" : "text-niho-text hover:bg-niho-pale/60",
        )}
      >
        {props.thumbnail}
        <span className={cn("truncate", props.thumbnail ? "min-w-0 flex-1" : null)}>{props.name}</span>
        {props.applying ? <Spinner size="sm" /> : null}
      </button>
      {props.actions}
    </li>
  );
}

/**
 * 右の面の「プリセット」。同梱のもの（Photo Bench の 4 本。段 2 の wasm を使える画面は crate の 3 本。移行元設計 S7b）と拠点で
 * 取り込んだもの（API）を並べ、押すと選んでいる写真の今の設定に当てる。拠点のものは Lightroom のプリセット（.xmp・.dng）の
 * 取り込みと削除ができる。Lightroom 専用の色の表を使うプリセットは、取り込む前に確かめる。
 *
 * ブラウザ版の右パネル（NIHO Photo 段 1 F2b 移行元設計）は、補正の群と同じ見た目の折りたためる節にし、一番上に
 * 「なし」、同梱のプリセットは日本語の名前、拠点のプリセットには小見出しを付け、取り込んだプリセットの使えない項目を 1 行で
 * 知らせる。見出しの右は「⋯」のメニュー（今の補正をプリセットに保存・Lightroom のプリセットを取り込む）、拠点のプリセットの行の
 * 右も「⋯」（名前を変更・削除）で、渡されれば行の左に見本（`thumbnails`）、一覧の下に適用量（`belowList`）を置く。
 */
export function PhotoEditingPresetsPanel(props: {
  spotId: string;
  canEdit: boolean;
  /** 段 2 の wasm の同梱プリセットの読み方。 */
  builtinPresets: {
    queryKey: readonly unknown[];
    load: () => Promise<PhotoEditingBuiltinPreset[]>;
  };
  /** 写真を選んでいるか（選んでいなければ当てられない） */
  canApply: boolean;
  appliedPresetKey: string | null;
  applyingPresetKey: string | null;
  applyError: string | null;
  onApply: (preset: PhotoEditingPresetTarget) => void;
  /**
   * 「なし」の行。どのプリセットも選ばれていなければ選ばれた表示のまま押せず、選ばれて
   * いれば（`canClear`）押して外せる
   */
  none?: { canClear: boolean; onClear: () => void };
  /**
   * 取り込む前に、段 2 の wasm で読めるプリセットかを確かめる（読めなければ reject。拠点に保存しない）。
   */
  readPreset: (xmp: string) => Promise<PhotoEditingPresetReadResult>;
  /**
   * 行にマウスを載せた・キーボードのフォーカスが来たプリセット（離れたら null）。写真に仮に当てて見せるのに使う
   */
  onPreview?: (preset: PhotoEditingPresetTarget | null) => void;
  /** 行の左の見本（省くと見本の無い行） */
  thumbnails?: PhotoEditingPresetThumbnails;
  /** 一覧の下に置くもの（「適用量」。節を閉じている間は出さない） */
  belowList?: ReactNode;
  /** 「今の補正をプリセットに保存」（省くとメニューの項目を押せない） */
  saveCurrent?: PhotoEditingPresetSaveCurrent;
  /** 拠点プリセット一覧が読み込まれた後、現在存在するキーを通知する（ブラウザの選択状態を同期） */
  onSpotPresetKeysChange?: (keys: readonly string[]) => void;
}) {
  const headingId = useId();
  const bodyId = useId();
  const spotHeadingId = useId();
  const queryClient = useQueryClient();
  // 拠点のプリセットと失敗の読み方は写真の出どころから（移行元設計）
  const library = usePhotoLibrary();
  const libraryPresets = library.presets;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [collapsed, toggleCollapsed] = usePhotoEditingPresetsSectionCollapsed();
  const [importing, setImporting] = useState(false);
  const [importFailures, setImportFailures] = useState<ImportMessage[]>([]);
  // 取り込めたが使えない項目があるプリセットの知らせ（情報。エラーの色にしない）
  const [importNotices, setImportNotices] = useState<ImportMessage[]>([]);
  // 閉じる途中で見出しが空にならないよう、対象は閉じても残し、開閉は別に持つ
  const [deleteTarget, setDeleteTarget] = useState<PhotoLibraryPreset | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // メニューから開いたダイアログ（保存・名前の変更・削除）を閉じたら、フォーカスを戻す「⋯」（最後に開いたメニューのもの）
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const rememberDialogTrigger = (trigger: HTMLButtonElement) => {
    dialogTriggerRef.current = trigger;
  };
  // 「今の補正をプリセットに保存」と「名前を変更」（ブラウザ版）。開くたびに回数を進め、入力を最初から始める
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveSession, setSaveSession] = useState(0);
  const [renameTarget, setRenameTarget] = useState<PhotoLibraryPreset | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameSession, setRenameSession] = useState(0);

  const builtinPresetsQuery = useQuery({
    queryKey: props.builtinPresets.queryKey,
    queryFn: props.builtinPresets.load,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const spotPresetsQueryKey = photoEditingQueryKeys.spotPresets(props.spotId);
  const spotPresetsQuery = useQuery({
    queryKey: spotPresetsQueryKey,
    // 一括の補正・スマホの面と同じ cache の形（`{ presets }`）
    queryFn: async () => ({ presets: await libraryPresets.list() }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const onSpotPresetKeysChange = props.onSpotPresetKeysChange;
  useEffect(() => {
    if (!spotPresetsQuery.isSuccess || !onSpotPresetKeysChange) return;
    onSpotPresetKeysChange(spotPresetsQuery.data.presets.map((preset) => spotPhotoPresetKey(preset.id)));
  }, [onSpotPresetKeysChange, spotPresetsQuery.data, spotPresetsQuery.isSuccess]);

  /** 選んだファイルから XMP を読む（DNG は中の XMP の塊を取り出す）。読めなければ理由。 */
  const readImportXmp = async (file: File): Promise<{ xmp: string } | { failure: string }> => {
    if (isPhotoPresetDngFileName(file.name)) {
      if (file.size > PHOTO_PRESET_DNG_MAX_BYTES) return { failure: PHOTO_EDITING_PRESET_DNG_TOO_LARGE_MESSAGE };
      const xmp = extractXmpFromDng(new Uint8Array(await file.arrayBuffer()));
      if (xmp === null) return { failure: PHOTO_EDITING_PRESET_DNG_NO_XMP_MESSAGE };
      if (new TextEncoder().encode(xmp).length > libraryPresets.xmpMaxBytes) {
        return { failure: PHOTO_PRESET_XMP_TOO_LARGE_MESSAGE };
      }
      return { xmp };
    }
    if (file.size > libraryPresets.xmpMaxBytes) return { failure: PHOTO_PRESET_XMP_TOO_LARGE_MESSAGE };
    const xmp = await file.text();
    if (!xmp.includes(XMP_ROOT_ELEMENT_MARKER)) return { failure: PHOTO_PRESET_XMP_INVALID_MESSAGE };
    return { xmp };
  };

  const importOne = async (file: File): Promise<ImportOutcome> => {
    const source = await readImportXmp(file);
    if ("failure" in source) return { kind: "failed", message: source.failure };
    const xmp = source.xmp;
    // エンジンで読めるかを先に確かめ、名前（crs:Name）も受け取る。読めない XMP は拠点に保存しない
    let read: PhotoEditingPresetReadResult;
    try {
      read = await props.readPreset(xmp);
    } catch (error) {
      return { kind: "failed", message: describePhotoEditingPresetReadError(error, (cause) => library.errors.describeNative(cause)) };
    }
    // Lightroom 専用の色の表は当てられない（同じ見た目にならない）ので、ファイルごとに確かめてから保存する
    if (presetUsesLightroomColorTable(xmp)) {
      const confirmed = await appDialog.confirm({
        title: photoEditingPresetColorTableConfirmTitle(file.name),
        description: PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_DESCRIPTION,
        confirmLabel: PHOTO_EDITING_PRESET_COLOR_TABLE_CONFIRM_LABEL,
        cancelLabel: PHOTO_EDITING_PRESET_COLOR_TABLE_CANCEL_LABEL,
      });
      if (!confirmed) return { kind: "cancelled" };
    }
    try {
      await libraryPresets.create({
        name: resolveImportedPhotoPresetName(read.name, file.name, libraryPresets.nameMaxChars),
        xmp,
      });
    } catch (error) {
      return { kind: "failed", message: libraryPresets.describeError(error, SPOT_PRESET_SAVE_ERROR) };
    }
    return { kind: "imported", notice: describeUnsupportedPresetItems(read.unsupported, xmp) };
  };

  const importFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setImporting(true);
    setImportFailures([]);
    setImportNotices([]);
    const failures: ImportMessage[] = [];
    const notices: ImportMessage[] = [];
    let imported = false;
    for (const file of files) {
      let outcome: ImportOutcome;
      try {
        outcome = await importOne(file);
      } catch (error) {
        // ファイルを読めなかった（消えた・権限が無いなど）
        outcome = { kind: "failed", message: describePhotoEditingPresetReadError(error, (cause) => library.errors.describeNative(cause)) };
      }
      if (outcome.kind === "failed") failures.push({ fileName: file.name, message: outcome.message });
      if (outcome.kind !== "imported") continue;
      imported = true;
      if (outcome.notice) notices.push({ fileName: file.name, message: outcome.notice });
    }
    if (imported) await queryClient.invalidateQueries({ queryKey: spotPresetsQueryKey });
    setImportFailures(failures);
    setImportNotices(notices);
    setImporting(false);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await libraryPresets.delete(deleteTarget.id);
      const remainingPresets = spotPresetsQuery.data?.presets.filter((preset) => preset.id !== deleteTarget.id);
      if (remainingPresets) {
        onSpotPresetKeysChange?.(remainingPresets.map((preset) => spotPhotoPresetKey(preset.id)));
        queryClient.setQueryData(spotPresetsQueryKey, { ...spotPresetsQuery.data, presets: remainingPresets });
      }
      await queryClient.invalidateQueries({ queryKey: spotPresetsQueryKey });
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError(libraryPresets.describeError(error, SPOT_PRESET_DELETE_ERROR));
    } finally {
      setDeleting(false);
    }
  };

  /** 今の補正を XMP にして拠点に保存し、一覧を読み直す（`source: "user"`）。 */
  const saveCurrentPreset = async (input: PhotoEditingPresetSaveInput): Promise<PhotoEditingPresetDialogResult> => {
    const saveCurrent = props.saveCurrent;
    let xmp: string;
    try {
      if (!saveCurrent) throw new Error("preset cannot be written");
      const written = await saveCurrent.writeXmp(input);
      if (written.notWritten.length > 0) {
        return { ok: false, nameTaken: false, message: photoEditingPresetNotWrittenError(written.notWritten) };
      }
      xmp = written.xmp;
    } catch {
      return { ok: false, nameTaken: false, message: PHOTO_EDITING_PRESET_WRITE_ERROR };
    }
    try {
      await libraryPresets.create({ name: input.name, xmp, source: "user" });
    } catch (error) {
      return presetDialogFailure(libraryPresets, error, SPOT_PRESET_SAVE_ERROR);
    }
    await queryClient.invalidateQueries({ queryKey: spotPresetsQueryKey });
    return { ok: true };
  };

  /** 拠点のプリセットの名前を変え、一覧を読み直す。 */
  const renamePreset = async (name: string): Promise<PhotoEditingPresetDialogResult> => {
    if (!renameTarget) return { ok: false, nameTaken: false, message: PHOTO_EDITING_PRESET_RENAME_ERROR };
    try {
      await libraryPresets.rename(renameTarget.id, name);
    } catch (error) {
      return presetDialogFailure(libraryPresets, error, PHOTO_EDITING_PRESET_RENAME_ERROR);
    }
    await queryClient.invalidateQueries({ queryKey: spotPresetsQueryKey });
    return { ok: true };
  };

  const openDelete = (preset: PhotoLibraryPreset) => {
    setDeleteError(null);
    setDeleteTarget(preset);
    setDeleteOpen(true);
  };

  const applying = props.applyingPresetKey !== null;
  const rowsDisabled = !props.canApply || applying;
  const builtinPresets = builtinPresetsQuery.data ?? [];
  const spotPresets = spotPresetsQuery.data?.presets ?? [];
  const errorTextClassName = "text-niho-danger";
  const onPreview = props.onPreview;
  const thumbnails = props.thumbnails;
  const thumbnailFor = (key: string, xmp: string | null) =>
    thumbnails ? <PhotoEditingPresetThumbnail thumbnailKey={key} xmp={xmp} thumbnails={thumbnails} /> : undefined;

  const presetRow = (
    target: PhotoEditingPresetTarget,
    extras: { actions?: ReactNode } = {},
  ) => (
    <PresetRow
      key={target.key}
      name={target.name}
      applied={props.appliedPresetKey === target.key}
      applying={props.applyingPresetKey === target.key}
      disabled={rowsDisabled}
      thumbnail={thumbnailFor(target.key, target.xmp)}
      onApply={() => props.onApply(target)}
      actions={extras.actions}
      onPreviewChange={onPreview ? (previewing) => onPreview(previewing ? target : null) : undefined}
    />
  );

  const fileInput = props.canEdit ? (
    <input
      ref={fileInputRef}
      type="file"
      accept={PRESET_FILE_ACCEPT}
      multiple
      tabIndex={-1}
      aria-hidden
      className="sr-only"
      data-testid="photo-editing-preset-file-input"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        // 同じファイルをもう一度選べるように空に戻す
        event.currentTarget.value = "";
        void importFiles(files);
      }}
    />
  ) : null;

  // ブラウザ版の見出しの右の「⋯」: 今の補正をプリセットに保存・Lightroom のプリセットを取り込む
  const browserActions = props.canEdit ? (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      {importing ? (
        <span role="status" className="inline-flex items-center gap-1.5 text-xs font-bold text-niho-text-sub">
          <Spinner size="sm" />
          {PHOTO_EDITING_PRESET_IMPORTING_LABEL}
        </span>
      ) : null}
      <MoreMenu
        label={PHOTO_EDITING_PRESET_ACTIONS_LABEL}
        onOpenMenu={rememberDialogTrigger}
        items={[
          // 今の補正を XMP にできない wasm では項目ごと出さない（公開されるまで変わらないので、押せない理由を見せ続けない）
          ...(props.saveCurrent
            ? [
                {
                  key: "save-current",
                  label: PHOTO_EDITING_PRESET_SAVE_CURRENT_LABEL,
                  disabled: !props.saveCurrent.available,
                  opensDialog: true,
                  onSelect: () => {
                    setSaveSession((session) => session + 1);
                    setSaveOpen(true);
                  },
                },
              ]
            : []),
          {
            key: "import",
            label: PHOTO_EDITING_PRESET_IMPORT_MENU_LABEL,
            disabled: importing,
            onSelect: () => fileInputRef.current?.click(),
          },
        ]}
      />
      {fileInput}
    </div>
  ) : null;

  const messages: ReactNode = (
    <>
      {importFailures.length > 0 ? (
        <div role="alert" className="mt-1">
          <ul className="space-y-1">
            {importFailures.map((failure, index) => (
              <li key={`${failure.fileName}-${index}`} className={cn("break-words text-xs leading-relaxed", errorTextClassName)}>
                {failure.fileName}: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {importNotices.length > 0 ? (
        <div role="status" className="mt-1">
          <ul className="space-y-1">
            {importNotices.map((notice, index) => (
              <li key={`${notice.fileName}-${index}`} className="break-words text-xs leading-relaxed text-niho-text-sub">
                {notice.fileName}: {notice.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {props.applyError ? (
        <p role="alert" className={cn("mt-1 text-xs leading-relaxed", errorTextClassName)}>
          {props.applyError}
        </p>
      ) : null}
    </>
  );

  const skeletonRowClassName = thumbnails ? "h-14" : "h-11";
  const builtinSkeleton = builtinPresetsQuery.isPending ? (
    <>
      <li aria-hidden>
        <Skeleton className={skeletonRowClassName} />
      </li>
      <li aria-hidden>
        <Skeleton className={skeletonRowClassName} />
      </li>
    </>
  ) : null;

  const builtinError = builtinPresetsQuery.isError ? (
    <div className={cn("mt-1 text-xs leading-relaxed", errorTextClassName)} role="alert">
      {library.errors.describeNative(builtinPresetsQuery.error)}
      <button
        type="button"
        onClick={() => void builtinPresetsQuery.refetch()}
        className="ml-2 min-h-11 font-bold text-niho-text-sub underline"
      >
        再読み込み
      </button>
    </div>
  ) : null;

  const spotRows = spotPresets.map((preset) =>
    presetRow(
      { key: spotPhotoPresetKey(preset.id), name: preset.name, xmp: preset.xmp },
      !props.canEdit
        ? {}
        : {
              // ブラウザ版は「⋯」のメニューに「名前を変更」「削除」
              actions: (
                <MoreMenu
                  label={photoEditingPresetRowActionsLabel(preset.name)}
                  onOpenMenu={rememberDialogTrigger}
                  items={[
                    {
                      key: "rename",
                      label: PHOTO_EDITING_PRESET_RENAME_LABEL,
                      opensDialog: true,
                      onSelect: () => {
                        setRenameTarget(preset);
                        setRenameSession((session) => session + 1);
                        setRenameOpen(true);
                      },
                    },
                    {
                      key: "delete",
                      label: PHOTO_EDITING_PRESET_DELETE_MENU_LABEL,
                      danger: true,
                      opensDialog: true,
                      onSelect: () => openDelete(preset),
                    },
                  ]}
                />
              ),
            }
    ),
  );

  const spotError = spotPresetsQuery.isError ? (
    <div className={cn("mt-2 text-xs leading-relaxed", errorTextClassName)} role="alert">
      {SPOT_PRESETS_LOAD_ERROR}
      <button
        type="button"
        onClick={() => void spotPresetsQuery.refetch()}
        className="ml-2 min-h-11 font-bold text-niho-text-sub underline"
      >
        再読み込み
      </button>
    </div>
  ) : null;

  const deleteDialog = (
    <ConfirmDialog
      open={deleteOpen}
      onOpenChange={setDeleteOpen}
      title={`「${deleteTarget?.name ?? ""}」を削除しますか？`}
      description="拠点のスタッフ全員の一覧から消えます。"
      confirmLabel="削除する"
      pendingLabel="削除中..."
      isPending={deleting}
      variant="danger"
      errorMessage={deleteError}
      onConfirm={() => void confirmDelete()}
      onCloseAutoFocus={(event) => returnDialogFocus(event, dialogTriggerRef)}
    />
  );

  const expanded = !collapsed;
    const none = props.none;
    const browserDialogs = props.canEdit ? (
      <>
        <PhotoEditingPresetSaveDialog
          key={`save-${saveSession}`}
          open={saveOpen}
          onOpenChange={setSaveOpen}
          neutral={props.saveCurrent?.neutral ?? true}
          onSave={saveCurrentPreset}
          returnFocusRef={dialogTriggerRef}
        />
        <PhotoEditingPresetRenameDialog
          key={`rename-${renameSession}`}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          currentName={renameTarget?.name ?? ""}
          onRename={renamePreset}
          returnFocusRef={dialogTriggerRef}
        />
      </>
    ) : null;
    return (
      <div role="group" aria-labelledby={headingId} className="pt-1">
        <div className="flex min-h-11 items-center gap-1">
          <h4 id={headingId} className="min-w-0">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={toggleCollapsed}
              className="-ml-1 flex min-h-11 items-center gap-1 rounded-full pl-1 pr-2 text-xs font-bold text-niho-text-muted transition hover:text-niho-text-sub focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-niho-accent-ink"
            >
              <ChevronDown
                className={cn("h-4 w-4 shrink-0 motion-safe:transition-transform", expanded ? null : "-rotate-90")}
                aria-hidden
              />
              {PHOTO_EDITING_PRESETS_TITLE}
            </button>
          </h4>
          {browserActions}
        </div>
        {/* 取り込みの結果は、節を閉じていても出す */}
        {messages}
        <div id={bodyId} hidden={!expanded} className="pb-1">
          {expanded ? (
            <>
              <ul className="space-y-0.5">
                {none ? (
                  <PresetRow
                    name={PHOTO_EDITING_PRESET_NONE_LABEL}
                    applied={props.appliedPresetKey === null}
                    applying={false}
                    disabled={rowsDisabled}
                    locked={!none.canClear}
                    thumbnail={thumbnailFor(PHOTO_EDITING_PRESET_NONE_THUMBNAIL_KEY, null)}
                    onApply={none.onClear}
                  />
                ) : null}
                {builtinSkeleton}
                {builtinPresets.map((preset) =>
                  presetRow({
                    key: builtinPhotoPresetKey(preset.id),
                    name: builtinPhotoPresetDisplayName(preset),
                    xmp: preset.xmp,
                  }),
                )}
              </ul>
              {builtinError}
              {spotPresets.length > 0 ? (
                <>
                  <h5 id={spotHeadingId} className="mt-2 px-3 pb-1 text-xs font-bold text-niho-text-muted">
                    {PHOTO_EDITING_SPOT_PRESETS_TITLE}
                  </h5>
                  <ul aria-labelledby={spotHeadingId} className="space-y-0.5">
                    {spotRows}
                  </ul>
                </>
              ) : null}
              {spotError}
              {props.belowList}
            </>
          ) : null}
        </div>
        {deleteDialog}
        {browserDialogs}
      </div>
    );
}
