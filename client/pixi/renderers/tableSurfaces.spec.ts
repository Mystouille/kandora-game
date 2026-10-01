import { createFrame, createResources } from "../results/pixiTestHarness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Container, NineSliceSprite, Sprite, Texture } from "pixi.js";
import type { MatchView } from "../../store";
import type { Meld } from "~/game/protocol/messages";
import { DiscardAnimator, type DiscardAnimation } from "../discardAnimator";
import { MeldAnimator } from "../meldAnimator";
import type { Seat } from "../tableGeometry";
import type { RenderFrame } from "../scene/renderTypes";
import { layoutDiscards, meldTileDims } from "../tileAreaLayout";
import { tableLayoutFromConfig } from "../tableLayout";
import { mobileTableLayout } from "../layouts/mobileTableLayout";
import { currentTableLayout } from "../layouts/currentTableLayout";
import { discardContainerZIndex, wallZIndex } from "../geometry/tableGeometry";
import {
  mobileRiichiStickPlacement,
  riichiStickMetrics,
} from "../geometry/riichiGeometry";
import {
  DISCARD_SHADOW_Z_INDEX,
  RIICHI_STICK_Z_INDEX,
} from "../geometry/renderConstants";
import {
  DiscardRenderer,
  computeHandSlotInDiscardLocal,
} from "./discardRenderer";
import type { HandSeatRender } from "./handRenderTypes";
import { MeldTileRenderer } from "./meldTiles";
import { MeldRenderer } from "./meldRenderer";
import { TablePanels } from "./tablePanels";
import { TileShadows } from "./tileShadows";
import { WallRenderer } from "./wallRenderer";
import { tintIfWait } from "./tileTint";
import * as tileAreaLayout from "../tileAreaLayout";

function harness(overrides: Partial<MatchView> = {}, mobile = false) {
  const base = createFrame(
    {
      mySeat: 0,
      conn: "replay",
      matchEnded: null,
      lastHandResult: null,
      ...overrides,
    },
    mobile ? "mobile" : "standard"
  );
  const frame: RenderFrame = {
    ...base,
    layout: tableLayoutFromConfig(
      mobile ? mobileTableLayout : currentTableLayout
    ),
  };
  frame.root.sortableChildren = true;
  const resources = createResources();
  vi.mocked(resources.spriteFactory.create).mockRestore();
  const textures = vi
    .spyOn(resources.textureStore, "getTexture")
    .mockReturnValue(Texture.EMPTY);
  const shadows = new TileShadows(resources);
  const animator = new DiscardAnimator();
  const discards = new DiscardRenderer(resources, animator, shadows);
  const panels = new TablePanels(resources.tileDesign);
  return { frame, resources, textures, shadows, animator, discards, panels };
}

function handState(frame: RenderFrame, seat: Seat): HandSeatRender {
  const handContainer = new Container();
  handContainer.zIndex = 10;
  handContainer.position.set(
    frame.layout.hands[seat].x,
    frame.layout.hands[seat].y
  );
  frame.root.addChild(handContainer);
  return {
    handContainer,
    handRect: frame.layout.hands[seat],
    longAxisOffset: 0,
    handWidth: 0,
    displayMelds: [],
    animateMelds: false,
    hand: ["1m", "2m", "3m"],
    isFreshlyDrawn: false,
    isSideHand: seat === 1 || seat === 3,
    sideHandRevealed: false,
    seatDiscardAnim: null,
    discardWaitingToStart: false,
  };
}

function containerAt(root: Container, zIndex: number): Container {
  const node = root.children.find((child) => child.zIndex === zIndex);
  if (!(node instanceof Container)) {
    throw new Error(`Missing container on layer ${zIndex}`);
  }
  return node;
}

