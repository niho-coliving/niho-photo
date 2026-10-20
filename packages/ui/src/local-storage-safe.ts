type LocalStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type LocalStorageContainer = {
  localStorage: LocalStorageLike;
};

function getLocalStorageSafely(
  container: LocalStorageContainer | undefined =
    typeof window === "undefined" ? undefined : (window as LocalStorageContainer),
): LocalStorageLike | null {
  if (!container) return null;
  try {
    return container.localStorage;
  } catch {
    return null;
  }
}

export function readLocalStorageItemSafely(
  key: string,
  container?: LocalStorageContainer,
): string | null {
  const storage = getLocalStorageSafely(container);
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function writeLocalStorageItemSafely(
  key: string,
  value: string,
  container?: LocalStorageContainer,
): boolean {
  const storage = getLocalStorageSafely(container);
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeLocalStorageItemSafely(
  key: string,
  container?: LocalStorageContainer,
): boolean {
  const storage = getLocalStorageSafely(container);
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
