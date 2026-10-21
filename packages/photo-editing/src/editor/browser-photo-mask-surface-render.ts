import {
  DevelopMaskSurfaceError,
  type DevelopEngine,
  type DevelopFrame,
  type DevelopRenderOptions,
} from "../develop-engine/develop-engine-client";
import { MAX_DEVELOP_MASKS, readDevelopMasks, writeDevelopMasks } from "../develop-engine/develop-masks";
import type { DevelopSettings } from "../develop-engine/develop-settings";

/**
 * 面（ブラシ・被写体・空のマスク。M4 #68）を読めない写真の描き方（`useBrowserPhotoOpen` が使う）。
 *
 * 描画は面を読めないマスクを黙って外さずに失敗する（{@link DevelopMaskSurfaceError}）。画面は前の画をそのまま見せ、マスクの面に理由を
 * 出す。ただし開いた直後でまだ wasm の画が無いときだけは、写真の編集を止めないよう、読めないマスクを当てない（`enabled: false`）設定で
 * 1 枚描いて見せる（保存する設定・書き出しは変えない。書き出しは面が要るので断る）。
 */

/** `maskIds` のマスクを当てない（`enabled: false`）設定。マスクの無い・読めない設定はそのまま。 */
export function withoutDevelopMasks(settings: DevelopSettings, maskIds: ReadonlySet<string>): DevelopSettings {
  const masks = readDevelopMasks(settings);
  if (!masks.some((mask) => maskIds.has(mask.id) && mask.enabled)) return settings;
  return writeDevelopMasks(
    settings,
    masks.map((mask) => (maskIds.has(mask.id) ? { ...mask, enabled: false } : mask)),
  );
}

/**
 * 面を読めないマスクを当てずに描く（読めないと分かったマスクを外して描き直し、ほかにも読めないマスクがあれば続けて外す。マスクの枚数
 * まで）。描いた画と、外したマスクの id。面のほかの失敗はそのまま投げる。
 */
export async function renderDevelopWithoutUnreadableMasks(
  engine: Pick<DevelopEngine, "render">,
  settings: DevelopSettings,
  options: DevelopRenderOptions,
  first: DevelopMaskSurfaceError,
): Promise<{ frame: DevelopFrame | null; maskIds: string[] }> {
  const skipped = new Set<string>();
  let error: DevelopMaskSurfaceError = first;
  for (let attempt = 0; attempt < MAX_DEVELOP_MASKS; attempt += 1) {
    if (error.maskId === null || skipped.has(error.maskId)) throw error;
    skipped.add(error.maskId);
    try {
      const frame = await engine.render(withoutDevelopMasks(settings, skipped), options);
      return { frame, maskIds: [...skipped] };
    } catch (next) {
      if (!(next instanceof DevelopMaskSurfaceError)) throw next;
      error = next;
    }
  }
  throw error;
}
