import {
  allText,
  installSceneEnvironment,
  logoLoad,
  sceneMocks,
} from "./results/pixiTestHarness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Container, Sprite, Texture, TextureSource } from "pixi.js";
import {
  TableRenderer,
  actionButtonLabel,
  genericPassOrTsumogiriAction,
  wallZIndex,
} from "./TableRenderer";
import { useMatchStore, type MatchView } from "../store";
import { initialView } from "~/game/replay/player";
import { seatValues } from "~/game/rules/seats";
import { rotateMatchView, tablePositionForSeat } from "../tableProjection";
import { mobileTableLayout } from "./layouts/mobileTableLayout";
import { renderResultScoreBoxes } from "./results/resultScoreBoxes";
import { buildWinResultRows } from "./results/resultRows";

beforeEach(() => {
  installSceneEnvironment();
  logoLoad.mockResolvedValue(
    new Texture({ source: new TextureSource({ width: 4096, height: 4096 }) })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function raw(count: 3 | 4): MatchView {
  return {
    ...useMatchStore.getInitialState(),
    ...initialView({ playerCount: count }),
    mySeat: 0,
    conn: "replay",
    seatNames: seatValues(count, (seat) => `Player ${seat}`),
    hands: seatValues(count, () => ["1p", "2p", "3p"]),
    discards: seatValues(count, () => ["9s"]),
    nukiTiles: seatValues(count, () => (count === 3 ? ["4z"] : [])),
    melds: seatValues(count, (seat) => [
      {
        type: "pon",
        tiles: ["7z", "7z", "7z"],
        claimedTile: "7z",
        from: seat === 0 ? 1 : 0,
      },
    ]),
  };
}

function root(): Container {
  const child = sceneMocks.stages.at(-1)?.children[0];
  if (!(child instanceof Container)) {
    throw new Error("Renderer root was not mounted");
  }
  return child;
}

describe("public bonus tile layering", () => {
  it.each(["standard", "compact", "mobile"] as const)(
    "keeps MCR flowers and both sanma nuki strips behind discards (%s)",
    async (mode) => {
      const renderer = new TableRenderer(
        mode === "mobile"
          ? { presentation: "mobile", layoutConfig: mobileTableLayout }
          : { webTableLayoutMode: mode }
      );
      renderer.setAnimationsEnabled(false);
      await renderer.mount(new HTMLElement());
      const views: MatchView[] = [
        {
          ...raw(4),
          rulesFamily: "mcr",
          flowerTiles: [["1f"], ["2f"], ["3f"], ["4f"]],
        },
        raw(3),
        {
          ...raw(3),
          sanmaType: "kansai",
          nukiTiles: [["0m"], ["5m"], ["5m"]],
        },
      ];
      for (const view of views) {
        renderer.render(view);
        const scene = root();
        expect(scene.sortableChildren).toBe(true);
        scene.sortChildren();
        const prefix =
          view.rulesFamily === "mcr" ? "flowers-seat-" : "nuki-seat-";
        const bonuses = scene.children.filter((node) =>
          node.label?.startsWith(prefix)
        );
        const ponds = scene.children.filter((node) =>
          node.label?.startsWith("discard-seat-")
        );
        expect(bonuses).toHaveLength(view.playerCount ?? 4);
        expect(ponds).toHaveLength(view.playerCount ?? 4);
        for (const bonus of bonuses) {
          expect(bonus.zIndex).toBeGreaterThan(
            Math.max(...[0, 1, 2, 3].map(wallZIndex))
          );
          for (const pond of ponds) {
            expect(bonus.zIndex).toBeLessThan(pond.zIndex);
            expect(scene.getChildIndex(bonus)).toBeLessThan(
              scene.getChildIndex(pond)
            );
          }
        }
      }
      renderer.destroy();
    }
  );
});

describe("three-seat rendering across shared layouts", () => {
  it.each(["standard", "compact", "mobile"] as const)(
    "removes old nodes and inactive hit areas across 4→3→4 and all perspectives (%s)",
    async (mode) => {
      const renderer = new TableRenderer(
        mode === "mobile"
          ? { presentation: "mobile", layoutConfig: mobileTableLayout }
          : { webTableLayoutMode: mode }
      );
      renderer.setAnimationsEnabled(false);
      renderer.setShowHands(true);
      await renderer.mount(new HTMLElement());
      renderer.render(raw(4));
      expect(
        root().children.filter((child) => child.label?.startsWith("hand-seat-"))
      ).toHaveLength(4);
      for (const focus of [0, 1, 2] as const) {
        for (const dealer of [0, 1, 2] as const) {
          const old = [...root().children];
          const view = rotateMatchView({ ...raw(3), dealer }, focus);
          renderer.render(view);
          expect(old.every((child) => child.destroyed)).toBe(true);
          const gap = tablePositionForSeat(3, focus);
          for (const kind of [
            "hand",
            "discard",
            "meld",
            "name",
            "score",
            "nuki",
            "hand-panel",
            "discard-panel",
            "player-panel",
          ]) {
            const nodes = root().children.filter((child) =>
              child.label?.startsWith(`${kind}-seat-`)
            );
            expect(nodes, kind).toHaveLength(3);
            expect(
              nodes.some((child) => child.label === `${kind}-seat-${gap}`),
              kind
            ).toBe(false);
          }
          expect(allText(root()).some((text) => text.text === "Player 3")).toBe(
            false
          );
          expect(
            root()
              .children.filter((child) => child.label?.startsWith("nuki-seat-"))
              .every((child) => child.eventMode === "none")
          ).toBe(true);
          for (const node of root().children.filter((child) =>
            child.label?.startsWith("nuki-seat-")
          )) {
            if (!(node instanceof Container)) {
              throw new Error("Expected a nuki tile container");
            }
            const tiles = node.children.filter(
              (child): child is Sprite => child instanceof Sprite
            );
            expect(tiles.length).toBeGreaterThan(0);
            expect(
              tiles.every((tile) => tile.anchor.x === 0 && tile.anchor.y === 0)
            ).toBe(true);
          }
          const results = new Container();
          renderResultScoreBoxes(
            view,
            { reason: "exhaustive_draw", delta: [0, 0, 0, 0] },
            { x: 0, y: 0, w: 900, h: 900 },
            results,
            true
          );
          expect(results.children).toHaveLength(3);
        }
      }
      const old = [...root().children];
      renderer.render(raw(4));
      expect(old.every((child) => child.destroyed)).toBe(true);
      expect(
        root().children.filter((child) => child.label?.startsWith("hand-seat-"))
      ).toHaveLength(4);
      expect(
        root().children.some((child) => child.label?.startsWith("nuki-seat-"))
      ).toBe(false);
      renderer.destroy();
    }
  );

  it("shows a manual North action and never invokes generic automatic tsumogiri over it", () => {
    const nuki = { id: "server-nuki", type: "nuki" as const, tile: "4z" };
    expect(actionButtonLabel(nuki)).toBe("Nuki 北");
    expect(
      genericPassOrTsumogiriAction({
        mySeat: 0,
        hands: [["4z"], [], []],
        legalActions: [
          nuki,
          { id: "discard", type: "discard", tile: "4z", discardSource: "draw" },
        ],
      })
    ).toBeUndefined();
  });

  it("uses han-only Kansai summaries and retains the authoritative payment", () => {
    const result = {
      reason: "tsumo" as const,
      wins: [
        {
          seat: 0 as const,
          han: 2,
          fu: 30,
          ten: 4200,
          yaku: { "Nuki Dora": "1 han" },
        },
      ],
    };
    const kansai = buildWinResultRows(result, 0, false, 0, null, true, true);
    expect(kansai.rows.find((row) => row.kind === "scoreRow")).toMatchObject({
      han: "2 han",
      pts: "4200pts",
    });
    const online = buildWinResultRows(result, 0, false, 0, null, true);
    expect(online.rows.find((row) => row.kind === "scoreRow")).toMatchObject({
      han: "2 han 30 fu",
      pts: "4200pts",
    });
  });
});
