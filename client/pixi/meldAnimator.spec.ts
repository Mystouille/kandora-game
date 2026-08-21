import { describe, expect, it } from "vitest";
import type { MatchView } from "../store";
import type { Meld } from "~/game/protocol/messages";
import {
  MELD_SLIDE_DURATION_MS,
  MeldAnimator,
  rotateMeldLocalPoint,
} from "./meldAnimator";

const PON: Meld = {
  type: "pon",
  tiles: ["2m", "2m", "2m"],
  claimedTile: "2m",
  from: 3,
};

const CHI: Meld = {
  type: "chi",
  tiles: ["3p", "4p", "5p"],
  claimedTile: "5p",
  from: 0,
};

const DAIMINKAN: Meld = {
  type: "daiminkan",
  tiles: ["7s", "7s", "7s", "7s"],
  claimedTile: "7s",
  from: 2,
};

const ANKAN: Meld = {
  type: "ankan",
  tiles: ["4z", "4z", "4z", "4z"],
  claimedTile: null,
  from: null,
};

function view(melds: Meld[][]): MatchView {
  return { melds } as MatchView;
}

describe("MeldAnimator", () => {
  it("maps player-left travel through every seat orientation", () => {
    const rotations = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
    const expected = [
      { x: -90, y: 0 },
      { x: 0, y: 90 },
      { x: 90, y: 0 },
      { x: 0, y: -90 },
    ];

    rotations.forEach((rotation, seat) => {
      const point = rotateMeldLocalPoint(-90, 0, rotation);
      expect(point.x).toBeCloseTo(expected[seat].x);
      expect(point.y).toBeCloseTo(expected[seat].y);
    });
  });

  it("maps player-above travel through every seat orientation", () => {
    const rotations = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
    const expected = [
      { x: 0, y: -90 },
      { x: -90, y: 0 },
      { x: 0, y: 90 },
      { x: 90, y: 0 },
    ];

    rotations.forEach((rotation, seat) => {
      const point = rotateMeldLocalPoint(0, -90, rotation);
      expect(point.x).toBeCloseTo(expected[seat].x);
      expect(point.y).toBeCloseTo(expected[seat].y);
    });
  });

  it("slides one newly appended meld from local left to zero", () => {
    let now = 100;
    const animator = new MeldAnimator({ now: () => now });
    animator.beginFrame(view([[], [], [], []]));
    animator.beginFrame(view([[], [CHI], [], []]));

    expect(animator.getMeldOffsetX(1, 0, 120)).toBe(-120);
    expect(animator.getShouminkanOffsetY(1, 0, 120)).toBe(0);
    now += MELD_SLIDE_DURATION_MS / 2;
    expect(animator.getMeldOffsetX(1, 0, 120)).toBeGreaterThan(-60);
    expect(animator.getMeldOffsetX(1, 0, 120)).toBeLessThan(0);
    now += MELD_SLIDE_DURATION_MS / 2;
    expect(animator.getMeldOffsetX(1, 0, 120)).toBe(0);
    expect(animator.hasActive()).toBe(false);
  });

  it.each([CHI, PON, DAIMINKAN, ANKAN])(
    "animates an appended $type meld",
    (meld) => {
      const animator = new MeldAnimator({ now: () => 0 });
      animator.beginFrame(view([[], [], [], []]));
      animator.beginFrame(view([[], [], [meld], []]));

      expect(animator.getMeldOffsetX(2, 0, 100)).toBe(-100);
      expect(animator.getShouminkanOffsetY(2, 0, 100)).toBe(0);
    }
  );

  it("slides only the added shouminkan tile from player-above", () => {
    let now = 0;
    const animator = new MeldAnimator({ now: () => now });
    animator.beginFrame(view([[PON], [], [], []]));
    animator.beginFrame(
      view([
        [
          {
            ...PON,
            type: "shouminkan",
            tiles: ["2m", "2m", "2m", "2m"],
          },
        ],
        [],
        [],
        [],
      ])
    );

    expect(animator.getMeldOffsetX(0, 0, 90)).toBe(0);
    expect(animator.getShouminkanOffsetY(0, 0, 90)).toBe(-90);
    now += MELD_SLIDE_DURATION_MS / 2;
    expect(animator.getShouminkanOffsetY(0, 0, 90)).toBeGreaterThan(-45);
    expect(animator.getShouminkanOffsetY(0, 0, 90)).toBeLessThan(0);
    now += MELD_SLIDE_DURATION_MS / 2;
    expect(animator.getShouminkanOffsetY(0, 0, 90)).toBe(0);
  });

  it("recognizes a red-five shouminkan inserted before the pon tiles", () => {
    const animator = new MeldAnimator({ now: () => 0 });
    animator.beginFrame(
      view([
        [
          {
            type: "pon",
            tiles: ["5m", "5m", "5m"],
            claimedTile: "5m",
            from: 3,
          },
        ],
        [],
        [],
        [],
      ])
    );
    animator.beginFrame(
      view([
        [
          {
            type: "shouminkan",
            tiles: ["0m", "5m", "5m", "5m"],
            claimedTile: "5m",
            from: 3,
          },
        ],
        [],
        [],
        [],
      ])
    );

    expect(animator.getMeldOffsetX(0, 0, 90)).toBe(0);
    expect(animator.getShouminkanOffsetY(0, 0, 90)).toBe(-90);
  });

  it("does not animate initial hydration or a jump across multiple calls", () => {
    const animator = new MeldAnimator({ now: () => 0 });
    animator.beginFrame(view([[PON], [], [], []]));
    expect(animator.hasActive()).toBe(false);

    animator.beginFrame(view([[PON, CHI], [PON], [], []]));
    expect(animator.hasActive()).toBe(false);
  });

  it("snapNext suppresses only the upcoming call transition", () => {
    const animator = new MeldAnimator({ now: () => 0 });
    animator.beginFrame(view([[], [], [], []]));
    animator.snapNext();
    animator.beginFrame(view([[PON], [], [], []]));
    expect(animator.hasActive()).toBe(false);

    animator.beginFrame(view([[PON, CHI], [], [], []]));
    expect(animator.hasActive()).toBe(true);
  });

  it("tracks state without scheduling while animations are disabled", () => {
    const animator = new MeldAnimator({ now: () => 0 });
    animator.beginFrame(view([[], [], [], []]));
    animator.setEnabled(false);
    animator.beginFrame(view([[PON], [], [], []]));
    expect(animator.hasActive()).toBe(false);

    animator.setEnabled(true);
    animator.beginFrame(view([[PON, CHI], [], [], []]));
    expect(animator.hasActive()).toBe(true);
  });
});
