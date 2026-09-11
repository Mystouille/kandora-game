import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebTableTopControls } from "./WebTableTopControls";

describe("WebTableTopControls", () => {
  it("renders shared settings and the quit control", () => {
    const html = renderToStaticMarkup(
      createElement(WebTableTopControls, {
        compactLayout: false,
        onCompactLayoutChange: () => undefined,
        onQuit: () => undefined,
        quitLabel: "Quit replay",
      })
    );

    expect(html).toContain('aria-label="Settings"');
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Compact table");
    expect(html).toContain("Sound");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("left-0.5");
    expect(html).toContain("translate-x-0");
    expect(html).toContain('aria-label="Quit replay"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('data-state="idle"');
    expect(html).toContain("hover:bg-emerald-800");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("active:scale-[0.96]");
    expect(html).toContain("data-[state=requested]:shadow-inner");
    expect(html).not.toContain('style="background-color:rgba(0,0,0,0.7)');
  });

  it("reflects the active compact layout", () => {
    const html = renderToStaticMarkup(
      createElement(WebTableTopControls, {
        compactLayout: true,
        onCompactLayoutChange: () => undefined,
        onQuit: () => undefined,
        quitLabel: "Quit game",
      })
    );

    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("left-0.5");
    expect(html).toContain("translate-x-4");
  });
});