function animation(
  phase: DiscardAnimation["phase"] = "to-nudge"
): DiscardAnimation {
  return {
    seat: 0,
    discardIndex: 0,
    tile: "3m",
    isRiichi: false,
    isRiichiDeclaration: false,
    isTsumogiri: false,
    phase,
    startMs: 0,
    durationMs: 250,
    sourceSlot: { handIndex: 2, handLength: 3 },
    draggedSourceCenter: null,
    phaseASnapshot: {
      hand: ["1m", "2m", "3m"],
      hiddenSlot: 2,
      isFreshlyDrawn: false,
      isConcealed: false,
    },
    landSoundPlayed: false,
    settleStartMs: null,
    presentationSeq: 7,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extracted discard and shadow passes", () => {
  it.each([0, 1, 2, 3] as const)(
    "keeps seat %i pond orientation, tile placements and root shadow layer",
    (seat) => {
      const rows = [["1m", "2m"], ["3p"], ["4s"], ["5z"]];
      const h = harness({
        discards: rows,
        riichiTileIdx: [1, null, null, null],
      });
      const state = handState(h.frame, seat);
      h.discards.render(h.frame, seat, state, undefined);
      const pond = containerAt(h.frame.root, discardContainerZIndex(seat));
      const placements = layoutDiscards(
        h.resources.tileDesign,
        seat,
        rows[seat],
        h.frame.view.riichiTileIdx[seat]
      );
      expect(pond.children).toHaveLength(placements.length);
      placements.forEach((placement, index) => {
        expect(pond.children[index]).toMatchObject({
          x: placement.wrap.x,
          y: placement.wrap.y,
          rotation: placement.wrap.rotation,
          zIndex: placement.zIndex,
        });
      });
      const shadowHost = containerAt(h.frame.root, DISCARD_SHADOW_Z_INDEX);
      expect(shadowHost.position).toMatchObject({ x: pond.x, y: pond.y });
      expect(shadowHost.rotation).toBe(pond.rotation);
    }
  );

  it("gives normalized wait tint priority over fresh tsumogiri and preserves the toggle modes", () => {
    const h = harness({
      discards: [["0m", "2m"], [], [], []],
      discardTsumogiri: [[true, true], [], [], []],
      discardOrdinals: [[1, 2], [], [], []],
      totalDiscards: 2,
    });
    const frame = { ...h.frame, waitTiles: new Set(["5m"]) };
    h.discards.render(frame, 0, handState(frame, 0), undefined);
    const pond = containerAt(frame.root, discardContainerZIndex(0));
    const sprites = pond.children
      .flatMap((node) => node.children)
      .filter((node): node is Sprite => node instanceof Sprite);
    expect(sprites.map((sprite) => Number(sprite.tint))).toEqual([
      0xff5555, 0xc8c8c8,
    ]);
    const plain = new Sprite(Texture.EMPTY);
    expect(tintIfWait(plain, null, frame.waitTiles)).toBe(false);
    h.discards.setShowTsumogiri(false);
    const next = { ...frame, root: new Container() };
    h.discards.render(next, 0, handState(next, 0), undefined);
    const nextSprites = containerAt(next.root, discardContainerZIndex(0))
      .children.flatMap((node) => node.children)
      .filter((node): node is Sprite => node instanceof Sprite);
    expect(nextSprites.map((sprite) => Number(sprite.tint))).toEqual([
      0xff5555, 0xffffff,
    ]);
  });

  it("uses the hand source for slide, reuses the same tile in settle, and does not paint a future overlay", () => {
    const h = harness({ discards: [["3m"], [], [], []] });
    vi.spyOn(h.animator, "getProgress").mockReturnValue(0);
    const state = handState(h.frame, 0);
    const active = { ...state, seatDiscardAnim: animation() };
    h.discards.render(h.frame, 0, active, undefined);
    const pond = containerAt(h.frame.root, 5);
    const expectedSource = computeHandSlotInDiscardLocal(
      "standard",
      state.handContainer,
      pond,
      0,
      2,
      h.frame.layout,
      false,
      3,
      false,
      false
    );
    expect(pond.children).toHaveLength(1);
    expect(pond.children[0].position).toMatchObject(expectedSource);
    expect(
      containerAt(h.frame.root, DISCARD_SHADOW_Z_INDEX).children
    ).toHaveLength(2);
    const future = { ...h.frame, root: new Container() };
    h.discards.render(
      future,
      0,
      {
        ...handState(future, 0),
        seatDiscardAnim: animation(),
        discardWaitingToStart: true,
      },
      undefined
    );
    expect(containerAt(future.root, 5).children).toHaveLength(0);
    const settled = { ...h.frame, root: new Container() };
    h.discards.render(
      settled,
      0,
      {
        ...handState(settled, 0),
        seatDiscardAnim: animation("to-final"),
      },
      undefined
    );
    const finalPlacement = layoutDiscards(
      h.resources.tileDesign,
      0,
      ["3m"],
      null
    )[0];
    expect(containerAt(settled.root, 5).children[0]).toMatchObject({
      x: finalPlacement.wrap.x + 10,
      y: finalPlacement.wrap.y + 10,
    });
  });

  it.each([0, 1, 2, 3] as const)(
    "keeps mobile seat %i riichi sticks above the shadow host",
    (seat) => {
      const h = harness({ riichiDeclared: [true, true, true, true] }, true);
      h.discards.render(
        h.frame,
        seat,
        handState(h.frame, seat),
        h.panels.discardLayoutOptions(h.frame, "standard")
      );
      const stick = containerAt(h.frame.root, RIICHI_STICK_Z_INDEX);
      const metrics = riichiStickMetrics(
        "mobile",
        h.resources.tileDesign,
        h.panels.discardLayoutOptions(h.frame, "standard")
      );
      const placement = mobileRiichiStickPlacement(
        h.frame.layout.discards[seat],
        h.frame.layout.center,
        seat,
        metrics
      );
      expect(stick).toMatchObject({
        x: placement.x,
        y: placement.y,
        rotation: placement.rotation,
      });
      expect(stick.zIndex).toBeGreaterThan(
        containerAt(h.frame.root, DISCARD_SHADOW_Z_INDEX).zIndex
      );
    }
  );

  it("splits shadow columns at actual gaps without bridging them", () => {
    const h = harness();
    const layer = new Container();
    h.shadows.placeColumnShadows(
      layer,
      [5, 15, 105, 115].map((ay) => ({ ax: 10, ay, w: 10, h: 10 }))
    );
    expect(layer.children).toHaveLength(2);
    expect(
      layer.children.every((child) => child instanceof NineSliceSprite)
    ).toBe(true);
    expect(layer.children.map((child) => child.height)).toEqual([20, 20]);
    const shadow = h.resources.tileDesign.effects.shadow;
    expect(layer.children.map((child) => child.width)).toEqual([
      shadow?.depth,
      shadow?.depth,
    ]);
  });
});

