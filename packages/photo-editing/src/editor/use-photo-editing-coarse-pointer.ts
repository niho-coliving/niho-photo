"use client";

import { useEffect, useState } from "react";

const COARSE_POINTER_QUERY = "(pointer: coarse)";

function matchesCoarse(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COARSE_POINTER_QUERY).matches;
}

/**
 * 主なポインタが指か（`(pointer: coarse)`。niho-photo#93）。写真の上の印の、CSS では決められない寸法（回転のつまみの離し方・ブラシの
 * 大きさの見本）に使う。押せる範囲の大きさは CSS の `pointer-coarse:` で決める。`matchMedia` の無い環境（テスト）は指ではない扱い。
 */
export function usePhotoEditingCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(matchesCoarse);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COARSE_POINTER_QUERY);
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return coarse;
}
