import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WebTableTopControls } from "./WebTableTopControls";

describe("WebTableTopControls", () => {
  it("renders table parameters and the shared quit control", () => {
    const html = renderToStaticMarkup(
      createElement(WebTableTopControls, {
        compactLayout: false,
        onCompactLayoutChange: () => undefined,
        onQuit: () => undefined,
        quitLabel: "Quit replay",
      })
    );

    expect(html).toContain('aria-label="Table parameters"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Compact table");
    expect(html).toContain("left-0.5");
    expect(html).toContain("translate-x-0");
    expect(html).toContain('aria-label="Quit replay"');
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