describe("extracted meld and wall passes", () => {
  it.each([0, 1, 2, 3] as const)(
    "keeps called-tile orientation and physical-copy removal for seat %i",
    (seat) => {
      const h = harness();
      const drawer = new MeldTileRenderer(h.resources, new Set());
      const drawTile = vi.spyOn(drawer, "drawMeldTile");
      const meld: Meld = {
        type: "pon",
        tiles: ["5m", "0m", "5m"],
        claimedTile: "5m",
        from: ([3, 0, 1, 2] as const)[seat],
      };
      const result = drawer.drawMeld(meld, seat);
      expect(result.node.children).toHaveLength(3);
      expect(drawTile.mock.calls.map(([tile]) => tile)).toEqual([
        "5m",
        "5m",
        "0m",
      ]);
      expect(drawTile.mock.calls[0][2]).toBe(
        h.resources.tileDesign.sheets.meld[((seat + 1) % 4) as Seat]
      );
      expect(result.boxes.filter((box) => box.isolated)).toHaveLength(1);
      expect(result.node.children[0].rotation).toBe(-Math.PI / 2);
    }
  );

  it("conceals ankan outer copies and retains the shouminkan stack offset and layer", () => {
    const h = harness();
    const drawer = new MeldTileRenderer(h.resources, new Set());
    const drawTile = vi.spyOn(drawer, "drawMeldTile");
    drawer.drawMeld(
      {
        type: "ankan",
        tiles: ["5m", "5m", "0m", "5m"],
        claimedTile: null,
        from: null,
      },
      0
    );
    expect(drawTile.mock.calls.map(([tile]) => tile)).toEqual([
      null,
      "0m",
      "5m",
      null,
    ]);
    const added = drawer.drawMeld(
      {
        type: "shouminkan",
        tiles: ["2p", "2p", "2p", "2p"],
        claimedTile: "2p",
        from: 1,
      },
      2,
      17
    );
    expect(added.node.children).toHaveLength(4);
    expect(added.node.children[3].zIndex).toBe(1);
    expect(added.node.children[3].y).toBeCloseTo(
      meldTileDims(h.resources.tileDesign, 2).h -
        meldTileDims(h.resources.tileDesign, 3).w +
        14.5 +
        17
    );
  });

  it("uses the returned hand band for the mobile four-meld column without a second layout owner", () => {
    const h = harness({}, true);
    const drawer = new MeldTileRenderer(h.resources, new Set());
    const renderer = new MeldRenderer(
      h.resources,
      new MeldAnimator(),
      h.shadows
    );
    const meld: Meld = {
      type: "pon",
      tiles: ["3m", "3m", "3m"],
      claimedTile: "3m",
      from: 0,
    };
    renderer.render(
      h.frame,
      1,
      { ...handState(h.frame, 1), displayMelds: [meld, meld, meld, meld] },
      drawer
    );
    const strip = h.frame.root.children[1];
    expect(strip.rotation).toBe(-Math.PI / 2);
    expect(
      strip.children.filter((child) => child.rotation !== Math.PI / 2)
    ).toHaveLength(4);
    expect(
      new Set(strip.children.slice(0, 4).map((child) => child.y)).size
    ).toBe(4);
  });

  it("keeps live spectators on the fixed fourteen-tile dead wall", () => {
    const h = harness({ doraIndicators: ["1m", "2m", "3m", "4m", "5m"] });
    const request = vi.fn();
    const renderer = new WallRenderer(h.resources, h.shadows, request);
    renderer.setLiveSpectate(true);
    renderer.setLiveSpectate(true);
    renderer.render(h.frame);
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.frame.root.children).toHaveLength(1);
    const wall = h.frame.root.children[0];
    expect(wall.zIndex).toBe(2);
    expect(
      wall.children.filter(
        (child) =>
          child instanceof Container &&
          child.zIndex >= 0 &&
          child.children.some((node) => node instanceof Sprite)
      )
    ).toHaveLength(14);
    expect(
      h.textures.mock.calls
        .map(([, tile]) => tile)
        .filter((tile) => tile !== null)
    ).toEqual(["1m", "2m", "3m", "4m", "5m"]);
  });

  it("keeps duplicate personal walls ahead of the relay-only fallback", () => {
    const h = harness({
      duplicateWallState: {
        initial: [18, 18, 17, 17],
        remaining: [18, 18, 17, 17],
        limitingSeat: 2,
        estimatedDrawsRemaining: 70,
      },
    });
    const renderer = new WallRenderer(h.resources, h.shadows, vi.fn());
    renderer.setLiveSpectate(true);
    renderer.render(h.frame);
    expect(h.frame.root.children).toHaveLength(4);
    expect(h.frame.root.children.map((child) => child.label)).toEqual([
      "wall-seat-0",
      "wall-seat-1",
      "wall-seat-2",
      "wall-seat-3",
    ]);
    expect(h.frame.root.children.map((child) => child.zIndex)).toEqual(
      [0, 1, 2, 3].map(wallZIndex)
    );
    expect(
      h.frame.root.children
        .flatMap((child) => child.children)
        .filter(
          (node) =>
            node instanceof Container &&
            node.zIndex >= 0 &&
            node.children.some((child) => child instanceof Sprite)
        )
    ).toHaveLength(80);
  });
});

describe("discard footprint cache owner", () => {
  it("retains default undefined spacing, caches each perspective once and invalidates explicitly", () => {
    const h = harness();
    const footprint = vi.spyOn(tileAreaLayout, "potentialDiscardBounds");
    expect(h.panels.discardLayoutOptions(h.frame, "standard")).toBeUndefined();
    const first = h.panels.discardPanelRects(
      h.frame,
      currentTableLayout.id,
      "standard"
    );
    expect(
      h.panels.discardPanelRects(h.frame, currentTableLayout.id, "standard")
    ).toEqual(first);
    expect(footprint).toHaveBeenCalledTimes(4);
    h.panels.discardPanelRects(h.frame, currentTableLayout.id, "compact");
    expect(footprint).toHaveBeenCalledTimes(8);
    h.panels.clear();
    h.panels.discardPanelRects(h.frame, currentTableLayout.id, "standard");
    expect(footprint).toHaveBeenCalledTimes(12);
  });
});
