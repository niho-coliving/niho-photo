"use client";

import { useId, type ReactNode } from "react";
import { cn } from "niho-ui/cn";

import {
  usePhotoEditingAdvancedSectionOpen,
  type PhotoEditingAdvancedSectionId,
} from "../photo-editing-advanced-sections-state";

import { AdjustmentGroup, GROUP_ACCESSORY_BUTTON_CLASS_NAME } from "./photo-editing-adjustment-controls";

/** 節の見出しの横の「初期化」（カーブ・カラーミキサー）。戻すものが無い・押せない間は薄くして押せない表示にする。 */
export const PHOTO_EDITING_SECTION_RESET_BUTTON_CLASS_NAME = cn(
  GROUP_ACCESSORY_BUTTON_CLASS_NAME,
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
);

/**
 * 右パネルの群の間に差し込む「既定で閉じた節」（カーブなど。niho-photo#37）。見た目は群と同じ（見出しの開閉のボタン・見出しの横の
 * `accessory`）で、開閉は {@link usePhotoEditingAdvancedSectionOpen} が端末に覚える（はじめては閉じる）。中身は開いている間だけ描く。
 *
 * 足し方: `PHOTO_EDITING_ADVANCED_SECTION_IDS` に id を足し、この部品で包んだ要素を `PhotoEditingAdjustmentGroups` の `afterGroup`
 * （ブラウザ版は `BrowserPhotoEditingAdjustments` の `afterGroup`）に、置きたい群の id で渡す。
 */
export function PhotoEditingAdvancedSection(props: {
  id: PhotoEditingAdvancedSectionId;
  title: string;
  /** 見出しの横に置く要素（節の「初期化」など。閉じていても出す） */
  accessory?: ReactNode;
  children: ReactNode;
}) {
  const [open, toggle] = usePhotoEditingAdvancedSectionOpen(props.id);
  const domId = useId();
  return (
    <AdjustmentGroup
      id={`${domId}-section-${props.id}`}
      title={props.title}
      expanded={open}
      onToggle={toggle}
      accessory={props.accessory}
    >
      {props.children}
    </AdjustmentGroup>
  );
}
