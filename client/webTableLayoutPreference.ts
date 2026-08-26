import type { WebTableLayoutMode } from "./pixi/layouts/webTableLayout";

export const WEB_TABLE_LAYOUT_STORAGE_KEY = "kandora.web.tableLayout.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseWebTableLayoutMode(
  value: string | null
): WebTableLayoutMode {
  return value === "compact" ? "compact" : "standard";
}

export function readWebTableLayoutMode(
  storage: StorageLike | null = browserStorage()
): WebTableLayoutMode {
  if (!storage) {
    return "standard";
  }
  try {
    return parseWebTableLayoutMode(storage.getItem(WEB_TABLE_LAYOUT_STORAGE_KEY));
  } catch {
    return "standard";
  }
}

export function writeWebTableLayoutMode(
  mode: WebTableLayoutMode,
  storage: StorageLike | null = browserStorage()
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(WEB_TABLE_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // localStorage may be unavailable in privacy mode or over quota.
  }
}