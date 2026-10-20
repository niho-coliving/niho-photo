/**
 * 同梱のプリセットの表示名（NIHO Photo 段 1 F2b 移行元設計）。エンジンが返す名前は英語の識別子（`bluesky2` など）なので、画面には
 * ここの日本語名を出す。id は crate（段 2 の wasm）が `niho-bluesky2`、NIHO Desktop のエンジン（Photo Bench）も同じ形だが、
 * `niho-` の有無と大文字・小文字を問わずに当てる。表に無いプリセットは、エンジンの名前のまま。
 */
const BUILTIN_PHOTO_PRESET_NAMES: Readonly<Record<string, string>> = {
  bluesky2: "青空",
  pastel: "パステル",
  colorful: "鮮やか",
};

const BUILTIN_ID_PREFIX = "niho-";

function lookupKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(BUILTIN_ID_PREFIX) ? normalized.slice(BUILTIN_ID_PREFIX.length) : normalized;
}

function lookupName(value: string): string | null {
  const key = lookupKey(value);
  return Object.hasOwn(BUILTIN_PHOTO_PRESET_NAMES, key) ? BUILTIN_PHOTO_PRESET_NAMES[key] : null;
}

/** 同梱のプリセットの表示名（id で当て、無ければ名前で当て、どちらも無ければ元の名前）。 */
export function builtinPhotoPresetDisplayName(preset: { id: string; name: string }): string {
  return lookupName(preset.id) ?? lookupName(preset.name) ?? preset.name;
}
