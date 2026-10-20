"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

import { appDialog } from "niho-ui/app-dialog";

import {
  DISCARD_DESCRIPTION,
  type BrowserNavigationApi,
  type BrowserNavigationEvent,
  type BrowserPhotoOperationKind,
  type PhotoEditingLeaveGuardRegistrar,
  type DevelopSession,
} from "./browser-photo-editing-model";

/**
 * 画面を離れる前の確かめ（beforeunload・管理画面の route guard・Navigation API の戻る / 進む）。beforeunload は未保存の操作
 * だけを止め、route guard と戻る / 進むは wasm で直している写真の保存を送り終えてから離れる（保存できなければ離れない）。
 * 補正のほかに送り終えるべき保存（NIHO camera の背景除去のレシピ）は `flushPendingSaves` で同じく待つ。
 */
export function useBrowserPhotoLeaveGuards(params: {
  /** 書き出し・追加・書き出していない補正・送り終えていない保存がある（beforeunload で止める） */
  unloadGuarded: boolean;
  /** route guard と戻る / 進むで確かめる（wasm で開いている写真も） */
  guarded: boolean;
  dirty: boolean;
  operationRef: MutableRefObject<BrowserPhotoOperationKind | null>;
  saveGenerationRef: MutableRefObject<number>;
  addQueue: { readonly running: boolean };
  developSessionRef: MutableRefObject<DevelopSession | null>;
  leaveEditing: (options: { release: boolean }) => Promise<boolean>;
  /** 補正のほかに送り終えるべき保存を待つ（できなければ false。route guard と戻る / 進むで離れる前に呼ぶ） */
  flushPendingSaves?: () => Promise<boolean>;
  registerRouteLeaveGuard?: PhotoEditingLeaveGuardRegistrar;
  active: boolean;
  openCloudPhotoId: string | null;
}) {
  const {
    unloadGuarded,
    guarded,
    dirty,
    operationRef,
    saveGenerationRef,
    addQueue,
    developSessionRef,
    leaveEditing,
    flushPendingSaves,
    registerRouteLeaveGuard,
    active: surfaceActive,
    openCloudPhotoId,
  } = params;

  // 毎回の描画で替わる関数を route guard の登録に使わない（登録し直さない）
  const flushPendingSavesRef = useRef(flushPendingSaves);
  flushPendingSavesRef.current = flushPendingSaves;

  const confirmRouteLeave = useCallback(async (options: { release?: boolean } = {}): Promise<boolean> => {
    if (operationRef.current || addQueue.running) return false;
    // 補正のほかの保存（背景除去）も送り終えてから離れる（送れなければ離れない。離れようとするたびに失敗分を送り直す）
    const flushPending = flushPendingSavesRef.current;
    if (flushPending && !(await flushPending())) return false;
    // wasm は確かめず、保存を送り終えてから離れる（保存できなければ離れない）
    if (developSessionRef.current) return leaveEditing({ release: options.release !== false });
    if (!dirty) return true;
    const saveGeneration = saveGenerationRef.current;
    const confirmed = await appDialog.confirm({
      title: "補正を破棄して移動しますか？",
      description: DISCARD_DESCRIPTION,
      confirmLabel: "破棄して移動",
      variant: "danger",
    });
    return confirmed && operationRef.current === null && !addQueue.running && saveGeneration === saveGenerationRef.current;
  }, [addQueue, developSessionRef, dirty, leaveEditing, operationRef, saveGenerationRef]);

  useEffect(() => {
    if (!unloadGuarded) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [unloadGuarded]);

  useEffect(() => {
    const register = registerRouteLeaveGuard;
    if (!register || !guarded) return;
    register(confirmRouteLeave);
    return () => register(null);
  }, [confirmRouteLeave, guarded, registerRouteLeaveGuard]);

  useEffect(() => {
    if (!guarded) return;
    const navigation = (window as unknown as { navigation?: BrowserNavigationApi }).navigation;
    if (!navigation?.traverseTo) return;

    let active = true;
    let pendingDestinationKey: string | null = null;
    let approvedDestinationKey: string | null = null;
    const onNavigate = (event: Event) => {
      const navigationEvent = event as BrowserNavigationEvent;
      if (
        navigationEvent.navigationType !== "traverse" ||
        !navigationEvent.canIntercept ||
        navigationEvent.hashChange ||
        !navigationEvent.cancelable
      ) return;

      const destinationKey = navigationEvent.destination?.key;
      if (!destinationKey) return;
      if (approvedDestinationKey === destinationKey) {
        approvedDestinationKey = null;
        return;
      }

      navigationEvent.preventDefault();
      if (pendingDestinationKey !== null) return;
      const originKey = navigation.currentEntry?.key ?? null;
      pendingDestinationKey = destinationKey;
      void confirmRouteLeave().then((canLeave) => {
        if (!active || pendingDestinationKey !== destinationKey) return;
        pendingDestinationKey = null;
        if (!canLeave || (originKey !== null && navigation.currentEntry?.key !== originKey)) return;

        approvedDestinationKey = destinationKey;
        const transition = navigation.traverseTo?.(destinationKey);
        if (!transition) {
          approvedDestinationKey = null;
          return;
        }
        void transition.finished?.catch(() => {
          if (approvedDestinationKey === destinationKey) approvedDestinationKey = null;
        });
      }).catch(() => {
        if (pendingDestinationKey === destinationKey) pendingDestinationKey = null;
      });
    };

    navigation.addEventListener("navigate", onNavigate);
    return () => {
      active = false;
      navigation.removeEventListener("navigate", onNavigate);
    };
    // 画面の切り替え（タブを戻した・URL の依頼が来た）でも登録し直す
  }, [confirmRouteLeave, guarded, surfaceActive, openCloudPhotoId]);

  return confirmRouteLeave;
}
