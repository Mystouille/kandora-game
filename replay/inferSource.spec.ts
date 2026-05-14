import { describe, expect, it } from "vitest";
import { inferReplaySource } from "./inferSource";

describe("inferReplaySource", () => {
  it("recognizes Tenhou ids (contain `gm-`)", () => {
    expect(inferReplaySource("2026041906gm-0001-14853-b8890fb3")).toBe(
      "tenhou"
    );
    expect(inferReplaySource("2026042001gm-0089-0000-f3730ee6")).toBe("tenhou");
  });

  it("recognizes Majsoul ids (YYMMDD-<uuid>)", () => {
    expect(
      inferReplaySource("250913-638affa1-cee0-4aee-869b-69b9cb40c983")
    ).toBe("majsoul");
    expect(
      inferReplaySource("260326-1143641d-f06c-45f9-a969-67108b9ee693")
    ).toBe("majsoul");
  });

  it("recognizes Riichi City ids (20-char cuid)", () => {
    expect(inferReplaySource("cknnf9eai08auidimj2g")).toBe("riichicity");
    expect(inferReplaySource("d7kftd46mci8rkoqfjrg")).toBe("riichicity");
    expect(inferReplaySource("cvb7i4c6mcifet1f1350")).toBe("riichicity");
  });

  it("recognizes ingame ids (24-char hex ObjectId)", () => {
    expect(inferReplaySource("507f1f77bcf86cd799439011")).toBe("ingame");
  });

  it("returns null for unrecognized shapes", () => {
    expect(inferReplaySource("")).toBe(null);
    expect(inferReplaySource("abc123")).toBe(null);
    expect(inferReplaySource("not-a-real-id")).toBe(null);
  });

  it("does not confuse Majsoul ids with Tenhou (no `gm-` infix)", () => {
    expect(
      inferReplaySource("250913-638affa1-cee0-4aee-869b-69b9cb40c983")
    ).toBe("majsoul");
  });
});
