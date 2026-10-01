import { describe, expect, it } from "vitest";
import {
  FIVE_MINUTE_SPECTATOR_DELAY_MS,
  SpectatorDelayFormValueSchema,
  SpectatorDelayMsSchema,
} from "./spectatorDelay";

describe("spectator delay settings", () => {
  it.each([0, 300_000])("accepts a %i ms game delay", (delayMs) => {
    expect(SpectatorDelayMsSchema.parse(delayMs)).toBe(delayMs);
  });

  it("defaults legacy games to instant spectating", () => {
    expect(SpectatorDelayMsSchema.default(0).parse(undefined)).toBe(0);
    expect(FIVE_MINUTE_SPECTATOR_DELAY_MS).toBe(300_000);
  });

  it.each([-1, 1, 60_000, 300_001, null, "300000", true])(
    "rejects an unsupported game delay: %s",
    (delayMs) => {
      expect(SpectatorDelayMsSchema.safeParse(delayMs).success).toBe(false);
    }
  );

  it.each([
    ["0", 0],
    ["300000", 300_000],
  ])("parses the %s form option", (value, delayMs) => {
    expect(SpectatorDelayFormValueSchema.parse(value)).toBe(delayMs);
  });

  it.each(["", "instant", "60000", "300000.0", " 300000", null])(
    "rejects an invalid form option: %s",
    (value) => {
      expect(SpectatorDelayFormValueSchema.safeParse(value).success).toBe(
        false
      );
    }
  );
});
