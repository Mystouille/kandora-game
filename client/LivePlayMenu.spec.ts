import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LIVE_PLAY_MENU_DEFAULTS,
  LivePlayMenu,
  resetEphemeralFlags,
} from "./LivePlayMenu";
import {
  readWebTableLayoutMode,
  WEB_TABLE_LAYOUT_STORAGE_KEY,
  writeWebTableLayoutMode,
} from "./webTableLayoutPreference";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (key: string): string | null =>
      key === WEB_TABLE_LAYOUT_STORAGE_KEY ? value : null,
    setItem: (key: string, next: string): void => {
      if (key === WEB_TABLE_LAYOUT_STORAGE_KEY) {
        value = next;
      }
    },
  };
}

describe("web table layout preference", () => {
  it("parses only the compact value and otherwise falls back safely", () => {
    expect(readWebTableLayoutMode(memoryStorage("compact"))).toBe("compact");
    expect(readWebTableLayoutMode(memoryStorage("standard"))).toBe("standard");
    expect(readWebTableLayoutMode(memoryStorage("unknown"))).toBe("standard");
    expect(readWebTableLayoutMode(null)).toBe("standard");
  });

  it("writes the shared layout mode", () => {
    const storage = memoryStorage();
    writeWebTableLayoutMode("compact", storage);
    expect(readWebTableLayoutMode(storage)).toBe("compact");
    writeWebTableLayoutMode("standard", storage);
    expect(readWebTableLayoutMode(storage)).toBe("standard");
  });
});

describe("LivePlayMenu compact layout", () => {
  it("keeps compact layout out of the live-play drawer", () => {
    const html = renderToStaticMarkup(
      createElement(LivePlayMenu, {
        flags: LIVE_PLAY_MENU_DEFAULTS,
        onChange: () => undefined,
      })
    );
    expect(html).not.toContain("Compact table");
  });

  it("preserves compact layout while resetting automatic play", () => {
    expect(
      resetEphemeralFlags({
        autoSort: false,
        autoWin: true,
        noCall: true,
        autoDiscard: true,
        compactLayout: true,
      })
    ).toEqual({
      autoSort: false,
      autoWin: false,
      noCall: false,
      autoDiscard: false,
      compactLayout: true,
    });
  });
});