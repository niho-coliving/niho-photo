import { useEffect, useRef } from "react";

/** 開いた順に一時的な面を積み、戻る操作で一番新しい面だけを閉じる。 */
type DismissLayer = {
  id: symbol;
  close: () => void;
};

const layers: DismissLayer[] = [];

/** 面を積む（開いた順）。返す関数で外す。 */
export function registerDismissLayer(close: () => void): () => void {
  const layer = { id: Symbol("dismiss-layer"), close };
  layers.push(layer);

  return () => {
    const index = layers.findIndex((candidate) => candidate.id === layer.id);
    if (index >= 0) layers.splice(index, 1);
  };
}

/** 一番新しい面を閉じる。閉じる面が無ければ false。 */
export function dismissTopLayer(): boolean {
  const layer = layers.at(-1);
  if (!layer) return false;
  layer.close();
  return true;
}

/** `active` の間だけ面を積む（「戻る」で `close` を呼ぶ）。 */
export function useDismissLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!active) return;
    return registerDismissLayer(() => closeRef.current());
  }, [active]);
}
