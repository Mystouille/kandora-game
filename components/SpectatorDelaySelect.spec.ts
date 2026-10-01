import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpectatorDelaySelect } from "./SpectatorDelaySelect";
import {
  FIVE_MINUTE_SPECTATOR_DELAY_MS,
  type SpectatorDelayMs,
} from "~/game/protocol/spectatorDelay";

describe("spectator delay selector", () => {
  it.each([0, FIVE_MINUTE_SPECTATOR_DELAY_MS] as const)(
    "renders both options and selects %i ms",
    (value: SpectatorDelayMs) => {
      const html = renderToStaticMarkup(
        createElement(SpectatorDelaySelect, {
          value,
          onChange: () => undefined,
        })
      );

      expect(html).toContain('aria-label="Spectator delay"');
      expect(html).toContain(">Instant</option>");
      expect(html).toContain(">5 min</option>");
      expect(html).toContain(`value="${value}" selected=""`);
    }
  );

  it("disables the selector while room creation is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(SpectatorDelaySelect, {
        value: 0,
        onChange: () => undefined,
        disabled: true,
      })
    );

    expect(html).toContain('disabled=""');
  });
});
